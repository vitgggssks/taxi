-- ============================================================================
-- RUKH platform — reference relational schema.
-- This file is the portable (SQLite) form of docs/03-data-model.sql (PostgreSQL
-- + PostGIS). Every table/column maps 1:1; geometry columns are stored here as
-- plain lat/lng floats and polygon JSON, and the geo helper layer
-- (src/lib/geo.ts) implements the same functions used by PostGIS.
-- ============================================================================
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity --
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  role          TEXT NOT NULL DEFAULT 'passenger', -- passenger|driver|dispatcher|admin|corporate_admin
  phone         TEXT NOT NULL UNIQUE,
  name          TEXT,
  email         TEXT,
  photo_url     TEXT,
  locale        TEXT NOT NULL DEFAULT 'uk',
  city_id       TEXT REFERENCES cities(id),
  corporate_id  TEXT REFERENCES companies(id),
  status        TEXT NOT NULL DEFAULT 'active',    -- active|blocked
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id         TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,
  code       TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'login',        -- login|phone_change|order_confirm
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

-- -------------------------------------------------------------------- geo ---
CREATE TABLE IF NOT EXISTS cities (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  region     TEXT,
  country    TEXT NOT NULL DEFAULT 'UA',
  currency   TEXT NOT NULL DEFAULT 'UAH',
  timezone   TEXT NOT NULL DEFAULT 'Europe/Kyiv',
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  settings   TEXT NOT NULL DEFAULT '{}'            -- per-city overrides (JSON)
);

