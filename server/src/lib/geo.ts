/**
 * Geo helpers. In the PostgreSQL deployment these calls are replaced by
 * PostGIS (geography type + ST_DWithin / ST_Distance / ST_Contains) — the
 * function signatures intentionally match that API so modules do not change.
 */
import { all, Db, Row } from './db.js';

const R = 6_371_000; // metres
const rad = (d: number) => (d * Math.PI) / 180;

export interface Point { lat: number; lng: number }

export function distanceM(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(s))));
}

/** Route length through an ordered list of points (metres). */
export function routeLengthM(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceM(points[i - 1], points[i]);
  return total;
}

/** Street-network fudge factor: real cars drive ~1.35× the great-circle path. */
export const ROAD_FACTOR = 1.35;
export const AVG_SPEED_KMH = 32;

export function durationS(distanceMeters: number, speedKmh = AVG_SPEED_KMH): number {
  return Math.max(60, Math.round((distanceMeters / (speedKmh * 1000 / 3600))));
}

/** Ray-casting point-in-polygon — mirrors ST_Contains for small polygons. */
export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lat, yi = polygon[i].lng;
    const xj = polygon[j].lat, yj = polygon[j].lng;
    const intersect = yi > p.lng !== yj > p.lng && p.lat < ((xj - xi) * (p.lng - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Same as ST_DWithin(geography, geography, metres). */
export function withinRadius(a: Point, b: Point, radiusM: number): boolean {
  return distanceM(a, b) <= radiusM;
}

/** Pick the nearest city for a point. */
export function nearestCity(db: Db, p: Point): Row | undefined {
  const cities = all(db, `SELECT * FROM cities WHERE active = 1`);
  let best: Row | undefined;
  let bestD = Infinity;
  for (const c of cities) {
    const d = distanceM(p, { lat: c.lat, lng: c.lng });
    if (d < bestD) { bestD = d; best = { ...c, distance_m: d }; }
  }
  return best;
}

/** Zone lookup for tariff/surge multipliers. */
export function zonesFor(db: Db, cityId: string, p: Point): Row[] {
  return all(db, `SELECT * FROM zones WHERE city_id = ? AND active = 1`, cityId).filter((z) =>
    pointInPolygon(p, JSON.parse(z.polygon_json) as Point[]),
  );
}

/**
 * Geocoding substitute: search the city address index.
 * NOTE: filtering happens in JS because SQLite's lower() is ASCII-only and
 * would not match Cyrillic. The PostgreSQL deployment uses
 * `label ILIKE $2` backed by a pg_trgm index — same semantics, indexed.
 */
export function searchAddresses(db: Db, cityId: string, q: string, limit = 8): Row[] {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  return all<Row>(db, `SELECT id, label, street, house, lat, lng, kind FROM addresses WHERE city_id = ?`, cityId)
    .filter((row) => String(row.label).toLowerCase().includes(term))
    .sort((a, b) => {
      const aStarts = String(a.label).toLowerCase().startsWith(term) ? 0 : 1;
      const bStarts = String(b.label).toLowerCase().startsWith(term) ? 0 : 1;
      return aStarts - bStarts || String(a.label).length - String(b.label).length;
    })
    .slice(0, limit);
}

export function reverseGeocode(db: Db, cityId: string, p: Point): Row {
  const list = all(db, `SELECT * FROM addresses WHERE city_id = ?`, cityId);
  let best: Row | undefined;
  let bestD = Infinity;
  for (const a of list) {
    const d = distanceM(p, a as Point);
    if (d < bestD) { bestD = d; best = a; }
  }
  if (!best) return { label: `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, lat: p.lat, lng: p.lng, exact: false };
  return { label: best.label, lat: p.lat, lng: p.lng, matched: best.label, distance_m: bestD, exact: bestD < 60 };
}
