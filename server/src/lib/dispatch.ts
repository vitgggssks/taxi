/**
 * Dispatch Engine.
 *
 * Guarantees:
 *  1. One order ⇒ at most one driver. Enforced by the partial unique index
 *     uniq_order_accepted plus an explicit guard inside a transaction.
 *  2. Offers expire (timer) and are re-offered in widening rounds with
 *     `offer_rounds` cap, then the order is parked as `no_drivers` (still
 *     dispatchable later / by hand).
 *  3. Auto-accept drivers get the order without a manual tap when their own
 *     criteria (radius, min price, class) are satisfied.
 *  4. Manual assignment & reassignment by a dispatcher/admin always wins over
 *     the automatic loop.
 */
import { all, Db, one, run, Row, tx } from './db.js';
import { distanceM, durationS, Point, ROAD_FACTOR } from './geo.js';
import { getOrderFull, notify, project, setStatus } from './order-service.js';
import { hub } from './realtime.js';
import { iso, isoAfter, id, notFound, conflict } from './util.js';

export interface DispatchSettings {
  offer_timeout_s: number;
  offer_rounds: number;
  search_radius_km: number;
  max_active_orders: number;
  auto_accept_max_distance_km: number;
  parallel_offers: number;
}

export function settingsFor(db: Db, cityId: string): DispatchSettings {
  const row = one(db, `SELECT * FROM dispatch_settings WHERE city_id = ?`, cityId);
  return {
    offer_timeout_s: row?.offer_timeout_s ?? 20,
    offer_rounds: row?.offer_rounds ?? 3,
    search_radius_km: row?.search_radius_km ?? 7,
    max_active_orders: row?.max_active_orders ?? 5,
    auto_accept_max_distance_km: row?.auto_accept_max_distance_km ?? 4,
    parallel_offers: row?.parallel_offers ?? 3,
  };
}

export interface Candidate extends Row {
  distance_m: number;
  eta_s: number;
}

/** Drivers eligible for this order, nearest first. */
export function candidateDrivers(
  db: Db,
  order: Row,
  opts: { radiusKm?: number; exclude?: Set<string>; limit?: number } = {},
): Candidate[] {
  const pickup = one(db, `SELECT * FROM order_points WHERE order_id = ? AND seq = 0`, order.id);
  if (!pickup) return [];
  const settings = settingsFor(db, order.city_id);
  const radiusKm = opts.radiusKm ?? settings.search_radius_km;
  const exclude = opts.exclude ?? new Set<string>();
  const classRow = one(db, `SELECT code FROM car_classes WHERE id = ?`, order.class_id);
  const classCode = classRow?.code ?? '';

  const drivers = all(
    db,
    `SELECT d.*, u.name, u.phone, v.id AS vehicle_id, v.plate, v.make, v.model, v.class_id
     FROM driver_profiles d
     JOIN users u ON u.id = d.user_id
     LEFT JOIN vehicles v ON v.driver_id = d.user_id AND v.active = 1 AND v.class_id = ?
     WHERE d.status = 'verified' AND d.work_status = 'online'
       AND d.lat IS NOT NULL AND d.lng IS NOT NULL`,
    order.class_id,
  );

  const active = all(
    db,
    `SELECT driver_id FROM orders WHERE status IN ('assigned','driver_arriving','waiting','in_progress') AND driver_id IS NOT NULL`,
  );
  const busy = new Set(active.map((r) => r.driver_id as string));

  const pickupPoint: Point = { lat: pickup.lat, lng: pickup.lng };
  return drivers
    .filter((d) => !exclude.has(d.user_id) && !busy.has(d.user_id))
    .filter((d) => (d.vehicle_id ? true : (d.classes_csv ?? '').split(',').includes(classCode)))
    .filter((d) => Boolean(d.vehicle_id) || !classCode) // must have a vehicle of the requested class
    .map((d): Candidate => {
      const dist = distanceM({ lat: d.lat, lng: d.lng }, pickupPoint);
      return Object.assign({}, d as Row, { distance_m: dist, eta_s: durationS(Math.round(dist * ROAD_FACTOR)) }) as Candidate;
    })
    .filter((d) => d.distance_m <= radiusKm * 1000)
    .filter((d) => d.distance_m <= Number(d.accept_radius_km ?? radiusKm) * 1000)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, opts.limit ?? 10);
}

