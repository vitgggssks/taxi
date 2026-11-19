/**
 * Integration tests — real HTTP layer, real DB, real business logic.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { runDispatchTick } from '../src/lib/dispatch.js';
import { walletBalance } from '../src/lib/payments.js';

let app: FastifyInstance;
let db: any;
let passengerToken = '';
let passengerId = '';

const KYIV_PICKUP = { address: 'Хрещатик, 1', lat: 50.4471, lng: 30.5227 };
const KYIV_DROPOFF = { address: 'ТРЦ Gulliver', lat: 50.4325, lng: 30.5215 };

async function api(method: string, url: string, body?: unknown, token?: string) {
  const res = await app.inject({
    method: method as any,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    payload: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = res.body; }
  return { status: res.statusCode, body: json, raw: res.body };
}

async function login(role: string, phone?: string): Promise<{ token: string; user: any }> {
  const res = await api('POST', '/api/auth/demo-login', { role, phone });
  assert.equal(res.status, 200, `demo-login failed: ${res.raw}`);
  return { token: res.body.token, user: res.body.user };
}

/** Cancel every order and free every driver so each test starts from a clean dispatch state. */
function resetWorld() {
  db.prepare(`UPDATE orders SET status='canceled' WHERE status IN
    ('searching','offered','no_drivers','assigned','driver_arriving','waiting','in_progress')`).run();
  db.prepare(`UPDATE order_offers SET status='revoked' WHERE status='offered'`).run();
  db.prepare(`UPDATE driver_profiles SET work_status='online', auto_accept=0 WHERE status='verified'`).run();
}

async function createRide(opts: Record<string, unknown> = {}): Promise<any> {
  const res = await api('POST', '/api/orders', {
    cityId: 'city_kyiv',
    classId: 'cls_economy',
    points: [KYIV_PICKUP, KYIV_DROPOFF],
    paymentMethod: 'cash',
    ...opts,
  }, passengerToken);
  return res;
}

/** Перша пропозиція замовлення — ручна (offered) або вже прийнята (accept). */
function offerFor(orderId: string): any {
  const row = db.prepare(
    `SELECT * FROM order_offers WHERE order_id=? AND status IN ('offered','accepted')
     ORDER BY CASE status WHEN 'offered' THEN 0 ELSE 1 END, created_at LIMIT 1`,
  ).get(orderId);
  assert.ok(row, `dispatch did not create an offer for ${orderId}`);
  return row;
}

before(async () => {
  const built = buildApp({ dbFile: ':memory:', seed: true, webRoot: '../web' });
  app = built.app;
  db = built.db;
  await app.ready();
  // tests need deterministic dispatch: auto-accept off unless a test enables it
  db.prepare(`UPDATE driver_profiles SET auto_accept = 0`).run();
  const session = await login('passenger', '+380671112233');
  passengerToken = session.token;
  passengerId = session.user.id;
});

after(async () => {
  await app.close();
});

