#!/usr/bin/env node
/**
 * Вартовий демо-тунелів.
 *
 * Проблема: безкоштовні quick-тунелі Cloudflare періодично втрачають з'єднання
 * з edge (`no recent network activity`) і на кілька хвилин віддають 530, після
 * чого інколи піднімаються з *новою* адресою. Через це застосунок із вшитою
 * адресою не міг зайти в демо.
 *
 * Що робить вартовий:
 *   1) тримає N тунелів до локального API;
 *   2) кожні 10 с перевіряє кожен публічний URL через /api/health;
 *   3) після двох невдалих перевірок перезапускає тунель (нова адреса);
 *   4) публікує живий список адрес у `endpoint.json` репозиторію, який
 *      застосунок читає на старті — APK перезбирати не потрібно.
 *
 * Запуск:
 *   GITHUB_TOKEN=... node scripts/tunnel-watchdog.mjs
 * Змінні: CLOUDFLARED, TUNNEL_TARGET, TUNNEL_COUNT, WATCH_INTERVAL_MS,
 *         REPO_DIR, GIT_BRANCH, DRY_RUN=1 (не пушити).
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BIN = process.env.CLOUDFLARED ?? join(homedir(), '.cache/cloudflared');
const TARGET = process.env.TUNNEL_TARGET ?? 'http://127.0.0.1:3000';
const COUNT = Number(process.env.TUNNEL_COUNT ?? 2);
const INTERVAL = Number(process.env.WATCH_INTERVAL_MS ?? 10_000);
const REPO_DIR = process.env.REPO_DIR ?? join(homedir(), 'taxi');
const BRANCH = process.env.GIT_BRANCH ?? 'main';
const TOKEN = process.env.GITHUB_TOKEN ?? '';
const DRY_RUN = process.env.DRY_RUN === '1';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** url -> { proc, failures, since } */
const tunnels = new Map();
/** останній опублікований набір адрес */
let published = '';

const log = (...args) => console.log(new Date().toISOString(), ...args);

function startTunnel() {
  const proc = spawn(BIN, ['tunnel', '--url', TARGET, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  const onData = (chunk) => {
    buffer += String(chunk);
    const match = buffer.match(URL_RE);
    if (match && !tunnels.has(match[0])) {
      const url = match[0];
      tunnels.set(url, { proc, failures: 0, since: Date.now() });
      log(`+ тунель ${url}`);
      publish();
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code) => {
    for (const [url, entry] of tunnels) {
      if (entry.proc === proc) {
        tunnels.delete(url);
        log(`- тунель ${url} завершився (code ${code})`);
      }
    }
    // не даємо кількості тунелів проснути нижче COUNT
    setTimeout(() => {
      if (tunnels.size < COUNT) startTunnel();
    }, 2000);
  });
  return proc;
}

async function alive(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${url}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

function publish() {
  const urls = [...tunnels.keys()];
  const payload = JSON.stringify(urls.slice().sort());
  if (!urls.length || payload === published) return;
  published = payload;

  const file = join(REPO_DIR, 'endpoint.json');
  const data = {
    service: 'rukh-api',
    updatedAt: new Date().toISOString(),
    note:
      'Публічні адреси демо-API. Оновлюється вартовим тунелів (scripts/tunnel-watchdog.mjs). ' +
      'Застосунок читає цей файл на старті й сам обирає живу адресу — APK перезбирати не потрібно.',
    endpoints: urls,
  };
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  log(`endpoint.json → ${urls.join(', ')}`);

  if (DRY_RUN || !TOKEN) return;
  try {
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    const run = (args) =>
      execFileSync('git', ['-c', `http.extraheader=AUTHORIZATION: basic ${basic}`, ...args], {
        cwd: REPO_DIR,
        stdio: 'pipe',
      });
    run(['add', 'endpoint.json']);
    try {
      run(['commit', '-m', `chore(endpoint): живі адреси API — ${urls.length} шт.`]);
    } catch {
      /* нічого не змінилось */
    }
    run(['push', 'origin', BRANCH]);
    log('endpoint.json опубліковано в GitHub');
  } catch (error) {
    log('не вдалося опублікувати endpoint.json:', String(error.message ?? error).slice(0, 200));
  }
}

async function tick() {
  for (const [url, entry] of [...tunnels]) {
    const ok = await alive(url);
    if (ok) {
      if (entry.failures) log(`✓ ${url} знову відповідає`);
      entry.failures = 0;
      continue;
    }
    entry.failures += 1;
    log(`✗ ${url} не відповідає (${entry.failures}/2)`);
    if (entry.failures >= 2) {
      log(`↻ перезапускаю тунель ${url}`);
      try {
        entry.proc.kill('SIGTERM');
      } catch {
        /* вже мертвий */
      }
      tunnels.delete(url);
      startTunnel();
    }
  }
  while (tunnels.size < COUNT) startTunnel();
  publish();
}

if (!existsSync(BIN)) {
  console.error(`не знайдено cloudflared: ${BIN}`);
  process.exit(1);
}

log(`вартовий стартує: ${COUNT} тунелів → ${TARGET}`);
for (let i = 0; i < COUNT; i++) startTunnel();
setInterval(() => {
  tick().catch((error) => log('помилка перевірки:', String(error).slice(0, 200)));
}, INTERVAL);

process.on('SIGTERM', () => {
  for (const { proc } of tunnels.values()) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
});
