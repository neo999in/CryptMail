import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import { MotiView } from 'moti';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { verdictFor } from '../categorizer/categorizer';
import { displayName, initials, relativeTime, shortFingerprint } from '../lib/format';
import { saveAttachment } from '../lib/files';
import { hostOf, linkify } from '../lib/links';
import { Attachment } from '../mail/attachment';
import { buildReplyDraft, replyAllRecipients, replyRecipients, ReplyKind, ReplySource } from '../mail/reply';
import { RootStackParamList } from '../navigation';
import { reasons, isUnwanted, SpamVerdict } from '../spam/spam';
import { OpenedMessage, useApp } from '../state/AppState';
import { color, defaultAccent, font, glass, radius, shadow, space, type } from '../theme';
import { AttachmentList } from '../ui/attachments';
import { useAppearance } from '../ui/appearance';
import { useChrome, useKeepsBarBeneath } from '../ui/chrome';
import { ExpandingScreen } from '../ui/expand';
import { MailRowCard } from '../ui/mailRow';
import { Icon } from '../ui/Icon';
import {
  Avatar,
  Badge,
  Banner,
  EmptyState,
  Glass,
  frost,
  IconButton,
  PrimaryButton,
  Skeleton,
  SecondaryButton,
} from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Message'>;

/** Reading — restored subject, trust chip, and the provider's view on demand. */
export function MessageScreen({ route, navigation }: Props) {
  const {
    messages,
    boxes,
    openMessage,
    keyring,
    identity,
    session,
    toggleStar,
    archiveMessage,
    setUnread,
    searchIndex,
    encryptionFor,
    spam,
    markSpam,
    markNotSpam,
  } = useApp();
  const insets = useSafeAreaInsets();
  const { rowPadding } = useAppearance();
  const { setOverlay } = useChrome();
  // The inbox's aurora bar is still on screen above this mail, so it keeps
  // animating rather than freezing on the frame it was focused at.
  useKeepsBarBeneath(!!route.params.topInset);
  const [opened, setOpened] = useState<OpenedMessage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  /** The link the reader tapped, waiting on them to confirm where it goes. */
  const [tappedLink, setTappedLink] = useState<string | null>(null);
  /** The attachment currently being written out, and any failure saving one. */
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The row can come from any list that shows mail, not just the inbox: opening
  // a message from Sent or Archive lands here with an id the inbox has never
  // seen.
  const summary = useMemo(() => {
    const id = route.params.id;
    return (
      messages.find((m) => m.id === id) ??
      boxes.sent.items.find((m) => m.id === id) ??
      boxes.archive.items.find((m) => m.id === id)
    );
  }, [boxes, messages, route.params.id]);

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

  const mark = summary ? spam.marks[summary.id] : undefined;

  useEffect(() => {
    let cancelled = false;
    if (!summary) return;
    (async () => {
      try {
        const result = await openMessage(summary);
        if (!cancelled) {
          setOpened(result);
          // Opening a message marks it read, like any mail client.
          if (summary.unread) void setUnread(summary.id, false);
        }
      } catch (e) {
        if (!cancelled) setFailure(e instanceof Error ? e.message : String(e));
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
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const senderName = displayName(summary.from.address, summary.from.name);
  const key = keyring[summary.from.address];
  const own = opened?.encryption.kind === 'encrypted' && !!opened.encryption.own;

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
        />
      }
      navigation={navigation}
      // The bar underneath gets its title, tabs and filter back as the mail
      // starts collapsing, not when it finally unmounts: the list is on show
      // for the whole of that, and an empty bar over it reads as broken.
      onClosing={() => setOverlay('closing')}
      origin={route.params.origin}
      topInset={route.params.topInset}
    >
      <View style={s.screen}>
        <CardBar
          onBack={() => navigation.goBack()}
          sender={summary.from}
          title={senderName}
          underBar={!!route.params.topInset}
        />
        <ScrollView
          // Tighter at the top than the sides: the message follows the card
          // bar, and 16 there stacked with the bar's own padding into a gap.
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 28 }}
          style={s.scroll}
          showsVerticalScrollIndicator={false}
        >
          {!opened && !failure ? (
            <View style={{ gap: 10 }}>
              <Skeleton width="72%" height={20} radius={radius.xs} />
              <Skeleton width={190} height={38} radius={radius.sm} />
              <View style={{ gap: 8, marginTop: 10 }}>
                <Skeleton width="100%" height={12} />
                <Skeleton width="94%" height={12} />
                <Skeleton width="60%" height={12} />
              </View>
            </View>
          ) : null}

          {failure ? <Banner tone="warn" icon="alert">{failure}</Banner> : null}

          {opened ? (
            <>
              {/* The authored moment: the message resolves top-down, as if it is
                  decrypting on this device line by line. */}
              <Reveal delay={0}>
                <StatusBanner opened={opened} />
                <SpamNotice verdict={verdict} />
              </Reveal>

              <Reveal delay={80}>
                <Text style={s.subject}>{opened.subject}</Text>
                <Text style={s.timestamp}>{relativeTime(summary.date)}</Text>
              </Reveal>

              <Reveal delay={160}>
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

                <View style={s.keyLine}>
                  <Icon
                    name={own || key ? 'key' : 'alert'}
                    size={13}
                    color={!own && key?.trust === 'changed' ? color.coral : !own && !key ? color.inkFaint : color.mint}
                  />
                  {own ? (
                    <Text style={s.senderKey}>you · key {shortFingerprint(identity?.fingerprint ?? '')}</Text>
                  ) : key ? (
                    <Text style={[s.senderKey, key.trust === 'changed' && { color: color.coral }]}>
                      {key.trust} · key {shortFingerprint(key.fingerprint)}
                    </Text>
                  ) : (
                    <Text style={[s.senderKey, { color: color.inkFaint }]}>no key on this device</Text>
                  )}
                </View>
              </Reveal>

              <Reveal delay={250}>
                {opened.error ? (
                  <View style={{ marginBottom: 14 }}>
                    <Banner tone="warn" icon="alert">{opened.error}</Banner>
                  </View>
                ) : (
                  <>
                    <Body text={opened.body} onLinkPress={setTappedLink} />
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

              <Reveal delay={340}>
                <View style={s.actions}>
                  <SecondaryButton
                    title={showRaw ? 'Hide provider view' : 'What Gmail sees'}
                    icon="search"
                    onPress={() => setShowRaw((v) => !v)}
                  />
                </View>
                <View style={s.actions}>
                  <SecondaryButton
                    title={summary.starred ? 'Starred' : 'Star'}
                    icon="star"
                    onPress={() => void toggleStar(summary.id)}
                  />
                  <SecondaryButton
                    title="Archive"
                    icon="archive"
                    onPress={() => {
                      void archiveMessage(summary.id);
                      navigation.goBack();
                    }}
                  />
                  <SecondaryButton
                    title="Mark unread"
                    icon="mail"
                    onPress={() => {
                      void setUnread(summary.id, true);
                      navigation.goBack();
                    }}
                  />
                  {/* One button, because the useful action is always the opposite of
                      what the filter currently believes. It files the message and
                      trains the personal model; it deliberately does not archive or
                      delete — removing mail from the mailbox is a different action
                      with a different button. */}
                  <SecondaryButton
                    title={mark === 'spam' ? 'Not spam' : 'Mark as spam'}
                    icon={mark === 'spam' ? 'check' : 'alert'}
                    tone={mark === 'spam' ? 'default' : 'danger'}
                    onPress={() => void (mark === 'spam' ? markNotSpam(summary.id) : markSpam(summary.id))}
                  />
                </View>
              </Reveal>

              {showRaw ? (
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
            </>
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

        <LinkSheet url={tappedLink} onClose={() => setTappedLink(null)} />
      </View>
    </ExpandingScreen>
  );
}

/**
 * The message text, with http(s) URLs made tappable.
 *
 * A decrypted body gets this for free — it is the same `<Text>`. Detection is in
 * `lib/links.ts`, which linkifies nothing but `http://` and `https://`; that
 * exclusion is the security boundary, so nothing about which schemes are
 * tappable is decided here.
 */
function Body({ text, onLinkPress }: { text: string; onLinkPress: (url: string) => void }) {
  return (
    <Text style={s.body}>
      {linkify(text).map((segment, i) =>
        segment.url ? (
          <Text
            accessibilityRole="link"
            key={`link-${i}`}
            onPress={() => onLinkPress(segment.url as string)}
            style={s.link}
            suppressHighlighting
          >
            {segment.text}
          </Text>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}

/**
 * Where this link goes, before it goes there.
 *
 * A tap opens this rather than the browser. Tapping a link in an email is the
 * classic phishing move, and the host is the part that gives a spoof away — so
 * it gets its own line, in mono, above the full URL. One extra tap is a small
 * price for making the destination visible while it can still be declined.
 */
function LinkSheet({ url, onClose }: { url: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Fresh state each time a link is tapped, so a previous "Copied" or a failure
  // from another URL is never showing against this one.
  useEffect(() => {
    setCopied(false);
    setFailure(null);
  }, [url]);

  if (!url) return null;

  const open = async () => {
    try {
      await Linking.openURL(url);
      onClose();
    } catch (e) {
      setFailure(`Could not open this link: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const copy = async () => {
    await Clipboard.setStringAsync(url);
    setCopied(true);
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={[s.scrim, frost(glass.blur.medium)]}>
        {Platform.OS !== 'web' ? (
          <BlurView intensity={glass.blur.medium} tint="dark" style={StyleSheet.absoluteFill} />
        ) : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: color.scrim }]} />
      </Pressable>
      <View style={[s.sheet, s.sheetInner, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={s.grabber} />
        <Text style={s.linkEyebrow}>This link goes to</Text>
        <Text style={s.linkHost}>{hostOf(url) ?? 'an address CryptMail could not read'}</Text>
        <ScrollView style={s.linkUrlBox} showsVerticalScrollIndicator={false}>
          <Text style={s.linkUrl}>{url}</Text>
        </ScrollView>
        {failure ? (
          <View style={{ marginTop: 12 }}>
            <Banner tone="warn" icon="alert">{failure}</Banner>
          </View>
        ) : null}
        <View style={s.linkActions}>
          <View style={{ flex: 1 }}>
            <PrimaryButton title="Open" icon="link" onPress={() => void open()} />
          </View>
          <SecondaryButton
            title={copied ? 'Copied' : 'Copy'}
            icon={copied ? 'check' : 'copy'}
            onPress={() => void copy()}
          />
          <SecondaryButton title="Cancel" icon="close" onPress={onClose} />
        </View>
      </View>
    </Modal>
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

function StatusBanner({ opened }: { opened: OpenedMessage }) {
  if (opened.encryption.kind === 'plain') {
    return (
      <View style={{ marginBottom: 15 }}>
        <View style={s.plainBanner}>
          <Badge tone="plain">Not encrypted</Badge>
          <Text style={s.plainText}>Sent by someone who is not a CryptMail user.</Text>
        </View>
      </View>
    );
  }
  if (opened.error) return null;

  const trust = opened.encryption.trust;
  const tone = trust === 'verified' || trust === 'seen' ? 'ok' : 'warn';
  const text = opened.encryption.own
    ? 'Your copy · encrypted to your own key'
    : trust === 'verified'
      ? 'Encrypted end-to-end · signature verified'
      : trust === 'seen'
        ? 'Encrypted end-to-end · sender key not verified yet'
        : trust === 'changed'
          ? "This sender's key changed — verify before you trust this message"
          : 'Encrypted · no key for this sender on this device';

  return (
    <View style={{ marginBottom: 15 }}>
      <Banner tone={tone} icon={tone === 'ok' ? 'shield' : 'alert'}>
        {text}
      </Banner>
    </View>
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
 * An explicit mark short-circuits the engine, so `overridden` is reported as the
 * user's own decision rather than dressed up as a detection.
 */
function SpamNotice({ verdict }: { verdict: SpamVerdict | null }) {
  if (!verdict) return null;

  if (verdict.overridden) {
    if (verdict.classification !== 'spam') return null;
    return (
      <View style={{ marginBottom: 15 }}>
        <Banner tone="warn" icon="alert">You marked this message as spam.</Banner>
      </View>
    );
  }

  if (!isUnwanted(verdict)) return null;

  const phishing = verdict.classification === 'phishing-suspicious';
  const why = reasons(verdict, 3);

  return (
    <View style={{ marginBottom: 15 }}>
      <Banner tone="warn" icon="alert">
        {phishing
          ? 'This message may be impersonating someone. Do not enter passwords or payment details from it.'
          : 'This looks like spam.'}
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

/**
 * The mail's own leading edge: back, the sender, and nothing else.
 *
 * Deliberately *not* an aurora bar. The band belongs to the screen this one
 * opened over — the inbox keeps drawing its own above the inset, unchanged and
 * still running — and a second band here would be a different bar arriving where
 * the reader was told nothing would move. This is the top of the card, so it
 * carries the card's fill and scales in with the rest of the message.
 *
 * `underBar` says the aurora bar above is holding the status bar; standing on
 * its own (opened from a conversation, from Sent) it has to clear it itself.
 */
function CardBar({
  onBack,
  sender,
  title,
  underBar,
}: {
  onBack: () => void;
  /** Absent while the message is missing — the bar is then just a way back. */
  sender?: { address: string; name?: string };
  title?: string;
  underBar: boolean;
}) {
  const insets = useSafeAreaInsets();

  return (
    // Sitting under the aurora bar, this row wants almost no lead-in: the band
    // above is already the top of the screen, and padding under it reads as a
    // gap rather than as breathing room. Standing alone it clears the status
    // bar itself and gets the usual space.
    <View style={[s.cardbar, { paddingTop: underBar ? space.xs : insets.top + space.sm }]}>
      <IconButton icon="back" label="Back" onPress={onBack} />
      {sender ? (
        <Avatar seed={sender.address} label={initials(displayName(sender.address, sender.name))} size={30} />
      ) : null}
      <Text numberOfLines={1} style={s.cardbarTitle}>
        {title ?? ''}
      </Text>
    </View>
  );
}

const truncate = (raw: string, lines = 26) => {
  const all = raw.split('\n');
  return all.length <= lines ? raw : [...all.slice(0, lines), `…  (${all.length - lines} more lines)`].join('\n');
};

const s = StyleSheet.create({
  screen: { backgroundColor: color.ground, flex: 1 },

  // The card's own edge: the ground it stands on, with a hairline where the
  // list used to be. No fill of its own — the surface colour belongs to bars,
  // and the one bar on this screen is the inbox's, above.
  cardbar: {
    alignItems: 'center',
    borderBottomColor: color.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: space.md,
    paddingBottom: space.xs,
    paddingHorizontal: space.lg,
  },
  cardbarTitle: { ...type.strong, color: color.ink, flex: 1 },
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

  body: { color: color.body, fontFamily: font.sans, fontSize: 15.5, lineHeight: 25 },
  // Underlined as well as tinted: colour alone is not a signal everyone can see.
  link: { color: defaultAccent, textDecorationLine: 'underline' },

  scrim: { flex: 1 },
  sheet: {
    backgroundColor: color.surface,
    borderTopColor: color.line,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    ...shadow.sheet,
  },
  sheetInner: { paddingHorizontal: 16, paddingTop: 10 },
  grabber: {
    alignSelf: 'center',
    backgroundColor: color.line,
    borderRadius: radius.pill,
    height: 4,
    marginBottom: 16,
    width: 38,
  },
  linkEyebrow: { ...type.eyebrow, color: color.inkFaint },
  linkHost: { color: color.ink, fontFamily: font.mono, fontSize: 17, marginTop: 8 },
  linkUrlBox: {
    backgroundColor: color.ground2,
    borderColor: color.lineSoft,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginTop: 12,
    maxHeight: 96,
    padding: 11,
  },
  linkUrl: { color: color.inkDim, fontFamily: font.mono, fontSize: 11.5, lineHeight: 17 },
  linkActions: { alignItems: 'stretch', flexDirection: 'row', gap: 9, marginTop: 14 },

  plainBanner: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderColor: glass.hairline,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    padding: 11,
  },
  plainText: { color: color.inkDim, flex: 1, fontFamily: font.sans, fontSize: 12.5 },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 16 },

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