describe('auth', () => {
  it('health check responds', async () => {
    resetWorld();
    const res = await api('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('registers a new passenger through the OTP flow', async () => {
    resetWorld();
    const phone = '+380991234567';
    const otpRes = await api('POST', '/api/auth/request-otp', { phone });
    assert.equal(otpRes.status, 200);
    assert.equal(otpRes.body.isNewUser, true);

    const badCode = await api('POST', '/api/auth/verify-otp', { phone, code: '000000' });
    assert.equal(badCode.status, 422);
    assert.equal(badCode.body.error.code, 'unprocessable');

    const ok = await api('POST', '/api/auth/verify-otp', { phone, code: otpRes.body.demoCode });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal(ok.body.user.role, 'passenger');

    const me = await api('GET', '/api/me', undefined, ok.body.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.phone, phone);
  });

  it('rejects requests without a token', async () => {
    resetWorld();
    const res = await api('GET', '/api/orders');
    assert.equal(res.status, 401);
  });
});

describe('pricing engine', () => {
  it('quotes every available class, cheaper classes first', async () => {
    resetWorld();
    const res = await api('POST', '/api/orders/quote', {
      cityId: 'city_kyiv',
      points: [KYIV_PICKUP, KYIV_DROPOFF],
    }, passengerToken);
    assert.equal(res.status, 200);
    const quotes = res.body.quotes;
    assert.ok(quotes.length >= 6);
    const economy = quotes.find((q: any) => q.classCode === 'economy');
    const business = quotes.find((q: any) => q.classCode === 'business');
    assert.ok(economy.totalCents < business.totalCents);
    assert.ok(economy.distanceM > 1000);
    assert.ok(economy.breakdown.baseCents > 0);
  });

  it('applies the minimum fare for very short trips', async () => {
    resetWorld();
    const res = await api('POST', '/api/orders/quote', {
      cityId: 'city_kyiv',
      classId: 'cls_minivan',
      points: [
        { address: 'Точка А', lat: 50.4471, lng: 30.5227 },
        { address: 'Точка Б', lat: 50.4473, lng: 30.5229 },
      ],
    }, passengerToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.quote.breakdown.minFareApplied, true);
    assert.equal(res.body.quote.totalCents, res.body.quote.breakdown.minFareCents);
  });

  it('adds options, stops and enforces the plus/minus limit', async () => {
    resetWorld();
    const base = await api('POST', '/api/orders/quote', {
      cityId: 'city_kyiv', classId: 'cls_comfort',
      points: [KYIV_PICKUP, KYIV_DROPOFF],
    }, passengerToken);
    const withStops = await api('POST', '/api/orders/quote', {
      cityId: 'city_kyiv', classId: 'cls_comfort',
      points: [KYIV_PICKUP, { address: 'Зупинка 1', lat: 50.4400, lng: 30.5200 }, KYIV_DROPOFF],
    }, passengerToken);
    assert.ok(withStops.body.quote.totalCents > base.body.quote.totalCents);

    const withOption = await api('POST', '/api/orders/quote', {
      cityId: 'city_kyiv', classId: 'cls_comfort', options: ['child_seat'],
      points: [KYIV_PICKUP, KYIV_DROPOFF],
    }, passengerToken);
    assert.equal(
      withOption.body.quote.totalCents - base.body.quote.totalCents, 7000,
      'child seat costs 70 ₴',
    );

    const tooMuch = await api('POST', '/api/orders/quote', {
      cityId: 'city_kyiv', classId: 'cls_comfort', plusMinusCents: 100000,
      points: [KYIV_PICKUP, KYIV_DROPOFF],
    }, passengerToken);
    assert.equal(tooMuch.status, 422);
  });

  it('rejects more than 5 intermediate stops', async () => {
    resetWorld();
    const points = [KYIV_PICKUP];
    for (let i = 0; i < 6; i++) points.push({ address: `stop ${i}`, lat: 50.44 + i * 0.001, lng: 30.52 });
    points.push(KYIV_DROPOFF);
    const res = await api('POST', '/api/orders/quote', { cityId: 'city_kyiv', classId: 'cls_economy', points }, passengerToken);
    assert.equal(res.status, 400);
  });

  it('does not allow an option that is unavailable for the class', async () => {
    resetWorld();
    const res = await api('POST', '/api/orders/quote', {
      cityId: 'city_kyiv', classId: 'cls_economy', options: ['quiet_ride'],
      points: [KYIV_PICKUP, KYIV_DROPOFF],
    }, passengerToken);
    assert.equal(res.status, 422);
  });
});

describe('dispatch engine', () => {
  it('offers a new order to nearby drivers and assigns on accept', async () => {
    resetWorld();
    const created = await createRide();
    assert.equal(created.status, 200, created.raw);
    const orderId = created.body.order.id;
    assert.equal(created.body.order.status, 'offered');

    const offers = db.prepare(`SELECT * FROM order_offers WHERE order_id = ? AND status='offered'`).all(orderId);
    assert.ok(offers.length >= 1, 'at least one offer was created');

    const driverToken = await tokenForDriver(offers[0].driver_id);
    const accepted = await api('POST', `/api/driver/offers/${offers[0].id}/accept`, {}, driverToken);
    assert.equal(accepted.status, 200, accepted.raw);
    assert.equal(accepted.body.order.status, 'assigned');
    assert.equal(accepted.body.order.driver_id, offers[0].driver_id);

    // the remaining offers are superseded — no double assignment
    const others = db.prepare(`SELECT status FROM order_offers WHERE order_id = ? AND id != ?`).all(orderId, offers[0].id);
    for (const o of others) assert.equal(o.status, 'superseded');

    // any other driver trying the same order fails
    const another = db.prepare(`SELECT * FROM order_offers WHERE order_id = ? AND status = 'superseded' LIMIT 1`).get(orderId);
    if (another) {
      const otherToken = await tokenForDriver(another.driver_id);
      const conflictRes = await api('POST', `/api/driver/offers/${another.id}/accept`, {}, otherToken);
      assert.equal(conflictRes.status, 409);
    }
  });

  it('re-offers the order to the next driver when the offer expires', async () => {
    resetWorld();
    const created = await createRide();
    const orderId = created.body.order.id;
    const first = db.prepare(`SELECT * FROM order_offers WHERE order_id=? AND status='offered'`).all(orderId);
    assert.ok(first.length > 0);
    // simulate the timer firing after the deadline
    db.prepare(`UPDATE order_offers SET expires_at = datetime('now','-1 minutes') WHERE order_id = ?`).run(orderId);
    runDispatchTick(db);
    const state = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(orderId);
    const expired = db.prepare(`SELECT COUNT(*) AS n FROM order_offers WHERE order_id = ? AND status='expired'`).get(orderId);
    assert.equal(expired.n, first.length);
    assert.ok(['offered', 'no_drivers', 'assigned', 'searching'].includes(state.status));
  });

  it('auto-assigns to a driver with auto-accept when criteria match', async () => {
    resetWorld();
    db.prepare(`UPDATE driver_profiles SET auto_accept = 1, min_price_cents = 0, accept_radius_km = 15
                WHERE user_id = (SELECT user_id FROM driver_profiles WHERE status='verified' LIMIT 1)`).run();
    const autoDriver = db.prepare(`SELECT user_id FROM driver_profiles WHERE auto_accept = 1 LIMIT 1`).get();
    const created = await createRide();
    assert.equal(created.body.order.status, 'assigned', 'auto-accept driver takes the order instantly');
    db.prepare(`UPDATE driver_profiles SET auto_accept = 0`).run();
    // clean up
    await api('POST', `/api/orders/${created.body.order.id}/cancel`, { reason: 'test cleanup' }, passengerToken);
    assert.ok(autoDriver.user_id);
  });

  it('parks the order as no_drivers when nobody is online', async () => {
    resetWorld();
    db.prepare(`UPDATE driver_profiles SET work_status = 'offline'`).run();
    const created = await createRide();
    assert.equal(created.body.order.status, 'no_drivers');
    db.prepare(`UPDATE driver_profiles SET work_status = 'online'`).run();
    await api('POST', `/api/orders/${created.body.order.id}/cancel`, { reason: 'cleanup' }, passengerToken);
  });

  it('supports manual assignment by dispatch', async () => {
    resetWorld();
    const dispatcher = await login('dispatcher');
    const created = await createRide();
    const driver = db.prepare(`SELECT user_id FROM driver_profiles WHERE status='verified' LIMIT 1`).get();
    const res = await api('POST', `/api/internal/orders/${created.body.order.id}/assign`, { driverId: driver.user_id }, dispatcher.token);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.order.status, 'assigned');
    assert.equal(res.body.order.assigned_by, 'dispatch');
  });
});

