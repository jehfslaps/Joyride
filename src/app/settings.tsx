import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { Alert, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { JoyrideNav } from '../../modules/joyride-nav';
import { deleteDrive, listDrives } from '@/lib/storage';
import { GlassRow, ScreenHeader } from '@/components/ui';
import { makeStyles, typeFor, useTheme } from '@/theme';

export const PRIVACY_URL = 'https://jehfslaps.github.io/Joyride/privacy.html';
export const SUPPORT_URL = 'https://github.com/jehfslaps/Joyride/issues';

export default function Settings() {
  const insets = useSafeAreaInsets();
  const p = useTheme();
  const t = typeFor(p);
  const s = useStyles();
  const version = Constants.expoConfig?.version ?? '1.0.0';

  function deleteAll() {
    Alert.alert('Delete all drives?', 'Every saved drive on this phone will be removed. This can’t be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete all',
        style: 'destructive',
        onPress: async () => {
          for (const d of await listDrives()) await deleteDrive(d.id);
          Alert.alert('Done', 'All drives were deleted.');
        },
      },
    ]);
  }

  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 12, paddingBottom: insets.bottom + 24 }}>
        <ScreenHeader title="settings" onBack={() => router.back()} />

        <GlassRow icon="map-marker-radius-outline" title="Location access" detail="Set to “Always” to record with the phone locked" onPress={() => Linking.openSettings()} />
        <GlassRow icon="shield-lock-outline" title="Privacy policy" onPress={() => Linking.openURL(PRIVACY_URL)} />
        <GlassRow icon="lifebuoy" title="Help and feedback" onPress={() => Linking.openURL(SUPPORT_URL)} />
        <GlassRow icon="information-outline" title="Show the welcome screen" onPress={() => router.push('/welcome')} />
        <GlassRow icon="theme-light-dark" title="Light and dark" detail="Follows your iPhone’s appearance. Turn-by-turn switches at sunset." />
        <GlassRow icon="delete-outline" title="Delete all drives" danger onPress={deleteAll} />

        <Text style={[t.caption, { textAlign: 'center', marginTop: 12 }]}>
          Joyride {version}
          {JoyrideNav ? ` · Mapbox Navigation ${JoyrideNav.sdkVersion}` : ''}
        </Text>
        <Text style={[t.caption, { textAlign: 'center', color: p.text3 }]}>
          Maps and directions © Mapbox © OpenStreetMap contributors
        </Text>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((p) => ({
  screen: { flex: 1, backgroundColor: p.canvas },
}));
