import { requireOptionalNativeModule, type EventSubscription } from 'expo';

type NavigationEnded = { canceled: boolean; arrived: boolean };

type JoyrideNavNative = {
  isAvailable: boolean;
  sdkVersion: string;
  startMatchedNavigation(coordinates: [number, number][], simulate: boolean): Promise<void>;
  addListener(event: 'onNavigationEnded', listener: (e: NavigationEnded) => void): EventSubscription;
};

/** The native navigation engine, or null in builds without it (e.g. Expo Go, web). */
export const JoyrideNav = requireOptionalNativeModule<JoyrideNavNative>('JoyrideNav');
