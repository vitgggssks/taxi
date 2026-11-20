#!/usr/bin/env node
/**
 * Вартовий демо-тунелів (кілька незалежних провайдерів).
 *
 * Проблема: безкоштовні тунелі періодично втрачають з'єднання, віддають 429/530,
 * а адреси вшиваються в APK під час збірки.
 *
 * Що робить вартовий:
 *   0) перед стартом перевіряє, що локальний API взагалі відповідає
 *      (найчастіша причина «крутить і нічого» — сервер не запущений, а тунель є);
 *   1) тримає тунелі Serveo (SSH) і, за потреби, Cloudflare/Pinggy — щоб збій
 *      одного провайдера не вбивав демо;
 *   2) кожні 8 с перевіряє кожен публічний URL через /api/health;
 *   3) у `endpoint.json` публікує ЛИШЕ адреси, які щойно відповіли 200 —
 *      мертві адреси в файл більше не потрапляють;
 *   4) після двох невдалих перевірок перезапускає тунель (нова адреса),
 *      з експоненційною паузою; на 429 (ліміт провайдера) — пауза 10 хв;
 *   5) публікує живий список адрес у `endpoint.json` (git commit + push) —
 *      застосунок читає його на старті, APK перезбирати не потрібно.
 *
 * Запуск:
 *   GITHUB_TOKEN=... node scripts/tunnel-watchdog.mjs
 *
 * Змінні: SERVEO_COUNT (2), CF_COUNT (0), PINGGY (0|1), WATCH_INTERVAL_MS (8000),
 *         TUNNEL_TARGET, REPO_DIR, GIT_BRANCH, DRY_RUN, API_PRECHECK (0|1).
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CLOUDFLARED = process.env.CLOUDFLARED ?? join(homedir(), '.cache/cloudflared');
const TARGET = process.env.TUNNEL_TARGET ?? 'http://127.0.0.1:3000';
const LOCAL_PORT = new URL(TARGET).port || '3000';
const SERVEO_COUNT = Number(process.env.SERVEO_COUNT ?? 2);
const CF_COUNT = Number(process.env.CF_COUNT ?? 0);
const USE_PINGGY = process.env.PINGGY === '1';
const INTERVAL = Number(process.env.WATCH_INTERVAL_MS ?? 8_000);
const PINGGY_MAX_AGE_MS = 50 * 60_000;
const MAX_BACKOFF_MS = 90_000;
const RATE_LIMIT_BACKOFF_MS = 10 * 60_000;
const REPO_DIR = process.env.REPO_DIR ?? join(homedir(), 'taxi');
const BRANCH = process.env.GIT_BRANCH ?? 'main';
const TOKEN = process.env.GITHUB_TOKEN ?? '';
const DRY_RUN = process.env.DRY_RUN === '1';

const URL_PATTERNS = [
  /https:\/\/[a-z0-9-]+\.serveousercontent\.com/,
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
  /https:\/\/[a-z0-9-]+\.run\.pinggy-free\.link/,
  /https:\/\/[a-z0-9-]+\.free\.pinggy\.net/,
];

/** url -> { proc, provider, failures, startedAt, healthy } */
const tunnels = new Map();
/** provider name -> { nextStartAt, delay } */
const backoff = new Map();
let published = '';

const log = (...args) => console.log(new Date().toISOString(), ...args);

const sshArgs = (extra) => [
  ...extra,
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'TCPKeepAlive=yes',
];

