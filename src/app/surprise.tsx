import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BigButton } from '@/components/BigButton';
import { pickSurprise } from '@/lib/funroutes';
import type { LngLat } from '@/lib/geo';
import { searchAreas, type Place } from '@/lib/places';
import { colors, radius, type } from '@/theme';

const MILES = [5, 10, 20, 30, 50];
const METERS_PER_MILE = 1609.344;

export default function SurpriseScreen() {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<'here' | 'there'>('here');
  const [miles, setMiles] = useState(20);
  const [secret, setSecret] = useState(true);
  const [here, setHere] = useState<LngLat | null>(null);
  const [areaQuery, setAreaQuery] = useState('');
  const [areas, setAreas] = useState<Place[]>([]);
  const [area, setArea] = useState<Place | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') return;
      const pos = (await Location.getLastKnownPositionAsync().catch(() => null)) ?? (await Location.getCurrentPositionAsync({}));
      setHere([pos.coords.longitude, pos.coords.latitude]);
    })().catch(() => {});
  }, []);

  useEffect(() => {
    if (mode !== 'there' || area || areaQuery.trim().length < 3) {
      setAreas([]);
      return;
    }
    const t = setTimeout(() => {
      searchAreas(areaQuery, here ?? undefined).then(setAreas).catch(() => setAreas([]));
    }, 350);
    return () => clearTimeout(t);
  }, [areaQuery, mode, area, here]);

  async function go() {
    if (!here) {
      Alert.alert('Finding you…', 'Joyride needs your location first. Make sure Location is allowed.');
      return;
    }
    if (mode === 'there' && !area) {
      Alert.alert('Pick an area', 'Type where you want to end up, like “Orange County”, and pick it from the list.');
      return;
    }
    setBusy(true);
    try {
      const dest = await pickSurprise({
        center: mode === 'there' && area ? area.coord : here,
        radiusM: miles * METERS_PER_MILE,
        fromHere: mode === 'here',
        // A city or county's own outline beats a circle when we have it.
        area: mode === 'there' && area?.bbox ? area : undefined,
      });
      router.push({
        pathname: '/routes',
        params: { lng: String(dest.coord[0]), lat: String(dest.coord[1]), name: dest.name, secret: secret ? '1' : '0' },
      });
    } catch (e: any) {
      Alert.alert('Couldn’t pick a spot', e?.message ?? 'Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: insets.top + 12, gap: 18, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.back} accessibilityLabel="Back">
          <MaterialCommunityIcons name="chevron-left" size={28} color={colors.text} />
        </Pressable>
        <View style={{ gap: 4 }}>
          <Text style={type.hero}>Surprise me</Text>
          <Text style={[type.body, { color: colors.muted }]}>Joyride picks a random spot. You just drive.</Text>
        </View>

        <View style={styles.segment}>
          {(['here', 'there'] as const).map((m) => (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              style={[styles.segmentBtn, mode === m && styles.segmentOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === m }}
            >
              <Text style={[styles.segmentText, mode === m && { color: colors.onAmber }]}>{m === 'here' ? 'From here' : 'Over there'}</Text>
            </Pressable>
          ))}
        </View>

        {mode === 'there' && (
          <View style={{ gap: 8 }}>
            <Text style={type.label}>END UP SOMEWHERE IN</Text>
            {area ? (
              <Pressable style={styles.areaPicked} onPress={() => { setArea(null); setAreaQuery(''); }}>
                <MaterialCommunityIcons name="map-marker-radius" size={22} color={colors.amber} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{area.name}</Text>
                  {!!area.detail && <Text style={type.small}>{area.detail}</Text>}
                </View>
                <MaterialCommunityIcons name="close-circle" size={20} color={colors.muted} />
              </Pressable>
            ) : (
              <>
                <View style={styles.input}>
                  <MaterialCommunityIcons name="magnify" size={20} color={colors.muted} />
                  <TextInput
                    value={areaQuery}
                    onChangeText={setAreaQuery}
                    placeholder="e.g. Orange County"
                    placeholderTextColor={colors.faint}
                    style={styles.inputText}
                    accessibilityLabel="Area"
                  />
                </View>
                {areas.map((a, i) => (
                  <Pressable key={`${a.name}-${i}`} onPress={() => setArea(a)} style={styles.row}>
                    <Text style={styles.rowTitle}>{a.name}</Text>
                    {!!a.detail && <Text style={type.small}>{a.detail}</Text>}
                  </Pressable>
                ))}
              </>
            )}
          </View>
        )}

        {(mode === 'here' || (area && !area.bbox)) && (
          <View style={{ gap: 10 }}>
            <Text style={type.label}>{mode === 'here' ? 'END SOMEWHERE WITHIN' : 'WITHIN THIS FAR OF IT'}</Text>
            <View style={styles.chips}>
              {MILES.map((m) => (
                <Pressable
                  key={m}
                  onPress={() => setMiles(m)}
                  style={[styles.chip, miles === m && styles.chipOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: miles === m }}
                >
                  <Text style={[styles.chipText, miles === m && { color: colors.onAmber }]}>{m} mi</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        <View style={styles.secretRow}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.rowTitle}>Keep it a secret</Text>
            <Text style={type.small}>Don’t show where we’re going until we get there</Text>
          </View>
          <Switch value={secret} onValueChange={setSecret} trackColor={{ true: colors.amber }} accessibilityLabel="Keep it a secret" />
        </View>

        <BigButton label="Find a surprise destination" icon="dice-5" onPress={go} busy={busy} />
        {!here && (
          <View style={{ flexDirection: 'row', gap: 8, alignSelf: 'center', alignItems: 'center' }}>
            <ActivityIndicator color={colors.muted} />
            <Text style={type.small}>Finding your location…</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  back: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.cardHi, alignItems: 'center', justifyContent: 'center' },
  segment: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: radius.md, padding: 4, gap: 4 },
  segmentBtn: { flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  segmentOn: { backgroundColor: colors.amber },
  segmentText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  input: { height: 48, borderRadius: radius.md, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 },
  inputText: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '600' },
  row: { backgroundColor: colors.card, borderRadius: radius.md, padding: 14, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  areaPicked: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, padding: 14, borderWidth: 1, borderColor: colors.amberDim },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 16, height: 44, borderRadius: 22, backgroundColor: colors.cardHi, justifyContent: 'center' },
  chipOn: { backgroundColor: colors.amber },
  chipText: { color: colors.text, fontWeight: '700', fontSize: 15 },
  secretRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, padding: 16 },
});
