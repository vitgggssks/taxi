import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import { createDb, type Db } from './lib/db.js';
import { ApiError, readToken } from './lib/util.js';
import { one } from './lib/db.js';
import { hub } from './lib/realtime.js';
import { registerAuthRoutes } from './modules/auth.js';
import { registerOrderRoutes } from './modules/orders.js';
import { registerDriverRoutes } from './modules/driver.js';
import { registerAdminRoutes } from './modules/admin.js';
import { registerCorporateRoutes, registerSupportRoutes } from './modules/corporate.js';
import { registerGeoRoutes } from './modules/geo.js';
import { registerUploadRoutes } from './modules/uploads.js';
import { seedDatabase } from './seed.js';
import { all } from './lib/db.js';
import { runDispatchTick, tryDispatch } from './lib/dispatch.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

export interface AppOptions {
  dbFile?: string;
  webRoot?: string;
  seed?: boolean;
  logger?: boolean;
}

export function buildApp(options: AppOptions = {}): { app: FastifyInstance; db: Db } {
  const db = createDb(options.dbFile ?? process.env.DB_FILE);
  if (options.seed !== false) seedDatabase(db);

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 2 * 1024 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', req.headers.origin ?? '*');
    reply.header('access-control-allow-headers', 'authorization,content-type');
    reply.header('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    reply.header('access-control-allow-credentials', 'true');
    if (req.method === 'OPTIONS') return reply.status(204).send();
  });

  // Проксі (Cloudflare quick tunnel) інколи додає content-type до запиту без
  // тіла — не відповідаємо 415, а трактуємо таке тіло як порожній JSON.
  app.addContentTypeParser(
    ['application/octet-stream', 'text/plain'],
    { parseAs: 'string' },
    (_req, body, done) => {
      const text = String(body ?? '').trim();
      if (!text) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch {
        done(null, {});
      }
    },
  );

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    const anyErr = error as any;
    if (anyErr?.validation) {
      return reply.status(400).send({ error: { code: 'validation_error', message: anyErr.message, details: anyErr.validation } });
    }
    // Fastify-помилки рівня протоколузуються зі своїм статусом (415, 413, 400)
    const status = Number(anyErr?.statusCode);
    if (Number.isFinite(status) && status >= 400 && status < 500) {
      return reply.status(status).send({
        error: { code: anyErr?.code ?? 'bad_request', message: anyErr?.message ?? 'Некоректний запит' },
      });
    }
    req.log?.error?.(error);
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Внутрішня помилка сервера', details: anyErr?.message } });
  });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'rukh-api',
    version: '0.1.0',
    time: new Date().toISOString(),
    realtimeClients: hub.onlineCount(),
  }));

  registerAuthRoutes(app, db);
  registerOrderRoutes(app, db);
  registerDriverRoutes(app, db);
  registerAdminRoutes(app, db);
  registerGeoRoutes(app, db);
  registerUploadRoutes(app, db);
  registerCorporateRoutes(app, db);
  registerSupportRoutes(app, db);

  /* ------------------------------------------------------------ static web */
  const webRoot = options.webRoot ?? join(process.cwd(), '../web');
  const sendFile = (reply: any, path: string) => {
    const body = readFileSync(path);
    reply.header('content-type', MIME[extname(path)] ?? 'application/octet-stream');
    reply.header('cache-control', 'no-cache');
    return reply.send(body);
  };
  app.get('/', async (_req, reply) => sendFile(reply, join(webRoot, 'index.html')));
  app.get('/driver', async (_req, reply) => sendFile(reply, join(webRoot, 'driver.html')));
  app.get('/admin', async (_req, reply) => sendFile(reply, join(webRoot, 'admin.html')));
  app.get('/app/*', async (req, reply) => {
    const rel = normalize((req.params as any)['*'] ?? '').replace(/^(\.\.[/\\])+/, '');
    const path = join(webRoot, 'app', rel);
    if (!existsSync(path)) return reply.status(404).send({ error: { code: 'not_found', message: 'Файл не знайдено' } });
    return sendFile(reply, path);
  });

  /* ------------------------------------------------------------- websocket */
  const wss = new WebSocketServer({ server: app.server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');
    const payload = token ? readToken(token) : null;
    const user = payload ? one<{ id: string; role: string; status: string }>(db, `SELECT id, role, status FROM users WHERE id = ?`, payload.userId) : null;
    if (!user || user.status === 'blocked') {
      ws.send(JSON.stringify({ event: 'error', payload: { message: 'unauthorized' } }));
      ws.close();
      return;
    }
    hub.join(ws, [`user:${user.id}`, `role:${user.role}`]);
    ws.send(JSON.stringify({ event: 'connected', payload: { userId: user.id, role: user.role } }));

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.type === 'ping') {
        ws.send(JSON.stringify({ event: 'pong', at: new Date().toISOString() }));
        return;
      }
      if (msg?.type === 'subscribe' && typeof msg.channel === 'string') {
        const [kind, entityId, extra] = msg.channel.split(':');
        if (kind === 'order' && entityId) {
          const order = one(db, `SELECT * FROM orders WHERE id = ?`, entityId);
          if (!order) return;
          const isStaff = ['admin', 'dispatcher'].includes(user.role);
          const allowed = isStaff || order.passenger_id === user.id || order.driver_id === user.id;
          if (allowed) hub.join(ws, [msg.channel]);
        }
        if (kind === 'user' && entityId && (entityId === user.id || ['admin', 'dispatcher'].includes(user.role))) {
          hub.join(ws, [msg.channel]);
        }
        if (kind === 'driver' && entityId) hub.join(ws, [`driver:${entityId}`]);
        if (kind === 'city' && extra) hub.join(ws, [msg.channel]);
      }
      if (msg?.type === 'unsubscribe' && typeof msg.channel === 'string') {
        hub.leaveChannel(ws, msg.channel);
      }
    });
    ws.on('close', () => hub.leave(ws));
  });

  (app as any).decorate('db', db);
  (app as any).decorate('wss', wss);
  (app as any).db = db;
  return { app, db };
}

/** Background dispatcher loop — offer timeouts, re-offers, scheduled releases. */
export function startWorkers(db: Db, intervalMs = 2000): NodeJS.Timeout {
  const timer = setInterval(() => {
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
          /* one order must not stop the loop */
        }
      }
    } catch {
      /* worker must never crash the process */
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}
