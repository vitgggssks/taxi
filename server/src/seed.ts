/**
 * Seed / demo dataset.
 * Creates the catalogue (cities, classes, tariffs, options), platform settings,
 * promo codes, demo staff and demo drivers with live coordinates so the whole
 * flow can be exercised end-to-end without external services.
 * Idempotent: does nothing when cities already exist.
 */
import { Db, one, run } from './lib/db.js';
import { id } from './lib/util.js';

type ClassSeed = {
  code: string; name: string; kind: string; seats: number; luggage: number; sort: number; icon: string;
  base: number; perKm: number; perMin: number; minFare: number; perStop: number; commission: number;
  intercity?: number; night?: number;
};

const CLASSES: ClassSeed[] = [
  { code: 'economy', name: 'Економ', kind: 'ride', seats: 4, luggage: 2, sort: 10, icon: '🚗', base: 4500, perKm: 900, perMin: 100, minFare: 7000, perStop: 1500, commission: 15 },
  { code: 'standard', name: 'Стандарт', kind: 'ride', seats: 4, luggage: 2, sort: 20, icon: '🚙', base: 5500, perKm: 1100, perMin: 120, minFare: 8500, perStop: 1500, commission: 15, night: 1.1 },
  { code: 'comfort', name: 'Комфорт', kind: 'ride', seats: 4, luggage: 3, sort: 30, icon: '🚘', base: 7500, perKm: 1500, perMin: 150, minFare: 12000, perStop: 2000, commission: 18, night: 1.1 },
  { code: 'business', name: 'Бізнес', kind: 'ride', seats: 4, luggage: 3, sort: 40, icon: '🏎️', base: 12000, perKm: 2400, perMin: 250, minFare: 20000, perStop: 3000, commission: 20 },
  { code: 'wagon', name: 'Універсал', kind: 'ride', seats: 4, luggage: 5, sort: 50, icon: '🚐', base: 7000, perKm: 1400, perMin: 140, minFare: 11000, perStop: 2000, commission: 15 },
  { code: 'minivan', name: 'Мінівен', kind: 'ride', seats: 6, luggage: 6, sort: 60, icon: '🚌', base: 9500, perKm: 1800, perMin: 170, minFare: 15000, perStop: 2500, commission: 15 },
  { code: 'kids', name: 'Дитячий', kind: 'ride', seats: 3, luggage: 2, sort: 70, icon: '🧒', base: 8500, perKm: 1600, perMin: 160, minFare: 13000, perStop: 2000, commission: 15 },
  { code: 'delivery', name: 'Доставка', kind: 'delivery', seats: 0, luggage: 20, sort: 80, icon: '📦', base: 6000, perKm: 1000, perMin: 80, minFare: 9000, perStop: 1500, commission: 12 },
  { code: 'intercity', name: 'Міжміське', kind: 'service', seats: 4, luggage: 3, sort: 90, icon: '🛣️', base: 8000, perKm: 700, perMin: 0, minFare: 15000, perStop: 3000, commission: 10, intercity: 700 },
  { code: 'sober', name: 'Тверезий водій', kind: 'service', seats: 1, luggage: 0, sort: 100, icon: '🧑‍✈️', base: 30000, perKm: 3500, perMin: 300, minFare: 35000, perStop: 0, commission: 20 },
];

