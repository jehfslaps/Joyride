// Joyride's own Light / Dark setting. "auto" follows the iPhone. The choice
// applies to the whole app, maps and the turn-by-turn screen included.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';

export type AppearanceChoice = 'auto' | 'dark' | 'light';
const KEY = 'joyride:appearance';

export async function loadAppearance(): Promise<AppearanceChoice> {
  const raw = await AsyncStorage.getItem(KEY).catch(() => null);
  const choice: AppearanceChoice = raw === 'dark' || raw === 'light' ? raw : 'auto';
  Appearance.setColorScheme(choice);
  return choice;
}

export async function setAppearance(choice: AppearanceChoice) {
  Appearance.setColorScheme(choice);
  await AsyncStorage.setItem(KEY, choice).catch(() => {});
}
