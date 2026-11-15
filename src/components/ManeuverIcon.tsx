import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import type { NavStep } from '@/lib/route';

type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

function iconFor(step: NavStep | null): IconName {
  if (!step) return 'navigation-variant';
  if (step.type === 'arrive') return 'flag-checkered';
  if (step.type === 'depart') return 'navigation-variant';
  if (step.type.includes('roundabout') || step.type.includes('rotary')) return 'rotate-right';
  switch (step.modifier) {
    case 'uturn':
      return 'arrow-u-left-top-bold';
    case 'sharp left':
    case 'left':
      return 'arrow-left-top-bold';
    case 'sharp right':
    case 'right':
      return 'arrow-right-top-bold';
    case 'slight left':
      return 'arrow-top-left-thick';
    case 'slight right':
      return 'arrow-top-right-thick';
    default:
      return 'arrow-up-bold';
  }
}

export function ManeuverIcon({ step, size = 44, color = '#fff' }: { step: NavStep | null; size?: number; color?: string }) {
  return <MaterialCommunityIcons name={iconFor(step)} size={size} color={color} />;
}
