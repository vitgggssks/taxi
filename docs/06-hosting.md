# Розгортання API: 4 варіанти

Демо-APK звертається до API за адресою, вшитою під час збірки
(`API_BASE_URL` + резервні `API_BASE_URL_FALLBACK`). Адресу можна змінити двома
способами:

1. **Без перезбирання (найшвидше):** екран входу → іконка сервера (⌁) →
   «Змінити адресу сервера» → вставити `https://…` → «Перевірити звʼязок».
   Адреса зберігається в застосунку й переживає перезапуск.
2. **Для всіх і назавжди:** змінна репозиторію `API_BASE_URL`
   (*Settings → Secrets and variables → Actions → Variables*) → запустити
   workflow **Android APK** → новий реліз.

Перевірка будь-якої адреси (дві команди, які завжди мають дати `200`):

```bash
curl -s https://<адреса>/api/health
curl -s -X POST https://<адреса>/api/demo-login -H 'content-type: application/json' \
     -d '{"role":"passenger"}' | head -c 120
```

---

## 1. VPS / будь-який сервер із Docker (рекомендовано для постійного хосту)

```bash
git clone https://github.com/vitgggssks/taxi && cd taxi
docker compose up -d            # api + postgres/redis/rabbit (цільовий стек ТЗ)
# або швидко, без Docker:
cd server && npm ci && npx tsx src/index.ts
```

Далі — домен і TLS (Caddy/Nginx або `cloudflared` із вашим доменом):

```bash
cloudflared tunnel login
cloudflared tunnel create rukh
cloudflared tunnel route dns rukh api.example.com
cloudflared tunnel run --url http://127.0.0.1:3000 rukh
```

**Named tunnel відрізняється від quick tunnel тим, що адреса постійна:**
`https://api.example.com` не змінюється й не вмирає разом із процесом.
Це саме те, що потрібно для стабільного демо.

## 2. Vercel (serverless, без сервера)

У репозиторії вже є готова збірка: `vercel.json` + `scripts/build-vercel.mjs` +
`server/src/vercel.ts` + `server/src/db/node-sqlite.mjs`.

```bash
npm install
npm run build:vercel      # → api/index.mjs (весь Fastify-API) + public/index.html
npx vercel link           # один раз
npx vercel --prod         # → https://<project>.vercel.app
```

Отриману адресу — у `API_BASE_URL`. Що треба знати про цей режим:

| Аспект | Поведінка |
| --- | --- |
| БД | `node:sqlite` у `/tmp` інстансу, схема інлайниться в бандл |
| Демо-дані | пересіваються на кожному холодному старті |
| Стан замовлень | живе в памʼяті інстансу; після зупинки скидається |
| Диспетчер | тік на кожному запиті (`server/src/vercel.ts`) — пропозиції/таймаути працюють |
| WebSocket | **недоступний** — пасажирський і водійський екрани оновлюються опитуванням |

Для справжнього продукту цей режим не підходить (немає постійної БД і WS) —
він саме для того, щоб демо мало **постійну адресу**.

## 3. Локально + quick tunnel (демо «тут і зараз»)

```bash
cd server && npx tsx src/index.ts                    # API на :3000
cloudflared tunnel --url http://127.0.0.1:3000       # → https://<random>.trycloudflare.com
```

> ⚠️ Quick tunnel **без гарантій аптайму**: адреса випадкова й живе, поки живий
> процес (при перепідключенні адреса зберігається, але після перезапуску — нова).
> Для захисту від коротких обривів APK містить до трьох адрес: `ApiClient`
> автоматично перемикається на резервну при мережевому збої або `5xx`.

Два-три тунелі одночасно:

```bash
cloudflared tunnel --url http://127.0.0.1:3000   # основний  → API_BASE_URL
cloudflared tunnel --url http://127.0.0.1:3000   # резервний  → API_BASE_URL_FALLBACK
cloudflared tunnel --url http://127.0.0.1:3000   # ще один    → через кому в тому ж FALLBACK
```

## 4. Телефон у тій самій Wi-Fi (без інтернету взагалі)

```bash
ip -4 addr | grep inet          # дізнайтесь IP компʼютера, напр. 192.168.1.50
```

У застосунку: ⌁ → «Змінити адресу сервера» → `http://192.168.1.50:3000`.
Сервер уже слухає `0.0.0.0`, а в Android-манифесті дозволено cleartext.

---

## Що робити, якщо в застосунку «Сервер недоступний»

1. Відкрийте `https://<адреса>/api/health` у браузері телефону. Немає `200` —
   проблема на хостингу, не в застосунку.
2. Перевірте, що процес API живий і тунель/домен веде саме на порт `3000`.
3. Введіть іншу адресу вручну на екрані входу — застосунок одразу перевірить
   звʼязок і покаже зелений статус.
4. Якщо змінили змінну `API_BASE_URL` — потрібен новий APK (адреса вшивається
   під час збірки); ручне введення в застосунку перезбирання не потребує.