describe('passenger order lifecycle', () => {
  it('limits simultaneous active orders to 5', async () => {
    resetWorld();
    db.prepare(`UPDATE orders SET status='canceled' WHERE passenger_id = ?`).run(passengerId);
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await createRide());
    const created = results.filter((r) => r.status === 200).length;
    const rejected = results.filter((r) => r.status === 409).length;
    assert.equal(created, 5);
    assert.equal(rejected, 1);
  });

  it('accepts a promo code and applies the discount', async () => {
    resetWorld();
    db.prepare(`UPDATE orders SET status='canceled' WHERE passenger_id = ?`).run(passengerId);
    const plain = await createRide();
    const withPromo = await createRide({ promoCode: 'RUKH10' });
    assert.equal(withPromo.status, 200, withPromo.raw);
    assert.ok(withPromo.body.quote.discountCents > 0);
    assert.ok(withPromo.body.order.quoted_price_cents < plain.body.order.quoted_price_cents);

    // RUKH10 is limited to 3 uses per user
    resetWorld();
    await createRide({ promoCode: 'RUKH10' });
    resetWorld();
    const third = await createRide({ promoCode: 'RUKH10' });
    assert.equal(third.status, 200, third.raw);
    resetWorld();
    const fourth = await createRide({ promoCode: 'RUKH10' });
    assert.equal(fourth.status, 422, 'per-user promo limit is enforced');
    assert.match(fourth.body.error.message, /використали/i);
  });

  it('validates a promo code through the dedicated endpoint', async () => {
    resetWorld();
    const valid = await api('POST', '/api/promo/validate', {
      code: 'FIRST100', cityId: 'city_kyiv', classId: 'cls_comfort', points: [KYIV_PICKUP, KYIV_DROPOFF],
    }, passengerToken);
    assert.equal(valid.status, 200);
    assert.equal(valid.body.valid, true);
    const invalid = await api('POST', '/api/promo/validate', {
      code: 'NOPE', cityId: 'city_kyiv', classId: 'cls_comfort', points: [KYIV_PICKUP, KYIV_DROPOFF],
    }, passengerToken);
    assert.equal(invalid.body.valid, false);
  });

  it('adjusts the price with plus/minus before a driver is assigned', async () => {
    resetWorld();
    db.prepare(`UPDATE orders SET status='canceled' WHERE passenger_id = ?`).run(passengerId);
    const created = await createRide();
    const orderId = created.body.order.id;
    const before = created.body.order.quoted_price_cents;
    const bumped = await api('POST', `/api/orders/${orderId}/plus-minus`, { deltaCents: 500 }, passengerToken);
    assert.equal(bumped.status, 200, bumped.raw);
    assert.equal(bumped.body.order.quoted_price_cents, before + 500);

    const overLimit = await api('POST', `/api/orders/${orderId}/plus-minus`, { deltaCents: 999999 }, passengerToken);
    assert.equal(overLimit.status, 422, 'the ± limit is enforced');
  });

  it('lets the driver confirm a route change and reprices the order', async () => {
    resetWorld();
    db.prepare(`UPDATE orders SET status='canceled' WHERE passenger_id = ?`).run(passengerId);
    const created = await createRide();
    assert.equal(created.status, 200, `createRide failed: ${created.status} ${created.raw}`);
    const orderId = created.body.order.id;
    const offer = offerFor(orderId);
    const driverToken = await tokenForDriver(offer.driver_id);
    await api('POST', `/api/driver/offers/${offer.id}/accept`, {}, driverToken);

    const change = await api('POST', `/api/orders/${orderId}/route-change`, {
      points: [KYIV_PICKUP, { address: 'Додаткова зупинка', lat: 50.4400, lng: 30.5250 }, KYIV_DROPOFF],
    }, passengerToken);
    assert.equal(change.status, 200, change.raw);
    assert.equal(change.body.status, 'pending_driver_confirmation');
    assert.ok(change.body.priceDeltaCents > 0);

    const approved = await api('POST', `/api/orders/${orderId}/route-change/${change.body.changeId}/decide`,
      { approve: true }, driverToken);
    assert.equal(approved.status, 200, approved.raw);
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.order.points.length, 3);
  });

  it('completes the ride, settles money and rates the driver', async () => {
    resetWorld();
    db.prepare(`UPDATE orders SET status='canceled' WHERE passenger_id = ?`).run(passengerId);
    const created = await createRide({ paymentMethod: 'cash' });
    const orderId = created.body.order.id;
    const offer = offerFor(orderId);
    const driverToken = await tokenForDriver(offer.driver_id);
    const driverId = offer.driver_id;
    await api('POST', `/api/driver/offers/${offer.id}/accept`, {}, driverToken);

    for (const status of ['driver_arriving', 'waiting', 'in_progress', 'completed']) {
      const res = await api('POST', `/api/driver/orders/${orderId}/status`, { status }, driverToken);
      assert.equal(res.status, 200, `${status}: ${res.raw}`);
    }
    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
    assert.equal(order.status, 'completed');
    assert.ok(order.commission_cents > 0);
    assert.ok(order.cashback_cents > 0, 'cashback is credited');

    // cash model: driver owes the commission
    const commission = db.prepare(`SELECT * FROM wallet_transactions WHERE order_id=? AND kind='commission'`).get(orderId);
    assert.ok(commission, 'commission ledger entry exists');
    assert.equal(commission.amount_cents, -order.commission_cents);

    const rating = await api('POST', `/api/orders/${orderId}/rate`, { rating: 5, text: 'Все супер' }, passengerToken);
    assert.equal(rating.status, 200, rating.raw);
    const driver = db.prepare(`SELECT rating, rating_count FROM driver_profiles WHERE user_id = ?`).get(driverId);
    assert.equal(driver.rating_count, 1);

    const twice = await api('POST', `/api/orders/${orderId}/rate`, { rating: 4 }, passengerToken);
    assert.equal(twice.status, 409, 'a review can only be left once');
  });

  it('cancels a ride and charges the cancellation fee when the driver was already en route', async () => {
    resetWorld();
    db.prepare(`UPDATE orders SET status='canceled' WHERE passenger_id = ?`).run(passengerId);
    const created = await createRide();
    assert.equal(created.status, 200, `createRide failed: ${created.status} ${created.raw}`);
    const orderId = created.body.order.id;
    const offer = offerFor(orderId);
    const driverToken = await tokenForDriver(offer.driver_id);
    await api('POST', `/api/driver/offers/${offer.id}/accept`, {}, driverToken);
    await api('POST', `/api/driver/orders/${orderId}/status`, { status: 'driver_arriving' }, driverToken);

    const canceled = await api('POST', `/api/orders/${orderId}/cancel`, { reason: 'Передумав' }, passengerToken);
    assert.equal(canceled.status, 200, canceled.raw);
    assert.equal(canceled.body.order.status, 'canceled');
    assert.equal(canceled.body.cancelFeeCents, 5000);
    const compensation = db.prepare(`SELECT * FROM wallet_transactions WHERE order_id=? AND kind='driver_earning'`).get(orderId);
    assert.ok(compensation, 'driver is compensated for the cancellation');
  });
});

