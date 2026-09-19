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
import { isValidRecoveryCode } from '../core/recoveryCode';
import { userMessage } from '../lib/errors';
import { backupFileName, saveTextFile } from '../lib/files';
import { useApp } from '../state/AppState';
import { drillOutstanding } from '../store/recoveryStore';
import { color, font, radius, space, type } from '../theme';
import { Icon, IconName } from '../ui/Icon';
import {
  Banner,
  Callout,
  Field,
  Group,
  Input,
  Label,
  Muted,
  PrimaryButton,
  SecondaryButton,
  StepHeading,
  Title,
  useFocus,
} from '../ui/primitives';
import { RecoveryCodeField, RecoveryCodeGrid } from '../ui/recoveryCode';
import { LoadedTransfer, useRestoreFile } from '../ui/restoreFile';

type Step = 'choose' | 'restore' | 'backup' | 'drill' | 'publish';

/** Where each step sits in the four the header counts. Restoring skips 2 and 3. */
const PROGRESS: Record<Step, { n: number; label: string }> = {
  choose: { n: 1, label: 'Your key' },
  restore: { n: 1, label: 'Restore your key' },
  backup: { n: 2, label: 'Recovery code' },
  drill: { n: 3, label: 'Check the code' },
  publish: { n: 4, label: 'Let people write to you' },
};
const STEPS = 4;

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

  /** This run's backup. Screen memory only — the code must not outlive it. */
  const [backup, setBackup] = useState<RecoveryBackup | null>(null);
  /** The core cannot make backups at all, so the drill cannot run. */
  const [backupUnavailable, setBackupUnavailable] = useState(false);
  const [blobCopied, setBlobCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  /** The backup text went somewhere — a file or the clipboard. Marks step 2 done. */
  const [blobKept, setBlobKept] = useState(false);
  const [drillInput, setDrillInput] = useState('');

  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };

  const makeBackup = async () => {
    setBusy(true);
    setError(null);
    try {
      setBackup(await exportRecovery());
    } catch (e) {
      if (e instanceof CoreError && e.code === 'unavailable') setBackupUnavailable(true);
      setError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveBackup = async (value: RecoveryBackup) => {
    setError(null);
    try {
      await saveTextFile(backupFileName(identity?.email ?? 'key'), value.blob, 'text/plain');
      setBlobKept(true);
    } catch (e) {
      setError(`Couldn’t save the backup file. ${userMessage(e)}`);
    }
  };

  const copyCode = async (value: RecoveryBackup) => {
    await Clipboard.setStringAsync(value.code);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 1800);
  };

  const copyBlob = async (value: RecoveryBackup) => {
    await Clipboard.setStringAsync(value.blob);
    setBlobKept(true);
    setBlobCopied(true);
    setTimeout(() => setBlobCopied(false), 1800);
  };

  /**
   * Fill the blob field from a file the user picks — or, for a device
   * transfer, hold it beside the field (`useRestoreFile`). Cancelling changes
   * nothing.
   *
   * This is the step that decides whether restoring happens at all. The backup
   * text is an armored key thousands of characters long, and on the device it
   * matters — a phone that has just been set up — it is in a file, not in a
   * clipboard that never crossed over. Asking for it as a paste is asking most
   * people to give up and generate a new key instead.
   */
  const restoreFile = useRestoreFile(setBlobInput, setError);
  const restoreBlob = restoreFile.transfer ?? blobInput.trim();

  const run = async (work: () => Promise<unknown>, next: Step | null) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      if (next) setStep(next);
      else onDone();
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** The failure, next to the action that failed — not below the card. */
  const problem = error ? <Callout>{error}</Callout> : null;
  const progress = PROGRESS[step];

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={{
        paddingHorizontal: space.lg,
        paddingTop: insets.top + space.xl,
        paddingBottom: insets.bottom + space.xl,
      }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={s.heading} accessibilityRole="header">
        Set up your key
      </Text>
      <View
        style={s.progress}
        accessibilityLabel={`Step ${progress.n} of ${STEPS}: ${progress.label}`}
        accessibilityRole="progressbar"
      >
        <View style={s.bars}>
          {Array.from({ length: STEPS }, (_, i) => (
            <View key={i} style={[s.bar, i < progress.n && s.barOn]} />
          ))}
        </View>
        <Text style={s.progressText}>
          Step {progress.n} of {STEPS} · {progress.label}
        </Text>
      </View>

      {step === 'choose' ? (
        <View style={s.stack}>
          <Choice
            icon="key"
            title="I’ve used CryptMail before"
            body="Restore your key from its backup and recovery code, or from the transfer file your old phone made. Your fingerprint stays the same, so the people who write to you notice nothing, and all your old encrypted mail stays readable."
          >
            <PrimaryButton title="Restore my key" icon="key" onPress={() => go('restore')} />
          </Choice>

          <Choice
            icon="plus"
            title="I’m new here"
            body="Create a new key on this phone. Only do this if you have no backup: a new key can’t open mail sent to an old one, and your contacts will see your fingerprint change."
          >
            <SecondaryButton
              title="Create a new key"
              icon="plus"
              onPress={() => void run(createIdentity, 'backup')}
            />
          </Choice>
          {problem}
        </View>
      ) : null}

      {step === 'restore' ? (
        <Panel>
          <Title>Restore your key</Title>
          <Muted>
            You need both halves: the file and its code — a backup with its recovery code, or a transfer
            with the code your old phone showed. Neither one works alone.
          </Muted>

          <StepHeading n={1} title="Load the backup or transfer" done={restoreBlob.length > 0} />
          <SecondaryButton title="Choose the file" icon="file" onPress={() => void restoreFile.load()} />
          {restoreFile.transfer ? (
            <LoadedTransfer text={restoreFile.transfer} onClear={restoreFile.clear} />
          ) : (
            <View>
              <Label>Or paste it here</Label>
              <Field focused={blobFocus.focused} style={s.flush}>
                <Input
                  accessibilityLabel="Backup text"
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
            </View>
          )}

          <StepHeading
            n={2}
            title={restoreFile.transfer ? 'Type the transfer code' : 'Type the recovery code'}
            done={isValidRecoveryCode(codeInput)}
          />
          <RecoveryCodeField
            value={codeInput}
            onChange={setCodeInput}
            label={restoreFile.transfer ? 'Transfer code' : 'Recovery code'}
          />

          {problem}
          <PrimaryButton
            title={restoreFile.transfer ? 'Move to this phone' : 'Restore my key'}
            icon="key"
            busy={busy}
            disabled={restoreBlob.length === 0 || !isValidRecoveryCode(codeInput)}
            onPress={() => void run(() => restoreFromRecovery(restoreBlob, codeInput), 'publish')}
          />
          <SecondaryButton title="Back" icon="back" onPress={() => go('choose')} />
        </Panel>
      ) : null}

      {step === 'backup' ? (
        <Panel>
          <Title>Save your way back in</Title>
          <Muted>
            Your key lives only on this phone. The recovery code and the backup text, together, are the only
            way to get it back.
          </Muted>
          <Banner tone="warn" icon="alert">
            Lose this phone without them and every encrypted message sent to you is gone for good. No one —
            not CryptMail, not your mail provider — can reset it.
          </Banner>

          {!backup ? (
            <>
              {problem}
              <PrimaryButton
                title="Create my recovery code"
                icon="shield"
                busy={busy}
                disabled={backupUnavailable}
                onPress={() => void makeBackup()}
              />
              {backupUnavailable ? (
                <>
                  <Banner tone="note" icon="shield">
                    The encryption engine on this phone can’t make backups yet, so this key has no way back if
                    the phone is lost. Settings will keep reminding you until it has one.
                  </Banner>
                  <SecondaryButton
                    title="Continue without a backup"
                    icon="chevron"
                    onPress={() => void run(waiveRecoveryDrill, 'publish')}
                  />
                </>
              ) : null}
            </>
          ) : (
            <>
              <StepHeading n={1} title="Write down the recovery code" />
              <RecoveryCodeGrid code={backup.code} />
              <Text style={s.note}>
                Groups 1 to 8, in order. Letters are unambiguous — there is no O, I, L or U. The code is shown
                once and never stored on this phone.
              </Text>
              <View style={s.row}>
                <SecondaryButton
                  title={codeCopied ? 'Copied' : 'Copy code'}
                  icon={codeCopied ? 'check' : 'copy'}
                  onPress={() => void copyCode(backup)}
                />
              </View>

              <View style={s.divider} />

              <StepHeading n={2} title="Save the backup text" done={blobKept} />
              <Text style={s.note}>
                Put it somewhere you can reach from a phone you don’t own yet — a drive or a password manager.
                The file holds the backup text only, never the code.
              </Text>
              <View style={s.row}>
                <SecondaryButton title="Save to a file" icon="download" onPress={() => void saveBackup(backup)} />
                <SecondaryButton
                  title={blobCopied ? 'Copied' : 'Copy text'}
                  icon={blobCopied ? 'check' : 'copy'}
                  onPress={() => void copyBlob(backup)}
                />
              </View>

              {problem}
              <PrimaryButton
                title="I’ve kept both — continue"
                icon="chevron"
                onPress={() => {
                  setDrillInput('');
                  go('drill');
                }}
              />
            </>
          )}
        </Panel>
      ) : null}

      {step === 'drill' ? (
        <Panel>
          <Title>Check your recovery code</Title>
          <Muted>
            Type it from where you wrote it down, groups 1 to 8 in order. This unlocks the backup you just
            made, exactly as a new phone would — so a miscopied character shows up now, while it’s easy to
            fix.
          </Muted>

          <RecoveryCodeField value={drillInput} onChange={setDrillInput} autoFocus />

          {problem}
          <PrimaryButton
            title="Check my code"
            icon="key"
            busy={busy}
            disabled={!isValidRecoveryCode(drillInput)}
            onPress={() => void run(() => completeRecoveryDrill(drillInput), 'publish')}
          />
          <SecondaryButton title="Show the code again" icon="back" onPress={() => go('backup')} />
        </Panel>
      ) : null}

      {step === 'publish' ? (
        <Panel>
          <Title>Let people write to you</Title>
          <Muted>
            Publishing your public key to {directoryName} lets anyone send you encrypted mail on their first
            try, without having to ask you for anything.
          </Muted>
          <Banner tone="note" icon="globe">
            The listing is public: anyone who looks up your address can see it has a key. Only the address and
            the key — never your messages. You can skip this and swap keys by hand instead.
          </Banner>

          {problem}
          <PrimaryButton
            title="Publish my public key"
            icon="shield"
            busy={busy}
            onPress={() => void run(publishOwnKey, null)}
          />
          <SecondaryButton title="Not now" icon="close" onPress={() => void run(declinePublish, null)} />
        </Panel>
      ) : null}
    </ScrollView>
  );
}

