/**
 * One mail, as every mailbox draws it.
 *
 * Lifted out of `InboxScreen` because other screens need the same pixels — the
 * inbox, Sent and Archive are one row (`ui/mailList.tsx`), and
 * closing a mail collapses it back onto a copy of the row it was tapped from
 * (`ui/expand.tsx`). That copy has to be the row — not a near-enough imitation
 * of it — or the last frame of the transition is a visible cut against the list
 * underneath. So this is the one definition, and the inbox row is this plus a
 * press target.
 *
 * Presentation only: no navigation, no state, no measuring. The list row wraps
 * it; the ghost renders it and never touches it.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { displayName, initials, relativeTime } from '../lib/format';
import { MailSummary } from '../mail/types';
import { EncryptionState } from '../state/AppState';
import { color, font, radius, space, type } from '../theme';
import { Icon } from './Icon';
import { useAccent } from './appearance';
import { lockFor } from './lock';
import { Avatar } from './primitives';

export function MailRowCard({
  summary,
  encryption,
  mailbox,
  count = 1,
  padding,
  selfAddress,
}: {
  summary: MailSummary;
  encryption: EncryptionState;
  /**
   * Which mailbox this row came from, shown only while the inbox is merged.
   *
   * A merged list without it is unreadable in the way that matters: the reply
   * it prompts goes out from whichever account is in front, and the reader has
   * no way to tell that is not the one the message arrived in.
   */
  mailbox?: string;
  /** Number of messages in this conversation; > 1 shows a thread-count chip. */
  count?: number;
  /** Vertical padding for the current density. */
  padding: number;
  /**
   * The active account's address, when the screen knows it.
   *
   * A message *you* sent is identified by who it went to — "from you" is the one
   * fact that carries no information. That is a property of the message, not of
   * the screen showing it, so the rule lives here: Sent, Archive and the closing
   * transition's ghost all reach the same answer without being told which list
   * they are, and a row cannot say `To …` in one place and your own name in the
   * other.
   */
  selfAddress?: string;
}) {
  const accent = useAccent();
  const lock = lockFor(encryption);
  const encrypted = encryption.kind === 'encrypted';
  const outgoing = isFrom(summary, selfAddress);
  // With several recipients the rest are counted rather than listed, so the row
  // does not wrap.
  const [first, ...rest] = summary.to;
  const who = outgoing
    ? first
      ? displayName(first)
      : 'No recipient'
    : displayName(summary.from.address, summary.from.name);
  const name = outgoing && first ? `To ${who}${rest.length > 0 ? ` +${rest.length}` : ''}` : who;
  const seed = outgoing ? (first ?? summary.from.address) : summary.from.address;

  return (
    <View style={[s.rowTap, { paddingVertical: padding }]}>
      {/* Part of the card, not of the list row that wraps it: the ghost the
          closing transition draws has to carry it too, or a mail collapses onto
          a row missing its dot. */}
      {summary.unread ? <View style={[s.unreadDot, { backgroundColor: accent }]} /> : null}
      <Avatar seed={seed} label={initials(who)} size={44} />
      <View style={s.rowMain}>
        <View style={s.rowTop}>
          <Text numberOfLines={1} style={[s.from, summary.unread && s.fromUnread]}>
            {name}
          </Text>
          {/* The lock is furniture: it must be findable on every row without
              out-shouting the subject, so it sits beside the date at the size
              of the date, not as a captioned badge. */}
          <Icon
            name={lock.icon}
            size={13}
            color={lock.tint}
            {...(lock.icon === 'lock' ? { fill: lock.tint } : {})}
          />
          <Text style={[s.time, { color: accent }]} accessibilityLabel={lock.label}>
            {relativeTime(summary.date)}
          </Text>
        </View>
        <View style={s.rowTop}>
          <Text numberOfLines={1} style={[s.subject, summary.unread && s.subjectUnread]}>
            {encrypted ? 'Encrypted message' : summary.subject}
          </Text>
          {count > 1 ? (
            <View style={s.threadChip} accessibilityLabel={`${count} messages in this conversation`}>
              <Text style={s.threadChipText}>{count}</Text>
            </View>
          ) : null}
        </View>
        {/* The stored snippet of an encrypted mail is ciphertext — showing it
            would be noise. Say what the row actually means instead. */}
        <Text numberOfLines={1} style={[s.snippet, encrypted && s.snippetLocked]}>
          {encrypted ? 'Contents decrypt on this device when you open it.' : summary.snippet}
        </Text>
        {mailbox ? (
          <Text numberOfLines={1} style={s.mailbox} accessibilityLabel={`In ${mailbox}`}>
            {mailbox}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Whether this message left the account currently in front. */
function isFrom(summary: MailSummary, address?: string): boolean {
  if (!address) return false;
  return summary.from.address.trim().toLowerCase() === address.trim().toLowerCase();
}

const s = StyleSheet.create({
  rowTap: { alignItems: 'flex-start', flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg },
  rowMain: { flex: 1, gap: 2 },
  rowTop: { alignItems: 'center', flexDirection: 'row', gap: space.sm },

  from: { ...type.row, color: color.inkDim, flex: 1 },
  fromUnread: { color: color.ink, fontFamily: font.sansBold },
  time: { ...type.date },
  subject: { ...type.rowSubject, color: color.inkDim, flex: 1 },
  subjectUnread: { color: color.ink, fontFamily: font.sansBold },
  snippet: { ...type.rowSub, color: color.inkFaint },
  snippetLocked: { fontFamily: font.sans, fontStyle: 'italic' },
  mailbox: { ...type.meta, color: color.inkFaint, marginTop: 3 },

  threadChip: { backgroundColor: color.surfaceRaised, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
  threadChipText: { color: color.inkDim, fontFamily: font.sansSemibold, fontSize: 11 },

  unreadDot: { borderRadius: 4, height: 8, left: 4, position: 'absolute', top: 26, width: 8 },
});