function createOffer(db: Db, order: Row, driver: Candidate, round: number, timeoutS: number): Row {
  const offerId = id('off');
  const expiresAt = isoAfter(timeoutS);
  run(
    db,
    `INSERT INTO order_offers (id, order_id, driver_id, price_cents, distance_to_pickup_m, eta_to_pickup_s, round, expires_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    offerId, order.id, driver.user_id, order.quoted_price_cents,
    driver.distance_m, driver.eta_s, round, expiresAt,
  );
  db.prepare(`UPDATE driver_profiles SET offers_total = offers_total + 1 WHERE user_id = ?`).run(driver.user_id);
  const offer = one(db, `SELECT * FROM order_offers WHERE id = ?`, offerId)!;
  hub.toUser(driver.user_id, 'offer.new', {
    offer, order: { ...order, pickup: one(db, `SELECT * FROM order_points WHERE order_id = ? AND seq = 0`, order.id) },
  });
  return offer;
}

/**
 * Accept an offer. Transactional: re-checks the order is still unassigned and
 * the offer still live, so a race between two drivers can never double-assign.
 */
export function acceptOffer(db: Db, driverId: string, offerId: string, auto = false): Row {
  return tx(db, () => {
    const offer = one(db, `SELECT * FROM order_offers WHERE id = ?`, offerId);
    if (!offer) throw notFound('Пропозицію не знайдено');
    if (offer.driver_id !== driverId) throw conflict('Пропозиція адресована іншому водієві');
    if (offer.status !== 'offered') throw conflict('Пропозиція вже неактивна');
    if (offer.expires_at < iso()) throw conflict('Час на прийняття пропозиції минув');

    const order = one(db, `SELECT * FROM orders WHERE id = ?`, offer.order_id);
    if (!order) throw notFound('Замовлення не знайдено');
    if (order.driver_id) throw conflict('Замовлення вже прийнято іншим водієм');
    if (!['searching', 'offered', 'no_drivers'].includes(order.status)) {
      throw conflict('Замовлення вже не можна прийняти');
    }

    run(db, `UPDATE order_offers SET status = 'accepted', responded_at = ? WHERE id = ?`, iso(), offerId);
    // supersede every other live offer for this order
    run(db, `UPDATE order_offers SET status = 'superseded', responded_at = ? WHERE order_id = ? AND id != ? AND status = 'offered'`,
      iso(), order.id, offerId);

    const vehicle = one(db, `SELECT * FROM vehicles WHERE driver_id = ? AND active = 1 AND class_id = ?`, driverId, order.class_id)
      ?? one(db, `SELECT * FROM vehicles WHERE driver_id = ? AND active = 1`, driverId);

    run(db, `UPDATE orders SET driver_id = ?, vehicle_id = ?, assigned_by = ? WHERE id = ?`,
      driverId, vehicle?.id ?? null, auto ? 'auto' : 'driver', order.id);
    run(db, `UPDATE driver_profiles SET work_status = 'busy', offers_accepted = offers_accepted + 1 WHERE user_id = ?`, driverId);

    const updated = setStatus(db, order.id, 'assigned', driverId, { event: auto ? 'dispatch.auto_assigned' : 'dispatch.accepted' });
    notify(db, order.passenger_id, 'driver_assigned', 'Водія призначено',
      'Авто вже в дорозі до вас', { orderId: order.id });
    const info = project(db, updated);
    hub.toOrder(order.id, 'order.assigned', info);
    return info;
  });
}

export function declineOffer(db: Db, driverId: string, offerId: string, reason = 'declined'): void {
  const offer = one(db, `SELECT * FROM order_offers WHERE id = ?`, offerId);
  if (!offer || offer.driver_id !== driverId) throw notFound('Пропозицію не знайдено');
  if (offer.status !== 'offered') return;
  run(db, `UPDATE order_offers SET status = ?, responded_at = ? WHERE id = ?`, reason, iso(), offerId);
  run(db, `UPDATE driver_profiles SET work_status = 'online' WHERE user_id = ? AND work_status = 'busy'`, driverId);
}

/** Main dispatch entry point — call after a new order is created. */
export function tryDispatch(db: Db, orderId: string): void {
  const order = one(db, `SELECT * FROM orders WHERE id = ?`, orderId);
  if (!order) return;
  if (!['searching', 'offered', 'no_drivers'].includes(order.status)) return;

  const open = all(db, `SELECT * FROM order_offers WHERE order_id = ? AND status = 'offered'`, orderId);
  if (open.length) return; // waiting for drivers to answer

  const settings = settingsFor(db, order.city_id);
  const previous = all(db, `SELECT * FROM order_offers WHERE order_id = ?`, orderId);
  const round = previous.reduce((m, o) => Math.max(m, Number(o.round ?? 1)), 0) + 1;
  if (round > settings.offer_rounds) {
    setStatus(db, orderId, 'no_drivers', null, { event: 'dispatch.rounds_exhausted' });
    return;
  }
  const radiusKm = settings.search_radius_km * (1 + (round - 1) * 0.7);
  const exclude = new Set(previous.filter((o) => o.status !== 'accepted').map((o) => o.driver_id as string));
  const candidates = candidateDrivers(db, order, { radiusKm, exclude, limit: settings.parallel_offers });
  if (!candidates.length) {
    if (order.status !== 'no_drivers') setStatus(db, orderId, 'no_drivers', null, { event: 'dispatch.no_candidates' });
    return;
  }

  const autoCandidate = candidates.find((c) =>
    Number(c.auto_accept) === 1 &&
    Number(order.quoted_price_cents) >= Number(c.min_price_cents ?? 0) &&
    c.distance_m <= Number(c.accept_radius_km ?? settings.auto_accept_max_distance_km) * 1000,
  );

  if (autoCandidate) {
    const offer = createOffer(db, order, autoCandidate, round, settings.offer_timeout_s);
    try {
      acceptOffer(db, autoCandidate.user_id, offer.id, true);
      return;
    } catch {
      /* fall through to the normal offer flow */
    }
  }

  for (const candidate of candidates) createOffer(db, order, candidate, round, settings.offer_timeout_s);
  const updated = setStatus(db, orderId, 'offered', null, { event: 'dispatch.offered' });
  const project_ = project(db, updated);
  for (const candidate of candidates) hub.toUser(candidate.user_id, 'order.offered', project_);
}

/** Timer sweeper: expires stale offers and pushes the order to the next round. */
export function runDispatchTick(db: Db, now = iso()): { expired: number; redispatched: number } {
  const stale = all(db, `SELECT * FROM order_offers WHERE status = 'offered' AND expires_at < ?`, now);
  for (const offer of stale) {
    run(db, `UPDATE order_offers SET status = 'expired' WHERE id = ?`, offer.id);
    hub.toUser(offer.driver_id, 'offer.expired', { offerId: offer.id, orderId: offer.order_id });
    run(db, `UPDATE driver_profiles SET work_status = 'online' WHERE user_id = ? AND work_status = 'busy'`, offer.driver_id);
  }

  const waiting = all(db, `SELECT DISTINCT order_id FROM order_offers WHERE status = 'offered' AND expires_at >= ?`, now);
  const waitingIds = new Set(waiting.map((r) => r.order_id));
  const candidates = all(db, `SELECT * FROM orders WHERE status IN ('searching','offered','no_drivers')`);
  let redispatched = 0;
  for (const order of candidates) {
    if (waitingIds.has(order.id)) continue;
    tryDispatch(db, order.id);
    redispatched++;
  }
  return { expired: stale.length, redispatched };
}

/** Dispatcher/admin manual assignment — bypasses the offer loop. */
export function assignManually(db: Db, orderId: string, driverId: string, actorId: string): Row {
  return tx(db, () => {
    const order = one(db, `SELECT * FROM orders WHERE id = ?`, orderId);
    if (!order) throw notFound('Замовлення не знайдено');
    const driver = one(db, `SELECT * FROM driver_profiles WHERE user_id = ?`, driverId);
    if (!driver) throw notFound('Водія не знайдено');
    if (driver.status !== 'verified') throw conflict('Водій не пройшов верифікацію');
    if (!['searching', 'offered', 'no_drivers', 'assigned'].includes(order.status)) {
      throw conflict(`Не можна призначити водія для замовлення в статусі ${order.status}`);
    }
    const vehicle = one(db, `SELECT * FROM vehicles WHERE driver_id = ? AND active = 1 AND class_id = ?`, driverId, order.class_id)
      ?? one(db, `SELECT * FROM vehicles WHERE driver_id = ? AND active = 1`, driverId);
    run(db, `UPDATE order_offers SET status = 'revoked', responded_at = ? WHERE order_id = ? AND status = 'offered'`, iso(), orderId);
    run(db, `UPDATE orders SET driver_id = ?, vehicle_id = ?, assigned_by = 'dispatch' WHERE id = ?`, driverId, vehicle?.id ?? null, orderId);
    run(db, `UPDATE driver_profiles SET work_status = 'busy' WHERE user_id = ?`, driverId);
    const updated = setStatus(db, orderId, 'assigned', actorId, { event: 'dispatch.manual_assign' });
    notify(db, order.passenger_id, 'driver_assigned', 'Водія призначено диспетчером', '', { orderId });
    notify(db, driverId, 'order_assigned', 'Вам призначено замовлення', `№${order.number}`, { orderId });
    return project(db, updated);
  });
}

export function reassign(db: Db, orderId: string, driverId: string, actorId: string): Row {
  const order = one(db, `SELECT * FROM orders WHERE id = ?`, orderId);
  if (!order) throw notFound('Замовлення не знайдено');
  if (order.driver_id) {
    run(db, `UPDATE driver_profiles SET work_status = 'online' WHERE user_id = ? AND work_status = 'busy'`, order.driver_id);
    notify(db, order.driver_id, 'order_reassigned', 'Замовлення передано іншому водієві', `№${order.number}`, { orderId });
  }
  run(db, `UPDATE orders SET driver_id = NULL, vehicle_id = NULL, status = 'searching' WHERE id = ?`, orderId);
  return assignManually(db, orderId, driverId, actorId);
}

/** Free the driver once the order is finished or canceled. */
export function releaseDriver(db: Db, driverId: string | null): void {
  if (!driverId) return;
  const stillBusy = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM orders WHERE driver_id = ? AND status IN ('assigned','driver_arriving','waiting','in_progress')`,
    driverId,
  );
  if (!stillBusy || stillBusy.n === 0) {
    run(db, `UPDATE driver_profiles SET work_status = 'online' WHERE user_id = ? AND work_status = 'busy'`, driverId);
  }
}

export function offerTimeoutFor(db: Db, cityId: string): number {
  return settingsFor(db, cityId).offer_timeout_s;
}

export { getOrderFull };
