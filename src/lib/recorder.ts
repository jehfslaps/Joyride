// Records a drive in the background, even with the phone locked.
// The task below must be defined at the top level, so this file is imported
// from the root layout before anything else runs.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { distance } from './geo';
import { saveDrive, type DriveSummary, type TrackPoint } from './storage';

export const RECORD_TASK = 'joyride-record-drive';
const RECORDING_KEY = 'joyride:recording';

/** Fixes worse than this (meters) are ignored, they make the line wobble. */
const MAX_ACCURACY_M = 35;
/** Ignore jitter while stopped at a light. */
const MIN_STEP_M = 4;

let points: TrackPoint[] = [];
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
  if (error || !data) return;
  await ensureLoaded();
  let added = false;
  for (const loc of data.locations) {
    const acc = loc.coords.accuracy;
    if (acc != null && acc > MAX_ACCURACY_M) continue;
    const p: TrackPoint = [loc.coords.longitude, loc.coords.latitude, loc.timestamp];
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
});

export function subscribe(fn: (pts: TrackPoint[]) => void): () => void {
  listeners.add(fn);
  fn(points);
  return () => listeners.delete(fn);
}

export type RecorderState = 'idle' | 'recording' | 'interrupted';

/** What the recorder is doing right now (also restores state after the app restarts). */
export async function getRecorderState(): Promise<RecorderState> {
  await ensureLoaded();
  const running = await Location.hasStartedLocationUpdatesAsync(RECORD_TASK).catch(() => false);
  if (running) return 'recording';
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

  await Location.startLocationUpdatesAsync(RECORD_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    activityType: Location.ActivityType.AutomotiveNavigation,
    distanceInterval: 5,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Joyride is recording',
      notificationBody: 'Your drive is being saved.',
    },
  });
  return { ok: true, background: bg?.status === 'granted' };
}

/** Stops recording and saves the drive. Returns null if it was too short to keep. */
export async function stopRecording(): Promise<DriveSummary | null> {
  if (await Location.hasStartedLocationUpdatesAsync(RECORD_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(RECORD_TASK);
  }
  await ensureLoaded();
  const saved = await saveDrive(points);
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
  notify();
}