const OPTIONS = [
  { code: 'child_seat', name: 'Дитяче крісло', description: 'Сертифіковане крісло для дитини', kind: 'option', price: 7000, scope: 'standard,comfort,business,minivan,kids,wagon' },
  { code: 'booster', name: 'Бустер', description: 'Підвищувальне сидіння', kind: 'option', price: 5000, scope: 'standard,comfort,minivan,wagon' },
  { code: 'pet', name: 'Перевезення тварини', description: 'Дозвіл на тварину в салоні', kind: 'option', price: 4000, scope: 'standard,comfort,wagon,minivan' },
  { code: 'luggage_extra', name: 'Великий багаж', description: 'Додаткові місця для багажу', kind: 'option', price: 5000, scope: 'wagon,minivan,comfort' },
  { code: 'quiet_ride', name: 'Тиха поїздка', description: 'Без розмов і музики', kind: 'option', price: 0, scope: 'comfort,business' },
  { code: 'meet_with_sign', name: 'Зустріч з табличкою', description: 'Водій зустріне з іменем', kind: 'option', price: 8000, scope: 'business,comfort' },
  { code: 'sober_driver', name: 'Тверезий водій', description: 'Водій поведе ваш автомобіль', kind: 'service', price: 0, scope: 'sober' },
  { code: 'waiting_30', name: 'Очікування 30 хв', description: 'Водій зачекає 30 хвилин', kind: 'option', price: 6000, scope: '*' },
];

const CITIES = [
  {
    id: 'city_kyiv', name: 'Київ', region: 'Київська область', lat: 50.4501, lng: 30.5234,
    addresses: [
      ['Хрещатик, 1', 50.4471, 30.5227, 'street'], ['Майдан Незалежності', 50.4501, 30.5234, 'poi'],
      ['Вокзальна площа, 1 (Центральний вокзал)', 50.4401, 30.4893, 'station'],
      ['Аеропорт Бориспіль, Термінал D', 50.3445, 30.8945, 'airport'],
      ['Аеропорт Жуляни', 50.4028, 30.4497, 'airport'],
      ['ТРЦ Ocean Plaza, Антоновича 176', 50.4127, 30.5266, 'poi'],
      ['ТРЦ Gulliver, Спортивна площа 1а', 50.4325, 30.5215, 'poi'],
      ['вул. Хрещатик, 22', 50.4472, 30.5197, 'street'], ['вул. Антоновича, 50', 50.4245, 30.5255, 'street'],
      ['просп. Перемоги, 41 (Святошин)', 50.4557, 30.4093, 'street'],
      ['Оболонська набережна, 5', 50.5069, 30.5166, 'street'],
      ['вул. Банківська, 8', 50.4458, 30.5300, 'street'],
      ['Голосіївський парк', 50.3966, 30.5089, 'poi'],
      ['вул. Велика Васильківська, 100', 50.4177, 30.5210, 'street'],
      ['Подільський узвіз, 1', 50.4628, 30.5172, 'street'],
      ['вул. Грушевського, 5', 50.4520, 30.5280, 'street'],
      ['Києво-Печерська лавра', 50.4342, 30.5592, 'poi'],
      ['Лівобережна, вул. Євгена Сверстюка, 21', 50.4500, 30.5990, 'street'],
      ['вул. Січових Стрільців, 77', 50.4584, 30.4940, 'street'],
      ['Троєщина, вул. Оноре де Бальзака, 4', 50.5080, 30.6080, 'street'],
    ],
  },
  {
    id: 'city_uzhhorod', name: 'Ужгород', region: 'Закарпатська область', lat: 48.6208, lng: 22.2879,
    addresses: [
      ['пл. Поштова, 1', 48.6234, 22.2880, 'street'], ['Ужгородський замок', 48.6225, 22.2894, 'poi'],
      ['Залізничний вокзал Ужгород', 48.6090, 22.2830, 'station'],
      ['вул. Корзо, 5', 48.6243, 22.2860, 'street'],
      ['Боздоський парк', 48.6170, 22.2700, 'poi'],
      ['ТЦ Токіо, вул. Собранецька, 89', 48.6270, 22.2800, 'poi'],
      ['Автовокзал, вул. Станційна, 2', 48.6097, 22.2840, 'station'],
      ['Аеропорт Ужгород', 48.6340, 22.2630, 'airport'],
      ['вул. Гагаріна, 101', 48.6150, 22.3010, 'street'],
      ['вул. Швабська, 17', 48.6240, 22.2930, 'street'],
      ['Мукачівська, 45', 48.6060, 22.3160, 'street'],
      ['Індустріальна, 2', 48.6120, 22.2950, 'street'],
    ],
  },
  {
    id: 'city_harkiv', name: 'Харків', region: 'Харківська область', lat: 49.9935, lng: 36.2304,
    addresses: [
      ['пл. Свободи, 1', 49.9935, 36.2304, 'street'], ['Південний вокзал', 49.9880, 36.1990, 'station'],
      ['вул. Сумська, 30', 50.0030, 36.2360, 'street'],
      ['Аеропорт Харків (Південний)', 49.9245, 36.2945, 'airport'],
      ['ТРЦ Нікольський', 50.0150, 36.2310, 'poi'],
      ['вул. Клочківська, 190', 50.0200, 36.2200, 'street'],
    ],
  },
];

