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
import { cumulative, distance, project, thin, type LngLat } from './geo';
import { areaName, nearby, type NearbyFeature, type Place } from './places';
import {
  bandAround,
  buildGraph,
  estimateS,
  type Dip,
  fetchStreets,
  findDips,
  nearestNode,
  pathCoords,
  planRoute,
  quickEdges,
  quickPath,
  spliceFor,
  streetRuns,
  STYLES,
  withDips,
} from './streetgraph';
import { streetsFromTiles } from './streettiles';

export type RouteStyle = 'fastest' | 'weave';

export interface RoadRules {
  noFreeways: boolean;
  noHighways: boolean;
}

export const NO_RULES: RoadRules = { noFreeways: false, noHighways: false };

export type ViaKind = 'street' | 'main' | 'culdesac' | 'odd';

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
  /** Street-by-street routes: the streets in order (for checking and labels). */
  streets?: string[];
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

const MAIN_STREETS = new Set(['primary', 'secondary', 'tertiary']);

/** A different main street to swing over to (not a freeway or highway on-ramp). */
export function isMainStreet(f: Pick<NearbyFeature, 'layer' | 'cls' | 'type'>): boolean {
  return f.layer === 'road' && MAIN_STREETS.has(f.cls) && !/link/.test(f.type);
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
  /** How far the route swings to each side of the quick way, in meters. */
  amplitude: number;
  /** Distance along the trip for one full swing up and back down, in meters. */
  wavelength: number;
  /** Spots are about this far apart along the trip. Close enough that a main road is never a shortcut between two. */
  spacing: number;
  /** Longest stretch without a turn before a side street is added there. */
  maxStraight: number;
  culPer10km: number;
  minCul: number;
  maxCul: number;
  /** At most this many spots, so very long trips stay sensible. */
  maxSpots: number;
  odds: number;
  /** Time budget, as a multiple of the quickest way (0 = no limit). Over it, the route keeps every other spot. */
  budget: number;
  title: string;
}

export const LEVELS: Level[] = [
  { amplitude: 500, wavelength: 6000, spacing: 1500, maxStraight: 3000, culPer10km: 0.5, minCul: 0, maxCul: 1, maxSpots: 12, odds: 0, budget: 1.2, title: 'A little detour' },
  { amplitude: 800, wavelength: 5000, spacing: 1100, maxStraight: 1200, culPer10km: 1, minCul: 1, maxCul: 2, maxSpots: 30, odds: 1, budget: 1.45, title: 'A few side streets' },
  { amplitude: 1000, wavelength: 4200, spacing: 800, maxStraight: 900, culPer10km: 1.5, minCul: 1, maxCul: 4, maxSpots: 45, odds: 1, budget: 1.8, title: 'Side-street wander' },
  { amplitude: 1200, wavelength: 3600, spacing: 550, maxStraight: 650, culPer10km: 2.5, minCul: 2, maxCul: 6, maxSpots: 70, odds: 2, budget: 2.4, title: 'Neighborhood zigzag' },
  { amplitude: 1400, wavelength: 3000, spacing: 400, maxStraight: 500, culPer10km: 4, minCul: 2, maxCul: 9, maxSpots: 100, odds: 2, budget: 3, title: 'Deep zigzag' },
  { amplitude: 1600, wavelength: 2600, spacing: 280, maxStraight: 400, culPer10km: 6, minCul: 3, maxCul: 12, maxSpots: 140, odds: 3, budget: 4, title: 'Every nook' },
];

/** Spots closer than this to the quick way just touch the corner of a side street. */
const MIN_REACH = 90;

/**
 * Where the route should be, sideways, at a point along the trip: a zigzag
 * that swings out to one side, back across the quick way, out to the other
 * side and so on. It eases in near the start and out near the end, so the
 * route leaves and arrives on the quick way. Signed meters, + = left.
 */
export function swingAt(along: number, tripM: number, level: Level, phase: number): number {
  const ramp = Math.min(1, along / 700, (tripM - along) / 700);
  if (ramp <= 0) return 0;
  const t = along / level.wavelength + phase;
  const tri = 1 - 4 * Math.abs(t - Math.floor(t + 0.5)); // -1..1 triangle wave
  return Math.max(-1, Math.min(1, tri * 1.25)) * level.amplitude * ramp; // flattened peaks: ride the far main street a bit
}