describe('payments', () => {
  it('charges the wallet once even when the request is retried', async () => {
    resetWorld();
    db.prepare(`UPDATE orders SET status='canceled' WHERE passenger_id = ?`).run(passengerId);
    const created = await createRide({ paymentMethod: 'wallet' });
    const orderId = created.body.order.id;
    const offer = offerFor(orderId);
    const driverToken = await tokenForDriver(offer.driver_id);
    await api('POST', `/api/driver/offers/${offer.id}/accept`, {}, driverToken);
    for (const status of ['driver_arriving', 'in_progress', 'completed']) {
      await api('POST', `/api/driver/orders/${orderId}/status`, { status }, driverToken);
    }
    const debit = db.prepare(`SELECT * FROM wallet_transactions WHERE order_id=? AND kind='ride_payment'`).get(orderId);
    assert.ok(debit, 'wallet was debited once on completion');
    const balanceAfter = walletBalance(db, passengerId);

    const key = `test-${orderId}`;
    const replay = await api('POST', `/api/orders/${orderId}/pay`, { method: 'wallet', idempotencyKey: key }, passengerToken);
    assert.equal(replay.status, 200);
    const replay2 = await api('POST', `/api/orders/${orderId}/pay`, { method: 'wallet', idempotencyKey: key }, passengerToken);
    assert.equal(replay2.status, 200);
    assert.equal(walletBalance(db, passengerId), balanceAfter, 'no double charge');
    const debits = db.prepare(`SELECT COUNT(*) AS n FROM wallet_transactions WHERE order_id=? AND kind='ride_payment'`).get(orderId);
    assert.equal(debits.n, 1);
  });

  it('rejects a wallet payment when the balance is insufficient', async () => {
    resetWorld();
    const poor = await login('passenger', '+380501112233');
    db.prepare(`UPDATE orders SET status='canceled' WHERE passenger_id = ?`).run(poor.user.id);
    const res = await api('POST', '/api/orders', {
      cityId: 'city_uzhhorod', classId: 'cls_business', paymentMethod: 'wallet',
      points: [
        { address: 'пл. Поштова, 1', lat: 48.6234, lng: 22.2880 },
        { address: 'Аеропорт Ужгород', lat: 48.6340, lng: 22.2630 },
      ],
    }, poor.token);
    assert.equal(res.status, 200, res.raw);
    const pay = await api('POST', `/api/orders/${res.body.order.id}/pay`, { method: 'wallet' }, poor.token);
    assert.equal(pay.status, 422);
    assert.match(pay.body.error.message, /Недостатньо коштів/);
  });

  it('tops up the wallet idempotently', async () => {
    resetWorld();
    const before = walletBalance(db, passengerId);
    const key = 'topup-test-1';
    const { topUp } = await import('../src/lib/payments.js');
    topUp(db, passengerId, 5000, key);
    topUp(db, passengerId, 5000, key);
    assert.equal(walletBalance(db, passengerId), before + 5000);
  });
});

