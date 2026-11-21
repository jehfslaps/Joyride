// A spot you tapped and held on a saved drive's map: its address and GPS
// coordinates, ready to copy, open in another map app, or share.

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Share, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { ContextChip, GlassCard, RoundButton } from '@/components/ui';
import type { LngLat } from '@/lib/geo';
import { enterRise, exitFade, moveList } from '@/lib/motion';
import { addressAt } from '@/lib/places';
import { makeStyles, typeFor, useTheme } from '@/theme';

/** "33.97312, -118.03201": latitude first, the way Google and Apple Maps read it. */
export const coordText = (c: LngLat) => `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`;

export function SpotCard({ at, onClose, bottom }: { at: LngLat; onClose: () => void; bottom: number }) {
  const p = useTheme();
  const t = typeFor(p);
  const s = useStyles();
  const [address, setAddress] = useState<string | null>(null);
  const [looking, setLooking] = useState(true);
  const [copied, setCopied] = useState<'address' | 'coords' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    setLooking(true);
    setAddress(null);
    addressAt(at)
      .then((a) => live && setAddress(a))
      .catch(() => {})
      .finally(() => live && setLooking(false));
    return () => {
      live = false;
    };
  }, [at]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const coords = coordText(at);
  const copy = async (what: 'address' | 'coords') => {
    await Clipboard.setStringAsync(what === 'address' && address ? address : coords);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setCopied(what);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1600);
  };
  const q = encodeURIComponent(`${at[1].toFixed(6)},${at[0].toFixed(6)}`);

  return (
    <Animated.View entering={enterRise} exiting={exitFade} layout={moveList} style={[s.wrap, { bottom }]}>
      <GlassCard radiusSize={24} strong glow style={s.card}>
        <View style={s.head}>
          <View style={{ flex: 1, gap: 2 }}>
            {looking ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <ActivityIndicator color={p.text2} />
                <Text style={t.caption}>Finding the address…</Text>
              </View>
            ) : (
              <Text style={t.bodyStrong} numberOfLines={2} selectable>
                {address ?? 'No street address here'}
              </Text>
            )}
            <Text style={[t.caption, { fontVariant: ['tabular-nums'] }]} selectable>
              {coords}
            </Text>
          </View>
          <RoundButton icon="close" label="Close" onPress={onClose} />
        </View>
        <View style={s.chips}>
          {address && (
            <ContextChip
              icon={copied === 'address' ? 'check' : 'content-copy'}
              label={copied === 'address' ? 'Copied' : 'Copy address'}
              on={copied === 'address'}
              onPress={() => copy('address')}
            />
          )}
          <ContextChip
            icon={copied === 'coords' ? 'check' : 'crosshairs-gps'}
            label={copied === 'coords' ? 'Copied' : 'Copy coordinates'}
            on={copied === 'coords'}
            onPress={() => copy('coords')}
          />
          <ContextChip icon="google-maps" label="Google Maps" onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`)} />
          <ContextChip icon="map-outline" label="Apple Maps" onPress={() => Linking.openURL(`https://maps.apple.com/?ll=${q}&q=${encodeURIComponent(address ?? 'Dropped pin')}`)} />
          <ContextChip
            icon="export-variant"
            label="Share"
            onPress={() =>
              Share.share({ message: [address, coords, `https://maps.apple.com/?ll=${q}`].filter(Boolean).join('\n') }).catch(() => {})
            }
          />
        </View>
      </GlassCard>
    </Animated.View>
  );
}

const useStyles = makeStyles(() => ({
  wrap: { position: 'absolute', left: 12, right: 12 },
  card: { padding: 14, gap: 12 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
}));
