/**
 * Simple UI — keys.
 *
 * Not optional: Autocrypt is out of scope for the prototype
 * (prototype-plan.md), so without a paste-a-key surface an encrypted send can
 * never succeed. Show mine, take theirs, list what we have.
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { groupFingerprint } from '../../lib/format';
import { useApp } from '../../state/AppState';
import { color, radius, space, type } from '../../theme';
import {
  Badge,
  Callout,
  Card,
  Divider,
  EmptyState,
  Field,
  Input,
  Mono,
  PrimaryButton,
  SecondaryButton,
  useFocus,
} from '../../ui/primitives';

export function SimpleKeysScreen() {
  const { identity, keyring, importKey, forgetKey, markVerified } = useApp();

  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const pasteFocus = useFocus();

  const contacts = Object.values(keyring);

  async function copyMine() {
    if (!identity) return;
    await Clipboard.setStringAsync(identity.publicKeyArmored);
  }

  async function importPasted() {
    setBusy(true);
    setFailure(null);
    setAdded(null);
    try {
      const key = await importKey(pasted.trim());
      setPasted('');
      setAdded(key.email);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text style={styles.eyebrow}>Your key</Text>
      <Card style={{ marginTop: space.sm }}>
        {identity ? (
          <>
            <Mono style={styles.addr}>{identity.email}</Mono>
            <Divider />
            <Text style={styles.fpLabel}>Fingerprint</Text>
            <View style={styles.fp}>
              {groupFingerprint(identity.fingerprint).map((chunk, i) => (
                <Mono key={i} style={styles.fpChunk}>
                  {chunk}
                </Mono>
              ))}
            </View>
            <View style={{ marginTop: space.md }}>
              <SecondaryButton title="Copy my public key" icon="copy" onPress={() => void copyMine()} />
            </View>
          </>
        ) : (
          <Text style={styles.hint}>No identity yet.</Text>
        )}
      </Card>

      <Text style={[styles.eyebrow, { marginTop: space.xl }]}>Add a contact&apos;s key</Text>
      <Field label="Armored public key" focused={pasteFocus.focused} style={{ marginTop: space.sm }}>
        <Input
          {...pasteFocus.bind}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          onChangeText={setPasted}
          placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
          style={styles.pasteInput}
          value={pasted}
        />
      </Field>
      <View style={{ marginTop: space.sm }}>
        <PrimaryButton
          busy={busy}
          disabled={pasted.trim().length === 0 || busy}
          icon="plus"
          onPress={() => void importPasted()}
          title="Import key"
        />
      </View>

      {failure ? (
        <View style={{ marginTop: space.md }}>
          <Callout>{failure}</Callout>
        </View>
      ) : null}
      {added ? (
        <View style={{ marginTop: space.md }}>
          <Callout>Added {added}. You can now send them encrypted mail.</Callout>
        </View>
      ) : null}

      <Text style={[styles.eyebrow, { marginTop: space.xl }]}>Contacts</Text>
      {contacts.length === 0 ? (
        <View style={{ marginTop: space.md }}>
          <EmptyState
            icon="key"
            title="No contact keys yet"
            hint="Paste a key above to send that person encrypted mail."
          />
        </View>
      ) : (
        contacts.map((c) => (
          <Card key={c.email} style={{ marginTop: space.sm }}>
            <View style={styles.contactHead}>
              <Mono style={styles.contactAddr}>{c.email}</Mono>
              <Badge
                tone={c.trust === 'changed' ? 'warn' : c.trust === 'verified' ? 'enc' : 'plain'}
                icon={c.trust === 'changed' ? 'alert' : c.trust === 'verified' ? 'check' : 'lock'}
              >
                {c.trust === 'verified' ? 'Verified' : c.trust === 'changed' ? 'Key changed' : 'Seen'}
              </Badge>
            </View>
            <Mono style={styles.contactFp}>{c.fingerprint}</Mono>
            <View style={styles.contactActions}>
              {c.trust !== 'verified' ? (
                <SecondaryButton
                  title="Mark verified"
                  icon="check"
                  onPress={() => void markVerified(c.email)}
                />
              ) : null}
              <SecondaryButton
                title="Forget"
                icon="close"
                tone="danger"
                onPress={() => void forgetKey(c.email)}
              />
            </View>
          </Card>
        ))
      )}

      <View style={{ marginTop: space.lg }}>
        <Callout>
          Marking a key verified means you compared this fingerprint with its owner out of band — in
          person or over a call. Doing it without checking defeats the point.
        </Callout>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  addr: { ...type.meta, color: color.ink },
  body: { padding: space.lg, paddingBottom: space.xl * 2 },
  contactActions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  contactAddr: { ...type.meta, color: color.ink, flex: 1 },
  contactFp: { ...type.meta, color: color.inkFaint, fontSize: 10, marginTop: space.xs },
  contactHead: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
  eyebrow: { ...type.eyebrow, color: color.inkFaint },
  fp: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
  fpChunk: {
    ...type.meta,
    backgroundColor: color.chip,
    borderRadius: radius.xs,
    color: color.ink,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  fpLabel: { ...type.eyebrow, color: color.inkFaint, marginTop: space.sm },
  hint: { ...type.small, color: color.inkDim },
  pasteInput: { fontSize: 11, minHeight: 110, textAlignVertical: 'top' },
});
