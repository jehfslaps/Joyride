// Joyride's building blocks: frosted glass panels over a dark world, one big
// "answer" number per screen, two-tone headlines, context chips, and a single
// glowing live element on the map.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import MaskedViewBase from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type PressableProps,
  type ViewStyle,
} from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
} from 'react-native-reanimated';
import { enterRise, exitRise, springFade, springPress, springUI } from '@/lib/motion';
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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * A pressable that sinks slightly the instant it's touched and springs back
 * when released. The spring picks up from wherever it is, so quick repeated
 * taps never jump.
 */
export function PressableScale({
  scaleTo = 0.97,
  style,
  onPressIn,
  onPressOut,
  children,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & { scaleTo?: number; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        scale.value = withSpring(scaleTo, springPress);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, springUI);
        onPressOut?.(e);
      }}
      style={[style, anim]}
    >
      {children}
    </AnimatedPressable>
  );
}

/** A 0→1 spring that follows `on`, for crossfading between two states. */
function useToggle(on: boolean) {
  const v = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    v.value = withSpring(on ? 1 : 0, springFade);
  }, [on, v]);
  return v;
}

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
  animate = true,
}: {
  value: string;
  unit?: string;
  caption?: ReactNode;
  size?: number;
  style?: StyleProp<ViewStyle>;
  /** Roll to a new value instead of cutting to it (off for ticking clocks). */
  animate?: boolean;
}) {
  const p = useTheme();
  const t = typeFor(p);
  const numStyle: TextStyle = { ...t.hero, fontSize: size, lineHeight: size * 1.08, letterSpacing: size > 40 ? -2 : -1 };
  return (
    <View style={style}>
      {caption ? typeof caption === 'string' ? <Text style={t.caption}>{caption}</Text> : caption : null}
      <Animated.View
        key={animate ? `${value}${unit ?? ''}` : 'still'}
        entering={animate ? enterRise : undefined}
        exiting={animate ? exitRise : undefined}
        style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}
      >
        <MaskedView maskElement={<Text style={numStyle}>{value}</Text>}>
          <LinearGradient colors={[p.heroFrom, p.heroTo]} start={{ x: 0, y: 0.1 }} end={{ x: 0, y: 1.1 }}>
            <Text style={[numStyle, { opacity: 0 }]}>{value}</Text>
          </LinearGradient>
        </MaskedView>
        {unit ? <Text style={[t.title, { color: p.text2, fontWeight: '500', marginBottom: size * 0.14 }]}>{unit}</Text> : null}
      </Animated.View>
    </View>
  );
}

/** Small caps section label. */
export function Label({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const p = useTheme();
  return <Text style={[typeFor(p).label, style]}>{children}</Text>;
}

// ---- Controls ---------------------------------------------------------------------------

/** A glass capsule like "Avoid / **Freeways**". Fades to solid mint when on. */
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
  const v = useToggle(!!on);
  const fill = useAnimatedStyle(() => ({ opacity: v.value }));
  const main = useAnimatedStyle(() => ({ color: interpolateColor(v.value, [0, 1], [p.mint, p.onMint]) }));
  const dim = useAnimatedStyle(() => ({ color: interpolateColor(v.value, [0, 1], [p.text3, p.onMint]) }));
  return (
    <PressableScale
      onPress={() => {
        tap();
        onPress?.();
      }}
      disabled={!onPress}
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityRole === 'switch' ? { checked: !!on } : { selected: !!on }}
      accessibilityLabel={prefix ? `${prefix} ${label}` : label}
      hitSlop={4}
    >
      <GlassCard radiusSize={radius.pill} style={styles.chip}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: p.mint, borderRadius: radius.pill }, fill]} pointerEvents="none" />
        <View style={styles.chipRow}>
          {icon && <MaterialCommunityIcons name={icon} size={15} color={on ? p.onMint : p.text2} />}
          {prefix ? <Animated.Text style={[styles.chipText, { fontWeight: '500' }, dim]}>{prefix} /</Animated.Text> : null}
          <Animated.Text style={[styles.chipText, main]}>{label}</Animated.Text>
        </View>
      </GlassCard>
    </PressableScale>
  );
}

