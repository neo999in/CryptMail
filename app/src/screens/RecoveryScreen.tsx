import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cryptoMode } from '../config';
import { formatRecoveryCode, isValidRecoveryCode } from '../core/recoveryCode';
import { RecoveryBackup } from '../core';
import { needsBackup } from '../store/recoveryStore';
import { useApp } from '../state/AppState';
import { color, font, glass, radius, type } from '../theme';
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
export function RecoveryScreen() {
  const { identity, recovery, exportRecovery, restoreFromRecovery } = useApp();
  const insets = useSafeAreaInsets();

  const [backup, setBackup] = useState<RecoveryBackup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'code' | 'blob' | null>(null);

  const [blobInput, setBlobInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const blobFocus = useFocus();
  const codeFocus = useFocus();

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
    setError(null);
    try {
      setBackup(await exportRecovery());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async () => {
    setBusy(true);
    setError(null);
    try {
      const restored = await restoreFromRecovery(blobInput.trim(), codeInput);
      setBlobInput('');
      setCodeInput('');
      Alert.alert('Identity restored', `This device now uses the key for ${restored.email}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
    Alert.alert(
      'Replace this device’s key?',
      `This device already holds a key for ${identity.email}. Restoring replaces it — anything encrypted only to the current key will stop being readable here.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace', style: 'destructive', onPress: () => void doRestore() },
      ],
    );
  };

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
      keyboardShouldPersistTaps="handled"
    >
      {unprotected ? (
        <View style={{ marginBottom: 14 }}>
          <Banner tone="warn" icon="alert">
            This key has no backup. If you lose this device, every message ever sent to it becomes
            unreadable — permanently, and by everyone.
          </Banner>
        </View>
      ) : recovery.backedUpAt ? (
        <View style={{ marginBottom: 14 }}>
          <Banner tone="ok" icon="check">
            Backed up {new Date(recovery.backedUpAt).toLocaleDateString()}. The code is only useful
            with the backup text, and vice versa.
          </Banner>
        </View>
      ) : null}

      <Card>
        <Title>Back up this key</Title>
        <Muted>
          Creates a recovery code and a block of backup text. Keep them apart: the code on paper, the
          text somewhere you can get to it from another device. Neither one restores anything alone.
        </Muted>

        {!identity ? (
          <View style={{ marginTop: 14 }}>
            <Muted>No identity key on this device yet.</Muted>
          </View>
        ) : !backup ? (
          <View style={{ marginTop: 14 }}>
            <PrimaryButton
              title={recovery.backedUpAt ? 'Create a new backup' : 'Create a backup'}
              icon="shield"
              onPress={() => void doExport()}
              busy={busy}
            />
            {recovery.backedUpAt ? (
              <Text style={s.note}>
                A new backup issues a new code. The previous code stops being the one to keep.
              </Text>
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
            <Text style={s.note}>
              This is shown once and is not stored anywhere on this device — that is what makes it
              worth keeping. Letters are unambiguous: there is no O, I, L or U.
            </Text>

            <View style={s.row}>
              <SecondaryButton
                title={copied === 'code' ? 'Copied' : 'Copy code'}
                icon={copied === 'code' ? 'check' : 'copy'}
                onPress={() => void copy('code', backup.code)}
              />
              <SecondaryButton
                title={copied === 'blob' ? 'Copied' : 'Copy backup text'}
                icon={copied === 'blob' ? 'check' : 'copy'}
                onPress={() => void copy('blob', backup.blob)}
              />
            </View>

            <Text style={[s.eyebrow, { marginTop: 18 }]}>Backup text</Text>
            <Text style={s.blob} selectable numberOfLines={6}>
              {backup.blob}
            </Text>

            <View style={{ marginTop: 14 }}>
              <SecondaryButton title="Done" icon="check" onPress={() => setBackup(null)} />
            </View>
          </View>
        )}
      </Card>

      <Card style={{ marginTop: 14 }}>
        <Title>Restore from a backup</Title>
        <Muted>
          Paste the backup text and type the recovery code. The same key comes back, with the same
          fingerprint — nobody who writes to you has to change anything.
        </Muted>
        <View style={{ height: 12 }} />

        <Field label="Backup text" focused={blobFocus.focused}>
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

        <Field label="Recovery code" focused={codeFocus.focused}>
          <Input
            autoCapitalize="characters"
            autoCorrect={false}
            onChangeText={setCodeInput}
            // Reformatted as they type, so what is on screen matches the paper.
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

        {error ? (
          <View style={{ marginBottom: 12 }}>
            <Callout>{error}</Callout>
          </View>
        ) : null}

        <PrimaryButton
          title="Restore identity"
          icon="key"
          onPress={confirmRestore}
          busy={busy}
          disabled={blobInput.trim().length === 0 || !isValidRecoveryCode(codeInput)}
        />
        {codeInput.length > 0 && !isValidRecoveryCode(codeInput) ? (
          <Text style={s.note}>A recovery code is 32 characters — eight groups of four.</Text>
        ) : null}
      </Card>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

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

  blob: {
    color: color.inkDim,
    fontFamily: font.mono,
    fontSize: 10.5,
    lineHeight: 15,
  },
  blobInput: { fontFamily: font.mono, fontSize: 11.5, minHeight: 96 },
  codeInput: { fontFamily: font.mono, fontSize: 15, letterSpacing: 1.2 },

  note: { ...type.small, color: color.inkFaint, lineHeight: 18, marginTop: 10 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 14 },
});
