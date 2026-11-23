// Draw a drive (phone only): make your own route on the map, save it, then
// relive it with turn-by-turn like any other drive.
//
//  - Draw: turn the pencil on and drag a finger along the streets; when you
//    lift it, the line snaps onto the streets you traced. With the pencil on,
//    the map holds still (use + / − to zoom); off, the map moves normally.
//    A second finger during a stroke cancels it, so pinches never draw.
//  - The drive starts wherever you first draw or tap (any city), or at your
//    location with "Start from my location".
//  - Tap: tap a street and it connects from the last point along real streets.
//  - Undo / Redo step back and forth through strokes and taps.
//  - Back to start closes the loop. Parts Joyride had to change to follow
//    legal streets (a one-way the other way, say) show in amber.

import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import MapView, { Polyline, type Region } from 'react-native-maps';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassCard, GlowRoute, PinTile, PrimaryPill, RoundButton, Segmented, TwoTone, useMapLook, Vignette } from '@/components/ui';
import { connect, joined, snapStroke, toTrack, totals, type Piece } from '@/lib/draft';
import { distance, formatMiles, type LngLat } from '@/lib/geo';
import { enterFade, enterRise, exitFade, moveList } from '@/lib/motion';
import { saveDrive } from '@/lib/storage';
import { useHere } from '@/lib/useHere';
import { makeStyles, typeFor, useTheme } from '@/theme';

type Mode = 'draw' | 'tap';
/** One undoable step: what it added (one or more pieces). */
type Step = Piece[];

const toLatLng = (c: LngLat) => ({ latitude: c[1], longitude: c[0] });

