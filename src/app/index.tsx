import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, Settings, StyleSheet, Text, View } from 'react-native';
import MapView, { Polyline } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEMO, demoReady } from '@/lib/demo';
import { BigButton } from '@/components/BigButton';
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
import { colors, radius, type } from '@/theme';

export default function Home() {
  const insets = useSafeAreaInsets();
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

  return (
    <View style={styles.screen}>
      <View style={[styles.mapWrap, { height: recording ? '62%' : '42%' }]}>
        <MapView
          ref={map}
          style={StyleSheet.absoluteFill}
          showsUserLocation
          followsUserLocation={recording}
          userInterfaceStyle="dark"
          showsPointsOfInterests={false}
          showsCompass={false}
          tintColor={colors.amber}
        >
          {coords.length > 1 && (
            <Polyline coordinates={coords} strokeColor={colors.amber} strokeWidth={6} lineCap="round" lineJoin="round" />
          )}
        </MapView>
        <View style={[styles.mapTop, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <Text style={styles.brand} pointerEvents="none">Joyride</Text>
          {recording ? (
            <View style={styles.recPill} pointerEvents="none">
              <View style={styles.recDot} />
              <Text style={styles.recPillText}>RECORDING</Text>
            </View>
          ) : (
            <Pressable onPress={() => router.push('/settings')} hitSlop={10} style={styles.gear} accessibilityLabel="Settings">
              <MaterialCommunityIcons name="cog-outline" size={22} color={colors.text} />
            </Pressable>
          )}
        </View>
        <View style={styles.mapFade} pointerEvents="none" />
      </View>

      {recording ? (
        <View style={[styles.panel, { paddingBottom: insets.bottom + 16 }]}>
          <Text style={type.label}>THIS DRIVE</Text>
          <Text style={[styles.timer, type.mono]}>{clock(elapsed)}</Text>
          <View style={styles.statsRow}>
            <Stat label="Distance" value={formatMiles(miles)} />
            <Stat label="Started" value={points[0] ? new Date(points[0][2]).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '—'} />
          </View>
          <View style={{ flex: 1 }} />
          <BigButton label="Stop & save" icon="stop-circle" tone="red" onPress={onStop} busy={busy} />
        </View>
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 24 }}
          data={drives}
          keyExtractor={(d) => d.id}
          ListHeaderComponent={
            <View style={{ gap: 18, paddingTop: 4, paddingBottom: 12 }}>
              {state === 'interrupted' && (
                <View style={styles.notice}>
                  <MaterialCommunityIcons name="alert-circle-outline" size={22} color={colors.amber} />
                  <Text style={[type.body, { flex: 1 }]}>A drive was still recording when Joyride closed.</Text>
                  <Pressable onPress={finish} hitSlop={10}>
                    <Text style={styles.noticeAction}>Save</Text>
                  </Pressable>
                  <Pressable onPress={async () => { await discardRecording(); refresh(); }} hitSlop={10}>
                    <Text style={[styles.noticeAction, { color: colors.muted }]}>Discard</Text>
                  </Pressable>
                </View>
              )}
              <BigButton label="Start a drive" icon="record-circle" onPress={onStart} busy={busy} />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <BigButton label="Fun routes" icon="routes" tone="ghost" onPress={() => router.push('/routes')} style={{ flex: 1 }} />
                <BigButton label="Surprise me" icon="dice-5" tone="ghost" onPress={() => router.push('/surprise')} style={{ flex: 1 }} />
              </View>
              <Text style={[type.label, { marginTop: 8 }]}>YOUR DRIVES</Text>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <MaterialCommunityIcons name="map-marker-path" size={40} color={colors.faint} />
              <Text style={[type.body, { color: colors.muted, textAlign: 'center' }]}>
                No drives yet. Tap Start, go wherever the road takes you, and tap Stop when you’re home.
              </Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/drive/[id]', params: { id: item.id } })}
              style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.cardHi }]}
            >
              <View style={styles.cardIcon}>
                <MaterialCommunityIcons name="map-marker-path" size={22} color={colors.amber} />
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={styles.cardTitle} numberOfLines={1}>{driveTitle(item)}</Text>
                <Text style={type.small}>
                  {driveSubtitle(item)} · {formatMiles(item.distanceM)} · {formatDuration(item.endedAt - item.startedAt)}
                </Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={22} color={colors.faint} />
            </Pressable>
          )}
        />
      )}
    </View>
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

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  mapWrap: { width: '100%', overflow: 'hidden' },
  gear: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(11,14,19,0.82)', alignItems: 'center', justifyContent: 'center' },
  mapTop: { position: 'absolute', left: 20, right: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { ...type.hero, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 12 },
  recPill: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.redDim, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.red },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
  recPillText: { color: colors.text, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  mapFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 24, backgroundColor: colors.bg, opacity: 0.35 },
  panel: { flex: 1, paddingHorizontal: 20, paddingTop: 20, gap: 6 },
  timer: { fontSize: 64, fontWeight: '800', color: colors.text, letterSpacing: -2 },
  statsRow: { flexDirection: 'row', gap: 12, marginTop: 6 },
  stat: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, padding: 14, gap: 4 },
  statValue: { fontSize: 22, fontWeight: '700', color: colors.text },
  list: { flex: 1, marginTop: 16 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.card, borderRadius: radius.md, padding: 16 },
  cardIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,178,63,0.12)', alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 32, paddingHorizontal: 12 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: radius.md, padding: 14, borderWidth: 1, borderColor: colors.amberDim },
  noticeAction: { color: colors.amber, fontWeight: '700', fontSize: 15 },
});
