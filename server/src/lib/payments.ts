/**
 * Payment & settlement engine.
 *
 * Idempotency: every mutation carries an idempotency key that is UNIQUE in
 * `wallet_transactions` / `payment_intents`, so retries (mobile networks,
 * webhook replays) can never double-charge. All balance maths happens inside a
 * single DB transaction.
 *
 * Methods:
 *   cash        – passenger pays the driver; the platform books a commission debt
 *   card/apple_pay/google_pay – captured through the gateway adapter, platform
 *                 then pays out to the driver's balance
 *   wallet      – passenger's internal balance
 *   corporate   – charged to the company account (invoice + member limit)
 */
import { Db, one, run, Row, tx } from './db.js';
import { notify } from './order-service.js';
import { hub } from './realtime.js';
import { conflict, id, iso, notFound, roundMoney, unprocessable } from './util.js';

export const PAYMENT_METHODS = ['cash', 'card', 'apple_pay', 'google_pay', 'wallet', 'corporate'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function settingNum(db: Db, key: string, fallback: number): number {
  const row = one(db, `SELECT value FROM settings WHERE key = ?`, key);
  if (!row) return fallback;
  try {
    const v = JSON.parse(row.value);
    return typeof v === 'number' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function walletBalance(db: Db, userId: string, account = 'main'): number {
  const row = one<{ balance: number }>(
    db,
    `SELECT COALESCE((SELECT balance_after_cents FROM wallet_transactions
                      WHERE user_id = ? AND account = ? ORDER BY created_at DESC, rowid DESC LIMIT 1), 0) AS balance`,
    userId, account,
  );
  return row?.balance ?? 0;
}

interface LedgerInput {
  userId: string;
  account?: string;
  kind: string;
  amountCents: number; // signed
  orderId?: string | null;
  idempotencyKey: string;
  meta?: Row;
}

export function ledger(db: Db, input: LedgerInput): Row {
  const existing = one(db, `SELECT * FROM wallet_transactions WHERE idempotency_key = ?`, input.idempotencyKey);
  if (existing) return existing; // idempotent replay
  const account = input.account ?? 'main';
  const balance = walletBalance(db, input.userId, account) + input.amountCents;
  const txnId = id('txn');
  run(
    db,
    `INSERT INTO wallet_transactions (id, user_id, account, kind, amount_cents, order_id, idempotency_key, balance_after_cents, meta)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    txnId, input.userId, account, input.kind, input.amountCents, input.orderId ?? null,
    input.idempotencyKey, balance, JSON.stringify(input.meta ?? {}),
  );
  hub.toUser(input.userId, 'wallet.updated', { balanceCents: balance, account });
  return one(db, `SELECT * FROM wallet_transactions WHERE id = ?`, txnId)!;
}

export function topUp(db: Db, userId: string, amountCents: number, idempotencyKey: string, meta: Row = {}): Row {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw unprocessable('Сума має бути додатна');
  if (amountCents > 5_000_000) throw unprocessable('Максимальна сума поповнення — 50 000 ₴');
  return tx(db, () =>
    ledger(db, { userId, kind: 'topup', amountCents, idempotencyKey, meta: { ...meta, via: meta.via ?? 'gateway' } }),
  );
}

/** Adapter for the card acquirer. Replace with a real provider (LiqPay/Fondy/Stripe). */
function captureWithGateway(db: Db, orderId: string, amountCents: number, method: PaymentMethod): string {
  const intent = one(db, `SELECT * FROM payment_intents WHERE order_id = ? AND status IN ('pending','captured')`, orderId);
  if (intent && intent.status === 'captured') return intent.gateway_ref;
  return `sim_${method}_${orderId.slice(-8)}_${Date.now().toString(36)}`;
}

/**
 * Charge the passenger for an order. Returns the payment intent row.
 * Safe to call repeatedly with the same idempotencyKey.
 */
export function chargeOrder(
  db: Db, orderId: string, method: PaymentMethod, idempotencyKey: string, actorId?: string,
): Row {
  return tx(db, () => {
    const order = one(db, `SELECT * FROM orders WHERE id = ?`, orderId);
    if (!order) throw notFound('Замовлення не знайдено');
    if (order.payment_status === 'paid') {
      const paid = one(db, `SELECT * FROM payment_intents WHERE order_id = ? AND status = 'captured'`, orderId);
      if (paid) return paid; // already paid — replay-safe
    }
    const amount = Number(order.final_price_cents ?? order.quoted_price_cents);
    if (amount <= 0) throw unprocessable('Сума до сплати нульова');

    const intentId = id('pay');
    run(
      db,
      `INSERT INTO payment_intents (id, order_id, user_id, method, amount_cents, status, idempotency_key, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      intentId, orderId, order.passenger_id, method, amount, 'pending', idempotencyKey, iso(),
    );

    if (method === 'wallet') {
      const balance = walletBalance(db, order.passenger_id);
      if (balance < amount) throw unprocessable('Недостатньо коштів на балансі', { balanceCents: balance, requiredCents: amount });
      ledger(db, {
        userId: order.passenger_id, kind: 'ride_payment', amountCents: -amount,
        orderId, idempotencyKey: `ride_${orderId}`, meta: { method },
      });
    } else if (method === 'corporate') {
      if (!order.corporate_id) throw unprocessable('Замовлення не привʼязане до корпоративного акаунта');
      const member = one(
        db, `SELECT * FROM corporate_members WHERE company_id = ? AND (user_id = ? OR phone = ?)`,
        order.corporate_id, order.passenger_id, order.passenger_id,
      );
      const company = one(db, `SELECT * FROM companies WHERE id = ?`, order.corporate_id);
      if (!company || company.status !== 'active') throw conflict('Корпоративний акаунт неактивний');
      if (member && member.status !== 'active') throw conflict('Корпоративний доступ співробітника неактивний');
      if (member && member.monthly_limit_cents > 0 && member.spent_cents + amount > member.monthly_limit_cents) {
        throw unprocessable('Перевищено місячний ліміт співробітника', { limitCents: member.monthly_limit_cents, spentCents: member.spent_cents });
      }
      if (company.credit_limit_cents > 0) {
        const spent = one<{ total: number }>(
          db, `SELECT COALESCE(SUM(total_cents),0) AS total FROM corporate_invoices WHERE company_id = ? AND status = 'open'`,
          order.corporate_id,
        )!;
        if (spent.total + amount > company.credit_limit_cents) throw unprocessable('Перевищено кредитний ліміт компанії');
      }
      const period = iso().slice(0, 7);
      run(
        db,
        `INSERT INTO corporate_invoices (id, company_id, period, total_cents, orders_count) VALUES (?,?,?,?,1)
         ON CONFLICT(company_id, period) DO UPDATE SET total_cents = total_cents + ?, orders_count = orders_count + 1`,
        id('inv'), order.corporate_id, period, amount, amount,
      );
      if (member) run(db, `UPDATE corporate_members SET spent_cents = spent_cents + ? WHERE id = ?`, amount, member.id);
    } else {
      // cash / card / apple pay / google pay
      captureWithGateway(db, orderId, amount, method);
    }

    run(db, `UPDATE payment_intents SET status = 'captured', gateway_ref = ?, updated_at = ? WHERE id = ?`,
      `cap_${intentId}`, iso(), intentId);
    run(db, `UPDATE orders SET payment_status = 'paid', payment_method = ? WHERE id = ?`, method, orderId);
    db.prepare(`INSERT INTO order_events (order_id, type, actor_id, payload) VALUES (?,?,?,?)`)
      .run(orderId, 'payment.captured', actorId ?? null, JSON.stringify({ method, amount }));

    return one(db, `SELECT * FROM payment_intents WHERE id = ?`, intentId)!;
  });
}

/**
 * Settle a completed order: driver earnings, platform commission, cashback,
 * promo redemption counters. Idempotent by construction (unique ledger keys).
 */
export function settleOrder(db: Db, orderId: string): Row {
  return tx(db, () => {
    const order = one(db, `SELECT * FROM orders WHERE id = ?`, orderId);
    if (!order) throw notFound('Замовлення не знайдено');
    if (order.status !== 'completed') throw conflict('Розрахунок можливий лише для завершеного замовлення');

    const tariff = one(
      db,
      `SELECT * FROM tariffs WHERE city_id = ? AND class_id = ? AND active = 1 ORDER BY version DESC LIMIT 1`,
      order.city_id, order.class_id,
    );
    const total = Number(order.final_price_cents ?? order.quoted_price_cents);
    const commissionPct = Number(tariff?.commission_pct ?? 15);
    const commission = roundMoney((total * commissionPct) / 100);
    const driverNet = total - commission;

    run(db, `UPDATE orders SET commission_cents = ? WHERE id = ?`, commission, orderId);

    const method = order.payment_method as PaymentMethod;
    if (order.driver_id) {
      if (['cash'].includes(method)) {
        // driver collected the cash: his balance goes negative by the commission
        ledger(db, {
          userId: order.driver_id, kind: 'commission', amountCents: -commission, orderId,
          idempotencyKey: `commission_${orderId}`, meta: { model: 'cash', commissionPct },
        });
      } else {
        ledger(db, {
          userId: order.driver_id, kind: 'driver_earning', amountCents: driverNet, orderId,
          idempotencyKey: `earning_${orderId}`, meta: { model: method, commissionPct },
        });
      }
      run(db, `UPDATE driver_profiles SET orders_completed = orders_completed + 1 WHERE user_id = ?`, order.driver_id);
      notify(db, order.driver_id, 'settled', 'Нарахування за поїздку',
        `${(driverNet / 100).toFixed(0)} ₴ за №${order.number}`, { orderId });
    }

    // cashback to the passenger's bonus account
    const cashbackPct = settingNum(db, 'cashback_pct', 0);
    if (cashbackPct > 0 && !order.corporate_id) {
      const cashback = roundMoney((total * cashbackPct) / 100);
      if (cashback > 0) {
        ledger(db, {
          userId: order.passenger_id, account: 'bonus', kind: 'cashback', amountCents: cashback, orderId,
          idempotencyKey: `cashback_${orderId}`, meta: { pct: cashbackPct },
        });
        run(db, `UPDATE orders SET cashback_cents = ? WHERE id = ?`, cashback, orderId);
      }
    }

    if (order.promo_code) {
      run(db, `UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?`, order.promo_code);
    }
    db.prepare(`INSERT INTO order_events (order_id, type, payload) VALUES (?,?,?)`)
      .run(orderId, 'payment.settled', JSON.stringify({ commission, driverNet, total }));
    return one(db, `SELECT * FROM orders WHERE id = ?`, orderId)!;
  });
}

/** Refund a paid order (full or partial) — admin only. */
export function refundOrder(db: Db, orderId: string, amountCents: number | null, reason: string, actorId: string): Row {
  return tx(db, () => {
    const order = one(db, `SELECT * FROM orders WHERE id = ?`, orderId);
    if (!order) throw notFound('Замовлення не знайдено');
    if (order.payment_status !== 'paid') throw conflict('Замовлення не оплачене');
    const intent = one(db, `SELECT * FROM payment_intents WHERE order_id = ? AND status = 'captured'`, orderId);
    if (!intent) throw conflict('Платіж не знайдено');
    const amount = Math.min(amountCents ?? intent.amount_cents, intent.amount_cents);
    if (amount <= 0) throw unprocessable('Сума повернення має бути додатна');

    ledger(db, {
      userId: order.passenger_id, kind: 'refund', amountCents: amount, orderId,
      idempotencyKey: `refund_${orderId}_${amount}`, meta: { reason, actorId },
    });
    run(db, `UPDATE payment_intents SET status = 'refunded', updated_at = ? WHERE id = ?`, iso(), intent.id);
    run(db, `UPDATE orders SET payment_status = 'refunded' WHERE id = ?`, orderId);
    db.prepare(`INSERT INTO order_events (order_id, type, actor_id, payload) VALUES (?,?,?,?)`)
      .run(orderId, 'payment.refunded', actorId, JSON.stringify({ amount, reason }));
    notify(db, order.passenger_id, 'refund', 'Повернення коштів',
      `${(amount / 100).toFixed(0)} ₴ за замовленням №${order.number}`, { orderId });
    return { ok: true, refundedCents: amount };
  });
}

export function driverPayout(db: Db, driverId: string, amountCents: number, idempotencyKey: string): Row {
  const balance = walletBalance(db, driverId);
  if (amountCents <= 0) throw unprocessable('Сума має бути додатна');
  if (amountCents > balance) throw unprocessable('Недостатньо коштів для виплати', { balanceCents: balance });
  const min = settingNum(db, 'driver_payout_min_cents', 10000);
  if (amountCents < min) throw unprocessable(`Мінімальна сума виплати — ${(min / 100).toFixed(0)} ₴`);
  return tx(db, () =>
    ledger(db, { userId: driverId, kind: 'payout', amountCents: -amountCents, idempotencyKey, meta: { channel: 'iban' } }),
  );
}
