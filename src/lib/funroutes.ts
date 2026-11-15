// Fun routes: several unconventional ways to the same destination, sorted
// from fastest to longest, plus picking a surprise destination.
//
// How a fun route is made: draw the straight line from you to the
// destination, pick spots off to the side of it (parks and viewpoints for
// Scenic, quiet streets for Neighborhoods, notable places for Landmarks…),
// and ask Mapbox for a driving route that passes through them. Bigger
// detours make longer routes.

import { MAPBOX_TOKEN } from '../config';
import { bearing, distance, type LngLat } from './geo';
import { nearby, type NearbyFeature, type Place } from './places';

export type RouteStyle = 'fastest' | 'scenic' | 'neighborhoods' | 'landmarks' | 'backroads' | 'random';

export const STYLE_LABELS: Record<RouteStyle, string> = {
  fastest: 'Fastest',
  scenic: 'Scenic',
  neighborhoods: 'Neighborhood wander',
  landmarks: 'Landmarks',
  backroads: 'Backroads',
  random: 'Random',
};

export interface RouteOption {
  id: string;
  style: RouteStyle;
  title: string;
  /** What makes it different, e.g. "Passes Oak Canyon Park". */
  blurb: string;
  durationS: number;
  distanceM: number;
  coords: LngLat[];
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

/**
 * Spots to detour through: `count` points spread along the line from origin
 * to destination, pushed sideways by about `sideM` meters, alternating sides
 * (or random sides when `rand` is given a non-default source).
 */
export function detourControlPoints(
  origin: LngLat,
  dest: LngLat,
  sideM: number,
  count: number,
  rand = Math.random,
): LngLat[] {
  const total = distance(origin, dest);
  const heading = bearing(origin, dest);
  const firstSide = rand() < 0.5 ? 1 : -1;
  const out: LngLat[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 1) / (count + 1);
    const along = destinationPoint(origin, heading, total * t);
    const side = count > 1 && i % 2 === 1 ? -firstSide : firstSide;
    const wobble = 0.75 + rand() * 0.5;
    out.push(destinationPoint(along, heading + 90 * side, sideM * wobble));
  }
  return out;
}

// ---- What each style looks for --------------------------------------------

const SCENIC_MAKI = new Set(['park', 'garden', 'viewpoint', 'beach', 'mountain', 'natural', 'picnic-site', 'campsite', 'golf', 'marine-terminal', 'harbor', 'water', 'wetland']);
const LANDMARK_MAKI = new Set([
  'monument', 'museum', 'castle', 'attraction', 'landmark', 'art-gallery', 'theatre', 'town-hall',
  'religious-christian', 'religious-jewish', 'religious-muslim', 'religious-buddhist', 'lighthouse',
  'stadium', 'zoo', 'aquarium', 'amusement-park', 'observation-tower', 'historic',
]);
const STREET_CLASSES = new Set(['street', 'street_limited', 'tertiary', 'secondary']);
const QUIET_STREET_CLASSES = new Set(['street', 'street_limited']);

function pickFeature(features: NearbyFeature[], style: RouteStyle, rand: () => number): NearbyFeature | null {
  let pool: NearbyFeature[] = [];
  if (style === 'scenic') {
    pool = features.filter((f) => (f.layer === 'poi_label' && (SCENIC_MAKI.has(f.maki) || f.cls === 'park_like')) || f.layer === 'natural_label');
  } else if (style === 'landmarks') {
    pool = features.filter((f) => f.layer === 'poi_label' && f.name && (LANDMARK_MAKI.has(f.maki) || f.cls === 'historic' || f.cls === 'landmark'));
  } else if (style === 'neighborhoods' || style === 'backroads') {
    pool = features.filter((f) => f.layer === 'road' && QUIET_STREET_CLASSES.has(f.cls));
  } else {
    pool = features.filter((f) => f.layer === 'road' && STREET_CLASSES.has(f.cls));
  }
  if (!pool.length) return null;
  // Prefer named places, and don't always take the closest one.
  const named = pool.filter((f) => f.name);
  const from = named.length ? named : pool;
  const top = from.slice(0, Math.min(5, from.length));
  return top[Math.floor(rand() * top.length)];
}

function layersFor(style: RouteStyle): string[] {
  if (style === 'scenic') return ['poi_label', 'natural_label'];
  if (style === 'landmarks') return ['poi_label'];
  return ['road'];
}

// ---- Directions ------------------------------------------------------------

interface DirectionsResult {
  durationS: number;
  distanceM: number;
  coords: LngLat[];
}