const DEMO_DRIVERS = [
  { phone: '+380671000101', name: 'Іван Петренко', cls: 'economy,standard', plate: 'AA 1234 I', car: ['Daewoo', 'Lanos', 2016, 'сірий'], lat: 50.4490, lng: 30.5270, auto: 1, min: 8000, radius: 6 },
  { phone: '+380671000102', name: 'Олександр Коваль', cls: 'standard,comfort', plate: 'BB 4521 B', car: ['Toyota', 'Camry', 2019, 'чорний'], lat: 50.4512, lng: 30.5180, auto: 0, min: 0, radius: 8 },
  { phone: '+380671000103', name: 'Марія Гриценко', cls: 'comfort,business', plate: 'CC 9911 C', car: ['Volkswagen', 'Passat', 2021, 'білий'], lat: 50.4430, lng: 30.5100, auto: 1, min: 15000, radius: 5 },
  { phone: '+380671000104', name: 'Дмитро Мельник', cls: 'minivan,wagon', plate: 'DD 3312 D', car: ['Volkswagen', 'Transporter', 2018, 'синій'], lat: 50.4550, lng: 30.5350, auto: 0, min: 0, radius: 10 },
  { phone: '+380671000105', name: 'Сергій Шевчук', cls: 'economy,delivery', plate: 'EE 7788 E', car: ['Renault', 'Logan', 2017, 'сірий'], lat: 50.4380, lng: 30.5290, auto: 1, min: 0, radius: 7 },
  { phone: '+380671000106', name: 'Андрій Бондар', cls: 'business,wagon', plate: 'FF 2201 F', car: ['BMW', '5 Series', 2022, 'чорний'], lat: 50.4470, lng: 30.5330, auto: 0, min: 25000, radius: 6 },
  { phone: '+380671000107', name: 'Наталія Ільченко', cls: 'kids,standard', plate: 'GG 5501 G', car: ['Skoda', 'Octavia', 2020, 'бордовий'], lat: 50.4600, lng: 30.5220, auto: 1, min: 12000, radius: 5 },
  { phone: '+380671000108', name: 'Петро Савченко', cls: 'sober,comfort', plate: 'HH 1010 H', car: ['Audi', 'A6', 2020, 'срібний'], lat: 50.4520, lng: 30.5450, auto: 0, min: 0, radius: 12 },
];

const DEMO_UZ_DRIVERS = [
  { phone: '+380671000201', name: 'Тарас Мигович', cls: 'economy,standard,delivery', plate: 'AO 4001 I', car: ['Skoda', 'Fabia', 2018, 'синій'], lat: 48.6234, lng: 22.2880, auto: 1, min: 8000, radius: 8 },
  { phone: '+380671000202', name: 'Ігор Пинзеник', cls: 'comfort,minivan', plate: 'AO 7788 K', car: ['Ford', 'Galaxy', 2019, 'сірий'], lat: 48.6180, lng: 22.2900, auto: 0, min: 0, radius: 10 },
];

