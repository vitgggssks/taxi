/**
 * Driver module — onboarding & verification, work mode (online/offline),
 * auto-accept vs manual mode, offers, order execution, earnings, stats, quests.
 */
import type { FastifyInstance } from 'fastify';
import { all, Db, one, run, tx } from '../lib/db.js';
import { acceptOffer, declineOffer, releaseDriver, settingsFor } from '../lib/dispatch.js';
import { audit, currentUser, requireRole } from '../lib/http.js';
import { getOrderFull, notify, project, setStatus } from '../lib/order-service.js';
import { driverPayout, ledger, settleOrder, walletBalance } from '../lib/payments.js';
import { hub } from '../lib/realtime.js';
import { bad, conflict, forbidden, id, iso, notFound, num, oneOf, str, unprocessable } from '../lib/util.js';
import { chargeOrder } from '../lib/payments.js';

const DOC_TYPES = ['license', 'vehicle_registration', 'vehicle_photo', 'id_card', 'insurance'] as const;

function driverProfile(db: Db, userId: string) {
  const profile = one(db, `SELECT * FROM driver_profiles WHERE user_id = ?`, userId);
  if (!profile) throw notFound('Профіль водія не знайдено');
  return profile;
}

/** Quest progress + automatic bonus payout (idempotent through the ledger). */
function checkQuests(db: Db, driverId: string, cityId: string) {
  const quests = all(db, `SELECT * FROM quests WHERE active = 1 AND (city_id IS NULL OR city_id = ?)`, cityId);
  const paid: Record<string, number> = {};
  for (const quest of quests) {
    const from = quest.valid_from ?? '1970-01-01';
    const to = quest.valid_to ?? '2999-12-31';
    const cnt = one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM orders WHERE driver_id = ? AND status = 'completed' AND date(created_at) BETWEEN ? AND ?`,
      driverId, from, to,
    )!;
    if (cnt.n >= quest.target_orders) {
      const key = `quest_${quest.id}_${driverId}`;
      const already = one(db, `SELECT id FROM wallet_transactions WHERE idempotency_key = ?`, key);
      if (!already) {
        ledger(db, {
          userId: driverId, kind: 'bonus', amountCents: quest.bonus_cents,
          idempotencyKey: key, meta: { questId: quest.id, title: quest.title },
        });
        notify(db, driverId, 'quest_bonus', 'Бонус за завдання', `${quest.title}: +${(quest.bonus_cents / 100).toFixed(0)} ₴`);
      }
      paid[quest.id] = quest.bonus_cents;
    }
  }
  return paid;
}

export function registerDriverRoutes(app: FastifyInstance, db: Db) {
  /* ---------------------------------------------------------- onboarding -- */
  app.post('/api/driver/register', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cityId = str(body.cityId, 'cityId');
    const city = one(db, `SELECT * FROM cities WHERE id = ?`, cityId);
    if (!city) throw bad('Місто не знайдено');
    const classes = all<{ code: string }>(db, `SELECT code FROM car_classes WHERE active = 1 AND kind = 'ride'`).map((c) => c.code);
    const driverClasses = (Array.isArray(body.classes) ? body.classes : []).map(String).filter((c) => classes.includes(c));
    if (!driverClasses.length) throw bad('Оберіть хоча б один клас авто', { field: 'classes' });

    const vehicle = (body.vehicle ?? {}) as Record<string, unknown>;
    const make = str(vehicle.make, 'vehicle.make', { min: 2, max: 40 });
    const model = str(vehicle.model, 'vehicle.model', { min: 1, max: 40 });
    const plate = str(vehicle.plate, 'vehicle.plate', { min: 4, max: 12 });
    const year = vehicle.year ? num(vehicle.year, 'vehicle.year', { min: 1990, max: 2030, int: true }) : null;
    const color = vehicle.color ? str(vehicle.color, 'vehicle.color', { max: 30 }) : null;
    const photoUrl = vehicle.photoUrl ? str(vehicle.photoUrl, 'vehicle.photoUrl', { max: 400 }) : null;

    const documents = Array.isArray(body.documents) ? body.documents : [];
    if (documents.length < 2) throw bad('Додайте щонайменше посвідчення водія та документ на авто', { field: 'documents' });

    const existing = one(db, `SELECT * FROM driver_profiles WHERE user_id = ?`, user.id);
    if (existing && existing.status === 'verified') throw conflict('Ви вже верифікований водій');

    tx(db, () => {
      const profileId = user.id;
      if (existing) {
        run(db, `UPDATE driver_profiles SET city_id = ?, classes_csv = ?, status = 'pending', rejection_reason = NULL WHERE user_id = ?`,
          cityId, driverClasses.join(','), profileId);
      } else {
        run(db, `INSERT INTO driver_profiles (user_id, city_id, status, classes_csv) VALUES (?,?,'pending',?)`,
          profileId, cityId, driverClasses.join(','));
      }
      run(db, `DELETE FROM vehicles WHERE driver_id = ?`, profileId);
      for (const code of driverClasses) {
        run(
          db,
          `INSERT INTO vehicles (id, driver_id, class_id, make, model, year, color, plate, photo_url)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          id('veh'), profileId, `cls_${code}`, make, model, year, color, plate, photoUrl,
        );
      }
      run(db, `UPDATE users SET role = 'driver', city_id = ? WHERE id = ?`, cityId, profileId);
      for (const doc of documents as Record<string, unknown>[]) {
        const type = oneOf(doc.type, DOC_TYPES, 'documents.type');
        const url = str(doc.fileUrl, 'documents.fileUrl', { min: 3, max: 400 });
        run(db, `INSERT INTO driver_documents (id, driver_id, type, file_url) VALUES (?,?,?,?)`, id('doc'), profileId, type, url);
      }
    });

    audit(db, user, 'driver.registered', 'driver', user.id, { cityId, classes: driverClasses });
    return {
      ok: true,
      status: 'pending',
      message: 'Заявку надіслано. Документи на перевірці — зазвичай це до 24 годин.',
    };
  });

  app.get('/api/driver/me', async (req) => {
    const user = currentUser(db, req);
    const profile = driverProfile(db, user.id);
    const vehicles = all(db, `SELECT * FROM vehicles WHERE driver_id = ? AND active = 1`, user.id);
    const documents = all(db, `SELECT * FROM driver_documents WHERE driver_id = ? ORDER BY created_at DESC`, user.id);
    const activeOrders = all(
      db,
      `SELECT * FROM orders WHERE driver_id = ? AND status IN ('assigned','driver_arriving','waiting','in_progress')`,
      user.id,
    ).map((o) => project(db, o));
    return {
      profile: { ...profile, balance_cents: walletBalance(db, user.id) },
      vehicles, documents, activeOrders,
      settings: settingsFor(db, profile.city_id),
    };
  });

  app.post('/api/driver/documents', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = oneOf(body.type, DOC_TYPES, 'type');
    const fileUrl = str(body.fileUrl, 'fileUrl', { min: 3, max: 400 });
    run(db, `INSERT INTO driver_documents (id, driver_id, type, file_url) VALUES (?,?,?,?)`, id('doc'), user.id, type, fileUrl);
    run(db, `UPDATE driver_profiles SET status = 'pending' WHERE user_id = ? AND status = 'rejected'`, user.id);
    audit(db, user, 'driver.document_uploaded', 'driver', user.id, { type });
    return { ok: true };
  });

  /* ----------------------------------------------------------- work mode -- */
  app.post('/api/driver/online', async (req) => {
    const user = currentUser(db, req);
    const profile = driverProfile(db, user.id);
    if (profile.status !== 'verified') throw forbidden('Документи ще не перевірені');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.lat !== undefined && body.lng !== undefined) {
      run(db, `UPDATE driver_profiles SET lat = ?, lng = ?, location_at = ? WHERE user_id = ?`,
        num(body.lat, 'lat'), num(body.lng, 'lng'), new Date().toISOString(), user.id);
    }
    run(db, `UPDATE driver_profiles SET work_status = 'online' WHERE user_id = ?`, user.id);
    const orders = all(db, `SELECT * FROM orders WHERE status IN ('assigned','driver_arriving','waiting','in_progress') AND driver_id = ?`, user.id);
    return { ok: true, workStatus: orders.length ? 'busy' : 'online' };
  });

  app.post('/api/driver/offline', async (req) => {
    const user = currentUser(db, req);
    const active = one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM orders WHERE driver_id = ? AND status IN ('assigned','driver_arriving','waiting','in_progress')`,
      user.id,
    )!;
    if (active.n > 0) throw conflict('Завершіть активне замовлення перед виходом офлайн');
    run(db, `UPDATE driver_profiles SET work_status = 'offline' WHERE user_id = ?`, user.id);
    return { ok: true, workStatus: 'offline' };
  });

  app.patch('/api/driver/settings', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.autoAccept !== undefined) { fields.push('auto_accept = ?'); values.push(body.autoAccept ? 1 : 0); }
    if (body.acceptRadiusKm !== undefined) { fields.push('accept_radius_km = ?'); values.push(num(body.acceptRadiusKm, 'acceptRadiusKm', { min: 0.5, max: 50 })); }
    if (body.minPriceCents !== undefined) { fields.push('min_price_cents = ?'); values.push(num(body.minPriceCents, 'minPriceCents', { min: 0, max: 1_000_000, int: true })); }
    if (body.classes !== undefined) {
      const codes = all<{ code: string }>(db, `SELECT code FROM car_classes WHERE active = 1 AND kind = 'ride'`).map((c) => c.code);
      const list = (Array.isArray(body.classes) ? body.classes : []).map(String).filter((c) => codes.includes(c));
      if (!list.length) throw bad('Оберіть хоча б один клас', { field: 'classes' });
      fields.push('classes_csv = ?');
      values.push(list.join(','));
    }
    if (!fields.length) return { ok: true };
    run(db, `UPDATE driver_profiles SET ${fields.join(', ')} WHERE user_id = ?`, ...values, user.id);
    const profile = driverProfile(db, user.id);
    return { ok: true, profile };
  });

  app.post('/api/driver/location', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lat = num(body.lat, 'lat', { min: -90, max: 90 });
    const lng = num(body.lng, 'lng', { min: -180, max: 180 });
    const now = new Date().toISOString();
    run(db, `UPDATE driver_profiles SET lat = ?, lng = ?, location_at = ? WHERE user_id = ?`, lat, lng, now, user.id);
    run(db, `INSERT INTO driver_locations (driver_id, lat, lng) VALUES (?,?,?)`, user.id, lat, lng);
    // share with the passenger of the active order
    const active = one(db, `SELECT id FROM orders WHERE driver_id = ? AND status IN ('assigned','driver_arriving','waiting','in_progress') LIMIT 1`, user.id);
    if (active) {
      hub.toOrder(active.id, 'driver.location', { driverId: user.id, lat, lng, at: now });
    }
    // keep the driver visible on the dispatch map
    hub.publish(['role:dispatch', 'role:admin'], 'driver.location', { driverId: user.id, lat, lng, at: now });
    return { ok: true };
  });

  /* -------------------------------------------------------------- offers -- */
  app.get('/api/driver/offers', async (req) => {
    const user = currentUser(db, req);
    const offers = all(
      db,
      `SELECT o.*, ord.number, ord.city_id, ord.distance_m, ord.duration_s, ord.payment_method, ord.comment,
              ord.service_kind
       FROM order_offers o JOIN orders ord ON ord.id = o.order_id
       WHERE o.driver_id = ? AND o.status = 'offered' AND o.expires_at > ? ORDER BY o.created_at DESC`,
      user.id, iso(),
    );
    return {
      items: offers.map((o) => ({
        ...o,
        order: project(db, one(db, `SELECT * FROM orders WHERE id = ?`, o.order_id)!),
        secondsLeft: Math.max(0, Math.round((new Date(o.expires_at.replace(' ', 'T')).getTime() - Date.now()) / 1000)),
      })),
    };
  });

  app.post('/api/driver/offers/:id/accept', async (req) => {
    const user = currentUser(db, req);
    const { id: offerId } = req.params as { id: string };
    const order = acceptOffer(db, user.id, offerId, false);
    audit(db, user, 'driver.offer_accepted', 'order', order.id as string, { offerId });
    return { ok: true, order };
  });

  app.post('/api/driver/offers/:id/decline', async (req) => {
    const user = currentUser(db, req);
    const { id: offerId } = req.params as { id: string };
    declineOffer(db, user.id, offerId);
    return { ok: true };
  });

  /* -------------------------------------------------------- order status -- */
  app.post('/api/driver/orders/:id/status', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next = oneOf(body.status, ['driver_arriving', 'waiting', 'in_progress', 'completed'] as const, 'status');
    const order = getOrderFull(db, orderId);
    if (order.driver_id !== user.id) throw forbidden('Це замовлення вам не призначене');

    if (next === 'completed') {
      return tx(db, () => {
        run(db, `UPDATE orders SET final_price_cents = COALESCE(final_price_cents, quoted_price_cents) WHERE id = ?`, orderId);
        const updated = setStatus(db, orderId, 'completed', user.id, { event: 'order.completed' });
        const refreshed = one(db, `SELECT * FROM orders WHERE id = ?`, orderId)!;
        if (refreshed.payment_status !== 'paid' && refreshed.payment_method !== 'cash') {
          try {
            chargeOrder(db, orderId, refreshed.payment_method, `pay_${orderId}_${refreshed.payment_method}`, user.id);
          } catch {
            /* fall back to cash collection / support */
          }
        }
        settleOrder(db, orderId);
        checkQuests(db, user.id, refreshed.city_id as string);
        releaseDriver(db, user.id);
        notify(db, order.passenger_id, 'order_completed', 'Поїздку завершено', `Оцініть водія, №${order.number}`, { orderId });
        return { ok: true, order: project(db, updated) };
      });
    }

    tx(db, () => {
      const updated = setStatus(db, orderId, next, user.id, { event: `order.${next}` });
      if (next === 'driver_arriving') notify(db, order.passenger_id, 'driver_arriving', 'Водій на місці', 'Авто прибуло', { orderId });
      if (next === 'in_progress') notify(db, order.passenger_id, 'ride_started', 'Поїздка розпочалась', '', { orderId });
      return updated;
    });
    return { ok: true, order: getOrderFull(db, orderId) };
  });

  app.get('/api/driver/orders/active', async (req) => {
    const user = currentUser(db, req);
    const rows = all(
      db,
      `SELECT * FROM orders WHERE driver_id = ? AND status IN ('assigned','driver_arriving','waiting','in_progress') ORDER BY created_at`,
      user.id,
    );
    return { items: rows.map((r) => project(db, r)) };
  });

  /* ------------------------------------------------------ money and stats -- */
  app.get('/api/driver/earnings', async (req) => {
    const user = currentUser(db, req);
    const q = req.query as Record<string, string>;
    const days = Math.min(Number(q.days ?? 7), 90);
    const rows = all(
      db,
      `SELECT date(created_at) AS day, kind, SUM(amount_cents) AS total
       FROM wallet_transactions WHERE user_id = ? AND created_at >= datetime('now', ?)
       GROUP BY day, kind ORDER BY day DESC`,
      user.id, `-${days} days`,
    );
    const completed = all(
      db,
      `SELECT date(created_at) AS day, COUNT(*) AS rides, SUM(COALESCE(final_price_cents, quoted_price_cents)) AS gross,
              SUM(commission_cents) AS commission
       FROM orders WHERE driver_id = ? AND status = 'completed' AND created_at >= datetime('now', ?)
       GROUP BY day ORDER BY day DESC`,
      user.id, `-${days} days`,
    );
    return { balanceCents: walletBalance(db, user.id), transactions: rows, daily: completed };
  });

  app.get('/api/driver/transactions', async (req) => {
    const user = currentUser(db, req);
    const rows = all(db, `SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`, user.id);
    return { items: rows, balanceCents: walletBalance(db, user.id) };
  });

  app.post('/api/driver/payout', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = num(body.amountCents, 'amountCents', { min: 100, int: true });
    const key = body.idempotencyKey ? str(body.idempotencyKey, 'idempotencyKey', { max: 80 }) : `payout_${user.id}_${Date.now()}`;
    const txn = driverPayout(db, user.id, amount, key);
    audit(db, user, 'driver.payout', 'driver', user.id, { amount });
    return { ok: true, transaction: txn, balanceCents: walletBalance(db, user.id) };
  });

  app.get('/api/driver/stats', async (req) => {
    const user = currentUser(db, req);
    const profile = driverProfile(db, user.id);
    const offersTotal = Number(profile.offers_total ?? 0);
    const accepted = Number(profile.offers_accepted ?? 0);
    const acceptanceRate = offersTotal ? Math.round((accepted / offersTotal) * 1000) / 10 : 0;
    const totalOrders = Number(profile.orders_completed ?? 0) + Number(profile.orders_canceled ?? 0);
    const cancelRate = totalOrders ? Math.round((Number(profile.orders_canceled ?? 0) / totalOrders) * 1000) / 10 : 0;
    const sectors = all(
      db,
      `SELECT c.name AS city, COUNT(*) AS orders, SUM(COALESCE(final_price_cents,0)) AS gross
       FROM orders o JOIN cities c ON c.id = o.city_id
       WHERE o.driver_id = ? AND o.status = 'completed' GROUP BY c.name ORDER BY orders DESC`,
      user.id,
    );
    const hourly = all(
      db,
      `SELECT strftime('%H', created_at) AS hour, COUNT(*) AS orders FROM orders
       WHERE driver_id = ? AND status = 'completed' GROUP BY hour ORDER BY hour`,
      user.id,
    );
    const quests = all(db, `SELECT * FROM quests WHERE active = 1 AND (city_id IS NULL OR city_id = ?)`, profile.city_id).map((q) => {
      const cnt = one<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM orders WHERE driver_id = ? AND status = 'completed'
         AND date(created_at) BETWEEN ? AND ?`,
        user.id, q.valid_from ?? '1970-01-01', q.valid_to ?? '2999-12-31',
      )!;
      return { ...q, progress: cnt.n, done: cnt.n >= q.target_orders };
    });
    return {
      rating: profile.rating,
      ratingCount: profile.rating_count,
      acceptanceRate,
      cancelRate,
      ordersCompleted: profile.orders_completed,
      offersTotal,
      sectors, hourly, quests,
      level: totalOrders > 500 ? 'Platinum' : totalOrders > 200 ? 'Gold' : totalOrders > 50 ? 'Silver' : 'Bronze',
    };
  });

  app.get('/api/driver/reviews', async (req) => {
    const user = currentUser(db, req);
    const rows = all(
      db,
      `SELECT r.*, u.name AS passenger_name FROM reviews r JOIN users u ON u.id = r.passenger_id
       WHERE r.driver_id = ? ORDER BY r.created_at DESC LIMIT 50`,
      user.id,
    );
    return { items: rows };
  });

  /* ------------------------------------------------ moderation endpoints -- */
  app.get('/api/admin/drivers/pending', async (req) => {
    const user = currentUser(db, req);
    requireRole(user, 'admin', 'dispatcher');
    const rows = all(
      db,
      `SELECT d.*, u.name, u.phone FROM driver_profiles d JOIN users u ON u.id = d.user_id
       WHERE d.status IN ('pending','rejected') ORDER BY d.user_id`,
    );
    return {
      items: rows.map((r) => ({
        ...r,
        documents: all(db, `SELECT * FROM driver_documents WHERE driver_id = ? ORDER BY created_at DESC`, r.user_id),
        vehicles: all(db, `SELECT * FROM vehicles WHERE driver_id = ?`, r.user_id),
      })),
    };
  });

  app.post('/api/admin/drivers/:id/verify', async (req) => {
    const actor = currentUser(db, req);
    requireRole(actor, 'admin');
    const { id: driverId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const approve = body.approve === true;
    const reason = body.reason ? str(body.reason, 'reason', { max: 300 }) : null;
    const profile = one(db, `SELECT * FROM driver_profiles WHERE user_id = ?`, driverId);
    if (!profile) throw notFound('Водія не знайдено');
    const docs = all(db, `SELECT * FROM driver_documents WHERE driver_id = ?`, driverId);
    if (approve && docs.length === 0) throw unprocessable('Немає завантажених документів');

    tx(db, () => {
      run(db, `UPDATE driver_profiles SET status = ?, verified_at = ?, rejection_reason = ? WHERE user_id = ?`,
        approve ? 'verified' : 'rejected', approve ? iso() : null, approve ? null : reason, driverId);
      run(db, `UPDATE driver_documents SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE driver_id = ?`,
        approve ? 'approved' : 'rejected', actor.id, iso(), driverId);
    });
    audit(db, actor, approve ? 'driver.verified' : 'driver.rejected', 'driver', driverId, { reason });
    notify(db, driverId, 'verification', approve ? 'Документи підтверджено' : 'Документи відхилено', reason ?? '', {});
    return { ok: true, status: approve ? 'verified' : 'rejected' };
  });

  app.post('/api/admin/drivers/:id/block', async (req) => {
    const actor = currentUser(db, req);
    requireRole(actor, 'admin');
    const { id: driverId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const blocked = body.blocked !== false;
    run(db, `UPDATE driver_profiles SET status = ?, work_status = 'offline' WHERE user_id = ?`,
      blocked ? 'suspended' : 'verified', driverId);
    audit(db, actor, blocked ? 'driver.suspended' : 'driver.restored', 'driver', driverId, {});
    return { ok: true };
  });
}
