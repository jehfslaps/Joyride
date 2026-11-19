import { MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MapView from 'react-native-maps';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { enterFade, enterRise, exitFade, moveList, springFade } from '@/lib/motion';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { JoyrideNav } from '../../modules/joyride-nav';
import { ContextChip, GlassCard, GlassRow, GlowRoute, HeroNumber, Label, LivePuck, PinTile, PressableScale, PrimaryPill, RoundButton, SpotDot, TwoTone, useMapLook, Vignette } from '@/components/ui';
import { buildFunRoutes, describe, NO_RULES, VisitedStreets, type RoadRules, type RouteOption } from '@/lib/funroutes';
import { formatMiles, type LngLat } from '@/lib/geo';
import { searchPlaces, type Place } from '@/lib/places';
import { getRecorderState, startRecording } from '@/lib/recorder';
import { getDrivePoints, listDrives } from '@/lib/storage';
import { makeStyles, typeFor, useTheme } from '@/theme';

const toLatLng = (c: LngLat) => ({ latitude: c[1], longitude: c[0] });
const RULES_KEY = 'joyride:roadRules';

/** Every street from your recorded drives, so routes can favor new ones. */
async function loadVisited(): Promise<VisitedStreets> {
  const traces: LngLat[][] = [];
  for (const d of await listDrives()) {
    const pts = await getDrivePoints(d.id).catch(() => []);
    traces.push(pts.map((p) => [p[0], p[1]] as LngLat));
  }
  return new VisitedStreets(traces);
}

export default function FunRoutesScreen() {
  const params = useLocalSearchParams<{ lng?: string; lat?: string; name?: string; secret?: string; pick?: string }>();
  const insets = useSafeAreaInsets();
  const p = useTheme();
  const t = typeFor(p);
  const s = useStyles();
  const mapLook = useMapLook();
  const map = useRef<MapView>(null);
  const secret = params.secret === '1';

  const [here, setHere] = useState<LngLat | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [dest, setDest] = useState<Place | null>(
    params.lng && params.lat
      ? { name: params.name ?? 'Surprise destination', detail: '', coord: [Number(params.lng), Number(params.lat)], kind: 'surprise' }
      : null,
  );
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  const [building, setBuilding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [record, setRecord] = useState(true);
  const [starting, setStarting] = useState(false);
  const [rules, setRules] = useState<RoadRules | null>(null);
  const [visited, setVisited] = useState<VisitedStreets | null>(null);
  const [shuffle, setShuffle] = useState(0);
  const buildId = useRef(0);

  // The switches remember how you left them.
  useEffect(() => {
    AsyncStorage.getItem(RULES_KEY)
      .then((raw) => setRules(raw ? { ...NO_RULES, ...JSON.parse(raw) } : NO_RULES))
      .catch(() => setRules(NO_RULES));
    loadVisited().then(setVisited).catch(() => setVisited(new VisitedStreets([])));
  }, []);

  function toggle(key: keyof RoadRules) {
    if (!rules) return;
    const next = { ...rules, [key]: !rules[key] };
    setRules(next);
    AsyncStorage.setItem(RULES_KEY, JSON.stringify(next)).catch(() => {});
  }

  useEffect(() => {
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') return;
      const pos = await Location.getLastKnownPositionAsync().catch(() => null) ?? await Location.getCurrentPositionAsync({});
      setHere([pos.coords.longitude, pos.coords.latitude]);
    })().catch(() => {});
  }, []);

  // Search as you type, after a short pause.
  useEffect(() => {
    if (dest || query.trim().length < 3) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        setResults(await searchPlaces(query, here ?? undefined));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, here, dest]);

  // Once there's a destination and we know where you are, build the menu.
  // Flipping a switch (or tapping New routes) builds it again.
  useEffect(() => {
    if (!dest || !here || !rules || !visited) return;
    const id = ++buildId.current;
    setRoutes([]);
    setSelected(null);
    setBuilding(true);
    buildFunRoutes(here, dest.coord, {
      rules,
      visited,
      onRoute: (all) => {
        if (id === buildId.current) setRoutes(all);
      },
    })
      .then((all) => {
        if (id !== buildId.current) return;
        setRoutes(all);
        if (!all.length) Alert.alert('No routes found', 'Mapbox couldn’t find a driving route there. Try another destination.');
      })
      .catch((e) => {
        if (id === buildId.current) Alert.alert('Couldn’t find routes', e?.message ?? 'Check your connection and try again.');
      })
      .finally(() => {
        if (id === buildId.current) setBuilding(false);
      });
  }, [dest, here, rules, visited, shuffle]);

  // Optional ?pick=<style> selects the first route of that style once they're in.
  useEffect(() => {
    if (building || selected || !params.pick) return;
    const match = routes.find((r) => r.style === params.pick);
    if (match) setSelected(match.id);
  }, [building, routes, selected, params.pick]);

  const chosen = useMemo(() => routes.find((r) => r.id === selected) ?? null, [routes, selected]);

  // Mystery: nothing on the map gives away the end, unless you're holding Peek.
  const [peek, setPeek] = useState(false);
  const hide = secret && !peek;

  // Keep the map framing everything (in a mystery, just you).
  useEffect(() => {
    if (hide) {
      if (here) map.current?.animateCamera({ center: toLatLng(here), zoom: 13.5, altitude: 9000 }, { duration: 600 });
      return;
    }
    const pts: LngLat[] = [];
    if (here) pts.push(here);
    if (dest) pts.push(dest.coord);
    for (const r of chosen ? [chosen] : routes) pts.push(...r.coords.filter((_, i) => i % 10 === 0));
    if (pts.length < 2) return;
    map.current?.fitToCoordinates(pts.map(toLatLng), {
      edgePadding: { top: insets.top + 90, right: 40, bottom: 40, left: 40 },
      animated: true,
    });
  }, [routes.length, chosen, here, dest, hide, insets.top]);

  // When a mystery drive ends, reveal where it was going.
  const reveal = useRef({ secret, name: dest?.name ?? '' });
  reveal.current = { secret, name: dest?.name ?? '' };
  useEffect(() => {
    const sub = JoyrideNav?.addListener('onNavigationEnded', ({ arrived }) => {
      const { secret: wasSecret, name } = reveal.current;
      if (!wasSecret) return;
      if (arrived) {
        Alert.alert('You made it', name ? `This was the mystery: ${name}.` : 'That was the mystery destination.');
      } else {
        Alert.alert('Want to know where you were headed?', undefined, [
          { text: 'Keep it a mystery', style: 'cancel' },
          { text: 'Show me', onPress: () => Alert.alert('The mystery destination', name || 'A random spot') },
        ]);
      }
    });
    return () => sub?.remove();
  }, []);

  async function go() {
    if (!chosen || !here) return;
    if (!JoyrideNav) {
      Alert.alert('Not available in this build', 'Fun routes need the new navigation engine, which comes with the next app build.');
      return;
    }
    setStarting(true);
    try {
      if (record && (await getRecorderState()) !== 'recording') await startRecording().catch(() => null);
      setPeek(false);
      await JoyrideNav.startReplay(chosen.coords, here, false, false, secret);
    } catch (e: any) {
      Alert.alert('Couldn’t start navigation', e?.message ?? String(e));
    } finally {
      setStarting(false);
    }
  }

  const destLabel = secret ? 'Mystery destination' : dest?.name ?? '';

  const arrive = chosen ? new Date(Date.now() + chosen.durationS * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  const extraMin = chosen && routes[0] ? Math.round((chosen.durationS - routes[0].durationS) / 60) : 0;

  return (
    <View style={s.screen}>
      <View style={s.mapWrap}>
        <MapView ref={map} style={StyleSheet.absoluteFill} showsUserLocation={false} {...mapLook}>
          {!hide &&
            routes
              .filter((r) => r.id !== selected)
              .map((r) => <GlowRoute key={r.id} coords={r.coords} dim onPress={() => setSelected(r.id)} />)}
          {!hide && chosen && <GlowRoute key={`on-${chosen.id}`} coords={chosen.coords} z={5} />}
          {!hide &&
            chosen?.via
              .filter((v) => v.kind === 'culdesac' || v.kind === 'odd')
              .map((v, i) => <SpotDot key={`via-${i}`} at={v.coord} kind={v.kind as 'culdesac' | 'odd'} />)}
          {dest && !hide && <PinTile at={dest.coord} />}
          {here && <LivePuck at={here} />}
        </MapView>
        <Vignette edge="top" height={insets.top + 90} />
        <Vignette edge="bottom" height={60} />
        <View style={[s.topBar, { paddingTop: insets.top + 6 }]}>
          <RoundButton icon="chevron-left" onPress={() => router.back()} label="Back" />
          {dest ? (
            <Pressable
              style={{ flex: 1 }}
              onPress={() => {
                if (params.lng) return;
                setDest(null);
                setRoutes([]);
              }}
              accessibilityRole="button"
              accessibilityLabel={params.lng ? destLabel : `To ${destLabel}. Tap to change.`}
            >
              <GlassCard radiusSize={22} strong style={s.destPill}>
                <Text style={s.destTo}>To</Text>
                <Text style={s.destName} numberOfLines={1}>{destLabel}</Text>
                {!params.lng && <MaterialCommunityIcons name="close-circle" size={18} color={p.text3} />}
              </GlassCard>
            </Pressable>
          ) : null}
          {dest ? <RoundButton icon="shuffle-variant" onPress={() => !building && setShuffle((n) => n + 1)} label="New routes" /> : (
            <GlassCard radiusSize={22} strong style={[s.searchBox, { flex: 1 }]}>
              <MaterialCommunityIcons name="magnify" size={20} color={p.text2} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Where to?"
                placeholderTextColor={p.text3}
                style={s.searchInput}
                autoFocus
                returnKeyType="search"
                accessibilityLabel="Destination"
              />
              {searching && <ActivityIndicator color={p.text2} />}
            </GlassCard>
          )}
        </View>
      </View>

      {!dest ? (
        <Animated.FlatList
          data={results}
          itemLayoutAnimation={moveList}
          keyExtractor={(pl, i) => `${pl.name}-${i}`}
          contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: insets.bottom + 24 }}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={[t.caption, { textAlign: 'center', marginTop: 12 }]}>
              {query.trim().length < 3 ? 'Type a place, address, or city.' : searching ? '' : 'No matches yet.'}
            </Text>
          }
          renderItem={({ item }) => (
            <Animated.View entering={enterFade} exiting={exitFade}>
              <GlassRow icon="map-marker-outline" title={item.name} detail={item.detail || undefined} onPress={() => setDest(item)} />
            </Animated.View>
          )}
        />
      ) : (
        <View style={{ flex: 1 }}>
          <Animated.FlatList
            data={routes}
            keyExtractor={(r) => r.id}
            itemLayoutAnimation={moveList}
            contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, gap: 8, paddingBottom: 12 }}
            ListHeaderComponent={
              <View style={{ gap: 12, marginBottom: 4 }}>
                <View style={s.chips}>
                  {secret && (
                    <Pressable
                      onPressIn={() => setPeek(true)}
                      onPressOut={() => setPeek(false)}
                      accessibilityRole="button"
                      accessibilityLabel="Hold to peek at the destination"
                    >
                      <ContextChip label={peek ? 'Peeking' : 'Hold to peek'} icon={peek ? 'eye-outline' : 'eye-off-outline'} on={peek} />
                    </Pressable>
                  )}
                  <ContextChip prefix="Avoid" label="Freeways" on={!!rules?.noFreeways} onPress={() => toggle('noFreeways')} accessibilityRole="switch" />
                  <ContextChip prefix="Avoid" label="Highways" on={!!rules?.noHighways} onPress={() => toggle('noHighways')} accessibilityRole="switch" />
                </View>
                <Label>{building ? 'FINDING SIDE STREETS…' : `${routes.length} ROUTES · FASTEST TO LONGEST`}</Label>
              </View>
            }
            ListFooterComponent={building ? <ActivityIndicator color={p.brand} style={{ marginTop: 8 }} /> : undefined}
            renderItem={({ item }) => {
              const on = item.id === selected;
              return (
                <Animated.View entering={enterRise} exiting={exitFade}>
                <PressableScale
                  scaleTo={0.985}
                  onPress={() => setSelected(item.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <GlassCard style={s.routeRow}>
                    <SelectedGlow on={on} />
                    <View style={s.timeCol}>
                      <Text style={[s.routeTime, { color: on ? p.mint : item.style === 'fastest' ? p.text2 : p.mint }]}>
                        {Math.round(item.durationS / 60)}
                      </Text>
                      <Text style={t.caption}>min</Text>
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={t.bodyStrong}>{item.title}</Text>
                      <Text style={t.caption} numberOfLines={2}>
                        {secret ? describe([], item.culDeSacs, []) : item.blurb}
                      </Text>
                      <Text style={[t.caption, { color: p.text3 }]} numberOfLines={1}>
                        {secret ? 'Mystery route' : formatMiles(item.distanceM)}
                        {item.newShare != null && item.style !== 'fastest' ? ` · ${Math.round(item.newShare * 100)}% new to you` : ''}
                        {item.usesHighway && !secret ? ` · ${formatMiles(item.highwayM)} on a highway (no way around)` : ''}
                      </Text>
                    </View>
                  </GlassCard>
                </PressableScale>
                </Animated.View>
              );
            }}
          />
          <GlassCard radiusSize={32} glow style={[s.sheet, { paddingBottom: insets.bottom + 12 }]}>
            {chosen ? (
              <Animated.View entering={enterRise} layout={moveList} style={s.sheetTop}>
                <HeroNumber
                  value={String(Math.round(chosen.durationS / 60))}
                  unit="min"
                  size={52}
                  caption={<TwoTone lead={chosen.style === 'fastest' ? 'Quickest ·' : extraMin > 0 ? `+${extraMin} min of side streets ·` : 'Side streets ·'} value={secret ? 'mystery arrival' : `arrive ${arrive}`} size="body" />}
                />
              </Animated.View>
            ) : null}
            <View style={s.recordRow}>
              <Text style={[t.body, { flex: 1 }]}>Record this drive</Text>
              <Switch value={record} onValueChange={setRecord} trackColor={{ true: p.brand }} accessibilityLabel="Record this drive" />
            </View>
            <PrimaryPill label={chosen ? 'Start' : 'Pick a route'} trailingIcon={chosen ? 'chevron-right' : undefined} onPress={go} disabled={!chosen} busy={starting} />
          </GlassCard>
        </View>
      )}
    </View>
  );
}

