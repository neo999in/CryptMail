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
import { color, font, ON_ACCENT, radius, space, type } from '../theme';
import { Icon } from './Icon';
import { useAccent } from './appearance';
import { lockFor } from './lock';
import { Avatar } from './primitives';

/**
 * Memoised because a list entering multi-select re-renders every row to switch
 * its gesture and role, and only the row that was picked changes what it draws.
 * Redrawing the avatar and icons of every visible card for that was most of the
 * first selection's cost.
 */
export const MailRowCard = React.memo(MailRowCardImpl);

function MailRowCardImpl({
  summary,
  encryption,
  mailbox,
  count = 1,
  padding,
  selfAddress,
  labels,
  selected,
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
  /**
   * The local label names this row carries (`labels/labels.ts`).
   *
   * On the card rather than on the list's wrapper for the reason everything
   * else is: the closing transition's ghost draws this component, and a mail
   * that collapses onto a row missing its labels is a visible cut.
   */
  labels?: string[];
  /**
   * Whether this row is part of a multi-selection. The avatar becomes a check,
   * and the label says so — selection is never carried by colour alone.
   *
   * Never set on the ghost: a message is only ever opened from a list that is
   * not selecting.
   */
  selected?: boolean;
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
      {selected ? (
        <View accessibilityLabel="Selected" style={[s.check, { backgroundColor: accent }]}>
          <Icon name="check" size={22} color={ON_ACCENT} strokeWidth={2.6} />
        </View>
      ) : (
        <Avatar seed={seed} label={initials(who)} size={44} />
      )}
      <View style={s.rowMain}>
        <View style={s.rowTop}>
          <Text numberOfLines={1} style={[s.from, summary.unread && s.fromUnread]}>
            {name}
          </Text>
          {/* The lock is furniture: it must be findable on every row without
              out-shouting the subject, so it sits beside the date at the size
              of the date, not as a captioned badge. */}
          <Icon name={lock.icon} size={13} color={lock.tint} />
          {/* Accent for unread only; a read row's date steps back with its text. */}
          <Text style={[s.time, { color: summary.unread ? accent : color.inkFaint }]} accessibilityLabel={lock.label}>
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
        {labels && labels.length > 0 ? (
          <View style={s.labels} accessibilityLabel={`Labels: ${labels.join(', ')}`}>
            {labels.slice(0, MAX_CHIPS).map((name) => (
              <View key={name} style={s.labelChip}>
                <Text numberOfLines={1} style={s.labelChipText}>
                  {name}
                </Text>
              </View>
            ))}
            {labels.length > MAX_CHIPS ? (
              <Text style={s.labelMore}>+{labels.length - MAX_CHIPS}</Text>
            ) : null}
          </View>
        ) : null}
        {mailbox ? (
          <Text numberOfLines={1} style={s.mailbox} accessibilityLabel={`In ${mailbox}`}>
            {mailbox}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Chips drawn before the rest are counted — a row must stay one line tall there. */
const MAX_CHIPS = 3;
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
  threadChipText: { color: color.inkDim, fontFamily: font.sansSemibold, fontSize: 11 },  check: { alignItems: 'center', borderRadius: 22, height: 44, justifyContent: 'center', width: 44 },

  labels: { alignItems: 'center', flexDirection: 'row', flexWrap: 'nowrap', gap: 6, marginTop: 5, overflow: 'hidden' },
  labelChip: {
    borderColor: color.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    maxWidth: 120,
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  labelChipText: { color: color.inkDim, fontFamily: font.sansSemibold, fontSize: 11 },
  labelMore: { color: color.inkFaint, fontFamily: font.sansSemibold, fontSize: 11 },
});