/**
 * Chooses the spots for one route, in order along the way. Every
 * `spacing` meters there's a target point on the zigzag; the spot is the
 * candidate closest to it. Near the peaks of the zigzag it prefers a main
 * street (so the route comes out onto a different main road for a while);
 * elsewhere residential streets. Some spots are cul-de-sacs or odd spots.
 */
export function pickSpots(candidates: Candidate[], tripM: number, level: Level, rand: () => number): Candidate[] {
  const lo = tripM * 0.03;
  const hi = tripM * 0.97;
  const spacing = Math.max(level.spacing, (hi - lo) / level.maxSpots);
  const n = Math.max(2, Math.round((hi - lo) / spacing));
  const step = (hi - lo) / n;
  const phase = rand() < 0.5 ? 0.25 : 0.75; // start by swinging left or right
  const bins: { at: number; target: number; peak: boolean; pool: Candidate[] }[] = [];
  for (let i = 0; i < n; i++) {
    const at = lo + step * (i + 0.5);
    const target = swingAt(at, tripM, level, phase);
    bins.push({ at, target, peak: Math.abs(target) > level.amplitude * 0.85, pool: [] });
  }
  for (const c of candidates) {
    const i = Math.floor((c.along - lo) / step);
    if (i < 0 || i >= n) continue;
    if (c.kind !== 'odd' && Math.abs(c.side) < MIN_REACH) continue;
    if (Math.abs(c.side) > level.amplitude * 1.3 + 200) continue;
    bins[i].pool.push(c);
  }

  // Which spots are cul-de-sacs or odd spots: only where one sits near the zigzag.
  const near = (b: (typeof bins)[number], c: Candidate) => Math.abs(c.side - b.target) < Math.max(250, level.amplitude * 0.35);
  const special = new Map<number, ViaKind>();
  const assign = (kind: ViaKind, count: number) => {
    const open = bins.map((_, i) => i).filter((i) => !special.has(i) && bins[i].pool.some((c) => c.kind === kind && near(bins[i], c)));
    shuffle(open, rand);
    for (const i of open.slice(0, count)) special.set(i, kind);
  };
  assign('culdesac', Math.min(level.maxCul, Math.max(level.minCul, Math.round((level.culPer10km * tripM) / 10000))));
  assign('odd', level.odds);

  const picked: Candidate[] = [];
  bins.forEach((bin, i) => {
    const want: ViaKind = special.get(i) ?? (bin.peak ? 'main' : 'street');
    let pool = bin.pool.filter((c) => c.kind === want && near(bin, c));
    if (!pool.length && want === 'main') pool = bin.pool.filter((c) => c.kind === 'street' && near(bin, c));
    if (!pool.length) pool = bin.pool.filter((c) => (c.kind === 'street' || c.kind === 'main') && near(bin, c));
    if (!pool.length) return;
    // Closest to the zigzag wins, new streets get a head start.
    const scored = pool
      .map((c) => ({ c, score: Math.abs(c.side - bin.target) - (c.isNew ? 120 : 0) + rand() * 90 }))
      .sort((a, b) => a.score - b.score);
    const choice = scored[0].c;
    const last = picked[picked.length - 1];
    if (last && distance(last.coord, choice.coord) < 110) {
      // Too close to the previous spot: a cul-de-sac or odd spot wins over a plain street.
      if (choice.kind === 'street' || choice.kind === 'main' || last.kind === 'culdesac' || last.kind === 'odd') return;
      picked.pop();
    }
    picked.push(choice);
  });
  return picked.sort((a, b) => a.along - b.along);
}

/**
 * Long stretches without a turn: points along any step longer than
 * `maxStraight`, where a side street should be added. Skips the first and
 * last bit of the trip.
 */
