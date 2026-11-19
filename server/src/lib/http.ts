import type { FastifyRequest } from 'fastify';
import { Db, one, Row } from './db.js';
import { forbidden, readToken, unauthorized } from './util.js';

export interface AuthUser extends Row {
  id: string;
  role: string;
  phone: string;
  name: string | null;
  city_id: string | null;
  corporate_id: string | null;
  status: string;
}

export function tokenFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const q = (req.query as any)?.token;
  if (typeof q === 'string' && q) return q;
  return null;
}

export function currentUser(db: Db, req: FastifyRequest): AuthUser {
  const token = tokenFrom(req);
  if (!token) throw unauthorized();
  const payload = readToken(token);
  if (!payload) throw unauthorized('Сесія недійсна або прострочена');
  const session = one(db, `SELECT * FROM sessions WHERE token = ?`, token);
  if (!session || session.revoked_at) throw unauthorized('Сесію завершено');
  const user = one<AuthUser>(db, `SELECT * FROM users WHERE id = ?`, payload.userId);
  if (!user) throw unauthorized('Користувача не знайдено');
  if (user.status === 'blocked') throw forbidden('Акаунт заблоковано');
  return user;
}

export function optionalUser(db: Db, req: FastifyRequest): AuthUser | null {
  try {
    return currentUser(db, req);
  } catch {
    return null;
  }
}

export function requireRole(user: AuthUser, ...roles: string[]): void {
  if (!roles.includes(user.role)) throw forbidden(`Доступ лише для: ${roles.join(', ')}`);
}

export function audit(
  db: Db, actor: AuthUser | null, action: string, entity: string, entityId: string | null, payload: Row = {},
): void {
  db.prepare(
    `INSERT INTO audit_logs (actor_id, actor_role, action, entity, entity_id, payload, city_id)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(actor?.id ?? null, actor?.role ?? 'system', action, entity, entityId, JSON.stringify(payload), actor?.city_id ?? null);
}

export function publicUser(user: Row): Row {
  return {
    id: user.id, role: user.role, phone: user.phone, name: user.name, email: user.email,
    photoUrl: user.photo_url, locale: user.locale, cityId: user.city_id,
    corporateId: user.corporate_id, createdAt: user.created_at,
  };
}
