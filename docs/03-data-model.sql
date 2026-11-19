-- ============================================================================
-- РУХ — цільова схема PostgreSQL 16 + PostGIS 3.
-- Це продакшн-форма референсної схеми server/src/schema.sql (SQLite).
-- Відмінності: geography(Point,4326) замість lat/lng-пар, timestamptz,
-- numeric для коефіцієнтів, ENUM-подібні CHECK, партиціювання «гарячих» таблиць.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE user_role AS ENUM ('passenger','driver','dispatcher','admin','corporate_admin');
CREATE TYPE order_status AS ENUM ('searching','offered','assigned','driver_arriving','waiting',
                                  'in_progress','completed','canceled','expired','no_drivers');
CREATE TYPE payment_method AS ENUM ('cash','card','apple_pay','google_pay','wallet','corporate');
CREATE TYPE payment_status AS ENUM ('pending','authorized','paid','refunded','failed');
CREATE TYPE driver_status AS ENUM ('pending','verified','rejected','suspended');
CREATE TYPE work_status AS ENUM ('offline','online','busy');
CREATE TYPE service_kind AS ENUM ('ride','delivery','sober','intercity');

-- ---------------------------------------------------------------- довідники --
CREATE TABLE cities (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         text NOT NULL,
  region       text,
  country      char(2) NOT NULL DEFAULT 'UA',
  currency     char(3) NOT NULL DEFAULT 'UAH',
  timezone     text NOT NULL DEFAULT 'Europe/Kyiv',
  center       geography(Point,4326) NOT NULL,
  area         geography(Polygon,4326),          -- зона обслуговування
  active       boolean NOT NULL DEFAULT true,
  settings     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE car_classes (
  id      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  code    text NOT NULL UNIQUE,
  name    text NOT NULL,
  kind    text NOT NULL DEFAULT 'ride' CHECK (kind IN ('ride','delivery','service')),
  seats   int  NOT NULL DEFAULT 4,
  luggage int  NOT NULL DEFAULT 2,
  sort    int  NOT NULL DEFAULT 100,
  icon    text,
  active  boolean NOT NULL DEFAULT true
);

CREATE TABLE order_options (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  kind        text NOT NULL DEFAULT 'option',
  price_cents int  NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  class_scope text[],
  max_qty     int  NOT NULL DEFAULT 1,
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE tariffs (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  city_id                uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  class_id               uuid NOT NULL REFERENCES car_classes(id) ON DELETE CASCADE,
  base_cents             int  NOT NULL CHECK (base_cents >= 0),
  per_km_cents           int  NOT NULL,
  per_min_cents          int  NOT NULL,
  min_fare_cents         int  NOT NULL,
  per_stop_cents         int  NOT NULL DEFAULT 0,
  waiting_per_min_cents  int  NOT NULL DEFAULT 0,
  cancel_fee_cents       int  NOT NULL DEFAULT 0,
  intercity_per_km_cents int,
  night_multiplier       numeric(4,2) NOT NULL DEFAULT 1,
  night_from             int NOT NULL DEFAULT 22,
  night_to               int NOT NULL DEFAULT 6,
  city_multiplier        numeric(4,2) NOT NULL DEFAULT 1,
  commission_pct         numeric(5,2) NOT NULL DEFAULT 15,
  currency               char(3) NOT NULL DEFAULT 'UAH',
  version                int NOT NULL DEFAULT 1,
  active                 boolean NOT NULL DEFAULT true,
  UNIQUE (city_id, class_id, version)
);

-- --------------------------------------------------------------- користувачі --
CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  role         user_role NOT NULL DEFAULT 'passenger',
  phone        text NOT NULL UNIQUE,
  name         text,
  email        text,
  photo_url    text,
  locale       text NOT NULL DEFAULT 'uk',
  city_id      uuid REFERENCES cities(id),
  corporate_id uuid,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_phone_trgm ON users USING gin (phone gin_trgm_ops);

CREATE TABLE otp_codes (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone       text NOT NULL,
  code        text NOT NULL,
  purpose     text NOT NULL DEFAULT 'login',
  attempts    int NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_phone_idx ON otp_codes (phone, created_at DESC);

CREATE TABLE sessions (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- -------------------------------------------------------------- водії й авто --
CREATE TABLE driver_profiles (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  city_id          uuid NOT NULL REFERENCES cities(id),
  status           driver_status NOT NULL DEFAULT 'pending',
  work_status      work_status NOT NULL DEFAULT 'offline',
  auto_accept      boolean NOT NULL DEFAULT false,
  accept_radius_km numeric(5,2) NOT NULL DEFAULT 5,
  min_price_cents  int NOT NULL DEFAULT 0,
  classes_csv      text NOT NULL DEFAULT '',
  location         geography(Point,4326),
  location_at      timestamptz,
  rating           numeric(3,2) NOT NULL DEFAULT 5.0,
  rating_count     int NOT NULL DEFAULT 0,
  offers_total     int NOT NULL DEFAULT 0,
  offers_accepted  int NOT NULL DEFAULT 0,
  orders_completed int NOT NULL DEFAULT 0,
  orders_canceled  int NOT NULL DEFAULT 0,
  balance_cents    bigint NOT NULL DEFAULT 0,
  commission_pct   numeric(5,2) NOT NULL DEFAULT 15,
  verified_at      timestamptz,
  rejection_reason text
);
-- головний індекс диспетчера: «хто на лінії в цьому місті»
CREATE INDEX driver_online_gist ON driver_profiles USING gist (location)
  WHERE work_status IN ('online','busy') AND status = 'verified';

CREATE TABLE vehicles (
  id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id  uuid NOT NULL REFERENCES car_classes(id),
  make      text NOT NULL, model text NOT NULL, year int, color text,
  plate     text NOT NULL, photo_url text,
  active    boolean NOT NULL DEFAULT true
);

CREATE TABLE driver_documents (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  file_url    text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  comment     text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE driver_locations (
  id        bigserial PRIMARY KEY,
  driver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  point     geography(Point,4326) NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (at);

-- --------------------------------------------------------------- замовлення --
CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  number             text NOT NULL UNIQUE,
  passenger_id       uuid NOT NULL REFERENCES users(id),
  city_id            uuid NOT NULL REFERENCES cities(id),
  class_id           uuid NOT NULL REFERENCES car_classes(id),
  service_kind       service_kind NOT NULL DEFAULT 'ride',
  status             order_status NOT NULL DEFAULT 'searching',
  payment_method     payment_method NOT NULL DEFAULT 'cash',
  payment_status     payment_status NOT NULL DEFAULT 'pending',
  quoted_price_cents int NOT NULL,
  final_price_cents  int,
  plus_minus_cents   int NOT NULL DEFAULT 0,
  discount_cents     int NOT NULL DEFAULT 0,
  bonus_used_cents   int NOT NULL DEFAULT 0,
  cashback_cents     int NOT NULL DEFAULT 0,
  commission_cents   int,
  currency           char(3) NOT NULL DEFAULT 'UAH',
  promo_code         text,
  distance_m         int NOT NULL DEFAULT 0,
  duration_s         int NOT NULL DEFAULT 0,
  pickup_eta_s       int NOT NULL DEFAULT 0,
  comment            text,
  options            text[] NOT NULL DEFAULT '{}',
  for_other          jsonb,
  corporate_id       uuid,
  scheduled_at       timestamptz,
  driver_id          uuid REFERENCES users(id),
  vehicle_id         uuid REFERENCES vehicles(id),
  assigned_by        text,
  cancel_reason      text,
  rating             int CHECK (rating BETWEEN 1 AND 5),
  review_text        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  accepted_at        timestamptz,
  arrived_at         timestamptz,
  started_at         timestamptz,
  finished_at        timestamptz,
  canceled_at        timestamptz,
  CHECK (final_price_cents IS NULL OR final_price_cents >= 0)
);
CREATE INDEX orders_passenger_idx ON orders (passenger_id, created_at DESC);
CREATE INDEX orders_driver_idx    ON orders (driver_id, created_at DESC);
CREATE INDEX orders_active_idx    ON orders (status, created_at)
  WHERE status NOT IN ('completed','canceled','expired');

CREATE TABLE order_points (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq           int NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('pickup','stop','dropoff')),
  address       text NOT NULL,
  point         geography(Point,4326) NOT NULL,
  note          text,
  contact_name  text,
  contact_phone text,
  UNIQUE (order_id, seq),
  CHECK (seq BETWEEN 0 AND 6)      -- максимум 5 проміжних зупинок
);

CREATE TABLE order_offers (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id             uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  driver_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'offered'
                        CHECK (status IN ('offered','accepted','declined','expired','superseded','revoked')),
  price_cents          int NOT NULL,
  distance_to_pickup_m int,
  eta_to_pickup_s      int,
  round                int NOT NULL DEFAULT 1,
  expires_at           timestamptz NOT NULL,
  responded_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- жорстка гарантія «одне замовлення — один водій»
CREATE UNIQUE INDEX uniq_order_accepted ON order_offers (order_id) WHERE status = 'accepted';
CREATE INDEX offers_driver_idx ON order_offers (driver_id, status);

CREATE TABLE order_events (
  id         bigserial PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type       text NOT NULL,
  actor_id   uuid,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_idx ON order_events (order_id, created_at);

CREATE TABLE route_changes (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  requested_by      text NOT NULL,
  points            jsonb NOT NULL,
  price_delta_cents int NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending',
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz
);

CREATE TABLE deliveries (
  order_id             uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  sender_name          text NOT NULL, sender_phone     text NOT NULL,
  recipient_name       text NOT NULL, recipient_phone  text NOT NULL,
  weight_kg            numeric(5,2) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 20),
  declared_value_cents int NOT NULL DEFAULT 0,
  description          text, instructions text,
  pickup_code          text NOT NULL, dropoff_code text NOT NULL,
  photo_proof_url      text,
  picked_up_at         timestamptz, delivered_at timestamptz
);

-- ----------------------------------------------------------------- гроші ----
CREATE TABLE wallet_transactions (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account             text NOT NULL DEFAULT 'main' CHECK (account IN ('main','bonus','corporate')),
  kind                text NOT NULL,
  amount_cents        bigint NOT NULL,
  currency            char(3) NOT NULL DEFAULT 'UAH',
  order_id            uuid REFERENCES orders(id),
  idempotency_key     text UNIQUE,
  balance_after_cents bigint NOT NULL,
  meta                jsonb NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'settled',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_user_idx ON wallet_transactions (user_id, created_at DESC);

CREATE TABLE payment_intents (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  method          payment_method NOT NULL,
  amount_cents    int NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  idempotency_key text UNIQUE,
  gateway_ref     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE promo_codes (
  code               text PRIMARY KEY,
  kind               text NOT NULL DEFAULT 'percent',
  value              int NOT NULL,
  min_fare_cents     int NOT NULL DEFAULT 0,
  max_discount_cents int,
  city_id            uuid REFERENCES cities(id),
  class_scope        text[],
  usage_limit        int,
  per_user_limit     int NOT NULL DEFAULT 1,
  used_count         int NOT NULL DEFAULT 0,
  valid_from         date, valid_to date,
  active             boolean NOT NULL DEFAULT true
);

CREATE TABLE promo_redemptions (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  code           text NOT NULL REFERENCES promo_codes(code),
  user_id        uuid NOT NULL REFERENCES users(id),
  order_id       uuid REFERENCES orders(id),
  discount_cents int NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, user_id, order_id)
);

-- ------------------------------------------------------------- корпоратив ---
CREATE TABLE companies (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name               text NOT NULL, edrpou text,
  city_id            uuid REFERENCES cities(id),
  discount_pct       numeric(5,2) NOT NULL DEFAULT 0,
  credit_limit_cents bigint NOT NULL DEFAULT 0,
  invoice_email      text,
  status             text NOT NULL DEFAULT 'active',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE corporate_members (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES users(id),
  phone               text NOT NULL,
  role                text NOT NULL DEFAULT 'employee',
  monthly_limit_cents bigint NOT NULL DEFAULT 0,
  spent_cents         bigint NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'invited',
  invite_token        text UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE corporate_invoices (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period       char(7) NOT NULL,
  total_cents  bigint NOT NULL DEFAULT 0,
  orders_count int NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'open',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, period)
);

-- ------------------------------------------- підтримка, відгуки, платформа ---
CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id),
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'normal',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_messages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id uuid, author_role text NOT NULL DEFAULT 'user',
  body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES users(id),
  passenger_id uuid NOT NULL REFERENCES users(id),
  rating int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  tags text[] NOT NULL DEFAULT '{}',
  text text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL, title text NOT NULL, body text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}', read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  platform text NOT NULL DEFAULT 'android',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quests (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  city_id uuid REFERENCES cities(id),
  title text NOT NULL, description text,
  target_orders int NOT NULL, bonus_cents int NOT NULL,
  valid_from date, valid_to date, active boolean NOT NULL DEFAULT true
);

CREATE TABLE zones (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  city_id    uuid NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'tariff',
  area       geography(Polygon,4326) NOT NULL,
  multiplier numeric(4,2) NOT NULL DEFAULT 1,
  active     boolean NOT NULL DEFAULT true
);
CREATE INDEX zones_area_gist ON zones USING gist (area);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_id uuid, actor_role text,
  action text NOT NULL, entity text NOT NULL, entity_id text,
  payload jsonb NOT NULL DEFAULT '{}',
  city_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_logs (created_at DESC);

CREATE TABLE settings (
  key text PRIMARY KEY, value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dispatch_settings (
  city_id uuid PRIMARY KEY REFERENCES cities(id) ON DELETE CASCADE,
  offer_timeout_s int NOT NULL DEFAULT 20,
  offer_rounds int NOT NULL DEFAULT 3,
  search_radius_km numeric(5,2) NOT NULL DEFAULT 7,
  max_active_orders int NOT NULL DEFAULT 5,
  auto_accept_max_distance_km numeric(5,2) NOT NULL DEFAULT 4,
  parallel_offers int NOT NULL DEFAULT 3
);

-- ---------------------------------------------------- приклад запитів PostGIS --
-- Кандидати-водії в радіусі 7 км (замінює candidateDrivers() у lib/dispatch.ts):
--
--   SELECT d.user_id,
--          ST_Distance(d.location, p.point) AS distance_m
--     FROM driver_profiles d
--     JOIN order_points p ON p.order_id = $1 AND p.seq = 0
--    WHERE d.status = 'verified' AND d.work_status = 'online'
--      AND ST_DWithin(d.location, p.point, 7000)
--      AND EXISTS (SELECT 1 FROM vehicles v WHERE v.driver_id = d.user_id AND v.class_id = $2 AND v.active)
--    ORDER BY distance_m
--    LIMIT 10;
--
-- Чи входить точка в зону surge (замінює zonesFor()):
--   SELECT * FROM zones WHERE city_id = $1 AND kind = 'surge' AND ST_Contains(area::geometry, $2::geometry);
