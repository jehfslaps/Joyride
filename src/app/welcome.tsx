import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ComponentProps } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassCard, IconTile, PrimaryPill, TwoTone } from '@/components/ui';
import Animated from 'react-native-reanimated';
import { riseIn } from '@/lib/motion';
import { makeStyles, typeFor, useTheme } from '@/theme';

export const WELCOME_KEY = 'joyride:welcomed:v1';

type Icon = ComponentProps<typeof MaterialCommunityIcons>['name'];

const POINTS: { icon: Icon; title: string; body: string }[] = [
  {
    icon: 'record-circle-outline',
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
    body: 'Routes that weave through neighborhoods, side streets and cul-de-sacs on the way to anywhere, fastest to longest.',
  },
  {
    icon: 'dice-5-outline',
    title: 'Surprise me',
    body: 'Set a distance or an area, and Joyride picks somewhere random to go.',
  },
];

export default function Welcome() {
  const insets = useSafeAreaInsets();
  const p = useTheme();
  const t = typeFor(p);
  const s = useStyles();

  async function done() {
    await AsyncStorage.setItem(WELCOME_KEY, '1').catch(() => {});
    router.replace('/');
  }

  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: insets.top + 32, gap: 22, paddingBottom: 24 }}>
        <View style={{ gap: 10 }}>
          <Text style={[t.hero, { fontSize: 56 }]}>
            <Text style={{ color: p.text3, fontWeight: '400' }}>joy</Text>ride
          </Text>
          <TwoTone lead="For drives where" value="the drive is the point." size="title" />
        </View>

        {POINTS.map((pt, i) => (
          <Animated.View key={pt.title} entering={riseIn(80 + i * 70)} style={s.point}>
            <IconTile icon={pt.icon} size={44} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={t.bodyStrong}>{pt.title}</Text>
              <Text style={[t.caption, { fontSize: 14, lineHeight: 20 }]}>{pt.body}</Text>
            </View>
          </Animated.View>
        ))}

        <GlassCard style={s.note}>
          <Text style={t.bodyStrong}>About your location</Text>
          <Text style={s.noteBody}>
            To record a drive with your phone locked, Joyride asks for location access “Always”. It only records while
            you’ve tapped Start, and your drives stay on this phone.
          </Text>
        </GlassCard>

        <GlassCard style={s.note}>
          <Text style={t.bodyStrong}>Drive safely</Text>
          <Text style={s.noteBody}>
            Keep your eyes on the road and set things up before you go. Directions can be wrong: always follow road
            signs and traffic laws, and never use the app in a way that distracts you.
          </Text>
        </GlassCard>
      </ScrollView>
      <View style={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 16, paddingTop: 8 }}>
        <PrimaryPill label="Let’s go" trailingIcon="chevron-right" onPress={done} />
      </View>
    </View>
  );
}

const useStyles = makeStyles((p) => ({
  screen: { flex: 1, backgroundColor: p.canvas },
  point: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  note: { padding: 16, gap: 6 },
  noteBody: { fontSize: 14, lineHeight: 20, color: p.text2 },
}));
