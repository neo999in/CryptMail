import { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import { MotiView } from 'moti';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { displayName, initials, relativeTime, shortFingerprint } from '../lib/format';
import { RootStackParamList } from '../navigation';
import { OpenedMessage, useApp } from '../state/AppState';
import { color, font, glass, radius, type } from '../theme';
import { Icon } from '../ui/Icon';
import { Avatar, Badge, Banner, EmptyState, Glass, Skeleton, SecondaryButton } from '../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'Message'>;

/** Reading — restored subject, trust chip, and the provider's view on demand. */
export function MessageScreen({ route, navigation }: Props) {
  const { messages, openMessage, keyring, identity, toggleStar, archiveMessage, setUnread } = useApp();
  const insets = useSafeAreaInsets();
  const [opened, setOpened] = useState<OpenedMessage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const summary = messages.find((m) => m.id === route.params.id);

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

  // Name the sender in the stack header so scrolled-down context is not lost.
  useEffect(() => {
    navigation.setOptions({
      title: summary ? displayName(summary.from.address, summary.from.name) : '',
    });
  }, [navigation, summary]);

  if (!summary) {
    return (
      <View style={s.screen}>
        <EmptyState
          icon="mail"
          title="Message not available"
          hint="It is no longer in the list on this device."
          action={<SecondaryButton title="Back to inbox" icon="back" onPress={() => navigation.goBack()} />}
        />
      </View>
    );
  }

  const copyCipher = async () => {
    if (!opened) return;
    await Clipboard.setStringAsync(opened.raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const senderName = displayName(summary.from.address, summary.from.name);
  const key = keyring[summary.from.address];
  const own = opened?.encryption.kind === 'encrypted' && !!opened.encryption.own;

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
      {!opened && !failure ? (
        <View>
          <View style={s.decryptingRow}>
            <ActivityIndicator color={color.brass} size="small" />
            <Text style={s.decrypting}>Decrypting on this device…</Text>
          </View>
          <View style={{ gap: 10, marginTop: 22 }}>
            <Skeleton width="72%" height={20} radius={radius.xs} />
            <Skeleton width={190} height={38} radius={radius.sm} />
            <View style={{ gap: 8, marginTop: 10 }}>
              <Skeleton width="100%" height={12} />
              <Skeleton width="94%" height={12} />
              <Skeleton width="60%" height={12} />
            </View>
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
              <Text style={s.body}>{opened.body}</Text>
            )}
          </Reveal>

          <Reveal delay={340}>
            <View style={s.actions}>
              <SecondaryButton
                title="Reply"
                icon="mail"
                onPress={() =>
                  navigation.navigate('Compose', {
                    to: summary.from.address,
                    subject: opened.subject.startsWith('Re:') ? opened.subject : `Re: ${opened.subject}`,
                  })
                }
              />
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
            </View>
          </Reveal>

          {showRaw ? (
            <Glass contentStyle={s.rawBlock} style={s.rawBlockOuter}>
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
            </Glass>
          ) : null}
        </>
      ) : null}
    </ScrollView>
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
          <Text style={s.plainText}>Sent by someone who is not a CipherMail user.</Text>
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

const truncate = (raw: string, lines = 26) => {
  const all = raw.split('\n');
  return all.length <= lines ? raw : [...all.slice(0, lines), `…  (${all.length - lines} more lines)`].join('\n');
};

const s = StyleSheet.create({
  screen: { backgroundColor: 'transparent', flex: 1 },
  decryptingRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  decrypting: { ...type.meta, color: color.inkFaint, fontSize: 12 },

  subject: { ...type.display, color: color.ink, fontSize: 21, lineHeight: 28 },
  timestamp: { ...type.meta, color: color.inkFaint, marginTop: 6 },
  sender: { alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 16 },
  senderName: { ...type.strong, color: color.ink },
  senderAddress: { ...type.meta, color: color.inkFaint, marginTop: 2 },

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

  rawBlockOuter: { marginTop: 16 },
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
