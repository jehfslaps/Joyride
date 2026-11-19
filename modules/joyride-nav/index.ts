import { requireOptionalNativeModule, type EventSubscription } from 'expo';

type NavigationEnded = { canceled: boolean; arrived: boolean };

type JoyrideNavNative = {
  isAvailable: boolean;
  sdkVersion: string;
  /** Relives a recorded drive: trace and here are [longitude, latitude]. */
  startReplay(
    trace: [number, number][],
    here: [number, number],
    joinNearest: boolean,
    simulate: boolean,
    /** Mystery destination: hide the end pin, overview, distance and arrival time. */
    secret: boolean,
  ): Promise<void>;
  /** Keeps CarPlay's copy of the saved drives up to date. */
  syncDrives(drives: { id: string; title: string; subtitle: string; trace: [number, number][] }[]): Promise<void>;
  addListener(event: 'onNavigationEnded', listener: (e: NavigationEnded) => void): EventSubscription;
};

/** The native navigation engine, or null in builds without it (e.g. Expo Go, web). */
export const JoyrideNav = requireOptionalNativeModule<JoyrideNavNative>('JoyrideNav');