CREATE TABLE IF NOT EXISTS zones (
  id           TEXT PRIMARY KEY,
  city_id      TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'tariff',     -- tariff|surge|service_area
  polygon_json TEXT NOT NULL,                      -- [[lat,lng],...]
  multiplier   REAL NOT NULL DEFAULT 1.0,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS addresses (
  id      TEXT PRIMARY KEY,
  city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  label   TEXT NOT NULL,
  street  TEXT,
  house   TEXT,
  lat     REAL NOT NULL,
  lng     REAL NOT NULL,
  kind    TEXT DEFAULT 'street'                    -- street|poi|airport|station
);

CREATE TABLE IF NOT EXISTS saved_addresses (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label   TEXT NOT NULL,
  address TEXT NOT NULL,
  lat     REAL NOT NULL,
  lng     REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------------------- catalogue ---
CREATE TABLE IF NOT EXISTS car_classes (
  id        TEXT PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,                  -- economy|standard|comfort|business|wagon|minivan|kids
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'ride',          -- ride|delivery|service
  seats     INTEGER NOT NULL DEFAULT 4,
  luggage   INTEGER NOT NULL DEFAULT 2,
  sort      INTEGER NOT NULL DEFAULT 100,
  active    INTEGER NOT NULL DEFAULT 1,
  icon      TEXT
);

CREATE TABLE IF NOT EXISTS order_options (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,                -- child_seat|pet|baggage|sober_driver|quiet_ride
  name        TEXT NOT NULL,
  description TEXT,
  kind        TEXT NOT NULL DEFAULT 'option',      -- option|service
  price_cents INTEGER NOT NULL DEFAULT 0,
  class_scope TEXT,                                -- CSV of class codes, NULL = all
  max_qty     INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tariffs (
  id                    TEXT PRIMARY KEY,
  city_id               TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  class_id              TEXT NOT NULL REFERENCES car_classes(id) ON DELETE CASCADE,
  base_cents            INTEGER NOT NULL,
  per_km_cents          INTEGER NOT NULL,
  per_min_cents         INTEGER NOT NULL,
  min_fare_cents        INTEGER NOT NULL,
  per_stop_cents        INTEGER NOT NULL DEFAULT 0,
  waiting_per_min_cents INTEGER NOT NULL DEFAULT 0,
  cancel_fee_cents      INTEGER NOT NULL DEFAULT 0,
  intercity_per_km_cents INTEGER,
  night_multiplier      REAL NOT NULL DEFAULT 1.0,
  night_from            INTEGER NOT NULL DEFAULT 22,   -- hour of day
  night_to              INTEGER NOT NULL DEFAULT 6,
  city_multiplier       REAL NOT NULL DEFAULT 1.0,
  commission_pct        REAL NOT NULL DEFAULT 15.0,
  currency              TEXT NOT NULL DEFAULT 'UAH',
  version               INTEGER NOT NULL DEFAULT 1,
  active                INTEGER NOT NULL DEFAULT 1,
  UNIQUE (city_id, class_id, version)
);

-- ----------------------------------------------------------------- drivers --
CREATE TABLE IF NOT EXISTS driver_profiles (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  city_id           TEXT NOT NULL REFERENCES cities(id),
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending|verified|rejected|suspended
  work_status       TEXT NOT NULL DEFAULT 'offline',  -- offline|online|busy
  auto_accept       INTEGER NOT NULL DEFAULT 0,
  accept_radius_km  REAL NOT NULL DEFAULT 5,
  min_price_cents   INTEGER NOT NULL DEFAULT 0,
  classes_csv       TEXT NOT NULL DEFAULT '',
  lat               REAL,
  lng               REAL,
  location_at       TEXT,
  rating            REAL NOT NULL DEFAULT 5.0,
  rating_count      INTEGER NOT NULL DEFAULT 0,
  offers_total      INTEGER NOT NULL DEFAULT 0,
  offers_accepted   INTEGER NOT NULL DEFAULT 0,
  orders_completed  INTEGER NOT NULL DEFAULT 0,
  orders_canceled   INTEGER NOT NULL DEFAULT 0,
  balance_cents     INTEGER NOT NULL DEFAULT 0,
  commission_pct    REAL NOT NULL DEFAULT 15.0,
  verified_at       TEXT,
  rejection_reason  TEXT
);

CREATE TABLE IF NOT EXISTS driver_documents (
  id          TEXT PRIMARY KEY,
  driver_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                        -- license|vehicle_registration|vehicle_photo|id_card|insurance
  file_url    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',      -- pending|approved|rejected
  comment     TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicles (
  id         TEXT PRIMARY KEY,
  driver_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id   TEXT NOT NULL REFERENCES car_classes(id),
  make       TEXT NOT NULL,
  model      TEXT NOT NULL,
  year       INTEGER,
  color      TEXT,
  plate      TEXT NOT NULL,
  photo_url  TEXT,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS driver_locations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_driver_loc ON driver_locations(driver_id, at DESC);

-- ----------------------------------------------------------------- orders ---
CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  number             TEXT NOT NULL UNIQUE,
  passenger_id       TEXT NOT NULL REFERENCES users(id),
  city_id            TEXT NOT NULL REFERENCES cities(id),
  class_id           TEXT NOT NULL REFERENCES car_classes(id),
  service_kind       TEXT NOT NULL DEFAULT 'ride',   -- ride|delivery|sober|intercity
  status             TEXT NOT NULL DEFAULT 'searching',
  -- searching|offered|assigned|driver_arriving|waiting|in_progress|completed|canceled|expired|no_drivers
  payment_method     TEXT NOT NULL DEFAULT 'cash',   -- cash|card|apple_pay|google_pay|wallet|corporate
  payment_status     TEXT NOT NULL DEFAULT 'pending',-- pending|authorized|paid|refunded|failed
  quoted_price_cents INTEGER NOT NULL,
  final_price_cents  INTEGER,
  plus_minus_cents   INTEGER NOT NULL DEFAULT 0,
  discount_cents     INTEGER NOT NULL DEFAULT 0,
  bonus_used_cents   INTEGER NOT NULL DEFAULT 0,
  cashback_cents     INTEGER NOT NULL DEFAULT 0,
  commission_cents   INTEGER,
  currency           TEXT NOT NULL DEFAULT 'UAH',
  promo_code         TEXT,
  distance_m         INTEGER NOT NULL DEFAULT 0,
  duration_s         INTEGER NOT NULL DEFAULT 0,
  pickup_eta_s       INTEGER NOT NULL DEFAULT 0,
  comment            TEXT,
  options_json       TEXT NOT NULL DEFAULT '[]',
  for_other_json     TEXT,
  corporate_id       TEXT REFERENCES companies(id),
  scheduled_at       TEXT,
  driver_id          TEXT REFERENCES users(id),
  vehicle_id         TEXT REFERENCES vehicles(id),
  assigned_by        TEXT,                            -- dispatch|driver|admin
  cancel_reason      TEXT,
  rating             INTEGER,
  review_text        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at        TEXT,
  arrived_at         TEXT,
  started_at         TEXT,
  finished_at        TEXT,
  canceled_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_passenger ON orders(passenger_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);

CREATE TABLE IF NOT EXISTS order_points (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,                       -- pickup|stop|dropoff
  address       TEXT NOT NULL,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  note          TEXT,
  contact_name  TEXT,
  contact_phone TEXT,
  UNIQUE (order_id, seq)
);

CREATE TABLE IF NOT EXISTS order_offers (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  driver_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'offered', -- offered|accepted|declined|expired|superseded|revoked
  price_cents         INTEGER NOT NULL,
  distance_to_pickup_m INTEGER,
  eta_to_pickup_s     INTEGER,
  round               INTEGER NOT NULL DEFAULT 1,
  expires_at          TEXT NOT NULL,
  responded_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
-- hard guarantee: an order can never be accepted by two drivers simultaneously
CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_accepted
  ON order_offers(order_id) WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_offers_driver ON order_offers(driver_id, status);

CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  actor_id   TEXT,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS route_changes (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,                        -- passenger|driver|admin
  points_json  TEXT NOT NULL,
  price_delta_cents INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',      -- pending|approved|rejected
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT
);

-- ---------------------------------------------------------------- delivery --
CREATE TABLE IF NOT EXISTS deliveries (
  order_id        TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  sender_name     TEXT NOT NULL,
  sender_phone    TEXT NOT NULL,
  recipient_name  TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  weight_kg       REAL NOT NULL,
  declared_value_cents INTEGER NOT NULL DEFAULT 0,
  description     TEXT,
  instructions    TEXT,
  pickup_code     TEXT NOT NULL,
  dropoff_code    TEXT NOT NULL,
  photo_proof_url TEXT,
  picked_up_at    TEXT,
  delivered_at    TEXT
);

-- ---------------------------------------------------------------- payments --
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account        TEXT NOT NULL DEFAULT 'main',       -- main|bonus|corporate
  kind           TEXT NOT NULL,                      -- topup|ride_payment|driver_earning|commission|refund|bonus|cashback|payout|adjustment
  amount_cents   INTEGER NOT NULL,                   -- signed
  currency       TEXT NOT NULL DEFAULT 'UAH',
  order_id       TEXT REFERENCES orders(id),
  idempotency_key TEXT UNIQUE,
  balance_after_cents INTEGER NOT NULL,
  meta           TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'settled',    -- pending|settled|failed|reversed
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_methods (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                          -- card|apple_pay|google_pay
  brand      TEXT,
  last4      TEXT,
  token      TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id),
  method          TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|captured|failed|refunded
  idempotency_key TEXT UNIQUE,
  gateway_ref     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_codes (
  code               TEXT PRIMARY KEY,
  kind               TEXT NOT NULL DEFAULT 'percent', -- percent|fixed|free_ride
  value              INTEGER NOT NULL,                -- percent (1-100) or cents
  min_fare_cents     INTEGER NOT NULL DEFAULT 0,
  max_discount_cents INTEGER,
  city_id            TEXT REFERENCES cities(id),
  class_scope        TEXT,
  usage_limit        INTEGER,
  per_user_limit     INTEGER NOT NULL DEFAULT 1,
  used_count         INTEGER NOT NULL DEFAULT 0,
  valid_from         TEXT,
  valid_to           TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL REFERENCES promo_codes(code),
  user_id        TEXT NOT NULL REFERENCES users(id),
  order_id       TEXT REFERENCES orders(id),
  discount_cents INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (code, user_id, order_id)
);

-- --------------------------------------------------------------- corporate --
CREATE TABLE IF NOT EXISTS companies (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  edrpou            TEXT,
  city_id           TEXT REFERENCES cities(id),
  discount_pct      REAL NOT NULL DEFAULT 0,
  credit_limit_cents INTEGER NOT NULL DEFAULT 0,
  invoice_email     TEXT,
  status            TEXT NOT NULL DEFAULT 'active',   -- active|suspended
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS corporate_members (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id             TEXT REFERENCES users(id),
  phone               TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'employee', -- admin|employee
  monthly_limit_cents INTEGER NOT NULL DEFAULT 0,
  spent_cents         INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'invited', -- invited|active|blocked
  invite_token        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS corporate_invoices (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period       TEXT NOT NULL,                          -- YYYY-MM
  total_cents  INTEGER NOT NULL DEFAULT 0,
  orders_count INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'open',           -- open|paid
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, period)
);

-- -------------------------------------------------- support / reviews / etc --
CREATE TABLE IF NOT EXISTS quests (
  id            TEXT PRIMARY KEY,
  city_id       TEXT REFERENCES cities(id),
  title         TEXT NOT NULL,
  description   TEXT,
  target_orders INTEGER NOT NULL,
  bonus_cents   INTEGER NOT NULL,
  valid_from    TEXT,
  valid_to      TEXT,
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id   TEXT REFERENCES orders(id),
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',             -- open|pending|closed
  priority   TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS support_messages (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id  TEXT,
  author_role TEXT NOT NULL DEFAULT 'user',            -- user|agent|system
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  driver_id    TEXT NOT NULL REFERENCES users(id),
  passenger_id TEXT NOT NULL REFERENCES users(id),
  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  tags         TEXT NOT NULL DEFAULT '[]',
  text         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL DEFAULT '{}',
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  platform   TEXT NOT NULL DEFAULT 'android',          -- android|ios|web
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------------------- platform ---
CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   TEXT,
  actor_role TEXT,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  payload    TEXT NOT NULL DEFAULT '{}',
  city_id    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dispatch_settings (
  city_id            TEXT PRIMARY KEY REFERENCES cities(id),
  offer_timeout_s    INTEGER NOT NULL DEFAULT 20,
  offer_rounds       INTEGER NOT NULL DEFAULT 3,
  search_radius_km   REAL NOT NULL DEFAULT 7,
  max_active_orders  INTEGER NOT NULL DEFAULT 5,
  parallel_offers    INTEGER NOT NULL DEFAULT 3,
  auto_accept_max_distance_km REAL NOT NULL DEFAULT 4
);
