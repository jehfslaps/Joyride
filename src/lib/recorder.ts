// Records a drive in the background, even with the phone locked.
// The task below must be defined at the top level, so this file is imported
// from the root layout before anything else runs.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { distance } from './geo';
import {
  ASK_AFTER_MS,
  ASK_AGAIN_AFTER_KEEP_MS,
  AUTO_STOP_AFTER_MS,
  clearState,
  fresh,
  loadState,
  saveState,
  scheduleAsk,
  setUpNotifications,
  step,
  tellSaved,
  type ParkedState,
} from './parked';
import { saveDrive, type DriveSummary, type TrackPoint } from './storage';

export const RECORD_TASK = 'joyride-record-drive';
const RECORDING_KEY = 'joyride:recording';

/** Fixes worse than this (meters) are ignored, they make the line wobble. */
const MAX_ACCURACY_M = 35;
/** Ignore jitter while stopped at a light. */
const MIN_STEP_M = 4;

let points: TrackPoint[] = [];
let parked: ParkedState | null = null;
let parkedPersisted = 0;
let stopping = false;

async function parkedState(): Promise<ParkedState> {
  if (!parked) parked = await loadState();
  return parked;
}
let loaded: Promise<void> | null = null;
let lastPersist = 0;
const listeners = new Set<(pts: TrackPoint[]) => void>();

function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = AsyncStorage.getItem(RECORDING_KEY)
      .then((raw) => {
        if (raw) {
          const saved = JSON.parse(raw) as { points: TrackPoint[] };
          // Keep anything that arrived before we finished loading.
          points = [...(saved.points ?? []), ...points].sort((a, b) => a[2] - b[2]);
        }
      })
      .catch(() => {});
  }
  return loaded;
}

async function persist(force = false) {
  const now = Date.now();
  if (!force && now - lastPersist < 10000) return;
  lastPersist = now;
  await AsyncStorage.setItem(RECORDING_KEY, JSON.stringify({ points }));
}

function notify() {
  for (const l of listeners) l(points);
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(RECORD_TASK, async ({ data, error }) => {
  if (error || !data || stopping) return;
  await ensureLoaded();
  const ps = await parkedState();
  let added = false;
  for (const loc of data.locations) {
    const acc = loc.coords.accuracy;
    if (acc != null && acc > MAX_ACCURACY_M) continue;
    const p: TrackPoint = [loc.coords.longitude, loc.coords.latitude, loc.timestamp];
    // Parked too long? Stop and save, without the parked time.
    const d = step(ps, [p[0], p[1]], p[2]);
    if (d.kind === 'auto-stop') {
      await autoStop(d.trimAfter, p[2]);
      return;
    }
    if (d.kind === 'moved') await scheduleAsk(ps, ps.since + ASK_AFTER_MS);
    const last = points[points.length - 1];
    if (last) {
      if (p[2] <= last[2]) continue;
      if (distance([last[0], last[1]], [p[0], p[1]]) < MIN_STEP_M) continue;
    }
    points.push(p);
    added = true;
  }
  if (added) {
    notify();
    await persist();
  }
  if (Date.now() - parkedPersisted > 15000) {
    parkedPersisted = Date.now();
    await saveState(ps);
  }
});

/** Stops and saves after being parked too long, then says so. */
async function autoStop(trimAfter: number, now: number) {
  stopping = true;
  try {
    const minutes = Math.max(15, Math.round((now - trimAfter) / 60000));
    await stopRecording({ trimAfter });
    await tellSaved(minutes);
  } finally {
    stopping = false;
  }
}

/** "Keep recording": no auto-stop for this stop, ask again in 15 minutes. */
export async function keepRecording() {
  const ps = await parkedState();
  ps.keptAt = Date.now();
  ps.askAt = null;
  await scheduleAsk(ps, ps.keptAt + ASK_AGAIN_AFTER_KEEP_MS);
  await saveState(ps);
}

/** When you stopped (for trimming), if you're parked right now. */
export async function parkedSince(): Promise<number | null> {
  const ps = await parkedState();
  return ps.anchor && Date.now() - ps.since > 60000 ? ps.since : null;
}

export function subscribe(fn: (pts: TrackPoint[]) => void): () => void {
  listeners.add(fn);
  fn(points);
  return () => listeners.delete(fn);
}

/** When this recording started, and its path so far (for CarPlay's timer and trail). */
export async function recordedSoFar(): Promise<{ startedAt: number | null; trail: [number, number][] }> {
  await ensureLoaded();
  return { startedAt: points[0]?.[2] ?? null, trail: points.map((p) => [p[0], p[1]] as [number, number]) };
}

export type RecorderState = 'idle' | 'recording' | 'interrupted';

/** What the recorder is doing right now (also restores state after the app restarts). */
export async function getRecorderState(): Promise<RecorderState> {
  await ensureLoaded();
  const running = await Location.hasStartedLocationUpdatesAsync(RECORD_TASK).catch(() => false);
  if (running) {
    // Parked past the limit while iOS let the app sleep: finish it now.
    const ps = await parkedState();
    if (ps.anchor && !ps.keptAt && Date.now() - ps.since >= AUTO_STOP_AFTER_MS) {
      await autoStop(ps.since, Date.now());
      return 'idle';
    }
    return 'recording';
  }
  const raw = await AsyncStorage.getItem(RECORDING_KEY);
  return raw ? 'interrupted' : 'idle';
}

export type StartResult =
  | { ok: true; background: boolean }
  | { ok: false; reason: 'denied' | 'services-off' };

export async function startRecording(): Promise<StartResult> {
  const enabled = await Location.hasServicesEnabledAsync();
  if (!enabled) return { ok: false, reason: 'services-off' };

  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return { ok: false, reason: 'denied' };
  // "Always" lets us keep recording with the screen off. If they say no we
  // still record, the phone just needs to stay on the app.
  const bg = await Location.requestBackgroundPermissionsAsync().catch(() => null);

  points = [];
  loaded = Promise.resolve();
  await AsyncStorage.setItem(RECORDING_KEY, JSON.stringify({ points }));
  notify();
  await clearState();
  parked = fresh();
  await setUpNotifications();

  await Location.startLocationUpdatesAsync(RECORD_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    activityType: Location.ActivityType.AutomotiveNavigation,
    // Every fix, even standing still, so Joyride can tell how long you've been parked.
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Joyride is recording',
      notificationBody: 'Your drive is being saved.',
    },
  });
  return { ok: true, background: bg?.status === 'granted' };
}

/**
 * Stops recording and saves the drive. Returns null if it was too short to
 * keep. `trimAfter` drops everything after that time (parked time).
 */
export async function stopRecording(opts: { trimAfter?: number } = {}): Promise<DriveSummary | null> {
  if (await Location.hasStartedLocationUpdatesAsync(RECORD_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(RECORD_TASK);
  }
  await ensureLoaded();
  const keep = opts.trimAfter != null ? points.filter((p) => p[2] <= opts.trimAfter! + 1000) : points;
  const saved = await saveDrive(keep.length >= 2 ? keep : points);
  await discardRecording();
  return saved;
}

export async function discardRecording() {
  if (await Location.hasStartedLocationUpdatesAsync(RECORD_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(RECORD_TASK);
  }
  points = [];
  loaded = Promise.resolve();
  await AsyncStorage.removeItem(RECORDING_KEY);
  await clearState();
  parked = fresh();
  notify();
}
