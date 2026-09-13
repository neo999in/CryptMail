import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { countRemoteImages } from '../html/remoteImages';
import { saveAttachment } from '../lib/files';
import { displayName, initials, relativeTime } from '../lib/format';
import { Attachment } from '../mail/attachment';
import { buildReplyDraft, replyAllRecipients, replyRecipients, ReplyKind, ReplySource } from '../mail/reply';
import { RootStackParamList } from '../navigation';
import { EncryptionState, OpenedMessage, useApp } from '../state/AppState';
import { InboxItem } from '../state/types';
import { settingsOf } from '../store/accountScope';
import { groupIntoThreads } from '../threads/threads';
import { color, font, motion, radius, shadow, space, type } from '../theme';
import { AttachmentList } from '../ui/attachments';
import { useAccent, useAppearance } from '../ui/appearance';
import { useChrome, useKeepsBarBeneath } from '../ui/chrome';
import { ExpandingScreen } from '../ui/expand';
import { HtmlReader } from '../ui/HtmlReader';
import { Icon, IconName } from '../ui/Icon';
import { lockFor } from '../ui/lock';
import { Body, LinkSheet } from '../ui/messageBody';
import { CardBar, PlainBanner, StatusBanner } from '../ui/messageChrome';
import { MailRowCard } from '../ui/mailRow';
import {
  Avatar,
  Banner,
  barIcon,
  EmptyState,
  IconButton,
  PressableRow,
  SecondaryButton,
  Sheet,
  Skeleton,
} from '../ui/primitives';
import { SnoozeModal } from '../ui/SnoozeModal';
import { LabelSheet } from '../ui/labelSheet';
import { labelNamesFor } from '../labels/labels';
import { useToast } from '../ui/ToastContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

/** What opening one message came back with, kept per message for the screen's life. */
type Loaded = { opened?: OpenedMessage; failure?: string };

/** Past this many messages, the middle of the thread folds into one row. */
const FOLD_AFTER = 4;

/**
 * How a message moving to make room for another one opening moves. Reanimated
 * skips layout animations under reduced motion by default, which is the gate a
 * discrete transition answers to (Design.md §7).
 */
const SHIFT = LinearTransition.duration(motion.base);

/**
 * A conversation — the reader's page, holding a thread instead of one mail.
 *
 * It *is* the message screen's page: it grows out of the inbox row it was
 * tapped from and collapses back onto it (`ui/expand.tsx`), under the same card
 * bar, the same trust banner, the same subject and sender block
 * (`ui/messageChrome.tsx`). What a thread adds is the messages, top to bottom:
 * older ones folded to who, when and how they start; the newest, and anything
 * unread, open with the body right there. Tapping a message's header opens or
 * folds it, and the messages around it move to make room rather than jumping.
 *
 * Every body comes from `openMessage`, the call the reader makes, so decryption,
 * the trust upgrade and the search index are one path — and opening one here
 * marks it read, as opening it there does. The reader is a tap away ("View full
 * message") for what a thread view does not carry: spam marking, snooze, and
 * the provider's ciphertext.
 */