async function directions(points: LngLat[], opts: { exclude?: string } = {}): Promise<DirectionsResult | null> {
  if (points.length < 2) return null;
  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    geometries: 'geojson',
    overview: 'full',
    steps: 'true',
    // Detour spots shape the route without becoming stops.
    waypoints: `0;${points.length - 1}`,
  });
  if (opts.exclude) params.set('exclude', opts.exclude);
  const path = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
  const res = await fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${path}?${params}`);
  if (!res.ok) return null;
  const body = await res.json();
  const route = body?.routes?.[0];
  if (body?.code !== 'Ok' || !route?.geometry?.coordinates) return null;
  return {
    durationS: route.duration,
    distanceM: route.distance,
    coords: route.geometry.coordinates as LngLat[],
  };
}

// ---- Building the menu -------------------------------------------------------

/** Detour sizes, as a share of the trip's straight-line length. Bigger = longer route. */
const SIZES = [0.18, 0.4, 0.75];

/** How sideways a detour of `size` goes, in meters (short trips still get real detours). */
export function sidewaysMeters(tripM: number, size: number): number {
  return Math.max(1200, Math.max(tripM, 4000) * size);
}

async function styledRoute(
  origin: LngLat,
  dest: LngLat,
  style: RouteStyle,
  size: number,
  rand: () => number,
): Promise<RouteOption | null> {
  const trip = distance(origin, dest);
  const side = sidewaysMeters(trip, size);
  const count = size < 0.3 ? 1 : 2;
  const controls = detourControlPoints(origin, dest, side, count, rand);
  const via: LngLat[] = [];
  const names: string[] = [];
  for (const c of controls) {
    let spot = c;
    try {
      const found = await nearby(c, Math.max(800, side * 0.5), layersFor(style));
      const pick = pickFeature(found, style, rand);
      if (pick) {
        spot = pick.coord;
        if (pick.name && pick.layer !== 'road') names.push(pick.name);
      }
    } catch {
      // No nearby data: the raw spot still makes a detour.
    }
    via.push(spot);
  }
  const result = await directions([origin, ...via, dest], style === 'backroads' ? { exclude: 'motorway' } : {});
  if (!result) return null;
  return {
    id: `${style}-${size}-${Math.round(result.durationS)}`,
    style,
    title: STYLE_LABELS[style],
    blurb: blurbFor(style, names),
    ...result,
  };
}

function blurbFor(style: RouteStyle, names: string[]): string {
  const unique = [...new Set(names)].slice(0, 2);
  const list = unique.join(' and ');
  switch (style) {
    case 'scenic':
      return list ? `Passes ${list}` : 'Parks, water and views along the way';
    case 'landmarks':
      return list ? `Drives by ${list}` : 'Past places worth seeing';
    case 'neighborhoods':
      return 'Winds through quiet residential streets';
    case 'backroads':
      return 'Stays off the freeway';
    case 'random':
      return 'A surprise route, different every time';
    default:
      return 'The usual quickest way';
  }
}

/**
 * Builds the menu of routes to `dest`, fastest first. `onRoute` is called as
 * each one arrives, so the list can fill in while the rest are worked out.
 */
export async function buildFunRoutes(
  origin: LngLat,
  dest: LngLat,
  styles: RouteStyle[] = ['scenic', 'neighborhoods', 'landmarks', 'backroads', 'random'],
  onRoute?: (all: RouteOption[]) => void,
  rand: () => number = Math.random,
): Promise<RouteOption[]> {
  const found: RouteOption[] = [];
  const add = (r: RouteOption | null) => {
    if (!r) return;
    found.push(r);
    onRoute?.(dedupe(found));
  };

  const fastest = await directions([origin, dest]);
  if (fastest) {
    add({ id: 'fastest', style: 'fastest', title: 'Fastest', blurb: 'The usual quickest way', ...fastest });
  }
  const backroadsPlain = styles.includes('backroads') ? await directions([origin, dest], { exclude: 'motorway' }) : null;
  if (backroadsPlain) {
    add({ id: 'backroads-plain', style: 'backroads', title: 'Backroads', blurb: 'Stays off the freeway', ...backroadsPlain });
  }

  // Work out the styled routes a few at a time.
  const jobs: (() => Promise<RouteOption | null>)[] = [];
  for (const size of SIZES) {
    for (const style of styles) jobs.push(() => styledRoute(origin, dest, style, size, rand).catch(() => null));
  }
  const parallel = 3;
  for (let i = 0; i < jobs.length; i += parallel) {
    const batch = await Promise.all(jobs.slice(i, i + parallel).map((j) => j()));
    batch.forEach(add);
  }
  return dedupe(found);
}

/** Drops near-duplicates (within 2 minutes and 5% distance) and sorts fastest first. */
export function dedupe(routes: RouteOption[]): RouteOption[] {
  const sorted = [...routes].sort((a, b) => a.durationS - b.durationS);
  const fastest = sorted.find((r) => r.style === 'fastest');
  const out: RouteOption[] = [];
  for (const r of sorted) {
    // A "fun" route that's really just the fast way isn't worth listing.
    if (r.style !== 'fastest' && fastest && r.durationS < fastest.durationS * 1.06) continue;
    const twin = out.find(
      (o) => Math.abs(o.durationS - r.durationS) < 120 && Math.abs(o.distanceM - r.distanceM) < Math.max(o.distanceM, r.distanceM) * 0.05,
    );
    if (twin) continue;
    out.push(r);
  }
  return out;
}

// ---- Surprise destinations --------------------------------------------------

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
