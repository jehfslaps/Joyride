// Night-drive look: deep blue-black, warm amber headlights, red tail-light for recording.
export const colors = {
  bg: '#0B0E13',
  card: '#151A22',
  cardHi: '#1C222C',
  line: '#262D38',
  text: '#F3F5F8',
  muted: '#8B94A3',
  faint: '#5A6372',
  amber: '#FFB23F',
  amberDim: 'rgba(255, 178, 63, 0.35)',
  red: '#FF4757',
  redDim: 'rgba(255, 71, 87, 0.18)',
  blue: '#4DA3FF',
  green: '#3DDC97',
  onAmber: '#1A1205',
};

export const radius = { sm: 10, md: 16, lg: 24, pill: 999 };

export const type = {
  hero: { fontSize: 34, fontWeight: '800' as const, letterSpacing: -0.8, color: colors.text },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.3, color: colors.text },
  body: { fontSize: 16, fontWeight: '500' as const, color: colors.text },
  label: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.6, color: colors.muted },
  small: { fontSize: 13, fontWeight: '500' as const, color: colors.muted },
  mono: { fontVariant: ['tabular-nums' as const] },
};
