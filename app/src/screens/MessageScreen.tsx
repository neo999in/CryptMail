import { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import { MotiView } from 'moti';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { categorizeMessage, providerFiledAsJunk, verdictFor } from '../categorizer/categorizer';
import { displayName, fullTimestamp, initials, shortFingerprint } from '../lib/format';
import { saveAttachment } from '../lib/files';
import { Attachment } from '../mail/attachment';
import { buildReplyDraft, replyAllRecipients, replyRecipients, ReplyKind, ReplySource } from '../mail/reply';
import { RootStackParamList } from '../navigation';
import { reasons, isUnwanted, SpamVerdict } from '../spam/spam';
import { OpenedMessage, useApp } from '../state/AppState';
import { SECONDARY_BOXES, SecondaryBox } from '../state/types';
import { settingsOf } from '../store/accountScope';
import { countRemoteImages } from '../html/remoteImages';
import { color, font, glass, radius, shadow, space, type } from '../theme';
import { AttachmentList } from '../ui/attachments';
import { useAccent, useAppearance } from '../ui/appearance';
import { HTML_BLOCK_MARGIN, HtmlReader } from '../ui/HtmlReader';
import { Body, bodyTextStyle, LinkSheet } from '../ui/messageBody';
import { CardBar, PlainBanner, StatusBanner } from '../ui/messageChrome';
import { DecryptedText, DecryptReveal } from '../ui/decryptedText';
import { useChrome, useKeepsBarBeneath } from '../ui/chrome';
import { ExpandingScreen } from '../ui/expand';
import { MailRowCard } from '../ui/mailRow';
import { Icon } from '../ui/Icon';
import {
  Avatar,
  barIcon,
  Banner,
  EmptyState,
  Glass,
  IconButton,
  PressableRow,
  Sheet,
  Skeleton,
  SecondaryButton,
} from '../ui/primitives';
import { SnoozeModal } from '../ui/SnoozeModal';
import { LabelSheet } from '../ui/labelSheet';
import { labelNamesFor } from '../labels/labels';
import { draftRuleFrom } from '../rules/rules';
import { useToast } from '../ui/ToastContext';
import { userMessage } from '../lib/errors';

type Props = NativeStackScreenProps<RootStackParamList, 'Message'>;

/** Reading — restored subject, trust chip, and the provider's view on demand. */
export function MessageScreen({ route, navigation }: Props) {
  const {
    messages,
    boxes,
    snoozed,
    openMessage,
    keyring,
    identity,
    session,
    toggleStar,
    archiveMessage,
    trashMessage,
    restoreMessage,
    setUnread,
    searchIndex,
    encryptionFor,
    spam,
    markSpam,
    markNotSpam,
    snoozeMessage,
    unsnoozeMessage,
    accounts,
    activeAccount,
    labels,
    exportMessage,
  } = useApp();
  const { showToast } = useToast();
  /** The mailbox this mail belongs to — see the `allowRemoteImages` note below. */
  const activeRef = accounts.find((a) => a.id === activeAccount);
  const insets = useSafeAreaInsets();
  // The reader wraps to the scroll view's padded box, not the whole window, or
  // wide content lays out past the right edge before it is clipped.
  const bodyWidth = useWindowDimensions().width - 32;
  const { rowPadding } = useAppearance();
  const accent = useAccent();
  const { setOverlay } = useChrome();
  // The inbox's aurora bar is still on screen above this mail, so it keeps
  // animating rather than freezing on the frame it was focused at.
  useKeepsBarBeneath(!!route.params.topInset);
  const [opened, setOpened] = useState<OpenedMessage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  /** The snooze picker, opened from the overflow. */
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  /** The label picker, opened from the overflow. */
  const [labelsOpen, setLabelsOpen] = useState(false);
  /** The link the reader tapped, waiting on them to confirm where it goes. */
  const [tappedLink, setTappedLink] = useState<string | null>(null);
  /**
   * Whether the reader has asked for this one message's images.
   *
   * Per message and per opening, never remembered: the account's setting is the
   * standing answer, and a "just this once" that quietly became permanent would
   * be a privacy control that decays. Reset below with the rest of the
   * per-message state when the id changes.
   */
  const [loadImages, setLoadImages] = useState(false);
  /**
   * Where the message's own ground starts.
   *
   * Everything above it — the card bar, and the trust banner under it — is left
   * unpainted so the aurora band the bar is still drawing shows through, which
   * is the whole reason `bandInset` is measured rather than assumed. Clamped to
   * it in both directions: past that line the inbox list is what is underneath,
   * and a transparent header over live rows is not a design, it is a bug. Zero
   * until the subject has been laid out, so the first frame is the flat ground
   * it has always been.
   */
  const [cardbarHeight, setCardbarHeight] = useState(0);
  const [subjectTop, setSubjectTop] = useState(0);
  const band = route.params.bandInset ?? 0;
  const revealTop =
    band > 0 && cardbarHeight > 0 && subjectTop > 0
      ? Math.min(band, cardbarHeight + SCROLL_LEAD + subjectTop)
      : 0;
  /** The overflow behind the toolbar's last button. */
  const [menuOpen, setMenuOpen] = useState(false);
  /** The attachment currently being written out, and any failure saving one. */
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * The row, and which list it came from.
   *
   * Any list that shows mail, not just the inbox: opening a message from Sent,
   * Archive or Trash lands here with an id the inbox has never seen. Which list
   * is worth keeping because one of them changes what this screen offers — a
   * message already in the trash is restored, not archived.
   */
  const { summary, fromBox } = useMemo(() => {
    const id = route.params.id;
    const inInbox = messages.find((m) => m.id === id);
    if (inInbox) return { summary: inInbox, fromBox: null as SecondaryBox | null };
    for (const box of SECONDARY_BOXES) {
      const row = boxes[box].items.find((m) => m.id === id);
      if (row) return { summary: row, fromBox: box as SecondaryBox | null };
    }
    // Opened from the Snoozed folder: a long snooze has usually scrolled out of
    // the loaded inbox, and the row it was drawn from is the snapshot taken when
    // it was snoozed (`snooze/snooze.ts`). It is still an inbox message.
    const snapshot = snoozed[id]?.summary;
    if (snapshot) return { summary: snapshot, fromBox: null as SecondaryBox | null };
    return { summary: undefined, fromBox: null as SecondaryBox | null };
  }, [boxes, messages, route.params.id, snoozed]);

  /**
   * Whether this message is already deleted.
   *
   * From the list it was opened from rather than from a label, so it holds for
   * any connector: `Trash` is a mailbox in `mail/types.ts`, and being in the one
   * the Trash destination lists is exactly what "deleted" means here.
   */
  const inTrash = fromBox === 'trash';

  /**
   * The filter's verdict for this message.
   *
   * Recomputed through `verdictFor` — the same function the inbox and the drawer
   * badges use — so the notice here cannot disagree with the category the row was
   * filed under. The one difference is `links`: once the message is open its
   * anchor `href`/label pairs exist, and a link whose text lies about its host is
   * evidence the inbox row never had.
   */
  const verdict = useMemo(() => {
    if (!summary) return null;
    return verdictFor(summary, encryptionFor(summary).kind === 'encrypted', searchIndex, {
      model: spam.model,
      marks: spam.marks,
      selfAddress: session?.email,
      links: opened?.links,
    });
  }, [encryptionFor, opened?.links, searchIndex, session?.email, spam, summary]);

  /**
   * Whether this message is currently filed under Spam — by the engine, by the
   * provider, or by the user's own mark.
   *
   * Through `categorizeMessage`, the same function the inbox row and the drawer
   * badge use, so the button below cannot offer *Mark as spam* on a message that
   * is already in Spam. That was the shape of a real dead end: a message the
   * provider flagged arrived with no mark of its own, so the only button on offer
   * was the one that agreed with it, and rescuing it meant marking it spam first.
   */
  const filedAsJunk = useMemo(
    () =>
      summary
        ? categorizeMessage(summary, encryptionFor(summary).kind === 'encrypted', searchIndex, {
            model: spam.model,
            marks: spam.marks,
            selfAddress: session?.email,
          }) === 'spam'
        : false,
    [encryptionFor, searchIndex, session?.email, spam, summary],
  );

  /**
   * Whether this message's remote images may be fetched, and how many are
   * being held back if not.
   *
   * The count is of the message's *own* markup, not of what the renderer drew,
   * so the strip can say a number before anything has been laid out. It is
   * distinct sources rather than tags: one spacer repeated down a newsletter is
   * one disclosure to one host (`html/remoteImages.ts`).
   */
  const imagesAllowed = !settingsOf(activeRef).blockRemoteImages || loadImages;
  const blockedImages = useMemo(
    () => (imagesAllowed || !opened?.html ? 0 : countRemoteImages(opened.html)),
    [imagesAllowed, opened?.html],
  );

  useEffect(() => {
    let cancelled = false;
    if (!summary) return;
    // A new message is a new decision. Without this, opening a blocked message
    // after loading one's images would fetch the next sender's pixels too.
    setLoadImages(false);
    (async () => {
      try {
        const result = await openMessage(summary);
        if (!cancelled) {
          setOpened(result);
          // Opening a message marks it read, like any mail client.
          if (summary.unread) void setUnread(summary.id, false);
        }
      } catch (e) {
        if (!cancelled) setFailure(userMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the id: re-opening on every keyring change would refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params.id]);


  if (!summary) {
    return (
      <ExpandingScreen
        navigation={navigation}
        onClosing={() => setOverlay('closing')}
        origin={route.params.origin}
        topInset={route.params.topInset}
      >
        <View style={s.screen}>
          <View style={s.ground} />
          <CardBar onBack={() => navigation.goBack()} underBar={!!route.params.topInset} />
          <EmptyState
            icon="mail"
            title="Message not available"
            hint="It is no longer in the list on this device."
            action={<SecondaryButton title="Back to inbox" icon="back" onPress={() => navigation.goBack()} />}
          />
        </View>
      </ExpandingScreen>
    );
  }

  const copyCipher = async () => {
    if (!opened) return;
    await Clipboard.setStringAsync(opened.raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  /**
   * Hand a file back to the user.
   *
   * This is the one point where decrypted content leaves the app, so it is
   * deliberately a tap the reader makes per file — nothing is written to disk
   * by opening a message. `lib/files.ts` says what "saving" means per platform.
   */
  const save = async (attachment: Attachment) => {
    setSaving(attachment.id);
    setSaveError(null);
    try {
      await saveAttachment(attachment);
    } catch (e) {
      setSaveError(userMessage(e));
    } finally {
      setSaving(null);
    }
  };

  const senderName = displayName(summary.from.address, summary.from.name);
  const key = keyring[summary.from.address];
  const own = opened?.encryption.kind === 'encrypted' && !!opened.encryption.own;
  /**
   * What the headers alone say - the same call the row made, no network and no
   * decryption, so it is true on the first frame.
   *
   * It is what lets the page draw itself while `openMessage` is still running:
   * everything the list already knew is real content, not a placeholder of it.
   * Only the two things that genuinely need the message body - an encrypted
   * subject, and the body itself - wait, and only those two are skeletons.
   */
  const headerEncrypted = encryptionFor(summary).kind === 'encrypted';

  // Reply/forward act on the decrypted message held in memory (`opened`), never
  // a re-fetch. Self is the same canonical address `resolveRecipientStates`
  // excludes, so a Reply-All never addresses you. Available for a readable
  // message — encrypted or plain; a plain reply simply has no key yet, which the
  // send path holds and invites, and is never a plaintext downgrade.
  const self = identity?.email ?? session?.email ?? '';
  const replySource: ReplySource | null =
    opened && !opened.error
      ? {
          from: summary.from,
          to: summary.to,
          date: summary.date,
          subject: opened.subject,
          body: opened.body,
          messageId: summary.messageId,
          references: summary.references,
          attachments: opened.attachments,
        }
      : null;
  // Reply-All only earns its own button when it would reach anyone Reply wouldn't.
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

  const handleSnooze = (until: string) => {
    if (!summary) return;
    const msgId = summary.id;
    void snoozeMessage(msgId, until);
    showToast({
      message: 'Snoozed message',
      actionLabel: 'Undo',
      onAction: () => {
        void unsnoozeMessage(msgId);
      },
      durationMs: 5000,
      icon: 'clock',
    });
    navigation.goBack();
  };

  return (
    <ExpandingScreen
      // The row this was opened from, drawn again as the last frame of the
      // close: the same `MailRowCard` the list draws, at the same density, so
      // the message shrinks back into its row rather than just leaving.
      ghost={
        <MailRowCard
          summary={summary}
          encryption={encryptionFor(summary)}
          padding={rowPadding}
          // So a mail opened from Sent collapses back onto the row it left —
          // one that leads with the recipient, not with you.
          selfAddress={session?.email}
          labels={labelNamesFor(labels, [summary.id])}
        />
      }
      navigation={navigation}
      // The bar underneath gets its title, tabs and filter back as the mail
      // starts collapsing, not when it finally unmounts: the list is on show
      // for the whole of that, and an empty bar over it reads as broken.
      onClosing={() => setOverlay('closing')}
      origin={route.params.origin}
      revealTop={revealTop}
      topInset={route.params.topInset}
    >
      <View style={s.screen}>
        {/* The ground, starting where the header ends rather than at the top of
            the screen: above this line the bar's band is still being drawn and
            is left to show through. Behind everything, so nothing above it has
            to know. */}
        <View pointerEvents="none" style={[s.ground, { top: revealTop }]} />
        <CardBar
          onBack={() => navigation.goBack()}
          onHeight={setCardbarHeight}
          underBar={!!route.params.topInset}
          actions={
            <>
              {/* The two that end the reading — both leave, so both go back to
                  the list themselves rather than sitting under a message the
                  list no longer shows.

                  On a deleted message the first of them is its opposite:
                  archiving something already in the trash says nothing, and
                  putting it back is the only move the reader wants from here. */}
              {inTrash ? (
                <IconButton
                  {...barIcon}
                  icon="inbox"
                  label="Restore"
                  onPress={() => {
                    void restoreMessage(summary.id);
                    navigation.goBack();
                  }}
                />
              ) : (
                <IconButton
                  {...barIcon}
                  icon="archive"
                  label="Archive"
                  onPress={() => {
                    void archiveMessage(summary.id);
                    navigation.goBack();
                  }}
                />
              )}
              <IconButton
                {...barIcon}
                icon="mail"
                label="Mark unread"
                onPress={() => {
                  void setUnread(summary.id, true);
                  navigation.goBack();
                }}
              />
              {/* Filled when it is on, not just recoloured. This is the one
                  button in the bar that holds a state rather than performing
                  an action, and an outline that changes colour is the same
                  mark twice — the label carries the difference for a reader
                  who cannot see it, but the glyph should say it too. The star
                  is a single closed path, so the fill lands inside the
                  outline instead of blobbing the way a multi-stroke icon
                  would. */}
              <IconButton
                {...barIcon}
                icon="star"
                label={summary.starred ? 'Starred' : 'Star'}
                tint={summary.starred ? accent : barIcon.tint}
                fill={summary.starred ? accent : undefined}
                onPress={() => void toggleStar(summary.id)}
              />
              {/* Same box as the rest, closed up 4 on the left and pulled 2
                  off the right edge.

                  This glyph is the odd one in the row: a 4-wide column of
                  dots inside a 21 glyph, so it carries about six more points
                  of nothing on each side than any other icon here. That leaves
                  the two ways of reading a button row disagreeing — the boxes
                  are on one 38-point rhythm, but the gap the eye sees between
                  the star and the dots is six wider than the two before it.
                  Neither extreme survives looking at it: shrink the box to the
                  dots and the ink evens out while the overflow lands visibly
                  nearer the star than the star is to the envelope; leave it
                  square and the row ends on a hole. Four is the split — the
                  gap comes in to about 24 against the others' 20, the centres
                  give up 4 of 38, and both errors are smaller than either one
                  alone. The right margin is set separately, and deliberately
                  short of the full six, so the bar does not end on a thin
                  column crowding the edge. */}
              <View style={{ marginLeft: -4, marginRight: -2 }}>
                <IconButton
                  {...barIcon}
                  icon="more"
                  label="More"
                  onPress={() => setMenuOpen(true)}
                />
              </View>
            </>
          }
        />
        <ScrollView
          // Tighter at the top than the sides: the message follows the card
          // bar, and 16 there stacked with the bar's own padding into a gap.
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: SCROLL_LEAD, paddingBottom: 28 }}
          style={s.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Drawn on the first frame, from the summary the list already had:
              the card that expands out of the row *is* the message, rather
              than a skeleton of it that fills in a moment later. Nothing here
              waits on `openMessage`. */}
          {opened ? <StatusBanner opened={opened} /> : headerEncrypted ? null : <PlainBanner />}
          {opened ? (
            <SpamNotice
              verdict={verdict}
              providerJunk={providerFiledAsJunk(summary.labels)}
              encrypted={opened.encryption.kind === 'encrypted'}
            />
          ) : null}

          {/* The one header that can be a placeholder: an encrypted subject is
              the placeholder one on the wire, and the real one only exists once
              the body has been decrypted. A plain subject is already known, so
              it is simply drawn. */}
          {opened && headerEncrypted ? (
            // The placeholder resolving into the subject it was hiding - the
            // one moment the reader can see decryption happen.
            <DecryptedText
              animate={!opened.error}
              onLayout={(e) => setSubjectTop(e.nativeEvent.layout.y)}
              style={s.subject}
              text={opened.subject}
            />
          ) : opened || !headerEncrypted ? (
            <Text onLayout={(e) => setSubjectTop(e.nativeEvent.layout.y)} style={s.subject}>
              {opened?.subject ?? summary.subject}
            </Text>
          ) : (
            <View
              onLayout={(e) => setSubjectTop(e.nativeEvent.layout.y)}
              style={{ marginBottom: 2, paddingVertical: 6 }}
            >
              <Skeleton width="72%" height={20} radius={radius.xs} />
            </View>
          )}
          <Text style={s.timestamp}>{fullTimestamp(summary.date)}</Text>

          <View style={s.sender}>
            <Avatar seed={summary.from.address} label={initials(senderName)} size={38} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={s.senderName}>
                {senderName}
              </Text>
              <Text numberOfLines={1} style={s.senderAddress}>
                {summary.from.address}
              </Text>
            </View>
          </View>

          {summary.to.length ? (
            <Text numberOfLines={2} style={s.recipients}>
              <Text style={s.recipientsLabel}>To: </Text>
              {summary.to.join(', ')}
            </Text>
          ) : null}

          {/* Which key this message was read with — so, only where there was
              one. On plain mail it said either "no key on this device", which
              is a fact about the sender and not about the letter the reader is
              looking at, or a fingerprint, which is worse: it reads as the key
              that protected this message when nothing protected it. The plain
              banner below already says what happened, and it says it in the
              one sentence that is true. Headers, not the opened message, so
              the line is either there from the first frame or never. */}
          {headerEncrypted ? (
            <View style={s.keyLine}>
              <Icon
                name={own || key ? 'key' : 'alert'}
                size={13}
                color={!own && key?.trust === 'changed' ? color.coral : !own && !key ? color.inkFaint : color.mint}
              />
              {own ? (
                <Text style={s.senderKey}>you - key {shortFingerprint(identity?.fingerprint ?? '')}</Text>
              ) : key ? (
                <Text style={[s.senderKey, key.trust === 'changed' && { color: color.coral }]}>
                  {key.trust} - key {shortFingerprint(key.fingerprint)}
                </Text>
              ) : (
                <Text style={[s.senderKey, { color: color.inkFaint }]}>no key on this device</Text>
              )}
            </View>
          ) : null}

          {failure ? <Banner tone="warn" icon="alert">{failure}</Banner> : null}

          {/* The body is the only part that is genuinely not here yet: it is a
              fetch, and for encrypted mail a decryption. It fades in on its own
              when it lands - one short reveal, not a staircase of them, because
              everything above it has been on screen since the card opened. */}
          {opened ? (
            <Reveal delay={0}>
              {opened.error ? (
                <View style={{ marginBottom: 14 }}>
                  <Banner tone="warn" icon="alert">{opened.error}</Banner>
                </View>
              ) : (
                <>
                  {/* Real mail is mostly HTML, and the plain-text alternative
                      a sender ships alongside it is usually a worse version of
                      the same message — a wall of bare URLs where the links
                      were. So the HTML is preferred when the message carries
                      it, sanitised in `html/sanitize.ts` before it reaches the
                      renderer, with the text part as the fallback. */}
                  {opened.html ? (
                    <>
                      {/* What was withheld, and the one control that loads it.
                          Without this the account setting is a switch people
                          turn on once and off again the first time they need
                          an image: the only alternative was Settings →
                          Accounts → the mailbox → toggle → back. */}
                      {blockedImages > 0 ? (
                        <PressableRow
                          accessibilityLabel={`Load ${blockedImages} blocked ${blockedImages === 1 ? 'image' : 'images'}. This tells the sender the message was opened.`}
                          accessibilityRole="button"
                          onPress={() => setLoadImages(true)}
                          style={s.imageStrip}
                        >
                          <Icon color={color.inkDim} name="image" size={16} />
                          <Text style={s.imageStripText}>
                            {blockedImages} {blockedImages === 1 ? 'image' : 'images'} not loaded
                          </Text>
                          <Text style={[s.imageStripAction, { color: accent }]}>Load</Text>
                        </PressableRow>
                      ) : null}
                      <DecryptReveal
                        animate={headerEncrypted}
                        paragraphMargin={HTML_BLOCK_MARGIN}
                        style={bodyTextStyle}
                        text={opened.body}
                      >
                        <HtmlReader
                          // Remote images load on open unless this mailbox says
                          // not to (features.md 0.8, and the Privacy control on
                          // `screens/AccountScreen.tsx`). The default is still
                          // "load", which is a real disclosure — a per-recipient
                          // image URL tells the sender the message was opened,
                          // when, and from where. What changed is that the choice
                          // is now the user's: standing, per account, and
                          // overridable for this one message by the strip above.
                          // Nothing else here phones anyone.
                          //
                          // The *active* account's setting, which is the right
                          // one: opening a merged-inbox row switches to the
                          // account that owns it first (`state/mailbox.ts`), so
                          // by the time this renders, the mail on screen belongs
                          // to that mailbox.
                          allowRemoteImages={imagesAllowed}
                          contentWidth={bodyWidth}
                          html={opened.html}
                          onLinkPress={setTappedLink}
                        />
                      </DecryptReveal>
                    </>
                  ) : (
                    <DecryptReveal animate={headerEncrypted} style={bodyTextStyle} text={opened.body}>
                      <Body text={opened.body} onLinkPress={setTappedLink} />
                    </DecryptReveal>
                  )}
                  <AttachmentList
                    attachments={opened.attachments}
                    decrypted={opened.encryption.kind === 'encrypted'}
                    onSave={(a) => void save(a)}
                    busyId={saving}
                  />
                  {saveError ? (
                    <View style={{ marginTop: 12 }}>
                      <Banner tone="warn" icon="alert">{saveError}</Banner>
                    </View>
                  ) : null}
                </>
              )}
            </Reveal>
          ) : failure ? null : (
            <View style={{ gap: 8, marginTop: 4 }}>
              <Skeleton width="100%" height={12} />
              <Skeleton width="94%" height={12} />
              <Skeleton width="60%" height={12} />
            </View>
          )}

          {opened && showRaw ? (
            <View style={[s.rawBlockOuter, s.rawBlock]}>
              <View style={s.rawHead}>
                <Icon name="mail" size={13} color={color.inkFaint} />
                <Text style={s.rawHeadText}>What Gmail / Outlook shows</Text>
                <Pressable
                  accessibilityLabel="Copy ciphertext"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => void copyCipher()}
                  style={({ pressed }) => [s.copyBtn, pressed && { backgroundColor: color.line }]}
                >
                  <Icon name={copied ? 'check' : 'copy'} size={12} color={copied ? color.mint : color.inkDim} />
                  <Text style={[s.copyText, copied && { color: color.mint }]}>{copied ? 'Copied' : 'Copy'}</Text>
                </Pressable>
              </View>
              <Text style={s.ghostSubject}>Subject: {summary.subject}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text style={s.cipher}>{truncate(opened.raw)}</Text>
              </ScrollView>
            </View>
          ) : null}
        </ScrollView>

        {/* Pinned quick actions, Gmail-style. Shown for any readable message —
            encrypted or plain. Replying to someone with no key is held and invited
            by the send path (rule 1), never quietly downgraded to plaintext here. */}
        {replySource ? (
          <View style={[s.replybar, s.replybarInner, { paddingBottom: insets.bottom + 14 }]}>
            <View style={s.replyActions}>
              <View style={{ flex: 1 }}>
                <SecondaryButton title="Reply" icon="reply" onPress={() => composeReply('reply')} />
              </View>
              {showReplyAll ? (
                <View style={{ flex: 1 }}>
                  <SecondaryButton title="Reply all" icon="reply-all" onPress={() => composeReply('replyAll')} />
                </View>
              ) : null}
              <View style={{ flex: 1 }}>
                <SecondaryButton title="Forward" icon="forward" onPress={() => composeReply('forward')} />
              </View>
            </View>
          </View>
        ) : null}

        {/* Everything the toolbar could not hold. The filing decision is here
            rather than in the bar because it is the one action on this screen
            that trains something and is worth a deliberate second tap; the
            provider view because it is a curiosity, not a task. */}
        <Sheet bottomInset={insets.bottom} onClose={() => setMenuOpen(false)} title="More" visible={menuOpen}>
          {/* Snoozing hides the row until a time the reader picks; it does not
              file the message anywhere, and nothing about it reaches the
              provider. It is here rather than in the toolbar because that row
              is spaced for the glyphs it already has, and because picking a
              time is a second tap regardless. */}
          <PressableRow
            accessibilityRole="button"
            onPress={() => {
              setMenuOpen(false);
              setSnoozeOpen(true);
            }}
            style={s.menuRow}
          >
            <Icon name="clock" size={18} color={color.inkDim} />
            <Text style={s.menuLabel}>Snooze</Text>
          </PressableRow>
          {/* Local labels — nothing here reaches the provider. The menu closes
              first so the picker is never a sheet stacked on a sheet. */}
          <PressableRow
            accessibilityRole="button"
            onPress={() => {
              setMenuOpen(false);
              setLabelsOpen(true);
            }}
            style={s.menuRow}
          >
            <Icon name="file" size={18} color={color.inkDim} />
            <Text style={s.menuLabel}>Labels</Text>
          </PressableRow>
          {/* Seeded from what this device can read of the message: always the
              sender, and the subject only once it has been decrypted here. */}
          <PressableRow
            accessibilityRole="button"
            onPress={() => {
              setMenuOpen(false);
              const seed = draftRuleFrom({ summary, encrypted: headerEncrypted }, searchIndex);
              navigation.navigate('RuleEdit', { from: seed.from, subject: seed.subject ?? undefined });
            }}
            style={s.menuRow}
          >
            <Icon name="settings" size={18} color={color.inkDim} />
            <Text style={s.menuLabel}>Create rule from this message</Text>
          </PressableRow>
          {/* One row, because the useful action is always the opposite of where
              the message is currently filed. It files the message and trains
              the personal model; it deliberately does not archive or delete —
              removing mail from the mailbox is a different action with a
              different button, and nothing here touches how the provider has
              filed the message on its own server. */}
          <PressableRow
            accessibilityRole="button"
            onPress={() => {
              setMenuOpen(false);
              void (filedAsJunk ? markNotSpam(summary.id) : markSpam(summary.id));
            }}
            style={s.menuRow}
          >
            <Icon
              name={filedAsJunk ? 'check' : 'junk'}
              size={18}
              color={filedAsJunk ? color.mint : color.coral}
            />
            <Text style={s.menuLabel}>{filedAsJunk ? 'Not spam' : 'Mark as spam'}</Text>
          </PressableRow>
          {/* Deleting is a move to the provider's trash, and it is worded as
              one: nothing here erases mail, and the message is in the Trash
              destination the moment this is tapped. It sits behind the overflow
              rather than in the toolbar because the toolbar's job is reading —
              and because a delete a thumb can reach by accident had better be
              two taps. Absent on a message already in the trash, where the bar
              offers Restore instead. */}
          {inTrash ? null : (
            <PressableRow
              accessibilityRole="button"
              onPress={() => {
                setMenuOpen(false);
                void trashMessage(summary.id);
                navigation.goBack();
              }}
              style={s.menuRow}
            >
              <Icon name="trash" size={18} color={color.coral} />
              <Text style={s.menuLabel}>Move to Trash</Text>
            </PressableRow>
          )}
          {/* The message as the provider stores it — sealed, if it is. Saving
              the decrypted text instead would be a button that strips the
              encryption off, so this row cannot reach it (`exportMessage`). */}
          <PressableRow
            accessibilityRole="button"
            onPress={() => {
              setMenuOpen(false);
              exportMessage(summary).catch((e: unknown) =>
                showToast({
                  durationMs: 5000,
                  icon: 'alert',
                  message: userMessage(e),
                }),
              );
            }}
            style={s.menuRow}
          >
            <Icon name="download" size={18} color={color.inkDim} />
            <Text style={s.menuLabel}>{headerEncrypted ? 'Save as .eml (stays encrypted)' : 'Save as .eml'}</Text>
          </PressableRow>
          {opened ? (
            <PressableRow
              accessibilityRole="button"
              onPress={() => {
                setMenuOpen(false);
                setShowRaw((v) => !v);
              }}
              style={s.menuRow}
            >
              <Icon name="search" size={18} color={color.inkDim} />
              <Text style={s.menuLabel}>
                {showRaw
                  ? 'Hide provider view'
                  : `What ${session?.provider === 'outlook' ? 'Outlook' : session?.provider === 'imap' ? 'your mail server' : 'Gmail'} sees`}
              </Text>
            </PressableRow>
          ) : null}
        </Sheet>

        <LinkSheet url={tappedLink} onClose={() => setTappedLink(null)} />
        <SnoozeModal
          visible={snoozeOpen}
          onSnooze={handleSnooze}
          onClose={() => setSnoozeOpen(false)}
        />
        <LabelSheet visible={labelsOpen} messageIds={[summary.id]} onClose={() => setLabelsOpen(false)} />
      </View>
    </ExpandingScreen>
  );
}

/** One block of the decrypt cascade — fades and rises into place on mount. */
function Reveal({ delay, children }: { delay: number; children: React.ReactNode }) {
  return (
    <MotiView
      from={{ opacity: 0, translateY: 10 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: 'timing', duration: 380, delay }}
    >
      {children}
    </MotiView>
  );
}

/**
 * Why this message was flagged — or nothing at all.
 *
 * Silent for legitimate mail, which is the common case and must stay quiet. When
 * it does speak it says *which rules fired*, because a warning a reader cannot
 * check is a warning they learn to dismiss. Phishing and spam get different
 * wording deliberately: one is a message trying to impersonate someone, the other
 * is mail the reader did not ask for, and collapsing them into one scary banner
 * would waste the distinction the engine works to draw.
 *
 * The provider's own junk verdict is the third thing it can report, and it has to
 * be reported: a message can sit in Spam on the provider's say-so alone, and a
 * reader who opened it from there would otherwise find no explanation at all. On
 * an encrypted message that verdict is *not* acted on — the provider only saw
 * ciphertext — so the copy says which way the disagreement went rather than
 * leaving the reader to notice for themselves that their provider hid a message
 * this app is showing.
 *
 * An explicit mark short-circuits the engine, so `overridden` is reported as the
 * user's own decision rather than dressed up as a detection — and it is reported
 * *instead* of the provider's verdict, because the whole point of a mark is that
 * it wins.
 */
function SpamNotice({
  verdict,
  providerJunk,
  encrypted,
}: {
  verdict: SpamVerdict | null;
  /** Whether the provider filed this message in its junk folder. */
  providerJunk: boolean;
  encrypted: boolean;
}) {
  if (!verdict) return null;

  if (verdict.overridden) {
    if (verdict.classification !== 'spam') return null;
    return (
      <View style={{ marginBottom: 15 }}>
        <Banner tone="warn" icon="alert">You marked this message as spam.</Banner>
      </View>
    );
  }

  const flagged = isUnwanted(verdict);
  if (!flagged && !providerJunk) return null;

  const providerSays = providerJunk
    ? encrypted
      ? 'Your mail provider filed this as spam. It could only see the ciphertext, so CryptMail keeps it in your inbox.'
      : 'Your mail provider filed this as spam.'
    : null;

  const phishing = verdict.classification === 'phishing-suspicious';
  const headline = phishing
    ? 'This message may be impersonating someone. Do not enter passwords or payment details from it.'
    : flagged
      ? 'This looks like spam.'
      : (providerSays as string);
  // The provider's sentence becomes a reason only when the headline is this
  // device's own verdict; otherwise it would be printed twice.
  const why = [...(flagged && providerSays ? [providerSays] : []), ...reasons(verdict, 3)];

  return (
    <View style={{ marginBottom: 15 }}>
      <Banner tone="warn" icon="alert">
        {headline}
      </Banner>
      {why.length > 0 ? (
        <View style={s.spamReasons}>
          {why.map((reason) => (
            <Text key={reason} style={s.spamReason}>
              · {reason}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const truncate = (raw: string, lines = 26) => {
  const all = raw.split('\n');
  return all.length <= lines ? raw : [...all.slice(0, lines), `…  (${all.length - lines} more lines)`].join('\n');
};

/** The gap between the card bar and the first thing under it. */
const SCROLL_LEAD = 10;


const s = StyleSheet.create({
  // No fill of its own: the ground below is a layer, so the strip above it can
  // be left to the band.
  screen: { flex: 1 },
  ground: { backgroundColor: color.ground, bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },

  scroll: { flex: 1 },

  subject: { ...type.display, color: color.ink, lineHeight: 28 },
  timestamp: { ...type.meta, color: color.inkFaint, marginTop: 6 },
  sender: { alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 16 },
  senderName: { ...type.strong, color: color.ink },
  senderAddress: { ...type.meta, color: color.inkFaint, marginTop: 2 },
  recipients: { ...type.meta, color: color.inkFaint, marginTop: 8 },
  recipientsLabel: { color: color.inkDim, fontFamily: font.sansSemibold },

  keyLine: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderColor: glass.hairline,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
    marginTop: 12,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  senderKey: { color: color.mint, flex: 1, fontFamily: font.mono, fontSize: 11.5 },

  // Reads as a note above the mail rather than a warning: nothing has gone
  // wrong, and coral is trust vocabulary that must not be spent here.
  imageStrip: {
    alignItems: 'center',
    backgroundColor: color.panel2,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 9,
    marginBottom: 14,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  imageStripText: { color: color.inkDim, flex: 1, fontFamily: font.sans, fontSize: 13 },
  imageStripAction: { fontFamily: font.sansSemibold, fontSize: 13 },
  menuRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },
  menuLabel: { ...type.settingsRow, color: color.ink },

  spamReasons: { gap: 3, marginTop: 8, paddingHorizontal: 4 },
  spamReason: { color: color.inkDim, fontFamily: font.sans, fontSize: 12 },

  replybar: {
    backgroundColor: color.surface,
    borderTopColor: color.line,
    borderTopWidth: 1,
    ...shadow.sheet,
  },
  replybarInner: { paddingHorizontal: 16, paddingTop: 14 },
  replyActions: { flexDirection: 'row', gap: 9 },

  rawBlockOuter: {
    backgroundColor: color.ground2,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginTop: 16,
  },
  rawBlock: { padding: 14 },
  rawHead: { alignItems: 'center', flexDirection: 'row', gap: 8, marginBottom: 10 },
  rawHeadText: { ...type.eyebrow, color: color.inkFaint, flex: 1 },
  copyBtn: {
    alignItems: 'center',
    borderRadius: radius.xs,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  copyText: { ...type.eyebrow, color: color.inkDim, letterSpacing: 0.6 },
  ghostSubject: {
    alignSelf: 'flex-start',
    backgroundColor: color.panel2,
    borderColor: color.line,
    borderRadius: radius.xs,
    borderWidth: 1,
    color: color.inkFaint,
    fontFamily: font.mono,
    fontSize: 11.5,
    marginBottom: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  cipher: {
    backgroundColor: color.ground2,
    borderColor: color.lineSoft,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: color.inkDim,
    fontFamily: font.mono,
    fontSize: 10.5,
    lineHeight: 15,
    padding: 13,
  },
});
