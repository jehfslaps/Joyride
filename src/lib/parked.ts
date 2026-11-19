// "Are you still driving?" While a drive records, Joyride notices when you've
// stayed in about the same spot (within ~60 m, so GPS drift doesn't count):
//  - after 10 minutes it asks, with Stop and save / Keep recording;
//  - after 15 minutes it stops and saves on its own, trimming the parked time.
// Choosing Keep recording means you're waiting on purpose: no auto-stop for
// that stop, and it asks again after another 15 minutes.
//
// The question is scheduled ahead of time as a local notification (pushed
// back whenever you move), so it shows up even if iOS doesn't wake the app.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

export * from './parkedLogic';
import { fresh, type ParkedState } from './parkedLogic';

export const CATEGORY = 'joyride-still-driving';
export const ACTION_STOP = 'stop';
export const ACTION_KEEP = 'keep';
const KEY = 'joyride:parked';
const ASK_ID = 'joyride-still-driving-ask';

export async function loadState(): Promise<ParkedState> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? { ...fresh(), ...JSON.parse(raw) } : fresh();
  } catch {
    return fresh();
  }
}

export async function saveState(s: ParkedState) {
  await AsyncStorage.setItem(KEY, JSON.stringify(s)).catch(() => {});
}

export async function clearState() {
  await AsyncStorage.removeItem(KEY).catch(() => {});
  await cancelAsk();
}

/** Sets up the notification buttons and asks for permission (once). */
export async function setUpNotifications() {
  await Notifications.setNotificationCategoryAsync(CATEGORY, [
    { identifier: ACTION_STOP, buttonTitle: 'Stop and save', options: { opensAppToForeground: true } },
    { identifier: ACTION_KEEP, buttonTitle: 'Keep recording', options: { opensAppToForeground: true } },
  ]).catch(() => {});
  const perm = await Notifications.getPermissionsAsync().catch(() => null);
  if (perm && !perm.granted && perm.canAskAgain) {
    await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }).catch(() => {});
  }
}

/** (Re)schedules the question for `at`. Skipped if it's already within 30 s of that. */
export async function scheduleAsk(state: ParkedState, at: number) {
  if (state.askAt && Math.abs(state.askAt - at) < 30000) return;
  await cancelAsk();
  const seconds = Math.max(5, Math.round((at - Date.now()) / 1000));
  await Notifications.scheduleNotificationAsync({
    identifier: ASK_ID,
    content: {
      title: 'Are you still driving?',
      body: 'Looks like you’ve stopped. Stop and save this drive?',
      categoryIdentifier: CATEGORY,
      sound: 'default',
      interruptionLevel: 'timeSensitive',
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds },
  }).catch(() => {});
  state.askAt = at;
}

export async function cancelAsk() {
  await Notifications.cancelScheduledNotificationAsync(ASK_ID).catch(() => {});
  await Notifications.dismissNotificationAsync(ASK_ID).catch(() => {});
}

export async function tellSaved(parkedMin: number) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Drive saved',
      body: `You’d been parked ${parkedMin} minutes, so Joyride stopped recording. The parked time isn’t included.`,
      sound: 'default',
    },
    trigger: null,
  }).catch(() => {});
}
