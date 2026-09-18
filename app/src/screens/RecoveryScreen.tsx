import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cryptoMode } from '../config';
import { isValidRecoveryCode } from '../core/recoveryCode';
import { RecoveryBackup } from '../core';
import { backupFileName, pickTextFile, saveTextFile } from '../lib/files';
import { back, RootStackParamList } from '../navigation';
import { needsBackup } from '../store/recoveryStore';
import { useApp } from '../state/AppState';
import { color, font, radius, space, type } from '../theme';
import { confirmDialog } from '../ui/dialog';
import { Icon, IconName } from '../ui/Icon';
import { RecoveryCodeField, RecoveryCodeGrid } from '../ui/recoveryCode';
import {
  Banner,
  Callout,
  Field,
  Group,
  GroupHeading,
  IconButton,
  Input,
  PrimaryButton,
  SecondaryButton,
  StepHeading,
  useFocus,
} from '../ui/primitives';
import { userMessage } from '../lib/errors';

type Props = NativeStackScreenProps<RootStackParamList, 'Recovery'>;

/**
 * Backup and restore for this device's identity key.
 *
 * The screen has one job the copy has to carry: making it clear *before* the
 * loss that there is no other way back. The key is wrapped by the platform
 * keystore, which has no backup path of its own — so a wiped phone with no
 * recovery code means every message ever sent to this key is unreadable, by
 * anyone, permanently. There is no support address that can undo it, and saying
 * so plainly is the only honest design.
 *
 * The two halves are deliberately separate: the code goes on paper, the blob
 * goes in storage, and neither alone restores anything.
 */
