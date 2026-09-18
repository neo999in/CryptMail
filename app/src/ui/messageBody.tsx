/**
 * A message's text and the link check that guards it — shared by the reader
 * (`screens/MessageScreen.tsx`) and the conversation view
 * (`screens/ConversationScreen.tsx`), so a link tapped in either goes through
 * the same sheet. A second copy of that sheet is how one of them would end up
 * opening links straight into the browser.
 */
import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useState } from 'react';
import { Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hostOf, linkify } from '../lib/links';
import { color, defaultAccent, font, glass, radius, shadow, space, type } from '../theme';
import { Banner, frost, PrimaryButton, SecondaryButton } from './primitives';
import { userMessage } from '../lib/errors';

/**
 * The message text, with http(s) URLs made tappable.
 *
 * A decrypted body gets this for free — it is the same `<Text>`. Detection is in
 * `lib/links.ts`, which linkifies nothing but `http://` and `https://`; that
 * exclusion is the security boundary, so nothing about which schemes are
 * tappable is decided here.
 */
/** The body's text style, for anything drawn in its place — the decrypt reveal. */
export const bodyTextStyle = { color: color.body, fontFamily: font.sans, fontSize: 15.5, lineHeight: 25 } as const;

export function Body({ text, onLinkPress }: { text: string; onLinkPress: (url: string) => void }) {
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
export function LinkSheet({ url, onClose }: { url: string | null; onClose: () => void }) {
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
      setFailure(`Could not open this link: ${userMessage(e)}`);
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

const s = StyleSheet.create({
  body: bodyTextStyle,
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
});
