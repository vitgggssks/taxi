/**
 * Pricing Engine.
 *
 * Fully data-driven: every coefficient lives in `tariffs` / `zones` /
 * `settings`, so admins can change pricing without a deploy.
 *
 *   fare = (base + per_km * km + per_min * min) * city * night * surge
 *          + stops * per_stop + Σ options
 *   fare = max(fare, min_fare)
 *   then  + plus/minus adjustment, − promo discount, − corporate discount
 */
import { all, Db, Row } from './db.js';
import { durationS, Point, routeLengthM, ROAD_FACTOR, zonesFor } from './geo.js';
import { bad, roundMoney, unprocessable } from './util.js';

export interface QuoteInput {
  cityId: string;
  classId: string;
  points: Point[];
  serviceKind?: string;
  optionCodes?: string[];
  promoCode?: string | null;
  paymentMethod?: string;
  userId?: string | null;
  corporateId?: string | null;
  plusMinusCents?: number;
  at?: Date;
}

export interface QuoteLine { code: string; label: string; amountCents: number }
export interface Quote {
  currency: string;
  classId: string;
  classCode: string;
  className: string;
  distanceM: number;
  durationS: number;
  pickupEtaS: number;
  fareCents: number;
  totalCents: number;
  lines: QuoteLine[];
  breakdown: {
    baseCents: number; distanceCents: number; timeCents: number; stopsCents: number;
    optionsCents: number; surgeMultiplier: number; nightMultiplier: number;
    cityMultiplier: number; minFareApplied: boolean; minFareCents: number;
  };
  discountCents: number;
  promoCode: string | null;
  plusMinusCents: number;
  commissionPct: number;
  commissionCents: number;
  driverEarningsCents: number;
}

export function loadTariff(db: Db, cityId: string, classId: string): Row {
  const t = db.prepare(
    `SELECT t.*, c.code AS class_code, c.name AS class_name, c.kind AS class_kind
     FROM tariffs t JOIN car_classes c ON c.id = t.class_id
     WHERE t.city_id = ? AND t.class_id = ? AND t.active = 1
     ORDER BY t.version DESC LIMIT 1`,
  ).get(cityId, classId) as Row | undefined;
  if (!t) throw unprocessable('Для цього міста тариф для обраного класу не налаштований', { cityId, classId });
  return t;
}

function nightMultiplier(tariff: Row, at: Date): { mult: number; night: boolean } {
  const h = at.getHours();
  const from = tariff.night_from ?? 22;
  const to = tariff.night_to ?? 6;
  const night = from > to ? h >= from || h < to : h >= from && h < to;
  return { mult: night ? Number(tariff.night_multiplier ?? 1) : 1, night };
}

function surgeMultiplier(db: Db, cityId: string, pickup: Point): number {
  const zones = zonesFor(db, cityId, pickup);
  return zones.reduce((m, z) => (z.kind === 'surge' ? m * Number(z.multiplier ?? 1) : m), 1);
}

export function priceOptions(db: Db, optionCodes: string[], classCode: string): { lines: QuoteLine[]; total: number } {
  const lines: QuoteLine[] = [];
  let total = 0;
  for (const code of optionCodes) {
    const opt = db.prepare(`SELECT * FROM order_options WHERE code = ? AND active = 1`).get(code) as Row | undefined;
    if (!opt) throw bad(`Опція «${code}» недоступна`, { field: 'options' });
    const scope = opt.class_scope ? String(opt.class_scope).split(',') : null;
    if (scope && !scope.includes(classCode) && !scope.includes('*')) {
      throw unprocessable(`Опція «${opt.name}» недоступна для класу ${classCode}`, { option: code });
    }
    lines.push({ code: opt.code, label: opt.name, amountCents: opt.price_cents });
    total += opt.price_cents;
  }
  return { lines, total };
}

