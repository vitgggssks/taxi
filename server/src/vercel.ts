/**
 * Serverless-вхід API (Vercel Functions).
 *
 * Vercel не тримає довгоживучий процес, тому:
 *  - БД — `node:sqlite` у `/tmp` (схема + сід створюються на холодному старті);
 *  - фоновий диспетчер-цикл заміщено «опортуністичним» тіком на кожному запиті
 *    (таймаути пропозицій, наступні раунди, планові замовлення);
 *  - WebSocket недоступний → клієнти доопитують стан через REST (polling),
 *    що вже реалізовано в пасажирському й водійському екранах.
 *
 * Локальна розробка й docker-compose використовують src/index.ts (Fastify + workers).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './app.js';
import { all } from './lib/db.js';
import { runDispatchTick, tryDispatch } from './lib/dispatch.js';

export const { app, db } = buildApp({
  dbFile: process.env.DB_FILE ?? '/tmp/rukh.db',
  seed: true,
  webRoot: '../web',
});

let lastTick = 0;

/** Мінімальний «воркер»: не частіше ніж раз на 2 с на інстанс. */
function tick(): void {
  const now = Date.now();
  if (now - lastTick < 2000) return;
  lastTick = now;
  try {
    runDispatchTick(db);
    const due = all(
      db,
      `SELECT * FROM orders WHERE scheduled_at IS NOT NULL AND status = 'searching'
         AND scheduled_at <= datetime('now', '+10 minutes')
         AND (SELECT COUNT(*) FROM order_offers o WHERE o.order_id = orders.id) = 0`,
    );
    for (const order of due) {
      try {
        tryDispatch(db, order.id);
      } catch {
        /* одне замовлення не має валити обробку запиту */
      }
    }
  } catch {
    /* тік не повинен ламати відповідь */
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await app.ready();
  tick();
  app.server.emit('request', req, res);
}
