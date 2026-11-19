import { useKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import * as Speech from 'expo-speech';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import MapView from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassCard, GlowRoute, IconTile, LivePuck, PrimaryPill, RoundButton, useMapLook, Vignette } from '@/components/ui';
import { ManeuverIcon } from '@/components/ManeuverIcon';
import { formatDistance, formatMiles, indexAtDistance, type LngLat } from '@/lib/geo';
import { NavSession, type JoinMode, type SessionView } from '@/lib/session';
import { getCachedRoute } from '@/lib/storage';
import { makeStyles, typeFor, useTheme } from '@/theme';

const toLatLng = (c: LngLat) => ({ latitude: c[1], longitude: c[0] });

export default function NavigateScreen() {
  useKeepAwake();
  const { id, mode } = useLocalSearchParams<{ id: string; mode: JoinMode }>();
  const insets = useSafeAreaInsets();
  const p = useTheme();
  const t = typeFor(p);
  const s = useStyles();
  const mapLook = useMapLook();
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
    <View style={s.screen}>
      <MapView
        ref={map}
        style={StyleSheet.absoluteFill}
        {...mapLook}
        showsUserLocation={false}
        pitchEnabled
        onPanDrag={() => follow && setFollow(false)}
      >
        {done.length > 1 && <GlowRoute coords={done} travelled />}
        {ahead.length > 1 && <GlowRoute coords={ahead} z={3} />}
        {view?.detour && view.detour.length > 1 && <GlowRoute coords={view.detour} dim z={2} />}
        {view?.beeline && here && <GlowRoute coords={[here, view.beeline]} dim z={2} />}
        {here && <LivePuck at={here} />}
      </MapView>
      <Vignette edge="top" height={insets.top + 150} />

      {/* Turn banner: high-opacity glass so it stays readable over any map. */}
      <GlassCard strong style={[s.banner, { top: insets.top + 8 }]}>
        {finished ? (
          <View style={s.bannerRow}>
            <IconTile icon="flag-checkered" size={56} glow />
            <View style={{ flex: 1 }}>
              <Text style={s.bannerDist}>Arrived.</Text>
              <Text style={s.bannerText}>Hope it was as good as the first time.</Text>
            </View>
          </View>
        ) : g?.next ? (
          <>
            {onDetour && <Text style={s.bannerTag}>{view?.phase === 'rejoin' ? 'BACK TO THE ROUTE' : 'GETTING TO THE ROUTE'}</Text>}
            <View style={s.bannerRow}>
              <View style={[s.turnTile, { backgroundColor: p.tile, shadowColor: p.glow }]}>
                <ManeuverIcon step={g.next} size={40} color={p.glow} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.bannerDist, t.mono]}>{formatDistance(g.distToNextM)}</Text>
                <Text style={s.bannerText} numberOfLines={2}>{g.next.instruction}</Text>
              </View>
            </View>
            {g.then && (
              <View style={s.thenRow}>
                <Text style={s.thenText}>Then</Text>
                <ManeuverIcon step={g.then} size={20} color={p.mint} />
              </View>
            )}
          </>
        ) : (
          <View style={s.bannerRow}>
            <IconTile icon="navigation-variant-outline" size={56} glow />
            <Text style={[s.bannerText, { flex: 1 }]}>
              {view?.beeline ? 'Head toward the route on the map' : 'Finding your position…'}
            </Text>
          </View>
        )}
      </GlassCard>

      {/* Trip sheet */}
      <GlassCard strong glow radiusSize={32} style={[s.bottom, { paddingBottom: insets.bottom + 12 }]}>
        {!follow && (
          <View style={s.recenterWrap}>
            <PrimaryPill label="Re-center" icon="navigation-variant-outline" onPress={() => setFollow(true)} compact />
          </View>
        )}
        {finished ? (
          <PrimaryPill label="Back to my drives" icon="check" onPress={() => router.back()} />
        ) : (
          <View style={s.bottomRow}>
            <RoundButton icon={muted ? 'volume-off' : 'volume-high'} onPress={() => setMuted((m) => !m)} label={muted ? 'Unmute' : 'Mute'} />
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={[s.remain, t.mono]}>{view ? formatMiles(view.mainRemainingM) : '—'}</Text>
              <Text style={t.caption}>{view ? `left of the drive · ${Math.round(speedMps * 2.23694)} mph` : 'getting ready'}</Text>
            </View>
            <PrimaryPill label="End" tone="hazard" onPress={onEnd} compact />
          </View>
        )}
        {view && view.mainTotalM > 0 && !finished && (
          <View style={[s.progressTrack, { backgroundColor: p.hairline }]}>
            <View style={[s.progressFill, { backgroundColor: p.brand, width: `${Math.min(100, (view.mainProgressM / view.mainTotalM) * 100)}%` }]} />
          </View>
        )}
      </GlassCard>
    </View>
  );
}

const useStyles = makeStyles((p) => ({
  screen: { flex: 1, backgroundColor: p.canvas },
  banner: { position: 'absolute', left: 12, right: 12, padding: 16, gap: 8 },
  bannerTag: { color: p.caution, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  bannerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  turnTile: { width: 60, height: 60, borderRadius: 14, alignItems: 'center', justifyContent: 'center', shadowOpacity: p.dark ? 0.45 : 0, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } },
  bannerDist: { fontSize: 32, fontWeight: '700', color: p.mint, letterSpacing: -0.5 },
  bannerText: { fontSize: 20, fontWeight: '600', color: p.mint },
  thenRow: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', backgroundColor: p.tile, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  thenText: { color: p.mint, fontWeight: '700' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 14, paddingHorizontal: 16, gap: 12, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  bottomRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  remain: { fontSize: 28, fontWeight: '700', color: p.mint },
  recenterWrap: { position: 'absolute', top: -60, alignSelf: 'center' },
  progressTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: 4 },
}));
