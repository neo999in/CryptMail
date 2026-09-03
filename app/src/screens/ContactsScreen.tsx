import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Contact, ContactTrust, trustSummary } from '../contacts/contacts';
import { useContacts } from '../contacts/useContacts';
import { displayName, initials, shortFingerprint } from '../lib/format';
import { color, font, radius, space, type } from '../theme';
import { Icon } from '../ui/Icon';
import { Avatar, Badge, BadgeTone, Banner, EmptyState, SecondaryButton } from '../ui/primitives';
import { BodyProps } from './HomeScreen';

/**
 * Contacts — the address book, and the trust dashboard behind it.
 *
 * **Only the people this device holds a key for.** `contacts/contacts.ts` builds
 * the wider book — the keyring merged with every address seen in the mail — and
 * this screen shows the half of it that can actually receive encrypted mail.
 *
 * That is a deliberate narrowing, and it was made after looking at a real
 * mailbox: seeded from seen senders alone, the list was eight `noreply@`
 * robots and two people. A dashboard whose subject is *trust* has nothing to
 * say about an address that will never have a key, and burying the two rows
 * that carry a fingerprint among eight that never will is the opposite of
 * making the security model visible.
 *
 * The keyless half is not lost — it is where it is useful: Compose's
 * autocomplete still offers everyone, because addressing a message is a
 * different job from reviewing trust, and each suggestion is badged so "no key
 * yet" is stated at the moment it matters.
 *
 * It reads state and nothing else — no provider, no core, no store — and every
 * field on a row comes from a cleartext header or the keyring, so an unopened
 * encrypted mailbox produces the same list as a fully-read one.
 *
 * The ceremony itself still lives on Keys: comparing a safety number is a
 * deliberate, one-contact-at-a-time act, and a list is the wrong place for it.
 * This screen says who needs it and sends you there.
 *
 * Like every other drawer row it is a **destination body, not a route**
 * (`screens/HomeScreen.tsx`): the search box and the All/Verified/Unverified
 * control live in the bar above, mounted once and shared with the mail lists, so
 * reaching Contacts changes what is under the bar and nothing else. It is the
 * one destination that is not mail, which shows up in exactly two places — the
 * bar offers no refresh, and its strip carries this filter instead of the
 * Primary/Encrypted lens.
 */
export type ContactFilter = 'all' | 'verified' | 'unverified';

export const CONTACT_FILTERS: { key: ContactFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'verified', label: 'Verified' },
  { key: 'unverified', label: 'Unverified' },
];

/**
 * What each filter admits.
 *
 * `changed` sits under Unverified: it has a key, and it is emphatically not
 * trusted. There is no "no key" filter because there are no keyless rows here.
 */
const MATCHES: Record<ContactFilter, (trust: ContactTrust) => boolean> = {
  all: () => true,
  verified: (t) => t === 'verified',
  unverified: (t) => t === 'seen' || t === 'changed',
};

