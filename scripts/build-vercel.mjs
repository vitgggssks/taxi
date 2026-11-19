#!/usr/bin/env node
/**
 * Збірка API у вигляді serverless-функції для Vercel.
 *
 *   node scripts/build-vercel.mjs
 *
 * Що робить:
 *  1. бандлить server/src/vercel.ts в один файл api/index.mjs (esbuild);
 *  2. підміняє нативний better-sqlite3 на адаптер поверх node:sqlite;
 *  3. інлайнить schema.sql (файлової системи в функції немає);
 *  4. генерує мінімальну landing-сторінку public/index.html.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = resolve(root, 'server');

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  console.error('[build-vercel] потрібен esbuild: npm install --no-save esbuild');
  process.exit(1);
}

const schema = readFileSync(resolve(server, 'src/schema.sql'), 'utf8');

rmSync(resolve(root, 'api'), { recursive: true, force: true });
mkdirSync(resolve(root, 'api'), { recursive: true });

await esbuild.build({
  absWorkingDir: server,
  entryPoints: ['src/vercel.ts'],
  outfile: resolve(root, 'api/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  mainFields: ['module', 'main'],
  alias: { 'better-sqlite3': resolve(server, 'src/db/node-sqlite.mjs') },
  define: { 'process.env.SCHEMA_SQL': JSON.stringify(schema) },
  // опційні нативні прискорювачі ws не потрібні
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});

const landing = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>РУХ API</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0b0f0d; color: #e9efe9; font: 16px/1.5 system-ui, sans-serif; padding: 24px; }
  .card { max-width: 620px; width: 100%; background: #141a17; border: 1px solid #222c27;
          border-radius: 20px; padding: 28px; }
  .mark { width: 44px; height: 44px; border-radius: 12px; background: #9be64b; color: #0b0f0d;
          display: grid; place-items: center; font-weight: 800; font-size: 22px; }
  h1 { font-size: 22px; margin: 16px 0 4px; }
  p { color: #8fa098; margin: 0 0 16px; }
  code { background: #1b2320; padding: 2px 6px; border-radius: 6px; }
  a { color: #9be64b; }
  ul { padding-left: 18px; color: #cfe0d5; }
  li { margin: 6px 0; }
  .note { margin-top: 18px; font-size: 13px; color: #8fa098; border-top: 1px solid #222c27; padding-top: 14px; }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">Р</div>
    <h1>РУХ API працює</h1>
    <p>Serverless-інстанс платформи таксі, міжміста та доставки.</p>
    <ul>
      <li><a href="/api/health">/api/health</a> — стан сервісу</li>
      <li><code>POST /api/auth/demo-login</code> — демо-вхід (пасажир, водій, адмін)</li>
      <li><code>GET /api/cities</code>, <code>GET /api/catalog</code>, <code>POST /api/orders/quote</code></li>
    </ul>
    <div class="note">
      Демо-дані (міста, тарифи, водії, акаунти) створюються на кожному холодному старті.
      Стан замовлень живе в памʼяті інстансу й скидається після його зупинки — це demo-режим.
      WebSocket тут недоступний: клієнти оновлюють стан опитуванням (REST).
    </div>
  </div>
</body>
</html>
`;
mkdirSync(resolve(root, 'public'), { recursive: true });
writeFileSync(resolve(root, 'public/index.html'), landing);
console.log('[build-vercel] готово: api/index.mjs + public/index.html');
