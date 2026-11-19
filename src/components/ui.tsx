// Joyride's building blocks: frosted glass panels over a dark world, one big
// "answer" number per screen, two-tone headlines, context chips, and a single
// glowing live element on the map.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import MaskedViewBase from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Marker, Polyline } from 'react-native-maps';
import type { LngLat } from '@/lib/geo';
import { radius, typeFor, useTheme } from '@/theme';

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

// The package's class typings don't line up with React 19's JSX types.
const MaskedView = MaskedViewBase as unknown as (props: { maskElement: React.ReactElement; children?: ReactNode }) => React.ReactElement;

// ---- Accessibility -------------------------------------------------------------

function useAccessibilityFlag(get: () => Promise<boolean>, event: 'reduceMotionChanged' | 'reduceTransparencyChanged') {
  const [on, setOn] = useState(false);
  useEffect(() => {
    get().then(setOn).catch(() => {});
    const sub = AccessibilityInfo.addEventListener(event, setOn);
    return () => sub.remove();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return on;
}

export const useReduceMotion = () => useAccessibilityFlag(AccessibilityInfo.isReduceMotionEnabled, 'reduceMotionChanged');
export const useReduceTransparency = () =>
  useAccessibilityFlag(AccessibilityInfo.isReduceTransparencyEnabled, 'reduceTransparencyChanged');

const tap = () => Haptics.selectionAsync().catch(() => {});

// ---- Glass -------------------------------------------------------------------------

/**
 * The base panel: blur, a translucent green tint and a hairline lit from the
 * top. `strong` is more opaque, for anything that must stay readable over a
 * busy map. With Reduce Transparency on, it's solid.
 */
export function GlassCard({
  children,
  style,
  strong,
  radiusSize = radius.card,
  glow,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  strong?: boolean;
  radiusSize?: number;
  /** Faint green light rising from the bottom edge. */
  glow?: boolean;
}) {
  const p = useTheme();
  const solid = useReduceTransparency();
  return (
    <View style={[{ borderRadius: radiusSize, overflow: 'hidden' }, style]}>
      {!solid && <BlurView intensity={p.dark ? 40 : 30} tint={p.dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />}
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: solid ? p.glassSolid : strong ? (p.dark ? 'rgba(11, 26, 18, 0.9)' : 'rgba(255,255,255,0.92)') : p.glassTint },
        ]}
      />
      {glow && (
        <LinearGradient
          colors={['transparent', p.dark ? 'rgba(30, 107, 69, 0.35)' : 'rgba(30, 138, 87, 0.10)', p.dark ? 'rgba(59, 163, 115, 0.45)' : 'rgba(30, 138, 87, 0.16)']}
          locations={[0.35, 0.8, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      {/* Hairline border, brighter along the top edge as if lit from above. */}
      <View style={[StyleSheet.absoluteFill, { borderRadius: radiusSize, borderWidth: StyleSheet.hairlineWidth, borderColor: p.hairlineSoft }]} pointerEvents="none" />
      <LinearGradient
        colors={[p.hairline, 'transparent']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{ position: 'absolute', top: 0, left: radiusSize * 0.6, right: radiusSize * 0.6, height: StyleSheet.hairlineWidth * 2 }}
        pointerEvents="none"
      />
      <View style={[StyleSheet.absoluteFill, { borderRadius: radiusSize, borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.hairline }]} pointerEvents="none" />
      {children}
    </View>
  );
}

// ---- Type ----------------------------------------------------------------------------

/** The signature headline: a dim lead-in and a bright key word, e.g. "Arrive **8:42**". */
export function TwoTone({
  lead,
  value,
  size = 'display',
  style,
  numberOfLines,
}: {
  lead?: string;
  value: string;
  size?: 'display' | 'title' | 'body';
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const p = useTheme();
  const t = typeFor(p);
  const base = size === 'display' ? t.display : size === 'title' ? t.title : t.bodyStrong;
  return (
    <Text style={[base, style]} numberOfLines={numberOfLines}>
      {lead ? <Text style={{ color: p.text3, fontWeight: size === 'body' ? '400' : '400' }}>{lead} </Text> : null}
      <Text style={{ color: p.mint, fontWeight: size === 'body' ? '700' : '700' }}>{value}</Text>
    </Text>
  );
}

/** One big gradient number per screen ("24 min", "8:42", "12.4 mi") with a caption above it. */
export function HeroNumber({
  value,
  unit,
  caption,
  size = 64,
  style,
}: {
  value: string;
  unit?: string;
  caption?: ReactNode;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const p = useTheme();
  const t = typeFor(p);
  const numStyle: TextStyle = { ...t.hero, fontSize: size, lineHeight: size * 1.08, letterSpacing: size > 40 ? -2 : -1 };
  return (
    <View style={style}>
      {caption ? typeof caption === 'string' ? <Text style={t.caption}>{caption}</Text> : caption : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>
        <MaskedView maskElement={<Text style={numStyle}>{value}</Text>}>
          <LinearGradient colors={[p.heroFrom, p.heroTo]} start={{ x: 0, y: 0.1 }} end={{ x: 0, y: 1.1 }}>
            <Text style={[numStyle, { opacity: 0 }]}>{value}</Text>
          </LinearGradient>
        </MaskedView>
        {unit ? <Text style={[t.title, { color: p.text2, fontWeight: '500', marginBottom: size * 0.14 }]}>{unit}</Text> : null}
      </View>
    </View>
  );
}

/** Small caps section label. */
export function Label({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const p = useTheme();
  return <Text style={[typeFor(p).label, style]}>{children}</Text>;
}

// ---- Controls ---------------------------------------------------------------------------

/** A glass capsule like "Avoid / **Freeways**". Solid mint when on. */
export function ContextChip({
  prefix,
  label,
  on,
  onPress,
  icon,
  accessibilityRole = 'button',
}: {
  prefix?: string;
  label: string;
  on?: boolean;
  onPress?: () => void;
  icon?: IconName;
  accessibilityRole?: 'button' | 'switch';
}) {
  const p = useTheme();
  const fg = on ? p.onMint : p.mint;
  const content = (
    <View style={styles.chipRow}>
      {icon && <MaterialCommunityIcons name={icon} size={15} color={on ? p.onMint : p.text2} />}
      {prefix ? <Text style={[styles.chipText, { color: on ? p.onMint : p.text3, fontWeight: '500' }]}>{prefix} /</Text> : null}
      <Text style={[styles.chipText, { color: fg }]}>{label}</Text>
    </View>
  );
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress?.();
      }}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityRole === 'switch' ? { checked: !!on } : { selected: !!on }}
      accessibilityLabel={prefix ? `${prefix} ${label}` : label}
      hitSlop={4}
      style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.97 : 1 }] })}
    >
      {on ? (
        <View style={[styles.chip, { backgroundColor: p.mint }]}>{content}</View>
      ) : (
        <GlassCard radiusSize={radius.pill} style={styles.chip}>
          {content}
        </GlassCard>
      )}
    </Pressable>
  );
}

