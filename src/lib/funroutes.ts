// Fun routes: ways to the same destination that weave through residential
// side streets, dip into cul-de-sacs and pass little odd spots along the way,
// sorted from fastest to longest. Plus picking a surprise destination.
//
// How a fun route is made:
//  1. Get the normal quickest route (obeying the No freeways / No highways
//     switches).
//  2. Look along it, a few hundred meters to each side, for residential
//     streets, cul-de-sacs (turning circles at the end of dead-end streets)
//     and odds and ends (parks, historic spots, viewpoints, public art).
//  3. Pick some of them in order along the way, zig-zagging from side to side,
//     and ask Mapbox for a route through them. Longer routes pick more spots
//     and reach a little further from the main road, but they keep heading the
//     same way: the extra time comes from twisty little streets, not distance.
//  4. Streets the person has never recorded a drive on are preferred.

import { MAPBOX_TOKEN } from '../config';
import { cumulative, distance, project, type LngLat } from './geo';
import { areaName, nearby, type NearbyFeature, type Place } from './places';

export type RouteStyle = 'fastest' | 'weave';

export interface RoadRules {
  noFreeways: boolean;
  noHighways: boolean;
}

export const NO_RULES: RoadRules = { noFreeways: false, noHighways: false };

export type ViaKind = 'street' | 'culdesac' | 'odd';

export interface Via {
  coord: LngLat;
  kind: ViaKind;
  name: string;
}

export interface RouteOption {
  id: string;
  style: RouteStyle;
  /** 0 for the quickest route, 1 (a few side streets) to 5 (the long weave). */
  level: number;
  title: string;
  /** e.g. "Through Sunny Hills and La Habra Heights · 3 cul-de-sacs · passes Hillcrest Park". */
  blurb: string;
  durationS: number;
  distanceM: number;
  coords: LngLat[];
  via: Via[];
  through: string[];
  passes: string[];
  culDeSacs: number;
  /** Share of the route (0..1) on streets with no recorded drive, or null with no drives recorded. */
  newShare: number | null;
  /** True when No highways is on but there was no way around one. */
  usesHighway: boolean;
  /** Meters on highways (numbered state/US routes that aren't freeways). */
  highwayM: number;
}

