/**
 * Settings → App lock.
 *
 * A PIN, an optional fingerprint in front of it, and how long CryptMail may sit
 * in the background before it asks again. The rules are in
 * `applock/appLock.ts`; the live state is `ui/appLock.tsx`.
 *
 * Setting, changing and removing the PIN each take over the screen with the
 * same pad the lock screen uses. Removing it or changing it asks for the
 * current one first — someone handed the phone for a moment must not be able
 * to take the lock off for good. A fingerprint can only be switched on after a
 * successful scan, so it is known to work before anything depends on it.
 *
 * What the lock is *not* is said at the bottom, in words: it hides the app, it
 * does not add a layer of encryption.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import { AppState as OsAppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LOCK_TIMEOUT_LABEL, LOCK_TIMEOUTS, PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '../applock/appLock';
import { BIOMETRIC_NAME, BiometricAvailability } from '../lib/biometrics';
import { back, RootStackParamList } from '../navigation';
import { color, space, type } from '../theme';
import { useAppLock } from '../ui/appLock';
import { useAccent } from '../ui/appearance';
import { Icon } from '../ui/Icon';
import { Group, GroupHeading, IconButton, PressableRow, SettingsRow, Toggle } from '../ui/primitives';
import { PinPad } from '../ui/pinPad';
import { useToast } from '../ui/ToastContext';

type Props = NativeStackScreenProps<RootStackParamList, 'AppLock'>;

/**
 * Which pad is up, if any.
 *
 *   set:    new → confirm
 *   change: current → new → confirm
 *   off:    current
 */
type Flow =
  | { kind: 'set'; step: 'new' }
  | { kind: 'set'; step: 'confirm'; first: string }
  | { kind: 'change'; step: 'current' }
  | { kind: 'change'; step: 'new' }
  | { kind: 'change'; step: 'confirm'; first: string }
  | { kind: 'off' };

