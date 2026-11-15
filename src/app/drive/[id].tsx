import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BigButton } from '@/components/BigButton';
import { JoyrideNav } from '../../../modules/joyride-nav';
import { distance, formatDuration, formatMiles, thin, type LngLat } from '@/lib/geo';
import { Guidance } from '@/lib/guidance';
import { buildRouteFromDrive, hasMapbox, MapboxError } from '@/lib/mapbox';
import type { NavRoute } from '@/lib/route';
import {
  cacheRoute,
  deleteDrive,
  driveSubtitle,
  driveTitle,
  getCachedRoute,
  getDrive,
  getDrivePoints,
  renameDrive,
  type DriveSummary,
  type TrackPoint,
} from '@/lib/storage';
import { colors, radius, type } from '@/theme';

type Choice = { startAwayM: number; nearestAwayM: number; nearestPct: number };

export default function DriveScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const map = useRef<MapView>(null);
  const [drive, setDrive] = useState<DriveSummary | null>(null);
  const [points, setPoints] = useState<TrackPoint[]>([]);
  const [preparing, setPreparing] = useState<number | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);

  useEffect(() => {
    (async () => {
      setDrive(await getDrive(id));
      setPoints(await getDrivePoints(id));
    })();
  }, [id]);

  const coords = useMemo(() => points.map((p) => ({ latitude: p[1], longitude: p[0] })), [points]);

  function fit() {
    if (coords.length < 2) return;
    map.current?.fitToCoordinates(coords, {
      edgePadding: { top: insets.top + 80, right: 40, bottom: 40, left: 40 },
      animated: false,
    });
  }

  useEffect(fit, [coords.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function getRoute(): Promise<NavRoute> {
    const cached = await getCachedRoute(id);
    // Re-match if it was saved without street names and we can now do better.
    if (cached && (cached.fullyMatched || !hasMapbox())) return cached;
    setPreparing(0);
    const route = await buildRouteFromDrive(points, (f) => setPreparing(f));
    await cacheRoute(id, route);
    return route;
  }

  async function onRelive() {
    try {
      setPreparing(0);
      const route = await getRoute();
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert('Location needed', 'Joyride needs your location to guide you.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const here: LngLat = [pos.coords.longitude, pos.coords.latitude];
      const g = new Guidance(route);
      const near = g.nearest(here);
      const startAwayM = distance(here, route.coords[0]);
      // Already at the start (usually home), or the nearest point *is* basically the start.
      if (!near || startAwayM < 150 || startAwayM - near.offsetM < 400) {
        go('start');
        return;
      }
      setChoice({ startAwayM, nearestAwayM: near.offsetM, nearestPct: Math.round((near.atM / g.totalM) * 100) });
    } catch (e: any) {
      Alert.alert(
        'Couldn’t prepare directions',
        e instanceof MapboxError ? e.message : 'Check your internet connection and try again.',
      );
    } finally {
      setPreparing(null);
    }
  }

  // Phase 1 test: guide along the first part of the drive with the Mapbox engine.
  // The engine takes up to 100 points per request, so long drives are trimmed for now.
  async function onBetaRelive() {
    if (!JoyrideNav) return;
    const coords = points.map((p) => [p[0], p[1]] as LngLat);
    const keep = thin(coords, 35).slice(0, 100).map((i) => coords[i]);
    if (keep.length < 2) {
      Alert.alert('Drive too short', 'This drive doesn’t have enough points to navigate.');
      return;
    }
    try {
      await JoyrideNav.startMatchedNavigation(keep, false);
    } catch (e: any) {
      Alert.alert('Couldn’t start navigation', e?.message ?? String(e));
    }
  }

  function go(mode: 'start' | 'nearest') {
    setChoice(null);
    router.push({ pathname: '/navigate/[id]', params: { id, mode } });
  }

  function onRename() {
    if (!drive) return;
    Alert.prompt(
      'Name this drive',
      undefined,
      async (text) => {
        await renameDrive(id, text);
        setDrive(await getDrive(id));
      },
      'plain-text',
      drive.name ?? '',
    );
  }

  function onDelete() {
    Alert.alert('Delete this drive?', 'This can’t be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteDrive(id);
          router.back();
        },
      },
    ]);
  }

  if (!drive) return <View style={styles.screen} />;

  return (
    <View style={styles.screen}>
      <View style={styles.mapWrap}>
        <MapView
          ref={map}
          style={StyleSheet.absoluteFill}
          userInterfaceStyle="dark"
          showsUserLocation
          showsPointsOfInterests={false}
          onMapReady={fit}
        >
          {coords.length > 1 && (
            <>
              <Polyline coordinates={coords} strokeColor={colors.amber} strokeWidth={5} lineCap="round" lineJoin="round" />
              <Marker coordinate={coords[0]} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
                <View style={[styles.dot, { backgroundColor: colors.green }]} />
              </Marker>
              <Marker coordinate={coords[coords.length - 1]} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
                <View style={styles.flag}>
                  <MaterialCommunityIcons name="flag-checkered" size={16} color={colors.bg} />
                </View>
              </Marker>
            </>
          )}
        </MapView>
        <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
          <RoundButton icon="chevron-left" onPress={() => router.back()} />
          <View style={{ flex: 1 }} />
          <RoundButton icon="pencil-outline" onPress={onRename} />
          <RoundButton icon="delete-outline" onPress={onDelete} />
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: insets.bottom + 24 }}>
        <View style={{ gap: 4 }}>
          <Text style={type.title}>{driveTitle(drive)}</Text>
          <Text style={type.small}>{driveSubtitle(drive)}</Text>
        </View>

        <View style={styles.statsRow}>
          <Stat label="Distance" value={formatMiles(drive.distanceM)} />
          <Stat label="Time" value={formatDuration(drive.endedAt - drive.startedAt)} />
        </View>

        {choice ? (
          <View style={{ gap: 10 }}>
            <Text style={type.label}>WHERE DO YOU WANT TO PICK IT UP?</Text>
            <ChoiceCard
              icon="home-outline"
              title="From the beginning"
              detail={`The start is ${formatMiles(choice.startAwayM)} away. You'll drive the whole thing.`}
              onPress={() => go('start')}
            />
            <ChoiceCard
              icon="crosshairs-gps"
              title="Nearest point"
              detail={`${formatMiles(choice.nearestAwayM)} away, about ${choice.nearestPct}% of the way into the drive.`}
              onPress={() => go('nearest')}
            />
            <Pressable onPress={() => setChoice(null)} style={{ alignSelf: 'center', padding: 8 }}>
              <Text style={[type.body, { color: colors.muted }]}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <BigButton
            label={preparing != null ? preparingLabel(preparing) : 'Relive this drive'}
            icon="steering"
            onPress={onRelive}
            busy={preparing != null}
          />
        )}

        {JoyrideNav?.isAvailable && !choice && (
          <Pressable onPress={onBetaRelive} style={{ alignSelf: 'center', padding: 8 }} accessibilityRole="button">
            <Text style={[type.small, { color: colors.amber }]}>Try the new navigation engine (beta)</Text>
          </Pressable>
        )}

        {!hasMapbox() && (
          <Text style={[type.small, { textAlign: 'center' }]}>
            Directions will show turns but no street names until a Mapbox token is added.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function preparingLabel(f: number) {
  return f > 0 && f < 1 ? `Matching roads… ${Math.round(f * 100)}%` : 'Preparing directions…';
}

function RoundButton({ icon, onPress }: { icon: 'chevron-left' | 'pencil-outline' | 'delete-outline'; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => [styles.round, pressed && { opacity: 0.7 }]}>
      <MaterialCommunityIcons name={icon} size={icon === 'chevron-left' ? 28 : 20} color={colors.text} />
    </Pressable>
  );
}

function ChoiceCard({ icon, title, detail, onPress }: { icon: 'home-outline' | 'crosshairs-gps'; title: string; detail: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.choice, pressed && { backgroundColor: colors.cardHi }]}>
      <MaterialCommunityIcons name={icon} size={26} color={colors.amber} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>{title}</Text>
        <Text style={type.small}>{detail}</Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={22} color={colors.faint} />
    </Pressable>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={type.small}>{label}</Text>
      <Text style={[styles.statValue, type.mono]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  mapWrap: { height: '50%', overflow: 'hidden' },
  topBar: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', gap: 10 },
  round: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(11,14,19,0.82)', alignItems: 'center', justifyContent: 'center' },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: '#fff' },
  flag: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  statsRow: { flexDirection: 'row', gap: 12 },
  stat: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, padding: 14, gap: 4 },
  statValue: { fontSize: 22, fontWeight: '700', color: colors.text },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.card, borderRadius: radius.md, padding: 16 },
});
