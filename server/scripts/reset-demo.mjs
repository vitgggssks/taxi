#!/usr/bin/env node
/**
 * Повертає демо-середовище у чистий стан: скасовує активні замовлення,
 * звільняє водіїв, вимикає авто-прийняття. Корисно перед демонстрацією.
 * Usage: node scripts/reset-demo.mjs [path-to-db]
 */
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? process.env.DB_FILE ?? join(here, '../data/taxi.db');
const db = new Database(file);

const canceled = db.prepare(
  `UPDATE orders SET status = 'canceled' WHERE status IN
   ('searching','offered','no_drivers','assigned','driver_arriving','waiting','in_progress')`,
).run().changes;
db.prepare(`UPDATE order_offers SET status = 'revoked' WHERE status = 'offered'`).run();
db.prepare(`UPDATE driver_profiles SET work_status = 'online', auto_accept = 0 WHERE status = 'verified'`).run();

console.log(`[reset-demo] скасовано замовлень: ${canceled}`);
console.log(`[reset-demo] водіїв на лінії: ${db.prepare(`SELECT COUNT(*) c FROM driver_profiles WHERE work_status='online'`).get().c}`);
