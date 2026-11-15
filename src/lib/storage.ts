import AsyncStorage from '@react-native-async-storage/async-storage';
import { JoyrideNav } from '../../modules/joyride-nav';
import { lineLength, thin, type LngLat } from './geo';
import type { NavRoute } from './route';

/** One GPS fix: [longitude, latitude, unix time in ms]. */
export type TrackPoint = [number, number, number];

export interface DriveSummary {
  id: string;
  name: string | null;
  startedAt: number;
  endedAt: number;
  distanceM: number;
  /** Start and end, handy for showing on the list without loading every point. */
  start: LngLat;
  end: LngLat;
}

const INDEX_KEY = 'joyride:drives';
const pointsKey = (id: string) => `joyride:drive:${id}:points`;
const routeKey = (id: string) => `joyride:drive:${id}:route`;

async function readIndex(): Promise<DriveSummary[]> {
  const raw = await AsyncStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as DriveSummary[];
  } catch {
    return [];
  }
}

async function writeIndex(list: DriveSummary[]) {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(list));
}

export async function listDrives(): Promise<DriveSummary[]> {
  const list = await readIndex();
  return list.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getDrive(id: string): Promise<DriveSummary | null> {
  const list = await readIndex();
  return list.find((d) => d.id === id) ?? null;
}

export async function getDrivePoints(id: string): Promise<TrackPoint[]> {
  const raw = await AsyncStorage.getItem(pointsKey(id));
  return raw ? (JSON.parse(raw) as TrackPoint[]) : [];
}

export async function saveDrive(points: TrackPoint[]): Promise<DriveSummary | null> {
  if (points.length < 2) return null;
  const coords = points.map((p) => [p[0], p[1]] as LngLat);
  const summary: DriveSummary = {
    id: `${points[0][2]}`,
    name: null,
    startedAt: points[0][2],
    endedAt: points[points.length - 1][2],
    distanceM: lineLength(coords),
    start: coords[0],
    end: coords[coords.length - 1],
  };
  await AsyncStorage.setItem(pointsKey(summary.id), JSON.stringify(points));
  const list = (await readIndex()).filter((d) => d.id !== summary.id);
  list.push(summary);
  await writeIndex(list);
  syncDrivesToCarPlay().catch(() => {});
  return summary;
}

export async function renameDrive(id: string, name: string) {
  const list = await readIndex();
  const d = list.find((x) => x.id === id);
  if (!d) return;
  d.name = name.trim() || null;
  await writeIndex(list);
  syncDrivesToCarPlay().catch(() => {});
}

export async function deleteDrive(id: string) {
  const list = (await readIndex()).filter((d) => d.id !== id);
  await writeIndex(list);
  await AsyncStorage.multiRemove([pointsKey(id), routeKey(id)]);
  syncDrivesToCarPlay().catch(() => {});
}

/** The road-snapped, turn-by-turn version of a drive is worked out once and kept. */
export async function getCachedRoute(id: string): Promise<NavRoute | null> {
  const raw = await AsyncStorage.getItem(routeKey(id));
  return raw ? (JSON.parse(raw) as NavRoute) : null;
}

export async function cacheRoute(id: string, route: NavRoute) {
  await AsyncStorage.setItem(routeKey(id), JSON.stringify(route));
}

export function driveTitle(d: DriveSummary): string {
  if (d.name) return d.name;
  const date = new Date(d.startedAt);
  const day = date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const hour = date.getHours();
  const part = hour < 5 ? 'late-night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
  return `${day} ${part} drive`;
}

export function driveSubtitle(d: DriveSummary): string {
  const date = new Date(d.startedAt);
  const year = date.getFullYear() !== new Date().getFullYear() ? `, ${date.getFullYear()}` : '';
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + year;
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

/**
 * CarPlay can run while this JavaScript isn't, so the native side keeps its
 * own copy of the drives. Points are thinned to about every 20 m to keep it small.
 */
export async function syncDrivesToCarPlay() {
  if (!JoyrideNav?.syncDrives) return;
  const list = await listDrives();
  const drives = [];
  for (const d of list) {
    const pts = (await getDrivePoints(d.id)).map((p) => [p[0], p[1]] as LngLat);
    const trace = thin(pts, 20).map((i) => pts[i]);
    drives.push({ id: d.id, title: driveTitle(d), subtitle: `${driveSubtitle(d)}`, trace });
  }
  await JoyrideNav.syncDrives(drives);
}
