/**
 * Shared order domain helpers: status machine, events, projections, realtime
 * fan-out. Used by orders / dispatch / driver / admin modules.
 */
import { all, Db, one, Row } from './db.js';
import { hub } from './realtime.js';
import { ApiError, conflict, iso, notFound, parseJson } from './util.js';

export const ORDER_STATUSES = [
  'searching', 'offered', 'assigned', 'driver_arriving', 'waiting',
  'in_progress', 'completed', 'canceled', 'expired', 'no_drivers',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Allowed transitions of the order state machine. */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  searching: ['offered', 'assigned', 'canceled', 'no_drivers', 'expired'],
  offered: ['assigned', 'searching', 'no_drivers', 'canceled', 'expired'],
  no_drivers: ['searching', 'offered', 'assigned', 'canceled'],
  assigned: ['driver_arriving', 'in_progress', 'canceled', 'searching'],
  driver_arriving: ['waiting', 'in_progress', 'canceled'],
  waiting: ['in_progress', 'canceled'],
  in_progress: ['completed', 'canceled'],
  completed: [],
  canceled: [],
  expired: [],
};

export const ACTIVE_STATUSES: OrderStatus[] = ['searching', 'offered', 'no_drivers', 'assigned', 'driver_arriving', 'waiting', 'in_progress'];

export function assertTransition(from: string, to: OrderStatus) {
  const allowed = TRANSITIONS[from as OrderStatus] ?? [];
  if (!allowed.includes(to)) {
    throw conflict(`Недопустимий перехід статусу ${from} → ${to}`);
  }
}

export function addEvent(db: Db, orderId: string, type: string, actorId: string | null, payload: Row = {}) {
  db.prepare(`INSERT INTO order_events (order_id, type, actor_id, payload) VALUES (?,?,?,?)`)
    .run(orderId, type, actorId, JSON.stringify(payload));
}

export interface OrderFull extends Row {
  points: Row[];
  options: string[];
  forOther: Row | null;
  delivery: Row | null;
  driver: Row | null;
  vehicle: Row | null;
}

export function getOrderFull(db: Db, orderId: string): OrderFull {
  const order = one(db, `SELECT * FROM orders WHERE id = ?`, orderId);
  if (!order) throw notFound('Замовлення не знайдено');
  return project(db, order);
}

export function project(db: Db, order: Row): OrderFull {
  const points = all(db, `SELECT * FROM order_points WHERE order_id = ? ORDER BY seq`, order.id);
  const delivery = one(db, `SELECT * FROM deliveries WHERE order_id = ?`, order.id) ?? null;
  let driver: Row | null = null;
  let vehicle: Row | null = null;
  if (order.driver_id) {
    driver = one(
      db,
      `SELECT u.id, u.name, u.phone, u.photo_url, d.rating, d.rating_count, d.orders_completed, d.lat, d.lng
       FROM users u JOIN driver_profiles d ON d.user_id = u.id WHERE u.id = ?`,
      order.driver_id,
    ) ?? null;
    if (order.vehicle_id) vehicle = one(db, `SELECT * FROM vehicles WHERE id = ?`, order.vehicle_id) ?? null;
  }
  return {
    ...order,
    options: parseJson<string[]>(order.options_json, []),
    points,
    forOther: parseJson<Row | null>(order.for_other_json, null),
    delivery,
    driver,
    vehicle,
  };
}

export function orderChannel(orderId: string) {
  return `order:${orderId}`;
}

export function orderChannelsFor(order: Row): string[] {
  const channels = [orderChannel(order.id), `user:${order.passenger_id}`];
  if (order.driver_id) channels.push(`user:${order.driver_id}`);
  channels.push('role:dispatch', 'role:admin');
  return channels;
}

/** Persist a status change, emit events + realtime fan-out. */
export function setStatus(
  db: Db,
  orderId: string, to: OrderStatus, actorId: string | null, extra: { reason?: string; event?: string } = {},
): Row {
  const order = one(db, `SELECT * FROM orders WHERE id = ?`, orderId);
  if (!order) throw notFound('Замовлення не знайдено');
  if (extra.reason === 'force') {
    /* admin/moderator override — skips the state machine on purpose */
  } else {
    assertTransition(order.status, to);
  }
  const stamp: Record<string, string> = {};
  const now = iso();
  if (to === 'assigned') stamp.accepted_at = now;
  if (to === 'driver_arriving') stamp.arrived_at = now;
  if (to === 'in_progress') stamp.started_at = now;
  if (to === 'completed') stamp.finished_at = now;
  if (to === 'canceled') stamp.canceled_at = now;

  const fields = ['status = ?', ...Object.keys(stamp).map((k) => `${k} = ?`)];
  db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`)
    .run(to, ...Object.values(stamp), orderId);

  addEvent(db, orderId, extra.event ?? `status.${to}`, actorId, { from: order.status, to });
  const updated = one(db, `SELECT * FROM orders WHERE id = ?`, orderId)!;
  hub.publish(orderChannelsFor(updated), 'order.updated', project(db, updated));
  return updated;
}

export function notify(db: Db, userId: string, kind: string, title: string, body = '', payload: Row = {}) {
  const notifId = `ntf_${Math.random().toString(36).slice(2, 16)}`;
  db.prepare(`INSERT INTO notifications (id, user_id, kind, title, body, payload) VALUES (?,?,?,?,?,?)`)
    .run(notifId, userId, kind, title, body, JSON.stringify(payload));
  hub.toUser(userId, 'notification', { id: notifId, kind, title, body, payload });
}

export function requireOwner(order: Row, userId: string, role: string) {
  if (['admin', 'dispatcher'].includes(role)) return;
  if (order.passenger_id !== userId && order.driver_id !== userId) {
    throw new ApiError(403, 'forbidden', 'Замовлення належить іншому користувачу');
  }
}

export function countActiveOrders(db: Db, passengerId: string): number {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  const row = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM orders WHERE passenger_id = ? AND status IN (${placeholders})`,
    passengerId, ...ACTIVE_STATUSES,
  )!;
  return row.n;
}
