// The recorder's background task has to be registered before anything else.
import '@/lib/recorder';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '@/theme';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'default',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="drive/[id]" />
        <Stack.Screen name="navigate/[id]" options={{ gestureEnabled: false, animation: 'fade' }} />
      </Stack>
    </>
  );
}