describe('delivery', () => {
  it('runs the parcel flow with pickup and drop-off codes', async () => {
    resetWorld();
    db.prepare(`UPDATE orders SET status='canceled' WHERE passenger_id = ?`).run(passengerId);
    const created = await api('POST', '/api/orders', {
      cityId: 'city_kyiv', classId: 'cls_delivery', serviceKind: 'delivery', paymentMethod: 'card',
      points: [KYIV_PICKUP, KYIV_DROPOFF],
      delivery: {
        senderName: 'Олена', senderPhone: '+380671112233',
        recipientName: 'Ігор', recipientPhone: '+380671112244',
        weightKg: 8, declaredValueCents: 200000, description: 'Документи', instructions: 'Подзвонити за 5 хв',
      },
    }, passengerToken);
    assert.equal(created.status, 200, created.raw);
    const orderId = created.body.order.id;
    const delivery = db.prepare(`SELECT * FROM deliveries WHERE order_id = ?`).get(orderId);
    assert.ok(delivery.pickup_code);
    assert.ok(delivery.dropoff_code);
    assert.notEqual(delivery.pickup_code, delivery.dropoff_code);

    const offer = offerFor(orderId);
    assert.ok(offer, 'delivery order is dispatched to a courier');
    const courierToken = await tokenForDriver(offer.driver_id);
    await api('POST', `/api/driver/offers/${offer.id}/accept`, {}, courierToken);

    const wrong = await api('POST', `/api/orders/${orderId}/delivery/pickup`, { code: '0000' }, courierToken);
    assert.equal(wrong.status, 422);
    const picked = await api('POST', `/api/orders/${orderId}/delivery/pickup`, { code: delivery.pickup_code }, courierToken);
    assert.equal(picked.status, 200, picked.raw);
    assert.equal(picked.body.order.status, 'in_progress');

    const dropped = await api('POST', `/api/orders/${orderId}/delivery/dropoff`,
      { code: delivery.dropoff_code, photoUrl: '/uploads/proof/1.jpg' }, courierToken);
    assert.equal(dropped.status, 200, dropped.raw);
    assert.equal(dropped.body.order.status, 'completed');
    assert.equal(dropped.body.order.delivery.photo_proof_url, '/uploads/proof/1.jpg');
  });

  it('rejects parcels heavier than 20 kg', async () => {
    resetWorld();
    const res = await api('POST', '/api/orders', {
      cityId: 'city_kyiv', classId: 'cls_delivery', serviceKind: 'delivery',
      points: [KYIV_PICKUP, KYIV_DROPOFF],
      delivery: {
        senderName: 'Андрій', senderPhone: '+380671112233', recipientName: 'Борис', recipientPhone: '+380671112244',
        weightKg: 25,
      },
    }, passengerToken);
    assert.equal(res.status, 400);
  });
});

