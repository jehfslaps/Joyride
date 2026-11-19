import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import type { LngLat } from './geo';

/** Your current position while a screen is open (only if location is already allowed). */
export function useHere(): LngLat | null {
  const [here, setHere] = useState<LngLat | null>(null);
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const perm = await Location.getForegroundPermissionsAsync();
      if (perm.status !== 'granted' || cancelled) return;
      const last = await Location.getLastKnownPositionAsync().catch(() => null);
      if (last && !cancelled) setHere([last.coords.longitude, last.coords.latitude]);
      sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, distanceInterval: 5 }, (pos) =>
        setHere([pos.coords.longitude, pos.coords.latitude]),
      );
      if (cancelled) sub.remove();
    })().catch(() => {});
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, []);
  return here;
}