/** Two or more options with a mint thumb that slides between them. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const p = useTheme();
  const [width, setWidth] = useState(0);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const x = useSharedValue(index);
  useEffect(() => {
    x.value = withSpring(index, springUI);
  }, [index, x]);
  const seg = width > 0 ? (width - 8) / options.length : 0;
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * seg }] }));
  return (
    <GlassCard radiusSize={18} style={styles.segment}>
      <View style={{ flexDirection: 'row' }} onLayout={(e) => setWidth(e.nativeEvent.layout.width + 8)}>
        {seg > 0 && <Animated.View style={[styles.segmentThumb, { width: seg, backgroundColor: p.mint }, thumb]} pointerEvents="none" />}
        {options.map((o, i) => (
          <SegmentLabel
            key={o.value}
            label={o.label}
            index={i}
            pos={x}
            onPress={() => {
              tap();
              onChange(o.value);
            }}
            selected={i === index}
          />
        ))}
      </View>
    </GlassCard>
  );
}

function SegmentLabel({ label, index, pos, onPress, selected }: { label: string; index: number; pos: { value: number }; onPress: () => void; selected: boolean }) {
  const p = useTheme();
  const color = useAnimatedStyle(() => {
    const near = Math.max(0, 1 - Math.abs(pos.value - index));
    return { color: interpolateColor(near, [0, 1], [p.mint, p.onMint]) };
  });
  return (
    <Pressable onPress={onPress} style={styles.segmentBtn} accessibilityRole="button" accessibilityState={{ selected }}>
      <Animated.Text style={[styles.segmentText, color]}>{label}</Animated.Text>
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
  const enabled = useToggle(!disabled);
  const enabledStyle = useAnimatedStyle(() => ({ opacity: 0.45 + 0.55 * enabled.value }));
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
    <PressableScale
      scaleTo={0.98}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      disabled={disabled || busy}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        onPress();
      }}
      style={style}
    >
      <Animated.View style={enabledStyle}>
      {tone === 'glass' ? (
        <GlassCard radiusSize={radius.pill} style={[styles.pill, { height }]}>
          {inner}
        </GlassCard>
      ) : (
        <View style={[styles.pill, { height, backgroundColor: tone === 'mint' ? p.mint : p.hazard }]}>{inner}</View>
      )}
      </Animated.View>
    </PressableScale>
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
export function RoundButton({
  icon,
  onPress,
  label,
  tone,
  disabled,
}: {
  icon: IconName;
  onPress: () => void;
  label: string;
  tone?: 'hazard';
  disabled?: boolean;
}) {
  const p = useTheme();
  return (
    <PressableScale
      scaleTo={0.92}
      disabled={disabled}
      style={disabled ? { opacity: 0.35 } : undefined}
      onPress={() => {
        if (disabled) return;
        tap();
        onPress();
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
    >
      <GlassCard radiusSize={22} style={styles.round}>
        <MaterialCommunityIcons name={icon} size={icon === 'chevron-left' ? 28 : 20} color={tone === 'hazard' ? p.hazard : p.mint} />
      </GlassCard>
    </PressableScale>
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
    <PressableScale onPress={onPress} accessibilityRole="button" scaleTo={0.985}>
      {body}
    </PressableScale>
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
        strokeColor={travelled ? (p.dark ? '#5C625F' : '#A9AEAB') : p.dark ? 'rgba(230, 247, 236, 0.28)' : 'rgba(6, 20, 12, 0.25)'}
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
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (still) return;
    // A slow, fully damped spring from 0 to 1, over and over (about 2.4 s each).
    const r = 2.4;
    pulse.value = withRepeat(withSpring(1, { mass: 1, stiffness: Math.pow((2 * Math.PI) / r, 2), damping: (4 * Math.PI) / r }), -1, false);
  }, [still, pulse]);
  const halo = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - pulse.value),
    transform: [{ scale: 1 + 0.6 * pulse.value }],
  }));
  return (
    <Marker coordinate={toLatLng(at)} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={!still} zIndex={10}>
      <View style={styles.puckBox}>
        {!still && <Animated.View style={[styles.puckHalo, { backgroundColor: p.glow }, halo]} />}
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
  segment: { padding: 4 },
  segmentThumb: { position: 'absolute', top: 0, bottom: 0, left: 0, borderRadius: 14 },
  segmentBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: 15, fontWeight: '700' },
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