/** The selected route's green edge and glow, fading in and out on a spring. */
function SelectedGlow({ on }: { on: boolean }) {
  const p = useTheme();
  const v = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    v.value = withSpring(on ? 1 : 0, springFade);
  }, [on, v]);
  const style = useAnimatedStyle(() => ({ opacity: v.value }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <LinearGradient
        colors={['transparent', p.dark ? 'rgba(30, 107, 69, 0.35)' : 'rgba(30, 138, 87, 0.10)', p.dark ? 'rgba(59, 163, 115, 0.45)' : 'rgba(30, 138, 87, 0.16)']}
        locations={[0.35, 0.8, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { borderRadius: 22, borderWidth: 1.5, borderColor: p.brand }]} />
    </Animated.View>
  );
}

const useStyles = makeStyles((p, t) => ({
  screen: { flex: 1, backgroundColor: p.canvas },
  mapWrap: { height: '36%', overflow: 'hidden' },
  topBar: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', gap: 10, alignItems: 'center' },
  searchBox: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 },
  searchInput: { flex: 1, color: p.mint, fontSize: 16, fontWeight: '600' },
  destPill: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  destTo: { color: p.text3, fontWeight: '500', fontSize: 14 },
  destName: { flex: 1, color: p.mint, fontWeight: '700', fontSize: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  routeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  timeCol: { width: 56, alignItems: 'flex-start' },
  routeTime: { fontSize: 28, fontWeight: '700', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  sheet: { marginHorizontal: 0, paddingHorizontal: 16, paddingTop: 16, gap: 12, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  sheetTop: { gap: 4 },
  recordRow: { flexDirection: 'row', alignItems: 'center' },
}));