export function AppLockScreen({ navigation }: Props) {
  const lock = useAppLock();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to clear the pad between steps and after a miss.
  const [attempt, setAttempt] = useState(0);

  const { refreshBiometricSupport } = lock;
  // On coming back from system settings, where a fingerprint may have been added.
  useEffect(() => {
    refreshBiometricSupport();
    const subscription = OsAppState.addEventListener('change', (next) => {
      if (next === 'active') refreshBiometricSupport();
    });
    return () => subscription.remove();
  }, [refreshBiometricSupport]);

  const go = (next: Flow | null, message: string | null = null) => {
    setFlow(next);
    setError(message);
    setAttempt((n) => n + 1);
  };

  const scanName = BIOMETRIC_NAME[lock.biometricKind];

  const onPin = async (pin: string) => {
    if (!flow) return;

    if ((flow.kind === 'change' && flow.step === 'current') || flow.kind === 'off') {
      setBusy(true);
      const result = await lock.verifyPin(pin);
      if (!result.ok) {
        setBusy(false);
        setError(result.message);
        setAttempt((n) => n + 1);
        return;
      }
      if (flow.kind === 'off') {
        await lock.disable();
        setBusy(false);
        go(null);
        showToast({ durationMs: 3000, icon: 'lock', message: 'App lock is off.' });
        return;
      }
      setBusy(false);
      go({ kind: 'change', step: 'new' });
      return;
    }

    if (flow.step === 'new') {
      go(flow.kind === 'set' ? { kind: 'set', step: 'confirm', first: pin } : { kind: 'change', step: 'confirm', first: pin });
      return;
    }

    if (flow.step === 'confirm') {
      if (pin !== flow.first) {
        // Back to the start of the new PIN, not to the current one: that part
        // was right.
        go({ kind: flow.kind, step: 'new' }, "Those PINs didn't match. Choose one again.");
        return;
      }
      setBusy(true);
      await lock.setPin(pin);
      setBusy(false);
      go(null);
      showToast({
        durationMs: 3000,
        icon: 'lock',
        message: flow.kind === 'set' ? 'App lock is on.' : 'PIN changed.',
      });
    }
  };

  const toggleBiometrics = async (on: boolean) => {
    const outcome = await lock.setBiometrics(on);
    if (outcome === 'ok' || outcome === 'cancelled') return;
    showToast({
      durationMs: 4000,
      icon: 'alert',
      message:
        outcome === 'lockout'
          ? `Too many tries — ${scanName} is paused by the system. Try again later.`
          : `${capitalise(scanName)} didn't confirm, so it was not turned on.`,
    });
  };

  if (flow) {
    const pad = padFor(flow, lock.pinLength);
    return (
      <View style={s.screen}>
        <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
          <IconButton icon="close" label="Cancel" onPress={() => go(null)} size={40} />
          <Text style={s.title}>App lock</Text>
        </View>
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.xl }}
          showsVerticalScrollIndicator={false}
        >
          <PinPad
            busy={busy}
            error={error}
            length={pad.length}
            onSubmit={(pin) => void onPin(pin)}
            resetKey={attempt}
            subtitle={pad.subtitle}
            title={pad.title}
          />
        </ScrollView>
      </View>
    );
  }

  const support = lock.biometricSupport;
  const scanAvailable = support === 'available';

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>App lock</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.md }}
        showsVerticalScrollIndicator={false}
      >
        <GroupHeading>Lock</GroupHeading>
        <Group>
          <SettingsRow
            icon="lock"
            label="Require a PIN"
            onPress={() => go(lock.enabled ? { kind: 'off' } : { kind: 'set', step: 'new' })}
            trailing={
              <Toggle
                label="Require a PIN"
                on={lock.enabled}
                onChange={(next) => go(next ? { kind: 'set', step: 'new' } : { kind: 'off' })}
              />
            }
            value={lock.enabled ? `On · ${lock.pinLength}-digit PIN` : 'Off — anyone holding this phone unlocked can open your mail'}
          />
          {lock.enabled ? (
            <SettingsRow icon="key" label="Change PIN" onPress={() => go({ kind: 'change', step: 'current' })} />
          ) : null}
          <SettingsRow
            icon="fingerprint"
            label={`Unlock with ${scanName}`}
            onPress={() => {
              if (lock.enabled && scanAvailable) void toggleBiometrics(!lock.biometrics);
            }}
            trailing={
              <Toggle
                disabled={!lock.enabled || !scanAvailable}
                label={`Unlock with ${scanName}`}
                on={lock.biometrics && lock.enabled && scanAvailable}
                onChange={(next) => void toggleBiometrics(next)}
              />
            }
            value={biometricValue(support, lock.enabled, scanName)}
          />
        </Group>

        <GroupHeading>Ask again</GroupHeading>
        <Group>
          {/* A vertical choice list, shaped like the Notifications screen's —
              `Radio` is laid out for choices side by side. */}
          {LOCK_TIMEOUTS.map((timeout) => {
            const selected = lock.timeout === timeout;
            return (
              <PressableRow
                accessibilityHint={lock.enabled ? undefined : 'Set a PIN first'}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: !lock.enabled }}
                disabled={!lock.enabled}
                key={timeout}
                onPress={() => lock.setTimeout(timeout)}
                style={lock.enabled ? s.choice : { ...s.choice, ...s.off }}
              >
                <Text style={s.choiceLabel}>{LOCK_TIMEOUT_LABEL[timeout]}</Text>
                {selected ? <Icon color={accent} name="check" size={20} /> : null}
              </PressableRow>
            );
          })}
        </Group>
        <Text style={s.note}>
          Counted from when you leave CryptMail. Attaching a file, sharing an export or signing in to a mailbox opens
          another app for a moment, and coming back from that does not ask again.
        </Text>

        {lock.enabled ? (
          <Group style={{ marginTop: space.lg }}>
            <SettingsRow icon="lock" label="Lock now" onPress={lock.lockNow} />
          </Group>
        ) : null}

        <Text style={s.note}>
          The lock hides CryptMail from someone holding your phone. It does not add encryption: what is stored here
          is already sealed with this device&apos;s key whether the lock is on or not. Notifications follow their
          own setting — choose Private there to keep senders off the screen too.
        </Text>
        <Text style={s.note}>
          After five wrong PINs, CryptMail waits before accepting another — 30 seconds, then longer each time.
          There is no way to reset a forgotten PIN except clearing CryptMail&apos;s storage, which removes every
          mailbox and key on this device. Keep your recovery code.
        </Text>
      </ScrollView>
    </View>
  );
}

function padFor(flow: Flow, currentLength: number): { title: string; subtitle: string; length: number | null } {
  const choose = `${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits.`;
  if (flow.kind === 'off') return { title: 'Enter your PIN', subtitle: 'To turn app lock off.', length: currentLength };
  if (flow.step === 'current') return { title: 'Enter your current PIN', subtitle: 'To change it.', length: currentLength };
  if (flow.step === 'new') {
    return { title: flow.kind === 'set' ? 'Choose a PIN' : 'Choose a new PIN', subtitle: choose, length: null };
  }
  return { title: 'Enter it again', subtitle: 'To make sure it is the one you meant.', length: flow.first.length };
}

function biometricValue(support: BiometricAvailability | null, enabled: boolean, name: string): string {
  switch (support) {
    case null:
      return ' ';
    case 'unsupported':
      return 'Not available on this platform';
    case 'no-hardware':
      return 'This device has no sensor CryptMail can use';
    case 'not-enrolled':
      return `Add a ${name} in the system settings first — only strong biometrics are accepted`;
    default:
      return enabled ? 'Your PIN still works whenever the scan does not' : 'Set a PIN first — it is the fallback';
  }
}

const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  topbar: {
    alignItems: 'center',
    backgroundColor: color.surface,
    flexDirection: 'row',
    gap: space.sm,
    paddingBottom: space.md,
    paddingHorizontal: space.md,
  },
  title: { ...type.display, color: color.ink },

  // The measure of `SettingsRow`, so a choice sits in a group like a row does.
  choice: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.lg,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  choiceLabel: { ...type.settingsRow, color: color.ink, flex: 1 },
  off: { opacity: 0.45 },

  note: { ...type.small, color: color.inkFaint, paddingHorizontal: space.lg + 2, paddingTop: space.sm },
});
