import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { transferFileName } from '../core/transferFile';
import { userMessage } from '../lib/errors';
import { saveTextFile } from '../lib/files';
import { back, RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { TransferMade } from '../state/types';
import { color, space, type } from '../theme';
import { confirmDialog } from '../ui/dialog';
import { RecoveryCodeGrid } from '../ui/recoveryCode';
import {
  Banner,
  Callout,
  Group,
  GroupHeading,
  IconButton,
  PrimaryButton,
  SecondaryButton,
  StepHeading,
} from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Transfer'>;

/**
 * The old phone's half of moving to a new one.
 *
 * A recovery backup brings the key back, and with it every message sealed to
 * it. It cannot bring back mail read with quantum keys — those keys are gone by
 * design — or the Key Manager's bank. A transfer does both: it seals the key,
 * the bank and the archive of what was read, under a code shown once.
 *
 * The part the copy must carry is that this is a *move*. Once the file exists
 * this phone stops sending with quantum keys, because two phones sending as one
 * end would seal two messages with the same key. It can still read, at every
 * level. The new phone's half is the ordinary restore field, which takes a
 * transfer file as readily as a backup.
 */
export function TransferScreen({ navigation }: Props) {
  const { identity, exportTransfer, transferStatus, resumeTransfer } = useApp();
  const insets = useSafeAreaInsets();

  /** `undefined` while asking the core. */
  const [handedOverAt, setHandedOverAt] = useState<Date | null | undefined>(undefined);
  const [made, setMade] = useState<TransferMade | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    transferStatus()
      .then((at) => live && setHandedOverAt(at))
      .catch(() => live && setHandedOverAt(null));
    return () => {
      live = false;
    };
  }, [transferStatus]);

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const transfer = await exportTransfer();
      setMade(transfer);
      setSaved(false);
      setHandedOverAt(await transferStatus().catch(() => new Date()));
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmMake = () =>
    confirmDialog(
      'Move to a new phone?',
      'This phone will stop sending with quantum keys as soon as the transfer is made — the key bank carries on from the new phone. It will still read your mail.',
      [
        { label: 'Cancel' },
        { label: 'Make transfer', onPress: () => void make() },
      ],
    );

  const save = async (transfer: TransferMade) => {
    setError(null);
    try {
      await saveTextFile(transferFileName(identity?.email ?? 'key'), transfer.blob, 'text/plain');
      setSaved(true);
    } catch (e) {
      setError(`Couldn’t save the transfer file. ${userMessage(e)}`);
    }
  };

  const confirmResume = () =>
    confirmDialog(
      'Keep using this phone?',
      'Only if the new phone has not sent anything with quantum keys yet. If both phones draw from the same key bank, the same key is used twice.',
      [
        { label: 'Cancel' },
        {
          label: 'Keep using this phone',
          tone: 'destructive',
          onPress: () =>
            void resumeTransfer()
              .then(() => {
                setHandedOverAt(null);
                setMade(null);
              })
              .catch((e) => setError(userMessage(e))),
        },
      ],
    );

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>Move to a new phone</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.lg }}
        showsVerticalScrollIndicator={false}
      >
        {handedOverAt && !made ? (
          <View style={s.gutter}>
            <Banner tone="note" icon="forward">
              This phone handed its quantum key bank to another on {handedOverAt.toLocaleDateString()}. It
              still reads your mail, but no longer sends at Levels 2 or 3.
            </Banner>
          </View>
        ) : null}

        <GroupHeading>What moves</GroupHeading>
        <Group>
          <View style={s.pad}>
            <Point title="Your key">
              The same fingerprint, so nobody who writes to you has to change anything.
            </Point>
            <Point title="Mail you read with quantum keys">
              Those messages can’t be decrypted again — the copy on this phone is the only one — so it moves
              too.
            </Point>
            <Point title="Your quantum key bank">
              The keys Levels 2 and 3 send with, and the link to the other phone that shares them. Without
              them the new phone could open no quantum mail still on its way, and would have to link again.
            </Point>
          </View>
        </Group>

        <GroupHeading>{made ? 'Finish on the new phone' : 'Make the transfer'}</GroupHeading>
        <Group>
          <View style={s.pad}>
            {!identity ? (
              <Text style={s.hint}>No identity key on this device yet.</Text>
            ) : !made ? (
              <>
                <Text style={s.body}>
                  You get a file and a code. The file is sealed; only the code opens it. Once it is made, this
                  phone stops sending with quantum keys.
                </Text>
                {error ? <Callout>{error}</Callout> : null}
                <PrimaryButton
                  title={handedOverAt ? 'Make a new transfer' : 'Make a transfer'}
                  icon="forward"
                  busy={busy}
                  onPress={confirmMake}
                />
                {handedOverAt ? (
                  <Text style={s.hint}>
                    A new transfer carries this phone’s key bank as it is now. Don’t load it on a phone
                    that has already sent with the earlier one.
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                <StepHeading n={1} title="Get the file to the new phone" done={saved} />
                <PrimaryButton title="Save transfer file" icon="download" onPress={() => void save(made)} />
                <Text style={s.hint}>
                  Any way you like — a drive, a cable, an email to yourself. Send the code a different way, or
                  just read it off this screen.
                  {made.archived > 0
                    ? ` It holds ${made.archived} ${made.archived === 1 ? 'message' : 'messages'} read with quantum keys.`
                    : ''}
                </Text>
                {made.unreadable > 0 ? (
                  <Banner tone="warn" icon="alert">
                    {made.unreadable} archived {made.unreadable === 1 ? 'message' : 'messages'} couldn’t be opened
                    on this phone and {made.unreadable === 1 ? 'isn’t' : 'aren’t'} in the transfer.
                  </Banner>
                ) : null}

                <View style={s.divider} />

                <StepHeading n={2} title="On the new phone" />
                <Text style={s.body}>
                  Install CryptMail, sign in to {identity.email}, choose “I’ve used CryptMail before”, load the
                  file, and type this code:
                </Text>
                <RecoveryCodeGrid code={made.code} label="Transfer code" />
                <Text style={s.hint}>
                  Shown once and not stored. If you lose it before the move is done, make a new transfer.
                </Text>

                {error ? <Callout>{error}</Callout> : null}
                <SecondaryButton title="Done" icon="check" onPress={() => setMade(null)} />
              </>
            )}
          </View>
        </Group>

        {handedOverAt ? (
          <>
            <GroupHeading>Changed your mind?</GroupHeading>
            <Group>
              <View style={s.pad}>
                <Text style={s.body}>
                  If the new phone never used the transfer, this phone can take its key bank back.
                </Text>
                <SecondaryButton title="Keep using this phone" icon="back" onPress={confirmResume} />
              </View>
            </Group>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Point({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.point}>
      <Text style={s.pointTitle}>{title}</Text>
      <Text style={s.hint}>{children}</Text>
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

  point: { gap: 2 },
  pointTitle: { ...type.strong, color: color.ink },

  divider: { backgroundColor: color.border, height: 1, marginVertical: space.xs },
});
