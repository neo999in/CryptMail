/**
 * A themed replacement for `Alert.alert`.
 *
 * The native dialog is OS chrome — a plain system-grey card with the
 * platform's own type and its own idea of an accent colour. It answers to
 * none of this app's tokens, so every "are you sure?" broke the illusion the
 * rest of the rework built. This is the same shape as the call it replaces —
 * title, message, buttons — so a call site swaps `Alert.alert(...)` for
 * `confirmDialog(...)` and nothing else changes; what changes is what the
 * user sees.
 *
 * Deliberately a global function backed by one host mounted at the root,
 * exactly like `Alert.alert` itself is a static call with no component of its
 * own to mount — a screen that wants to confirm something should not need a
 * `useState` and a JSX block just to ask. `DialogHost` is UI plumbing, not a
 * domain subsystem, so — like `ui/appearance.tsx` and `ui/destination.tsx` —
 * it stays out of `state/`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { color, font, radius, shadow, space, type } from '../theme';
import { useAccent } from './appearance';

export type DialogButton = {
  label: string;
  onPress?: () => void;
  /** `destructive` renders coral; anything else renders in the current accent. */
  tone?: 'default' | 'destructive';
};

type Request = { title: string; message?: string; buttons: DialogButton[] };

let show: ((req: Request) => void) | null = null;

/**
 * Show a themed dialog. `buttons` is never optional — unlike `Alert.alert`,
 * which quietly supplies a bare "OK" when the array is omitted, a caller here
 * says explicitly what dismisses it.
 *
 * A no-op before `DialogHost` has mounted, which cannot happen in practice:
 * it is mounted once at the root, before any screen exists to call this.
 */
export function confirmDialog(title: string, message: string | undefined, buttons: DialogButton[]): void {
  show?.({ title, message, buttons });
}

/** Mounted once, near the root, inside `AppearanceProvider` so it can read the accent. */
export function DialogHost() {
  const [request, setRequest] = useState<Request | null>(null);
  const accent = useAccent();

  useEffect(() => {
    show = setRequest;
    return () => {
      show = null;
    };
  }, []);

  const close = useCallback(() => setRequest(null), []);

  if (!request) return null;

  const press = (button: DialogButton) => {
    close();
    button.onPress?.();
  };

  return (
    <Modal animationType="fade" onRequestClose={close} transparent visible>
      <Pressable accessibilityLabel="Dismiss" onPress={close} style={[StyleSheet.absoluteFill, s.scrim]} />
      <View pointerEvents="box-none" style={s.wrap}>
        <View style={[s.card, shadow.floating]}>
          <Text style={s.title}>{request.title}</Text>
          {request.message ? <Text style={s.message}>{request.message}</Text> : null}
          <View style={s.actions}>
            {request.buttons.map((button, i) => (
              <Pressable
                accessibilityRole="button"
                key={i}
                onPress={() => press(button)}
                style={({ pressed }) => [s.action, pressed && { backgroundColor: color.rowPress }]}
              >
                <Text style={[s.actionText, { color: button.tone === 'destructive' ? color.coral : accent }]}>
                  {button.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { backgroundColor: color.scrim },
  wrap: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: space.xl },
  card: {
    backgroundColor: color.card,
    borderColor: color.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    maxWidth: 380,
    padding: space.lg,
    width: '100%',
  },
  title: { ...type.heading, color: color.ink },
  message: { ...type.body, color: color.inkDim, fontFamily: font.sans, marginTop: space.sm },
  actions: { flexDirection: 'row', gap: space.sm, justifyContent: 'flex-end', marginTop: space.lg },
  action: { borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 10 },
  actionText: { ...type.strong },
});