/**
 * The main button: a full-width capsule. `mint` is the one primary action on a
 * screen; `glass` is secondary; `hazard` ends or stops something.
 */
export function PrimaryPill({
  label,
  onPress,
  icon,
  trailingIcon,
  tone = 'mint',
  busy,
  disabled,
  style,
  compact,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  trailingIcon?: IconName;
  tone?: 'mint' | 'glass' | 'hazard';
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const p = useTheme();
  const fg = tone === 'mint' ? p.onMint : tone === 'hazard' ? '#fff' : p.mint;
  const height = compact ? 48 : 58;
  const inner = (
    <View style={styles.pillRow}>
      {busy ? <ActivityIndicator color={fg} /> : icon ? <MaterialCommunityIcons name={icon} size={22} color={fg} /> : null}
      <Text style={[styles.pillText, { color: fg, fontSize: compact ? 16 : 17 }]} numberOfLines={1}>
        {label}
      </Text>
      {trailingIcon && !busy ? <MaterialCommunityIcons name={trailingIcon} size={20} color={fg} /> : null}
    </View>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      disabled={disabled || busy}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [{ opacity: disabled ? 0.45 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }, style]}
    >
      {tone === 'glass' ? (
        <GlassCard radiusSize={radius.pill} style={[styles.pill, { height }]}>
          {inner}
        </GlassCard>
      ) : (
        <View style={[styles.pill, { height, backgroundColor: tone === 'mint' ? p.mint : p.hazard }]}>{inner}</View>
      )}
    </Pressable>
  );
}

