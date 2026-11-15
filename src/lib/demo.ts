// Demo mode, for App Store screenshots: built only when EXPO_PUBLIC_DEMO=1.
// Seeds three sample drives around Whittier, made from real Mapbox routes so
// they follow actual streets, and skips the welcome screen.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { MAPBOX_TOKEN } from '../config';
import type { LngLat } from './geo';
import { listDrives, renameDrive, saveDrive, type TrackPoint } from './storage';

export const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

/** Sample drives: start time (ms) and the spots each one passes through. */
export const DEMO_DRIVES: { startedAt: number; name: string | null; via: LngLat[] }[] = [
  {
    // Saturday, Nov 14, 8:42 PM: a loop through Hacienda Heights and La Habra Heights.
    startedAt: 1794717720000,
    name: null,
    via: [
      [-118.0328, 33.9792],
      [-117.9700, 33.9930],
      [-117.9575, 33.9600],
      [-118.0000, 33.9450],
      [-118.0328, 33.9792],
    ],
  },
  {
    // Saturday, Nov 7, 9:05 PM: up into the hills.
    startedAt: 1794114300000,
    name: 'Back roads to the hills',
    via: [
      [-118.0328, 33.9792],
      [-118.0150, 34.0100],
      [-117.9950, 34.0230],
      [-118.0328, 33.9792],
    ],
  },
  {
    // Saturday, Oct 31, 10:14 PM: a short neighborhood loop.
    startedAt: 1793510040000,
    name: null,
    via: [
      [-118.0328, 33.9792],
      [-118.0450, 33.9700],
      [-118.0250, 33.9620],
      [-118.0328, 33.9792],
    ],
  },
];

async function routeThrough(via: LngLat[]): Promise<LngLat[]> {
  const params = new URLSearchParams({ access_token: MAPBOX_TOKEN, geometries: 'geojson', overview: 'full' });
  const path = via.map((p) => `${p[0]},${p[1]}`).join(';');
  const res = await fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${path}?${params}`);
  const body = await res.json();
  return (body?.routes?.[0]?.geometry?.coordinates as LngLat[]) ?? [];
}

/** Turns a route line into fake GPS fixes, as if driven at about 12 m/s. */
function asTrack(line: LngLat[], startedAt: number): TrackPoint[] {
  const out: TrackPoint[] = [];
  let t = startedAt;
  for (let i = 0; i < line.length; i++) {
    if (i > 0) {
      const [a, b] = [line[i - 1], line[i]];
      const dx = (b[0] - a[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180);
      const dy = (b[1] - a[1]) * 110540;
      t += Math.max(1000, (Math.hypot(dx, dy) / 12) * 1000);
    }
    out.push([line[i][0], line[i][1], Math.round(t)]);
  }
  return out;
}

export async function seedDemo() {
  if (!DEMO) return;
  await AsyncStorage.setItem('joyride:welcomed:v1', '1');
  if ((await listDrives()).length > 0) return;
  for (const d of DEMO_DRIVES) {
    const line = await routeThrough(d.via).catch(() => []);
    if (line.length < 2) continue;
    const saved = await saveDrive(asTrack(line, d.startedAt));
    if (saved && d.name) await renameDrive(saved.id, d.name);
  }
}

/** Resolves once demo drives are in place (immediately outside demo builds). */
export const demoReady: Promise<void> = DEMO ? seedDemo().catch(() => {}) : Promise.resolve();
