# API — РУХ (v1)

Базовий URL: `/api`. Авторизація: `Authorization: Bearer <token>` (крім `/api/health`, `/api/auth/*`, `/api/cities`).

Формат помилок: `{ "error": { "code", "message", "details" } }`, коди: 400 (валідація), 401, 403, 409 (конфлікт стану), 422 (бізнес-правило), 404, 500.

Гроші — цілі числа в копійках (`*Cents`). Час — `YYYY-MM-DD HH:MM:SS` (UTC).


## Авторизація та профіль

| Метод | Шлях |
|---|---|
| `POST` | `/api/auth/request-otp` |
| `POST` | `/api/auth/verify-otp` |
| `POST` | `/api/auth/demo-login` |
| `POST` | `/api/auth/logout` |
| `GET` | `/api/me` |
| `PATCH` | `/api/me` |
| `POST` | `/api/me/device-token` |
| `GET` | `/api/me/notifications` |
| `POST` | `/api/me/notifications/:id/read` |
| `GET` | `/api/me/addresses` |
| `POST` | `/api/me/addresses` |
| `DELETE` | `/api/me/addresses/:id` |
| `POST` | `/api/admin/users/:id/role` |

## Міста, адреси, гаманець

| Метод | Шлях |
|---|---|
| `GET` | `/api/cities` |
| `GET` | `/api/cities/nearest` |
| `GET` | `/api/geo/search` |
| `GET` | `/api/geo/reverse` |
| `GET` | `/api/geo/zones` |
| `GET` | `/api/wallet` |
| `POST` | `/api/wallet/topup` |
| `POST` | `/api/wallet/withdraw` |

## Замовлення, ціни, доставка

| Метод | Шлях |
|---|---|
| `GET` | `/api/catalog` |
| `POST` | `/api/orders/quote` |
| `POST` | `/api/promo/validate` |
| `POST` | `/api/orders` |
| `GET` | `/api/orders` |
| `GET` | `/api/orders/:id` |
| `GET` | `/api/orders/:id/track` |
| `POST` | `/api/orders/:id/cancel` |
| `POST` | `/api/orders/:id/rate` |
| `POST` | `/api/orders/:id/repeat` |
| `POST` | `/api/orders/:id/plus-minus` |
| `POST` | `/api/orders/:id/route-change` |
| `POST` | `/api/orders/:id/route-change/:changeId/decide` |
| `POST` | `/api/orders/:id/pay` |
| `POST` | `/api/orders/:id/delivery/pickup` |
| `POST` | `/api/orders/:id/delivery/dropoff` |
| `POST` | `/api/internal/orders/:id/assign` |

## Застосунок водія, модерація

| Метод | Шлях |
|---|---|
| `POST` | `/api/driver/register` |
| `GET` | `/api/driver/me` |
| `POST` | `/api/driver/documents` |
| `POST` | `/api/driver/online` |
| `POST` | `/api/driver/offline` |
| `PATCH` | `/api/driver/settings` |
| `POST` | `/api/driver/location` |
| `GET` | `/api/driver/offers` |
| `POST` | `/api/driver/offers/:id/accept` |
| `POST` | `/api/driver/offers/:id/decline` |
| `POST` | `/api/driver/orders/:id/status` |
| `GET` | `/api/driver/orders/active` |
| `GET` | `/api/driver/earnings` |
| `GET` | `/api/driver/transactions` |
| `POST` | `/api/driver/payout` |
| `GET` | `/api/driver/stats` |
| `GET` | `/api/driver/reviews` |
| `GET` | `/api/admin/drivers/pending` |
| `POST` | `/api/admin/drivers/:id/verify` |
| `POST` | `/api/admin/drivers/:id/block` |

## Адмінпанель

