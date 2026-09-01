import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { describeCheck } from '../outbox/checkResult';
import { Held, holdReason, listScheduled, stillPending } from '../outbox/outbox';
import { RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { color, font, glass, radius, type } from '../theme';
import { Icon } from '../ui/Icon';
import { EmptyState, SecondaryButton } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Scheduled'>;

/**
 * The outbox: everything written but not yet delivered. Two kinds live here —
 * messages scheduled for a time, and messages held because a recipient has no
 * key yet. The second kind has no send time at all, so the screen says what it
 * is actually waiting for rather than implying a clock is running.
 */
export function ScheduledScreen({ navigation }: Props) {
  const { scheduled, keyring, identity, undiscoverable, sendScheduledNow, cancelScheduled, saveDraft } = useApp();
  const insets = useSafeAreaInsets();
  const items = listScheduled(scheduled);

  /** The id being tried right now, and what the last try said about it. */
  const [checking, setChecking] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ id: string; text: string; tone: 'ok' | 'warn' } | null>(null);

  /**
   * Try a queued message, and always say what happened.
   *
   * Three answers, and the third is the one that is easy to lose: `deliver`
   * *throws* when a recipient's key changed fingerprint, so without this catch,
   * tapping on a message whose recipient substituted their key would look
   * exactly like tapping on nothing.
   */
  const check = async (item: Held) => {
    setChecking(item.id);
    setOutcome(null);
    try {
      const result = await sendScheduledNow(item.id);
      if (result === null) {
        setOutcome({ id: item.id, tone: 'ok', text: 'This message has already left the outbox.' });
      } else if (result.status === 'sent') {
        setOutcome({ id: item.id, tone: 'ok', text: 'Encrypted and sent.' });
      } else {
        setOutcome({ id: item.id, tone: 'warn', text: describeCheck(result.pending, undiscoverable).text });
      }
    } catch (e) {
      setOutcome({ id: item.id, tone: 'warn', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(null);
    }
  };

  const cancelToDraft = async (item: Held) => {
    await saveDraft({
      id: item.id,
      to: item.to,
      subject: item.subject,
      body: item.body,
      attachments: item.attachments,
      updatedAt: new Date().toISOString(),
    });
    await cancelScheduled(item.id);
  };

  if (items.length === 0) {
    return (
      <View style={s.screen}>
        <EmptyState
          icon="clock"
          title="Nothing waiting"
          hint="Messages you schedule, and messages held for a recipient who has no key yet, wait here."
          action={<SecondaryButton title="New message" icon="plus" onPress={() => navigation.navigate('Compose', {})} />}
        />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 10 }}>
        {/*
          A message that went out is no longer in the list, so its own card
          cannot report the outcome — and "the row vanished" is a poor way to
          learn that a check succeeded.
        */}
        {outcome && !scheduled[outcome.id] ? (
          <Text style={[s.outcome, outcome.tone === 'ok' ? s.outcomeOk : s.outcomeWarn]}>{outcome.text}</Text>
        ) : null}
        {items.map((item) => {
          const awaitingKey = holdReason(item) === 'awaiting-key';
          const pending = awaitingKey ? stillPending(item, keyring, identity) : [];
          return (
            <View key={item.id} style={s.card}>
              <View style={s.top}>
                <Text numberOfLines={1} style={s.title}>
                  {item.subject.trim() || '(no subject)'}
                </Text>
                <View style={[s.when, awaitingKey && s.whenHeld]}>
                  <Text style={[s.whenText, awaitingKey && s.whenTextHeld]}>
                    {awaitingKey ? 'waiting for a key' : whenLabel(item.sendAt)}
                  </Text>
                </View>
              </View>
              <Text numberOfLines={1} style={s.recipients}>
                To: {item.to.length > 0 ? item.to.join(', ') : 'no recipients'}
              </Text>
              {item.attachments?.length ? (
                <View style={s.attached}>
                  <Icon name="paperclip" size={12} color={color.inkFaint} />
                  <Text style={s.attachedText}>
                    {item.attachments.length === 1
                      ? item.attachments[0].name
                      : `${item.attachments.length} files`}
                  </Text>
                </View>
              ) : null}
              {item.body.trim() ? (
                <Text numberOfLines={2} style={s.preview}>
                  {item.body.trim()}
                </Text>
              ) : null}
              {awaitingKey ? (
                <Text style={s.holdNote}>
                  {pending.length > 0
                    ? `Not delivered. ${pending.join(', ')} ${pending.length > 1 ? 'have' : 'has'} no key CryptMail can use yet — the message goes out by itself once ${pending.length > 1 ? 'they do' : 'they do'}.`
                    : 'A key has turned up. This sends on the next check.'}
                </Text>
              ) : null}
              {outcome?.id === item.id ? (
                <Text style={[s.outcome, outcome.tone === 'ok' ? s.outcomeOk : s.outcomeWarn]}>
                  {outcome.text}
                </Text>
              ) : null}
              <View style={s.actions}>
                {/*
                  An awaiting-key hold is not waiting on a clock, so "Send now"
                  promises something this button cannot do — the message goes out
                  when the recipient has a key and not before. What it actually
                  does is ask the directory again, and it says what came back.
                */}
                <SecondaryButton
                  title={checking === item.id ? 'Checking…' : awaitingKey ? 'Check for a key' : 'Send now'}
                  icon={awaitingKey ? 'refresh' : 'send'}
                  disabled={checking !== null}
                  onPress={() => void check(item)}
                />
                <SecondaryButton title="Cancel" icon="edit" onPress={() => void cancelToDraft(item)} />
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/* -------------------------------------------------------------- helpers ---- */

function whenLabel(sendAt: string): string {
  const d = new Date(sendAt);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },

  card: {
    backgroundColor: color.card,
    borderColor: color.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    gap: 4,
    paddingHorizontal: 13,
    paddingVertical: 13,
  },
  top: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  title: { ...type.strong, color: color.ink, flex: 1 },
  when: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.borderStrong,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  whenText: { color: color.inkDim, fontFamily: font.mono, fontSize: 10.5 },
  whenHeld: { backgroundColor: color.surface, borderColor: color.lineSoft },
  whenTextHeld: { color: color.inkDim },
  holdNote: { ...type.small, color: color.inkDim, marginTop: 6 },
  outcome: {
    ...type.small,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  outcomeOk: { backgroundColor: color.mintBg, borderColor: color.mintLine, color: color.mintInk },
  outcomeWarn: { backgroundColor: color.coralBg, borderColor: color.coralLine, color: color.coralInk },
  recipients: { color: color.inkDim, fontFamily: font.mono, fontSize: 11.5 },
  preview: { ...type.small, color: color.inkFaint, marginTop: 2 },
  attached: { alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 4 },
  attachedText: { color: color.inkFaint, fontFamily: font.mono, fontSize: 11 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
});
