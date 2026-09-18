/**
 * A PIN pad: a heading, a row of dots, and a 3×4 keypad.
 *
 * Shared by the lock screen and by Settings → App lock (set, confirm, change,
 * turn off), so entering a PIN looks and behaves the same everywhere.
 *
 * Its own keys rather than a `TextInput` with the number keyboard: the system
 * keyboard learns and suggests, slides in over half the screen, and on some
 * keyboards offers a clipboard strip — none of which belongs next to a PIN.
 *
 * Two ways to finish:
 *   - `length` given (unlocking, confirming): checks the moment that many
 *     digits are in, like a phone's own lock screen.
 *   - `length` null (choosing a new PIN): any length from 4 to 8, finished with
 *     the Continue button.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '../applock/appLock';
import { color, radius, space, type } from '../theme';
import { useAccent } from './appearance';
import { Icon, IconName } from './Icon';
import { PrimaryButton } from './primitives';

const KEY_SIZE = 72;

export function PinPad({
  title,
  subtitle,
  length,
  onSubmit,
  error,
  disabled,
  busy,
  biometric,
  resetKey,
}: {
  title: string;
  subtitle?: string;
  /** Fixed length to auto-submit at, or null to let the user choose 4–8 and press Continue. */
  length: number | null;
  onSubmit: (pin: string) => void;
  /** Why the last attempt failed, or how long the cooldown has left. Read out as it changes. */
  error?: string | null;
  /** No digits accepted — a cooldown. The biometric key stays usable. */
  disabled?: boolean;
  /** A check is running; keys wait for it. */
  busy?: boolean;
  /** The bottom-left key, when a fingerprint or face may be used instead. */
  biometric?: { icon: IconName; label: string; onPress: () => void };
  /** Change this to clear what has been typed — after a wrong PIN, or a new step. */
  resetKey?: unknown;
}) {
  const accent = useAccent();
  const [digits, setDigits] = useState('');

  useEffect(() => setDigits(''), [resetKey]);

  const locked = !!disabled || !!busy;
  const cap = length ?? PIN_MAX_LENGTH;

  const press = (digit: string) => {
    if (locked || digits.length >= cap) return;
    const next = digits + digit;
    setDigits(next);
    if (length !== null && next.length === length) onSubmit(next);
  };

  const erase = () => {
    if (!locked) setDigits((d) => d.slice(0, -1));
  };

  // A fixed length shows every slot up front; a free one shows what is typed,
  // padded to the minimum so an empty pad still reads as a PIN field.
  const slots = length ?? Math.max(PIN_MIN_LENGTH, digits.length);

  return (
    <View style={s.wrap}>
      <View style={s.head}>
        <Text accessibilityRole="header" style={s.title}>
          {title}
        </Text>
        {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
      </View>

      <View
        accessibilityLabel={`${digits.length} of ${length ?? `${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH}`} digits entered`}
        accessible
        style={s.dots}
      >
        {Array.from({ length: slots }, (_, i) => (
          <View
            key={i}
            style={[
              s.dot,
              i < digits.length ? { backgroundColor: accent, borderColor: accent } : null,
            ]}
          />
        ))}
      </View>

      <View style={s.status}>
        {busy ? (
          <ActivityIndicator color={color.inkDim} size="small" />
        ) : error ? (
          <Text accessibilityLiveRegion="polite" style={s.error}>
            {error}
          </Text>
        ) : null}
      </View>

      <View style={s.grid}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Key disabled={locked} key={d} label={d} onPress={() => press(d)}>
            <Text style={s.digit}>{d}</Text>
          </Key>
        ))}
        {biometric ? (
          <Key disabled={!!busy} label={biometric.label} onPress={biometric.onPress} quiet>
            <Icon color={color.ink} name={biometric.icon} size={28} />
          </Key>
        ) : (
          <View style={s.keySpace} />
        )}
        <Key disabled={locked} label="0" onPress={() => press('0')}>
          <Text style={s.digit}>0</Text>
        </Key>
        <Key disabled={locked || digits.length === 0} label="Delete" onPress={erase} quiet>
          <Icon color={color.inkDim} name="backspace" size={26} />
        </Key>
      </View>

      {length === null ? (
        <View style={s.submit}>
          <PrimaryButton
            disabled={digits.length < PIN_MIN_LENGTH || locked}
            onPress={() => onSubmit(digits)}
            title="Continue"
          />
        </View>
      ) : null}
    </View>
  );
}

function Key({
  label,
  onPress,
  disabled,
  quiet,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** No card behind it — the biometric and delete keys, which are not digits. */
  quiet?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.key,
        !quiet && s.keyCard,
        pressed && { backgroundColor: color.segmentActive },
        disabled && { opacity: 0.4 },
      ]}
    >
      {children}
    </Pressable>
  );
}

const s = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.lg, paddingHorizontal: space.lg },
  head: { alignItems: 'center', gap: space.xs },
  title: { ...type.display, color: color.ink, textAlign: 'center' },
  subtitle: { ...type.body, color: color.inkDim, textAlign: 'center' },

  dots: { flexDirection: 'row', gap: space.md, justifyContent: 'center', minHeight: 14 },
  dot: {
    borderColor: color.borderStrong,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    height: 14,
    width: 14,
  },
  // Holds its height whether or not there is a message, so the keys never jump.
  status: { alignItems: 'center', justifyContent: 'center', minHeight: 36 },
  error: { ...type.small, color: color.coral, textAlign: 'center' },

  grid: {
    columnGap: space.xl,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    rowGap: space.md,
    width: KEY_SIZE * 3 + space.xl * 2,
  },
  key: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: KEY_SIZE,
    justifyContent: 'center',
    width: KEY_SIZE,
  },
  keyCard: { backgroundColor: color.card, borderColor: color.border, borderWidth: 1 },
  keySpace: { height: KEY_SIZE, width: KEY_SIZE },
  digit: { ...type.display, color: color.ink },

  submit: { alignSelf: 'stretch' },
});