const DEMO_PASSENGERS = [
  { phone: '+380671112233', name: 'Олена Славська', city: 'city_kyiv' },
  { phone: '+380501112233', name: 'Богдан Федорович', city: 'city_uzhhorod' },
];

export function seedDatabase(db: Db): void {
  const already = one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM cities`);
  if (already && already.n > 0) return;

  const cities = CITIES.map((c) => {
    run(
      db,
      `INSERT INTO cities (id, name, region, country, currency, timezone, lat, lng) VALUES (?,?,?,?,?,?,?,?)`,
      c.id, c.name, c.region, 'UA', 'UAH', 'Europe/Kyiv', c.lat, c.lng,
    );
    run(
      db,
      `INSERT INTO dispatch_settings (city_id, offer_timeout_s, offer_rounds, search_radius_km, max_active_orders, auto_accept_max_distance_km, parallel_offers)
       VALUES (?,?,?,?,?,?,?)`,
      c.id, 20, 3, 7, 5, 4, 3,
    );
    for (const [label, lat, lng, kind] of c.addresses) {
      run(db, `INSERT INTO addresses (id, city_id, label, lat, lng, kind) VALUES (?,?,?,?,?,?)`,
        id('addr'), c.id, label as string, lat as number, lng as number, kind as string);
    }
    return c;
  });

  // commodity classes are city-independent; tariffs are per city
  for (const cls of CLASSES) {
    run(
      db,
      `INSERT INTO car_classes (id, code, name, kind, seats, luggage, sort, icon) VALUES (?,?,?,?,?,?,?,?)`,
      `cls_${cls.code}`, cls.code, cls.name, cls.kind, cls.seats, cls.luggage, cls.sort, cls.icon,
    );
    for (const city of cities) {
      const coeff = city.id === 'city_kyiv' ? 1 : 0.85;
      run(
        db,
        `INSERT INTO tariffs (id, city_id, class_id, base_cents, per_km_cents, per_min_cents, min_fare_cents,
          per_stop_cents, waiting_per_min_cents, cancel_fee_cents, intercity_per_km_cents, night_multiplier,
          night_from, night_to, city_multiplier, commission_pct, version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        id('trf'), city.id, `cls_${cls.code}`,
        Math.round(cls.base * coeff), Math.round(cls.perKm * coeff), Math.round(cls.perMin * coeff),
        Math.round(cls.minFare * coeff), Math.round(cls.perStop * coeff), 200, 5000,
        cls.intercity != null ? Math.round(cls.intercity * coeff) : null,
        cls.night ?? 1.0, 22, 6, 1.0, cls.commission,
      );
    }
  }

  for (const opt of OPTIONS) {
    run(
      db,
      `INSERT INTO order_options (id, code, name, description, kind, price_cents, class_scope) VALUES (?,?,?,?,?,?,?)`,
      id('opt'), opt.code, opt.name, opt.description, opt.kind, opt.price, opt.scope,
    );
  }

  // zones: surge in the very centre, service area for each city
  const kyivCentre = [
    { lat: 50.4560, lng: 30.5150 }, { lat: 50.4560, lng: 30.5350 },
    { lat: 50.4400, lng: 30.5350 }, { lat: 50.4400, lng: 30.5150 },
  ];
  run(db, `INSERT INTO zones (id, city_id, name, kind, polygon_json, multiplier) VALUES (?,?,?,?,?,?)`,
    id('zn'), 'city_kyiv', 'Центр (підвищений попит)', 'surge', JSON.stringify(kyivCentre), 1.25);
  run(db, `INSERT INTO zones (id, city_id, name, kind, polygon_json, multiplier) VALUES (?,?,?,?,?,?)`,
    id('zn'), 'city_kyiv', 'Київ — зона обслуговування', 'service_area', JSON.stringify([
      { lat: 50.55, lng: 30.35 }, { lat: 50.55, lng: 30.7 }, { lat: 50.35, lng: 30.7 }, { lat: 50.35, lng: 30.35 },
    ]), 1);
  run(db, `INSERT INTO zones (id, city_id, name, kind, polygon_json, multiplier) VALUES (?,?,?,?,?,?)`,
    id('zn'), 'city_uzhhorod', 'Ужгород — зона обслуговування', 'service_area', JSON.stringify([
      { lat: 48.65, lng: 22.24 }, { lat: 48.65, lng: 22.34 }, { lat: 48.59, lng: 22.34 }, { lat: 48.59, lng: 22.24 },
    ]), 1);

  // promo codes
  run(db, `INSERT INTO promo_codes (code, kind, value, min_fare_cents, usage_limit, per_user_limit, valid_to, active)
           VALUES ('RUKH10','percent',10,0,1000,3,'2030-12-31',1)`);
  run(db, `INSERT INTO promo_codes (code, kind, value, min_fare_cents, max_discount_cents, usage_limit, per_user_limit, valid_to, active)
           VALUES ('FIRST100','fixed',10000,12000,10000,500,1,'2030-12-31',1)`);
  run(db, `INSERT INTO promo_codes (code, kind, value, min_fare_cents, max_discount_cents, usage_limit, per_user_limit, valid_to, active)
           VALUES ('FREE50','free_ride',0,0,5000,50,1,'2030-12-31',1)`);

  // roles & settings
  run(db, `INSERT INTO roles (id, name, permissions) VALUES (?,?,?)`, 'role_admin', 'admin',
    JSON.stringify(['*']));
  run(db, `INSERT INTO roles (id, name, permissions) VALUES (?,?,?)`, 'role_dispatcher', 'dispatcher',
    JSON.stringify(['orders.*', 'drivers.read', 'map.read', 'support.*']));
  run(db, `INSERT INTO roles (id, name, permissions) VALUES (?,?,?)`, 'role_support', 'support',
    JSON.stringify(['support.*', 'orders.read', 'reviews.read']));

  const settings: Record<string, unknown> = {
    plus_minus_max_pct: 20,
    cashback_pct: 2,
    support_phone: '+380 44 000 00 00',
    brand_name: 'РУХ',
    default_locale: 'uk',
    otp_ttl_seconds: 300,
    otp_max_attempts: 5,
    max_stops: 5,
    max_active_rides: 5,
    scheduled_min_lead_minutes: 15,
    driver_payout_min_cents: 10000,
  };
  for (const [key, value] of Object.entries(settings)) {
    run(db, `INSERT INTO settings (key, value) VALUES (?,?)`, key, JSON.stringify(value));
  }

  // staff
  const addUser = (phone: string, role: string, name: string, cityId?: string) => {
    const userId = id('usr');
    run(db, `INSERT INTO users (id, role, phone, name, city_id) VALUES (?,?,?,?,?)`, userId, role, phone, name, cityId ?? null);
    return userId;
  };
  addUser('+380500000001', 'admin', 'Адмін платформи');
  addUser('+380500000002', 'dispatcher', 'Диспетчер Олег', 'city_kyiv');

  for (const p of DEMO_PASSENGERS) addUser(p.phone, 'passenger', p.name, p.city);

  // corporate demo company + admin
  const companyId = id('cmp');
  run(db, `INSERT INTO companies (id, name, edrpou, city_id, discount_pct, credit_limit_cents, invoice_email)
           VALUES (?,?,?,?,?,?,?)`, companyId, 'ТОВ «Карпати Логістик»', '39876543', 'city_kyiv', 7, 5000000, 'billing@karpaty.example');
  const corpAdmin = addUser('+380503334455', 'corporate_admin', 'Ірина Захарченко', 'city_kyiv');
  run(db, `UPDATE users SET corporate_id = ? WHERE id = ?`, companyId, corpAdmin);
  run(db, `INSERT INTO corporate_members (id, company_id, user_id, phone, role, monthly_limit_cents, status)
           VALUES (?,?,?,?,?,?,?)`, id('cm'), companyId, corpAdmin, '+380503334455', 'admin', 0, 'active');
  run(db, `INSERT INTO corporate_members (id, company_id, phone, role, monthly_limit_cents, status, invite_token)
           VALUES (?,?,?,?,?,?,?)`, id('cm'), companyId, '+380509990011', 'employee', 300000, 'invited', 'inv_demo123');

  // drivers
  const addDriver = (d: typeof DEMO_DRIVERS[number], cityId: string) => {
    const userId = addUser(d.phone, 'driver', d.name, cityId);
    const primaryClass = d.cls.split(',')[0];
    run(
      db,
      `INSERT INTO driver_profiles (user_id, city_id, status, work_status, auto_accept, accept_radius_km, min_price_cents,
        classes_csv, lat, lng, location_at, rating, rating_count, orders_completed, balance_cents, commission_pct, verified_at)
       VALUES (?,?,'verified','online',?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      userId, cityId, d.auto, d.radius, d.min, d.cls, d.lat, d.lng, new Date().toISOString(),
      4.6 + Math.random() * 0.4, 40 + Math.floor(Math.random() * 400),
      30 + Math.floor(Math.random() * 900), 0, 15,
    );
    run(db, `UPDATE driver_profiles SET rating = ROUND(rating, 2) WHERE user_id = ?`, userId);
    for (const cls of d.cls.split(',')) {
      run(
        db,
        `INSERT INTO vehicles (id, driver_id, class_id, make, model, year, color, plate, photo_url)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        id('veh'), userId, `cls_${cls}`, d.car[0] as string, d.car[1] as string, d.car[2] as number,
        d.car[3] as string, cls === primaryClass ? (d.plate as string) : `${d.plate}`, null,
      );
    }
    for (const type of ['license', 'vehicle_registration', 'vehicle_photo']) {
      run(db, `INSERT INTO driver_documents (id, driver_id, type, file_url, status, reviewed_at) VALUES (?,?,?,?,?,datetime('now'))`,
        id('doc'), userId, type, `/uploads/${type}/${userId}.jpg`, 'approved');
    }
    return userId;
  };
  for (const d of DEMO_DRIVERS) addDriver(d, 'city_kyiv');
  for (const d of DEMO_UZ_DRIVERS) addDriver(d, 'city_uzhhorod');

  // one driver pending verification, so moderation has work to do
  const pending = addUser('+380671000199', 'driver', 'Новачок Без Документів', 'city_kyiv');
  run(db, `INSERT INTO driver_profiles (user_id, city_id, status, classes_csv) VALUES (?,?,'pending','')`, pending, 'city_kyiv');
  run(db, `INSERT INTO driver_documents (id, driver_id, type, file_url) VALUES (?,?,?,?)`,
    id('doc'), pending, 'license', `/uploads/license/${pending}.jpg`);

  // wallet for demo passenger
  const pass = one<{ id: string }>(db, `SELECT id FROM users WHERE phone = '+380671112233'`);
  if (pass) {
    run(db, `UPDATE users SET name = 'Олена Славська' WHERE id = ?`, pass.id);
    run(db, `INSERT INTO wallet_transactions (id, user_id, kind, amount_cents, idempotency_key, balance_after_cents, meta)
             VALUES (?,?,'topup',20000,'seed_topup_1',20000,?)`, id('txn'), pass.id, JSON.stringify({ source: 'seed' }));
    run(db, `INSERT INTO saved_addresses (id, user_id, label, address, lat, lng) VALUES (?,?,?,?,?,?)`,
      id('sav'), pass.id, 'Дім', 'вул. Хрещатик, 22', 50.4472, 30.5197);
    run(db, `INSERT INTO saved_addresses (id, user_id, label, address, lat, lng) VALUES (?,?,?,?,?,?)`,
      id('sav'), pass.id, 'Робота', 'ТРЦ Gulliver, Спортивна площа 1а', 50.4325, 30.5215);
  }
}
