/**
 * Admin panel API — everything the back-office needs, all data-driven so the
 * platform is configurable without code changes.
 */
import type { FastifyInstance } from 'fastify';
import { all, Db, one, run, tx } from '../lib/db.js';
import { audit, currentUser, requireRole } from '../lib/http.js';
import { getOrderFull, notify, project, setStatus } from '../lib/order-service.js';
import { reassign } from '../lib/dispatch.js';
import { refundOrder } from '../lib/payments.js';
import { bad, conflict, id, iso, notFound, num, oneOf, str, unprocessable } from '../lib/util.js';

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(';'), ...rows.map((r) => columns.map((c) => esc(r[c])).join(';'))].join('\n');
}

export function registerAdminRoutes(app: FastifyInstance, db: Db) {
  const guard = (req: any, roles: string[] = ['admin', 'dispatcher']) => {
    const user = currentUser(db, req);
    requireRole(user, ...roles);
    return user;
  };

  app.get('/api/admin/dashboard', async (req) => {
    guard(req);
    const q = req.query as Record<string, string>;
    const cityFilter = q.cityId ? 'AND o.city_id = ?' : '';
    const params = q.cityId ? [q.cityId] : [];

    const today = one<any>(db, `SELECT COUNT(*) AS orders,
        COALESCE(SUM(COALESCE(final_price_cents, quoted_price_cents)),0) AS gross
      FROM orders o WHERE date(o.created_at) = date('now') ${cityFilter}`, ...params)!;
    const active = one<any>(db,
      `SELECT COUNT(*) AS n FROM orders o WHERE status IN ('searching','offered','assigned','driver_arriving','waiting','in_progress') ${cityFilter}`,
      ...params)!;
    const completedToday = one<any>(db,
      `SELECT COUNT(*) AS n FROM orders o WHERE status='completed' AND date(o.created_at)=date('now') ${cityFilter}`, ...params)!;
    const onlineDrivers = one<any>(db,
      `SELECT COUNT(*) AS n FROM driver_profiles WHERE work_status IN ('online','busy')` +
      (q.cityId ? ' AND city_id = ?' : ''), ...params)!;
    const pendingDrivers = one<any>(db, `SELECT COUNT(*) AS n FROM driver_profiles WHERE status = 'pending'`)!;
    const openTickets = one<any>(db, `SELECT COUNT(*) AS n FROM support_tickets WHERE status != 'closed'`)!;
    const revenue7 = all(db,
      `SELECT date(created_at) AS day, COUNT(*) AS orders,
              COALESCE(SUM(COALESCE(final_price_cents, quoted_price_cents)),0) AS gross,
              COALESCE(SUM(commission_cents),0) AS commission
       FROM orders o WHERE created_at >= datetime('now','-7 days') AND status='completed' ${cityFilter}
       GROUP BY day ORDER BY day`, ...params);
    const byCity = all(db,
      `SELECT c.name AS city, COUNT(o.id) AS orders, COALESCE(SUM(o.final_price_cents),0) AS gross
       FROM cities c LEFT JOIN orders o ON o.city_id = c.id AND o.status='completed'
       GROUP BY c.id ORDER BY orders DESC`);
    const byClass = all(db,
      `SELECT cc.name AS class, COUNT(o.id) AS orders FROM car_classes cc
       LEFT JOIN orders o ON o.class_id = cc.id AND o.status = 'completed' GROUP BY cc.id ORDER BY orders DESC`);
    const ratings = one<any>(db, `SELECT ROUND(AVG(rating),2) AS avg FROM reviews`)!;
    const cancellations = one<any>(db,
      `SELECT COUNT(*) AS n FROM orders WHERE status='canceled' AND created_at >= datetime('now','-7 days')`)!;

    return {
      today: { orders: today.orders, grossCents: today.gross, completed: completedToday.n },
      activeOrders: active.n,
      onlineDrivers: onlineDrivers.n,
      pendingDrivers: pendingDrivers.n,
      openTickets: openTickets.n,
      avgRating: ratings.avg ?? null,
      cancellations7d: cancellations.n,
      revenue7d: revenue7,
      byCity, byClass,
    };
  });

  app.get('/api/admin/live-map', async (req) => {
    guard(req);
    const drivers = all(db,
      `SELECT d.user_id, u.name, d.lat, d.lng, d.location_at, d.work_status, d.rating,
              (SELECT plate FROM vehicles v WHERE v.driver_id = d.user_id AND v.active=1 LIMIT 1) AS plate
       FROM driver_profiles d JOIN users u ON u.id = d.user_id
       WHERE d.lat IS NOT NULL AND d.work_status IN ('online','busy')`);
    const orders = all(db,
      `SELECT o.id, o.number, o.status, o.city_id, o.driver_id, o.quoted_price_cents,
              (SELECT json_group_array(json_object('lat',lat,'lng',lng,'kind',kind,'address',address))
                 FROM order_points p WHERE p.order_id = o.id) AS points
       FROM orders o WHERE o.status IN ('searching','offered','assigned','driver_arriving','waiting','in_progress')`);
    return {
      drivers,
      orders: orders.map((o) => ({ ...o, points: JSON.parse(o.points ?? '[]') })),
    };
  });

  app.get('/api/admin/users', async (req) => {
    guard(req);
    const q = req.query as Record<string, string>;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.role) { where.push('role = ?'); params.push(q.role); }
    if (q.q) { where.push('(phone LIKE ? OR lower(name) LIKE ?)'); params.push(`%${q.q}%`, `%${q.q.toLowerCase()}%`); }
    const rows = all(db,
      `SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.passenger_id = u.id) AS orders,
              (SELECT COUNT(*) FROM orders o WHERE o.driver_id = u.id) AS driver_orders
       FROM users u ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY u.created_at DESC LIMIT 200`,
      ...params);
    return { items: rows };
  });

  app.post('/api/admin/users/:id/block', async (req) => {
    const actor = guard(req, ['admin']);
    const { id: userId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const blocked = body.blocked !== false;
    run(db, `UPDATE users SET status = ? WHERE id = ?`, blocked ? 'blocked' : 'active', userId);
    audit(db, actor, blocked ? 'user.blocked' : 'user.unblocked', 'user', userId, {});
    return { ok: true };
  });

  app.get('/api/admin/orders', async (req) => {
    guard(req);
    const q = req.query as Record<string, string>;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) { where.push(`status IN (${q.status.split(',').map(() => '?').join(',')})`); params.push(...q.status.split(',')); }
    if (q.cityId) { where.push('city_id = ?'); params.push(q.cityId); }
    if (q.from) { where.push('created_at >= ?'); params.push(q.from); }
    if (q.to) { where.push('created_at <= ?'); params.push(q.to); }
    if (q.q) { where.push('(number LIKE ? OR id = ?)'); params.push(`%${q.q}%`, q.q); }
    const rows = all(db,
      `SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
      ...params, Math.min(Number(q.limit ?? 100), 300));
    return { items: rows.map((r) => project(db, r)) };
  });

  app.post('/api/admin/orders/:id/cancel', async (req) => {
    const actor = guard(req);
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = str(body.reason ?? 'Скасовано диспетчером', 'reason', { max: 200 });
    const order = one(db, `SELECT * FROM orders WHERE id = ?`, orderId);
    if (!order) throw notFound('Замовлення не знайдено');
    run(db, `UPDATE order_points SET note = note WHERE order_id = ?`, orderId);
    setStatus(db, orderId, 'canceled', actor.id, { reason: 'force', event: 'admin.canceled' });
    run(db, `UPDATE orders SET cancel_reason = ? WHERE id = ?`, reason, orderId);
    run(db, `UPDATE order_offers SET status='revoked' WHERE order_id = ? AND status='offered'`, orderId);
    if (order.driver_id) {
      run(db, `UPDATE driver_profiles SET work_status='online' WHERE user_id = ? AND work_status='busy'`, order.driver_id);
      notify(db, order.driver_id, 'order_canceled', 'Замовлення скасовано диспетчером', `№${order.number}`, { orderId });
    }
    notify(db, order.passenger_id, 'order_canceled', 'Замовлення скасовано', reason, { orderId });
    audit(db, actor, 'order.admin_canceled', 'order', orderId, { reason });
    return { ok: true, order: getOrderFull(db, orderId) };
  });

  app.post('/api/admin/orders/:id/reassign', async (req) => {
    const actor = guard(req);
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const driverId = str(body.driverId, 'driverId');
    const order = reassign(db, orderId, driverId, actor.id);
    audit(db, actor, 'order.reassigned', 'order', orderId, { driverId });
    return { order };
  });

  /* ---------------------------------------------------------------- money -- */
  app.post('/api/admin/orders/:id/refund', async (req) => {
    const actor = guard(req, ['admin']);
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = body.amountCents !== undefined ? num(body.amountCents, 'amountCents', { min: 1, int: true }) : null;
    const reason = str(body.reason ?? 'Повернення коштів', 'reason', { max: 200 });
    const res = refundOrder(db, orderId, amount, reason, actor.id);
    audit(db, actor, 'payment.refunded', 'order', orderId, { amount: res.refundedCents, reason });
    return res;
  });

  app.get('/api/admin/payments', async (req) => {
    guard(req);
    const rows = all(db,
      `SELECT p.*, o.number FROM payment_intents p JOIN orders o ON o.id = p.order_id
       ORDER BY p.created_at DESC LIMIT 200`);
    const summary = all(db,
      `SELECT method, COUNT(*) AS n, SUM(amount_cents) AS total FROM payment_intents
       WHERE status='captured' GROUP BY method`);
    return { items: rows, summary };
  });

  /* ----------------------------------------------------------- catalogue -- */
  app.get('/api/admin/tariffs', async (req) => {
    guard(req);
    const q = req.query as Record<string, string>;
    const rows = all(db,
      `SELECT t.*, c.name AS class_name, c.code AS class_code, ci.name AS city_name
       FROM tariffs t JOIN car_classes c ON c.id = t.class_id JOIN cities ci ON ci.id = t.city_id
       ${q.cityId ? 'WHERE t.city_id = ?' : ''} ORDER BY ci.name, c.sort`,
      ...(q.cityId ? [q.cityId] : []));
    return { items: rows };
  });

  app.patch('/api/admin/tariffs/:id', async (req) => {
    const actor = guard(req, ['admin']);
    const { id: tariffId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed = [
      'base_cents', 'per_km_cents', 'per_min_cents', 'min_fare_cents', 'per_stop_cents',
      'waiting_per_min_cents', 'cancel_fee_cents', 'intercity_per_km_cents', 'night_multiplier',
      'night_from', 'night_to', 'city_multiplier', 'commission_pct', 'active',
    ];
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed) {
      if (body[key] === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(typeof body[key] === 'boolean' ? Number(body[key]) : Number(body[key]));
    }
    if (!fields.length) throw bad('Немає полів для оновлення');
    run(db, `UPDATE tariffs SET ${fields.join(', ')}, version = version + 1 WHERE id = ?`, ...values, tariffId);
    audit(db, actor, 'tariff.updated', 'tariff', tariffId, body);
    return { ok: true, item: one(db, `SELECT * FROM tariffs WHERE id = ?`, tariffId) };
  });

  app.post('/api/admin/tariffs', async (req) => {
    const actor = guard(req, ['admin']);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cityId = str(body.cityId, 'cityId');
    const classId = str(body.classId, 'classId');
    const exists = one(db, `SELECT id FROM tariffs WHERE city_id = ? AND class_id = ? AND active = 1`, cityId, classId);
    if (exists) throw conflict('Тариф для цього міста та класу вже існує — відредагуйте його');
    const tariffId = id('trf');
    run(db,
      `INSERT INTO tariffs (id, city_id, class_id, base_cents, per_km_cents, per_min_cents, min_fare_cents,
        per_stop_cents, waiting_per_min_cents, cancel_fee_cents, intercity_per_km_cents, night_multiplier,
        city_multiplier, commission_pct, version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      tariffId, cityId, classId,
      num(body.baseCents, 'baseCents'), num(body.perKmCents, 'perKmCents'), num(body.perMinCents, 'perMinCents'),
      num(body.minFareCents, 'minFareCents'), num(body.perStopCents ?? 0, 'perStopCents'),
      num(body.waitingPerMinCents ?? 0, 'waitingPerMinCents'), num(body.cancelFeeCents ?? 0, 'cancelFeeCents'),
      body.intercityPerKmCents ? num(body.intercityPerKmCents, 'intercityPerKmCents') : null,
      num(body.nightMultiplier ?? 1, 'nightMultiplier'), num(body.cityMultiplier ?? 1, 'cityMultiplier'),
      num(body.commissionPct ?? 15, 'commissionPct'));
    audit(db, actor, 'tariff.created', 'tariff', tariffId, { cityId, classId });
    return { ok: true, item: one(db, `SELECT * FROM tariffs WHERE id = ?`, tariffId) };
  });

  app.get('/api/admin/classes', async (req) => {
    guard(req);
    return { items: all(db, `SELECT * FROM car_classes ORDER BY sort`) };
  });

  app.patch('/api/admin/classes/:id', async (req) => {
    const actor = guard(req, ['admin']);
    const { id: classId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ['name', 'sort', 'active', 'seats', 'luggage', 'icon']) {
      if (body[key] === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(typeof body[key] === 'boolean' ? Number(body[key]) : body[key]);
    }
    if (!fields.length) throw bad('Немає полів для оновлення');
    run(db, `UPDATE car_classes SET ${fields.join(', ')} WHERE id = ?`, ...values, classId);
    audit(db, actor, 'class.updated', 'class', classId, body);
    return { ok: true };
  });

  app.post('/api/admin/classes', async (req) => {
    const actor = guard(req, ['admin']);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = str(body.code, 'code', { min: 2, max: 30 }).toLowerCase().replace(/[^a-z0-9_]/g, '');
    const name = str(body.name, 'name', { min: 2, max: 40 });
    const kind = oneOf(body.kind, ['ride', 'delivery', 'service'] as const, 'kind', 'ride');
    const classId = `cls_${code}`;
    if (one(db, `SELECT id FROM car_classes WHERE id = ? OR code = ?`, classId, code)) throw conflict('Клас з таким кодом існує');
    run(db, `INSERT INTO car_classes (id, code, name, kind, seats, luggage, sort, icon) VALUES (?,?,?,?,?,?,?,?)`,
      classId, code, name, kind, num(body.seats ?? 4, 'seats'), num(body.luggage ?? 2, 'luggage'),
      num(body.sort ?? 100, 'sort'), body.icon ? String(body.icon) : null);
    // clone a base tariff so the class is immediately usable in every city
    for (const city of all<{ id: string }>(db, `SELECT id FROM cities WHERE active = 1`)) {
      const base = one(db, `SELECT * FROM tariffs WHERE city_id = ? AND class_id = 'cls_economy' LIMIT 1`, city.id);
      if (!base) continue;
      run(db,
        `INSERT INTO tariffs (id, city_id, class_id, base_cents, per_km_cents, per_min_cents, min_fare_cents,
          per_stop_cents, waiting_per_min_cents, cancel_fee_cents, night_multiplier, city_multiplier, commission_pct)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id('trf'), city.id, classId, base.base_cents, base.per_km_cents, base.per_min_cents, base.min_fare_cents,
        base.per_stop_cents, base.waiting_per_min_cents, base.cancel_fee_cents, base.night_multiplier,
        base.city_multiplier, base.commission_pct);
    }
    audit(db, actor, 'class.created', 'class', classId, { code, name });
    return { ok: true, item: one(db, `SELECT * FROM car_classes WHERE id = ?`, classId) };
  });

  app.get('/api/admin/options', async (req) => {
    guard(req);
    return { items: all(db, `SELECT * FROM order_options ORDER BY kind, name`) };
  });

  app.post('/api/admin/options', async (req) => {
    const actor = guard(req, ['admin']);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const optionId = id('opt');
    run(db,
      `INSERT INTO order_options (id, code, name, description, kind, price_cents, class_scope, max_qty, active)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      optionId, str(body.code, 'code', { min: 2, max: 40 }), str(body.name, 'name', { min: 2, max: 60 }),
      body.description ? String(body.description) : null,
      oneOf(body.kind, ['option', 'service'] as const, 'kind', 'option'),
      num(body.priceCents ?? 0, 'priceCents'), body.classScope ? String(body.classScope) : null,
      num(body.maxQty ?? 1, 'maxQty'));
    audit(db, actor, 'option.created', 'option', optionId, body);
    return { ok: true };
  });

  app.patch('/api/admin/options/:id', async (req) => {
    const actor = guard(req, ['admin']);
    const { id: optionId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const map: Record<string, string> = {
      name: 'name', priceCents: 'price_cents', active: 'active', classScope: 'class_scope', maxQty: 'max_qty',
    };
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (body[key] === undefined) continue;
      fields.push(`${column} = ?`);
      values.push(typeof body[key] === 'boolean' ? Number(body[key]) : body[key]);
    }
    if (!fields.length) throw bad('Немає полів для оновлення');
    run(db, `UPDATE order_options SET ${fields.join(', ')} WHERE id = ?`, ...values, optionId);
    audit(db, actor, 'option.updated', 'option', optionId, body);
    return { ok: true };
  });

  /* ------------------------------------------------------- cities & zones -- */
  app.get('/api/admin/cities', async (req) => {
    guard(req);
    return { items: all(db, `SELECT * FROM cities ORDER BY name`) };
  });

  app.post('/api/admin/cities', async (req) => {
    const actor = guard(req, ['admin']);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cityId = id('city');
    run(db, `INSERT INTO cities (id, name, region, country, currency, timezone, lat, lng, active) VALUES (?,?,?,?,?,?,?,?,1)`,
      cityId, str(body.name, 'name', { min: 2, max: 60 }), body.region ? String(body.region) : null,
      String(body.country ?? 'UA'), String(body.currency ?? 'UAH'), String(body.timezone ?? 'Europe/Kyiv'),
      num(body.lat, 'lat', { min: -90, max: 90 }), num(body.lng, 'lng', { min: -180, max: 180 }));
    run(db, `INSERT INTO dispatch_settings (city_id) VALUES (?)`, cityId);
    // copy tariffs from the first city so the new city works immediately
    const template = one<{ city_id: string }>(db, `SELECT city_id FROM tariffs LIMIT 1`);
    if (template) {
      for (const t of all(db, `SELECT * FROM tariffs WHERE city_id = ?`, template.city_id)) {
        run(db,
          `INSERT INTO tariffs (id, city_id, class_id, base_cents, per_km_cents, per_min_cents, min_fare_cents,
            per_stop_cents, waiting_per_min_cents, cancel_fee_cents, intercity_per_km_cents, night_multiplier,
            night_from, night_to, city_multiplier, commission_pct)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id('trf'), cityId, t.class_id, t.base_cents, t.per_km_cents, t.per_min_cents, t.min_fare_cents,
          t.per_stop_cents, t.waiting_per_min_cents, t.cancel_fee_cents, t.intercity_per_km_cents,
          t.night_multiplier, t.night_from, t.night_to, t.city_multiplier, t.commission_pct);
      }
    }
    audit(db, actor, 'city.created', 'city', cityId, { name: body.name });
    return { ok: true, item: one(db, `SELECT * FROM cities WHERE id = ?`, cityId) };
  });

  app.patch('/api/admin/cities/:id', async (req) => {
    const actor = guard(req, ['admin']);
    const { id: cityId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ['name', 'region', 'active', 'currency', 'timezone']) {
      if (body[key] === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(typeof body[key] === 'boolean' ? Number(body[key]) : body[key]);
    }
    if (!fields.length) throw bad('Немає полів для оновлення');
    run(db, `UPDATE cities SET ${fields.join(', ')} WHERE id = ?`, ...values, cityId);
    audit(db, actor, 'city.updated', 'city', cityId, body);
    return { ok: true };
  });

  app.get('/api/admin/zones', async (req) => {
    guard(req);
    const q = req.query as Record<string, string>;
    const rows = all(db, `SELECT * FROM zones ${q.cityId ? 'WHERE city_id = ?' : ''} ORDER BY name`,
      ...(q.cityId ? [q.cityId] : []));
    return { items: rows.map((z) => ({ ...z, polygon: JSON.parse(z.polygon_json) })) };
  });

  app.post('/api/admin/zones', async (req) => {
    const actor = guard(req, ['admin']);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const polygon = Array.isArray(body.polygon) ? body.polygon : null;
    if (!polygon || polygon.length < 3) throw bad('Полігон має містити щонайменше 3 точки', { field: 'polygon' });
    const zoneId = id('zn');
    run(db, `INSERT INTO zones (id, city_id, name, kind, polygon_json, multiplier) VALUES (?,?,?,?,?,?)`,
      zoneId, str(body.cityId, 'cityId'), str(body.name, 'name', { min: 2, max: 60 }),
      oneOf(body.kind, ['tariff', 'surge', 'service_area'] as const, 'kind', 'surge'),
      JSON.stringify(polygon), num(body.multiplier ?? 1, 'multiplier', { min: 0.1, max: 5 }));
    audit(db, actor, 'zone.created', 'zone', zoneId, {});
    return { ok: true };
  });

  app.delete('/api/admin/zones/:id', async (req) => {
    const actor = guard(req, ['admin']);
    const { id: zoneId } = req.params as { id: string };
    run(db, `DELETE FROM zones WHERE id = ?`, zoneId);
    audit(db, actor, 'zone.deleted', 'zone', zoneId, {});
    return { ok: true };
  });

  /* -------------------------------------------------------------- promos --- */
  app.get('/api/admin/promos', async (req) => {
    guard(req);
    return { items: all(db, `SELECT * FROM promo_codes ORDER BY created_at DESC`) };
  });

  app.post('/api/admin/promos', async (req) => {
    const actor = guard(req, ['admin']);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = str(body.code, 'code', { min: 2, max: 30 }).toUpperCase();
    if (one(db, `SELECT code FROM promo_codes WHERE code = ?`, code)) throw conflict('Такий промокод уже існує');
    run(db,
      `INSERT INTO promo_codes (code, kind, value, min_fare_cents, max_discount_cents, city_id, class_scope,
        usage_limit, per_user_limit, valid_from, valid_to, active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      code, oneOf(body.kind, ['percent', 'fixed', 'free_ride'] as const, 'kind', 'percent'),
      num(body.value ?? 0, 'value'), num(body.minFareCents ?? 0, 'minFareCents'),
      body.maxDiscountCents !== undefined ? num(body.maxDiscountCents, 'maxDiscountCents') : null,
      body.cityId ? String(body.cityId) : null, body.classScope ? String(body.classScope) : null,
      body.usageLimit !== undefined ? num(body.usageLimit, 'usageLimit') : null,
      num(body.perUserLimit ?? 1, 'perUserLimit'),
      body.validFrom ? String(body.validFrom) : null, body.validTo ? String(body.validTo) : null,
      body.active === false ? 0 : 1);
    audit(db, actor, 'promo.created', 'promo', code, {});
    return { ok: true };
  });

  app.patch('/api/admin/promos/:code', async (req) => {
    const actor = guard(req, ['admin']);
    const { code } = req.params as { code: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      active: 'active', value: 'value', usageLimit: 'usage_limit', validTo: 'valid_to', perUserLimit: 'per_user_limit',
    };
    for (const [key, column] of Object.entries(map)) {
      if (body[key] === undefined) continue;
      fields.push(`${column} = ?`);
      values.push(typeof body[key] === 'boolean' ? Number(body[key]) : body[key]);
    }
    if (!fields.length) throw bad('Немає полів для оновлення');
    run(db, `UPDATE promo_codes SET ${fields.join(', ')} WHERE code = ?`, ...values, code);
    audit(db, actor, 'promo.updated', 'promo', code, body);
    return { ok: true };
  });

  /* ------------------------------------------------- reviews & moderation -- */
  app.get('/api/admin/reviews', async (req) => {
    guard(req);
    const rows = all(db,
      `SELECT r.*, u.name AS driver_name, p.name AS passenger_name, o.number
       FROM reviews r JOIN users u ON u.id = r.driver_id JOIN users p ON p.id = r.passenger_id
       LEFT JOIN orders o ON o.id = r.order_id ORDER BY r.created_at DESC LIMIT 200`);
    return { items: rows };
  });

  app.delete('/api/admin/reviews/:id', async (req) => {
    const actor = guard(req, ['admin']);
    const { id: reviewId } = req.params as { id: string };
    const review = one(db, `SELECT * FROM reviews WHERE id = ?`, reviewId);
    if (!review) throw notFound('Відгук не знайдено');
    run(db, `DELETE FROM reviews WHERE id = ?`, reviewId);
    const agg = one<any>(db, `SELECT AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE driver_id = ?`, review.driver_id)!;
    run(db, `UPDATE driver_profiles SET rating = ROUND(?,2), rating_count = ? WHERE user_id = ?`,
      agg.avg ?? 5, agg.n, review.driver_id);
    audit(db, actor, 'review.deleted', 'review', reviewId, { reason: 'moderation' });
    return { ok: true };
  });

  /* -------------------------------------------------------------- quests --- */
  app.get('/api/admin/quests', async (req) => {
    guard(req);
    return { items: all(db, `SELECT * FROM quests ORDER BY valid_to DESC`) };
  });

  app.post('/api/admin/quests', async (req) => {
    const actor = guard(req, ['admin']);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const questId = id('qst');
    run(db,
      `INSERT INTO quests (id, city_id, title, description, target_orders, bonus_cents, valid_from, valid_to, active)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      questId, body.cityId ? String(body.cityId) : null, str(body.title, 'title', { min: 3, max: 80 }),
      body.description ? String(body.description) : null,
      num(body.targetOrders, 'targetOrders', { min: 1, int: true }),
      num(body.bonusCents, 'bonusCents', { min: 100, int: true }),
      body.validFrom ? String(body.validFrom) : iso().slice(0, 10),
      body.validTo ? String(body.validTo) : null);
    audit(db, actor, 'quest.created', 'quest', questId, {});
    return { ok: true };
  });

  /* ------------------------------------------------- settings & audit log -- */
  app.get('/api/admin/settings', async (req) => {
    guard(req, ['admin']);
    const rows = all(db, `SELECT * FROM settings ORDER BY key`);
    return {
      items: rows.map((r) => ({ key: r.key, value: JSON.parse(r.value), updatedAt: r.updated_at })),
      roles: all(db, `SELECT * FROM roles`),
      dispatch: all(db, `SELECT * FROM dispatch_settings`),
    };
  });

  app.patch('/api/admin/settings', async (req) => {
    const actor = guard(req, ['admin']);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const entries = Object.entries(body);
    if (!entries.length) throw bad('Немає налаштувань для оновлення');
    tx(db, () => {
      for (const [key, value] of entries) {
        run(db, `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          key, JSON.stringify(value), iso());
      }
    });
    audit(db, actor, 'settings.updated', 'settings', null, body);
    return { ok: true };
  });

  app.patch('/api/admin/dispatch/:cityId', async (req) => {
    const actor = guard(req, ['admin']);
    const { cityId } = req.params as { cityId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const map: Record<string, string> = {
      offerTimeoutS: 'offer_timeout_s', offerRounds: 'offer_rounds', searchRadiusKm: 'search_radius_km',
      maxActiveOrders: 'max_active_orders', autoAcceptMaxDistanceKm: 'auto_accept_max_distance_km',
      parallelOffers: 'parallel_offers',
    };
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (body[key] === undefined) continue;
      fields.push(`${column} = ?`);
      values.push(Number(body[key]));
    }
    if (!fields.length) throw bad('Немає полів для оновлення');
    run(db, `UPDATE dispatch_settings SET ${fields.join(', ')} WHERE city_id = ?`, ...values, cityId);
    audit(db, actor, 'dispatch.updated', 'dispatch', cityId, body);
    return { ok: true, item: one(db, `SELECT * FROM dispatch_settings WHERE city_id = ?`, cityId) };
  });

  app.get('/api/admin/audit', async (req) => {
    guard(req, ['admin']);
    const q = req.query as Record<string, string>;
    const rows = all(db,
      `SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       ${q.entity ? 'WHERE a.entity = ?' : ''} ORDER BY a.created_at DESC LIMIT 200`,
      ...(q.entity ? [q.entity] : []));
    return { items: rows };
  });

  /* -------------------------------------------------------------- reports -- */
  app.get('/api/admin/reports/orders.csv', async (req, reply) => {
    guard(req, ['admin']);
    const q = req.query as Record<string, string>;
    const rows = all(db,
      `SELECT o.number, o.created_at, o.status, c.name AS city, cc.name AS class, o.service_kind,
              o.payment_method, o.payment_status, o.quoted_price_cents, o.final_price_cents,
              o.commission_cents, o.distance_m, u.phone AS passenger, d.name AS driver
       FROM orders o JOIN cities c ON c.id = o.city_id JOIN car_classes cc ON cc.id = o.class_id
       JOIN users u ON u.id = o.passenger_id LEFT JOIN users d ON d.id = o.driver_id
       WHERE o.created_at BETWEEN ? AND ? ORDER BY o.created_at DESC`,
      q.from ?? '1970-01-01', q.to ?? '2999-12-31');
    audit(db, currentUser(db, req), 'report.exported', 'report', 'orders', { rows: rows.length });
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="orders.csv"');
    return '\uFEFF' + toCsv(rows, [
      'number', 'created_at', 'status', 'city', 'class', 'service_kind', 'payment_method', 'payment_status',
      'quoted_price_cents', 'final_price_cents', 'commission_cents', 'distance_m', 'passenger', 'driver',
    ]);
  });

  app.get('/api/admin/reports/finance.csv', async (req, reply) => {
    guard(req, ['admin']);
    const q = req.query as Record<string, string>;
    const rows = all(db,
      `SELECT date(o.created_at) AS day, COUNT(*) AS orders,
              SUM(COALESCE(o.final_price_cents, o.quoted_price_cents)) AS gross_cents,
              SUM(COALESCE(o.commission_cents,0)) AS commission_cents,
              SUM(COALESCE(o.discount_cents,0)) AS discount_cents,
              SUM(COALESCE(o.cashback_cents,0)) AS cashback_cents
       FROM orders o WHERE o.status = 'completed' AND o.created_at BETWEEN ? AND ?
       GROUP BY day ORDER BY day`,
      q.from ?? '1970-01-01', q.to ?? '2999-12-31');
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="finance.csv"');
    return '\uFEFF' + toCsv(rows, ['day', 'orders', 'gross_cents', 'commission_cents', 'discount_cents', 'cashback_cents']);
  });

  /* ------------------------------------------------------------ companies -- */
  app.get('/api/admin/companies', async (req) => {
    guard(req);
    const rows = all(db,
      `SELECT c.*, (SELECT COUNT(*) FROM corporate_members m WHERE m.company_id = c.id) AS members,
              (SELECT COALESCE(SUM(total_cents),0) FROM corporate_invoices i WHERE i.company_id = c.id AND i.status='open') AS open_invoice_cents
       FROM companies c ORDER BY c.created_at DESC`);
    return { items: rows };
  });

  app.post('/api/admin/companies', async (req) => {
    const actor = guard(req, ['admin']);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const companyId = id('cmp');
    run(db,
      `INSERT INTO companies (id, name, edrpou, city_id, discount_pct, credit_limit_cents, invoice_email, status)
       VALUES (?,?,?,?,?,?,?, 'active')`,
      companyId, str(body.name, 'name', { min: 2, max: 120 }), body.edrpou ? String(body.edrpou) : null,
      body.cityId ? String(body.cityId) : null, num(body.discountPct ?? 0, 'discountPct'),
      num(body.creditLimitCents ?? 0, 'creditLimitCents'), body.invoiceEmail ? String(body.invoiceEmail) : null);
    audit(db, actor, 'company.created', 'company', companyId, { name: body.name });
    return { ok: true, item: one(db, `SELECT * FROM companies WHERE id = ?`, companyId) };
  });

  app.get('/api/admin/settlements', async (req) => {
    guard(req, ['admin']);
    const drivers = all(db,
      `SELECT d.user_id, u.name, u.phone, d.balance_cents, d.commission_pct, d.orders_completed,
              (SELECT COALESCE(SUM(amount_cents),0) FROM wallet_transactions w WHERE w.user_id = d.user_id AND w.kind='driver_earning') AS earned_cents
       FROM driver_profiles d JOIN users u ON u.id = d.user_id ORDER BY d.balance_cents DESC`);
    return { items: drivers };
  });
}
