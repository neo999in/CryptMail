import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KmLink, KmStatus } from '../core';
import { isValidRecoveryCode } from '../core/recoveryCode';
import { userMessage } from '../lib/errors';
import { pickTextFile, saveTextFile } from '../lib/files';
import { back, RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { color, font, space, type } from '../theme';
import { confirmDialog } from '../ui/dialog';
import { RecoveryCodeField, RecoveryCodeGrid } from '../ui/recoveryCode';
import {
  Banner,
  Field,
  Input,
  useFocus,
  Callout,
  Group,
  GroupHeading,
  IconButton,
  PrimaryButton,
  SecondaryButton,
  StepHeading,
} from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'KeyManager'>;

/**
 * The quantum Key Manager for the signed-in mailbox.
 *
 * Levels 2 and 3 encrypt with symmetric keys a Key Manager hands out — in a
 * real deployment, keys a QKD link produced at both ends. This one is
 * simulated inside the app (`core/src/km.rs`): a bank of 100 keys of 1 Kb,
 * handed out through the ETSI GS QKD 014 calls, deleted once used. The screen
 * says so, because the keys are random rather than quantum.
 *
 * One login: the Key Manager's account is the mailbox you are signed in to, so
 * there is nothing separate to sign in to here.
 *
 * Two phones come to hold the same keys one of two ways, and the screen offers
 * them in this order:
 *
 *  · **Over email** — BB84, run in three messages (`state/bb84.ts`). Nothing is
 *    copied: both ends measure, compare a sample, and derive the same bank. It
 *    needs no second phone in the room and takes as long as three syncs.
 *  · **By file** — this bank, sealed under a one-time code, adopted by the
 *    other phone. Instant, manual, and plainly a copy. Kept for when the two
 *    phones are on one table.
 */
export function KeyManagerScreen({ navigation }: Props) {
  const { kmStatus, kmRegenerate, kmExportLink, kmImportLink, beginQuantumLink, checkQuantumLink } = useApp();
  const insets = useSafeAreaInsets();

  const [status, setStatus] = useState<KmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<KmLink | null>(null);
  const [linkBlob, setLinkBlob] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState('');
  /** The address a quantum link is being set up with, and whether it has gone. */
  const [peer, setPeer] = useState('');
  const [started, setStarted] = useState<string | null>(null);
  const peerFocus = useFocus();
  /** What the last "Check for link messages" found. */
  const [checked, setChecked] = useState<string | null>(null);

  const checkLink = () =>
    void run(async () => {
      setChecked(await checkQuantumLink());
      refresh();
    });

  const startLink = () =>
    void run(async () => {
      const to = peer.trim();
      await beginQuantumLink(to);
      setStarted(to);
      setPeer('');
    });

  const refresh = useCallback(() => {
    kmStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(userMessage(e)));
  }, [kmStatus]);

  useEffect(refresh, [refresh]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmRegenerate = () =>
    confirmDialog(
      'Refill the key bank?',
      'This replaces every key in the bank with 100 new ones. Mail sealed with the old keys and not yet opened here can’t be opened any more, and a linked phone must be linked again.',
      [
        { label: 'Cancel' },
        { label: 'Refill', tone: 'destructive', onPress: () => void run(async () => setStatus(await kmRegenerate())) },
      ],
    );

  const makeLink = () =>
    confirmDialog(
      'Link another phone?',
      'The other phone gets a copy of this bank. From then on each phone sends only with its own half — 50 keys each — so the two never use the same key.',
      [
        { label: 'Cancel' },
        {
          label: 'Make link',
          onPress: () =>
            void run(async () => {
              setLink(await kmExportLink());
              refresh();
            }),
        },
      ],
    );

  const loadLink = () =>
    void run(async () => {
      const picked = await pickTextFile();
      if (!picked) return;
      if ('refused' in picked) throw new Error(picked.refused);
      setLinkBlob(picked.text.trim());
    });

  const adoptLink = () =>
    void run(async () => {
      setStatus(await kmImportLink(linkBlob ?? '', linkCode));
      setLinkBlob(null);
      setLinkCode('');
    });

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>Quantum Key Manager</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.lg }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.gutter}>
          <Banner tone="note" icon="shield">
            Simulated Key Manager. The keys are random, not produced by a quantum channel — it shows how a
            real QKD Key Manager plugs in, through the same ETSI GS QKD 014 calls.
          </Banner>
        </View>

        {error ? (
          <View style={s.gutter}>
            <Callout>{error}</Callout>
          </View>
        ) : null}

        <GroupHeading>Signed in</GroupHeading>
        <Group>
          <View style={s.pad}>
            <Row label="Account" value={status?.account ?? '—'} mono />
            <Text style={s.hint}>
              The same login as your mailbox. Signing in to the mail signs you in here; signing out closes it.
            </Text>
            <Row label="SAE ID" value={status?.saeId ?? '—'} mono />
            <Row
              label="Linked to"
              value={status?.peerSaeId ? `${status.peerSaeId} (${status.role === 'Master' ? 'this phone is master' : 'this phone is slave'})` : 'No other phone yet'}
              mono={!!status?.peerSaeId}
            />
          </View>
        </Group>

        <GroupHeading>Key bank</GroupHeading>
        <Group>
          <View style={s.pad}>
            {status?.handedOver ? (
              <Banner tone="note" icon="forward">
                This key bank moved to another phone. It still opens quantum mail that was already on its way,
                but the other phone sends with it now — two phones sending as one end would seal with the
                same key twice.
              </Banner>
            ) : null}
            <Row label="Keys to send with" value={status ? (status.handedOver ? '—' : `${status.available}`) : '—'} />
            <Row label="Keys in the bank" value={status ? `${status.remaining} of ${status.bankSize}` : '—'} />
            <Row label="Key size" value={status ? `${status.keyBits} bits (1 Kb)` : '—'} />
            <Text style={s.hint}>
              Level 2 uses one key per message. Both phones send from the whole bank — if you both pick the
              same key, each message still gets its own encryption key, because it is tied to who sent it. A
              key is deleted as soon as the message it sealed is opened.
            </Text>
            <SecondaryButton title="Refill the bank" icon="refresh" onPress={confirmRegenerate} />
          </View>
        </Group>

        <GroupHeading>Set up a quantum link</GroupHeading>
        <Group>
          <View style={s.pad}>
            {started ? (
              <>
                <Banner tone="note" icon="forward">
                  Setting up a quantum link with {started}. It takes three messages and a few minutes — longer
                  if their phone is not open. The keys appear here when it finishes.
                </Banner>
                <SecondaryButton title="Set up another" icon="close" onPress={() => setStarted(null)} />
              </>
            ) : (
              <>
                <Text style={s.body}>
                  Both ends run the key exchange over email: this phone sends the states, theirs measures them,
                  and a sample is compared to prove nobody read them on the way. Neither phone sends the keys —
                  both work them out. If too much of that sample disagrees, no keys are built and CryptMail
                  says so.
                </Text>
                <Field focused={peerFocus.focused} label="THEIR ADDRESS">
                  <Input
                    {...peerFocus.bind}
                    autoCapitalize="none"
                    autoCorrect={false}
                    inputMode="email"
                    onChangeText={setPeer}
                    placeholder="them@example.com"
                    returnKeyType="send"
                    value={peer}
                  />
                </Field>
                <PrimaryButton
                  title="Send the states"
                  icon="forward"
                  busy={busy}
                  disabled={!peer.includes('@')}
                  onPress={startLink}
                />
                <Text style={s.hint}>
                  This replaces whatever bank this mailbox holds now, on both phones, once it finishes.
                </Text>
              </>
            )}
            <SecondaryButton title="Check for link messages" icon="refresh" onPress={checkLink} />
            {checked ? <Text style={s.hint}>{checked}</Text> : null}
          </View>
        </Group>

        <GroupHeading>Link another phone by file</GroupHeading>
        <Group>
          <View style={s.pad}>
            {!link ? (
              <>
                <Text style={s.body}>
                  The quicker way when both phones are here: this one makes a link file and a code, the other
                  loads them. It copies the bank rather than agreeing on one, so prefer the exchange above
                  where there is time for it.
                </Text>
                <PrimaryButton title="Make a link" icon="forward" busy={busy} onPress={makeLink} />
              </>
            ) : (
              <>
                <StepHeading n={1} title="Get the file to the other phone" />
                <PrimaryButton
                  title="Save link file"
                  icon="download"
                  onPress={() => void run(() => saveTextFile(`cryptmail-km-link-${status?.saeId ?? 'bank'}.txt`, link.blob, 'text/plain'))}
                />
                <StepHeading n={2} title="On the other phone, load it with this code" />
                <RecoveryCodeGrid code={link.code} label="Link code" />
                <Text style={s.hint}>Shown once. The file is useless without it.</Text>
                <SecondaryButton title="Done" icon="check" onPress={() => setLink(null)} />
              </>
            )}

            <View style={s.divider} />

            <Text style={s.eyebrow}>Received a link?</Text>
            {linkBlob ? (
              <Text style={s.hint}>Link file loaded. Type the code the other phone showed.</Text>
            ) : (
              <SecondaryButton title="Load link file" icon="file" onPress={loadLink} />
            )}
            {linkBlob ? (
              <>
                <RecoveryCodeField value={linkCode} onChange={setLinkCode} label="Link code" />
                <PrimaryButton
                  title="Link this phone"
                  icon="key"
                  busy={busy}
                  disabled={!isValidRecoveryCode(linkCode)}
                  onPress={adoptLink}
                />
                <Text style={s.hint}>This replaces this phone’s bank with the linked one.</Text>
              </>
            ) : null}
          </View>
        </Group>
      </ScrollView>
    </View>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, mono && s.mono]} selectable>
        {value}
      </Text>
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
  row: { gap: 2 },
  rowLabel: { ...type.small, color: color.inkFaint },
  rowValue: { ...type.body, color: color.ink },
  mono: { fontFamily: font.mono, fontSize: 13 },
  divider: { backgroundColor: color.border, height: 1, marginVertical: space.xs },
});