| Метод | Шлях |
|---|---|
| `GET` | `/api/admin/dashboard` |
| `GET` | `/api/admin/live-map` |
| `GET` | `/api/admin/users` |
| `POST` | `/api/admin/users/:id/block` |
| `GET` | `/api/admin/orders` |
| `POST` | `/api/admin/orders/:id/cancel` |
| `POST` | `/api/admin/orders/:id/reassign` |
| `POST` | `/api/admin/orders/:id/refund` |
| `GET` | `/api/admin/payments` |
| `GET` | `/api/admin/tariffs` |
| `PATCH` | `/api/admin/tariffs/:id` |
| `POST` | `/api/admin/tariffs` |
| `GET` | `/api/admin/classes` |
| `PATCH` | `/api/admin/classes/:id` |
| `POST` | `/api/admin/classes` |
| `GET` | `/api/admin/options` |
| `POST` | `/api/admin/options` |
| `PATCH` | `/api/admin/options/:id` |
| `GET` | `/api/admin/cities` |
| `POST` | `/api/admin/cities` |
| `PATCH` | `/api/admin/cities/:id` |
| `GET` | `/api/admin/zones` |
| `POST` | `/api/admin/zones` |
| `DELETE` | `/api/admin/zones/:id` |
| `GET` | `/api/admin/promos` |
| `POST` | `/api/admin/promos` |
| `PATCH` | `/api/admin/promos/:code` |
| `GET` | `/api/admin/reviews` |
| `DELETE` | `/api/admin/reviews/:id` |
| `GET` | `/api/admin/quests` |
| `POST` | `/api/admin/quests` |
| `GET` | `/api/admin/settings` |
| `PATCH` | `/api/admin/settings` |
| `PATCH` | `/api/admin/dispatch/:cityId` |
| `GET` | `/api/admin/audit` |
| `GET` | `/api/admin/reports/orders.csv` |
| `GET` | `/api/admin/reports/finance.csv` |
| `GET` | `/api/admin/companies` |
| `POST` | `/api/admin/companies` |
| `GET` | `/api/admin/settlements` |

## Корпоратив і підтримка

| Метод | Шлях |
|---|---|
| `GET` | `/api/corporate/me` |
| `POST` | `/api/corporate/members/invite` |
| `POST` | `/api/corporate/join` |
| `PATCH` | `/api/corporate/members/:id` |
| `GET` | `/api/corporate/reports` |
| `POST` | `/api/support/tickets` |
| `GET` | `/api/support/tickets` |
| `GET` | `/api/support/tickets/:id` |
| `POST` | `/api/support/tickets/:id/messages` |
| `GET` | `/api/admin/support/tickets` |
| `PATCH` | `/api/admin/support/tickets/:id` |


## WebSocket `/ws?token=…`

Клієнт автоматично підписаний на `user:<id>` і `role:<role>`; для замовлення надсилає
`{"type":"subscribe","channel":"order:<orderId>"}` (сервер перевіряє права).

| Подія | Кому | Опис |
|---|---|---|
| `connected` | всім | підтвердження з'єднання |
| `order.updated` | учасники замовлення, dispatch | повний проєкт замовлення після зміни статусу |
| `order.assigned` | пасажир, водій | водія призначено (включно з авто-прийняттям) |
| `offer.new` | водій | нова пропозиція з таймером |
| `offer.expired` | водій | час на прийняття минув |
| `driver.location` | пасажир цього замовлення, dispatch | GPS-точка водія |
| `notification` | користувач | сповіщення (дублюється в `/api/me/notifications`) |
| `wallet.updated` | користувач | новий баланс після транзакції |

## Сценарій повного замовлення (послідовність викликів)

1. `POST /api/auth/request-otp` → `POST /api/auth/verify-otp` → `token`
2. `GET /api/cities` → `GET /api/catalog?cityId=…` (класи, опції, сервіси)
3. `POST /api/orders/quote` (кожен клас / конкретний `classId`) → фіксована ціна
4. `POST /api/orders` → замовлення + автоматична диспетчеризація
5. водій: `GET /api/driver/offers` → `POST /api/driver/offers/:id/accept`
6. водій: `POST /api/driver/orders/:id/status` (`driver_arriving` → `waiting` → `in_progress` → `completed`)
7. сервер: `chargeOrder()` + `settleOrder()` (комісія, заробіток, кешбек)
8. пасажир: `POST /api/orders/:id/rate`

## Файли

| Метод | Шлях | Опис |
| --- | --- | --- |
| POST | `/api/uploads` | завантаження файлу: `{ dataUrl }` (base64 або data URL) → `{ url, mime, size }`. Ліміт 3 МБ, типи визначаються за магічними байтами: PNG, JPEG, WEBP, PDF |
| GET | `/uploads/<name>` | віддача файлу (immutable cache), захист від `..` |

Файл використовується як `photoUrl` у `POST /api/orders/:id/delivery/dropoff`
(фото вручення посилки) і як `fileUrl` у `POST /api/driver/documents`
(посвідчення, техпаспорт, фото авто, ID-картка, страховка).