export function ConversationScreen({ route, navigation }: Props) {
  const {
    messages,
    encryptionFor,
    searchIndex,
    openMessage,
    setUnread,
    toggleStar,
    snoozeMessage,
    unsnoozeMessage,
    archiveMessage,
    unarchiveMessage,
    trashMessage,
    restoreMessage,
    refreshInbox,
    accounts,
    activeAccount,
    identity,
    session,
    labels,
  } = useApp();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const { rowPadding } = useAppearance();
  const { setOverlay } = useChrome();
  const accent = useAccent();
  // The inbox's aurora bar is still on screen above this, so it keeps running.
  useKeepsBarBeneath(!!route.params.topInset);
  const [menuOpen, setMenuOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  /**
   * Where the page's own ground starts — the reader's arrangement exactly: the
   * card bar and the banner under it stand on the aurora band the inbox is still
   * drawing, and the black starts at the subject. Clamped to the band, since
   * past it is a live inbox row. Zero until both are laid out, which paints from
   * the top as before.
   */
  const [cardbarHeight, setCardbarHeight] = useState(0);
  const [subjectTop, setSubjectTop] = useState(0);
  const band = route.params.bandInset ?? 0;
  const revealTop =
    band > 0 && cardbarHeight > 0 && subjectTop > 0 ? Math.min(band, cardbarHeight + SCROLL_LEAD + subjectTop) : 0;
  const bodyWidth = useWindowDimensions().width - GUTTER * 2;
  // The active account's image policy — see the note on `allowRemoteImages` in
  // the reader. The same standing answer, overridable per message below.
  const blockImages = settingsOf(accounts.find((a) => a.id === activeAccount)).blockRemoteImages;
  const self = identity?.email ?? session?.email ?? '';

  const thread = useMemo(
    () => groupIntoThreads(messages).find((t) => t.id === route.params.threadId),
    [messages, route.params.threadId],
  );
  const list = useMemo(() => thread?.messages ?? [], [thread]);
  const stamps = useMemo(() => stampsFor(list.map((m) => m.date)), [list]);

  /** Which messages are open. `null` until the reader touches one: the default. */
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const openIds = useMemo(() => expanded ?? defaultOpen(list), [expanded, list]);
  const [showAll, setShowAll] = useState(false);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const inflight = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  /** Messages whose images the reader asked for — per message, never remembered. */
  const [imagesFor, setImagesFor] = useState<Set<string>>(() => new Set());
  const [tappedLink, setTappedLink] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  // Open each message the moment it is shown open, once.
  useEffect(() => {
    for (const m of list) {
      if (!openIds.has(m.id) || loaded[m.id] || inflight.current.has(m.id)) continue;
      inflight.current.add(m.id);
      openMessage(m)
        .then(
          (opened) => {
            if (!mounted.current) return;
            setLoaded((prev) => ({ ...prev, [m.id]: { opened } }));
            if (m.unread) void setUnread(m.id, false);
          },
          (e) => {
            if (mounted.current) {
              setLoaded((prev) => ({ ...prev, [m.id]: { failure: e instanceof Error ? e.message : String(e) } }));
            }
          },
        )
        .finally(() => inflight.current.delete(m.id));
    }
  }, [list, loaded, openIds, openMessage, setUnread]);

  const toggle = (id: string) =>
    setExpanded(() => {
      const next = new Set(openIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The newest message speaks for the thread: its trust banner heads the page,
  // and replies answer it.
  const last = list[list.length - 1];
  const lastOpened = last ? loaded[last.id]?.opened : undefined;
  const lastEncrypted = last ? encryptionFor(last).kind === 'encrypted' : false;
  const headLock = lockFor(lastOpened?.encryption ?? (last ? encryptionFor(last) : { kind: 'plain' }));

  // From what was decrypted into memory — never a re-fetch. Plain or encrypted:
  // a reply to someone with no key is held and invited by the send path, never
  // downgraded here (rule 1).
  const replySource: ReplySource | null =
    last && lastOpened && !lastOpened.error
      ? {
          from: last.from,
          to: last.to,
          date: last.date,
          subject: lastOpened.subject,
          body: lastOpened.body,
          messageId: last.messageId,
          references: last.references,
          attachments: lastOpened.attachments,
        }
      : null;
  const showReplyAll =
    !!replySource && replyAllRecipients(replySource, self).length > replyRecipients(replySource, self).length;

  const composeReply = (kind: ReplyKind) => {
    if (!replySource) return;
    const d = buildReplyDraft(kind, replySource, self);
    navigation.navigate('Compose', {
      to: d.to,
      subject: d.subject,
      quotedBody: d.quotedBody,
      inReplyTo: d.inReplyTo,
      references: d.references,
      attachments: d.attachments,
    });
  };

  /** Archive or delete the whole conversation, with the way back on the toast. */
  const moveAll = (
    work: (id: string) => Promise<unknown>,
    undo: (id: string) => Promise<unknown>,
    done: string,
    failed: string,
    icon: IconName,
  ) => {
    const ids = list.map((m) => m.id);
    navigation.goBack();
    Promise.all(ids.map(work)).then(
      () =>
        showToast({
          message: done,
          icon,
          durationMs: 5000,
          actionLabel: 'Undo',
          // The inbox only ever drops rows on a move, so it re-fetches to show
          // them again (`mail/flags.ts`).
          onAction: () => void Promise.all(ids.map(undo)).then(() => refreshInbox()),
        }),
      () => showToast({ message: failed, icon: 'alert', durationMs: 5000 }),
    );
  };

  /** Snooze the whole conversation, as the reader snoozes one message. */
  const snoozeAll = (until: string) => {
    const ids = list.map((m) => m.id);
    setSnoozeOpen(false);
    navigation.goBack();
    Promise.all(ids.map((id) => snoozeMessage(id, until))).then(
      () =>
        showToast({
          message: 'Snoozed conversation',
          icon: 'clock',
          durationMs: 5000,
          actionLabel: 'Undo',
          onAction: () => void Promise.all(ids.map(unsnoozeMessage)),
        }),
      () => showToast({ message: 'Couldn’t snooze that conversation', icon: 'alert', durationMs: 5000 }),
    );
  };

  const save = async (attachment: Attachment) => {
    setSaving(attachment.id);
    try {
      await saveAttachment(attachment);
    } catch (e) {
      showToast({
        message: `Couldn’t save ${attachment.name}: ${e instanceof Error ? e.message : String(e)}`,
        icon: 'alert',
        durationMs: 5000,
      });
    } finally {
      setSaving(null);
    }
  };

  const renderMessage = (m: InboxItem, i: number) => (
    <MessageBlock
      key={m.id}
      message={m}
      encryption={encryptionFor(m)}
      open={openIds.has(m.id)}
      stamp={stamps[i]}
      self={self}
      searchIndex={searchIndex}
      loaded={loaded[m.id]}
      headLabel={headLock.label}
      imagesAllowed={!blockImages || imagesFor.has(m.id)}
      bodyWidth={bodyWidth}
      savingId={saving}
      onToggle={() => toggle(m.id)}
      onLoadImages={() => setImagesFor((prev) => new Set(prev).add(m.id))}
      onLinkPress={setTappedLink}
      onSave={(a) => void save(a)}
      onOpenFull={() => navigation.navigate('Message', { id: m.id })}
    />
  );

  // Gmail's fold: first and last two stay, the middle becomes one row — unless
  // something in the middle is open, which is never hidden.
  const middle = list.slice(1, -2);
  const fold = !showAll && list.length > FOLD_AFTER && middle.every((m) => !openIds.has(m.id));

  return (
    <ExpandingScreen
      // The row this opened from, drawn again as the last frame of the close —
      // the inbox's own conversation row, thread-count chip and all.
      ghost={
        thread ? (
          <MailRowCard
            summary={thread.latest}
            encryption={encryptionFor(thread.latest)}
            count={thread.count}
            padding={rowPadding}
            selfAddress={session?.email}
            labels={labelNamesFor(
              labels,
              thread.messages.map((m) => m.id),
            )}
          />
        ) : undefined
      }
      navigation={navigation}
      onClosing={() => setOverlay('closing')}
      origin={route.params.origin}
      revealTop={revealTop}
      topInset={route.params.topInset}
    >
      <View style={s.screen}>
        {/* The ground starts where the header ends, as in the reader — above
            this line the inbox's band shows through. */}
        <View pointerEvents="none" style={[s.ground, { top: revealTop }]} />
        <CardBar
          onBack={() => navigation.goBack()}
          onHeight={setCardbarHeight}
          underBar={!!route.params.topInset}
          actions={
            thread && last ? (
              // The reader's four, in the reader's order. Archive files the
              // whole conversation; unread and star act on its newest message,
              // which is the one the inbox row stands for.
              <>
                <IconButton
                  {...barIcon}
                  icon="archive"
                  label="Archive conversation"
                  onPress={() =>
                    moveAll(
                      archiveMessage,
                      unarchiveMessage,
                      'Conversation archived',
                      'Couldn’t archive that conversation',
                      'archive',
                    )
                  }
                />
                <IconButton
                  {...barIcon}
                  icon="mail"
                  label="Mark unread"
                  onPress={() => {
                    void setUnread(last.id, true);
                    navigation.goBack();
                  }}
                />
                <IconButton
                  {...barIcon}
                  icon="star"
                  label={last.starred ? 'Starred' : 'Star'}
                  tint={last.starred ? accent : barIcon.tint}
                  fill={last.starred ? accent : undefined}
                  onPress={() => void toggleStar(last.id)}
                />
                {/* The reader's overflow, with its spacing — see `CardBar`'s
                    note on the dots' side bearing in `MessageScreen`. */}
                <View style={{ marginLeft: -4, marginRight: -2 }}>
                  <IconButton {...barIcon} icon="more" label="More" onPress={() => setMenuOpen(true)} />
                </View>
              </>
            ) : undefined
          }
        />

        {!thread ? (
          <EmptyState
            icon="mail"
            title="Conversation not available"
            hint="It is no longer in the list on this device."
            action={<SecondaryButton title="Back to inbox" icon="back" onPress={() => navigation.goBack()} />}
          />
        ) : (
          <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false} style={s.scroll}>
            {/* The page's head, as the reader draws it: the newest message's
                banner (from its headers until it has been opened), the subject,
                and under it what the thread is. */}
            {lastOpened ? <StatusBanner opened={lastOpened} /> : lastEncrypted ? null : <PlainBanner />}
            <Text
              accessibilityRole="header"
              onLayout={(e) => setSubjectTop(e.nativeEvent.layout.y)}
              style={s.subject}
            >
              {subjectOf(thread.latest.id, lastOpened?.subject, thread.latest.subject, encryptionFor(thread.latest), searchIndex)}
            </Text>
            <Text style={s.timestamp}>
              {list.length} messages · {participantsOf(list)}
            </Text>

            <View style={s.thread}>
              {fold ? (
                <>
                  {renderMessage(list[0], 0)}
                  <Animated.View exiting={FadeOut.duration(motion.fast)} layout={SHIFT}>
                    <MoreRow count={middle.length} onPress={() => setShowAll(true)} />
                  </Animated.View>
                  {list.slice(-2).map((m, k) => renderMessage(m, list.length - 2 + k))}
                </>
              ) : (
                list.map(renderMessage)
              )}
            </View>
          </ScrollView>
        )}

        {replySource ? (
          <View style={[s.replybar, { paddingBottom: insets.bottom + 14 }]}>
            <View style={s.replyButton}>
              <SecondaryButton title="Reply" icon="reply" onPress={() => composeReply('reply')} />
            </View>
            {showReplyAll ? (
              <View style={s.replyButton}>
                <SecondaryButton title="Reply all" icon="reply-all" onPress={() => composeReply('replyAll')} />
              </View>
            ) : null}
            <View style={s.replyButton}>
              <SecondaryButton title="Forward" icon="forward" onPress={() => composeReply('forward')} />
            </View>
          </View>
        ) : null}

        {/* The reader's overflow: what the bar could not hold, for the whole
            conversation. */}
        <Sheet bottomInset={insets.bottom} onClose={() => setMenuOpen(false)} title="More" visible={menuOpen}>
          <PressableRow
            accessibilityRole="button"
            onPress={() => {
              setMenuOpen(false);
              setSnoozeOpen(true);
            }}
            style={s.menuRow}
          >
            <Icon name="clock" size={18} color={color.inkDim} />
            <Text style={s.menuLabel}>Snooze conversation</Text>
          </PressableRow>
          {/* Every message in it, as a swipe or a bulk action takes the whole
              conversation — a label on only the newest would come off the row
              the moment someone replied. */}
          <PressableRow
            accessibilityRole="button"
            onPress={() => {
              setMenuOpen(false);
              setLabelsOpen(true);
            }}
            style={s.menuRow}
          >
            <Icon name="file" size={18} color={color.inkDim} />
            <Text style={s.menuLabel}>Label conversation</Text>
          </PressableRow>
          <PressableRow
            accessibilityRole="button"
            onPress={() => {
              setMenuOpen(false);
              moveAll(
                trashMessage,
                restoreMessage,
                'Conversation moved to Trash',
                'Couldn’t delete that conversation',
                'trash',
              );
            }}
            style={s.menuRow}
          >
            <Icon name="trash" size={18} color={color.coral} />
            <Text style={[s.menuLabel, { color: color.coral }]}>Delete conversation</Text>
          </PressableRow>
        </Sheet>
        <SnoozeModal visible={snoozeOpen} onSnooze={snoozeAll} onClose={() => setSnoozeOpen(false)} />
        <LabelSheet
          visible={labelsOpen}
          messageIds={list.map((m) => m.id)}
          onClose={() => setLabelsOpen(false)}
        />
        <LinkSheet url={tappedLink} onClose={() => setTappedLink(null)} />
      </View>
    </ExpandingScreen>
  );
}

/* -------------------------------------------------------------- message ---- */

/**
 * One message in the thread, folded or open.
 *
 * One component for both states, so opening a message is the same view growing
 * rather than one row swapped for another: its header stays put, the body fades
 * in under it, and `SHIFT` slides everything below down to make room — and back
 * up when it folds.
 *
 * Open, the header is the reader's sender block — name, address, the date —
 * with "To:" under it. Folded, the address gives way to how the message starts.
 */
function MessageBlock({
  message,
  encryption,
  open,
  stamp,
  self,
  searchIndex,
  loaded,
  headLabel,
  imagesAllowed,
  bodyWidth,
  savingId,
  onToggle,
  onLoadImages,
  onLinkPress,
  onSave,
  onOpenFull,
}: {
  message: InboxItem;
  encryption: EncryptionState;
  open: boolean;
  stamp: string;
  self: string;
  searchIndex: Record<string, { subject: string; body: string }>;
  loaded?: Loaded;
  /** The trust the page's banner already states — a message that matches it need not repeat it. */
  headLabel: string;
  imagesAllowed: boolean;
  bodyWidth: number;
  savingId: string | null;
  onToggle: () => void;
  onLoadImages: () => void;
  onLinkPress: (url: string) => void;
  onSave: (attachment: Attachment) => void;
  onOpenFull: () => void;
}) {
  const accent = useAccent();
  const name = displayName(message.from.address, message.from.name);
  const opened = loaded?.opened;
  // Opening upgrades trust with the signature, so once it has run its verdict wins.
  const lock = lockFor(opened?.encryption ?? encryption);
  const differs = lock.label !== headLabel;
  const locked = encryption.kind === 'encrypted' && !searchIndex[message.id];
  const blocked = useMemo(
    () => (imagesAllowed || !opened?.html ? 0 : countRemoteImages(opened.html)),
    [imagesAllowed, opened?.html],
  );

  return (
    <Animated.View layout={SHIFT} style={s.block}>
      <Pressable
        accessibilityLabel={`${name}, ${stamp}, ${lock.label}${message.unread ? ', unread' : ''}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => [s.head, pressed && s.pressed]}
      >
        {message.unread && !open ? <View style={[s.unreadDot, { backgroundColor: accent }]} /> : null}
        <Avatar seed={message.from.address} label={initials(name)} size={38} />
        <View style={s.main}>
          <View style={s.line}>
            <Text numberOfLines={1} style={[s.senderName, !open && !message.unread && s.senderNameFolded]}>
              {name}
            </Text>
            {/* Only where this message's trust is not the one the banner states. */}
            {differs ? <Icon name={lock.icon} size={13} color={lock.tint} /> : null}
            <Text style={[s.date, { color: message.unread && !open ? accent : color.inkFaint }]}>{stamp}</Text>
          </View>
          {open ? (
            <Text numberOfLines={1} style={s.senderAddress}>
              {message.from.address}
            </Text>
          ) : (
            <Text numberOfLines={1} style={[s.snippet, locked && s.snippetLocked]}>
              {previewOf(message.id, message.snippet, encryption, searchIndex)}
            </Text>
          )}
        </View>
      </Pressable>

      {open ? (
        <Animated.View
          entering={FadeIn.duration(motion.base)}
          exiting={FadeOut.duration(motion.fast)}
          style={s.bodyBox}
        >
          <Text numberOfLines={2} style={s.recipients}>
            <Text style={s.recipientsLabel}>To: </Text>
            {recipientsOf(message.to, self)}
          </Text>
          {differs ? (
            <View style={s.lockLine}>
              <Icon name={lock.icon} size={12} color={lock.tint} />
              <Text style={[s.lockText, { color: lock.tint }]}>{lock.label}</Text>
            </View>
          ) : null}

          {loaded?.failure ? (
            <Banner tone="warn" icon="alert">{loaded.failure}</Banner>
          ) : !opened ? (
            <View style={s.skeleton}>
              <Skeleton width="100%" height={12} />
              <Skeleton width="94%" height={12} />
              <Skeleton width="60%" height={12} />
            </View>
          ) : opened.error ? (
            <Banner tone="warn" icon="alert">{opened.error}</Banner>
          ) : (
            <Animated.View entering={FadeIn.duration(motion.base)} style={s.bodyContent}>
              {opened.html ? (
                <>
                  {blocked > 0 ? (
                    <PressableRow
                      accessibilityLabel={`Load ${blocked} blocked ${blocked === 1 ? 'image' : 'images'}. This tells the sender the message was opened.`}
                      accessibilityRole="button"
                      onPress={onLoadImages}
                      style={s.imageStrip}
                    >
                      <Icon color={color.inkDim} name="image" size={16} />
                      <Text style={s.imageStripText}>
                        {blocked} {blocked === 1 ? 'image' : 'images'} not loaded
                      </Text>
                      <Text style={[s.imageStripAction, { color: accent }]}>Load</Text>
                    </PressableRow>
                  ) : null}
                  <HtmlReader
                    allowRemoteImages={imagesAllowed}
                    contentWidth={bodyWidth}
                    html={opened.html}
                    onLinkPress={onLinkPress}
                  />
                </>
              ) : (
                <Body text={opened.body} onLinkPress={onLinkPress} />
              )}
              <AttachmentList
                attachments={opened.attachments}
                decrypted={opened.encryption.kind === 'encrypted'}
                onSave={onSave}
                busyId={savingId}
              />
            </Animated.View>
          )}

          <Pressable accessibilityRole="button" hitSlop={8} onPress={onOpenFull} style={s.fullLink}>
            <Text style={s.fullLinkText}>View full message</Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/** The folded middle of a long thread. */
function MoreRow({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <PressableRow
      accessibilityLabel={`Show ${count} older messages`}
      accessibilityRole="button"
      onPress={onPress}
      style={s.more}
    >
      <View style={s.moreBadge}>
        <Text style={s.moreBadgeText}>{count}</Text>
      </View>
      <Text style={s.moreText}>{count === 1 ? '1 older message' : `${count} older messages`}</Text>
    </PressableRow>
  );
}

/* -------------------------------------------------------------- helpers ---- */

/** The newest message and anything unread start open — what a reader came for. */
function defaultOpen(list: InboxItem[]): Set<string> {
  const ids = new Set(list.filter((m) => m.unread).map((m) => m.id));
  const last = list[list.length - 1];
  if (last) ids.add(last.id);
  return ids;
}

/** The thread's title: decrypted if we have it, else honest fallbacks. */
function subjectOf(
  id: string,
  openedSubject: string | undefined,
  headerSubject: string,
  encryption: EncryptionState,
  searchIndex: Record<string, { subject: string }>,
): string {
  if (openedSubject) return openedSubject;
  const indexed = searchIndex[id];
  if (indexed?.subject) return indexed.subject;
  if (encryption.kind === 'plain') return headerSubject || '(no subject)';
  return 'Encrypted conversation';
}

/** A preview: decrypted body first, then plaintext snippet, else a locked hint. */
function previewOf(
  id: string,
  snippet: string,
  encryption: EncryptionState,
  searchIndex: Record<string, { subject: string; body: string }>,
): string {
  const indexed = searchIndex[id];
  if (indexed) return firstLine(indexed.body) || indexed.subject || snippet;
  if (encryption.kind === 'plain') return snippet;
  return 'Contents decrypt on this device when you open it.';
}

/** Who is in the thread, in order of first appearance: two names, then a count. */
function participantsOf(messages: InboxItem[]): string {
  const names: string[] = [];
  for (const m of messages) {
    const name = displayName(m.from.address, m.from.name);
    if (!names.includes(name)) names.push(name);
  }
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/** "me", or who it went to — two names, then a count. */
function recipientsOf(to: string[], self: string): string {
  if (to.length === 0) return 'no recipients';
  const names = to.map((a) => (self && a.trim().toLowerCase() === self.trim().toLowerCase() ? 'me' : a));
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/**
 * Each message's date, with the time added wherever the date alone would repeat
 * — three messages reading "Sep 1" tell the reader nothing about their order.
 */
function stampsFor(dates: string[]): string[] {
  const labels = dates.map((d) => relativeTime(d));
  return dates.map((iso, i) => {
    const label = labels[i];
    const clash = labels.some((other, j) => j !== i && other === label);
    // Today's label is already a time.
    if (!clash || label.includes(':')) return label;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return label;
    return `${label}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  });
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0)?.slice(0, 140) ?? '';
}

/** The reader's gutter, so a thread's text lines up with a single mail's. */
const GUTTER = 16;
/** The gap between the card bar and the first thing under it — the reader's. */
const SCROLL_LEAD = 10;

const s = StyleSheet.create({
  // No fill of its own, as in the reader: the ground is a layer behind it.
  screen: { flex: 1 },
  ground: { backgroundColor: color.ground, bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  scroll: { flex: 1 },
  content: { paddingBottom: 28, paddingHorizontal: GUTTER, paddingTop: SCROLL_LEAD },

  menuRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },
  menuLabel: { ...type.settingsRow, color: color.ink },

  // The reader's head.
  subject: { ...type.display, color: color.ink, lineHeight: 28 },
  timestamp: { ...type.meta, color: color.inkFaint, marginTop: 6 },

  thread: { marginTop: space.md },
  block: { borderTopColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  head: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingVertical: 14 },
  pressed: { backgroundColor: color.rowPress },
  // In the gutter, beside the avatar: the inbox row's unread dot.
  unreadDot: { borderRadius: 4, height: 8, left: -12, marginTop: -4, position: 'absolute', top: '50%', width: 8 },

  main: { flex: 1, minWidth: 0 },
  line: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
  // The reader's sender block.
  senderName: { ...type.strong, color: color.ink, flex: 1 },
  senderNameFolded: { color: color.inkDim, fontFamily: font.sansMedium },
  senderAddress: { ...type.meta, color: color.inkFaint, marginTop: 2 },
  date: { ...type.meta },
  snippet: { ...type.small, color: color.inkFaint, marginTop: 2 },
  snippetLocked: { fontStyle: 'italic' },

  bodyBox: { gap: space.md, paddingBottom: space.lg },
  recipients: { ...type.meta, color: color.inkFaint },
  recipientsLabel: { color: color.inkDim, fontFamily: font.sansSemibold },
  lockLine: { alignItems: 'center', flexDirection: 'row', gap: space.xs },
  lockText: { ...type.small, fontFamily: font.sansMedium },
  skeleton: { gap: space.sm, marginTop: space.xs },
  bodyContent: { gap: space.md },
  // A note above the mail, not a warning: coral is trust vocabulary.
  imageStrip: {
    alignItems: 'center',
    backgroundColor: color.card,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  imageStripText: { ...type.small, color: color.inkDim, flex: 1 },
  imageStripAction: { ...type.small, fontFamily: font.sansSemibold },
  fullLink: { alignSelf: 'flex-start' },
  fullLinkText: { ...type.small, color: color.inkDim, fontFamily: font.sansSemibold, textDecorationLine: 'underline' },

  more: {
    alignItems: 'center',
    borderTopColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    paddingVertical: space.md,
  },
  moreBadge: {
    alignItems: 'center',
    borderColor: color.line,
    borderRadius: radius.pill,
    borderWidth: 1,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  moreBadgeText: { ...type.strong, color: color.inkDim },
  moreText: { ...type.small, color: color.inkDim, fontFamily: font.sansMedium },

  // The reader's pinned reply bar.
  replybar: {
    backgroundColor: color.surface,
    borderTopColor: color.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: GUTTER,
    paddingTop: 14,
    ...shadow.sheet,
  },
  replyButton: { flex: 1 },
});
