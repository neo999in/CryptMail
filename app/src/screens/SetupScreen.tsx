/**
 * First run, after sign-in and before there is a key on this device.
 *
 * Two decisions, in the order that keeps a fingerprint stable:
 *
 * 1. **Restore, or generate?** This screen exists because the app used to
 *    generate an identity the moment a session appeared. Someone reinstalling
 *    then held a throwaway key by the time they found the recovery screen, and
 *    every correspondent saw "the key for them changed" in the meantime — a
 *    fingerprint change the app caused and nobody needed. Restoring first brings
 *    back the same key, and nobody has to do anything.
 * 2. **Publish, or not?** Listing the key is what lets a stranger write to this
 *    address encrypted on their first try. It is also public: anyone can learn
 *    from the listing that this address uses CryptMail. That is a consent
 *    decision, so it is asked plainly and answered before anything is uploaded.
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatRecoveryCode, isValidRecoveryCode } from '../core/recoveryCode';
import { useApp } from '../state/AppState';
import { color, font, space } from '../theme';
import {
  Callout,
  Card,
  Field,
  Input,
  Muted,
  PrimaryButton,
  SecondaryButton,
  Title,
  useFocus,
} from '../ui/primitives';

type Step = 'choose' | 'restore' | 'publish';

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const { identity, directoryName, createIdentity, restoreFromRecovery, publishOwnKey, declinePublish } =
    useApp();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<Step>(identity ? 'publish' : 'choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [blobInput, setBlobInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const blobFocus = useFocus();
  const codeFocus = useFocus();

  const run = async (work: () => Promise<unknown>, next: Step | null) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      if (next) setStep(next);
      else onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={s.heading}>Set up your key</Text>

      {step === 'choose' ? (
        <>
          <Card>
            <Title>Used CryptMail before?</Title>
            <Muted>
              Restore from your recovery code and this device gets the same key back — same
              fingerprint, so everyone who writes to you carries on as if nothing happened, and
              every message ever sent to you stays readable.
            </Muted>
            <View style={{ marginTop: 14 }}>
              <PrimaryButton title="Restore from a recovery code" icon="key" onPress={() => setStep('restore')} />
            </View>
          </Card>

          <Card style={{ marginTop: 14 }}>
            <Title>Starting fresh</Title>
            <Muted>
              Generates a new key on this device. Do this only if you have no backup: a new key
              cannot open anything that was sent to an old one, and your contacts will see the
              fingerprint change.
            </Muted>
            <View style={{ marginTop: 14 }}>
              <SecondaryButton
                title="Create a new key"
                icon="plus"
                onPress={() => void run(createIdentity, 'publish')}
              />
            </View>
          </Card>
        </>
      ) : null}

      {step === 'restore' ? (
        <Card>
          <Title>Restore from a backup</Title>
          <Muted>
            Paste the backup text and type the recovery code. Neither one restores anything alone.
          </Muted>
          <View style={{ height: 12 }} />

          <Field label="Backup text" focused={blobFocus.focused}>
            <Input
              autoCapitalize="none"
              autoCorrect={false}
              big
              multiline
              onChangeText={setBlobInput}
              placeholder="-----BEGIN …-----"
              style={s.blobInput}
              value={blobInput}
              {...blobFocus.bind}
            />
          </Field>

          <Field label="Recovery code" focused={codeFocus.focused}>
            <Input
              autoCapitalize="characters"
              autoCorrect={false}
              onChangeText={setCodeInput}
              onBlur={() => {
                codeFocus.bind.onBlur();
                if (codeInput.trim()) setCodeInput(formatRecoveryCode(codeInput));
              }}
              onFocus={codeFocus.bind.onFocus}
              placeholder="K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-2N8Q"
              style={s.codeInput}
              value={codeInput}
            />
          </Field>

          <PrimaryButton
            title="Restore my key"
            icon="key"
            busy={busy}
            disabled={blobInput.trim().length === 0 || !isValidRecoveryCode(codeInput)}
            onPress={() => void run(() => restoreFromRecovery(blobInput.trim(), codeInput), 'publish')}
          />
          <View style={{ marginTop: 10 }}>
            <SecondaryButton title="Back" icon="chevron" onPress={() => setStep('choose')} />
          </View>
        </Card>
      ) : null}

      {step === 'publish' ? (
        <Card>
          <Title>Let people write to you</Title>
          <Muted>
            Publishing your public key to {directoryName} is what lets someone send you encrypted
            mail the first time they write, without asking you for anything.
          </Muted>
          <View style={{ marginTop: 12 }}>
            <Callout>
              The listing is public. Anyone who tries your address can see that it has a key — the
              address and the key, never your messages. You can skip this and exchange keys by hand.
            </Callout>
          </View>
          <View style={{ marginTop: 14 }}>
            <PrimaryButton
              title="Publish my public key"
              icon="shield"
              busy={busy}
              onPress={() => void run(publishOwnKey, null)}
            />
            <View style={{ marginTop: 10 }}>
              <SecondaryButton title="Not now" icon="close" onPress={() => void run(declinePublish, null)} />
            </View>
          </View>
        </Card>
      ) : null}

      {error ? (
        <View style={{ marginTop: 14 }}>
          <Callout>{error}</Callout>
        </View>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },
  heading: {
    color: color.ink,
    fontFamily: font.displayBold,
    fontSize: 24,
    letterSpacing: -0.4,
    marginBottom: space.lg,
  },
  blobInput: { fontFamily: font.mono, fontSize: 11.5, minHeight: 96 },
  codeInput: { fontFamily: font.mono, fontSize: 15, letterSpacing: 1.2 },
});
