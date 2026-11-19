// Kept for older screens: the same button as PrimaryPill.
import type { ViewStyle } from 'react-native';
import { PrimaryPill, type IconName } from './ui';

type Props = {
  label: string;
  onPress: () => void;
  icon?: IconName;
  tone?: 'mint' | 'glass' | 'hazard';
  busy?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
};

export function BigButton(props: Props) {
  return <PrimaryPill {...props} />;
}
