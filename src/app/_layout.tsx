// The recorder's background task has to be registered before anything else.
import '@/lib/recorder';

import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { syncDrivesToCarPlay } from '@/lib/storage';
import { loadAppearance } from '@/lib/appearance';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '@/theme';

export default function RootLayout() {
  const p = useTheme();
  useEffect(() => {
    loadAppearance().catch(() => {});
    syncDrivesToCarPlay().catch(() => {});
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
