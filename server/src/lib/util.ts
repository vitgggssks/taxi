import { randomUUID, randomInt, createHmac, timingSafeEqual } from 'node:crypto';

export const SECRET = process.env.APP_SECRET ?? 'dev-secret-change-me';

export type Json = Record<string, any>;

/* ------------------------------------------------------------------ ids --- */
export const id = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
export const orderNumber = (): string => {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${ymd}-${randomInt(1000, 9999)}`;
};
export const otp = (): string => String(randomInt(100000, 999999));

/* ---------------------------------------------------------------- money --- */
/** All money is stored as integer minor units (копійки). */
export const roundMoney = (v: number): number => Math.round(v);
export const toMoney = (cents: number): string => (cents / 100).toFixed(2);
export const fromMoney = (value: string | number): number => Math.round(Number(value) * 100);

/* ------------------------------------------------------------------ jwt --- */
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const sign = (payload: string) => createHmac('sha256', SECRET).update(payload).digest('base64url');

export function makeToken(userId: string, ttlSec = 60 * 60 * 24 * 30): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  // jti keeps tokens unique even for back-to-back logins of the same user
  const payload = `${userId}.${exp}.${randomUUID().slice(0, 8)}`;
  return `${b64(payload)}.${sign(payload)}`;
}

export function readToken(token: string): { userId: string; exp: number } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let payload: string;
  try {
    payload = Buffer.from(parts[0], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(parts[1]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const [userId, expRaw] = payload.split('.');
  const exp = Number(expRaw);
  if (!userId || !Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  return { userId, exp };
}

/* ------------------------------------------------------------- errors ----- */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const bad = (msg: string, details?: unknown) => new ApiError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Потрібна авторизація') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Немає доступу') => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = 'Не знайдено') => new ApiError(404, 'not_found', msg);
export const conflict = (msg: string) => new ApiError(409, 'conflict', msg);
export const unprocessable = (msg: string, details?: unknown) => new ApiError(422, 'unprocessable', msg, details);

/* ---------------------------------------------------------- validation ---- */
export function str(v: unknown, name: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw bad(`Поле «${name}» обовʼязкове`, { field: name });
  }
  if (typeof v !== 'string') throw bad(`Поле «${name}» має бути рядком`, { field: name });
  const s = v.trim();
  if (opts.min !== undefined && s.length < opts.min) throw bad(`Поле «${name}» закоротке`, { field: name });
  if (opts.max !== undefined && s.length > opts.max) throw bad(`Поле «${name}» задовге`, { field: name });
  return s;
}

export function num(v: unknown, name: string, opts: { min?: number; max?: number; optional?: boolean; int?: boolean } = {}): number {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return NaN;
    throw bad(`Поле «${name}» обовʼязкове`, { field: name });
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`Поле «${name}» має бути числом`, { field: name });
  if (opts.int && !Number.isInteger(n)) throw bad(`Поле «${name}» має бути цілим числом`, { field: name });
  if (opts.min !== undefined && n < opts.min) throw bad(`Поле «${name}» має бути ≥ ${opts.min}`, { field: name });
  if (opts.max !== undefined && n > opts.max) throw bad(`Поле «${name}» має бути ≤ ${opts.max}`, { field: name });
  return n;
}

export function phone(raw: unknown): string {
  const s = str(raw, 'phone', { min: 9, max: 20 }).replace(/[^\d+]/g, '');
  const digits = s.replace(/^\+/, '');
  if (digits.length < 9) throw bad('Невірний номер телефону', { field: 'phone' });
  return `+${digits}`;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string, fallback?: T): T {
  if (v === undefined || v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw bad(`Поле «${name}» обовʼязкове`, { field: name, allowed });
  }
  if (!allowed.includes(v as T)) throw bad(`Недопустиме значення «${name}»`, { field: name, allowed });
  return v as T;
}

export const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
export const iso = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const isoAfter = (seconds: number): string =>
  new Date(Date.now() + seconds * 1000).toISOString().replace('T', ' ').slice(0, 19);

export const parseJson = <T = any>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};
