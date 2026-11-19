// Fluid motion: everything that moves, scales, fades or changes value uses a
// spring, and every spring is interruptible (a new input redirects it from
// where it is, carrying its velocity). Reanimated runs these on the UI
// thread, so feedback lands on the same frame as the touch.
//
// Springs are given as response (roughly the settle time, in seconds) and
// damping (1 = no overshoot), the same as SwiftUI, and converted to
// stiffness and damping for a unit mass.
import {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutUp,
  LinearTransition,
  ReduceMotion,
  type WithSpringConfig,
} from 'react-native-reanimated';

function fromResponse(response: number, dampingFraction: number): WithSpringConfig {
  const stiffness = Math.pow((2 * Math.PI) / response, 2);
  const damping = (4 * Math.PI * dampingFraction) / response;
  return { mass: 1, stiffness, damping, reduceMotion: ReduceMotion.System };
}

/** General UI: panels, chips, sliders, value changes. */
export const springUI = fromResponse(0.38, 0.78);
/** Button press and release. */
export const springPress = fromResponse(0.1, 1);
/** Fades and quiet transitions. */
export const springFade = fromResponse(0.475, 1);
/** Lists settling into place. */
export const springList = fromResponse(0.42, 1);

type Builder = { springify(): any };
function sprung<T extends Builder>(b: T, s: WithSpringConfig): T {
  return (b.springify() as any).mass(s.mass).stiffness(s.stiffness).damping(s.damping).reduceMotion(ReduceMotion.System);
}

/** Things arriving: a quiet fade. */
export const enterFade = sprung(FadeIn, springFade);
export const exitFade = sprung(FadeOut, springFade);
/** A new value replacing an old one: rises in, the old one rises away. */
export const enterRise = sprung(FadeInDown, springUI);
export const exitRise = sprung(FadeOutUp, springFade);
/** Rows moving when the list around them changes (routes arriving, sorted by time). */
export const moveList = sprung(LinearTransition, springList);
/** A fresh rise-in with its own delay (builders are shared objects, so never call .delay() on the ones above). */
export const riseIn = (delay = 0) => (sprung(FadeInDown, springUI) as any).delay(delay);