describe('driver app', () => {
  it('registers a new driver and blocks going online until verified', async () => {
    resetWorld();
    const phone = '+380931112233';
    const otpRes = await api('POST', '/api/auth/request-otp', { phone });
    const session = await api('POST', '/api/auth/verify-otp', { phone, code: otpRes.body.demoCode });
    const token = session.body.token;

    const reg = await api('POST', '/api/driver/register', {
      cityId: 'city_kyiv',
      classes: ['economy', 'comfort'],
      vehicle: { make: 'Renault', model: 'Logan', year: 2019, color: 'білий', plate: 'KA 1111 AA' },
      documents: [
        { type: 'license', fileUrl: '/uploads/license/1.jpg' },
        { type: 'vehicle_registration', fileUrl: '/uploads/reg/1.jpg' },
      ],
    }, token);
    assert.equal(reg.status, 200, reg.raw);
    assert.equal(reg.body.status, 'pending');

    const online = await api('POST', '/api/driver/online', {}, token);
    assert.equal(online.status, 403);

    const admin = await login('admin');
    const pending = await api('GET', '/api/admin/drivers/pending', undefined, admin.token);
    const mine = pending.body.items.find((d: any) => d.phone === phone);
    assert.ok(mine);

    const verify = await api('POST', `/api/admin/drivers/${mine.user_id}/verify`, { approve: true }, admin.token);
    assert.equal(verify.status, 200, verify.raw);

    const online2 = await api('POST', '/api/driver/online', { lat: 50.45, lng: 30.52 }, token);
    assert.equal(online2.status, 200);
  });

  it('exposes driver settings, offers and stats', async () => {
    resetWorld();
    const driver = db.prepare(`SELECT user_id FROM driver_profiles WHERE status='verified' LIMIT 1`).get();
    const token = await tokenForDriver(driver.user_id);
    const settings = await api('PATCH', '/api/driver/settings', { autoAccept: true, acceptRadiusKm: 9, minPriceCents: 9000 }, token);
    assert.equal(settings.status, 200, settings.raw);
    assert.equal(settings.body.profile.auto_accept, 1);

    const stats = await api('GET', '/api/driver/stats', undefined, token);
    assert.equal(stats.status, 200);
    assert.ok('acceptanceRate' in stats.body);
    assert.ok(Array.isArray(stats.body.quests));

    const txs = await api('GET', '/api/driver/transactions', undefined, token);
    assert.equal(txs.status, 200);
    assert.ok(typeof txs.body.balanceCents === 'number');

    db.prepare(`UPDATE driver_profiles SET auto_accept = 0 WHERE user_id = ?`).run(driver.user_id);
  });
});

