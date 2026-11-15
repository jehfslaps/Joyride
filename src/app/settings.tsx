import { MaterialCommunityIcons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import type { ComponentProps } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { JoyrideNav } from '../../modules/joyride-nav';
import { deleteDrive, listDrives } from '@/lib/storage';
import { colors, radius, type } from '@/theme';

export const PRIVACY_URL = 'https://jehfslaps.github.io/Joyride/privacy.html';
export const SUPPORT_URL = 'https://github.com/jehfslaps/Joyride/issues';

type Icon = ComponentProps<typeof MaterialCommunityIcons>['name'];

export default function Settings() {
  const insets = useSafeAreaInsets();
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
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: insets.top + 12, gap: 14, paddingBottom: insets.bottom + 24 }}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.back} accessibilityLabel="Back">
          <MaterialCommunityIcons name="chevron-left" size={28} color={colors.text} />
        </Pressable>
        <Text style={type.hero}>Settings</Text>

        <Row icon="map-marker-radius" title="Location access" detail="Set to “Always” to record with the phone locked" onPress={() => Linking.openSettings()} />
        <Row icon="shield-lock-outline" title="Privacy policy" onPress={() => Linking.openURL(PRIVACY_URL)} />
        <Row icon="lifebuoy" title="Help and feedback" onPress={() => Linking.openURL(SUPPORT_URL)} />
        <Row icon="information-outline" title="Show the welcome screen" onPress={() => router.push('/welcome')} />
        <Row icon="delete-outline" title="Delete all drives" danger onPress={deleteAll} />

        <Text style={[type.small, { textAlign: 'center', marginTop: 12 }]}>
          Joyride {version}
          {JoyrideNav ? ` · Mapbox Navigation ${JoyrideNav.sdkVersion}` : ''}
        </Text>
        <Text style={[type.small, { textAlign: 'center', color: colors.faint }]}>
          Maps and directions © Mapbox © OpenStreetMap contributors
        </Text>
      </ScrollView>
    </View>
  );
}

function Row({ icon, title, detail, onPress, danger }: { icon: Icon; title: string; detail?: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.cardHi }]} accessibilityRole="button">
      <MaterialCommunityIcons name={icon} size={22} color={danger ? colors.red : colors.amber} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowTitle, danger && { color: colors.red }]}>{title}</Text>
        {!!detail && <Text style={type.small}>{detail}</Text>}
      </View>
      <MaterialCommunityIcons name="chevron-right" size={22} color={colors.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  back: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.cardHi, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.card, borderRadius: radius.md, padding: 16 },
  rowTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
});