function providers() {
  const list = [];
  for (let i = 0; i < SERVEO_COUNT; i++) {
    list.push({
      name: `serveo#${i + 1}`,
      spawn: () =>
        spawn('ssh', [...sshArgs([]), '-R', `80:localhost:${LOCAL_PORT}`, 'serveo.net'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
    });
  }
  for (let i = 0; i < CF_COUNT; i++) {
    list.push({
      name: `cloudflare#${i + 1}`,
      spawn: () =>
        spawn(CLOUDFLARED, ['tunnel', '--url', TARGET, '--no-autoupdate'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
    });
  }
  if (USE_PINGGY) {
    list.push({
      name: 'pinggy',
      spawn: () =>
        spawn('ssh', [...sshArgs(['-p', '443']), '-R', `0:localhost:${LOCAL_PORT}`, 'a.pinggy.io'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
    });
  }
  return list;
}

const PROVIDERS = providers();

function startTunnel(provider) {
  const state = backoff.get(provider.name) ?? { nextStartAt: 0, delay: 3000 };
  backoff.set(provider.name, state);
  const proc = provider.spawn();
  let buffer = '';
  let rateLimited = false;

  const onData = (chunk) => {
    buffer += String(chunk);
    if (/\b429\b|rate.?limit/i.test(buffer)) rateLimited = true;
    for (const pattern of URL_PATTERNS) {
      const match = buffer.match(pattern);
      if (match && !tunnels.has(match[0])) {
        const url = match[0];
        tunnels.set(url, { proc, provider: provider.name, failures: 0, startedAt: Date.now(), healthy: false });
        log(`+ [${provider.name}] ${url} (перевіряю…)`);
        alive(url).then((ok) => {
          const entry = tunnels.get(url);
          if (!entry) return;
          entry.healthy = ok;
          if (ok) {
            state.delay = 3000; // провайдер ожив — скидаємо паузу
            log(`✓ [${provider.name}] ${url} відповідає`);
            publish();
          } else {
            log(`✗ [${provider.name}] ${url} не відповідає — у публікацію не піде`);
          }
        });
        return;
      }
    }
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code) => {
    for (const [url, entry] of [...tunnels]) {
      if (entry.proc === proc) {
        tunnels.delete(url);
        log(`- [${entry.provider}] ${url} (code ${code})`);
      }
    }
    if (rateLimited) {
      state.nextStartAt = Date.now() + RATE_LIMIT_BACKOFF_MS;
      log(`⏸ [${provider.name}] ліміт провайдера (429) — наступна спроба через 10 хв`);
    } else {
      state.nextStartAt = Date.now() + state.delay;
      state.delay = Math.min(state.delay * 2, MAX_BACKOFF_MS);
      log(`… [${provider.name}] перезапуск через ${Math.round(state.delay / 1000)} с`);
    }
    publish();
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

function writeEndpointFile(urls) {
  const file = join(REPO_DIR, 'endpoint.json');
  const data = {
    service: 'rukh-api',
    updatedAt: new Date().toISOString(),
    note:
      'Публічні адреси демо-API (перевірені на живу відповідь). Оновлюється ' +
      'scripts/tunnel-watchdog.mjs. Застосунок читає цей файл на старті й сам обирає ' +
      'живу адресу — APK перезбирати не потрібно.',
    endpoints: urls,
  };
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function publish() {
  const urls = [...tunnels.entries()].filter(([, e]) => e.healthy).map(([u]) => u).sort();
  if (!urls.length) return; // не затираємо файл, якщо живого поки немає
  const fingerprint = JSON.stringify(urls);
  if (fingerprint === published) return;
  published = fingerprint;

  writeEndpointFile(urls);
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
    log('публікація endpoint.json не вдалась:', String(error.message ?? error).slice(0, 160));
  }
}

async function tick() {
  for (const [url, entry] of [...tunnels]) {
    // профілактичний перезапуск Pinggy (безкоштовний тунель живе 60 хв)
    if (entry.provider === 'pinggy' && Date.now() - entry.startedAt > PINGGY_MAX_AGE_MS) {
      log(`↻ [pinggy] плановий перезапуск ${url}`);
      try {
        entry.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      tunnels.delete(url);
      continue;
    }
    const ok = await alive(url);
    if (ok) {
      if (!entry.healthy) log(`✓ ${url} відповідає`);
      entry.failures = 0;
      entry.healthy = true;
      continue;
    }
    entry.failures += 1;
    entry.healthy = false;
    log(`✗ ${url} не відповідає (${entry.failures}/2)`);
    if (entry.failures >= 2) {
      log(`↻ перезапуск ${url}`);
      try {
        entry.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      tunnels.delete(url);
      publish();
    }
  }
  for (const provider of PROVIDERS) {
    const active = [...tunnels.values()].filter((t) => t.provider === provider.name);
    const state = backoff.get(provider.name) ?? { nextStartAt: 0, delay: 3000 };
    backoff.set(provider.name, state);
    if (active.length === 0 && Date.now() >= state.nextStartAt) startTunnel(provider);
  }
  publish();
}

async function precheck() {
  if (process.env.API_PRECHECK === '0') return true;
  const ok = await alive(TARGET);
  if (!ok) {
    log(`✗ локальний API ${TARGET} не відповідає — тунелі публікувати немає сенсу`);
    log('  спочатку запустіть сервер: (cd server && npm start)');
    process.exit(2);
  }
  log(`✓ локальний API ${TARGET} відповідає`);
  return true;
}

if (CF_COUNT > 0 && !existsSync(CLOUDFLARED)) {
  log(`не знайдено cloudflared (${CLOUDFLARED}) — працюю без Cloudflare`);
}

await precheck();
log(`вартовий стартує: serveo×${SERVEO_COUNT}${CF_COUNT ? ` + cloudflare×${CF_COUNT}` : ''}${USE_PINGGY ? ' + pinggy' : ''} → ${TARGET}`);
for (const provider of PROVIDERS) startTunnel(provider);
setInterval(() => {
  tick().catch((error) => log('помилка перевірки:', String(error).slice(0, 160)));
}, INTERVAL);

const shutdown = () => {
  for (const { proc } of tunnels.values()) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
