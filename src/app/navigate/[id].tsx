import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import * as Speech from 'expo-speech';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Polyline } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BigButton } from '@/components/BigButton';
import { ManeuverIcon } from '@/components/ManeuverIcon';
import { formatDistance, formatMiles, indexAtDistance, type LngLat } from '@/lib/geo';
import { NavSession, type JoinMode, type SessionView } from '@/lib/session';
import { getCachedRoute } from '@/lib/storage';
import { colors, radius, type } from '@/theme';

const toLatLng = (c: LngLat) => ({ latitude: c[1], longitude: c[0] });

export default function NavigateScreen() {
  useKeepAwake();
  const { id, mode } = useLocalSearchParams<{ id: string; mode: JoinMode }>();
  const insets = useSafeAreaInsets();
  const map = useRef<MapView>(null);
  const session = useRef<NavSession | null>(null);
  const mutedRef = useRef(false);
  const headingRef = useRef(0);
  const followRef = useRef(true);

  const [view, setView] = useState<SessionView | null>(null);
  const [routeCoords, setRouteCoords] = useState<LngLat[]>([]);
  const [muted, setMuted] = useState(false);
  const [follow, setFollow] = useState(true);
  const [speedMps, setSpeedMps] = useState(0);
  const [here, setHere] = useState<LngLat | null>(null);

  useEffect(() => {
    mutedRef.current = muted;
    if (muted) Speech.stop();
  }, [muted]);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;

    const speak = (text: string) => {
      if (mutedRef.current || !text) return;
      Speech.stop();
      Speech.speak(text, { rate: 1.0, pitch: 1.0 });
    };

    (async () => {
      const route = await getCachedRoute(id);
      if (!route) {
        Alert.alert('Route not ready', 'Go back and tap “Relive this drive” again.');
        router.back();
        return;
      }
      setRouteCoords(route.coords);
      const s = new NavSession(route, speak);
      session.current = s;

      const first = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation });
      if (cancelled) return;
      const here: LngLat = [first.coords.longitude, first.coords.latitude];
      await s.begin(here, mode === 'nearest' ? 'nearest' : 'start');
      setHere(here);
      setView(await s.onPosition(here, 0));
      moveCamera(here, first.coords.heading ?? 0, 0);

      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 3, timeInterval: 1000 },
        async (loc) => {
          const p: LngLat = [loc.coords.longitude, loc.coords.latitude];
          const speed = Math.max(0, loc.coords.speed ?? 0);
          if (speed > 2 && loc.coords.heading != null && loc.coords.heading >= 0) headingRef.current = loc.coords.heading;
          setSpeedMps(speed);
          setHere(p);
          const v = await s.onPosition(p, speed);
          if (!cancelled) setView(v);
          moveCamera(p, headingRef.current, speed);
        },
      );
    })().catch((e) => {
      Alert.alert('Navigation problem', e?.message ?? String(e));
    });

    return () => {
      cancelled = true;
      sub?.remove();
      Speech.stop();
    };
  }, [id, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  function moveCamera(p: LngLat, heading: number, speed: number) {
    if (!followRef.current) return;
    // Zoom out a little on faster roads so turns show up sooner.
    const altitude = speed > 22 ? 1100 : speed > 13 ? 750 : 480;
    map.current?.animateCamera(
      { center: toLatLng(p), heading, pitch: 50, altitude, zoom: speed > 22 ? 15.5 : 17 },
      { duration: 900 },
    );
  }

  // Split the route into the part already driven (dim) and what's ahead (bright).
  const { done, ahead } = useMemo(() => {
    if (routeCoords.length < 2 || !view || !session.current) {
      return { done: [] as LngLat[], ahead: routeCoords };
    }
    const i = indexAtDistance(session.current.main.cum, view.mainProgressM);
    return { done: routeCoords.slice(0, i + 1), ahead: routeCoords.slice(Math.max(0, i)) };
  }, [routeCoords, view?.mainProgressM]); // eslint-disable-line react-hooks/exhaustive-deps

  const g = view?.guide ?? null;
  const onDetour = view?.phase === 'approach' || view?.phase === 'rejoin';
  const finished = view?.phase === 'done';

  function onEnd() {
    if (finished) return router.back();
    Alert.alert('End navigation?', undefined, [
      { text: 'Keep going', style: 'cancel' },
      { text: 'End', style: 'destructive', onPress: () => router.back() },
    ]);
  }

  return (
    <View style={styles.screen}>
      <MapView
        ref={map}
        style={StyleSheet.absoluteFill}
        userInterfaceStyle="dark"
        showsUserLocation
        showsCompass={false}
        showsPointsOfInterests={false}
        showsBuildings
        pitchEnabled
        tintColor={colors.blue}
        onPanDrag={() => follow && setFollow(false)}
      >
        {done.length > 1 && (
          <Polyline coordinates={done.map(toLatLng)} strokeColor={colors.amberDim} strokeWidth={7} lineCap="round" lineJoin="round" />
        )}
        {ahead.length > 1 && (
          <Polyline coordinates={ahead.map(toLatLng)} strokeColor={colors.amber} strokeWidth={8} lineCap="round" lineJoin="round" />
        )}
        {view?.detour && view.detour.length > 1 && (
          <Polyline coordinates={view.detour.map(toLatLng)} strokeColor={colors.blue} strokeWidth={8} lineCap="round" lineJoin="round" lineDashPattern={[1, 12]} />
        )}
        {view?.beeline && here && (
          <Polyline coordinates={[toLatLng(here), toLatLng(view.beeline)]} strokeColor={colors.blue} strokeWidth={4} lineDashPattern={[8, 10]} />
        )}
      </MapView>

      {/* Turn banner */}
      <View style={[styles.banner, { top: insets.top + 8 }, onDetour && { backgroundColor: '#123058' }]}>
        {finished ? (
          <View style={styles.bannerRow}>
            <MaterialCommunityIcons name="flag-checkered" size={44} color={colors.text} />
            <View style={{ flex: 1 }}>
              <Text style={styles.bannerDist}>Drive complete</Text>
              <Text style={styles.bannerText}>Hope it was as good as the first time.</Text>
            </View>
          </View>
        ) : g?.next ? (
          <>
            {onDetour && <Text style={styles.bannerTag}>{view?.phase === 'rejoin' ? 'BACK TO THE ROUTE' : 'GETTING TO THE ROUTE'}</Text>}
            <View style={styles.bannerRow}>
              <ManeuverIcon step={g.next} size={52} color={colors.text} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.bannerDist, type.mono]}>{formatDistance(g.distToNextM)}</Text>
                <Text style={styles.bannerText} numberOfLines={2}>{g.next.instruction}</Text>
              </View>
            </View>
            {g.then && (
              <View style={styles.thenRow}>
                <Text style={styles.thenText}>Then</Text>
                <ManeuverIcon step={g.then} size={20} color={colors.text} />
              </View>
            )}
          </>
        ) : (
          <View style={styles.bannerRow}>
            <MaterialCommunityIcons name="navigation-variant" size={44} color={colors.text} />
            <Text style={[styles.bannerText, { flex: 1 }]}>
              {view?.beeline ? 'Head toward the route on the map' : 'Finding your position…'}
            </Text>
          </View>
        )}
      </View>

      {/* Bottom bar */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        {!follow && (
          <Pressable style={styles.recenter} onPress={() => setFollow(true)}>
            <MaterialCommunityIcons name="navigation-variant" size={18} color={colors.onAmber} />
            <Text style={{ color: colors.onAmber, fontWeight: '700' }}>Re-center</Text>
          </Pressable>
        )}
        {finished ? (
          <BigButton label="Back to my drives" icon="check" onPress={() => router.back()} />
        ) : (
          <View style={styles.bottomRow}>
            <Pressable onPress={() => setMuted((m) => !m)} style={styles.iconBtn} hitSlop={6}>
              <MaterialCommunityIcons name={muted ? 'volume-off' : 'volume-high'} size={24} color={colors.text} />
            </Pressable>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={[styles.remain, type.mono]}>{view ? formatMiles(view.mainRemainingM) : '—'}</Text>
              <Text style={type.small}>
                {view ? `left of the drive · ${Math.round(speedMps * 2.23694)} mph` : 'getting ready'}
              </Text>
            </View>
            <Pressable onPress={onEnd} style={[styles.iconBtn, { backgroundColor: colors.red }]} hitSlop={6}>
              <MaterialCommunityIcons name="close" size={24} color={colors.text} />
            </Pressable>
          </View>
        )}
        {view && view.mainTotalM > 0 && !finished && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(100, (view.mainProgressM / view.mainTotalM) * 100)}%` }]} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  banner: {
    position: 'absolute', left: 12, right: 12, backgroundColor: '#13261C', borderRadius: radius.lg, padding: 16, gap: 8,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
  },
  bannerTag: { color: colors.blue, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  bannerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  bannerDist: { fontSize: 30, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  bannerText: { fontSize: 19, fontWeight: '600', color: colors.text },
  thenRow: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 4 },
  thenText: { color: colors.text, fontWeight: '700' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, paddingTop: 14, paddingHorizontal: 16, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, gap: 12 },
  bottomRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.cardHi, alignItems: 'center', justifyContent: 'center' },
  remain: { fontSize: 26, fontWeight: '800', color: colors.text },
  recenter: { position: 'absolute', top: -56, alignSelf: 'center', flexDirection: 'row', gap: 6, alignItems: 'center', backgroundColor: colors.amber, borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 10 },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: colors.amber },
});
