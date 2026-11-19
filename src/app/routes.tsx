import { MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { JoyrideNav } from '../../modules/joyride-nav';
import { BigButton } from '@/components/BigButton';
import { buildFunRoutes, NO_RULES, VisitedStreets, type RoadRules, type RouteOption } from '@/lib/funroutes';
import { formatDuration, formatMiles, type LngLat } from '@/lib/geo';
import { searchPlaces, type Place } from '@/lib/places';
import { getRecorderState, startRecording } from '@/lib/recorder';
import { getDrivePoints, listDrives } from '@/lib/storage';
import { colors, radius, type } from '@/theme';

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

  // Keep the map framing everything.
  useEffect(() => {
    const pts: LngLat[] = [];
    if (here) pts.push(here);
    if (dest && !secret) pts.push(dest.coord);
    for (const r of chosen ? [chosen] : routes) pts.push(...r.coords.filter((_, i) => i % 10 === 0));
    if (pts.length < 2) return;
    map.current?.fitToCoordinates(pts.map(toLatLng), {
      edgePadding: { top: insets.top + 90, right: 40, bottom: 40, left: 40 },
      animated: true,
    });
  }, [routes.length, chosen, here, dest, secret, insets.top]);

  async function go() {
    if (!chosen || !here) return;
    if (!JoyrideNav) {
      Alert.alert('Not available in this build', 'Fun routes need the new navigation engine, which comes with the next app build.');
      return;
    }
    setStarting(true);
    try {
      if (record && (await getRecorderState()) !== 'recording') await startRecording().catch(() => null);
      await JoyrideNav.startReplay(chosen.coords, here, false, false);
    } catch (e: any) {
      Alert.alert('Couldn’t start navigation', e?.message ?? String(e));
    } finally {
      setStarting(false);
    }
  }

  const destLabel = secret ? 'Mystery destination' : dest?.name ?? '';

  return (
    <View style={styles.screen}>
      <View style={styles.mapWrap}>
        <MapView ref={map} style={StyleSheet.absoluteFill} userInterfaceStyle="dark" showsUserLocation showsPointsOfInterests={false}>
          {routes.map((r) => (
            <Polyline
              key={r.id}
              coordinates={r.coords.map(toLatLng)}
              strokeColor={r.id === selected ? colors.amber : 'rgba(139,148,163,0.55)'}
              strokeWidth={r.id === selected ? 6 : 3}
              zIndex={r.id === selected ? 2 : 1}
              tappable
              onPress={() => setSelected(r.id)}
            />
          ))}
          {chosen?.via
            .filter((v) => v.kind !== 'street')
            .map((v, i) => (
              <Marker key={`via-${i}`} coordinate={toLatLng(v.coord)} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
                <View style={[styles.viaDot, { backgroundColor: v.kind === 'culdesac' ? colors.red : colors.green }]} />
              </Marker>
            ))}
          {dest && !secret && (
            <Marker coordinate={toLatLng(dest.coord)} tracksViewChanges={false}>
              <View style={styles.flag}>
                <MaterialCommunityIcons name="flag-checkered" size={16} color={colors.bg} />
              </View>
            </Marker>
          )}
        </MapView>
        <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.round} accessibilityLabel="Back">
            <MaterialCommunityIcons name="chevron-left" size={28} color={colors.text} />
          </Pressable>
          {dest ? (
            <Pressable
              style={styles.destPill}
              onPress={() => {
                if (params.lng) return;
                setDest(null);
                setRoutes([]);
              }}
            >
              <Text style={styles.destTo}>To</Text>
              <Text style={styles.destName} numberOfLines={1}>{destLabel}</Text>
              {!params.lng && <MaterialCommunityIcons name="close-circle" size={18} color={colors.muted} />}
            </Pressable>
          ) : (
            <View style={styles.searchBox}>
              <MaterialCommunityIcons name="magnify" size={20} color={colors.muted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Where to?"
                placeholderTextColor={colors.faint}
                style={styles.searchInput}
                autoFocus
                returnKeyType="search"
                accessibilityLabel="Destination"
              />
              {searching && <ActivityIndicator color={colors.muted} />}
            </View>
          )}
        </View>
      </View>

      {!dest ? (
        <FlatList
          data={results}
          keyExtractor={(p, i) => `${p.name}-${i}`}
          contentContainerStyle={{ padding: 20, gap: 10, paddingBottom: insets.bottom + 24 }}
          ListEmptyComponent={
            <Text style={[type.small, { textAlign: 'center', marginTop: 12 }]}>
              {query.trim().length < 3 ? 'Type a place, address, or city.' : searching ? '' : 'No matches yet.'}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => setDest(item)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.cardHi }]}>
              <MaterialCommunityIcons name="map-marker" size={22} color={colors.amber} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{item.name}</Text>
                {!!item.detail && <Text style={type.small} numberOfLines={1}>{item.detail}</Text>}
              </View>
            </Pressable>
          )}
        />
      ) : (
        <View style={{ flex: 1 }}>
          <FlatList
            data={routes}
            keyExtractor={(r) => r.id}
            contentContainerStyle={{ padding: 20, gap: 8, paddingBottom: 12 }}
            ListHeaderComponent={
              <View style={{ gap: 12, marginBottom: 4 }}>
                <View style={styles.chips}>
                  <Chip label="No freeways" on={!!rules?.noFreeways} onPress={() => toggle('noFreeways')} />
                  <Chip label="No highways" on={!!rules?.noHighways} onPress={() => toggle('noHighways')} />
                  <View style={{ flex: 1 }} />
                  <Pressable
                    onPress={() => setShuffle((n) => n + 1)}
                    disabled={building}
                    hitSlop={8}
                    style={({ pressed }) => [styles.shuffle, (pressed || building) && { opacity: 0.5 }]}
                    accessibilityLabel="New routes"
                  >
                    <MaterialCommunityIcons name="shuffle-variant" size={18} color={colors.text} />
                    <Text style={styles.shuffleText}>New</Text>
                  </Pressable>
                </View>
                <Text style={type.label}>
                  {building ? 'FINDING SIDE STREETS…' : `${routes.length} ROUTES, FASTEST TO LONGEST`}
                </Text>
              </View>
            }
            ListFooterComponent={building ? <ActivityIndicator color={colors.amber} style={{ marginTop: 8 }} /> : undefined}
            renderItem={({ item }) => {
              const on = item.id === selected;
              return (
                <Pressable
                  onPress={() => setSelected(item.id)}
                  style={[styles.routeRow, on && styles.routeRowOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.routeTime, on && { color: colors.amber }, item.style === 'fastest' && !on && { color: colors.muted }]}>
                    {formatDuration(item.durationS * 1000)}
                  </Text>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.rowTitle}>{item.title}</Text>
                    <Text style={type.small} numberOfLines={2}>
                      {item.blurb}
                    </Text>
                    <Text style={[type.small, { color: colors.faint }]} numberOfLines={1}>
                      {formatMiles(item.distanceM)}
                      {item.newShare != null && item.style !== 'fastest' ? ` · ${Math.round(item.newShare * 100)}% new to you` : ''}
                      {item.usesHighway ? ` · ${formatMiles(item.highwayM)} on a highway (no way around)` : ''}
                    </Text>
                  </View>
                </Pressable>
              );
            }}
          />
          <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
            <View style={styles.recordRow}>
              <Text style={[type.body, { flex: 1 }]}>Record this drive</Text>
              <Switch value={record} onValueChange={setRecord} trackColor={{ true: colors.amber }} accessibilityLabel="Record this drive" />
            </View>
            <BigButton
              label={chosen ? (chosen.style === 'fastest' ? 'Go the quick way' : 'Start this route') : 'Pick a route'}
              icon="steering"
              onPress={go}
              disabled={!chosen}
              busy={starting}
            />
          </View>
        </View>
      )}
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
    >
      <MaterialCommunityIcons name={on ? 'check-circle' : 'circle-outline'} size={16} color={on ? colors.onAmber : colors.muted} />
      <Text style={[styles.chipText, on && { color: colors.onAmber }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  mapWrap: { height: '38%', overflow: 'hidden' },
  topBar: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', gap: 10, alignItems: 'center' },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(11,14,19,0.86)', alignItems: 'center', justifyContent: 'center' },
  searchBox: { flex: 1, height: 44, borderRadius: 22, backgroundColor: 'rgba(11,14,19,0.92)', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 },
  searchInput: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '600' },
  destPill: { flex: 1, height: 44, borderRadius: 22, backgroundColor: 'rgba(11,14,19,0.92)', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  destTo: { color: colors.muted, fontWeight: '600', fontSize: 13 },
  destName: { flex: 1, color: colors.text, fontWeight: '700', fontSize: 16 },
  flag: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, padding: 14 },
  rowTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  routeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 2, borderColor: 'transparent' },
  routeRowOn: { borderColor: colors.amber, backgroundColor: '#1C1A14' },
  routeTime: { width: 76, fontSize: 18, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  footer: { paddingHorizontal: 20, paddingTop: 8, gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  recordRow: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  chipOn: { backgroundColor: colors.amber, borderColor: colors.amber },
  chipText: { fontSize: 14, fontWeight: '700', color: colors.text },
  shuffle: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 36, paddingHorizontal: 10 },
  shuffleText: { fontSize: 14, fontWeight: '700', color: colors.text },
  viaDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: '#fff' },
});
