import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { displayName, groupFingerprint, initials } from '../lib/format';
import { back, RootStackParamList } from '../navigation';
import { ContactKey } from '../store/keyring';
import { needsBackup } from '../store/recoveryStore';
import { useApp } from '../state/AppState';
import { color, font, radius, space, type } from '../theme';
import { confirmDialog } from '../ui/dialog';
import { Icon } from '../ui/Icon';
import {
  Avatar,
  Badge,
  Banner,
  Callout,
  EmptyState,
  Field,
  Group,
  GroupHeading,
  IconButton,
  Input,
  PrimaryButton,
  SecondaryButton,
  SettingsRow,
  useFocus,
} from '../ui/primitives';
import { userMessage } from '../lib/errors';
import { KEY_DIRECTORY_ENABLED } from '../config';

/**
 * Keys — the prototype's replacement for the whole key directory: show mine,
 * paste theirs. Every imported key is trusted on first use (known debt), so the
 * fingerprint is shown prominently for out-of-band comparison.
 */
type Props = NativeStackScreenProps<RootStackParamList, 'Keys'>;

export function KeysScreen({ navigation }: Props) {
  const {
    identity,
    keyring,
    recovery,
    directoryName,
    verifyLink,
    publishStatus,
    publishOwnKey,
    declinePublish,
    importKey,
    forgetKey,
    markVerified,
    safetyNumberFor,
  } = useApp();
  const insets = useSafeAreaInsets();
  const [paste, setPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  /**
   * Kept apart from `error`, which belongs to the import/verify card further
   * down: a publish failure reported *there* reads as though pasting a key
   * failed, and on most screens it is below the fold — so the button would
   * simply stop spinning and nothing would appear to have happened.
   */
  const [publishError, setPublishError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const pasteFocus = useFocus();

  const published = publishStatus();

  const doPublish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      await publishOwnKey();
    } catch (e) {
      setPublishError(userMessage(e));
    } finally {
      setPublishing(false);
    }
  };

  /**
   * Open the directory's own confirmation link, found in this mailbox.
   *
   * Directly, with no "are you sure" — unlike a link in a message body, which
   * gets a confirmation sheet. The difference is what is known about it:
   * `keys/verifyLink.ts` has already established the sender, that the mail names
   * *this device's* fingerprint, and that the URL is a `/verify/` path on the
   * keyserver itself. That is more than a human squinting at a URL can check.
   */
  const openVerifyLink = async () => {
    if (!verifyLink) return;
    setPublishError(null);
    try {
      await Linking.openURL(verifyLink);
    } catch (e) {
      setPublishError(`Could not open the confirmation link: ${userMessage(e)}`);
    }
  };

  /** The contact currently mid-ceremony, and the digits being compared. */
  const [verifying, setVerifying] = useState<{ email: string; number: string } | null>(null);

  const startVerify = async (contact: ContactKey) => {
    setError(null);
    try {
      setVerifying({ email: contact.email, number: await safetyNumberFor(contact.email) });
    } catch (e) {
      setError(userMessage(e));
    }
  };

  const confirmVerify = async (contact: ContactKey) => {
    try {
      // The fingerprint as it was when the number on screen was derived. If the
      // key has changed since, AppState refuses rather than certifying the new one.
      await markVerified(contact.email, contact.fingerprint);
      setVerifying(null);
    } catch (e) {
      setError(userMessage(e));
      setVerifying(null);
    }
  };

  const contacts = Object.values(keyring).sort((a, b) => a.email.localeCompare(b.email));
  const unverified = contacts.filter((c) => c.trust !== 'verified').length;
  const backupMissing = needsBackup(recovery, identity?.fingerprint ?? null);

  const copyMine = async () => {
    if (!identity) return;
    await Clipboard.setStringAsync(identity.publicKeyArmored);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  /**
   * Key blocks arrive by clipboard almost every time — save the long-press.
   *
   * A read that comes back empty, or throws because the OS refused it, must say
   * so: silently doing nothing leaves the user tapping a button that looks
   * broken, with no way to tell a denied clipboard from an empty one.
   */
  const pasteFromClipboard = async () => {
    let text: string;
    try {
      text = await Clipboard.getStringAsync();
    } catch (e) {
      setError(`Could not read the clipboard: ${userMessage(e)}`);
      return;
    }

    if (!text.trim()) {
      setError('The clipboard is empty. Copy the key block first, then paste.');
      return;
    }

    setPaste(text.trim());
    setError(null);
  };

  const doImport = async () => {
    setError(null);
    try {
      const key = await importKey(paste);
      setPaste('');
      confirmDialog('Key imported', `${key.email}\n${groupFingerprint(key.fingerprint).join(' ')}`, [{ label: 'OK' }]);
    } catch (e) {
      setError(userMessage(e));
    }
  };

  const pasted = paste.trim().length > 0;

  return (
    <View style={s.screen}>
      <View style={[s.topbar, { paddingTop: insets.top + 6 }]}>
        <IconButton icon="back" label="Back" onPress={() => back(navigation)} size={40} />
        <Text style={s.title}>Keys</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl, paddingTop: space.sm }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <GroupHeading>Your key</GroupHeading>

        {/*
          Unprompted, because the user has no other way to learn it: the key
          is wrapped by the platform keystore, which has no backup path of
          its own. Someone who never opens this screen finds out only after
          the phone is gone, when nothing can be done about it.
        */}
        {identity && backupMissing ? (
          <View style={s.gutter}>
            <Banner tone="warn" icon="alert">
              This key has no backup. Lose this device and every message ever sent to it becomes
              unreadable — permanently.
            </Banner>
          </View>
        ) : null}

        <Group>
          {identity ? (
            <View style={s.pad}>
              <View style={s.ownHead}>
                <View style={s.ownGlyph}>
                  <Icon name="key" size={20} color={color.ink} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={s.ownAddress}>
                    {identity.email}
                  </Text>
                  <Text style={s.hint}>Share this with anyone who should be able to send you encrypted mail.</Text>
                </View>
              </View>

              <Text style={s.eyebrow}>Fingerprint</Text>
              <Inset>
                <View style={s.fpGrid}>
                  {groupFingerprint(identity.fingerprint).map((group, i) => (
                    <Text key={`${group}-${i}`} style={s.fpCell}>
                      {group}
                    </Text>
                  ))}
                </View>
              </Inset>

              <SecondaryButton
                title={copied ? 'Copied' : 'Copy public key'}
                icon={copied ? 'check' : 'copy'}
                onPress={() => void copyMine()}
              />
            </View>
          ) : (
            <View style={s.pad}>
              <Text style={s.hint}>No identity key on this device yet.</Text>
            </View>
          )}
          {identity ? (
            <SettingsRow
              icon="shield"
              label={backupMissing ? 'Back up this key' : 'Backup and recovery'}
              value={
                !backupMissing && recovery.backedUpAt
                  ? `Backed up ${new Date(recovery.backedUpAt).toLocaleDateString()}`
                  : 'Never backed up'
              }
              tint={backupMissing ? color.coral : undefined}
              onPress={() => navigation.navigate('Recovery')}
              trailing={<Icon name="chevron" size={18} color={color.inkFaint} />}
            />
          ) : null}
        </Group>

        {/*
          Publishing is asked for, never assumed. The listing is public — it tells
          anyone who looks that this address has a key — and it is also the only
          thing that lets a stranger's first message to this address be encrypted.
          Both halves of that are said out loud rather than one of them buried.
        */}
        {identity && !KEY_DIRECTORY_ENABLED ? (
          <>
            <GroupHeading>Key directory</GroupHeading>
            <Group>
              <View style={s.pad}>
                {/*
                  Said rather than hidden. Someone who has read that publishing
                  is what lets a stranger write to them encrypted will come
                  looking for it, and a section that silently vanished would
                  read as a bug — or worse, as a listing they already have.
                */}
                <Text style={s.body}>
                  This build does not use a key directory. It never asks a server which key belongs to an
                  address, and never lists yours.
                </Text>
                <Callout>
                  Keys reach this device by mail: when someone writes to you, their key travels with the
                  message. Someone who has never written to you cannot encrypt to you on their first try —
                  they get an invite, and their message waits until a key exists. Nothing is ever sent
                  unencrypted because of this.
                </Callout>
              </View>
            </Group>
          </>
        ) : null}

        {identity && KEY_DIRECTORY_ENABLED ? (
          <>
            <GroupHeading>Key directory</GroupHeading>
            <Group>
              <View style={s.pad}>
                {published === 'published' ? (
                  <>
                    <Banner tone="ok" icon="shield">
                      Listed on {directoryName}. Anyone can now write to you encrypted on their first try.
                    </Banner>
                    <Text style={s.body}>
                      What is listed is your address and your public key. Nothing about your messages, and
                      nobody you correspond with.
                    </Text>
                  </>
                ) : published === 'pending' ? (
                  <>
                    <Banner tone="warn" icon="clock">
                      Uploaded. {directoryName} has emailed you a confirmation link — until you open it,
                      your key is stored but not served to anyone.
                    </Banner>
                    {verifyLink ? (
                      <>
                        {/*
                          The link came out of this mailbox, and CryptMail checked that
                          it was sent by the keyserver, that it names this device's own
                          fingerprint, and that it points at a /verify/ path on
                          keys.openpgp.org — see keys/verifyLink.ts. Hence a button
                          rather than "go and find the email".
                        */}
                        <Text style={s.body}>
                          The confirmation email is here. CryptMail checked that {directoryName} sent it and
                          that it names this device&apos;s key.
                        </Text>
                        <PrimaryButton title="Open the confirmation link" icon="link" onPress={() => void openVerifyLink()} />
                      </>
                    ) : (
                      <Text style={s.body}>
                        CryptMail checks on each sync and will notice once the link has been opened, on this
                        device or any other. It also watches your recent inbox for the confirmation email —
                        if your provider filed it as spam, or it has scrolled out of the last twenty
                        messages, open the link from your mail app instead.
                      </Text>
                    )}
                    {publishError ? (
                      <Banner tone="warn" icon="alert">{publishError}</Banner>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Text style={s.body}>
                      Listing your public key is what lets someone send you encrypted mail the first time
                      they write, without asking you for anything first.
                    </Text>
                    <Callout>
                      The listing is public: anyone who tries your address learns that it has a key. Your
                      messages and your contacts are not part of it.
                    </Callout>
                    <PrimaryButton
                      title={`Publish to ${directoryName}`}
                      icon="shield"
                      busy={publishing}
                      onPress={() => void doPublish()}
                    />
                    {published === 'declined' ? null : (
                      <SecondaryButton title="Not now" onPress={() => void declinePublish()} />
                    )}
                    {publishError ? (
                      <Banner tone="warn" icon="alert">
                        {publishError} Your key is not listed; nothing was sent.
                      </Banner>
                    ) : null}
                  </>
                )}
              </View>
            </Group>
          </>
        ) : null}

        <GroupHeading>Add someone&apos;s key</GroupHeading>
        <Group>
          <View style={s.pad}>
            <Text style={s.hint}>
              Paste the armored public key block they sent you — exported from GnuPG, Proton Mail, or any
              OpenPGP tool.
            </Text>
            <Field
              label="Public key block"
              focused={pasteFocus.focused}
              tone={error ? 'warn' : 'default'}
              style={s.fieldFlush}
            >
              <Input
                autoCapitalize="none"
                autoCorrect={false}
                big
                multiline
                onChangeText={setPaste}
                placeholder={'-----BEGIN PGP PUBLIC KEY BLOCK-----'}
                style={s.pasteInput}
                value={paste}
                {...pasteFocus.bind}
              />
            </Field>
            {error ? <Callout>{error}</Callout> : null}
            <View style={s.importRow}>
              <View style={{ flex: 1 }}>
                <PrimaryButton title="Import key" icon="key" onPress={() => void doImport()} disabled={!pasted} />
              </View>
              <SecondaryButton
                title={pasted ? 'Clear' : 'Paste'}
                icon={pasted ? 'close' : 'copy'}
                onPress={() => (pasted ? setPaste('') : void pasteFromClipboard())}
              />
            </View>
          </View>
        </Group>

        <GroupHeading>
          {`Keyring · ${contacts.length}${unverified > 0 ? ` · ${unverified} unverified` : ''}`}
        </GroupHeading>

        <Group>
          {contacts.length === 0 ? (
            <EmptyState
              icon="key"
              title="No contact keys yet"
              hint="Without a key, CryptMail will not send to that address at all."
            />
          ) : (
            contacts.map((contact) => (
              <ContactRow
                key={contact.email}
                contact={contact}
                ceremony={verifying?.email === contact.email ? verifying.number : null}
                onStartVerify={() => void startVerify(contact)}
                onConfirm={() => void confirmVerify(contact)}
                onCancel={() => setVerifying(null)}
                onForget={() =>
                  confirmDialog('Forget key?', `Remove ${contact.email}'s key from this device?`, [
                    { label: 'Cancel' },
                    { label: 'Forget', tone: 'destructive', onPress: () => void forgetKey(contact.email) },
                  ])
                }
              />
            ))
          )}
        </Group>
      </ScrollView>
    </View>
  );
}

/** A recessed block for cryptographic text — a fingerprint, a safety number. */
function Inset({ children }: { children: React.ReactNode }) {
  return <View style={s.inset}>{children}</View>;
}

function ContactRow({
  contact,
  ceremony,
  onStartVerify,
  onConfirm,
  onCancel,
  onForget,
}: {
  contact: ContactKey;
  /** The safety number, once the user has asked to verify. */
  ceremony: string | null;
  onStartVerify: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onForget: () => void;
}) {
  const name = displayName(contact.email, contact.name);
  const badge =
    contact.trust === 'verified'
      ? { tone: 'enc' as const, icon: 'lock' as const, label: 'verified' }
      : contact.trust === 'changed'
        ? { tone: 'warn' as const, icon: 'alert' as const, label: 'key changed' }
        : { tone: 'plain' as const, label: 'trusted on first use' };

  return (
    <View style={s.contact}>
      <View style={s.contactHead}>
        <Avatar seed={contact.email} label={initials(name)} size={38} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={s.contactName}>
            {name}
          </Text>
          <Text numberOfLines={1} style={s.contactEmail}>
            {contact.email}
          </Text>
        </View>
        <Badge tone={badge.tone} icon={badge.icon}>
          {badge.label}
        </Badge>
      </View>

      <View style={s.contactBody}>
        <Text selectable style={s.fingerprint}>
          {groupFingerprint(contact.fingerprint).join(' ')}
        </Text>
        <Text style={s.source}>
          via {contact.source}
          {contact.verifiedAt ? ` · compared ${new Date(contact.verifiedAt).toLocaleDateString()}` : ''}
        </Text>

        {ceremony ? (
          <View style={s.ceremony}>
            <Text style={s.hint}>
              Read these digits to {name} over a channel you already trust — in person, or a call where
              you recognise their voice. They will see the same number.
            </Text>
            <Inset>
              <Text selectable style={s.safetyNumber}>
                {ceremony}
              </Text>
            </Inset>
            <View style={s.actions}>
              <View style={{ flex: 1 }}>
                <PrimaryButton title="They match" icon="check" onPress={onConfirm} />
              </View>
              <SecondaryButton title="Cancel" onPress={onCancel} />
            </View>
          </View>
        ) : (
          <View style={s.actions}>
            {contact.trust !== 'verified' ? (
              <SecondaryButton title="Verify…" icon="check" onPress={onStartVerify} />
            ) : null}
            <SecondaryButton title="Forget" icon="trash" onPress={onForget} tone="danger" />
          </View>
        )}
      </View>
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

  /** Something standing in the gutter between a heading and its group. */
  gutter: { marginBottom: space.md, marginHorizontal: space.lg },
  pad: { gap: space.md, padding: space.lg },

  body: { ...type.body, color: color.inkDim },
  hint: { ...type.small, color: color.inkDim },
  eyebrow: { ...type.eyebrow, color: color.inkFaint, marginBottom: -space.xs },

  ownHead: { alignItems: 'center', flexDirection: 'row', gap: space.md },
  ownGlyph: {
    alignItems: 'center',
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.lg,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  ownAddress: { ...type.heading, color: color.ink, marginBottom: 2 },

  inset: {
    backgroundColor: color.ground2,
    borderColor: color.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: space.sm,
    paddingVertical: space.md,
  },
  fpGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  fpCell: {
    color: color.ink,
    fontFamily: font.mono,
    fontSize: 14,
    letterSpacing: 1,
    paddingVertical: space.xs,
    textAlign: 'center',
    width: '25%',
  },

  ceremony: { gap: space.md, marginTop: space.xs },
  safetyNumber: {
    color: color.ink,
    fontFamily: font.mono,
    fontSize: 16,
    letterSpacing: 1.5,
    lineHeight: 26,
    textAlign: 'center',
  },

  actions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },

  // The field's own bottom margin is for a stack of fields; here the group's
  // gap already spaces it.
  fieldFlush: { marginBottom: 0 },
  pasteInput: { fontFamily: font.mono, fontSize: 11.5, minHeight: 96 },
  importRow: { alignItems: 'stretch', flexDirection: 'row', gap: space.sm },

  contact: { gap: space.md, padding: space.lg },
  contactHead: { alignItems: 'center', flexDirection: 'row', gap: space.md },
  // Indented to the text column, so the avatar stands alone on the left.
  contactBody: { gap: space.sm, marginLeft: 38 + space.md },
  contactName: { ...type.row, color: color.ink },
  contactEmail: { ...type.meta, color: color.inkFaint, marginTop: 2 },
  fingerprint: { ...type.meta, color: color.inkDim, lineHeight: 18 },
  source: { ...type.small, color: color.inkFaint, marginTop: -space.xs },
});
