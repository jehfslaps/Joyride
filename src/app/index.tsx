import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, Settings, StyleSheet, Text, View } from 'react-native';
import MapView from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEMO, demoReady } from '@/lib/demo';
import {
  ContextChip,
  GlassCard,
  GlowRoute,
  HeroNumber,
  IconTile,
  Label,
  LivePuck,
  PrimaryPill,
  RoundButton,
  TwoTone,
  useMapLook,
  Vignette,
} from '@/components/ui';
import { useHere } from '@/lib/useHere';
import { formatDuration, formatMiles, lineLength, type LngLat } from '@/lib/geo';
import {
  discardRecording,
  getRecorderState,
  startRecording,
  stopRecording,
  subscribe,
  type RecorderState,
} from '@/lib/recorder';
import { driveSubtitle, driveTitle, listDrives, type DriveSummary, type TrackPoint } from '@/lib/storage';
import { makeStyles, typeFor, useTheme } from '@/theme';

export default function Home() {
  const insets = useSafeAreaInsets();
  const p = useTheme();
  const t = typeFor(p);
  const s = useStyles();
  const mapLook = useMapLook();
  const here = useHere();
  const map = useRef<MapView>(null);
  const [state, setState] = useState<RecorderState>('idle');
  const [points, setPoints] = useState<TrackPoint[]>([]);
  const [drives, setDrives] = useState<DriveSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    await demoReady;
    setState(await getRecorderState());
    setDrives(await listDrives());
  }, []);

  // First launch: show the welcome screen once.
  useEffect(() => {
    if (DEMO) {
      // Screenshot runs pick the screen to open through the app's settings
      // (`defaults write <bundle id> demoRoute /routes?...`).
      const route = Settings.get('demoRoute');
      if (typeof route === 'string' && route.startsWith('/')) {
        demoReady.then(() => router.push(route as any));
      }
      return;
    }
    AsyncStorage.getItem('joyride:welcomed:v1')
      .then((v) => {
        if (!v) router.replace('/welcome');
      })
      .catch(() => {});
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  useEffect(() => subscribe((p) => setPoints([...p])), []);

  // Tick the timer once a second while recording.
  useEffect(() => {
    if (state !== 'recording') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);

  // Show where you are when the app opens.
  useEffect(() => {
    (async () => {
      const perm = await Location.getForegroundPermissionsAsync();
      if (perm.status !== 'granted') return;
      const pos = await Location.getLastKnownPositionAsync().catch(() => null);
      if (pos && points.length === 0) {
        map.current?.animateCamera(
          { center: { latitude: pos.coords.latitude, longitude: pos.coords.longitude }, altitude: 4000, zoom: 14 },
          { duration: 0 },
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the live trail in view.
  const last = points[points.length - 1];
  useEffect(() => {
    if (state === 'recording' && last) {
      map.current?.animateCamera({ center: { latitude: last[1], longitude: last[0] } }, { duration: 600 });
    }
  }, [state, last]);

  const coords = useMemo(() => points.map((p) => ({ latitude: p[1], longitude: p[0] })), [points]);
  const miles = useMemo(() => lineLength(points.map((p) => [p[0], p[1]] as LngLat)), [points]);
  const elapsed = points.length ? now - points[0][2] : 0;

  async function onStart() {
    setBusy(true);
    try {
      const r = await startRecording();
      if (!r.ok) {
        if (r.reason === 'services-off') {
          Alert.alert('Location is off', 'Turn on Location Services in Settings so Joyride can record your drive.');
        } else {
          Alert.alert(
            'Location needed',
            'Joyride needs your location to record drives. You can allow it in Settings.',
            [{ text: 'Not now' }, { text: 'Open Settings', onPress: () => Linking.openSettings() }],
          );
        }
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setState('recording');
      setNow(Date.now());
      if (!r.background) {
        Alert.alert(
          'Keep Joyride open',
          'Recording works, but it will pause if you lock your phone or switch apps. To record with the screen off, set Location to "Always" for Joyride in Settings.',
          [{ text: 'OK' }, { text: 'Open Settings', onPress: () => Linking.openSettings() }],
        );
      }
    } catch (e: any) {
      Alert.alert('Could not start', e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      const saved = await stopRecording();
      await refresh();
      if (saved) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        router.push({ pathname: '/drive/[id]', params: { id: saved.id } });
      } else {
        Alert.alert('Too short to save', 'That drive didn’t have enough GPS points to keep.');
      }
    } finally {
      setBusy(false);
    }
  }

  function onStop() {
    Alert.alert('End this drive?', `${formatMiles(miles)} · ${formatDuration(elapsed)}`, [
      { text: 'Keep driving', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () =>
          Alert.alert('Discard this drive?', 'It won’t be saved.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Discard', style: 'destructive', onPress: async () => { await discardRecording(); refresh(); } },
          ]),
      },
      { text: 'Save drive', onPress: finish },
    ]);
  }

  const recording = state === 'recording';
  const totalM = drives.reduce((a, d) => a + d.distanceM, 0);
  const startedAt = points[0] ? new Date(points[0][2]).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

  return (
    <View style={s.screen}>
      <View style={[s.mapWrap, { height: recording ? '58%' : '40%' }]}>
        <MapView ref={map} style={StyleSheet.absoluteFill} showsUserLocation={false} {...mapLook}>
          {coords.length > 1 && <GlowRoute coords={points.map((pt) => [pt[0], pt[1]] as LngLat)} />}
          {here && <LivePuck at={here} />}
        </MapView>
        <Vignette edge="top" height={insets.top + 110} />
        <Vignette edge="bottom" height={90} />
        <View style={[s.mapTop, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <Text style={s.brand} pointerEvents="none">
            <Text style={{ color: p.text3, fontWeight: '400' }}>joy</Text>ride
          </Text>
          {recording ? (
            <GlassCard radiusSize={18} style={s.recPill}>
              <View style={[s.recDot, { backgroundColor: p.glow, shadowColor: p.glow }]} />
              <Text style={s.recPillText}>Recording</Text>
            </GlassCard>
          ) : (
            <RoundButton icon="cog-outline" onPress={() => router.push('/settings')} label="Settings" />
          )}
        </View>
      </View>

      {recording ? (
        <View style={[s.panel, { paddingBottom: insets.bottom + 16 }]}>
          <HeroNumber value={clock(elapsed)} size={72} caption={<TwoTone lead="This drive ·" value={`started ${startedAt}`} size="body" />} />
          <View style={s.chipsRow}>
            <ContextChip prefix="Distance" label={formatMiles(miles)} />
          </View>
          <Text style={[t.caption, { marginTop: 4 }]}>Lock the phone or switch apps. It keeps recording.</Text>
          <View style={{ flex: 1 }} />
          <PrimaryPill label="Stop and save" icon="stop-circle-outline" tone="hazard" onPress={onStop} busy={busy} />
        </View>
      ) : (
        <FlatList
          style={s.list}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
          data={drives}
          keyExtractor={(d) => d.id}
          ListHeaderComponent={
            <View style={{ gap: 14, paddingBottom: 12 }}>
              {state === 'interrupted' && (
                <GlassCard style={s.notice}>
                  <MaterialCommunityIcons name="alert-circle-outline" size={22} color={p.caution} />
                  <Text style={[t.body, { flex: 1 }]}>A drive was still recording when Joyride closed.</Text>
                  <Pressable onPress={finish} hitSlop={10}>
                    <Text style={[s.noticeAction, { color: p.mint }]}>Save</Text>
                  </Pressable>
                  <Pressable onPress={async () => { await discardRecording(); refresh(); }} hitSlop={10}>
                    <Text style={[s.noticeAction, { color: p.text2 }]}>Discard</Text>
                  </Pressable>
                </GlassCard>
              )}
              {drives.length > 0 ? (
                <HeroNumber
                  value={(totalM / 1609.344).toFixed(totalM < 16093 ? 1 : 0)}
                  unit="mi"
                  caption={<TwoTone lead="Recorded so far ·" value={`${drives.length} drive${drives.length === 1 ? '' : 's'}`} size="body" />}
                />
              ) : (
                <TwoTone lead="Ready when" value="you are." />
              )}
              <PrimaryPill label="Start a drive" icon="record-circle-outline" onPress={onStart} busy={busy} />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <PrimaryPill label="Fun routes" icon="routes" tone="glass" onPress={() => router.push('/routes')} style={{ flex: 1 }} compact />
                <PrimaryPill label="Surprise me" icon="dice-5-outline" tone="glass" onPress={() => router.push('/surprise')} style={{ flex: 1 }} compact />
              </View>
              {drives.length > 0 && <Label style={{ marginTop: 10 }}>YOUR DRIVES</Label>}
            </View>
          }
          ListEmptyComponent={
            <GlassCard style={s.empty}>
              <IconTile icon="map-marker-path" size={48} />
              <Text style={[t.body, { color: p.text2, textAlign: 'center' }]}>
                No drives yet. Tap Start, go wherever the road takes you, and tap Stop when you’re home.
              </Text>
            </GlassCard>
          }
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/drive/[id]', params: { id: item.id } })}
              style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1, transform: [{ scale: pressed ? 0.99 : 1 }] })}
              accessibilityRole="button"
            >
              <GlassCard style={s.card}>
                <IconTile icon="map-marker-path" size={42} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={t.bodyStrong} numberOfLines={1}>{driveTitle(item)}</Text>
                  <Text style={t.caption}>
                    {driveSubtitle(item)} · {formatMiles(item.distanceM)} · {formatDuration(item.endedAt - item.startedAt)}
                  </Text>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={22} color={p.text3} />
              </GlassCard>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const useStyles = makeStyles((p, t) => ({
  screen: { flex: 1, backgroundColor: p.canvas },
  mapWrap: { width: '100%', overflow: 'hidden' },
  mapTop: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { ...t.display, fontWeight: '700' },
  recPill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, height: 36 },
  recDot: { width: 9, height: 9, borderRadius: 5, shadowOpacity: 0.9, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
  recPillText: { color: p.mint, fontSize: 14, fontWeight: '700' },
  panel: { flex: 1, paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  chipsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  list: { flex: 1, marginTop: 4 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 28, paddingHorizontal: 18 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  noticeAction: { fontWeight: '700', fontSize: 15 },
}));