export function RecoveryScreen({ navigation }: Props) {
  const { identity, recovery, exportRecovery, restoreFromRecovery } = useApp();
  const insets = useSafeAreaInsets();

  const [backup, setBackup] = useState<RecoveryBackup | null>(null);
  const [busy, setBusy] = useState(false);
  /** Kept apart so a failure shows in the section it belongs to. */
  const [backupError, setBackupError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'code' | 'blob' | null>(null);

  const [blobInput, setBlobInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const blobFocus = useFocus();

  const unprotected = needsBackup(recovery, identity?.fingerprint ?? null);

  // The two cores emit different blobs: the real one re-locks the OpenPGP secret
  // key under the code, so the backup *is* a standard armored private key, while
  // demoCore wraps base64 in a header of its own. A placeholder showing the
  // wrong one tells a user their perfectly good backup looks wrong.
  const blobPlaceholder =
    cryptoMode === 'real'
      ? '-----BEGIN PGP PRIVATE KEY BLOCK-----'
      : '-----BEGIN CRYPTMAIL RECOVERY BACKUP-----';

  const copy = async (what: 'code' | 'blob', value: string) => {
    await Clipboard.setStringAsync(value);
    setCopied(what);
    setTimeout(() => setCopied(null), 1800);
  };

  const doExport = async () => {
    setBusy(true);
    setBackupError(null);
    try {
      setBackup(await exportRecovery());
    } catch (e) {
      setBackupError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hand the backup text out as a file.
   *
   * The clipboard is fine for moving the blob between two apps on one phone; it
   * is no way to get it onto the phone you buy after losing this one. A file
   * goes to a password manager, a drive, or a USB stick, and is still there in
   * two years — which is the timescale this feature is actually for.
   *
   * Only the blob. The code stays on paper: writing both into one file would
   * put the lock and its key in the same place and make the pair pointless.
   */
  const saveBackupFile = async (value: RecoveryBackup) => {
    setBackupError(null);
    try {
      await saveTextFile(backupFileName(identity?.email ?? 'key'), value.blob, 'text/plain');
    } catch (e) {
      setBackupError(`Couldn’t save the backup file. ${userMessage(e)}`);
    }
  };

  /** Fill the blob field from a file the user picks. Cancelling changes nothing. */
  const loadBackupFile = async () => {
    setRestoreError(null);
    try {
      const result = await pickTextFile();
      if (!result) return;
      if ('refused' in result) {
        setRestoreError(result.refused);
        return;
      }
      setBlobInput(result.text.trim());
    } catch (e) {
      setRestoreError(userMessage(e));
    }
  };

  const doRestore = async () => {
    setBusy(true);
    setRestoreError(null);
    try {
      const restored = await restoreFromRecovery(blobInput.trim(), codeInput);
      setBlobInput('');
      setCodeInput('');
      confirmDialog('Identity restored', `This device now uses the key for ${restored.email}.`, [{ label: 'OK' }]);
    } catch (e) {
      setRestoreError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = () => {
    if (!identity) {
      void doRestore();
      return;
    }
    // Replacing a key the device is already using is not obviously reversible
    // from the user's side, so it is worth one deliberate confirmation.
    confirmDialog(
      'Replace this device’s key?',
      `This device already holds a key for ${identity.email}. Restoring replaces it — anything encrypted only to the current key will stop being readable here.`,
      [
        { label: 'Cancel' },
        { label: 'Replace', tone: 'destructive', onPress: () => void doRestore() },
      ],
    );
  };

  const codeValid = isValidRecoveryCode(codeInput);

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>Key recovery</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.lg }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {unprotected ? (
          <View style={s.gutter}>
            <Banner tone="warn" icon="alert">
              This key has no backup. If you lose this device, every message ever sent to it becomes
              unreadable — permanently, and by everyone.
            </Banner>
          </View>
        ) : recovery.backedUpAt ? (
          <View style={s.gutter}>
            <Banner tone="ok" icon="check">
              Backed up {new Date(recovery.backedUpAt).toLocaleDateString()}. The code is only useful
              with the backup text, and vice versa.
            </Banner>
          </View>
        ) : null}

        {/* The two halves, drawn as two: what goes on paper, what goes in storage. */}
        <View style={s.halves}>
          <Half icon="edit" title="Recovery code" hint="On paper, kept at home" />
          <Half icon="file" title="Backup text" hint="In a drive or password manager" />
        </View>

        <GroupHeading>Back up this key</GroupHeading>
        <Group>
          <View style={s.pad}>
            {!backup ? (
              <Text style={s.body}>
                Creates a recovery code and a block of backup text. Keep them apart: the code on paper, the
                text somewhere you can get to it from another device. Neither one restores anything alone.
              </Text>
            ) : null}

            {!identity ? (
              <Text style={s.hint}>No identity key on this device yet.</Text>
            ) : !backup ? (
              <>
                {backupError ? <Callout>{backupError}</Callout> : null}
                <PrimaryButton
                  title={recovery.backedUpAt ? 'Create a new backup' : 'Create a backup'}
                  icon="shield"
                  onPress={() => void doExport()}
                  busy={busy}
                />
                {recovery.backedUpAt ? (
                  <Text style={s.hint}>
                    A new backup issues a new code. The previous code stops being the one to keep.
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                <StepHeading n={1} title="Write the recovery code down now" />
                <RecoveryCodeGrid code={backup.code} />
                <Text style={s.hint}>
                  Groups 1 to 8, in order. It is shown once and not stored anywhere on this device — that
                  is what makes it worth keeping. Letters are unambiguous: there is no O, I, L or U.
                </Text>
                <View style={s.actions}>
                  <SecondaryButton
                    title={copied === 'code' ? 'Copied' : 'Copy code'}
                    icon={copied === 'code' ? 'check' : 'copy'}
                    onPress={() => void copy('code', backup.code)}
                  />
                </View>

                <View style={s.divider} />

                <StepHeading n={2} title="Store the backup text somewhere else" />
                <View style={s.inset}>
                  <Text style={s.blob} selectable numberOfLines={5}>
                    {backup.blob}
                  </Text>
                </View>
                <PrimaryButton
                  title="Save backup to a file"
                  icon="download"
                  onPress={() => void saveBackupFile(backup)}
                />
                <View style={s.actions}>
                  <SecondaryButton
                    title={copied === 'blob' ? 'Copied' : 'Copy backup text'}
                    icon={copied === 'blob' ? 'check' : 'copy'}
                    onPress={() => void copy('blob', backup.blob)}
                  />
                </View>
                <Text style={s.hint}>
                  The file holds the backup text only — never the code. Put it somewhere you can reach
                  from a device you do not own yet.
                </Text>

                <View style={s.divider} />

                {backupError ? <Callout>{backupError}</Callout> : null}
                <SecondaryButton title="Done" icon="check" onPress={() => setBackup(null)} />
              </>
            )}
          </View>
        </Group>

        <GroupHeading>Restore from a backup</GroupHeading>
        <Group>
          <View style={s.pad}>
            <Text style={s.body}>
              Load the backup file or paste its text, then type the recovery code. The same key comes
              back, with the same fingerprint — nobody who writes to you has to change anything.
            </Text>

            <View>
              <View style={s.fieldHead}>
                <Text style={s.eyebrow}>Backup text</Text>
                <SecondaryButton title="Load file" icon="file" onPress={() => void loadBackupFile()} />
              </View>
              <Field focused={blobFocus.focused} style={s.fieldFlush}>
                <Input
                  autoCapitalize="none"
                  autoCorrect={false}
                  big
                  multiline
                  onChangeText={setBlobInput}
                  placeholder={blobPlaceholder}
                  style={s.blobInput}
                  value={blobInput}
                  {...blobFocus.bind}
                />
              </Field>
            </View>

            <RecoveryCodeField value={codeInput} onChange={setCodeInput} />

            {restoreError ? <Callout>{restoreError}</Callout> : null}

            <PrimaryButton
              title="Restore identity"
              icon="key"
              onPress={confirmRestore}
              busy={busy}
              disabled={blobInput.trim().length === 0 || !codeValid}
            />
          </View>
        </Group>
      </ScrollView>
    </View>
  );
}

/** One of the two things a backup is made of, and where it belongs. */
function Half({ icon, title, hint }: { icon: IconName; title: string; hint: string }) {
  return (
    <View style={s.half}>
      <Icon name={icon} size={20} color={color.inkDim} />
      <Text style={s.halfTitle}>{title}</Text>
      <Text style={s.halfHint}>{hint}</Text>
    </View>
  );
}

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
  title: { ...type.display, color: color.ink, flex: 1 },

  gutter: { marginBottom: space.md, marginHorizontal: space.lg },
  pad: { gap: space.md, padding: space.lg },

  body: { ...type.body, color: color.inkDim },
  hint: { ...type.small, color: color.inkFaint },
  eyebrow: { ...type.eyebrow, color: color.inkFaint },

  halves: { flexDirection: 'row', gap: space.sm, marginHorizontal: space.lg },
  half: {
    backgroundColor: color.card,
    borderColor: color.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    flex: 1,
    gap: space.xs,
    padding: space.md,
  },
  halfTitle: { ...type.strong, color: color.ink, marginTop: space.xs },
  halfHint: { ...type.small, color: color.inkFaint },

  inset: {
    backgroundColor: color.ground2,
    borderColor: color.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: space.sm,
    paddingVertical: space.md,
  },
  blob: { ...type.meta, color: color.inkDim, fontSize: 10.5, lineHeight: 15, paddingHorizontal: space.xs },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  divider: { backgroundColor: color.border, height: 1, marginVertical: space.xs },

  fieldHead: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: space.sm },
  fieldFlush: { marginBottom: 0 },
  blobInput: { fontFamily: font.mono, fontSize: 11.5, minHeight: 96 },
});