export function ContactsBody({ navigation, query, contactFilter, clearSearch, showAllContacts }: BodyProps) {
  // The keyed half of the book. `useContacts` is shared with Compose, which
  // wants the whole of it — see the note at the top of this file.
  const everyone = useContacts();
  const contacts = useMemo(() => everyone.filter((c) => c.key), [everyone]);
  const insets = useSafeAreaInsets();
  const filter = contactFilter;

  const summary = useMemo(() => trustSummary(contacts), [contacts]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts.filter(
      (c) =>
        MATCHES[filter](c.trust) &&
        (q.length === 0 || c.email.includes(q) || (c.name ?? '').toLowerCase().includes(q)),
    );
  }, [contacts, filter, query]);

  const searching = query.trim().length > 0;

  return (
    <View style={s.screen}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={s.head}>
          {/* The headline. Said in words as well as counts — trust is never
              carried by colour alone anywhere in this app. */}
          <Text style={s.summary}>
            {summary.total} {summary.total === 1 ? 'contact' : 'contacts'} with a key · {summary.verified}{' '}
            verified · {summary.seen} trusted on first use
          </Text>

          {summary.changed > 0 ? (
            <View style={s.banner}>
              <Banner tone="warn" icon="alert">
                {summary.changed === 1
                  ? "One contact's key changed. CryptMail will not send to them until you compare the new safety number."
                  : `${summary.changed} contacts' keys changed. CryptMail will not send to them until you compare the new safety numbers.`}
              </Banner>
            </View>
          ) : null}

        </View>

        {shown.length === 0 ? (
          <View style={s.emptyWrap}>
            {searching ? (
              <EmptyState
                icon="search"
                title="Nothing matched"
                hint="Contacts with a key are searched by name and address."
                action={<SecondaryButton title="Clear search" icon="close" onPress={clearSearch} />}
              />
            ) : contacts.length === 0 ? (
              <EmptyState
                icon="users"
                title="Nobody has a key here yet"
                hint="Contacts appear once this device holds their public key — harvested from a message they sent, looked up in the directory, or pasted in on Keys."
              />
            ) : (
              <EmptyState
                icon="user"
                title="Nobody in this state"
                hint={EMPTY_HINT[filter]}
                action={<SecondaryButton title="Show all" icon="user" onPress={showAllContacts} />}
              />
            )}
          </View>
        ) : (
          <View style={s.list}>
            {shown.map((contact) => (
              <ContactRow
                key={contact.email}
                contact={contact}
                onWrite={() => navigation.navigate('Compose', { to: [contact.email] })}
                onReview={() => navigation.navigate('Keys')}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const EMPTY_HINT: Record<ContactFilter, string> = {
  all: '',
  verified: 'Verifying means comparing a safety number out of band — on Keys, one contact at a time.',
  unverified: 'Every contact here has had their key compared out of band.',
};

const BADGE: Record<ContactTrust, { tone: BadgeTone; icon?: 'lock' | 'alert' | 'clock'; label: string }> = {
  verified: { tone: 'enc', icon: 'lock', label: 'verified' },
  seen: { tone: 'plain', label: 'trusted on first use' },
  changed: { tone: 'warn', icon: 'alert', label: 'key changed' },
  none: { tone: 'plain', icon: 'clock', label: 'no key yet' },
};

/** `2026-06-06T…` → `6 Jun 2026`, or nothing at all for an absent date. */
const on = (iso: string | undefined): string | null =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;

function ContactRow({
  contact,
  onWrite,
  onReview,
}: {
  contact: Contact;
  onWrite: () => void;
  onReview: () => void;
}) {
  const name = displayName(contact.email, contact.name);
  const badge = BADGE[contact.trust];

  // The history, in the order it happened. A key with no first-seen date is one
  // that does not exist — the line then describes the correspondence instead.
  const facts: string[] = [];
  const first = on(contact.keyFirstSeen);
  if (first) facts.push(`key first seen ${first}`);
  if (contact.keySource) facts.push(`via ${contact.keySource}`);
  const verified = on(contact.verifiedAt);
  if (verified) facts.push(`compared ${verified}`);

  const traffic: string[] = [];
  if (contact.received > 0) traffic.push(`${contact.received} received`);
  if (contact.addressed > 0) traffic.push(`${contact.addressed} sent to`);

  const changed = on(contact.keyChangedAt);

  return (
    <View style={s.card}>
      <Pressable
        accessibilityHint="Starts a message to this contact"
        accessibilityLabel={`${name}, ${contact.email}, ${badge.label}`}
        accessibilityRole="button"
        onPress={onWrite}
        style={({ pressed }) => [s.rowMain, pressed && { backgroundColor: color.rowPress }]}
      >
        <View style={s.head2}>
          <Avatar seed={contact.email} label={initials(name)} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={s.name}>
              {name}
            </Text>
            <Text numberOfLines={1} style={s.email}>
              {contact.email}
            </Text>
          </View>
          <Badge tone={badge.tone} icon={badge.icon}>
            {badge.label}
          </Badge>
        </View>

        {contact.key ? <Text style={s.fingerprint}>{shortFingerprint(contact.key.fingerprint)}</Text> : null}
        {facts.length > 0 ? <Text style={s.meta}>{facts.join(' · ')}</Text> : null}
        {traffic.length > 0 ? <Text style={s.meta}>{traffic.join(' · ')}</Text> : null}
      </Pressable>

      {/*
        Whether the key ever changed, kept separate from the current badge and
        said even once the new key has been verified: `trust` moves on, and
        "this address has swapped fingerprints before" stays true. Written in
        the past tense when it is history and in the present when it is still
        blocking sends.
      */}
      {changed ? (
        <View style={[s.history, contact.trust === 'changed' && s.historyAlarm]}>
          <Icon
            name={contact.trust === 'changed' ? 'alert' : 'clock'}
            size={13}
            color={contact.trust === 'changed' ? color.coral : color.inkFaint}
          />
          <Text style={[s.historyText, contact.trust === 'changed' && { color: color.coralInk }]}>
            {contact.trust === 'changed'
              ? `Key changed ${changed}. Nothing will be sent to this address until you compare the new safety number.`
              : `Key changed ${changed}${
                  contact.previousFingerprint ? `, replacing ${shortFingerprint(contact.previousFingerprint)}` : ''
                }.`}
          </Text>
        </View>
      ) : null}

      {contact.trust === 'changed' || (contact.key && contact.trust === 'seen') ? (
        <View style={s.actions}>
          <SecondaryButton
            title={contact.trust === 'changed' ? 'Review in Keys' : 'Verify in Keys…'}
            icon={contact.trust === 'changed' ? 'alert' : 'check'}
            onPress={onReview}
            tone={contact.trust === 'changed' ? 'danger' : undefined}
          />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  head: { gap: space.md, paddingHorizontal: space.lg, paddingTop: space.sm },
  summary: { ...type.small, color: color.inkFaint },
  banner: { marginTop: -2 },
  filter: { marginBottom: space.sm },

  emptyWrap: { paddingHorizontal: space.lg, paddingTop: space.xl },
  list: { gap: 10, paddingHorizontal: space.lg },

  card: {
    backgroundColor: color.panel,
    borderColor: color.line,
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  rowMain: { gap: 4, padding: 13 },
  head2: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  name: { ...type.strong, color: color.ink },
  email: { ...type.meta, color: color.inkFaint, marginTop: 1 },
  fingerprint: { color: color.inkDim, fontFamily: font.mono, fontSize: 11.5, marginTop: 6 },
  meta: { ...type.small, color: color.inkFaint },

  history: {
    alignItems: 'flex-start',
    borderTopColor: color.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  historyAlarm: { backgroundColor: color.coralBg, borderTopColor: color.coralLine },
  historyText: { ...type.small, color: color.inkDim, flex: 1 },

  actions: { flexDirection: 'row', gap: 9, paddingBottom: 13, paddingHorizontal: 13 },
});
