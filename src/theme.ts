// Joyride's look: calm navigation, lit from within. One green scale from
// near-black to mint. A lime glow is reserved for live things (your position,
// the active route, recording). Amber and coral are only for warnings.
// Dark is the main theme; light (pale green mist) is for bright daylight.
import { useMemo } from 'react';
import { StyleSheet, useColorScheme, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';

export interface Palette {
  dark: boolean;
  /** App background. */
  canvas: string;
  /** Opaque sheets and list backgrounds. */
  raised: string;
  /** Glass panel fill, laid over a blur. */
  glassTint: string;
  /** Glass panel fill when blur is off (Reduce Transparency). */
  glassSolid: string;
  deep: string;
  emerald: string;
  /** Route line body, icons, links. */
  brand: string;
  /** Live only: your position, active route core, recording. */
  glow: string;
  /** Primary text, hero numbers, the main button. */
  mint: string;
  text2: string;
  text3: string;
  hairline: string;
  hairlineSoft: string;
  /** Icon tiles and inactive chips. */
  tile: string;
  caution: string;
  hazard: string;
  hazardSoft: string;
  /** Text on the mint button. */
  onMint: string;
  heroFrom: string;
  heroTo: string;
  /** Behind-the-UI map fade, as a solid color (made transparent in gradients). */
  vignette: string;
  map: 'dark' | 'light';
}

export const dark: Palette = {
  dark: true,
  canvas: '#050A07',
  raised: '#0B1A12',
  glassTint: 'rgba(15, 42, 28, 0.62)',
  glassSolid: '#0B1A12',
  deep: '#0F3D26',
  emerald: '#1E6B45',
  brand: '#3BA373',
  glow: '#7CFF6B',
  mint: '#E6F7EC',
  text2: 'rgba(230, 247, 236, 0.62)',
  text3: 'rgba(230, 247, 236, 0.40)',
  hairline: 'rgba(255, 255, 255, 0.10)',
  hairlineSoft: 'rgba(255, 255, 255, 0.04)',
  tile: 'rgba(230, 247, 236, 0.08)',
  caution: '#FFB547',
  hazard: '#FF6B5B',
  hazardSoft: 'rgba(255, 107, 91, 0.16)',
  onMint: '#050A07',
  heroFrom: '#E6F7EC',
  heroTo: '#3BA373',
  vignette: '#050A07',
  map: 'dark',
};

export const light: Palette = {
  dark: false,
  canvas: '#F6FBF7',
  raised: '#FFFFFF',
  glassTint: 'rgba(255, 255, 255, 0.70)',
  glassSolid: '#FFFFFF',
  deep: '#E3F3E8',
  emerald: '#2E9A64',
  brand: '#1E8A57',
  // In daylight a deep green takes the place of the lime glow.
  glow: '#1E8A57',
  mint: '#06140C',
  text2: 'rgba(6, 20, 12, 0.62)',
  text3: 'rgba(6, 20, 12, 0.45)',
  hairline: 'rgba(6, 20, 12, 0.10)',
  hairlineSoft: 'rgba(6, 20, 12, 0.05)',
  tile: 'rgba(30, 138, 87, 0.10)',
  caution: '#C97A00',
  hazard: '#D9432F',
  hazardSoft: 'rgba(217, 67, 47, 0.12)',
  onMint: '#F6FBF7',
  heroFrom: '#06140C',
  heroTo: '#1E8A57',
  vignette: '#F6FBF7',
  map: 'light',
};

/** The palette for the phone's current appearance (follows Dark Mode automatically). */
export function useTheme(): Palette {
  return useColorScheme() === 'light' ? light : dark;
}

export const radius = { tile: 12, card: 22, sheet: 32, pill: 999 };
export const space = { gutter: 16, gap: 12 };

/** Type scale. Navigation-critical text is solid and at least 28 pt. */
export function typeFor(p: Palette) {
  const t = {
    hero: { fontSize: 64, fontWeight: '700', letterSpacing: -2, color: p.mint, fontVariant: ['tabular-nums'] },
    display: { fontSize: 34, fontWeight: '600', letterSpacing: -1, color: p.mint },
    maneuver: { fontSize: 30, fontWeight: '700', letterSpacing: -0.5, color: p.mint },
    title: { fontSize: 22, fontWeight: '600', letterSpacing: -0.4, color: p.mint },
    body: { fontSize: 16, fontWeight: '400', color: p.mint },
    bodyStrong: { fontSize: 16, fontWeight: '600', color: p.mint },
    caption: { fontSize: 13, fontWeight: '500', color: p.text2 },
    label: { fontSize: 12, fontWeight: '600', letterSpacing: 0.8, color: p.text3 },
    mono: { fontVariant: ['tabular-nums'] },
  };
  return t as { [K in keyof typeof t]: TextStyle };
}

type StylesIn = { readonly [key: string]: ViewStyle | TextStyle | ImageStyle };

/** Styles that follow the theme: `const useStyles = makeStyles((p) => ({ ... }))`, then `const s = useStyles()`. */
export function makeStyles<S extends StylesIn>(build: (p: Palette, t: ReturnType<typeof typeFor>) => S) {
  const cache = new Map<boolean, S>();
  return function useStyles(): S {
    const p = useTheme();
    return useMemo(() => {
      const hit = cache.get(p.dark);
      if (hit) return hit;
      const made = StyleSheet.create(build(p, typeFor(p))) as S;
      cache.set(p.dark, made);
      return made;
    }, [p]);
  };
}