/** One card of the setup flow: a bordered `Group` with its contents evenly spaced. */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <Group style={s.panelOuter}>
      <View style={s.panel}>{children}</View>
    </Group>
  );
}

/** One of the two ways in on the first step. */
function Choice({
  icon,
  title,
  body,
  children,
}: {
  icon: IconName;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <Panel>
      <View style={s.choiceHead}>
        <View style={s.choiceIcon}>
          <Icon name={icon} size={18} color={color.ink} />
        </View>
        <Title style={s.choiceTitle}>{title}</Title>
      </View>
      <Muted>{body}</Muted>
      {children}
    </Panel>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },
  heading: {
    color: color.ink,
    fontFamily: font.displayBold,
    fontSize: 26,
    letterSpacing: -0.4,
  },

  progress: { gap: space.sm, marginBottom: space.xl, marginTop: space.md },
  bars: { flexDirection: 'row', gap: space.xs },
  bar: { backgroundColor: color.border, borderRadius: radius.pill, flex: 1, height: 3 },
  barOn: { backgroundColor: color.ink },
  progressText: { ...type.small, color: color.inkDim },

  stack: { gap: space.md },
  panelOuter: { marginHorizontal: 0 },
  panel: { gap: space.md, padding: space.lg },

  choiceHead: { alignItems: 'center', flexDirection: 'row', gap: space.md },
  choiceIcon: {
    alignItems: 'center',
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  choiceTitle: { flex: 1 },

  flush: { marginBottom: 0 },
  blobInput: { fontFamily: font.mono, fontSize: 11.5, minHeight: 96 },
  note: { ...type.small, color: color.inkFaint },
  row: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  divider: { backgroundColor: color.border, height: 1, marginVertical: space.xs },
});
