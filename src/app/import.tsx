// Opens from a Joyride Draw link (desktop page → QR code or link):
//   joyride://import?d=v1/<seconds>/<points>/<name>
// Shows the drawn drive and saves it to your drives as Drafted.

import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView from 'react-native-maps';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassCard, GlowRoute, PinTile, PrimaryPill, RoundButton, TwoTone, useMapLook, Vignette } from '@/components/ui';
import { toTrack } from '@/lib/draft';
import { decodeDriveLink } from '@/lib/drivelink';
import { formatMiles, lineLength } from '@/lib/geo';
import { enterRise } from '@/lib/motion';
import { saveDrive } from '@/lib/storage';
import { makeStyles, typeFor, useTheme } from '@/theme';

const toLatLng = (c: [number, number]) => ({ latitude: c[1], longitude: c[0] });

export default function ImportScreen() {
  const p = useTheme();
  const t = typeFor(p);
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const mapLook = useMapLook();
  const map = useRef<MapView>(null);
  const { d } = useLocalSearchParams<{ d?: string }>();
  const drive = useMemo(() => decodeDriveLink(d), [d]);
  const [saving, setSaving] = useState(false);

  const fit = () => {
    if (!drive) return;
    map.current?.fitToCoordinates(drive.coords.map(toLatLng), {
      edgePadding: { top: insets.top + 80, right: 40, bottom: 320, left: 40 },
      animated: false,
    });
  };

  const save = async () => {
    if (!drive) return;
    setSaving(true);
    try {
      const piece = { coords: drive.coords, durationS: drive.durationS || lineLength(drive.coords) / 9, kind: 'draw' as const, adjusted: false };
      const saved = await saveDrive(toTrack(null, [piece]), { name: drive.name || 'Drawn on my computer', drafted: true });
      if (saved) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        router.replace({ pathname: '/drive/[id]', params: { id: saved.id } });
      }
    } finally {
      setSaving(false);
    }
  };

  if (!drive) {
    return (
      <View style={[s.root, s.center, { paddingTop: insets.top }]}>
        <Text style={t.title}>That link didn’t work</Text>
        <Text style={[t.caption, { textAlign: 'center' }]}>It may have been cut off. Try scanning the code again, or use Copy link on the Joyride Draw page.</Text>
        <PrimaryPill label="Back to Joyride" onPress={() => router.replace('/')} />
      </View>
    );
  }

  return (
    <View style={s.root}>
      <MapView ref={map} style={StyleSheet.absoluteFill} onMapReady={fit} rotateEnabled={false} pitchEnabled={false} {...mapLook}>
        <GlowRoute coords={drive.coords} />
        <PinTile at={drive.coords[0]} icon="flag-variant" tone="start" />
        <PinTile at={drive.coords[drive.coords.length - 1]} icon="map-marker" />
      </MapView>
      <Vignette edge="top" height={insets.top + 100} />
      <View style={[s.top, { top: insets.top + 8 }]}>
        <RoundButton icon="close" label="Don’t save" onPress={() => router.replace('/')} />
      </View>
      <Animated.View entering={enterRise} style={[s.sheetWrap, { paddingBottom: insets.bottom + 12 }]}>
        <GlassCard radiusSize={28} glow style={s.sheet}>
          <Text style={t.caption}>FROM JOYRIDE DRAW</Text>
          <Text style={t.title} numberOfLines={2}>
            {drive.name || 'Drawn drive'}
          </Text>
          <TwoTone lead={formatMiles(lineLength(drive.coords))} value={`about ${Math.max(1, Math.round(drive.durationS / 60))} min`} size="body" />
          <PrimaryPill label="Save to my drives" icon="content-save-outline" onPress={save} busy={saving} />
        </GlassCard>
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((p) => ({
  root: { flex: 1, backgroundColor: p.canvas },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 28 },
  top: { position: 'absolute', left: 12 },
  sheetWrap: { position: 'absolute', left: 10, right: 10, bottom: 0 },
  sheet: { padding: 18, gap: 10 },
}));
