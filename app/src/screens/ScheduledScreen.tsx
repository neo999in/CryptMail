import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Held, holdReason, listScheduled, stillPending } from '../outbox/outbox';
import { RootStackParamList } from '../navigation';
import { useApp } from '../state/AppState';
import { color, font, glass, radius, type } from '../theme';
import { EmptyState, SecondaryButton } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Scheduled'>;

/**
 * The outbox: everything written but not yet delivered. Two kinds live here —
 * messages scheduled for a time, and messages held because a recipient has no
 * key yet. The second kind has no send time at all, so the screen says what it
 * is actually waiting for rather than implying a clock is running.
 */
export function ScheduledScreen({ navigation }: Props) {
  const { scheduled, keyring, identity, sendScheduledNow, cancelScheduled, saveDraft } = useApp();
  const insets = useSafeAreaInsets();
  const items = listScheduled(scheduled);

  const cancelToDraft = async (item: Held) => {
    await saveDraft({
      id: item.id,
      to: item.to,
      subject: item.subject,
      body: item.body,
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
              <View style={s.actions}>
                <SecondaryButton title="Send now" icon="send" onPress={() => void sendScheduledNow(item.id)} />
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
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderColor: glass.hairline,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 4,
    paddingHorizontal: 13,
    paddingVertical: 13,
  },
  top: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  title: { ...type.strong, color: color.ink, flex: 1 },
  when: {
    backgroundColor: color.brassBg,
    borderColor: 'rgba(235,184,99,0.35)',
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  whenText: { color: color.brass, fontFamily: font.mono, fontSize: 10.5 },
  whenHeld: { backgroundColor: color.chip, borderColor: color.lineSoft },
  whenTextHeld: { color: color.inkDim },
  holdNote: { ...type.small, color: color.inkDim, marginTop: 6 },
  recipients: { color: color.inkDim, fontFamily: font.mono, fontSize: 11.5 },
  preview: { ...type.small, color: color.inkFaint, marginTop: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
});