export default function DrawScreen() {
  const p = useTheme();
  const t = typeFor(p);
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const mapLook = useMapLook();
  const here = useHere();
  const map = useRef<MapView>(null);

  const [mode, setMode] = useState<Mode>('draw');
  // The pencil: on, one finger draws and the map holds still; off, the map moves.
  const [pen, setPen] = useState(false);
  const drawing = mode === 'draw' && pen;
  // Where the drive starts: set by a tap, a long-press or "Start from my location";
  // otherwise it's wherever the first stroke begins.
  const [pinnedStart, setStart] = useState<LngLat | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [redo, setRedo] = useState<Step[]>([]);
  const [busy, setBusy] = useState(0);
  const [stroke, setStroke] = useState<LngLat[]>([]);
  const strokeRef = useRef<LngLat[]>([]);
  const [saving, setSaving] = useState(false);

  const pieces = useMemo(() => steps.flat(), [steps]);
  const start: LngLat | null = pinnedStart ?? pieces[0]?.coords[0] ?? null;
  const end = pieces.length ? pieces[pieces.length - 1].coords[pieces[pieces.length - 1].coords.length - 1] : start;
  const sum = totals(pieces);
  const adjusted = pieces.filter((x) => x.adjusted).length;

  // A queue, so quick strokes/taps are added in order even while snapping.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const lastEnd = useRef<LngLat | null>(null);
  lastEnd.current = end ?? null;

  const addStep = (make: (from: LngLat | null) => Promise<Step>) => {
    setBusy((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        const step = (await make(lastEnd.current)).filter((x) => x.coords.length >= 2);
        if (step.length) {
          lastEnd.current = step[step.length - 1].coords[step[step.length - 1].coords.length - 1];
          setSteps((list) => [...list, step]);
          setRedo([]);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        } else {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        }
      } finally {
        setBusy((n) => n - 1);
      }
    });
  };

  // ---- Draw: one finger traces, lifting it snaps the stroke onto the streets.
  const tainted = useRef(false);
  const onTouches = (count: number) => {
    // A second finger: it's a pinch, not a stroke. Drop what's been drawn.
    if (count > 1) {
      tainted.current = true;
      strokeRef.current = [];
      setStroke([]);
    }
  };
  const onDrag = (c: LngLat) => {
    if (tainted.current) return;
    const list = strokeRef.current;
    const last = list[list.length - 1];
    if (last && distance(last, c) < 6) return;
    list.push(c);
    setStroke([...list]);
  };
  const finishStroke = (stillTouching = 0) => {
    if (stillTouching > 0) return;
    const wasTainted = tainted.current;
    tainted.current = false;
    const raw = strokeRef.current;
    strokeRef.current = [];
    if (wasTainted || raw.length < 2) {
      setStroke([]);
      return;
    }
    addStep(async (from) => {
      try {
        return await snapStroke(raw, from);
      } finally {
        setStroke([]);
      }
    });
  };

  // ---- Tap: connects from the last point along real streets.
  const onTapMap = (c: LngLat) => {
    if (mode !== 'tap') return;
    if (!start) {
      setStart(c);
      return;
    }
    addStep(async (from) => {
      const piece = from ? await connect(from, c) : null;
      return piece ? [piece] : [];
    });
  };

  // + / − while the pencil holds the map still.
  const region = useRef<Region | null>(null);
  const zoom = (factor: number) => {
    const r = region.current;
    if (!r) return;
    map.current?.animateToRegion(
      { ...r, latitudeDelta: Math.min(60, Math.max(0.002, r.latitudeDelta * factor)), longitudeDelta: Math.min(60, Math.max(0.002, r.longitudeDelta * factor)) },
      250,
    );
  };

  const undo = () => {
    if (!steps.length || busy) return;
    setRedo((r) => [...r, steps[steps.length - 1]]);
    setSteps((list) => list.slice(0, -1));
  };
  const redoStep = () => {
    if (!redo.length || busy) return;
    setSteps((list) => [...list, redo[redo.length - 1]]);
    setRedo((r) => r.slice(0, -1));
  };
  const backToStart = () => {
    if (!start || !end || distance(start, end) < 30) return;
    const home = start;
    addStep(async (from) => {
      const piece = from ? await connect(from, home, 'home') : null;
      return piece ? [piece] : [];
    });
  };
  const clear = () =>
    Alert.alert('Clear the drawing?', 'You can’t undo this.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          setSteps([]);
          setRedo([]);
          setStart(null);
        },
      },
    ]);

  const leave = () => {
    if (!steps.length) return router.back();
    Alert.alert('Leave without saving?', 'Your drawing will be lost.', [
      { text: 'Keep drawing', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: () => router.back() },
    ]);
  };

  const save = () => {
    if (!pieces.length) return;
    Alert.prompt(
      'Name this drive',
      'You’ll find it in your drives, ready to relive with turn-by-turn.',
      async (name) => {
        setSaving(true);
        try {
          const saved = await saveDrive(toTrack(start, pieces), { name: name || 'My drawn drive', drafted: true });
          if (saved) router.replace({ pathname: '/drive/[id]', params: { id: saved.id } });
        } finally {
          setSaving(false);
        }
      },
      'plain-text',
      '',
    );
  };

  // Long-press before drawing anything: start somewhere else.
  const onLongPress = (c: LngLat) => {
    if (steps.length) return;
    setStart(c);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  };

  const path = useMemo(() => joined(start, pieces), [start, pieces]);
  const canLoop = !!start && !!end && pieces.length > 0 && distance(start, end) >= 30;

  return (
    <View style={s.root}>
      <View
        style={StyleSheet.absoluteFill}
        onTouchStart={(e) => drawing && onTouches(e.nativeEvent.touches.length)}
        onTouchMove={(e) => drawing && onTouches(e.nativeEvent.touches.length)}
        onTouchEnd={(e) => drawing && finishStroke(e.nativeEvent.touches.length)}
        onTouchCancel={() => drawing && finishStroke()}
      >
        {here && (
          <MapView
            ref={map}
            style={StyleSheet.absoluteFill}
            initialRegion={{ latitude: here[1], longitude: here[0], latitudeDelta: 0.03, longitudeDelta: 0.03 }}
            showsUserLocation
            rotateEnabled={false}
            pitchEnabled={false}
            // Pencil on: the map holds still and one finger draws. Off: the map moves as usual.
            scrollEnabled={!drawing}
            zoomEnabled={!drawing}
            onRegionChangeComplete={(r) => {
              region.current = r;
            }}
            onPanDrag={(e) => drawing && onDrag([e.nativeEvent.coordinate.longitude, e.nativeEvent.coordinate.latitude])}
            onPress={(e) => onTapMap([e.nativeEvent.coordinate.longitude, e.nativeEvent.coordinate.latitude])}
            onLongPress={(e) => onLongPress([e.nativeEvent.coordinate.longitude, e.nativeEvent.coordinate.latitude])}
            {...mapLook}
          >
            {path.length >= 2 && <GlowRoute coords={path} />}
            {pieces
              .filter((x) => x.adjusted)
              .map((x, i) => (
                <Polyline key={`adj-${i}`} coordinates={x.coords.map(toLatLng)} strokeColor={p.caution} strokeWidth={5} lineCap="round" lineJoin="round" zIndex={5} />
              ))}
            {stroke.length >= 2 && (
              <Polyline coordinates={stroke.map(toLatLng)} strokeColor={p.mint} strokeWidth={4} lineDashPattern={[8, 6]} lineCap="round" zIndex={6} />
            )}
            {start && <PinTile at={start} icon="flag-variant" tone="start" />}
            {end && pieces.length > 0 && <PinTile key={`end-${end[0]}-${end[1]}`} at={end} icon="map-marker" />}
          </MapView>
        )}
      </View>
      <Vignette edge="top" height={insets.top + 110} />

      {/* Top: back, title, undo, redo */}
      <View style={[s.top, { top: insets.top + 8 }]} pointerEvents="box-none">
        <RoundButton icon="chevron-left" label="Back" onPress={leave} />
        <GlassCard radiusSize={22} strong style={s.title}>
          <Text style={[t.bodyStrong, { color: p.mint }]}>Draw a drive</Text>
        </GlassCard>
        <RoundButton icon="undo-variant" label="Undo" onPress={undo} disabled={!steps.length || busy > 0} />
        <RoundButton icon="redo-variant" label="Redo" onPress={redoStep} disabled={!redo.length || busy > 0} />
      </View>

      {/* Pencil (and zoom while it's on), right side of the map */}
      {mode === 'draw' && (
        <Animated.View entering={enterFade} exiting={exitFade} style={[s.tools, { top: insets.top + 70 }]} pointerEvents="box-none">
          <RoundButton icon={pen ? 'pencil' : 'pencil-off-outline'} label={pen ? 'Pencil on. Tap to move the map.' : 'Pencil off. Tap to draw.'} onPress={() => setPen((v) => !v)} />
          {pen && (
            <Animated.View entering={enterFade} exiting={exitFade} style={{ gap: 8 }}>
              <RoundButton icon="plus" label="Zoom in" onPress={() => zoom(0.5)} />
              <RoundButton icon="minus" label="Zoom out" onPress={() => zoom(2)} />
            </Animated.View>
          )}
        </Animated.View>
      )}

      {/* Bottom sheet */}
      <Animated.View entering={enterRise} style={[s.sheetWrap, { paddingBottom: insets.bottom + 12 }]} pointerEvents="box-none">
        <GlassCard radiusSize={28} glow style={s.sheet}>
          <Segmented
            options={[
              { value: 'draw', label: 'Draw with finger' },
              { value: 'tap', label: 'Tap to add stops' },
            ]}
            value={mode}
            onChange={setMode}
          />
          <Animated.Text key={mode} entering={enterFade} exiting={exitFade} style={t.caption}>
            {mode === 'tap'
              ? `Tap a street to ${start ? 'drive there along real streets' : 'start there'}. Drag and pinch move the map.`
              : pen
                ? 'Pencil on: drag along the streets, lift and it snaps onto them. Use + / − to zoom.'
                : `Move the map to ${start ? 'where you want to go next' : 'where you want to start (any city)'}, then turn on the pencil.`}
          </Animated.Text>

          <View style={s.stats}>
            {pieces.length ? (
              <TwoTone lead={formatMiles(sum.distanceM)} value={`about ${Math.max(1, Math.round(sum.durationS / 60))} min`} size="body" />
            ) : (
              <TwoTone lead="Nothing drawn" value="yet" size="body" />
            )}
            {busy > 0 && <ActivityIndicator color={p.brand} />}
          </View>
          {adjusted > 0 && (
            <Animated.Text entering={enterFade} exiting={exitFade} layout={moveList} style={[t.caption, { color: p.caution }]}>
              {adjusted === 1 ? 'One part' : `${adjusted} parts`} adjusted to follow legal streets (in amber).
            </Animated.Text>
          )}

          <View style={s.row}>
            {start ? (
              <PrimaryPill label="Back to start" icon="home-import-outline" tone="glass" compact onPress={backToStart} disabled={!canLoop || busy > 0} style={{ flex: 1 }} />
            ) : (
              <PrimaryPill
                label="Start from my location"
                icon="crosshairs-gps"
                tone="glass"
                compact
                disabled={!here}
                onPress={() => {
                  if (!here) return;
                  setStart(here);
                  map.current?.animateToRegion({ latitude: here[1], longitude: here[0], latitudeDelta: 0.02, longitudeDelta: 0.02 }, 400);
                }}
                style={{ flex: 1 }}
              />
            )}
            <PrimaryPill label="Clear" icon="eraser" tone="glass" compact onPress={clear} disabled={!steps.length} style={{ flex: 1 }} />
          </View>
          <PrimaryPill label="Save this drive" icon="content-save-outline" onPress={save} disabled={!pieces.length || busy > 0} busy={saving} />
        </GlassCard>
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((p) => ({
  root: { flex: 1, backgroundColor: p.canvas },
  top: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, height: 44, justifyContent: 'center', paddingHorizontal: 16 },
  sheetWrap: { position: 'absolute', left: 10, right: 10, bottom: 0 },
  sheet: { padding: 16, gap: 12 },
  stats: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', gap: 10 },
  tools: { position: 'absolute', right: 12, gap: 8, alignItems: 'center' },
}));
