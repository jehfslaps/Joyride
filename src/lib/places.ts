// Finding places with Mapbox: searching for a destination by name, and
// looking up what's near a point (parks, viewpoints, landmarks, streets).

import { MAPBOX_TOKEN } from '../config';
import type { LngLat } from './geo';

const API = 'https://api.mapbox.com';

export interface Place {
  name: string;
  /** Second line, e.g. "Laguna Beach, California". */
  detail: string;
  coord: LngLat;
  /** Area covered, when the result is a region or city: [minLng, minLat, maxLng, maxLat]. */
  bbox?: [number, number, number, number];
  kind: string;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (res.status === 401 || res.status === 403) throw new Error('Mapbox rejected the access token.');
  if (!res.ok) throw new Error(`Mapbox error ${res.status}`);
  return res.json();
}

/** Search for a destination by name or address, preferring results near `near`. */
export async function searchPlaces(query: string, near?: LngLat): Promise<Place[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({ q, access_token: MAPBOX_TOKEN, limit: '6', language: 'en' });
  if (near) params.set('proximity', `${near[0]},${near[1]}`);
  try {
    // Search Box finds businesses and landmarks as well as addresses.
    const body = await getJson(`${API}/search/searchbox/v1/forward?${params}`);
    const out = parseFeatures(body);
    if (out.length) return out;
  } catch {
    // fall back to plain geocoding below
  }
  const body = await getJson(`${API}/search/geocode/v6/forward?${params}`);
  return parseFeatures(body);
}

/** Search only for areas (cities, regions, neighborhoods), for "end up somewhere in…". */
export async function searchAreas(query: string, near?: LngLat): Promise<Place[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({
    q,
    access_token: MAPBOX_TOKEN,
    limit: '6',
    language: 'en',
    types: 'region,district,place,locality,neighborhood,postcode',
  });
  if (near) params.set('proximity', `${near[0]},${near[1]}`);
  const body = await getJson(`${API}/search/geocode/v6/forward?${params}`);
  return parseFeatures(body);
}

function parseFeatures(body: any): Place[] {
  const features: any[] = Array.isArray(body?.features) ? body.features : [];
  const out: Place[] = [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const c = p.coordinates;
    const coord: LngLat | null =
      c && typeof c.longitude === 'number'
        ? [c.longitude, c.latitude]
        : Array.isArray(f?.geometry?.coordinates)
          ? [f.geometry.coordinates[0], f.geometry.coordinates[1]]
          : null;
    if (!coord) continue;
    const bbox = Array.isArray(p.bbox) && p.bbox.length === 4 ? (p.bbox as [number, number, number, number]) : undefined;
    out.push({
      name: p.name_preferred || p.name || p.full_address || 'Unnamed place',
      detail: p.place_formatted || p.full_address || '',
      coord,
      bbox,
      kind: p.feature_type || 'place',
    });
  }
  return out;
}

// ---- What's near a point ---------------------------------------------------

export interface NearbyFeature {
  coord: LngLat;
  name: string;
  layer: string;
  cls: string;
  maki: string;
  /** Road type for streets, e.g. "residential". */
  type: string;
  distanceM: number;
}

/**
 * Features of Mapbox's street map near a point, nearest first.
 * Layers used here: poi_label (named places), road (streets), natural_label.
 */
export async function nearby(
  at: LngLat,
  radiusM: number,
  layers: string[],
  limit = 50,
  opts: { geometry?: 'point' | 'linestring' | 'polygon'; dedupe?: boolean } = {},
): Promise<NearbyFeature[]> {
  const params = new URLSearchParams({
    radius: String(Math.round(radiusM)),
    limit: String(Math.min(50, Math.max(1, limit))),
    layers: layers.join(','),
    access_token: MAPBOX_TOKEN,
  });
  if (opts.geometry) params.set('geometry', opts.geometry);
  if (opts.dedupe === false) params.set('dedupe', 'false');
  const url = `${API}/v4/mapbox.mapbox-streets-v8/tilequery/${at[0].toFixed(6)},${at[1].toFixed(6)}.json?${params}`;
  const body = await getJson(url);
  const features: any[] = Array.isArray(body?.features) ? body.features : [];
  return features
    .filter((f) => Array.isArray(f?.geometry?.coordinates))
    .map((f) => ({
      coord: [f.geometry.coordinates[0], f.geometry.coordinates[1]] as LngLat,
      name: f.properties?.name ?? '',
      layer: f.properties?.tilequery?.layer ?? '',
      cls: f.properties?.class ?? '',
      maki: f.properties?.maki ?? '',
      type: f.properties?.type ?? '',
      distanceM: f.properties?.tilequery?.distance ?? 0,
    }));
}

/** The neighborhood (or, failing that, town) a point is in. */
const areaCache = new Map<string, string | null>();
export async function areaName(at: LngLat): Promise<string | null> {
  const key = `${at[0].toFixed(3)},${at[1].toFixed(3)}`;
  if (areaCache.has(key)) return areaCache.get(key) ?? null;
  let name: string | null = null;
  for (const types of ['neighborhood', 'locality,place']) {
    const params = new URLSearchParams({
      longitude: at[0].toFixed(6),
      latitude: at[1].toFixed(6),
      types,
      limit: '1',
      language: 'en',
      access_token: MAPBOX_TOKEN,
    });
    try {
      const body = await getJson(`${API}/search/geocode/v6/reverse?${params}`);
      const p = body?.features?.[0]?.properties;
      name = p?.name_preferred || p?.name || null;
    } catch {
      name = null;
    }
    if (name) break;
  }
  areaCache.set(key, name);
  return name;
}