export function straightStretches(steps: Step[], maxStraight: number, tripM: number): LngLat[] {
  const out: LngLat[] = [];
  let done = 0;
  for (const s of steps) {
    const c = s.geometry?.coordinates ?? [];
    const startAt = done;
    done += s.distance;
    if (s.distance <= maxStraight || c.length < 2) continue;
    const cum = cumulative(c);
    const len = cum[cum.length - 1];
    const pieces = Math.floor(len / (maxStraight * 0.85));
    for (let k = 1; k <= pieces; k++) {
      const m = (len * k) / (pieces + 1);
      const absolute = startAt + m;
      if (absolute < 400 || absolute > tripM - 400) continue;
      out.push(pointAlong(c, cum, m).at);
    }
  }
  return out;
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

// Mapbox allows a few hundred route requests a minute; keep a handful in flight and back off when told to.
let inFlight = 0;
const waiting: (() => void)[] = [];
const started: number[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (inFlight >= 6) await new Promise<void>((resolve) => waiting.push(resolve));
  // Stay under about 250 requests a minute.
  for (;;) {
    const now = Date.now();
    while (started.length && now - started[0] > 60000) started.shift();
    if (started.length < 250) break;
    await new Promise((r) => setTimeout(r, 60000 - (now - started[0]) + 50));
  }
  started.push(Date.now());
  inFlight++;
  try {
    return await work();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

async function fetchWithRetry(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await slot(() => fetch(url));
    if (res.status !== 429 || attempt >= 3) return res;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

/**
 * Drive time along an exact path, from Mapbox's map matching (the same way
 * turn-by-turn will follow it). Null if Mapbox can't follow it.
 */
export async function timeAlong(coords: LngLat[]): Promise<{ durationS: number; distanceM: number } | null> {
  const keep = thin(coords, 40).map((i) => coords[i]);
  if (keep.length < 2) return null;
  const pieces: LngLat[][] = [];
  for (let i = 0; i < keep.length - 1; i += 99) pieces.push(keep.slice(i, Math.min(keep.length, i + 100)));
  const results = await Promise.all(
    pieces.map(async (piece) => {
      if (piece.length < 2) return { d: 0, m: 0 };
      const params = new URLSearchParams({
        access_token: MAPBOX_TOKEN,
        geometries: 'geojson',
        overview: 'false',
        radiuses: piece.map(() => '20').join(';'),
        waypoints: `0;${piece.length - 1}`,
      });
      const path = piece.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
      const res = await fetchWithRetry(`https://api.mapbox.com/matching/v5/mapbox/driving/${path}?${params}`);
      if (!res.ok) return null;
      const body = await res.json();
      const ms: any[] = body?.matchings ?? [];
      if (body?.code !== 'Ok' || !ms.length) return null;
      return { d: ms.reduce((a, m) => a + (m.duration ?? 0), 0), m: ms.reduce((a, m) => a + (m.distance ?? 0), 0) };
    }),
  );
  // A piece Mapbox couldn't match (a gap, a private road) is timed at the
  // average speed of the rest, unless too many failed to trust it.
  const ok = results.filter((r): r is { d: number; m: number } => !!r && r.m > 0);
  if (ok.length < results.length * 0.7 || !ok.length) return null;
  const speed = ok.reduce((a, r) => a + r.m, 0) / Math.max(1, ok.reduce((a, r) => a + r.d, 0));
  let d = 0;
  let m = 0;
  results.forEach((r, i) => {
    if (r && r.m > 0) {
      d += r.d;
      m += r.m;
    } else {
      const len = cumulative(pieces[i]).pop() ?? 0;
      d += len / speed;
      m += len;
    }
  });
  return { durationS: d, distanceM: m };
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
  const res = await fetchWithRetry(`https://api.mapbox.com/directions/v5/mapbox/driving/${path}?${params}${excludeParam}`);
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
  // A spot Mapbox can't reach (a gated street, say) shouldn't sink the whole
  // route: retry that piece with fewer spots, then with just its two ends.
  const robust = async (p: LngLat[]) => {
    const tries = [p, p.filter((_, i) => i === 0 || i === p.length - 1 || i % 2 === 0), [p[0], p[p.length - 1]]];
    for (const t of tries) {
      const r = await routeWithRules(t, rules, continueStraight).catch(() => null);
      if (r) return r;
    }
    return null;
  };
  const results = await Promise.all(pieces.map(robust));
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
    if (v.kind !== 'street' && v.kind !== 'main') return;
    const back = pointAlong(coords, cum, cum[best] - 120).at;
    const fwd = pointAlong(coords, cum, cum[best] + 120).at;
    if (distance(back, fwd) < 40) out.add(k);
  });
  return out;
}

/**
 * Swaps each stub spot (one the route only pokes into and backs out of) for
 * a nearby through-street on the same side, so the route keeps weaving
 * without turning around mid-street.
 */
export function swapStubs(spots: Candidate[], stubs: Set<number>, candidates: Candidate[], rand: () => number): Candidate[] {
  const used = new Set(spots);
  const tried = new Set<Candidate>();
  return spots.map((sp, i) => {
    if (!stubs.has(i)) return sp;
    tried.add(sp);
    let best: Candidate | null = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      if (c.kind !== 'street' && c.kind !== 'main') continue;
      if (used.has(c) || tried.has(c) || Math.sign(c.side) !== Math.sign(sp.side) || c.name === sp.name) continue;
      const d = distance(c.coord, sp.coord);
      if (d < 60 || d > 450) continue;
      const score = d + Math.abs(Math.abs(c.side) - Math.abs(sp.side)) * 0.5 - (c.isNew ? 80 : 0) + rand() * 60;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) return sp;
    used.add(best);
    return best;
  });
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
  const stepM = Math.min(1000, Math.max(400, len / 24));
  const jobs: (() => Promise<NearbyFeature[]>)[] = [];
  let k = 0;
  for (let m = Math.min(300, len / 2); m < len - 150; m += stepM, k++) {
    const { at, heading } = pointAlong(base, cum, m);
    // Two rings each side: close in, and out where the zigzag swings to the next main streets.
    for (const side of [-90, 90]) {
      for (const [offset, radius] of [[450, Math.max(560, stepM * 0.7)], [1250, Math.max(650, stepM * 0.75)]]) {
        const c = destinationPoint(at, heading + side, offset);
        jobs.push(() => nearby(c, radius, ['road'], 50, { geometry: 'linestring' }).catch(() => []));
        if (offset < 1000 || k % 2 === 0) jobs.push(() => nearby(c, radius * 1.05, ['road'], 50, { geometry: 'point', dedupe: false }).catch(() => []));
      }
    }
    if (k % 2 === 0) jobs.push(() => nearby(at, Math.max(450, stepM * 0.8), ['poi_label'], 40).catch(() => []));
  }
  const found = (await inBatches(jobs, 10)).flat();

  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    const kind: ViaKind | null = isCulDeSac(f) ? 'culdesac' : isQuietStreet(f) ? 'street' : isMainStreet(f) ? 'main' : isOddSpot(f) ? 'odd' : null;
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

// ---- Street-by-street routes ---------------------------------------------------------

/** Shorter options: mostly the quick way, with side-street stretches adding about this much time. */
export const SHORT_TIERS = [
  { title: 'A little detour', share: 0.1, minS: 5 * 60, style: 1, culDeSacs: 1 },
  { title: 'Some side streets', share: 0.2, minS: 9 * 60, style: 1, culDeSacs: 1 },
  { title: 'Half and half', share: 0.4, minS: 15 * 60, style: 2, culDeSacs: 2 },
];

/**
 * Fun routes planned street by street (see streetgraph.ts): real chains of
 * connecting streets that keep heading toward the destination. Two kinds:
 *  - shorter ones: the quick way with a few side-street stretches, adding
 *    roughly 10%, 20% and 40% to the trip;
 *  - full ones: side streets the whole way, two per style from "a few side
 *    streets" to "every nook", each a different combination.
 */
async function streetRoutes(
  origin: LngLat,
  dest: LngLat,
  base: { coords: LngLat[]; distanceM: number; durationS: number },
  opts: { rules: RoadRules; rand: () => number; visited: VisitedStreets | null; variants: number },
  add: (r: RouteOption) => void,
): Promise<number> {
  const halfWidth = Math.min(2200, Math.max(1200, base.distanceM * 0.12));
  // Streets from Mapbox's map tiles; OpenStreetMap's public server as a backup.
  const ways = await streetsFromTiles(base.coords, halfWidth).catch(() => fetchStreets(bandAround(base.coords, halfWidth)));
  const g = buildGraph(ways);
  const a = nearestNode(g, origin);
  const b = nearestNode(g, dest);
  if (a == null || b == null) return 0;
  const quick = quickEdges(g, base.coords);
  const quickNames = new Set([...quick].map((e) => g.edges[e].name).filter(Boolean));
  const noHighways = opts.rules.noHighways;
  const used = new Map<number, number>();
  let made = 0;
  const jobs: (() => Promise<void>)[] = [];

  const emit = (id: string, level: number, title: string, path: number[], dips: Dip[]) => {
    const full = withDips(path, dips);
    const coords: LngLat[] = [origin, ...pathCoords(g, full), dest];
    const runs = streetRuns(g, path);
    // The streets worth naming: the bigger ones it switches onto, in order.
    const via: string[] = [];
    for (const r of runs) {
      if (!r.name || r.len < 350 || via.includes(r.name) || quickNames.has(r.name)) continue;
      if (r.cls === 'residential' || r.cls === 'living_street' || r.cls === 'link') continue;
      via.push(r.name);
    }
    const guessS = estimateS(g, full) * speedFix;
    jobs.push(async () => {
      // Mapbox's time along the exact streets; a rough estimate if that fails.
      const t = (await timeAlong(coords).catch(() => null)) ?? { durationS: guessS, distanceM: cumulative(coords).pop() ?? 0 };
      made++;
      const smallStreets = runs.filter((r) => r.cls === 'residential' || r.cls === 'living_street' || r.cls === 'unclassified').length;
      const parts: string[] = [];
      if (via.length) parts.push(`Via ${joinNames(via.slice(0, 3))}`);
      if (smallStreets) parts.push(`${smallStreets} little street${smallStreets === 1 ? '' : 's'}`);
      if (dips.length) parts.push(`${dips.length} cul-de-sac${dips.length === 1 ? '' : 's'}`);
      add({
        id: `${id}-${Math.round(t.durationS)}`,
        style: 'weave',
        level,
        title,
        blurb: parts.join(' · ') || 'Winds through residential side streets',
        durationS: t.durationS,
        distanceM: t.distanceM,
        coords,
        via: dips.map((d) => ({ coord: d.tip, kind: 'culdesac' as const, name: '' })),
        through: via,
        passes: [],
        culDeSacs: dips.length,
        newShare: opts.visited?.newShare(coords) ?? null,
        usesHighway: noHighways && path.some((e) => g.edges[e].highway),
        highwayM: path.filter((e) => g.edges[e].highway).reduce((x, e) => x + g.edges[e].len, 0),
        streets: runs.filter((r) => r.len >= 60).map((r) => r.name || '(unnamed)'),
      });
    });
  };

  // The quick way through the street graph, and how our rough times compare to Mapbox's.
  const qpath = quickPath(g, a, b, quick, noHighways);
  const qEst = qpath && qpath.length ? estimateS(g, qpath) : 0;
  const speedFix = qEst > 0 ? Math.min(2, Math.max(0.5, base.durationS / qEst)) : 1;

  // Full routes: side streets the whole way.
  let fullExtra = Infinity;
  STYLES.forEach((style, si) => {
    for (let v = 0; v < opts.variants; v++) {
      const path = planRoute(g, a, b, style, quick, { noHighways, rand: opts.rand, used });
      if (!path || !path.length) continue;
      for (const e of path) used.set(e, (used.get(e) ?? 0) + 1);
      const dips = findDips(g, path, style.culDeSacs, opts.rand);
      if (qEst) fullExtra = Math.min(fullExtra, estimateS(g, withDips(path, dips)) - qEst);
      emit(`street-${si + 1}-${v}`, si + 2, style.title, path, dips);
    }
  });

  // Shorter routes: the quick way with side-street stretches, if they'd really be shorter.
  if (qpath && qpath.length > 4) {
    SHORT_TIERS.forEach((tier, ti) => {
      const extraS = Math.max(tier.minS, base.durationS * tier.share) / speedFix;
      if (extraS > fullExtra * 0.8) return;
      const variants = ti < 2 ? opts.variants : 1;
      for (let v = 0; v < variants; v++) {
        const r = spliceFor(g, qpath, extraS, STYLES[tier.style], quick, {
          noHighways,
          seed: Math.floor(opts.rand() * 1e9),
          shift: variants > 1 ? v / (variants - 1) : 0.5,
          used,
        });
        if (!r.stretches.length || r.extraS < 60) continue;
        for (const { from, to } of r.stretches) for (let i = from; i < to; i++) used.set(r.path[i], (used.get(r.path[i]) ?? 0) + 1);
        // Cul-de-sacs only on the side-street stretches, one per stretch.
        const dips: Dip[] = [];
        for (const st of r.stretches.slice(0, tier.culDeSacs)) {
          const piece = r.path.slice(st.from, st.to);
          for (const d of findDips(g, piece, 1, opts.rand)) dips.push({ ...d, after: d.after + st.from });
        }
        emit(`short-${ti + 1}-${v}`, 1, tier.title, r.path, dips);
      }
    });
  }

  for (let i = 0; i < jobs.length; i += 3) await Promise.all(jobs.slice(i, i + 3).map((j) => j().catch(() => {})));
  return made;
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
  /** Plan routes street by street (default), or only use the older spot-based weaving. */
  streetByStreet?: boolean;
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

  // First choice: plan routes street by street. If the street map can't be
  // loaded, fall back to the older spot-based weaving below.
  if (opts.streetByStreet !== false) {
    const made = await streetRoutes(origin, dest, base, { rules, rand, visited, variants }, add).catch(() => 0);
    if (made >= 2) return dedupe(found);
  }

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
          const again = kept.length ? await routeThrough([origin, ...kept.map((sp) => sp.coord), dest], rules).catch(() => null) : null;
          if (again) {
            spots = kept;
            r = again;
          }
        }
        // No long straight shots: wherever the route runs too far without a
        // turn, add the nearest side street there and route again (twice at most).
        for (let pass = 0; pass < 2; pass++) {
          const gaps = straightStretches(r.steps, level.maxStraight, r.distanceM);
          if (!gaps.length) break;
          const used = new Set(spots);
          const extra: Candidate[] = [];
          for (const g of gaps) {
            let best: Candidate | null = null;
            let bestScore = Infinity;
            for (const c of candidates) {
              // Only through-streets here; cul-de-sacs are counted and capped separately.
              if (used.has(c) || c.kind !== 'street') continue;
              const d = distance(g, c.coord);
              if (d < 120 || d > 700) continue;
              const score = d - (c.isNew ? 100 : 0);
              if (score < bestScore) {
                bestScore = score;
                best = c;
              }
            }
            if (best) {
              used.add(best);
              extra.push(best);
            }
          }
          if (!extra.length) break;
          const more = [...spots, ...extra].sort((a, b) => a.along - b.along);
          const again = await routeThrough([origin, ...more.map((s) => s.coord), dest], rules).catch(() => null);
          if (!again) break;
          spots = more;
          r = again;
        }
        // Over its time budget: keep every other spot (cul-de-sacs and odd spots stay) and route again, up to twice.
        for (let pass = 0; level.budget > 0 && pass < 3 && r.durationS > base.durationS * level.budget; pass++) {
          const fewer = spots.filter((sp, i) => sp.kind === 'culdesac' || sp.kind === 'odd' || i % 2 === 0);
          if (fewer.length === spots.length || fewer.length < 2) break;
          const again = await routeThrough([origin, ...fewer.map((sp) => sp.coord), dest], rules).catch(() => null);
          if (!again) break;
          spots = fewer;
          r = again;
        }
        // Last tidy-up: drop the few spots that still poke in and back out (never a big share, or the weave goes flat).
        const lateStubs = stubSpots(r.coords, spots);
        if (lateStubs.size && lateStubs.size <= Math.max(2, spots.length * 0.1)) {
          const kept = spots.filter((_, i) => !lateStubs.has(i));
          const again = kept.length ? await routeThrough([origin, ...kept.map((sp) => sp.coord), dest], rules).catch(() => null) : null;
          if (again) {
            spots = kept;
            r = again;
          }
        }
        // A route that wandered off far beyond what was asked isn't fun, it's broken.
        if (r.durationS > base.durationS * 12 && r.durationS > base.durationS + 180 * 60) return null;
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
