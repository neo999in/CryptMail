import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { displayName, groupFingerprint, initials } from '../lib/format';
import { RootStackParamList } from '../navigation';
import { ContactKey } from '../store/keyring';
import { needsBackup } from '../store/recoveryStore';
import { useApp } from '../state/AppState';
import { color, font, glass, radius, type } from '../theme';
import {
  Avatar,
  Badge,
  Banner,
  Callout,
  Card,
  EmptyState,
  Field,
  Input,
  Muted,
  PrimaryButton,
  SectionLabel,
  SecondaryButton,
  Title,
  useFocus,
} from '../ui/primitives';

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
      setPublishError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  };

  /** The contact currently mid-ceremony, and the digits being compared. */
  const [verifying, setVerifying] = useState<{ email: string; number: string } | null>(null);

  const startVerify = async (contact: ContactKey) => {
    setError(null);
    try {
      setVerifying({ email: contact.email, number: await safetyNumberFor(contact.email) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmVerify = async (contact: ContactKey) => {
    try {
      // The fingerprint as it was when the number on screen was derived. If the
      // key has changed since, AppState refuses rather than certifying the new one.
      await markVerified(contact.email, contact.fingerprint);
      setVerifying(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      setError(`Could not read the clipboard: ${e instanceof Error ? e.message : String(e)}`);
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
      Alert.alert('Key imported', `${key.email}\n${groupFingerprint(key.fingerprint).join(' ')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
      keyboardShouldPersistTaps="handled"
    >
      <Card>
        <Title>Your public key</Title>
        <Muted>Share this with anyone who should be able to send you encrypted mail.</Muted>

        {identity ? (
          <>
            <View style={s.fpGrid}>
              {groupFingerprint(identity.fingerprint).map((group, i) => (
                <Text key={`${group}-${i}`} style={s.fpCell}>
                  {group}
                </Text>
              ))}
            </View>
            <View style={s.row}>
              <SecondaryButton title={copied ? 'Copied' : 'Copy key'} icon={copied ? 'check' : 'copy'} onPress={() => void copyMine()} />
              <Text style={s.address}>{identity.email}</Text>
            </View>

            {/*
              Unprompted, because the user has no other way to learn it: the key
              is wrapped by the platform keystore, which has no backup path of
              its own. Someone who never opens this screen finds out only after
              the phone is gone, when nothing can be done about it.
            */}
            <View style={{ marginTop: 14 }}>
              {backupMissing || !recovery.backedUpAt ? (
                <Banner tone="warn" icon="alert">
                  This key has no backup. Lose this device and every message ever sent to it becomes
                  unreadable — permanently.
                </Banner>
              ) : (
                <Banner tone="ok" icon="shield">
                  Backed up {new Date(recovery.backedUpAt).toLocaleDateString()}.
                </Banner>
              )}
              <View style={s.row}>
                <SecondaryButton
                  title={backupMissing ? 'Back up this key…' : 'Backup and recovery…'}
                  icon="shield"
                  onPress={() => navigation.navigate('Recovery')}
                />
              </View>
            </View>
          </>
        ) : (
          <Muted>No identity key yet.</Muted>
        )}
      </Card>

      {/*
        Publishing is asked for, never assumed. The listing is public — it tells
        anyone who looks that this address has a key — and it is also the only
        thing that lets a stranger's first message to this address be encrypted.
        Both halves of that are said out loud rather than one of them buried.
      */}
      {identity ? (
        <Card style={{ marginTop: 14 }}>
          <Title>Publish your key</Title>
          {published === 'published' ? (
            <>
              <Banner tone="ok" icon="shield">
                Listed on {directoryName}. Anyone can now write to you encrypted on their first try.
              </Banner>
              <Muted>
                What is listed is your address and your public key. Nothing about your messages, and
                nobody you correspond with.
              </Muted>
            </>
          ) : published === 'pending' ? (
            <>
              <Banner tone="warn" icon="clock">
                Uploaded. {directoryName} has emailed you a confirmation link — until you open it,
                your key is stored but not served to anyone.
              </Banner>
              <Muted>
                CryptMail checks on each sync and will notice once the link has been opened, on this
                device or any other.
              </Muted>
            </>
          ) : (
            <>
              <Muted>
                Listing your public key is what lets someone send you encrypted mail the first time
                they write, without asking you for anything first.
              </Muted>
              <View style={{ marginTop: 10 }}>
                <Callout>
                  The listing is public: anyone who tries your address learns that it has a key. Your
                  messages and your contacts are not part of it.
                </Callout>
              </View>
              <View style={s.row}>
                <PrimaryButton
                  title={`Publish to ${directoryName}`}
                  icon="shield"
                  busy={publishing}
                  onPress={() => void doPublish()}
                />
                {published === 'declined' ? null : (
                  <SecondaryButton title="Not now" icon="close" onPress={() => void declinePublish()} />
                )}
              </View>
              {publishError ? (
                <View style={{ marginTop: 12 }}>
                  <Banner tone="warn" icon="alert">
                    {publishError} Your key is not listed; nothing was sent.
                  </Banner>
                </View>
              ) : null}
            </>
          )}
        </Card>
      ) : null}

      <Card style={{ marginTop: 14 }}>
        <Title>Add someone&apos;s key</Title>
        <Muted>Paste the armored public key block they sent you — exported from GnuPG, Proton Mail, or any OpenPGP tool.</Muted>
        <View style={{ height: 10 }} />
        <Field label="Public key block" focused={pasteFocus.focused} tone={error ? 'warn' : 'default'}>
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
        {error ? (
          <View style={{ marginBottom: 12 }}>
            <Callout>{error}</Callout>
          </View>
        ) : null}
        <View style={s.importRow}>
          <View style={{ flex: 1 }}>
            <PrimaryButton
              title="Import key"
              icon="key"
              onPress={() => void doImport()}
              disabled={paste.trim().length === 0}
            />
          </View>
          <SecondaryButton
            title={paste.trim().length > 0 ? 'Clear' : 'Paste'}
            icon={paste.trim().length > 0 ? 'close' : 'copy'}
            onPress={() => (paste.trim().length > 0 ? setPaste('') : void pasteFromClipboard())}
          />
        </View>
      </Card>

      <SectionLabel style={s.sectionHead}>
        Keyring · {contacts.length}
        {unverified > 0 ? ` · ${unverified} unverified` : ''}
      </SectionLabel>

      {contacts.length === 0 ? (
        <Card>
          <EmptyState
            icon="key"
            title="No contact keys yet"
            hint="Without a key, CryptMail will not send to that address at all."
          />
        </Card>
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
              Alert.alert('Forget key?', `Remove ${contact.email}'s key from this device?`, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Forget', style: 'destructive', onPress: () => void forgetKey(contact.email) },
              ])
            }
          />
        ))
      )}
    </ScrollView>
  );
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
    <Card style={{ marginBottom: 10 }}>
      <View style={s.contactHead}>
        <Avatar seed={contact.email} label={initials(name)} />
        <View style={{ flex: 1 }}>
          <Text style={s.contactName}>{name}</Text>
          <Text style={s.contactEmail}>{contact.email}</Text>
        </View>
        <Badge tone={badge.tone} icon={badge.icon}>
          {badge.label}
        </Badge>
      </View>

      <Text style={s.fingerprint}>{groupFingerprint(contact.fingerprint).join(' ')}</Text>
      <Text style={s.source}>
        via {contact.source}
        {contact.verifiedAt ? ` · compared ${new Date(contact.verifiedAt).toLocaleDateString()}` : ''}
      </Text>

      {ceremony ? (
        <View style={s.ceremony}>
          <Muted>
            Read these digits to {name} over a channel you already trust — in person, or a call where
            you recognise their voice. They will see the same number.
          </Muted>
          <Text style={s.safetyNumber}>{ceremony}</Text>
          <View style={s.row}>
            <PrimaryButton title="They match" icon="check" onPress={onConfirm} />
            <SecondaryButton title="Cancel" icon="close" onPress={onCancel} />
          </View>
        </View>
      ) : null}

      <View style={s.row}>
        {contact.trust !== 'verified' && !ceremony ? (
          <SecondaryButton title="Verify…" icon="check" onPress={onStartVerify} />
        ) : null}
        <SecondaryButton title="Forget" icon="close" onPress={onForget} tone="danger" />
      </View>
    </Card>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  fpGrid: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderColor: glass.hairline,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 14,
    paddingHorizontal: 8,
    paddingVertical: 15,
  },
  fpCell: {
    color: color.ink,
    fontFamily: font.mono,
    fontSize: 14,
    letterSpacing: 1,
    paddingVertical: 4,
    textAlign: 'center',
    width: '25%',
  },

  ceremony: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderColor: glass.hairline,
    borderRadius: radius.sm,
    borderWidth: 1,
    gap: 10,
    marginTop: 12,
    padding: 12,
  },
  safetyNumber: {
    color: color.ink,
    fontFamily: font.mono,
    fontSize: 16,
    letterSpacing: 1.5,
    lineHeight: 26,
    textAlign: 'center',
  },

  row: { alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 12 },
  address: { ...type.meta, color: color.inkFaint, flex: 1 },

  pasteInput: { fontFamily: font.mono, fontSize: 11.5, minHeight: 96 },
  importRow: { alignItems: 'stretch', flexDirection: 'row', gap: 9 },

  sectionHead: { marginBottom: 10, marginTop: 24 },

  contactHead: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  contactName: { ...type.strong, color: color.ink },
  contactEmail: { ...type.meta, color: color.inkFaint, marginTop: 1 },
  fingerprint: { color: color.inkDim, fontFamily: font.mono, fontSize: 11.5, lineHeight: 18, marginTop: 12 },
  source: { ...type.eyebrow, color: color.inkFaint, letterSpacing: 0.4, marginTop: 4, textTransform: 'none' },
});
