// The recorder's background task has to be registered before anything else.
import '@/lib/recorder';

import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import { useEffect } from 'react';
import { keepRecording, parkedSince, stopRecording } from '@/lib/recorder';
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

export default function RootLayout() {
  const p = useTheme();
  useEffect(() => {
    loadAppearance().catch(() => {});
    syncDrivesToCarPlay().catch(() => {});
    // Answered while Joyride was closed, or while it's open.
    Notifications.getLastNotificationResponseAsync().then(onStillDrivingAnswer).catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((r) => onStillDrivingAnswer(r).catch(() => {}));
    return () => sub.remove();
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