/** An icon in a soft rounded-square tile. */
export function IconTile({ icon, size = 44, color, glow }: { icon: IconName; size?: number; color?: string; glow?: boolean }) {
  const p = useTheme();
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: radius.tile, backgroundColor: p.tile, alignItems: 'center', justifyContent: 'center' },
        glow && p.dark && { shadowColor: p.glow, shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
      ]}
    >
      <MaterialCommunityIcons name={icon} size={size * 0.5} color={color ?? (glow ? p.glow : p.brand)} />
    </View>
  );
}

/** A round glass button for back, settings and map controls. */
export function RoundButton({ icon, onPress, label, tone }: { icon: IconName; onPress: () => void; label: string; tone?: 'hazard' }) {
  const p = useTheme();
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.94 : 1 }] })}
    >
      <GlassCard radiusSize={22} style={styles.round}>
        <MaterialCommunityIcons name={icon} size={icon === 'chevron-left' ? 28 : 20} color={tone === 'hazard' ? p.hazard : p.mint} />
      </GlassCard>
    </Pressable>
  );
}

/** Back button plus a lowercase screen title ("settings", "surprise"). */
export function ScreenHeader({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  const p = useTheme();
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        {onBack ? <RoundButton icon="chevron-left" onPress={onBack} label="Back" /> : <View />}
        {right}
      </View>
      <Text style={[typeFor(p).display, { textTransform: 'lowercase' }]} accessibilityRole="header">
        {title}
      </Text>
    </View>
  );
}

/** A setting or option row on glass. */
export function GlassRow({
  icon,
  title,
  detail,
  onPress,
  right,
  danger,
}: {
  icon?: IconName;
  title: string;
  detail?: string;
  onPress?: () => void;
  right?: ReactNode;
  danger?: boolean;
}) {
  const p = useTheme();
  const t = typeFor(p);
  const body = (
    <GlassCard style={styles.row}>
      {icon && <IconTile icon={icon} size={40} color={danger ? p.hazard : undefined} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[t.bodyStrong, danger && { color: p.hazard }]}>{title}</Text>
        {!!detail && <Text style={t.caption}>{detail}</Text>}
      </View>
      {right ?? (onPress ? <MaterialCommunityIcons name="chevron-right" size={22} color={p.text3} /> : null)}
    </GlassCard>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
      {body}
    </Pressable>
  );
}

// ---- Map -------------------------------------------------------------------------------------

/** Fades the map into the background at the top or bottom, so the UI floats over it. */
export function Vignette({ edge, height }: { edge: 'top' | 'bottom'; height: number }) {
  const p = useTheme();
  const solid = p.dark ? 'rgba(5, 10, 7, 0.85)' : 'rgba(246, 251, 247, 0.85)';
  const clear = p.dark ? 'rgba(5, 10, 7, 0)' : 'rgba(246, 251, 247, 0)';
  return (
    <LinearGradient
      colors={edge === 'top' ? [solid, clear] : [clear, p.canvas]}
      style={{ position: 'absolute', left: 0, right: 0, height, [edge]: 0 }}
      pointerEvents="none"
    />
  );
}

const toLatLng = (c: LngLat) => ({ latitude: c[1], longitude: c[0] });

/**
 * A route as three stacked lines: a wide soft halo, the green body and a thin
 * bright core. `dim` draws it as an unselected option; `travelled` as the
 * part already driven.
 */
