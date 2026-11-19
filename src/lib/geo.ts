// Small geometry helpers. Coordinates are [longitude, latitude] pairs
// (the same order Mapbox uses), distances are in meters.

export type LngLat = [number, number];

const R = 6371008.8; // mean Earth radius in meters
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function distance(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Cumulative distance along a line: result[i] = meters from start to coords[i]. */
export function cumulative(coords: LngLat[]): number[] {
  const out = new Array<number>(coords.length);
  let total = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) total += distance(coords[i - 1], coords[i]);
    out[i] = total;
  }
  return out;
}

export function lineLength(coords: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distance(coords[i - 1], coords[i]);
  return total;
}

export interface Projection {
  /** Index of the segment start (segment is coords[index] -> coords[index + 1]). */
  index: number;
  /** 0..1 position along that segment. */
  t: number;
  /** Distance in meters from the point to the line. */
  offset: number;
  /** The closest point on the line. */
  point: LngLat;
}

/**
 * Closest point on a polyline, searching segments [from, to).
 * Uses a local flat-earth approximation, which is accurate at street scale.
 */
export function project(p: LngLat, coords: LngLat[], from = 0, to = coords.length - 1): Projection | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) return { index: 0, t: 0, offset: distance(p, coords[0]), point: coords[0] };
  const start = Math.max(0, from);
  const end = Math.min(coords.length - 1, to);
  const kx = Math.cos(toRad(p[1])) * 111320;
  const ky = 110540;
  let best: Projection | null = null;
  let bestD2 = Infinity;
  for (let i = start; i < end; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const ax = (a[0] - p[0]) * kx;
    const ay = (a[1] - p[1]) * ky;
    const bx = (b[0] - p[0]) * kx;
    const by = (b[1] - p[1]) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const d2 = cx * cx + cy * cy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = {
        index: i,
        t,
        offset: Math.sqrt(d2),
        point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      };
    }
  }
  return best;
}

/** Distance along the line (meters from its start) of a projection. */
export function alongLine(proj: Projection, coords: LngLat[], cum: number[]): number {
  const i = proj.index;
  if (i >= coords.length - 1) return cum[cum.length - 1] ?? 0;
  return cum[i] + (cum[i + 1] - cum[i]) * proj.t;
}

/** Index of the first coordinate at or beyond `meters` along the line. */
export function indexAtDistance(cum: number[], meters: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < meters) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Keep points that are at least `minSpacing` meters apart (always keeps first and last). */
export function thin(coords: LngLat[], minSpacing: number): number[] {
  if (coords.length <= 2) return coords.map((_, i) => i);
  const keep = [0];
  let last = coords[0];
  for (let i = 1; i < coords.length - 1; i++) {
    if (distance(last, coords[i]) >= minSpacing) {
      keep.push(i);
      last = coords[i];
    }
  }
  keep.push(coords.length - 1);
  return keep;
}

export function bounds(coords: LngLat[]) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

// ---- Friendly US-style formatting -------------------------------------------------

const FEET_PER_METER = 3.28084;
const METERS_PER_MILE = 1609.344;

export function formatDistance(m: number): string {
  const miles = m / METERS_PER_MILE;
  if (miles >= 10) return `${Math.round(miles)} mi`;
  if (miles >= 0.2) return `${miles.toFixed(1)} mi`;
  const ft = Math.max(50, Math.round((m * FEET_PER_METER) / 50) * 50);
  return `${ft} ft`;
}

/** How a distance sounds when spoken. */
export function spokenDistance(m: number): string {
  const miles = m / METERS_PER_MILE;
  if (miles >= 0.9) {
    const r = Math.round(miles);
    return r === 1 ? 'one mile' : `${r} miles`;
  }
  if (miles >= 0.65) return 'three quarters of a mile';
  if (miles >= 0.4) return 'half a mile';
  if (miles >= 0.2) return 'a quarter mile';
  const ft = Math.max(100, Math.round((m * FEET_PER_METER) / 100) * 100);
  return `${ft} feet`;
}

export function formatMiles(m: number): string {
  const miles = m / METERS_PER_MILE;
  return miles >= 10 ? `${Math.round(miles)} mi` : `${miles.toFixed(1)} mi`;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** A duration split for a big number: "34" + "min", or "1:05" + "hr". */
export function heroDuration(ms: number): { value: string; unit: string } {
  const totalMin = Math.max(1, Math.round(ms / 60000));
  if (totalMin < 60) return { value: String(totalMin), unit: 'min' };
  return { value: `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`, unit: 'hr' };
}
