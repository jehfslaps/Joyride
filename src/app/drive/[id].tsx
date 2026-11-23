import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import MapView from 'react-native-maps';
import Animated from 'react-native-reanimated';
import { enterFade, enterRise, exitFade, moveList } from '@/lib/motion';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ContextChip, GlassRow, GlowRoute, HeroNumber, Label, LivePuck, PinTile, PrimaryPill, RoundButton, TwoTone, useMapLook, Vignette } from '@/components/ui';
import { useHere } from '@/lib/useHere';
import * as Haptics from 'expo-haptics';
import { SpotCard } from '@/components/SpotCard';
import { JoyrideNav } from '../../../modules/joyride-nav';
import { DEMO } from '@/lib/demo';
import { getRecorderState, startRecording } from '@/lib/recorder';
import { distance, formatMiles, heroDuration, project, type LngLat } from '@/lib/geo';
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
import { makeStyles, typeFor, useTheme } from '@/theme';

type Choice = { startAwayM: number; nearestAwayM: number; nearestPct: number };

export default function DriveScreen() {
  const { id, go: autoGo } = useLocalSearchParams<{ id: string; go?: string }>();
  const insets = useSafeAreaInsets();
  const p = useTheme();
  const t = typeFor(p);
  const s = useStyles();
  const mapLook = useMapLook();
  const here = useHere();
  const map = useRef<MapView>(null);
  const [drive, setDrive] = useState<DriveSummary | null>(null);
  const drafted = !!drive?.drafted;
  const [points, setPoints] = useState<TrackPoint[]>([]);
  const [preparing, setPreparing] = useState<number | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [recordBack, setRecordBack] = useState(true);
  // Tap and hold the map: a pin, with its address and GPS coordinates to copy.
  const [spot, setSpot] = useState<LngLat | null>(null);

  useEffect(() => {
    (async () => {
      setDrive(await getDrive(id));
      setPoints(await getDrivePoints(id));
    })();
  }, [id]);

  // Demo builds only: start reliving straight away (for screenshots).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!DEMO || autoGo !== '1' || autoStarted.current || points.length < 2) return;
    autoStarted.current = true;
    onRelive();
  }, [autoGo, points.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (JoyrideNav?.isAvailable) return onNativeRelive(false);
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

  // Relive the whole drive with the Mapbox navigation engine, or drive it
  // back: the same streets from the end to the start (one-way streets and
  // ramps get a short legal detour, then it rejoins).
  async function onNativeRelive(back = false) {
    if (!JoyrideNav) return;
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert('Location needed', 'Joyride needs your location to guide you.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const here: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      const trace = points.map((p) => [p[0], p[1]] as [number, number]);
      if (back) trace.reverse();
      const startAway = distance(here, trace[0]);
      const joinNearest = await new Promise<boolean>((resolve) => {
        if (startAway < 150) return resolve(false);
        Alert.alert('Where do you want to pick it up?', undefined, [
          { text: back ? 'From where it ended' : 'From the beginning', onPress: () => resolve(false) },
          { text: 'Nearest point', onPress: () => resolve(true) },
        ]);
      });
      setPreparing(0);
      // The trip back (or driving a drawn drive) is a new drive of its own.
      if ((back || drafted) && recordBack && (await getRecorderState()) !== 'recording') await startRecording().catch(() => null);
      await JoyrideNav.startReplay(trace, here, joinNearest, false, false);
    } catch (e: any) {
      Alert.alert('Couldn’t start navigation', e?.message ?? String(e));
    } finally {
      setPreparing(null);
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

  if (!drive) return <View style={s.screen} />;

  return (
    <View style={s.screen}>
      <View style={s.mapWrap}>
        <MapView
          ref={map}
          style={StyleSheet.absoluteFill}
          showsUserLocation={false}
          onMapReady={fit}
          onLongPress={(e) => {
            const c: LngLat = [e.nativeEvent.coordinate.longitude, e.nativeEvent.coordinate.latitude];
            // Close to the drive's line: snap onto it, so it's exactly where you drove.
            const line = points.map((pt) => [pt[0], pt[1]] as LngLat);
            const on = project(c, line);
            setSpot(on && on.offset < 25 ? on.point : c);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          }}
          onPress={() => setSpot(null)}
          {...mapLook}
        >
          {coords.length > 1 && (
            <>
              <GlowRoute coords={points.map((pt) => [pt[0], pt[1]] as LngLat)} />
              <PinTile at={[points[0][0], points[0][1]]} icon="circle-double" tone="start" />
              <PinTile at={[points[points.length - 1][0], points[points.length - 1][1]]} icon="flag-checkered" />
            </>
          )}
          {here && <LivePuck at={here} />}
          {spot && <PinTile key={`spot-${spot[0]}-${spot[1]}`} at={spot} icon="map-marker" />}
        </MapView>
        <Vignette edge="top" height={insets.top + 90} />
        <Vignette edge="bottom" height={70} />
        <View style={[s.topBar, { paddingTop: insets.top + 6 }]}>
          <RoundButton icon="chevron-left" onPress={() => router.back()} label="Back" />
          <View style={{ flex: 1 }} />
          <RoundButton icon="pencil-outline" onPress={onRename} label="Rename" />
          <RoundButton icon="delete-outline" onPress={onDelete} label="Delete" tone="hazard" />
        </View>
        {spot ? (
          <SpotCard at={spot} bottom={12} onClose={() => setSpot(null)} />
        ) : (
          <Text style={[s.holdHint, { color: p.text2 }]} pointerEvents="none">
            Tap and hold the map to copy a spot
          </Text>
        )}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: insets.bottom + 24 }}>
        <HeroNumber {...heroDuration(drive.endedAt - drive.startedAt)} caption={<TwoTone lead="Recorded" value={driveSubtitle(drive)} size="body" />} />
        <Text style={t.title} numberOfLines={2}>{driveTitle(drive)}</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <ContextChip prefix="Distance" label={formatMiles(drive.distanceM)} />
          <ContextChip prefix="Turns" label="every one" />
        </View>

        {choice ? (
          <Animated.View key="choice" entering={enterRise} exiting={exitFade} layout={moveList} style={{ gap: 10 }}>
            <Label>WHERE DO YOU WANT TO PICK IT UP?</Label>
            <GlassRow
              icon="home-outline"
              title="From the beginning"
              detail={`The start is ${formatMiles(choice.startAwayM)} away. You'll drive the whole thing.`}
              onPress={() => go('start')}
            />
            <GlassRow
              icon="crosshairs-gps"
              title="Nearest point"
              detail={`${formatMiles(choice.nearestAwayM)} away, about ${choice.nearestPct}% of the way into the drive.`}
              onPress={() => go('nearest')}
            />
            <Pressable onPress={() => setChoice(null)} style={{ alignSelf: 'center', padding: 8 }}>
              <Text style={[t.body, { color: p.text2 }]}>Cancel</Text>
            </Pressable>
          </Animated.View>
        ) : (
          <Animated.View key="relive" entering={enterFade} exiting={exitFade} layout={moveList}>
          <PrimaryPill
            label={preparing != null ? preparingLabel(preparing) : 'Relive this drive'}
            icon="steering"
            trailingIcon="chevron-right"
            onPress={onRelive}
            busy={preparing != null}
          />
          {JoyrideNav?.isAvailable && (
            <View style={{ gap: 10, marginTop: 10 }}>
              <PrimaryPill
                label="Drive it back"
                icon="swap-horizontal"
                tone="glass"
                onPress={() => onNativeRelive(true)}
                disabled={preparing != null}
              />
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 }}>
                <Text style={[t.caption, { flex: 1 }]}>
                  {drafted ? 'Record it as you drive, as a new drive (either direction)' : 'Same streets, end to start. Record the trip back as a new drive'}
                </Text>
                <Switch value={recordBack} onValueChange={setRecordBack} trackColor={{ true: p.brand }} accessibilityLabel="Record the trip back" />
              </View>
            </View>
          )}
          </Animated.View>
        )}

        {!hasMapbox() && (
          <Text style={[t.caption, { textAlign: 'center' }]}>
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

const useStyles = makeStyles((p) => ({
  screen: { flex: 1, backgroundColor: p.canvas },
  mapWrap: { height: '48%', overflow: 'hidden' },
  holdHint: { position: 'absolute', bottom: 34, alignSelf: 'center', fontSize: 12, fontWeight: '600' },
  topBar: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', gap: 10 },
}));
