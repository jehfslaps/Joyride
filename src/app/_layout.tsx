// The recorder's background task has to be registered before anything else.
import '@/lib/recorder';

import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import { useEffect } from 'react';
import { getRecorderState, keepRecording, parkedSince, recordedSoFar, startRecording, stopRecording } from '@/lib/recorder';
import { thin, type LngLat } from '@/lib/geo';
import { JoyrideNav } from '../../modules/joyride-nav';
import { formatDuration } from '@/lib/geo';
import { ACTION_KEEP, ACTION_STOP, CATEGORY } from '@/lib/parked';
import { syncDrivesToCarPlay } from '@/lib/storage';
import { loadAppearance } from '@/lib/appearance';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '@/theme';

// Show Joyride's notifications even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/** The buttons on "Are you still driving?". */
async function onStillDrivingAnswer(r: Notifications.NotificationResponse | null) {
  if (!r || r.notification.request.content.categoryIdentifier !== CATEGORY) return;
  if (r.actionIdentifier === ACTION_KEEP) {
    await keepRecording();
  } else if (r.actionIdentifier === ACTION_STOP) {
    const trimAfter = (await parkedSince()) ?? undefined;
    const saved = await stopRecording({ trimAfter });
    if (saved) router.push({ pathname: '/drive/[id]', params: { id: saved.id } });
  }
  await Notifications.clearLastNotificationResponseAsync().catch(() => {});
}

/** Record / Stop tapped on CarPlay. */
async function onCarPlayRecord(start: boolean) {
  if (start) {
    if ((await getRecorderState()) === 'recording') return syncCarPlayRecording();
    const r = await startRecording().catch(() => null);
    if (!r || !r.ok) {
      JoyrideNav?.setRecording(false, 'Couldn’t start recording. Open Joyride on your phone and allow Location.', null, null);
      return;
    }
    carPlaySaw = null;
    await syncCarPlayRecording();
  } else {
    const saved = await stopRecording().catch(() => null);
    carPlaySaw = false;
    JoyrideNav?.setRecording(false, saved ? `Drive saved · ${formatDuration(saved.endedAt - saved.startedAt)}` : 'Too short to save.', null, null);
  }
}

/**
 * Keeps CarPlay's Record / Stop button, timer and trail matching what's really
 * happening (recording can start on the phone too). The path so far is sent
 * once, when CarPlay first sees the recording; after that it draws as you go.
 */
let carPlaySaw: boolean | null = null;
async function syncCarPlayRecording() {
  const on = (await getRecorderState()) === 'recording';
  if (on === carPlaySaw) return;
  carPlaySaw = on;
  if (!on) return JoyrideNav?.setRecording(false, null, null, null);
  const so = await recordedSoFar();
  const keep = thin(so.trail as LngLat[], 15).map((i) => so.trail[i]);
  JoyrideNav?.setRecording(true, null, so.startedAt, keep.slice(-1500));
}

export default function RootLayout() {
  const p = useTheme();
  useEffect(() => {
    loadAppearance().catch(() => {});
    syncDrivesToCarPlay().catch(() => {});
    // Answered while Joyride was closed, or while it's open.
    Notifications.getLastNotificationResponseAsync().then(onStillDrivingAnswer).catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((r) => onStillDrivingAnswer(r).catch(() => {}));
    // CarPlay's Record button.
    const rec = JoyrideNav?.addListener('onCarPlayRecord', ({ start }) => onCarPlayRecord(start).catch(() => {}));
    const pending = JoyrideNav?.takeRecordRequest?.();
    if (pending) onCarPlayRecord(pending === 'start').catch(() => {});
    syncCarPlayRecording().catch(() => {});
    const tick = setInterval(() => syncCarPlayRecording().catch(() => {}), 3000);
    return () => {
      sub.remove();
      rec?.remove();
      clearInterval(tick);
    };
  }, []);

  return (
    <>
      <StatusBar style={p.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: p.canvas },
          animation: 'default',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="drive/[id]" />
        <Stack.Screen name="routes" />
        <Stack.Screen name="surprise" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="welcome" options={{ animation: 'fade' }} />
        <Stack.Screen name="navigate/[id]" options={{ gestureEnabled: false, animation: 'fade' }} />
      </Stack>
    </>
  );
}
