/**
 * Database layer.
 *
 * The code targets a repository-free but *swappable* DAO: every module talks to
 * SQL through this file only, and the SQL dialect used here (SQLite) is a
 * strict subset of the PostgreSQL schema in docs/03-data-model.sql.
 * Switching to PostgreSQL/PostGIS = replacing this file's driver + the geo
 * helpers in lib/geo.ts (which mirror ST_DWithin / ST_Contains semantics).
 */
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export type Row = Record<string, any>;

export function createDb(file = process.env.DB_FILE ?? join(here, '../../data/taxi.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // У serverless-збірці (Vercel) схема інлайниться в бандл і передається через
  // SCHEMA_SQL — файлової системи поруч із функцією немає.
  const schemaSql = process.env.SCHEMA_SQL ?? readFileSync(join(here, '../schema.sql'), 'utf8');
  db.exec(schemaSql);
  return db;
}

export type Db = ReturnType<typeof createDb>;

/** Synchronous transaction wrapper (better-sqlite3 semantics). */
export function tx<T>(db: Db, fn: () => T): T {
  const wrapped = db.transaction(fn);
  return wrapped();
}

export function one<T = Row>(db: Db, sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T = Row>(db: Db, sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(db: Db, sql: string, ...params: any[]): Database.RunResult {
  return db.prepare(sql).run(...params);
}
