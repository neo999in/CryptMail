import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { displayName, groupFingerprint, initials } from '../lib/format';
import { ContactKey } from '../store/keyring';
import { useApp } from '../state/AppState';
import { color, font, glass, radius, type } from '../theme';
import {
  Avatar,
  Badge,
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
export function KeysScreen() {
  const { identity, keyring, importKey, forgetKey, markVerified } = useApp();
  const insets = useSafeAreaInsets();
  const [paste, setPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pasteFocus = useFocus();

  const contacts = Object.values(keyring).sort((a, b) => a.email.localeCompare(b.email));
  const unverified = contacts.filter((c) => c.trust !== 'verified').length;

  const copyMine = async () => {
    if (!identity) return;
    await Clipboard.setStringAsync(identity.publicKeyArmored);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  /** Key blocks arrive by clipboard almost every time — save the long-press. */
  const pasteFromClipboard = async () => {
    const text = await Clipboard.getStringAsync();
    if (text.trim()) {
      setPaste(text.trim());
      setError(null);
    }
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
          </>
        ) : (
          <Muted>No identity key yet.</Muted>
        )}
      </Card>

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
            onVerify={() => void markVerified(contact.email)}
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
  onVerify,
  onForget,
}: {
  contact: ContactKey;
  onVerify: () => void;
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
      <Text style={s.source}>via {contact.source}</Text>

      <View style={s.row}>
        {contact.trust !== 'verified' ? (
          <SecondaryButton title="They match — verify" icon="check" onPress={onVerify} />
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