export function validatePromo(
  db: Db, code: string, ctx: { userId?: string | null; cityId: string; classId: string; subtotalCents: number; classCode: string },
): { ok: boolean; reason?: string; promo?: Row } {
  const promo = db.prepare(`SELECT * FROM promo_codes WHERE code = ?`).get(code.toUpperCase()) as Row | undefined;
  if (!promo) return { ok: false, reason: 'Промокод не знайдено' };
  if (!promo.active) return { ok: false, reason: 'Промокод неактивний' };
  const now = new Date().toISOString().slice(0, 10);
  if (promo.valid_from && now < promo.valid_from) return { ok: false, reason: 'Термін дії промокоду ще не почався' };
  if (promo.valid_to && now > promo.valid_to) return { ok: false, reason: 'Термін дії промокоду завершився' };
  if (promo.usage_limit !== null && promo.used_count >= promo.usage_limit) return { ok: false, reason: 'Ліміт використань промокоду вичерпано' };
  if (promo.city_id && promo.city_id !== ctx.cityId) return { ok: false, reason: 'Промокод діє в іншому місті' };
  if (promo.class_scope && !String(promo.class_scope).split(',').includes(ctx.classCode)) {
    return { ok: false, reason: 'Промокод не діє для цього класу' };
  }
  if (ctx.subtotalCents < (promo.min_fare_cents ?? 0)) {
    return { ok: false, reason: `Мінімальна сума замовлення для промокоду — ${(promo.min_fare_cents / 100).toFixed(0)} ₴` };
  }
  if (ctx.userId) {
    const used = db.prepare(
      `SELECT COUNT(*) AS n FROM promo_redemptions WHERE code = ? AND user_id = ?`,
    ).get(promo.code, ctx.userId) as { n: number };
    if (used.n >= (promo.per_user_limit ?? 1)) return { ok: false, reason: 'Ви вже використали цей промокод' };
  }
  return { ok: true, promo };
}

export function promoDiscount(promo: Row, subtotalCents: number): number {
  let discount = 0;
  if (promo.kind === 'percent') discount = roundMoney((subtotalCents * Number(promo.value)) / 100);
  else if (promo.kind === 'fixed') discount = Number(promo.value);
  else if (promo.kind === 'free_ride') discount = subtotalCents;
  if (promo.max_discount_cents) discount = Math.min(discount, Number(promo.max_discount_cents));
  return Math.max(0, Math.min(discount, subtotalCents));
}

/** Max ± adjustment allowed by platform policy (settings.plus_minus_max_pct). */
export function plusMinusLimit(subtotalCents: number, maxPct = 20): number {
  return Math.round((subtotalCents * maxPct) / 100);
}

