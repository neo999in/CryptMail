/**
 * One mailbox: what it is called, what it is allowed to do, and what it has
 * left on this device.
 *
 * Everything here is scoped to a single account and stored on its registry ref
 * (`store/accountScope.ts`), so a setting written here applies to that mailbox
 * alone — a merged inbox honours each account's own sync window, and blocking
 * remote images on a work address leaves a personal one as it was.
 *
 * The three destructive controls at the bottom are deliberately three, not one.
 * "Clear decrypted content", "Reset" and "Remove" take progressively more, each
 * says exactly what goes and what stays, and none of them can be reached by an
 * accidental gesture the way removal used to be.
 */
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { initials, shortFingerprint } from '../lib/format';
import { RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { accountLabel, AvatarMode, settingsOf, SYNC_WINDOWS, SyncWindow } from '../store/accountScope';
import { PublishStatus } from '../store/publishStore';
import { color, space, type } from '../theme';
import { confirmDialog } from '../ui/dialog';
import { useToast } from '../ui/ToastContext';
import { Icon } from '../ui/Icon';
import {
  Avatar,
  Field,
  Group,
  GroupHeading,
  IconButton,
  Input,
  Radio,
  SettingsRow,
  Toggle,
  useFocus,
} from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Account'>;

/** How a publication state reads on a one-line row. `Keys` says the rest. */
const PUBLISH_LABEL: Record<PublishStatus, string> = {
  published: 'listed in the key directory',
  pending: 'awaiting directory confirmation',
  unpublished: 'not listed in the directory',
  declined: 'kept out of the directory',
};

/**
 * Short, because four of these sit side by side in fixed-width slots on a
 * phone. The sentence under them says what they mean.
 */
const SYNC_LABEL: Record<SyncWindow, string> = {
  '7': '7 days',
  '30': '30 days',
  '90': '90 days',
  all: 'All mail',
};

const AVATAR_MODES: AvatarMode[] = ['photo', 'initials'];

const AVATAR_LABEL: Record<AvatarMode, string> = {
  photo: 'Picture',
  initials: 'Initials',
};

export function AccountScreen({ navigation, route }: Props) {
  const {
    accounts,
    activeAccount,
    needsReauth,
    unified,
    searchIndex,
    drafts,
    scheduled,
    identity,
    recovery,
    publishStatus,
    addAccount,
    switchAccount,
    removeAccount,
    updateAccount,
    resetAccount,
    pauseAccount,
    resumeAccount,
    exportMailbox,
  } = useApp();
  const insets = useSafeAreaInsets();
  const nameFocus = useFocus();
  const { showToast } = useToast();

  const account = accounts.find((a) => a.id === route.params.id);
  // Draft state, so typing a name does not write the store — and re-sync the
  // rail's label — on every keystroke. Committed on blur.
  const [name, setName] = useState(() => settingsOf(account).displayName);
  /** True while the mbox is being fetched and written. */
  const [exporting, setExporting] = useState(false);

  // Removing this account pops the screen, and the pop is not instant: React
  // renders once more with the account already gone from `accounts`. Rendering
  // nothing is what that frame should be, not a crash.
  if (!account) return <View style={s.screen} />;

  const settings = settingsOf(account);
  const stale = needsReauth.includes(account.id);
  const active = account.id === activeAccount;
  const label = accountLabel(account);

  const commitName = () => {
    if (name.trim() === settings.displayName) return;
    void updateAccount(account.id, { displayName: name.trim() });
  };

  /**
   * The counts below come from `State`, which holds the **active** account's
   * stores. Showing them for another mailbox would mean loading its keyring and
   * index behind the user's back — so the screen says whose numbers these are
   * rather than quietly attributing one mailbox's cache to another.
   */
  const counts = active
    ? `${Object.keys(searchIndex).length} messages indexed · ${Object.keys(drafts).length} drafts · ${Object.keys(scheduled).length} queued`
    : 'Counted while this mailbox is in front';

  /**
   * Whether pausing this one would leave nothing fetching mail.
   *
   * The same test the service applies before refusing — kept here so the screen
   * can say so *before* the tap rather than reporting an error after it.
   * "Syncing" excludes a mailbox whose grant has died as well as a paused one:
   * both are unreadable, and neither is somewhere to step onto.
   */
  const lastSyncing =
    !settings.paused &&
    accounts.filter((a) => !settingsOf(a).paused && !needsReauth.includes(a.id)).length <= 1;

  /**
   * The export, and the one piece of screen state it needs.
   *
   * A file the user asked for either arrives or fails out loud: silence after a
   * tap that takes seconds of network is indistinguishable from a broken
   * button, so the row says it is working and a toast says how it ended.
   */
  const runExport = async () => {
    setExporting(true);
    try {
      const count = await exportMailbox(account.id);
      showToast({
        durationMs: 4000,
        icon: 'download',
        message:
          count === 0
            ? 'No mail loaded to export.'
            : `Exported ${count} ${count === 1 ? 'message' : 'messages'}.`,
      });
    } catch (e) {
      showToast({
        durationMs: 5000,
        icon: 'alert',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExporting(false);
    }
  };

  const confirmPause = () =>
    confirmDialog(
      `Stop syncing ${account.email}?`,
      'It stays connected and keeps its keys, drafts and decrypted mail on this device — it just stops fetching. Resume any time from this screen or the drawer.',
      [
        { label: 'Cancel' },
        { label: 'Stop syncing', onPress: () => void pauseAccount(account.id) },
      ],
    );

  const confirmClear = () =>
    confirmDialog(
      'Clear decrypted content?',
      'Deletes the searchable copy of mail this device has decrypted. Your keys, drafts and queued messages stay, and search works again over anything you open next.',
      [
        { label: 'Cancel' },
        { label: 'Clear', tone: 'destructive', onPress: () => void resetAccount(account.id, 'content') },
      ],
    );

  const confirmReset = () =>
    confirmDialog(
      `Reset ${account.email}?`,
      'Deletes this device’s cache of the mailbox — decrypted content, the spam filter it has learned, and any snoozes — then syncs again. Your keys, drafts and queued messages are untouched, and nothing on the server changes.',
      [
        { label: 'Cancel' },
        { label: 'Reset', tone: 'destructive', onPress: () => void resetAccount(account.id, 'all') },
      ],
    );

  const confirmRemove = () =>
    confirmDialog(
      `Remove ${account.email}?`,
      'This deletes its keyring, drafts and locally decrypted mail from this device. Nothing on the server is touched.',
      [
        { label: 'Cancel' },
        {
          label: 'Remove',
          tone: 'destructive',
          onPress: () => {
            void removeAccount(account.id);
            navigation.goBack();
          },
        },
      ],
    );

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => navigation.goBack()} size={40} />
        <Text numberOfLines={1} style={s.title}>
          {label}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.md }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={s.identity}>
          <Avatar
            label={initials(label)}
            mode={settings.avatar}
            photo={account.photo}
            seed={account.email}
            size={72}
          />
          {/* The title bar already carries the label; repeat the address here
              only when it is telling the reader something new. */}
          {label !== account.email ? <Text style={s.identityAddress}>{account.email}</Text> : null}
          <Text style={s.identityProvider}>
            {account.provider === 'gmail' ? 'Google' : account.provider}
            {stale ? ' · needs sign-in' : active ? (unified ? ' · sending from this mailbox' : ' · in front') : ''}
          </Text>
        </View>

        {stale ? (
          <Group>
            <SettingsRow
              icon="refresh"
              label="Sign in again"
              onPress={() => void addAccount()}
              value="This mailbox cannot sync until Google grants access again. Its keys and mail on this device are kept."
            />
          </Group>
        ) : !active ? (
          <Group>
            <SettingsRow
              icon="inbox"
              label="Put this mailbox in front"
              onPress={() => {
                // Same call the rail makes: leaving the merged view is part of
                // choosing one mailbox, and both land in a single sync.
                void switchAccount(account.id, { unified: false });
                navigation.goBack();
              }}
              value="Compose, send and decrypt as this account"
            />
          </Group>
        ) : null}

        <GroupHeading>Name and picture</GroupHeading>
        <Group>
          <View style={s.pad}>
            <Field focused={nameFocus.focused} label="DISPLAY NAME">
              <Input
                {...nameFocus.bind}
                onBlur={() => {
                  nameFocus.bind.onBlur();
                  commitName();
                }}
                onChangeText={setName}
                onSubmitEditing={commitName}
                placeholder={account.name ?? account.email}
                returnKeyType="done"
                value={name}
              />
            </Field>
            <Text style={s.hint}>
              What the drawer, the mail bar and this list call the mailbox. Leave it empty to use the name
              Google gives it. It is local to this device and never sent with your mail.
            </Text>
          </View>
        </Group>
        <Group>
          <View style={s.pad}>
            <Text style={s.choiceLabel}>Show as</Text>
            {/* A row of slots, not a stack: `Radio` draws its label *above* its
                ring (`ui/primitives.tsx`), which is the shape the Appearance
                screen's theme and density pickers already use. Stacking them
                vertically repeats that column down the screen and reads as a
                list of headings. */}
            <View style={s.radios}>
              {AVATAR_MODES.map((mode) => (
                <View key={mode} style={s.radioSlot}>
                  <Radio
                    label={AVATAR_LABEL[mode]}
                    onPress={() => void updateAccount(account.id, { avatar: mode })}
                    selected={settings.avatar === mode}
                  />
                </View>
              ))}
            </View>
          </View>
        </Group>

        <GroupHeading>Keys</GroupHeading>
        <Group>
          {active ? (
            <>
              {/* The keyring, the publication record and the recovery mark are
                  all per-account stores, but Keys and Recovery are reached from
                  Settings and silently describe whichever mailbox is in front.
                  This is where the mailbox itself says which key it sends with. */}
              <SettingsRow
                icon="key"
                label="Sending key"
                onPress={() => navigation.navigate('Keys')}
                value={
                  identity
                    ? `${shortFingerprint(identity.fingerprint)} · ${PUBLISH_LABEL[publishStatus()]}`
                    : 'No key on this device yet'
                }
              />
              <SettingsRow
                icon="shield"
                label="Recovery"
                onPress={() => navigation.navigate('Recovery')}
                value={
                  recovery.backedUpAt && recovery.fingerprint === identity?.fingerprint
                    ? `Backed up ${new Date(recovery.backedUpAt).toLocaleDateString()}`
                    : 'This key has never been backed up'
                }
              />
            </>
          ) : (
            // Not a lie by omission: `State` holds the active account's keyring
            // and publication record, and reading another mailbox's would mean
            // loading its stores behind the user's back. Switching is one tap
            // above.
            <View style={s.readout}>
              <Icon color={color.inkDim} name="key" size={21} />
              <View style={{ flex: 1 }}>
                <Text style={s.readoutLabel}>Sending key</Text>
                <Text style={s.readoutValue}>Shown while this mailbox is in front</Text>
              </View>
            </View>
          )}
        </Group>

        <GroupHeading>Privacy</GroupHeading>
        <Group>
          <SettingsRow
            icon="image"
            label="Block external images"
            onPress={() => void updateAccount(account.id, { blockRemoteImages: !settings.blockRemoteImages })}
            trailing={
              <Toggle
                label="Block external images"
                on={settings.blockRemoteImages}
                onChange={(next) => void updateAccount(account.id, { blockRemoteImages: next })}
              />
            }
            value={
              settings.blockRemoteImages
                ? 'Images in this mailbox render as placeholders and no request is made.'
                : 'A remote image tells its sender the message was opened, when, and from where.'
            }
          />
        </Group>

        <GroupHeading>Sync</GroupHeading>
        <Group>
          <View style={s.pad}>
            <Text style={s.choiceLabel}>Mail to sync</Text>
            <View style={s.radios}>
              {SYNC_WINDOWS.map((window) => (
                <View key={window} style={s.radioSlot}>
                  <Radio
                    label={SYNC_LABEL[window]}
                    onPress={() => void updateAccount(account.id, { syncWindow: window })}
                    selected={settings.syncWindow === window}
                  />
                </View>
              ))}
            </View>
            <Text style={s.hint}>
              A filter on what this mailbox lists, not a retention policy: nothing is deleted anywhere, and
              widening it brings older mail straight back.
            </Text>
          </View>
        </Group>

        <GroupHeading>Syncing</GroupHeading>
        <Group>
          {settings.paused ? (
            <SettingsRow
              icon="refresh"
              label="Resume syncing"
              onPress={() => void resumeAccount(account.id)}
              value="Paused. Its keys, drafts and mail on this device are all still here — resuming brings it back in front."
            />
          ) : lastSyncing ? (
            // Not a row that looks pressable and refuses. The reason is the
            // control: an app with nothing left to read is the connect screen,
            // and signing out is what that is for.
            <View style={s.readout}>
              <Icon color={color.inkFaint} name="refresh" size={21} />
              <View style={{ flex: 1 }}>
                <Text style={[s.readoutLabel, { color: color.inkDim }]}>Stop syncing</Text>
                <Text style={s.readoutValue}>
                  Unavailable: this is the only mailbox still syncing. Sign out instead of pausing it.
                </Text>
              </View>
            </View>
          ) : (
            <SettingsRow
              icon="refresh"
              label="Stop syncing"
              onPress={confirmPause}
              value="Keeps the mailbox and everything it owns on this device, and stops fetching its mail."
            />
          )}
        </Group>

        <GroupHeading>Storage</GroupHeading>
        <Group>
          {/* Not a `SettingsRow`: this one is a readout, and a row that looks
              pressable and does nothing is worse than a plain one. */}
          <View style={s.readout}>
            <Icon color={color.inkDim} name="file" size={21} />
            <View style={{ flex: 1 }}>
              <Text style={s.readoutLabel}>On this device</Text>
              <Text style={s.readoutValue}>{counts}</Text>
            </View>
          </View>
          <SettingsRow
            icon="search"
            label="Clear decrypted content"
            onPress={confirmClear}
            value="Empties the searchable copy of mail decrypted here"
          />
          <SettingsRow
            icon="refresh"
            label="Reset account"
            onPress={confirmReset}
            value="Clears this device's cache and syncs again. Keys and drafts stay."
          />
        </Group>

        <GroupHeading>Export</GroupHeading>
        <Group>
          <SettingsRow
            icon="download"
            label={exporting ? 'Exporting…' : 'Export as .mbox'}
            onPress={() => (active ? void runExport() : undefined)}
            value={
              active
                ? 'The mail this device has loaded, in the format Thunderbird and every other client reads. Encrypted messages export sealed — your key still opens them.'
                : 'Put this mailbox in front to export it'
            }
          />
        </Group>

        <GroupHeading>Disconnect</GroupHeading>
        <Group>
          <SettingsRow
            icon="trash"
            label="Remove account"
            onPress={confirmRemove}
            tint={color.coral}
            value="Deletes this mailbox's keys, drafts and decrypted mail from this device"
          />
        </Group>
      </ScrollView>
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

  identity: { alignItems: 'center', gap: space.sm, paddingBottom: space.lg, paddingTop: space.md },
  identityAddress: { ...type.heading, color: color.ink },
  identityProvider: { ...type.small, color: color.inkFaint },

  pad: { gap: space.sm, padding: space.md },
  readout: { alignItems: 'center', flexDirection: 'row', gap: space.md, padding: space.md },
  readoutLabel: { ...type.settingsRow, color: color.ink },
  readoutValue: { ...type.settingsValue, color: color.inkDim },
  choiceLabel: { ...type.section, color: color.inkDim, marginBottom: space.xs },
  radios: { flexDirection: 'row', justifyContent: 'center', paddingVertical: space.sm },
  // Equal fixed-width columns so every ring centres on the same rhythm — the
  // same measure the Appearance screen's pickers use.
  radioSlot: { alignItems: 'center', width: 84 },
  hint: { ...type.small, color: color.inkFaint },
});
