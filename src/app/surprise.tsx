import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ContextChip, GlassCard, GlassRow, Label, PrimaryPill, ScreenHeader, TwoTone } from '@/components/ui';
import { pickSurprise } from '@/lib/funroutes';
import type { LngLat } from '@/lib/geo';
import { searchAreas, type Place } from '@/lib/places';
import { makeStyles, typeFor, useTheme } from '@/theme';

const MILES = [5, 10, 20, 30, 50];
const METERS_PER_MILE = 1609.344;

export default function SurpriseScreen() {
  const insets = useSafeAreaInsets();
  const p = useTheme();
  const t = typeFor(p);
  const s = useStyles();
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
    <View style={s.screen}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 18, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <ScreenHeader title="surprise" onBack={() => router.back()} />
        <TwoTone lead="Joyride picks a spot." value="You just drive." size="title" />

        <GlassCard radiusSize={18} style={s.segment}>
          {(['here', 'there'] as const).map((m) => (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              style={[s.segmentBtn, mode === m && { backgroundColor: p.mint }]}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === m }}
            >
              <Text style={[s.segmentText, mode === m && { color: p.onMint }]}>{m === 'here' ? 'From here' : 'Over there'}</Text>
            </Pressable>
          ))}
        </GlassCard>

        {mode === 'there' && (
          <View style={{ gap: 8 }}>
            <Label>END UP SOMEWHERE IN</Label>
            {area ? (
              <GlassRow
                icon="map-marker-radius-outline"
                title={area.name}
                detail={area.detail || undefined}
                onPress={() => { setArea(null); setAreaQuery(''); }}
                right={<MaterialCommunityIcons name="close-circle" size={20} color={p.text3} />}
              />
            ) : (
              <>
                <GlassCard radiusSize={18} style={s.input}>
                  <MaterialCommunityIcons name="magnify" size={20} color={p.text2} />
                  <TextInput
                    value={areaQuery}
                    onChangeText={setAreaQuery}
                    placeholder="e.g. Orange County"
                    placeholderTextColor={p.text3}
                    style={s.inputText}
                    accessibilityLabel="Area"
                  />
                </GlassCard>
                {areas.map((a, i) => (
                  <GlassRow key={`${a.name}-${i}`} title={a.name} detail={a.detail || undefined} onPress={() => setArea(a)} />
                ))}
              </>
            )}
          </View>
        )}

        {(mode === 'here' || (area && !area.bbox)) && (
          <View style={{ gap: 10 }}>
            <Label>{mode === 'here' ? 'END SOMEWHERE WITHIN' : 'WITHIN THIS FAR OF IT'}</Label>
            <View style={s.chips}>
              {MILES.map((m) => (
                <ContextChip key={m} label={`${m} mi`} on={miles === m} onPress={() => setMiles(m)} />
              ))}
            </View>
          </View>
        )}

        <GlassRow
          icon="eye-off-outline"
          title="Keep it a secret"
          detail="Don’t show where we’re going until we get there"
          right={<Switch value={secret} onValueChange={setSecret} trackColor={{ true: p.brand }} accessibilityLabel="Keep it a secret" />}
        />

        <PrimaryPill label="Find a surprise destination" icon="dice-5-outline" onPress={go} busy={busy} />
        {!here && (
          <View style={{ flexDirection: 'row', gap: 8, alignSelf: 'center', alignItems: 'center' }}>
            <ActivityIndicator color={p.text2} />
            <Text style={t.caption}>Finding your location…</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((p) => ({
  screen: { flex: 1, backgroundColor: p.canvas },
  segment: { flexDirection: 'row', padding: 4, gap: 4 },
  segmentBtn: { flex: 1, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  segmentText: { color: p.mint, fontSize: 15, fontWeight: '700' },
  input: { height: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 },
  inputText: { flex: 1, color: p.mint, fontSize: 16, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
}));
