/**
 * The lock screen, drawn over everything while `useAppLock().locked`.
 *
 * A `Modal` rather than an absolutely positioned view: a `Sheet` or a dialog is
 * its own native window, and a plain overlay would sit *under* one left open
 * when the lock came down. Presented later, the lock's window sits on top.
 *
 * The app underneath stays mounted — what was being written is still there
 * after unlocking — but is never visible or reachable while this is up.
 *
 * With a fingerprint enabled it asks for it once, as soon as the lock appears
 * with the app in front, and not again on its own after a cancel: a prompt that
 * reopens every time it is dismissed is a prompt that cannot be dismissed. The
 * pad's fingerprint key asks again.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState as OsAppState, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cooldownRemaining, DEFAULT_APP_LOCK, describeWait } from '../applock/appLock';
import { BIOMETRIC_NAME } from '../lib/biometrics';
import { color, space, type } from '../theme';
import { useAppLock } from './appLock';
import { Icon } from './Icon';
import { PinPad } from './pinPad';

export function AppLockGate() {
  const lock = useAppLock();

  // Until the settings are read nobody knows whether there is a lock, so the
  // app is covered rather than shown for a frame and then hidden.
  if (lock.loading) return <View pointerEvents="auto" style={[StyleSheet.absoluteFill, s.cover]} />;

  return (
    <Modal
      // No fade: the right PIN should show the mail at once, not a beat later.
      animationType="none"
      navigationBarTranslucent
      // There is nowhere to go back to: the back button does not dismiss a lock.
      onRequestClose={() => {}}
      statusBarTranslucent
      transparent={false}
      visible={lock.locked}
    >
      {lock.locked ? <LockScreen /> : null}
    </Modal>
  );
}

function LockScreen() {
  const {
    biometricKind,
    biometricSupport,
    biometrics,
    lockedUntil,
    pinLength,
    unlockWithBiometrics,
    unlockWithPin,
  } = useAppLock();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [forgotOpen, setForgotOpen] = useState(false);
  const prompted = useRef(false);

  const canScan = biometrics && biometricSupport === 'available';
  const wait = cooldownRemaining({ ...DEFAULT_APP_LOCK, lockedUntil }, now);

  // Tick while a cooldown runs, so the pad re-opens on its own.
  const cooling = wait > 0;
  useEffect(() => {
    if (!cooling) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      // The wait is over. The last miss's message ("try again in 30 seconds")
      // would now be wrong, so it goes with it.
      setError(null);
    };
  }, [cooling]);

  const scan = useCallback(async () => {
    const outcome = await unlockWithBiometrics();
    if (outcome === 'lockout') setError(`Too many tries — ${BIOMETRIC_NAME[biometricKind]} is paused. Use your PIN.`);
    else if (outcome === 'failed') setError(`${capitalise(BIOMETRIC_NAME[biometricKind])} not recognised. Use your PIN.`);
    else if (outcome === 'unavailable') setError(`${capitalise(BIOMETRIC_NAME[biometricKind])} isn't available. Use your PIN.`);
  }, [biometricKind, unlockWithBiometrics]);

  // Once per lock, and only with the app in front — a prompt raised while the
  // app is still in the background is refused by the system.
  useEffect(() => {
    if (!canScan || prompted.current) return;
    const go = () => {
      if (prompted.current) return;
      prompted.current = true;
      void scan();
    };
    if (OsAppState.currentState === 'active') {
      go();
      return;
    }
    const subscription = OsAppState.addEventListener('change', (next) => {
      if (next === 'active') go();
    });
    return () => subscription.remove();
  }, [canScan, scan]);

  const submit = async (pin: string) => {
    setBusy(true);
    const result = await unlockWithPin(pin);
    setBusy(false);
    setNow(Date.now());
    if (!result.ok) {
      setError(result.message);
      setAttempt((n) => n + 1);
    }
  };

  return (
    <View
      style={[s.screen, { paddingBottom: insets.bottom + space.xl, paddingTop: insets.top + space.xl * 2 }]}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={s.glyph}>
        <Icon color={color.inkDim} name="lock" size={28} />
      </View>

      <PinPad
        biometric={
          canScan
            ? {
                icon: 'fingerprint',
                label: `Unlock with ${BIOMETRIC_NAME[biometricKind]}`,
                onPress: () => void scan(),
              }
            : undefined
        }
        busy={busy}
        disabled={cooling}
        error={cooling ? `Too many wrong PINs. Try again in ${describeWait(wait)}.` : error}
        length={pinLength}
        onSubmit={(pin) => void submit(pin)}
        resetKey={attempt}
        subtitle="Enter your PIN to open your mail."
        title="CryptMail is locked"
      />

      <View style={s.foot}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: forgotOpen }}
          hitSlop={8}
          onPress={() => setForgotOpen((open) => !open)}
        >
          <Text style={s.forgot}>Forgot your PIN?</Text>
        </Pressable>
        {forgotOpen ? (
          <Text style={s.note}>
            There is no reset from here — one would let anyone holding the phone past the lock. Clearing
            CryptMail&apos;s storage in the system&apos;s app settings removes the lock together with every mailbox,
            key and draft on this device. Your key comes back from its recovery code.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

const s = StyleSheet.create({
  cover: { backgroundColor: color.ground },
  screen: { backgroundColor: color.ground, flex: 1, justifyContent: 'space-between' },
  glyph: { alignItems: 'center' },
  foot: { alignItems: 'center', gap: space.sm, paddingHorizontal: space.xl },
  forgot: { ...type.strong, color: color.inkDim },
  note: { ...type.small, color: color.inkFaint, textAlign: 'center' },
});