// ---- Pure geometry helpers (exported for tests) ---------------------------

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The point `meters` away from `from` in direction `bearingDeg`. */
export function destinationPoint(from: LngLat, bearingDeg: number, meters: number): LngLat {
  const δ = meters / R;
  const θ = rad(bearingDeg);
  const φ1 = rad(from[1]);
  const λ1 = rad(from[0]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [((deg(λ2) + 540) % 360) - 180, deg(φ2)];
}

/** A random point between `minM` and `maxM` from `center`, spread evenly over the area. */
export function randomPointInRing(center: LngLat, minM: number, maxM: number, rand = Math.random): LngLat {
  const lo = Math.min(minM, maxM);
  const hi = Math.max(minM, maxM);
  const r = Math.sqrt(lo * lo + rand() * (hi * hi - lo * lo));
  return destinationPoint(center, rand() * 360, r);
}

/** A random point inside a bounding box [minLng, minLat, maxLng, maxLat]. */
export function randomPointInBox(b: [number, number, number, number], rand = Math.random): LngLat {
  return [b[0] + rand() * (b[2] - b[0]), b[1] + rand() * (b[3] - b[1])];
}

function bearingDeg(a: LngLat, b: LngLat): number {
  const φ1 = rad(a[1]);
  const φ2 = rad(b[1]);
  const Δλ = rad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Point and heading `meters` along a line. */
export function pointAlong(coords: LngLat[], cum: number[], meters: number): { at: LngLat; heading: number } {
  const m = Math.max(0, Math.min(meters, cum[cum.length - 1]));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < m) i++;
  const a = coords[i - 1];
  const b = coords[i];
  const seg = cum[i] - cum[i - 1];
  const t = seg > 0 ? (m - cum[i - 1]) / seg : 0;
  return { at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearingDeg(a, b) };
}

/** Where a point sits relative to a line: meters along it, and signed meters to the side (+ = left). */
export function placeAlong(p: LngLat, coords: LngLat[], cum: number[]): { along: number; side: number } | null {
  const proj = project(p, coords);
  if (!proj) return null;
  const i = Math.min(proj.index, coords.length - 2);
  const a = coords[i];
  const b = coords[i + 1];
  const kx = Math.cos(rad(p[1])) * 111320;
  const ky = 110540;
  const cross = (b[0] - a[0]) * kx * ((p[1] - a[1]) * ky) - (b[1] - a[1]) * ky * ((p[0] - a[0]) * kx);
  const along = cum[i] + (cum[i + 1] - cum[i]) * proj.t;
  return { along, side: cross >= 0 ? proj.offset : -proj.offset };
}

// ---- Streets you've already driven ------------------------------------------

/** Remembers every ~40 m square that a recorded drive went through. */
export class VisitedStreets {
  private cells = new Set<string>();
  readonly empty: boolean;

  constructor(traces: LngLat[][]) {
    for (const t of traces) {
      for (let i = 0; i < t.length; i++) {
        this.add(t[i]);
        if (i === 0) continue;
        // Fill gaps between GPS fixes so fast stretches still count.
        const d = distance(t[i - 1], t[i]);
        const steps = Math.min(50, Math.floor(d / 20));
        for (let s = 1; s < steps; s++) {
          const f = s / steps;
          this.add([t[i - 1][0] + (t[i][0] - t[i - 1][0]) * f, t[i - 1][1] + (t[i][1] - t[i - 1][1]) * f]);
        }
      }
    }
    this.empty = this.cells.size === 0;
  }

  private static cell(p: LngLat): [number, number] {
    const lat = 40 / 110540;
    const lng = 40 / (Math.cos(rad(p[1])) * 111320);
    return [Math.floor(p[0] / lng), Math.floor(p[1] / lat)];
  }

  private add(p: LngLat) {
    const [x, y] = VisitedStreets.cell(p);
    this.cells.add(`${x}:${y}`);
  }

  /** True if a recorded drive passed within about 40 m. */
  has(p: LngLat): boolean {
    const [x, y] = VisitedStreets.cell(p);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (this.cells.has(`${x + dx}:${y + dy}`)) return true;
    return false;
  }

  /** Share of a route (0..1) that isn't on a recorded drive. */
  newShare(coords: LngLat[]): number | null {
    if (this.empty || coords.length < 2) return null;
    let total = 0;
    let fresh = 0;
    for (let i = 1; i < coords.length; i++) {
      const d = distance(coords[i - 1], coords[i]);
      const steps = Math.max(1, Math.round(d / 30));
      for (let s = 0; s < steps; s++) {
        const f = (s + 0.5) / steps;
        const p: LngLat = [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f];
        total += d / steps;
        if (!this.has(p)) fresh += d / steps;
      }
    }
    return total > 0 ? fresh / total : null;
  }
}

// ---- What counts as a fun spot ----------------------------------------------

const QUIET_STREETS = new Set(['street', 'street_limited']);
const NOT_REAL_STREETS = new Set(['service', 'driveway', 'parking_aisle', 'alley', 'drive-through', 'emergency_access']);
const CUL_DE_SAC = new Set(['turning_circle', 'turning_loop']);
const ODD_MAKI = new Set([
  'park', 'garden', 'viewpoint', 'monument', 'museum', 'castle', 'attraction', 'landmark', 'art-gallery',
  'observation-tower', 'historic', 'lighthouse', 'water', 'picnic-site', 'natural', 'waterfall', 'mountain', 'wetland',
]);
const BORING_MAKI = new Set([
  'shop', 'grocery', 'fast-food', 'fuel', 'car', 'car-repair', 'car-rental', 'parking', 'parking-garage',
  'bank', 'pharmacy', 'convenience', 'clothing-store', 'mobile-phone', 'hardware', 'laundry', 'dentist',
  'doctor', 'hospital', 'commercial', 'restaurant', 'cafe', 'bar', 'alcohol-shop', 'lodging', 'post',
  'library', 'town-hall', 'school', 'college', 'police', 'fire-station', 'religious-christian', 'amusement-park',
  'bowling-alley', 'cinema', 'casino', 'golf',
]);

const DULL_NAMES = /\b(office|court|courthouse|library|welcome|parking|restroom|entrance|school|church|dmv|city hall|post|police|fire station|clinic|center)\b/i;

export function isOddSpot(f: Pick<NearbyFeature, 'layer' | 'cls' | 'maki' | 'name'>): boolean {
  if (f.layer !== 'poi_label' || !f.name) return false;
  if (BORING_MAKI.has(f.maki) || DULL_NAMES.test(f.name)) return false;
  if (f.cls === 'park_like' || f.cls === 'historic' || f.cls === 'landmark') return true;
  return ODD_MAKI.has(f.maki);
}

export function isQuietStreet(f: Pick<NearbyFeature, 'layer' | 'cls' | 'type'>): boolean {
  return f.layer === 'road' && QUIET_STREETS.has(f.cls) && !NOT_REAL_STREETS.has(f.type);
}

export function isCulDeSac(f: Pick<NearbyFeature, 'layer' | 'cls'>): boolean {
  return f.layer === 'road' && CUL_DE_SAC.has(f.cls);
}

export interface Candidate extends Via {
  /** Meters along the quickest route. */
  along: number;
  /** Signed meters to the side of the quickest route (+ = left). */
  side: number;
  isNew: boolean;
}

// ---- Picking spots -----------------------------------------------------------

export interface Level {
  /** How far from the main route spots may be, in meters. */
  reach: number;
  /** Share of the trip spent weaving through neighborhood pockets (0..1). */
  coverage: number;
  /** Cul-de-sacs per 10 km of trip, and at least this many. */
  culPer10km: number;
  minCul: number;
  odds: number;
  title: string;
}

export const LEVELS: Level[] = [
  { reach: 350, coverage: 0.3, culPer10km: 1, minCul: 1, odds: 1, title: 'A few side streets' },
  { reach: 450, coverage: 0.45, culPer10km: 2, minCul: 1, odds: 1, title: 'Side-street wander' },
  { reach: 600, coverage: 0.65, culPer10km: 3, minCul: 2, odds: 2, title: 'Neighborhood weave' },
  { reach: 750, coverage: 0.85, culPer10km: 5, minCul: 2, odds: 2, title: 'Deep weave' },
  { reach: 900, coverage: 1, culPer10km: 7, minCul: 3, odds: 3, title: 'The long weave' },
];

/** Spots inside a pocket are about this far apart, so the route stays on side streets between them. */
export const SPOT_SPACING = 450;
/** Spots closer than this to the main route just touch the corner of a side street. */
const MIN_REACH = 90;

/** Stretches of the trip to weave through, alternating sides: [start, end, side]. */
export function pocketsFor(tripM: number, level: Level, rand: () => number): [number, number, number][] {
  const lo = tripM * 0.04;
  const hi = tripM * 0.96;
  const span = hi - lo;
  const len = Math.min(2500, Math.max(900, tripM * 0.12));
  const count = Math.max(1, Math.round((span * level.coverage) / len));
  const pocket = Math.min(len, span / count);
  const gap = (span - pocket * count) / (count + 1);
  const out: [number, number, number][] = [];
  let side = rand() < 0.5 ? 1 : -1;
  for (let i = 0; i < count; i++) {
    const a = lo + gap * (i + 1) + pocket * i;
    out.push([a, a + pocket, side]);
    side = -side;
  }
  return out;
}

/**
 * Chooses the spots for one route, in order along the way. Each pocket is a
 * stretch of the trip where the route leaves the main road and winds through
 * the neighborhood on one side, with a spot every ~450 m; pockets alternate
 * sides. Some spots are cul-de-sacs or odd spots instead of plain streets.
 */
export function pickSpots(candidates: Candidate[], tripM: number, level: Level, rand: () => number): Candidate[] {
  const pockets = pocketsFor(tripM, level, rand);
  const bins: { lo: number; hi: number; side: number; pool: Candidate[] }[] = [];
  for (const [a, b, side] of pockets) {
    const n = Math.max(1, Math.round((b - a) / SPOT_SPACING));
    const w = (b - a) / n;
    for (let i = 0; i < n; i++) bins.push({ lo: a + w * i, hi: a + w * (i + 1), side, pool: [] });
  }
  for (const c of candidates) {
    const reach = Math.abs(c.side);
    if (c.kind === 'odd' ? reach > Math.min(level.reach, 400) : reach < MIN_REACH || reach > level.reach) continue;
    const bin = bins.find((b) => c.along >= b.lo && c.along < b.hi);
    if (bin) bin.pool.push(c);
  }

  // Which spots are cul-de-sacs or odd spots.
  const special = new Map<number, ViaKind>();
  const assign = (kind: ViaKind, count: number) => {
    const open = bins.map((_, i) => i).filter((i) => !special.has(i) && bins[i].pool.some((c) => c.kind === kind));
    shuffle(open, rand);
    for (const i of open.slice(0, count)) special.set(i, kind);
  };
  assign('culdesac', Math.max(level.minCul, Math.round((level.culPer10km * tripM) / 10000)));
  assign('odd', level.odds);

  const picked: Candidate[] = [];
  bins.forEach((bin, i) => {
    const want = special.get(i) ?? 'street';
    let pool = bin.pool.filter((c) => c.kind === want);
    if (!pool.length) pool = bin.pool.filter((c) => c.kind === 'street');
    if (!pool.length) return;
    const onSide = pool.filter((c) => Math.sign(c.side) === bin.side || c.kind === 'odd');
    if (onSide.length) pool = onSide;
    else if (!pool.every((c) => c.kind === 'culdesac')) return; // only cross the main road for a cul-de-sac
    const choice = weightedPick(pool, (c) => (c.isNew ? 3 : 1), rand);
    const last = picked[picked.length - 1];
    if (last && distance(last.coord, choice.coord) < 150) return;
    picked.push(choice);
  });
  return picked.sort((a, b) => a.along - b.along);
}

function shuffle<T>(a: T[], rand: () => number) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function weightedPick<T>(items: T[], weight: (t: T) => number, rand: () => number): T {
  const total = items.reduce((s, t) => s + weight(t), 0);
  let r = rand() * total;
  for (const t of items) {
    r -= weight(t);
    if (r <= 0) return t;
  }
  return items[items.length - 1];
}

// ---- Directions --------------------------------------------------------------

interface Step {
  name?: string;
  ref?: string;
  distance: number;
  geometry?: { coordinates: LngLat[] };
  intersections?: { classes?: string[] }[];
}

interface DirectionsResult {
  durationS: number;
  distanceM: number;
  coords: LngLat[];
  steps: Step[];
}

/** A numbered state or US route that isn't a freeway: Whittier Blvd (CA 72), Beach Blvd (CA 39), PCH (CA 1). */
export function isHighwayStep(step: Step): boolean {
  if (step.distance < 150) return false;
  const freeway = (step.intersections ?? []).some((x) => x.classes?.includes('motorway'));
  if (freeway) return false;
  const ref = step.ref ?? '';
  const name = step.name ?? '';
  return /\b(CA|SR|US|HWY|STATE ROUTE|ROUTE)[\s-]?\d+/i.test(ref) || /\b(highway|hwy|pacific coast)\b/i.test(name);
}

/** Points along highway stretches, used to tell Mapbox to route around them. */
export function highwayBlockPoints(steps: Step[], every = 300): LngLat[] {
  const out: LngLat[] = [];
  for (const s of steps) {
    if (!isHighwayStep(s)) continue;
    const c = s.geometry?.coordinates ?? [];
    if (c.length < 2) continue;
    const cum = cumulative(c);
    const len = cum[cum.length - 1];
    if (len < 160) continue;
    for (let m = Math.min(80, len / 2); m <= len - 80; m += every) out.push(pointAlong(c, cum, m).at);
    if (len < 320) out.push(pointAlong(c, cum, len / 2).at);
  }
  return out;
}

async function directions(points: LngLat[], noFreeways: boolean, blocked: LngLat[], continueStraight: boolean): Promise<DirectionsResult | null> {
  if (points.length < 2) return null;
  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    geometries: 'geojson',
    overview: 'full',
    steps: 'true',
    // Spots shape the route without becoming stops.
    waypoints: `0;${points.length - 1}`,
    continue_straight: continueStraight ? 'true' : 'false',
  });
  const exclude = [
    ...(noFreeways ? ['motorway'] : []),
    ...blocked.slice(0, 45).map((p) => `point(${p[0].toFixed(6)} ${p[1].toFixed(6)})`),
  ];
  const path = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
  const excludeParam = exclude.length ? `&exclude=${encodeURIComponent(exclude.join(','))}` : '';
  const res = await fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${path}?${params}${excludeParam}`);
  if (!res.ok) return null;
  const body = await res.json();
  const route = body?.routes?.[0];
  if (body?.code !== 'Ok' || !route?.geometry?.coordinates) return null;
  const steps: Step[] = (route.legs ?? []).flatMap((l: any) => l.steps ?? []);
  return { durationS: route.duration, distanceM: route.distance, coords: route.geometry.coordinates as LngLat[], steps };
}

/** A route through `points` that follows the switches, routing around highways when asked. */
export async function routeWithRules(
  points: LngLat[],
  rules: RoadRules,
  continueStraight = CONTINUE_STRAIGHT,
): Promise<(DirectionsResult & { usesHighway: boolean }) | null> {
  let blocked: LngLat[] = [];
  let last: DirectionsResult | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await directions(points, rules.noFreeways, blocked, continueStraight);
    if (!r) break;
    last = r;
    if (!rules.noHighways) return { ...r, usesHighway: false };
    const more = highwayBlockPoints(r.steps);
    if (!more.length) return { ...r, usesHighway: false };
    if (blocked.length >= 45) break;
    blocked = [...blocked, ...more].slice(0, 45);
  }
  return last ? { ...last, usesHighway: rules.noHighways && highwayBlockPoints(last.steps).length > 0 } : null;
}

/** Whether the route must drive on past each spot (true) or may turn around at one. */
export let CONTINUE_STRAIGHT = false;
export function setContinueStraight(v: boolean) {
  CONTINUE_STRAIGHT = v;
}

/** Mapbox takes 25 points per request, so long weaves are routed in pieces and joined. */
export async function routeThrough(points: LngLat[], rules: RoadRules, continueStraight = CONTINUE_STRAIGHT) {
  const pieces: LngLat[][] = [];
  for (let i = 0; i < points.length - 1; i += 24) pieces.push(points.slice(i, Math.min(points.length, i + 25)));
  const results = await Promise.all(pieces.map((p) => routeWithRules(p, rules, continueStraight)));
  if (results.some((r) => !r)) return null;
  const coords: LngLat[] = [];
  for (const r of results) coords.push(...(coords.length ? r!.coords.slice(1) : r!.coords));
  return {
    durationS: results.reduce((a, r) => a + r!.durationS, 0),
    distanceM: results.reduce((a, r) => a + r!.distanceM, 0),
    coords,
    steps: results.flatMap((r) => r!.steps),
    usesHighway: results.some((r) => r!.usesHighway),
  };
}

/** Street spots where the route only pokes in and turns straight back. */
export function stubSpots(coords: LngLat[], via: Via[]): Set<number> {
  const out = new Set<number>();
  const cum = cumulative(coords);
  let from = 0;
  via.forEach((v, k) => {
    // Nearest route point, searching forward so loops don't confuse it.
    let best = from;
    let bd = Infinity;
    for (let i = from; i < coords.length; i++) {
      const d = distance(coords[i], v.coord);
      if (d < bd) {
        bd = d;
        best = i;
      }
      if (d > bd + 3000) break;
    }
    from = best;
    if (v.kind !== 'street') return;
    const back = pointAlong(coords, cum, cum[best] - 120).at;
    const fwd = pointAlong(coords, cum, cum[best] + 120).at;
    if (distance(back, fwd) < 40) out.add(k);
  });
  return out;
}

export function highwayMeters(steps: Step[]): number {
  return steps.filter(isHighwayStep).reduce((a, s) => a + s.distance, 0);
}

// ---- Looking along the route ------------------------------------------------------

async function inBatches<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < jobs.length; i += size) out.push(...(await Promise.all(jobs.slice(i, i + size).map((j) => j()))));
  return out;
}

/** Residential streets, cul-de-sacs and odd spots on both sides of `base`. */
export async function gatherCandidates(base: LngLat[], visited: VisitedStreets | null): Promise<Candidate[]> {
  const cum = cumulative(base);
  const len = cum[cum.length - 1];
  const stepM = Math.min(1300, Math.max(450, len / 20));
  const offset = 480;
  const jobs: (() => Promise<NearbyFeature[]>)[] = [];
  let k = 0;
  for (let m = Math.min(300, len / 2); m < len - 150; m += stepM, k++) {
    const { at, heading } = pointAlong(base, cum, m);
    for (const side of [-90, 90]) {
      const c = destinationPoint(at, heading + side, offset);
      jobs.push(() => nearby(c, Math.max(560, stepM * 0.7), ['road'], 50, { geometry: 'linestring' }).catch(() => []));
      jobs.push(() => nearby(c, Math.max(600, stepM * 0.75), ['road'], 50, { geometry: 'point', dedupe: false }).catch(() => []));
    }
    if (k % 2 === 0) jobs.push(() => nearby(at, Math.max(450, stepM * 0.8), ['poi_label'], 40).catch(() => []));
  }
  const found = (await inBatches(jobs, 10)).flat();

  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    const kind: ViaKind | null = isCulDeSac(f) ? 'culdesac' : isQuietStreet(f) ? 'street' : isOddSpot(f) ? 'odd' : null;
    if (!kind) continue;
    const key = `${kind}:${f.coord[0].toFixed(4)},${f.coord[1].toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const where = placeAlong(f.coord, base, cum);
    if (!where) continue;
    out.push({ coord: f.coord, kind, name: f.name, along: where.along, side: where.side, isNew: !visited || !visited.has(f.coord) });
  }
  return out;
}