export function quote(db: Db, input: QuoteInput): Quote {
  const points = input.points;
  if (!points || points.length < 2) throw bad('Маршрут має містити щонайменше точку подачі та призначення', { field: 'points' });
  if (points.length > 7) throw bad('Максимум 5 проміжних зупинок (7 точок у маршруті)', { field: 'points' });

  const tariff = loadTariff(db, input.cityId, input.classId);
  const rawDistance = routeLengthM(points);
  if (rawDistance < 1) throw bad('Точки маршруту збігаються');
  const distanceM = Math.round(rawDistance * ROAD_FACTOR);
  const tripDuration = durationS(distanceM);
  const at = input.at ?? new Date();
  const night = nightMultiplier(tariff, at);
  const surge = surgeMultiplier(db, input.cityId, points[0]);

  const km = distanceM / 1000;
  const minutes = tripDuration / 60;

  const isIntercity = input.serviceKind === 'intercity';
  const perKm = isIntercity && tariff.intercity_per_km_cents != null
    ? Number(tariff.intercity_per_km_cents)
    : Number(tariff.per_km_cents);

  const baseCents = Number(tariff.base_cents);
  const distanceCents = roundMoney(perKm * km);
  const timeCents = roundMoney(Number(tariff.per_min_cents) * minutes);
  let fare = (baseCents + distanceCents + timeCents) * Number(tariff.city_multiplier ?? 1) * night.mult * surge;

  const stops = Math.max(0, points.length - 2);
  const stopsCents = stops * Number(tariff.per_stop_cents ?? 0);
  fare += stopsCents;

  const opts = priceOptions(db, input.optionCodes ?? [], String(tariff.class_code));
  fare += opts.total;

  const preMinFare = roundMoney(fare);
  const minFare = Number(tariff.min_fare_cents ?? 0);
  const minFareApplied = preMinFare < minFare;
  const subtotalBeforeDiscount = Math.max(preMinFare, minFare);

  // pickup ETA: 2.5 min base + 1 min per 500 m if we already know a nearby driver
  const pickupEtaS = Math.round(150 + Math.min(600, distanceM / 1000 * 6));

  let discountCents = 0;
  let appliedPromo: string | null = null;
  if (input.promoCode) {
    const res = validatePromo(db, input.promoCode, {
      userId: input.userId, cityId: input.cityId, classId: input.classId,
      subtotalCents: subtotalBeforeDiscount, classCode: String(tariff.class_code),
    });
    if (!res.ok || !res.promo) throw unprocessable(res.reason ?? 'Промокод недійсний', { field: 'promoCode' });
    discountCents = promoDiscount(res.promo, subtotalBeforeDiscount);
    appliedPromo = res.promo.code;
  }

  // corporate contract discount
  if (input.corporateId) {
    const company = db.prepare(`SELECT * FROM companies WHERE id = ? AND status = 'active'`).get(input.corporateId) as Row | undefined;
    if (company?.discount_pct) {
      discountCents += roundMoney((subtotalBeforeDiscount * Number(company.discount_pct)) / 100);
    }
  }
  discountCents = Math.min(discountCents, subtotalBeforeDiscount);

  const plusMinus = Math.trunc(input.plusMinusCents ?? 0);
  const limit = plusMinusLimit(subtotalBeforeDiscount);
  if (Math.abs(plusMinus) > limit) {
    throw unprocessable(`Коригування ціни перевищує ліміт ±${(limit / 100).toFixed(0)} ₴`, { field: 'plusMinusCents', limit });
  }

  const total = Math.max(0, roundMoney(subtotalBeforeDiscount + plusMinus - discountCents));
  const commissionPct = Number(tariff.commission_pct ?? 15);
  const commissionCents = roundMoney((total * commissionPct) / 100);

  const lines: QuoteLine[] = [
    { code: 'base', label: 'Посадка', amountCents: baseCents },
    { code: 'distance', label: `Проїзд ${km.toFixed(1)} км`, amountCents: distanceCents },
    { code: 'time', label: `Час у дорозі ${Math.round(minutes)} хв`, amountCents: timeCents },
  ];
  if (stopsCents) lines.push({ code: 'stops', label: `Зупинки (${stops})`, amountCents: stopsCents });
  for (const l of opts.lines) lines.push(l);
  if (night.mult !== 1) lines.push({ code: 'night', label: `Нічний тариф ×${night.mult}`, amountCents: 0 });
  if (surge !== 1) lines.push({ code: 'surge', label: `Підвищений попит ×${surge.toFixed(2)}`, amountCents: 0 });

  return {
    currency: tariff.currency ?? 'UAH',
    classId: input.classId,
    classCode: String(tariff.class_code),
    className: String(tariff.class_name),
    distanceM, durationS: tripDuration, pickupEtaS,
    fareCents: subtotalBeforeDiscount,
    totalCents: total,
    lines,
    breakdown: {
      baseCents, distanceCents, timeCents, stopsCents, optionsCents: opts.total,
      surgeMultiplier: surge, nightMultiplier: night.mult,
      cityMultiplier: Number(tariff.city_multiplier ?? 1),
      minFareApplied, minFareCents: minFare,
    },
    discountCents, promoCode: appliedPromo, plusMinusCents: plusMinus,
    commissionPct, commissionCents,
    driverEarningsCents: Math.max(0, total - commissionCents),
  };
}

/** Quote every active class of a city with the same route (class picker screen). */
export function quoteAll(db: Db, input: Omit<QuoteInput, 'classId'> & { classKind?: string }): Quote[] {
  const classes = all(
    db,
    `SELECT c.* FROM car_classes c
     JOIN tariffs t ON t.class_id = c.id AND t.city_id = ? AND t.active = 1
     WHERE c.active = 1 AND c.kind = ? ORDER BY c.sort`,
    input.cityId, input.classKind ?? 'ride',
  );
  const out: Quote[] = [];
  for (const c of classes) {
    try {
      out.push(quote(db, { ...input, classId: c.id }));
    } catch {
      /* class unavailable for this route — skipped, never breaks the list */
    }
  }
  return out;
}
