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
 * 2. **For a new key, prove the way back works.** The key gets a recovery code
 *    and a backup, and setup does not go on until the code has been typed back
 *    and has actually unlocked that backup (features.md 0.15). A code nobody has
 *    ever used is a code nobody can be sure they have, and the moment that is
 *    discovered is the moment the phone is already gone. Restoring skips this:
 *    a restore *is* a successful code entry.
 * 3. **Publish, or not?** Listing the key is what lets a stranger write to this
 *    address encrypted on their first try. It is also public: anyone can learn
 *    from the listing that this address uses CryptMail. That is a consent
 *    decision, so it is asked plainly and answered before anything is uploaded.
 */
import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CoreError, RecoveryBackup } from '../core';
import { formatRecoveryCode, isValidRecoveryCode } from '../core/recoveryCode';
import { backupFileName, pickTextFile, saveTextFile } from '../lib/files';
import { useApp } from '../state/AppState';
import { drillOutstanding } from '../store/recoveryStore';
import { color, font, glass, radius, space, type } from '../theme';
import {
  Banner,
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

type Step = 'choose' | 'restore' | 'backup' | 'drill' | 'publish';

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const {
    identity,
    recovery,
    directoryName,
    createIdentity,
    restoreFromRecovery,
    exportRecovery,
    completeRecoveryDrill,
    waiveRecoveryDrill,
    publishOwnKey,
    declinePublish,
  } = useApp();
  const insets = useSafeAreaInsets();

  // A key that still owes its drill starts at the backup: that is a relaunch
  // part way through setup, and the code from before it was never stored.
  const [step, setStep] = useState<Step>(
    !identity ? 'choose' : drillOutstanding(recovery, identity.fingerprint) ? 'backup' : 'publish',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [blobInput, setBlobInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const blobFocus = useFocus();
  const codeFocus = useFocus();

  /** This run's backup. Screen memory only — the code must not outlive it. */
  const [backup, setBackup] = useState<RecoveryBackup | null>(null);
  /** The core cannot make backups at all, so the drill cannot run. */
  const [backupUnavailable, setBackupUnavailable] = useState(false);
  const [blobCopied, setBlobCopied] = useState(false);
  const [drillInput, setDrillInput] = useState('');
  const drillFocus = useFocus();

  const makeBackup = async () => {
    setBusy(true);
    setError(null);
    try {
      setBackup(await exportRecovery());
    } catch (e) {
      if (e instanceof CoreError && e.code === 'unavailable') setBackupUnavailable(true);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveBackup = async (value: RecoveryBackup) => {
    setError(null);
    try {
      await saveTextFile(backupFileName(identity?.email ?? 'key'), value.blob, 'text/plain');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copyBlob = async (value: RecoveryBackup) => {
    await Clipboard.setStringAsync(value.blob);
    setBlobCopied(true);
    setTimeout(() => setBlobCopied(false), 1800);
  };

  /**
   * Fill the blob field from a file the user picks. Cancelling changes nothing.
   *
   * This is the step that decides whether restoring happens at all. The backup
   * text is an armored key thousands of characters long, and on the device it
   * matters — a phone that has just been set up — it is in a file, not in a
   * clipboard that never crossed over. Asking for it as a paste is asking most
   * people to give up and generate a new key instead.
   */
  const loadBackupFile = async () => {
    setError(null);
    try {
      const result = await pickTextFile();
      if (!result) return;
      if ('refused' in result) {
        setError(result.refused);
        return;
      }
      setBlobInput(result.text.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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
      showsVerticalScrollIndicator={false}
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
                onPress={() => void run(createIdentity, 'backup')}
              />
            </View>
          </Card>
        </>
      ) : null}

      {step === 'restore' ? (
        <Card>
          <Title>Restore from a backup</Title>
          <Muted>
            Load the backup file or paste its text, then type the recovery code. Neither one
            restores anything alone.
          </Muted>
          <View style={{ marginTop: 12, marginBottom: 4 }}>
            <SecondaryButton title="Load from a file" icon="file" onPress={() => void loadBackupFile()} />
          </View>

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

      {step === 'backup' ? (
        <Card>
          <Title>Your recovery code</Title>
          <Muted>
            This key lives only on this device. If you lose the device and this code, every message
            ever sent to this key is unreadable — permanently, by anyone, and there is no one who can
            reset it for you.
          </Muted>

          {!backup ? (
            <View style={{ marginTop: 14 }}>
              <PrimaryButton
                title="Create my recovery code"
                icon="shield"
                busy={busy}
                disabled={backupUnavailable}
                onPress={() => void makeBackup()}
              />
              {backupUnavailable ? (
                <View style={{ marginTop: 12 }}>
                  <Banner tone="warn" icon="alert">
                    The crypto core on this device cannot make backups, so this key has no way back if
                    the device is lost. Keys will keep saying so until a backup exists.
                  </Banner>
                  <View style={{ marginTop: 10 }}>
                    <SecondaryButton
                      title="Continue without a backup"
                      icon="chevron"
                      onPress={() => void run(waiveRecoveryDrill, 'publish')}
                    />
                  </View>
                </View>
              ) : null}
            </View>
          ) : (
            <View style={{ marginTop: 16 }}>
              <Text style={s.eyebrow}>Recovery code — write this down now</Text>
              <View style={s.codeBox}>
                {backup.code.split('-').map((group, i) => (
                  <Text key={`${group}-${i}`} style={s.codeCell}>
                    {group}
                  </Text>
                ))}
              </View>
              {/* No copy button for the code, on purpose: the next step asks for
                  it back, and a clipboard round trip would pass that check
                  without the code ever being anywhere but this phone. */}
              <Text style={s.note}>
                Shown once and never stored on this device. Letters are unambiguous: there is no O, I,
                L or U. Next you will type it back, so write it somewhere that is not this phone.
              </Text>

              <Text style={[s.eyebrow, { marginTop: 18 }]}>Backup text</Text>
              <Text style={s.note}>
                The other half. Save it somewhere you can reach from a device you do not own yet — the
                file holds the backup text only, never the code.
              </Text>
              <View style={s.row}>
                <SecondaryButton title="Save to a file" icon="download" onPress={() => void saveBackup(backup)} />
                <SecondaryButton
                  title={blobCopied ? 'Copied' : 'Copy text'}
                  icon={blobCopied ? 'check' : 'copy'}
                  onPress={() => void copyBlob(backup)}
                />
              </View>

              <View style={{ marginTop: 16 }}>
                <PrimaryButton
                  title="I have written the code down"
                  icon="check"
                  onPress={() => {
                    setError(null);
                    setDrillInput('');
                    setStep('drill');
                  }}
                />
              </View>
            </View>
          )}
        </Card>
      ) : null}

      {step === 'drill' ? (
        <Card>
          <Title>Type your recovery code</Title>
          <Muted>
            From what you wrote down, not from memory. This unlocks the backup you just made, the same
            way a new phone would — so you find out now, while it is easy to fix, if a character was
            copied wrong.
          </Muted>

          <View style={{ marginTop: 12 }}>
            <Field label="Recovery code" focused={drillFocus.focused}>
              <Input
                autoCapitalize="characters"
                autoCorrect={false}
                onChangeText={setDrillInput}
                onBlur={() => {
                  drillFocus.bind.onBlur();
                  if (drillInput.trim()) setDrillInput(formatRecoveryCode(drillInput));
                }}
                onFocus={drillFocus.bind.onFocus}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                style={s.codeInput}
                value={drillInput}
              />
            </Field>
          </View>
          {drillInput.length > 0 && !isValidRecoveryCode(drillInput) ? (
            <Text style={[s.note, { marginTop: 0, marginBottom: 10 }]}>
              A recovery code is 32 characters — eight groups of four.
            </Text>
          ) : null}

          <PrimaryButton
            title="Check my code"
            icon="key"
            busy={busy}
            disabled={!isValidRecoveryCode(drillInput)}
            onPress={() => void run(() => completeRecoveryDrill(drillInput), 'publish')}
          />
          <View style={{ marginTop: 10 }}>
            <SecondaryButton
              title="Show the code again"
              icon="back"
              onPress={() => {
                setError(null);
                setStep('backup');
              }}
            />
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

  // The code box is RecoveryScreen's, so a code looks the same wherever it is shown.
  eyebrow: { ...type.eyebrow, color: color.inkFaint, letterSpacing: 0.8, marginBottom: 8 },
  codeBox: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderColor: glass.hairline,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
    paddingVertical: 14,
  },
  codeCell: {
    color: color.ink,
    fontFamily: font.mono,
    fontSize: 16,
    letterSpacing: 2,
    paddingVertical: 5,
    textAlign: 'center',
    width: '25%',
  },
  note: { ...type.small, color: color.inkFaint, lineHeight: 18, marginTop: 10 },
  row: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
});
