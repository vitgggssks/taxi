/** Cities, address search, reverse geocoding and the passenger wallet API. */
import type { FastifyInstance } from 'fastify';
import { all, Db, one } from '../lib/db.js';
import { audit, currentUser } from '../lib/http.js';
import { nearestCity, reverseGeocode, searchAddresses, zonesFor } from '../lib/geo.js';
import { ledger, topUp, walletBalance } from '../lib/payments.js';
import { num, str, unprocessable } from '../lib/util.js';

export function registerGeoRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/cities', async () => {
    const items = all(db, `SELECT id, name, region, country, currency, timezone, lat, lng FROM cities WHERE active = 1 ORDER BY name`);
    return { items };
  });

  app.get('/api/cities/nearest', async (req) => {
    const q = req.query as Record<string, string>;
    const lat = num(q.lat, 'lat', { min: -90, max: 90 });
    const lng = num(q.lng, 'lng', { min: -180, max: 180 });
    const city = nearestCity(db, { lat, lng });
    return { city };
  });

  app.get('/api/geo/search', async (req) => {
    const q = req.query as Record<string, string>;
    const cityId = str(q.cityId, 'cityId');
    const query = str(q.q, 'q', { min: 1, max: 80 });
    const city = one(db, `SELECT * FROM cities WHERE id = ?`, cityId);
    if (!city) throw unprocessable('Місто не обслуговується');
    const items = searchAddresses(db, cityId, query, 10);
    return { items, cityId };
  });

  app.get('/api/geo/reverse', async (req) => {
    const q = req.query as Record<string, string>;
    const lat = num(q.lat, 'lat', { min: -90, max: 90 });
    const lng = num(q.lng, 'lng', { min: -180, max: 180 });
    const cityId = q.cityId ?? nearestCity(db, { lat, lng })?.id;
    if (!cityId) throw unprocessable('Не вдалось визначити місто');
    return reverseGeocode(db, cityId, { lat, lng });
  });

  app.get('/api/geo/zones', async (req) => {
    const q = req.query as Record<string, string>;
    const lat = num(q.lat, 'lat', { min: -90, max: 90 });
    const lng = num(q.lng, 'lng', { min: -180, max: 180 });
    const cityId = str(q.cityId, 'cityId');
    return { zones: zonesFor(db, cityId, { lat, lng }) };
  });

  /* ------------------------------------------------------------- wallet --- */
  app.get('/api/wallet', async (req) => {
    const user = currentUser(db, req);
    const transactions = all(
      db,
      `SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50`,
      user.id,
    );
    return {
      balanceCents: walletBalance(db, user.id),
      bonusCents: walletBalance(db, user.id, 'bonus'),
      transactions,
    };
  });

  app.post('/api/wallet/topup', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = num(body.amountCents, 'amountCents', { min: 1000, max: 5_000_000, int: true });
    const key = body.idempotencyKey ? str(body.idempotencyKey, 'idempotencyKey', { max: 80 }) : `topup_${user.id}_${Date.now()}`;
    const txn = topUp(db, user.id, amount, key, { via: String(body.method ?? 'card') });
    audit(db, user, 'wallet.topup', 'wallet', user.id, { amount });
    return { ok: true, transaction: txn, balanceCents: walletBalance(db, user.id) };
  });

  app.post('/api/wallet/withdraw', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = num(body.amountCents, 'amountCents', { min: 1000, int: true });
    const balance = walletBalance(db, user.id);
    if (amount > balance) throw unprocessable('Недостатньо коштів', { balanceCents: balance });
    const txn = ledger(db, {
      userId: user.id, kind: 'payout', amountCents: -amount,
      idempotencyKey: `withdraw_${user.id}_${Date.now()}`, meta: { channel: 'card' },
    });
    return { ok: true, transaction: txn, balanceCents: walletBalance(db, user.id) };
  });
}
