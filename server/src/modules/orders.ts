/**
 * Orders module — creation, quoting, lifecycle, routing changes, delivery
 * confirmation, payments, ratings. This is the aggregation boundary of the
 * domain: every state change goes through the order state machine
 * (lib/order-service.ts) and dispatch engine (lib/dispatch.ts).
 */
import type { FastifyInstance } from 'fastify';
import { all, Db, one, run, tx } from '../lib/db.js';
import { assignManually, tryDispatch } from '../lib/dispatch.js';
import { audit, currentUser, requireRole } from '../lib/http.js';
import { countActiveOrders, getOrderFull, notify, project, requireOwner, setStatus } from '../lib/order-service.js';
import { chargeOrder, PAYMENT_METHODS, settleOrder, type PaymentMethod } from '../lib/payments.js';
import { promoDiscount, quote, quoteAll, validatePromo } from '../lib/pricing.js';
import { releaseDriver } from '../lib/dispatch.js';
import { arr, bad, conflict, forbidden, id, iso, notFound, num, oneOf, orderNumber, parseJson, str, unprocessable } from '../lib/util.js';

const PAYMENT_LIST = PAYMENT_METHODS;

function serviceKindForClass(cls: Record<string, any>): string {
  if (cls.kind === 'delivery') return 'delivery';
  if (cls.kind === 'service') return cls.code === 'sober' ? 'sober' : 'intercity';
  return 'ride';
}

interface RawPoint { address?: string; lat?: unknown; lng?: unknown; note?: string; contactName?: string; contactPhone?: string }

function normalizePoints(raw: unknown, maxStops: number) {
  const list = arr<RawPoint>(raw);
  if (list.length < 2) throw bad('Потрібні точка подачі та точка призначення', { field: 'points' });
  if (list.length > maxStops + 2) throw bad(`Максимум ${maxStops} проміжних зупинок`, { field: 'points' });
  return list.map((p, index) => ({
    seq: index,
    kind: index === 0 ? 'pickup' : index === list.length - 1 ? 'dropoff' : 'stop',
    address: str(p.address, `points[${index}].address`, { min: 2, max: 200 }),
    lat: num(p.lat, `points[${index}].lat`, { min: -90, max: 90 }),
    lng: num(p.lng, `points[${index}].lng`, { min: -180, max: 180 }),
    note: p.note ? str(p.note, `points[${index}].note`, { max: 200 }) : null,
    contactName: p.contactName ? str(p.contactName, `points[${index}].contactName`, { max: 80 }) : null,
    contactPhone: p.contactPhone ? str(p.contactPhone, `points[${index}].contactPhone`, { max: 20 }) : null,
  }));
}

