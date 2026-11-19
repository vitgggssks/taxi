/** Auth module: phone + OTP, sessions, profile. */
import type { FastifyInstance } from 'fastify';
import { Db, one, run } from '../lib/db.js';
import { audit, currentUser, publicUser, requireRole } from '../lib/http.js';
import { bad, conflict, id, iso, isoAfter, makeToken, notFound, num, oneOf, otp, phone, str, unauthorized, unprocessable } from '../lib/util.js';

const setting = (db: Db, key: string, fallback: unknown) => {
  const row = one(db, `SELECT value FROM settings WHERE key = ?`, key);
  try {
    return row ? JSON.parse(row.value) : fallback;
  } catch {
    return fallback;
  }
};

export function registerAuthRoutes(app: FastifyInstance, db: Db) {
  /** Step 1 — request an OTP for a phone number. */
  app.post('/api/auth/request-otp', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userPhone = phone(body.phone);
    const ttl = Number(setting(db, 'otp_ttl_seconds', 300));

    const recent = one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at > datetime('now','-10 minutes')`,
      userPhone,
    );
    if (recent && recent.n >= 3) throw conflict('Забагато запитів. Спробуйте за 10 хвилин.');

    const code = otp();
    run(db, `INSERT INTO otp_codes (id, phone, code, expires_at) VALUES (?,?,?,?)`, id('otp'), userPhone, code, isoAfter(ttl));
    const user = one(db, `SELECT * FROM users WHERE phone = ?`, userPhone);

    // In production this is where an SMS provider (TurboSMS / Twilio) is called.
    // Demo mode returns the code so the flow is testable without an SMS gateway.
    return {
      sent: true,
      channel: 'sms',
      expiresInSec: ttl,
      isNewUser: !user,
      demoCode: code,
      hint: 'SMS-провайдер не підключений: код повертається у відповіді (demo mode)',
    };
  });

  /** Step 2 — verify the OTP and open a session (auto-registration). */
  app.post('/api/auth/verify-otp', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userPhone = phone(body.phone);
    const code = str(body.code, 'code', { min: 4, max: 8 });
    const maxAttempts = Number(setting(db, 'otp_max_attempts', 5));

    const record = one(
      db,
      `SELECT * FROM otp_codes WHERE phone = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      userPhone,
    );
    if (!record) throw unprocessable('Код не знайдено. Запросіть новий.', { field: 'code' });
    if (record.expires_at < iso()) throw unprocessable('Термін дії коду минув', { field: 'code' });
    if (record.attempts >= maxAttempts) throw conflict('Перевищено кількість спроб. Запросіть новий код.');
    if (record.code !== code) {
      run(db, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, record.id);
      throw unprocessable('Невірний код', { field: 'code', attemptsLeft: maxAttempts - record.attempts - 1 });
    }
    run(db, `UPDATE otp_codes SET consumed_at = ? WHERE id = ?`, iso(), record.id);

    let user = one(db, `SELECT * FROM users WHERE phone = ?`, userPhone);
    if (!user) {
      const userId = id('usr');
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
      run(db, `INSERT INTO users (id, role, phone, name) VALUES (?,?,?,?)`, userId, 'passenger', userPhone, name);
      user = one(db, `SELECT * FROM users WHERE id = ?`, userId)!;
      audit(db, null, 'user.registered', 'user', userId, { phone: userPhone });
    }
    if (user.status === 'blocked') throw unauthorized('Акаунт заблоковано');

    const token = makeToken(user.id);
    run(db, `INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)`, token, user.id,
      new Date(Date.now() + 30 * 864e5).toISOString());

    return { token, user: publicUser(user) };
  });

  /** Demo shortcut used by the bundled web clients (no SMS gateway attached). */
  app.post('/api/auth/demo-login', async (req) => {
    if (setting(db, 'allow_demo_login', true) !== true) throw notFound('Демо-вхід вимкнено');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const role = oneOf(body.role, ['passenger', 'driver', 'dispatcher', 'admin', 'corporate_admin'] as const, 'role', 'passenger');
    const key = body.phone ? phone(body.phone) : null;
    const user = key
      ? one(db, `SELECT * FROM users WHERE phone = ?`, key)
      : one(db, `SELECT * FROM users WHERE role = ? ORDER BY created_at LIMIT 1`, role);
    if (!user) throw notFound('Демо-користувача не знайдено');
    const token = makeToken(user.id);
    run(db, `INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)`, token, user.id,
      new Date(Date.now() + 30 * 864e5).toISOString());
    return { token, user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (req) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) run(db, `UPDATE sessions SET revoked_at = ? WHERE token = ?`, iso(), token);
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const user = currentUser(db, req);
    const out: Record<string, unknown> = { ...publicUser(user) };
    if (user.role === 'driver') {
      out.driver = one(db, `SELECT * FROM driver_profiles WHERE user_id = ?`, user.id) ?? null;
      out.vehicles = db.prepare(`SELECT * FROM vehicles WHERE driver_id = ? AND active = 1`).all(user.id);
    }
    if (user.corporate_id) {
      out.company = one(db, `SELECT * FROM companies WHERE id = ?`, user.corporate_id) ?? null;
      out.corporateMember = one(
        db, `SELECT * FROM corporate_members WHERE company_id = ? AND (user_id = ? OR phone = ?)`,
        user.corporate_id, user.id, user.phone,
      ) ?? null;
    }
    return out;
  });

  app.patch('/api/me', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) { fields.push('name = ?'); values.push(str(body.name, 'name', { min: 2, max: 80 })); }
    if (body.email !== undefined) { fields.push('email = ?'); values.push(str(body.email, 'email', { max: 120 })); }
    if (body.photoUrl !== undefined) { fields.push('photo_url = ?'); values.push(str(body.photoUrl, 'photoUrl', { max: 500 })); }
    if (body.locale !== undefined) { fields.push('locale = ?'); values.push(oneOf(body.locale, ['uk', 'en', 'ro', 'hu'] as const, 'locale')); }
    if (body.cityId !== undefined && ['passenger', 'driver'].includes(user.role)) {
      const city = one(db, `SELECT id FROM cities WHERE id = ?`, str(body.cityId, 'cityId'));
      if (!city) throw bad('Місто не знайдено');
      fields.push('city_id = ?');
      values.push(body.cityId);
    }
    if (!fields.length) return { ok: true, user: publicUser(user) };
    run(db, `UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...values, user.id);
    const updated = one(db, `SELECT * FROM users WHERE id = ?`, user.id)!;
    audit(db, user, 'user.updated', 'user', user.id, { fields: fields.map((f) => f.split(' ')[0]) });
    return { ok: true, user: publicUser(updated) };
  });

  /** Device token registration for FCM push. */
  app.post('/api/me/device-token', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = str(body.token, 'token', { min: 8, max: 400 });
    const platform = oneOf(body.platform, ['android', 'ios', 'web'] as const, 'platform', 'web');
    run(db, `INSERT INTO device_tokens (id, user_id, token, platform) VALUES (?,?,?,?)
             ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform`,
      id('dev'), user.id, token, platform);
    return { ok: true };
  });

  app.get('/api/me/notifications', async (req) => {
    const user = currentUser(db, req);
    const rows = db.prepare(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).all(user.id);
    return { items: rows };
  });

  app.post('/api/me/notifications/:id/read', async (req) => {
    const user = currentUser(db, req);
    const { id: notifId } = req.params as { id: string };
    run(db, `UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?`, iso(), notifId, user.id);
    return { ok: true };
  });

  /** Saved addresses ("Мої адреси"). */
  app.get('/api/me/addresses', async (req) => {
    const user = currentUser(db, req);
    return { items: db.prepare(`SELECT * FROM saved_addresses WHERE user_id = ? ORDER BY created_at`).all(user.id) };
  });

  app.post('/api/me/addresses', async (req) => {
    const user = currentUser(db, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = str(body.label, 'label', { min: 1, max: 40 });
    const address = str(body.address, 'address', { min: 3, max: 200 });
    const lat = num(body.lat, 'lat', { min: -90, max: 90 });
    const lng = num(body.lng, 'lng', { min: -180, max: 180 });
    const count = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM saved_addresses WHERE user_id = ?`, user.id)!;
    if (count.n >= 20) throw conflict('Максимум 20 збережених адрес');
    const addressId = id('sav');
    run(db, `INSERT INTO saved_addresses (id, user_id, label, address, lat, lng) VALUES (?,?,?,?,?,?)`,
      addressId, user.id, label, address, lat, lng);
    return { ok: true, item: one(db, `SELECT * FROM saved_addresses WHERE id = ?`, addressId) };
  });

  app.delete('/api/me/addresses/:id', async (req) => {
    const user = currentUser(db, req);
    const { id: addressId } = req.params as { id: string };
    const row = one(db, `SELECT * FROM saved_addresses WHERE id = ? AND user_id = ?`, addressId, user.id);
    if (!row) throw notFound('Адресу не знайдено');
    run(db, `DELETE FROM saved_addresses WHERE id = ?`, addressId);
    return { ok: true };
  });

  /** Admin-only: role management. */
  app.post('/api/admin/users/:id/role', async (req) => {
    const actor = currentUser(db, req);
    requireRole(actor, 'admin');
    const { id: userId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const role = oneOf(body.role, ['passenger', 'driver', 'dispatcher', 'admin', 'corporate_admin'] as const, 'role');
    if (userId === actor.id) throw conflict('Не можна змінити власну роль');
    const target = one(db, `SELECT * FROM users WHERE id = ?`, userId);
    if (!target) throw notFound('Користувача не знайдено');
    run(db, `UPDATE users SET role = ? WHERE id = ?`, role, userId);
    audit(db, actor, 'user.role_changed', 'user', userId, { from: target.role, to: role });
    return { ok: true };
  });
}