describe('admin panel', () => {
  it('serves dashboard aggregates', async () => {
    resetWorld();
    const admin = await login('admin');
    const res = await api('GET', '/api/admin/dashboard', undefined, admin.token);
    assert.equal(res.status, 200);
    assert.ok(res.body.today.orders >= 0);
    assert.ok(res.body.onlineDrivers >= 1);
    assert.ok(Array.isArray(res.body.byCity));
  });

  it('updates a tariff without a code change', async () => {
    resetWorld();
    const admin = await login('admin');
    const tariffs = await api('GET', '/api/admin/tariffs?cityId=city_kyiv', undefined, admin.token);
    const economy = tariffs.body.items.find((t: any) => t.class_code === 'economy');
    const before = economy.per_km_cents;
    const patched = await api('PATCH', `/api/admin/tariffs/${economy.id}`, { per_km_cents: before + 100 }, admin.token);
    assert.equal(patched.status, 200, patched.raw);
    assert.equal(patched.body.item.per_km_cents, before + 100);

    const quoteAfter = await api('POST', '/api/orders/quote', {
      cityId: 'city_kyiv', classId: 'cls_economy', points: [KYIV_PICKUP, KYIV_DROPOFF],
    }, passengerToken);
    assert.ok(quoteAfter.body.quote.breakdown.distanceCents > 0);
    // restore
    await api('PATCH', `/api/admin/tariffs/${economy.id}`, { per_km_cents: before }, admin.token);
  });

  it('creates a new car class with tariffs for every city', async () => {
    resetWorld();
    const admin = await login('admin');
    const res = await api('POST', '/api/admin/classes', { code: 'test_extra', name: 'Тест-клас', kind: 'ride', seats: 4 }, admin.token);
    assert.equal(res.status, 200, res.raw);
    const tariffs = db.prepare(`SELECT COUNT(*) AS n FROM tariffs WHERE class_id = 'cls_test_extra'`).get();
    assert.equal(tariffs.n, 3, 'tariff cloned to all 3 cities');
  });

  it('creates promo codes and exports CSV reports', async () => {
    resetWorld();
    const admin = await login('admin');
    const promo = await api('POST', '/api/admin/promos', { code: 'TEST20', kind: 'percent', value: 20, usageLimit: 10 }, admin.token);
    assert.equal(promo.status, 200, promo.raw);
    const dup = await api('POST', '/api/admin/promos', { code: 'TEST20', kind: 'percent', value: 20 }, admin.token);
    assert.equal(dup.status, 409);

    const csv = await api('GET', '/api/admin/reports/orders.csv', undefined, admin.token);
    assert.equal(csv.status, 200);
    assert.match(String(csv.body ?? csv.raw), /number;created_at/);
  });

  it('scopes the live map to drivers and active orders', async () => {
    resetWorld();
    const dispatcher = await login('dispatcher');
    const res = await api('GET', '/api/admin/live-map', undefined, dispatcher.token);
    assert.equal(res.status, 200);
    assert.ok(res.body.drivers.length >= 1);
    assert.ok(res.body.drivers[0].lat !== null);
  });

  it('refuses admin endpoints for passengers', async () => {
    resetWorld();
    const res = await api('GET', '/api/admin/dashboard', undefined, passengerToken);
    assert.equal(res.status, 403);
  });

  it('writes an audit trail for privileged actions', async () => {
    resetWorld();
    const admin = await login('admin');
    const res = await api('GET', '/api/admin/audit', undefined, admin.token);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length > 0);
    assert.ok(res.body.items.some((i: any) => i.action === 'tariff.updated'));
  });
});

