import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ComponentProps } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BigButton } from '@/components/BigButton';
import { colors, radius, type } from '@/theme';

export const WELCOME_KEY = 'joyride:welcomed:v1';

type Icon = ComponentProps<typeof MaterialCommunityIcons>['name'];

const POINTS: { icon: Icon; title: string; body: string }[] = [
  {
    icon: 'record-circle',
    title: 'Record any drive',
    body: 'Tap Start, drive wherever you like, and tap Stop. Joyride saves every street and turn.',
  },
  {
    icon: 'steering',
    title: 'Relive it, turn by turn',
    body: 'Pick a saved drive and get voice directions along the exact same roads.',
  },
  {
    icon: 'routes',
    title: 'Fun routes',
    body: 'Scenic, neighborhood, landmark and backroad routes to anywhere, fastest to longest.',
  },
  {
    icon: 'dice-5',
    title: 'Surprise me',
    body: 'Set a distance or an area, and Joyride picks somewhere random to go.',
  },
];

export default function Welcome() {
  const insets = useSafeAreaInsets();

  async function done() {
    await AsyncStorage.setItem(WELCOME_KEY, '1').catch(() => {});
    router.replace('/');
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: insets.top + 32, gap: 22, paddingBottom: 24 }}>
        <View style={{ gap: 6 }}>
          <Text style={type.hero}>Joyride</Text>
          <Text style={[type.body, { color: colors.muted }]}>For drives where the drive is the point.</Text>
        </View>

        {POINTS.map((p) => (
          <View key={p.title} style={styles.point}>
            <View style={styles.icon}>
              <MaterialCommunityIcons name={p.icon} size={24} color={colors.amber} />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={styles.title}>{p.title}</Text>
              <Text style={[type.small, { fontSize: 14, lineHeight: 20 }]}>{p.body}</Text>
            </View>
          </View>
        ))}

        <View style={styles.note}>
          <Text style={styles.noteTitle}>About your location</Text>
          <Text style={styles.noteBody}>
            To record a drive with your phone locked, Joyride asks for location access “Always”. It only records while
            you’ve tapped Start, and your drives stay on this phone.
          </Text>
        </View>

        <View style={styles.note}>
          <Text style={styles.noteTitle}>Drive safely</Text>
          <Text style={styles.noteBody}>
            Keep your eyes on the road and set things up before you go. Directions can be wrong: always follow road
            signs and traffic laws, and never use the app in a way that distracts you.
          </Text>
        </View>
      </ScrollView>
      <View style={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 16, paddingTop: 8 }}>
        <BigButton label="Let’s go" icon="arrow-right" onPress={done} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  point: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  icon: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,178,63,0.12)', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '700', color: colors.text },
  note: { backgroundColor: colors.card, borderRadius: radius.md, padding: 16, gap: 6 },
  noteTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  noteBody: { fontSize: 14, lineHeight: 20, color: colors.muted },
});