function settingValue(db: Db, key: string, fallback: number): number {
  const row = one(db, `SELECT value FROM settings WHERE key = ?`, key);
  if (!row) return fallback;
  try {
    const v = JSON.parse(row.value);
    return typeof v === 'number' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function registerOrderRoutes(app: FastifyInstance, db: Db) {
  /* ------------------------------------------------------------- catalog -- */
  app.get('/api/catalog', async (req) => {
    const q = req.query as Record<string, string>;
    const cityId = str(q.cityId, 'cityId');
    const city = one(db, `SELECT * FROM cities WHERE id = ? AND active = 1`, cityId);
    if (!city) throw notFound('Місто не обслуговується');
    const optionCodes = q.optionCodes ? q.optionCodes.split(',') : [];
    const classKind = q.classKind ? oneOf(q.classKind, ['ride', 'delivery', 'service'] as const, 'classKind') : 'ride';
    const classes = all(
      db,
      `SELECT c.* FROM car_classes c JOIN tariffs t ON t.class_id = c.id AND t.city_id = ? AND t.active = 1
       WHERE c.active = 1 AND c.kind = ? ORDER BY c.sort`,
      cityId, classKind,
    );
    const options = all(db, `SELECT * FROM order_options WHERE active = 1 ORDER BY kind, name`);
    const services = all(db, `SELECT * FROM car_classes WHERE active = 1 AND kind != 'ride' ORDER BY sort`);
    return { city, classes, options, services, maxStops: settingValue(db, 'max_stops', 5) };
  });

  app.post('/api/orders/quote', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cityId = str(body.cityId, 'cityId');
    const points = normalizePoints(body.points, settingValue(db, 'max_stops', 5));
    const serviceKind = oneOf(body.serviceKind, ['ride', 'delivery', 'sober', 'intercity'] as const, 'serviceKind', 'ride');
    const optionCodes = arr<string>(body.options);
    const promoCode = body.promoCode ? str(body.promoCode, 'promoCode', { max: 40 }) : null;
    const scheduledAt = body.scheduledAt ? str(body.scheduledAt, 'scheduledAt') : null;

    const base = {
      cityId, points, serviceKind, optionCodes, promoCode,
      plusMinusCents: body.plusMinusCents !== undefined ? num(body.plusMinusCents, 'plusMinusCents', { int: true }) : 0,
      userId: user.id, corporateId: (user.corporate_id as string) ?? null,
      at: scheduledAt ? new Date(scheduledAt.replace(' ', 'T')) : new Date(),
    };

    if (body.classId) {
      const result = quote(db, { ...base, classId: str(body.classId, 'classId') });
      return { quote: result };
    }
    const classKind = serviceKind === 'delivery' ? 'delivery' : serviceKind === 'ride' ? 'ride' : 'service';
    const quotes = quoteAll(db, { ...base, classKind });
    return { quotes, distanceM: quotes[0]?.distanceM ?? 0 };
  });

  app.post('/api/promo/validate', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = str(body.code, 'code', { min: 2, max: 40 }).toUpperCase();
    const q = quote(db, {
      cityId: str(body.cityId, 'cityId'),
      classId: str(body.classId, 'classId'),
      points: normalizePoints(body.points, settingValue(db, 'max_stops', 5)),
      userId: user.id,
    });
    const res = validatePromo(db, code, {
      userId: user.id, cityId: String(body.cityId), classId: String(body.classId),
      subtotalCents: q.fareCents, classCode: q.classCode,
    });
    if (!res.ok || !res.promo) return { valid: false, reason: res.reason };
    return { valid: true, discountCents: promoDiscount(res.promo, q.fareCents), promo: { code: res.promo.code, kind: res.promo.kind, value: res.promo.value } };
  });

  /* -------------------------------------------------------------- create -- */
  app.post('/api/orders', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cityId = str(body.cityId, 'cityId');
    const classId = str(body.classId, 'classId');
    const city = one(db, `SELECT * FROM cities WHERE id = ? AND active = 1`, cityId);
    if (!city) throw unprocessable('Місто не обслуговується');
    const cls = one(db, `SELECT * FROM car_classes WHERE id = ? AND active = 1`, classId);
    if (!cls) throw unprocessable('Клас авто недоступний');

    const serviceKind = oneOf(body.serviceKind, ['ride', 'delivery', 'sober', 'intercity'] as const, 'serviceKind', serviceKindForClass(cls) as any);
    const points = normalizePoints(body.points, settingValue(db, 'max_stops', 5));
    const paymentMethod = oneOf(body.paymentMethod, PAYMENT_LIST, 'paymentMethod', 'cash') as PaymentMethod;
    const optionCodes = arr<string>(body.options).map((o) => String(o));

    const maxActive = settingValue(db, 'max_active_rides', 5);
    if (countActiveOrders(db, user.id) >= maxActive) {
      throw conflict(`Досягнуто ліміт одночасних замовлень (${maxActive})`);
    }

    let scheduledAt: string | null = null;
    if (body.scheduledAt) {
      const at = new Date(String(body.scheduledAt).replace(' ', 'T'));
      if (Number.isNaN(at.getTime())) throw bad('Некоректна дата попереднього замовлення', { field: 'scheduledAt' });
      const leadMin = settingValue(db, 'scheduled_min_lead_minutes', 15);
      if (at.getTime() < Date.now() + leadMin * 60_000) {
        throw unprocessable(`Попереднє замовлення — мінімум за ${leadMin} хв до подачі`);
      }
      if (at.getTime() > Date.now() + 30 * 864e5) throw unprocessable('Попереднє замовлення — не більше ніж за 30 днів');
      scheduledAt = at.toISOString().replace('T', ' ').slice(0, 19);
    }

    let forOther: Record<string, string> | null = null;
    if (body.forOther) {
      const raw = body.forOther as Record<string, unknown>;
      forOther = {
        name: str(raw.name, 'forOther.name', { min: 2, max: 80 }),
        phone: str(raw.phone, 'forOther.phone', { min: 9, max: 20 }),
      };
    }

    let delivery: Record<string, unknown> | null = null;
    if (serviceKind === 'delivery') {
      const raw = (body.delivery ?? {}) as Record<string, unknown>;
      const weight = num(raw.weightKg, 'delivery.weightKg', { min: 0.1, max: 20 });
      delivery = {
        senderName: str(raw.senderName, 'delivery.senderName', { min: 2, max: 80 }),
        senderPhone: str(raw.senderPhone, 'delivery.senderPhone', { min: 9, max: 20 }),
        recipientName: str(raw.recipientName, 'delivery.recipientName', { min: 2, max: 80 }),
        recipientPhone: str(raw.recipientPhone, 'delivery.recipientPhone', { min: 9, max: 20 }),
        weightKg: weight,
        declaredValueCents: raw.declaredValueCents ? num(raw.declaredValueCents, 'delivery.declaredValueCents', { min: 0, max: 10_000_000 }) : 0,
        description: raw.description ? str(raw.description, 'delivery.description', { max: 300 }) : null,
        instructions: raw.instructions ? str(raw.instructions, 'delivery.instructions', { max: 300 }) : null,
      };
    }

    const promoCode = body.promoCode ? str(body.promoCode, 'promoCode', { max: 40 }).toUpperCase() : null;
    const plusMinusCents = body.plusMinusCents ? num(body.plusMinusCents, 'plusMinusCents', { int: true }) : 0;
    const comment = body.comment ? str(body.comment, 'comment', { max: 300 }) : null;

    const quoteResult = quote(db, {
      cityId, classId, points, serviceKind, optionCodes, promoCode, paymentMethod,
      userId: user.id, corporateId: paymentMethod === 'corporate' ? (user.corporate_id as string) : null,
      plusMinusCents,
      at: scheduledAt ? new Date(scheduledAt.replace(' ', 'T')) : new Date(),
    });

    const orderId = id('ord');
    const number = orderNumber();

    tx(db, () => {
      run(
        db,
        `INSERT INTO orders (id, number, passenger_id, city_id, class_id, service_kind, status, payment_method,
          quoted_price_cents, discount_cents, plus_minus_cents, currency, promo_code, distance_m, duration_s,
          pickup_eta_s, comment, options_json, for_other_json, corporate_id, scheduled_at)
         VALUES (?,?,?,?,?,?,'searching',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        orderId, number, user.id, cityId, classId, serviceKind, paymentMethod,
        quoteResult.totalCents, quoteResult.discountCents, plusMinusCents, quoteResult.currency,
        promoCode, quoteResult.distanceM, quoteResult.durationS, quoteResult.pickupEtaS,
        comment, JSON.stringify(optionCodes), forOther ? JSON.stringify(forOther) : null,
        paymentMethod === 'corporate' ? (user.corporate_id as string) : null, scheduledAt,
      );
      for (const p of points) {
        run(
          db,
          `INSERT INTO order_points (id, order_id, seq, kind, address, lat, lng, note, contact_name, contact_phone)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          id('opt'), orderId, p.seq, p.kind, p.address, p.lat, p.lng, p.note, p.contactName, p.contactPhone,
        );
      }
      if (delivery) {
        run(
          db,
          `INSERT INTO deliveries (order_id, sender_name, sender_phone, recipient_name, recipient_phone, weight_kg,
            declared_value_cents, description, instructions, pickup_code, dropoff_code)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          orderId, delivery.senderName, delivery.senderPhone, delivery.recipientName, delivery.recipientPhone,
          delivery.weightKg, delivery.declaredValueCents, delivery.description, delivery.instructions,
          String(Math.floor(1000 + Math.random() * 9000)), String(Math.floor(1000 + Math.random() * 9000)),
        );
      }
      db.prepare(`INSERT INTO order_events (order_id, type, actor_id, payload) VALUES (?,?,?,?)`)
        .run(orderId, 'order.created', user.id, JSON.stringify({ price: quoteResult.totalCents, serviceKind }));
      if (promoCode) {
        run(db, `INSERT INTO promo_redemptions (id, code, user_id, order_id, discount_cents) VALUES (?,?,?,?,?)`,
          id('prm'), promoCode, user.id, orderId, quoteResult.discountCents);
      }
    });

    audit(db, user, 'order.created', 'order', orderId, { price: quoteResult.totalCents, paymentMethod });
    notify(db, user.id, 'order_created', 'Замовлення створено', `№${number} · шукаємо водія`, { orderId });

    if (scheduledAt) {
      // scheduled orders stay parked until the dispatcher releases them
      run(db, `UPDATE orders SET status = 'searching' WHERE id = ?`, orderId);
    } else {
      tryDispatch(db, orderId);
    }
    return { order: getOrderFull(db, orderId), quote: quoteResult };
  });

  /* ----------------------------------------------------------------- read -- */
  app.get('/api/orders', async (req) => {
    const user = currentUser(db, req);
    const q = req.query as Record<string, string>;
    const limit = Math.min(Number(q.limit ?? 50), 100);
    const statuses = q.status ? q.status.split(',') : [];
    const where: string[] = [];
    const params: unknown[] = [];
    if (user.role === 'driver') { where.push('driver_id = ?'); params.push(user.id); }
    else if (user.role === 'passenger' || user.role === 'corporate_admin') { where.push('passenger_id = ?'); params.push(user.id); }
    else if (q.passengerId) { where.push('passenger_id = ?'); params.push(q.passengerId); }
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const rows = all(
      db,
      `SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
      ...params, limit,
    );
    return { items: rows.map((r) => project(db, r)) };
  });

  app.get('/api/orders/:id', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId } = req.params as { id: string };
    const order = getOrderFull(db, orderId);
    requireOwner(order, user.id, user.role);
    return { order };
  });

  app.get('/api/orders/:id/track', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId } = req.params as { id: string };
    const order = getOrderFull(db, orderId);
    requireOwner(order, user.id, user.role);
    const offers = all(db, `SELECT * FROM order_offers WHERE order_id = ? ORDER BY created_at DESC`, orderId);
    return {
      orderId: order.id,
      status: order.status,
      driver: order.driver ? {
        id: order.driver.id, name: order.driver.name, phone: order.driver.phone,
        rating: order.driver.rating, lat: order.driver.lat, lng: order.driver.lng,
        vehicle: order.vehicle ? { make: order.vehicle.make, model: order.vehicle.model, plate: order.vehicle.plate, color: order.vehicle.color } : null,
      } : null,
      offersSent: offers.length,
      lastOfferAt: offers[0]?.created_at ?? null,
    };
  });

  /* ------------------------------------------------------------ lifecycle -- */
  app.post('/api/orders/:id/cancel', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = body.reason ? str(body.reason, 'reason', { max: 200 }) : 'Скасовано клієнтом';
    const order = getOrderFull(db, orderId);
    requireOwner(order, user.id, user.role);
    if (['completed', 'canceled', 'expired'].includes(order.status)) throw conflict('Замовлення вже закрите');

    let cancelFee = 0;
    const tariff = one(db, `SELECT * FROM tariffs WHERE city_id = ? AND class_id = ? AND active = 1 ORDER BY version DESC LIMIT 1`,
      order.city_id, order.class_id);
    if (order.driver_id && ['assigned', 'driver_arriving'].includes(order.status)) {
      cancelFee = Number(tariff?.cancel_fee_cents ?? 0);
    }

    tx(db, () => {
      run(db, `UPDATE order_offers SET status = 'revoked', responded_at = ? WHERE order_id = ? AND status = 'offered'`, iso(), orderId);
      run(db, `UPDATE orders SET cancel_reason = ?, final_price_cents = ? WHERE id = ?`, reason, cancelFee, orderId);
      setStatus(db, orderId, 'canceled', user.id, { reason: 'force', event: 'order.canceled' });
      if (cancelFee > 0 && order.driver_id) {
        run(db, `INSERT INTO wallet_transactions (id, user_id, kind, amount_cents, order_id, idempotency_key, balance_after_cents, meta)
                 VALUES (?,?,?,?,?,?,?,?)`, id('txn'), order.driver_id, 'driver_earning', cancelFee, orderId,
          `cancel_fee_${orderId}`, cancelFee, JSON.stringify({ reason: 'cancel_fee' }));
        notify(db, order.driver_id, 'cancel_fee', 'Компенсація за скасування', `${(cancelFee / 100).toFixed(0)} ₴`, { orderId });
      }
      releaseDriver(db, order.driver_id);
    });

    audit(db, user, 'order.canceled', 'order', orderId, { reason, cancelFee });
    if (order.driver_id) notify(db, order.driver_id, 'order_canceled', 'Замовлення скасовано', `№${order.number}`, { orderId });
    return { ok: true, cancelFeeCents: cancelFee, order: getOrderFull(db, orderId) };
  });

  app.post('/api/orders/:id/rate', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rating = num(body.rating, 'rating', { min: 1, max: 5, int: true });
    const text = body.text ? str(body.text, 'text', { max: 500 }) : null;
    const order = one(db, `SELECT * FROM orders WHERE id = ?`, orderId);
    if (!order) throw notFound('Замовлення не знайдено');
    if (order.passenger_id !== user.id) throw forbidden('Оцінювати може лише пасажир цього замовлення');
    if (order.status !== 'completed') throw conflict('Оцінити можна лише завершене замовлення');
    if (!order.driver_id) throw conflict('Замовлення без водія');
    if (one(db, `SELECT id FROM reviews WHERE order_id = ?`, orderId)) throw conflict('Відгук для цього замовлення вже залишено');

    tx(db, () => {
      run(db, `INSERT INTO reviews (id, order_id, driver_id, passenger_id, rating, text, tags) VALUES (?,?,?,?,?,?,?)`,
        id('rev'), orderId, order.driver_id, user.id, rating, text, JSON.stringify(arr(body.tags)));
      run(db, `UPDATE orders SET rating = ?, review_text = ? WHERE id = ?`, rating, text, orderId);
      const agg = one<{ avg: number; n: number }>(
        db, `SELECT AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE driver_id = ?`, order.driver_id,
      )!;
      run(db, `UPDATE driver_profiles SET rating = ROUND(?, 2), rating_count = ? WHERE user_id = ?`,
        agg.avg ?? 5, agg.n, order.driver_id);
      notify(db, order.driver_id, 'review', 'Новий відгук', `${rating}★ ${text ?? ''}`.trim(), { orderId });
    });
    return { ok: true };
  });

  app.post('/api/orders/:id/repeat', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId } = req.params as { id: string };
    const src = getOrderFull(db, orderId);
    if (src.passenger_id !== user.id && !['admin', 'dispatcher'].includes(user.role)) throw forbidden();
    const q = quote(db, {
      cityId: src.city_id, classId: src.class_id,
      points: src.points.map((p) => ({ lat: p.lat, lng: p.lng })),
      serviceKind: src.service_kind, optionCodes: src.options,
      userId: user.id, corporateId: (user.corporate_id as string) ?? null,
    });
    return {
      prefill: {
        cityId: src.city_id, classId: src.class_id, serviceKind: src.service_kind,
        points: src.points.map((p) => ({ address: p.address, lat: p.lat, lng: p.lng })),
        options: src.options, paymentMethod: src.payment_method,
      },
      quote: q,
    };
  });

  app.post('/api/orders/:id/plus-minus', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const delta = num(body.deltaCents, 'deltaCents', { int: true });
    const order = getOrderFull(db, orderId);
    if (order.passenger_id !== user.id) throw forbidden();
    if (!['searching', 'offered', 'no_drivers'].includes(order.status)) {
      throw conflict('Коригувати ціну можна лише до призначення водія');
    }
    const q = quote(db, {
      cityId: order.city_id, classId: order.class_id,
      points: order.points.map((p) => ({ lat: p.lat, lng: p.lng })),
      serviceKind: order.service_kind, optionCodes: order.options,
      promoCode: order.promo_code, userId: user.id, plusMinusCents: delta,
    });
    tx(db, () => {
      run(db, `UPDATE orders SET plus_minus_cents = ?, quoted_price_cents = ?, discount_cents = ? WHERE id = ?`,
        delta, q.totalCents, q.discountCents, orderId);
      run(db, `UPDATE order_offers SET status = 'superseded', responded_at = ? WHERE order_id = ? AND status = 'offered'`, iso(), orderId);
      db.prepare(`INSERT INTO order_events (order_id, type, actor_id, payload) VALUES (?,?,?,?)`)
        .run(orderId, 'order.price_adjusted', user.id, JSON.stringify({ deltaCents: delta, total: q.totalCents }));
    });
    tryDispatch(db, orderId);
    return { ok: true, quote: q, order: getOrderFull(db, orderId) };
  });

  /* ------------------------------------------------------- route changes -- */
  app.post('/api/orders/:id/route-change', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const points = normalizePoints(body.points, settingValue(db, 'max_stops', 5));
    const order = getOrderFull(db, orderId);
    if (order.passenger_id !== user.id) throw forbidden();
    if (['completed', 'canceled', 'expired'].includes(order.status)) throw conflict('Замовлення закрито');

    const q = quote(db, {
      cityId: order.city_id, classId: order.class_id, points, serviceKind: order.service_kind,
      optionCodes: order.options, userId: user.id,
    });
    const delta = q.totalCents - Number(order.quoted_price_cents);
    const changeId = id('rch');

    if (!order.driver_id) {
      // nobody is executing it yet — apply immediately and re-dispatch
      tx(db, () => {
        run(db, `DELETE FROM order_points WHERE order_id = ?`, orderId);
        for (const p of points) {
          run(db, `INSERT INTO order_points (id, order_id, seq, kind, address, lat, lng, note, contact_name, contact_phone)
                   VALUES (?,?,?,?,?,?,?,?,?,?)`,
            id('opt'), orderId, p.seq, p.kind, p.address, p.lat, p.lng, p.note, p.contactName, p.contactPhone);
        }
        run(db, `UPDATE orders SET quoted_price_cents = ?, distance_m = ?, duration_s = ? WHERE id = ?`,
          q.totalCents, q.distanceM, q.durationS, orderId);
        db.prepare(`INSERT INTO order_events (order_id, type, actor_id, payload) VALUES (?,?,?,?)`)
          .run(orderId, 'order.route_changed', user.id, JSON.stringify({ priceDelta: delta }));
      });
      tryDispatch(db, orderId);
      return { status: 'applied', priceDeltaCents: delta, quote: q, order: getOrderFull(db, orderId) };
    }

    run(db, `INSERT INTO route_changes (id, order_id, requested_by, points_json, price_delta_cents) VALUES (?,?,?,?,?)`,
      changeId, orderId, 'passenger', JSON.stringify(points), delta);
    notify(db, order.driver_id, 'route_change', 'Пасажир змінює маршрут',
      delta >= 0 ? `Доплата ${(delta / 100).toFixed(0)} ₴` : `Знижка ${(-delta / 100).toFixed(0)} ₴`, { orderId, changeId });
    return { status: 'pending_driver_confirmation', changeId, priceDeltaCents: delta, quote: q };
  });

  app.post('/api/orders/:id/route-change/:changeId/decide', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId, changeId } = req.params as { id: string; changeId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const approve = body.approve === true;
    const change = one(db, `SELECT * FROM route_changes WHERE id = ? AND order_id = ?`, changeId, orderId);
    if (!change) throw notFound('Запит на зміну маршруту не знайдено');
    if (change.status !== 'pending') throw conflict('Запит уже оброблено');
    const order = getOrderFull(db, orderId);
    if (order.driver_id !== user.id && !['admin', 'dispatcher'].includes(user.role)) {
      throw forbidden('Підтвердити зміну може лише призначений водій або диспетчер');
    }
    if (!approve) {
      run(db, `UPDATE route_changes SET status = 'rejected', resolved_at = ? WHERE id = ?`, iso(), changeId);
      notify(db, order.passenger_id, 'route_change_rejected', 'Водій не підтвердив зміну маршруту', '', { orderId });
      return { status: 'rejected' };
    }
    const points = parseJson<Record<string, any>[]>(change.points_json, []);
    tx(db, () => {
      run(db, `DELETE FROM order_points WHERE order_id = ?`, orderId);
      points.forEach((p, i) => {
        run(db, `INSERT INTO order_points (id, order_id, seq, kind, address, lat, lng) VALUES (?,?,?,?,?,?,?)`,
          id('opt'), orderId, i, p.kind ?? (i === 0 ? 'pickup' : i === points.length - 1 ? 'dropoff' : 'stop'),
          p.address, p.lat, p.lng);
      });
      run(db, `UPDATE orders SET quoted_price_cents = quoted_price_cents + ? WHERE id = ?`, change.price_delta_cents, orderId);
      run(db, `UPDATE route_changes SET status = 'approved', resolved_at = ? WHERE id = ?`, iso(), changeId);
      db.prepare(`INSERT INTO order_events (order_id, type, actor_id, payload) VALUES (?,?,?,?)`)
        .run(orderId, 'order.route_change_approved', user.id, JSON.stringify({ priceDelta: change.price_delta_cents }));
    });
    notify(db, order.passenger_id, 'route_change_approved', 'Маршрут змінено', 'Водій підтвердив новий маршрут', { orderId });
    return { status: 'approved', order: getOrderFull(db, orderId) };
  });

  /* ------------------------------------------------------------ payments -- */
  app.post('/api/orders/:id/pay', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const order = one(db, `SELECT * FROM orders WHERE id = ?`, orderId);
    if (!order) throw notFound('Замовлення не знайдено');
    if (order.passenger_id !== user.id && !['admin', 'dispatcher'].includes(user.role)) throw forbidden();
    const method = oneOf(body.method, PAYMENT_LIST, 'method', order.payment_method) as PaymentMethod;
    const idempotencyKey = body.idempotencyKey
      ? str(body.idempotencyKey, 'idempotencyKey', { max: 80 })
      : `pay_${orderId}_${method}`;
    const intent = chargeOrder(db, orderId, method, idempotencyKey, user.id);
    return { ok: true, intent, order: getOrderFull(db, orderId) };
  });

  /* ------------------------------------------------------------ delivery -- */
  app.post('/api/orders/:id/delivery/pickup', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = str(body.code, 'code', { min: 4, max: 6 });
    const order = getOrderFull(db, orderId);
    if (!order.delivery)	throw unprocessable('Це замовлення не є доставкою');
    if (order.driver_id !== user.id && !['admin', 'dispatcher'].includes(user.role)) throw forbidden();
    if (order.delivery.pickup_code !== code) throw unprocessable('Невірний код відправника', { field: 'code' });
    tx(db, () => {
      run(db, `UPDATE deliveries SET picked_up_at = ? WHERE order_id = ?`, iso(), orderId);
      if (order.status === 'assigned' || order.status === 'driver_arriving' || order.status === 'waiting') {
        setStatus(db, orderId, 'in_progress', user.id, { event: 'delivery.picked_up' });
      }
      db.prepare(`INSERT INTO order_events (order_id, type, actor_id) VALUES (?,?,?)`).run(orderId, 'delivery.picked_up', user.id);
    });
    notify(db, order.passenger_id, 'delivery_pickup', 'Посилку забрано', `№${order.number}`, { orderId });
    return { ok: true, order: getOrderFull(db, orderId) };
  });

  app.post('/api/orders/:id/delivery/dropoff', async (req) => {
    const user = currentUser(db, req);
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = str(body.code, 'code', { min: 4, max: 6 });
    const photoUrl = body.photoUrl ? str(body.photoUrl, 'photoUrl', { max: 400 }) : null;
    const order = getOrderFull(db, orderId);
    if (!order.delivery) throw unprocessable('Це замовлення не є доставкою');
    if (order.driver_id !== user.id && !['admin', 'dispatcher'].includes(user.role)) throw forbidden();
    if (order.delivery.dropoff_code !== code) throw unprocessable('Невірний код отримувача', { field: 'code' });

    tx(db, () => {
      run(db, `UPDATE deliveries SET delivered_at = ?, photo_proof_url = ? WHERE order_id = ?`, iso(), photoUrl, orderId);
      setStatus(db, orderId, 'completed', user.id, { event: 'delivery.delivered' });
      run(db, `UPDATE orders SET final_price_cents = quoted_price_cents WHERE id = ? AND final_price_cents IS NULL`, orderId);
    });
    if (order.payment_status !== 'paid') {
      try {
        chargeOrder(db, orderId, order.payment_method as PaymentMethod, `pay_${orderId}_${order.payment_method}`, user.id);
      } catch {
        /* cash settlement handled at delivery hand-over */
      }
    }
    settleOrder(db, orderId);
    notify(db, order.passenger_id, 'delivery_done', 'Посилку доставлено', `№${order.number}`, { orderId });
    return { ok: true, order: getOrderFull(db, orderId) };
  });

  /* ------------------------------------------------- internal (dispatch) -- */
  app.post('/api/internal/orders/:id/assign', async (req) => {
    const user = currentUser(db, req);
    requireRole(user, 'admin', 'dispatcher');
    const { id: orderId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const driverId = str(body.driverId, 'driverId');
    const order = assignManually(db, orderId, driverId, user.id);
    audit(db, user, 'dispatch.manual_assign', 'order', orderId, { driverId });
    return { order };
  });
}