// ---- Labels ------------------------------------------------------------------------

export function describe(through: string[], culDeSacs: number, passes: string[]): string {
  const parts: string[] = [];
  if (through.length) parts.push(`Through ${joinNames(through)}`);
  if (culDeSacs) parts.push(`${culDeSacs} cul-de-sac${culDeSacs === 1 ? '' : 's'}`);
  if (passes.length) parts.push(`passes ${joinNames(passes)}`);
  return parts.length ? parts.join(' · ') : 'Winds through residential side streets';
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

async function neighborhoodsOn(spots: Via[], skip: Set<string>): Promise<string[]> {
  const sample = spots.filter((_, i) => spots.length <= 6 || i % Math.ceil(spots.length / 6) === 0);
  const names = await Promise.all(sample.map((s) => areaName(s.coord).catch(() => null)));
  const out: string[] = [];
  for (const n of names) if (n && !skip.has(n) && !out.includes(n)) out.push(n);
  return out.slice(0, 3);
}

// ---- Building the menu ---------------------------------------------------------------

export interface BuildOptions {
  rules?: RoadRules;
  /** Streets from recorded drives, to favor new ones. */
  visited?: VisitedStreets | null;
  onRoute?: (all: RouteOption[]) => void;
  rand?: () => number;
  /** Routes per level (each a different random pick). */
  variants?: number;
}

/**
 * Builds the menu of routes to `dest`, fastest first. `onRoute` is called as
 * each one arrives, so the list can fill in while the rest are worked out.
 */
export async function buildFunRoutes(origin: LngLat, dest: LngLat, opts: BuildOptions = {}): Promise<RouteOption[]> {
  const rules = opts.rules ?? NO_RULES;
  const rand = opts.rand ?? Math.random;
  const visited = opts.visited ?? null;
  const variants = opts.variants ?? 2;
  const found: RouteOption[] = [];
  const add = (r: RouteOption | null) => {
    if (!r) return;
    found.push(r);
    opts.onRoute?.(dedupe(found));
  };

  const base = await routeWithRules([origin, dest], rules);
  if (!base) return [];
  add({
    id: 'fastest',
    style: 'fastest',
    level: 0,
    title: 'Quickest',
    blurb: rules.noFreeways || rules.noHighways ? 'The quickest way that follows your switches' : 'The usual quickest way',
    durationS: base.durationS,
    distanceM: base.distanceM,
    coords: base.coords,
    via: [],
    through: [],
    passes: [],
    culDeSacs: 0,
    newShare: visited?.newShare(base.coords) ?? null,
    usesHighway: base.usesHighway,
    highwayM: highwayMeters(base.steps),
  });

  const candidates = await gatherCandidates(base.coords, visited);
  const [fromArea, toArea] = await Promise.all([areaName(origin).catch(() => null), areaName(dest).catch(() => null)]);
  const skip = new Set([fromArea, toArea].filter((x): x is string => !!x));

  const jobs: (() => Promise<RouteOption | null>)[] = [];
  LEVELS.forEach((level, li) => {
    for (let v = 0; v < variants; v++) {
      jobs.push(async () => {
        let spots = pickSpots(candidates, base.distanceM, level, rand);
        if (!spots.length) return null;
        let r = await routeThrough([origin, ...spots.map((s) => s.coord), dest], rules).catch(() => null);
        if (!r) return null;
        // Drop spots the route only poked into and backed out of, and route again.
        const stubs = stubSpots(r.coords, spots);
        if (stubs.size) {
          const kept = spots.filter((_, i) => !stubs.has(i));
          const again = kept.length ? await routeThrough([origin, ...kept.map((s) => s.coord), dest], rules).catch(() => null) : null;
          if (again) {
            spots = kept;
            r = again;
          }
        }
        // A route that wandered off far beyond what was asked isn't fun, it's broken.
        if (r.durationS > base.durationS * 4 && r.durationS > base.durationS + 45 * 60) return null;
        const via = spots.map(({ coord, kind, name }) => ({ coord, kind, name }));
        const passes = [...new Set(spots.filter((s) => s.kind === 'odd').map((s) => s.name))].slice(0, 2);
        const culDeSacs = spots.filter((s) => s.kind === 'culdesac').length;
        const through = await neighborhoodsOn(via, skip);
        return {
          id: `weave-${li + 1}-${v}-${Math.round(r.durationS)}`,
          style: 'weave' as const,
          level: li + 1,
          title: level.title,
          blurb: describe(through, culDeSacs, passes),
          durationS: r.durationS,
          distanceM: r.distanceM,
          coords: r.coords,
          via,
          through,
          passes,
          culDeSacs,
          newShare: visited?.newShare(r.coords) ?? null,
          usesHighway: r.usesHighway,
          highwayM: highwayMeters(r.steps),
        };
      });
    }
  });
  for (let i = 0; i < jobs.length; i += 3) {
    const batch = await Promise.all(jobs.slice(i, i + 3).map((j) => j().catch(() => null)));
    batch.forEach(add);
  }
  return dedupe(found);
}

/** Drops near-duplicates (within 90 seconds and 4% distance) and sorts fastest first. */
export function dedupe(routes: RouteOption[]): RouteOption[] {
  const sorted = [...routes].sort((a, b) => a.durationS - b.durationS);
  const fastest = sorted.find((r) => r.style === 'fastest');
  const out: RouteOption[] = [];
  for (const r of sorted) {
    // A "fun" route that's really just the quick way isn't worth listing.
    if (r.style !== 'fastest' && fastest && r.durationS < fastest.durationS + 60) continue;
    const twin = out.find(
      (o) => Math.abs(o.durationS - r.durationS) < 90 && Math.abs(o.distanceM - r.distanceM) < Math.max(o.distanceM, r.distanceM) * 0.04,
    );
    if (twin) continue;
    out.push(r);
  }
  return out;
}

// ---- Surprise destinations --------------------------------------------------

const SCENIC_MAKI = new Set(['park', 'garden', 'viewpoint', 'beach', 'mountain', 'natural', 'picnic-site', 'campsite', 'golf', 'marine-terminal', 'harbor', 'water', 'wetland']);
const LANDMARK_MAKI = new Set([
  'monument', 'museum', 'castle', 'attraction', 'landmark', 'art-gallery', 'theatre', 'town-hall',
  'religious-christian', 'religious-jewish', 'religious-muslim', 'religious-buddhist', 'lighthouse',
  'stadium', 'zoo', 'aquarium', 'amusement-park', 'observation-tower', 'historic',
]);
const STREET_CLASSES = new Set(['street', 'street_limited', 'tertiary', 'secondary']);
const SURPRISE_MAKI = new Set([...SCENIC_MAKI, ...LANDMARK_MAKI, 'cafe', 'ice-cream', 'bakery', 'restaurant', 'fast-food', 'bar', 'shop']);

/**
 * Picks a random destination: somewhere between 40% and 100% of `radiusM`
 * from `center` (so it's a real drive), or anywhere inside `area` when given.
 * It prefers a named, fun place near the random spot over a bare street corner.
 */
export async function pickSurprise(
  opts: { center: LngLat; radiusM: number; fromHere: boolean; area?: Place },
  rand: () => number = Math.random,
): Promise<Place> {
  const spot: LngLat = opts.area?.bbox
    ? randomPointInBox(opts.area.bbox, rand)
    : opts.fromHere
      ? randomPointInRing(opts.center, opts.radiusM * 0.4, opts.radiusM, rand)
      : randomPointInRing(opts.center, 0, opts.radiusM, rand);
  try {
    const found = await nearby(spot, 2500, ['poi_label']);
    const fun = found.filter((f) => f.name && SURPRISE_MAKI.has(f.maki));
    const pool = fun.length ? fun : found.filter((f) => f.name);
    if (pool.length) {
      const pick = pool[Math.floor(rand() * Math.min(pool.length, 6))];
      return { name: pick.name, detail: 'Surprise destination', coord: pick.coord, kind: 'poi' };
    }
    const roads = await nearby(spot, 1500, ['road']);
    const road = roads.find((f) => STREET_CLASSES.has(f.cls));
    if (road) return { name: road.name || 'A random street', detail: 'Surprise destination', coord: road.coord, kind: 'street' };
  } catch {
    // fall through to the raw spot
  }
  return { name: 'A random spot', detail: 'Surprise destination', coord: spot, kind: 'spot' };
}
