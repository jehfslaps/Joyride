// Surprise → Over there: a map with a circle on it. Drag the map to move the
// circle anywhere; the distance chips grow or shrink it (on a spring, while the
// map zooms to keep it in view). Joyride then picks a spot inside the circle.
// When a city or county with its own outline is picked instead, the map frames
// that area and the circle steps aside.

import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import MapView, { type Region } from 'react-native-maps';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { GlassCard, RoundButton, useMapLook, Vignette } from '@/components/ui';
import type { LngLat } from '@/lib/geo';
import { springFade, springUI } from '@/lib/motion';
import type { Place } from '@/lib/places';
import { makeStyles, useTheme } from '@/theme';

const METERS_PER_MILE = 1609.344;
/** The circle fills this share of the map's shorter side once the map settles. */
const FILL = 0.78;

function regionFor(center: LngLat, radiusM: number, w: number, h: number): Region {
  const mpp = radiusM / ((FILL / 2) * Math.min(w, h));
  return {
    latitude: center[1],
    longitude: center[0],
    latitudeDelta: (mpp * h) / 110540,
    longitudeDelta: (mpp * w) / (111320 * Math.cos((center[1] * Math.PI) / 180)),
  };
}

export function AreaCircle({
  here,
  miles,
  area,
  onCenter,
  onTouch,
}: {
  here: LngLat;
  miles: number;
  /** A picked city or county: with an outline (bbox) the map frames it instead of the circle. */
  area: Place | null;
  /** Where the circle's center is, each time the map comes to rest. */
  onCenter: (c: LngLat) => void;
  /** True while a finger is on the map (so the screen doesn't scroll at the same time). */
  onTouch?: (down: boolean) => void;
}) {
  const p = useTheme();
  const s = useStyles();
  const mapLook = useMapLook();
  const map = useRef<MapView>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const center = useRef<LngLat>(here);
  const outline = !!area?.bbox;

  // The circle is drawn on top of the map, so it needs meters per pixel (from
  // the map, as it moves) and the radius in meters (sprung, so it grows smoothly).
  const radius = useSharedValue(miles * METERS_PER_MILE);
  const mpp = useSharedValue(50);
  const shown = useSharedValue(outline ? 0 : 1);

  const frame = (c: LngLat) => {
    if (!size) return;
    map.current?.animateToRegion(regionFor(c, miles * METERS_PER_MILE, size.w, size.h), 450);
  };

  // New distance: grow or shrink the circle, and zoom so it stays in view.
  useEffect(() => {
    radius.value = withSpring(miles * METERS_PER_MILE, springUI);
    if (!outline) frame(center.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miles, size]);

  // A picked area: frame its outline, or move the circle onto it.
  useEffect(() => {
    shown.value = withSpring(outline ? 0 : 1, springFade);
    if (!area || !size) return;
    if (area.bbox) {
      const [w, sth, e, n] = area.bbox;
      map.current?.fitToCoordinates(
        [
          { latitude: sth, longitude: w },
          { latitude: n, longitude: e },
        ],
        { edgePadding: { top: 40, right: 30, bottom: 30, left: 30 }, animated: true },
      );
    } else {
      center.current = area.coord;
      onCenter(area.coord);
      frame(area.coord);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area, size]);

  const track = (r: Region) => {
    if (!size) return;
    mpp.value = (r.longitudeDelta * 111320 * Math.cos((r.latitude * Math.PI) / 180)) / size.w;
  };

  const circle = useAnimatedStyle(() => {
    const d = (2 * radius.value) / Math.max(0.5, mpp.value);
    return { width: d, height: d, borderRadius: d / 2, marginLeft: -d / 2, marginTop: -d / 2, opacity: shown.value };
  });
  const dot = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ scale: 0.6 + 0.4 * shown.value }] }));

  return (
    <View
      style={s.wrap}
      onLayout={(e: LayoutChangeEvent) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      onTouchStart={() => onTouch?.(true)}
      onTouchEnd={() => onTouch?.(false)}
      onTouchCancel={() => onTouch?.(false)}
    >
      {size && (
        <MapView
          ref={map}
          style={StyleSheet.absoluteFill}
          initialRegion={regionFor(here, miles * METERS_PER_MILE, size.w, size.h)}
          showsUserLocation
          rotateEnabled={false}
          pitchEnabled={false}
          onRegionChange={track}
          onRegionChangeComplete={(r) => {
            track(r);
            if (outline) return;
            center.current = [r.longitude, r.latitude];
            onCenter(center.current);
          }}
          {...mapLook}
        />
      )}
      <Animated.View pointerEvents="none" style={[s.circle, { borderColor: p.brand, backgroundColor: p.dark ? 'rgba(124, 255, 107, 0.10)' : 'rgba(30, 138, 87, 0.12)' }, circle]} />
      <Animated.View pointerEvents="none" style={[s.dot, { backgroundColor: p.glow, borderColor: p.deep }, dot]} />
      <Vignette edge="bottom" height={40} />
      <View style={s.topRow} pointerEvents="box-none">
        <GlassCard radiusSize={16} strong style={s.label}>
          <Text style={[s.labelText, { color: p.mint }]} numberOfLines={1}>
            {outline ? `Anywhere in ${area!.name}` : `Anywhere within ${miles} mi`}
          </Text>
        </GlassCard>
        {!outline && (
          <RoundButton
            icon="crosshairs-gps"
            label="Back to me"
            onPress={() => {
              center.current = here;
              onCenter(here);
              frame(here);
            }}
          />
        )}
      </View>
      {!outline && (
        <Text style={[s.hint, { color: p.text2 }]} pointerEvents="none">
          Drag the map to move the circle
        </Text>
      )}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  wrap: { height: 340, borderRadius: 24, overflow: 'hidden' },
  circle: { position: 'absolute', left: '50%', top: '50%', borderWidth: 2 },
  dot: { position: 'absolute', left: '50%', top: '50%', width: 12, height: 12, marginLeft: -6, marginTop: -6, borderRadius: 6, borderWidth: 2 },
  topRow: { position: 'absolute', top: 10, left: 10, right: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  label: { height: 36, paddingHorizontal: 14, justifyContent: 'center' },
  labelText: { fontSize: 14, fontWeight: '700' },
  hint: { position: 'absolute', bottom: 34, alignSelf: 'center', fontSize: 12, fontWeight: '600' },
}));