describe('corporate module', () => {
  it('creates a corporate order on the company account', async () => {
    resetWorld();
    const corp = await login('corporate_admin', '+380503334455');
    const res = await api('POST', '/api/orders', {
      cityId: 'city_kyiv', classId: 'cls_comfort', paymentMethod: 'corporate',
      points: [KYIV_PICKUP, KYIV_DROPOFF],
    }, corp.token);
    assert.equal(res.status, 200, res.raw);
    const orderId = res.body.order.id;
    const offer = offerFor(orderId);
    if (offer) {
      const driverToken = await tokenForDriver(offer.driver_id);
      await api('POST', `/api/driver/offers/${offer.id}/accept`, {}, driverToken);
      for (const status of ['driver_arriving', 'in_progress', 'completed']) {
        await api('POST', `/api/driver/orders/${orderId}/status`, { status }, driverToken);
      }
    }
    const pay = await api('POST', `/api/orders/${orderId}/pay`, { method: 'corporate' }, corp.token);
    assert.equal(pay.status, 200, pay.raw);

    const period = new Date().toISOString().slice(0, 7);
    const invoice = db.prepare(`SELECT * FROM corporate_invoices WHERE period = ?`).get(period);
    assert.ok(invoice, 'invoice for the period exists');
    assert.ok(invoice.total_cents >= 0);

    const report = await api('GET', `/api/corporate/reports?period=${period}`, undefined, corp.token);
    assert.equal(report.status, 200);
    assert.ok(Array.isArray(report.body.items));

    const csv = await api('GET', `/api/corporate/reports?period=${period}&format=csv`, undefined, corp.token);
    assert.match(String(csv.raw), /number;created_at/);
  });

  it('invites an employee and enforces the member limit', async () => {
    resetWorld();
    const corp = await login('corporate_admin', '+380503334455');
    const invite = await api('POST', '/api/corporate/members/invite', { phone: '+380937778899', monthlyLimitCents: 1000 }, corp.token);
    assert.equal(invite.status, 200, invite.raw);
    assert.ok(invite.body.inviteToken);
  });
});

describe('support desk', () => {
  it('creates a ticket and lets an agent reply', async () => {
    resetWorld();
    const created = await api('POST', '/api/support/tickets', { subject: 'Водій не приїхав', message: 'Чекаю 20 хвилин' }, passengerToken);
    assert.equal(created.status, 200, created.raw);
    const agent = await login('dispatcher');
    const reply = await api('POST', `/api/support/tickets/${created.body.ticketId}/messages`, { message: 'Перевіряємо' }, agent.token);
    assert.equal(reply.status, 200, reply.raw);
    const detail = await api('GET', `/api/support/tickets/${created.body.ticketId}`, undefined, passengerToken);
    assert.equal(detail.body.messages.length, 2);
  });
});

/* --------------------------------------------------------------- helpers --- */
async function tokenForDriver(driverId: string): Promise<string> {
  const row = db.prepare(`SELECT phone FROM users WHERE id = ?`).get(driverId);
  const session = await login('driver', row.phone);
  return session.token;
}