export function GlowRoute({
  coords,
  dim,
  travelled,
  onPress,
  z = 1,
}: {
  coords: LngLat[];
  dim?: boolean;
  travelled?: boolean;
  onPress?: () => void;
  z?: number;
}) {
  const p = useTheme();
  if (coords.length < 2) return null;
  const pts = coords.map(toLatLng);
  if (dim || travelled) {
    return (
      <Polyline
        coordinates={pts}
        strokeColor={travelled ? (p.dark ? 'rgba(59, 163, 115, 0.3)' : 'rgba(30, 138, 87, 0.3)') : p.dark ? 'rgba(230, 247, 236, 0.28)' : 'rgba(6, 20, 12, 0.25)'}
        strokeWidth={travelled ? 6 : 4}
        lineCap="round"
        lineJoin="round"
        tappable={!!onPress}
        onPress={onPress}
        zIndex={z}
      />
    );
  }
  return (
    <>
      <Polyline coordinates={pts} strokeColor={p.dark ? 'rgba(124, 255, 107, 0.2)' : 'rgba(30, 138, 87, 0.18)'} strokeWidth={16} lineCap="round" lineJoin="round" zIndex={z} tappable={!!onPress} onPress={onPress} />
      <Polyline coordinates={pts} strokeColor={p.brand} strokeWidth={7} lineCap="round" lineJoin="round" zIndex={z + 1} />
      <Polyline coordinates={pts} strokeColor={p.dark ? 'rgba(230, 247, 236, 0.85)' : 'rgba(255, 255, 255, 0.9)'} strokeWidth={2} lineCap="round" lineJoin="round" zIndex={z + 2} />
    </>
  );
}

/** Your position: a lime core in a mint ring with a slow pulsing halo. */
export function LivePuck({ at }: { at: LngLat }) {
  const p = useTheme();
  const still = useReduceMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still) return;
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 2400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [still, pulse]);
  return (
    <Marker coordinate={toLatLng(at)} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={!still} zIndex={10}>
      <View style={styles.puckBox}>
        {!still && (
          <Animated.View
            style={[
              styles.puckHalo,
              {
                backgroundColor: p.glow,
                opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
                transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] }) }],
              },
            ]}
          />
        )}
        <View style={[styles.puckRing, { backgroundColor: p.mint, shadowColor: p.glow }]}>
          <View style={[styles.puckCore, { backgroundColor: p.glow }]} />
        </View>
      </View>
    </Marker>
  );
}

/** A destination or end marker: a glass rounded-square tile with a mint glyph. */
export function PinTile({ at, icon = 'flag-checkered', tone }: { at: LngLat; icon?: IconName; tone?: 'start' }) {
  const p = useTheme();
  return (
    <Marker coordinate={toLatLng(at)} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={9}>
      <View style={[styles.pin, { backgroundColor: p.dark ? 'rgba(11, 26, 18, 0.92)' : 'rgba(255,255,255,0.95)', borderColor: p.hairline }]}>
        <MaterialCommunityIcons name={icon} size={16} color={tone === 'start' ? p.brand : p.mint} />
      </View>
    </Marker>
  );
}

/** Small dot on the map for a spot along a route (cul-de-sac or odd spot). */
export function SpotDot({ at, kind }: { at: LngLat; kind: 'culdesac' | 'odd' }) {
  const p = useTheme();
  return (
    <Marker coordinate={toLatLng(at)} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={8}>
      <View style={[styles.spot, { backgroundColor: kind === 'culdesac' ? p.mint : p.brand, borderColor: p.canvas }]} />
    </Marker>
  );
}

const styles = StyleSheet.create({
  chip: { height: 36, paddingHorizontal: 14, borderRadius: radius.pill, justifyContent: 'center' },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chipText: { fontSize: 14, fontWeight: '700' },
  pill: { borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pillText: { fontWeight: '700', letterSpacing: -0.2 },
  round: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 },
  puckBox: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  puckHalo: { position: 'absolute', width: 34, height: 34, borderRadius: 17 },
  puckRing: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', shadowOpacity: 0.6, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  puckCore: { width: 14, height: 14, borderRadius: 7 },
  pin: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  spot: { width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
});

/** Shared settings for every map: muted, quiet, following the theme. */
export function useMapLook() {
  const p = useTheme();
  return {
    userInterfaceStyle: p.map,
    mapType: 'mutedStandard' as const,
    showsPointsOfInterests: false,
    showsCompass: false,
    showsBuildings: false,
    showsTraffic: false,
    showsIndoors: false,
    tintColor: p.brand,
  };
}
