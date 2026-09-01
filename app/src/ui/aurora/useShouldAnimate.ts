/**
 * Whether the aurora should be running at all.
 *
 * Four independent reasons to hold a static frame, gathered in one place so the
 * band cannot be animating for a reason nobody checked:
 *
 *   - the screen is not focused (`active`, from `useIsFocused()`),
 *   - the app is not in the foreground,
 *   - the OS reduced-motion setting is on,
 *   - the device is in battery saver / low power mode.
 *
 * The last two are separate settings and neither implies the other: Android's
 * Battery Saver does not necessarily zero `animator_duration_scale`, so
 * `useReducedMotion()` alone misses exactly the case where a user has most
 * asked not to have their battery spent on decoration.
 *
 * The foreground check matters less than it looks — Android stops drawing a
 * backgrounded app, so the frames were never painted — but the animation was
 * still *scheduled*, and a timer nobody can see is a timer nobody will notice
 * misbehaving. Cancelling it is honest and costs nothing.
 */
import * as Battery from 'expo-battery';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

export function useShouldAnimate(active: boolean): boolean {
  const reducedMotion = useReducedMotion();
  const [foreground, setForeground] = useState(() => AppState.currentState === 'active');
  const [lowPower, setLowPower] = useState(false);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    let live = true;

    // Not available on every platform (web has no such notion), and a failure
    // to read it must not stop the band rendering — assume not saving, which is
    // the state the device is in the overwhelming majority of the time.
    Battery.isLowPowerModeEnabledAsync()
      .then((on) => {
        if (live) setLowPower(on);
      })
      .catch(() => {});

    const sub = Battery.addLowPowerModeListener(({ lowPowerMode }) => {
      if (live) setLowPower(lowPowerMode);
    });

    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  return active && foreground && !reducedMotion && !lowPower;
}
