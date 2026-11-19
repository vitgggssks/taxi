import { buildApp, startWorkers } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.BIND_HOST ?? '0.0.0.0';

const { app, db } = buildApp({ logger: process.env.LOG === '1' });

startWorkers(db, Number(process.env.DISPATCH_TICK_MS ?? 2000));

app
  .listen({ port, host })
  .then((address) => {
    // eslint-disable-next-line no-console
    console.log(`[rukh] API ready on ${address}`);
    console.log(`[rukh] passenger app  → http://localhost:${port}/`);
    console.log(`[rukh] driver app     → http://localhost:${port}/driver`);
    console.log(`[rukh] admin panel    → http://localhost:${port}/admin`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[rukh] failed to start', err);
    process.exit(1);
  });

const shutdown = () => {
  app.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
