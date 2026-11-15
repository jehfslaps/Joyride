import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { ComponentProps } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { colors, radius } from '@/theme';

type Props = {
  label: string;
  onPress: () => void;
  icon?: ComponentProps<typeof MaterialCommunityIcons>['name'];
  tone?: 'amber' | 'red' | 'ghost';
  busy?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
};

export function BigButton({ label, onPress, icon, tone = 'amber', busy, disabled, style }: Props) {
  const bg = tone === 'amber' ? colors.amber : tone === 'red' ? colors.red : colors.cardHi;
  const fg = tone === 'amber' ? colors.onAmber : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] },
        style,
      ]}
    >
      <View style={styles.row}>
        {busy ? (
          <ActivityIndicator color={fg} />
        ) : icon ? (
          <MaterialCommunityIcons name={icon} size={24} color={fg} />
        ) : null}
        <Text style={[styles.label, { color: fg }]}>{label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { height: 60, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  label: { fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
});
