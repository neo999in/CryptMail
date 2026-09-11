/**
 * The chrome around an open message — its bar and its trust banner — shared by
 * the reader (`screens/MessageScreen.tsx`) and the conversation view
 * (`screens/ConversationScreen.tsx`), so a thread and a single mail are the same
 * page rather than two that drift apart.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OpenedMessage } from '../state/AppState';
import { color, font, space } from '../theme';
import { Badge, Banner, barIcon, IconButton } from './primitives';

/**
 * "Not encrypted", from the headers alone.
 *
 * Drawn before the message is open as well as after, which is why it is its own
 * component: the banner the reader sees while the body loads has to be the same
 * one they are left with, or the page rewrites itself under them. Only the
 * *encrypted* banner waits, because its wording is the signature's verdict and
 * that does not exist until the message has been decrypted.
 */
export function PlainBanner() {
  return (
    <View style={{ marginBottom: 15 }}>
      <View style={s.plainBanner}>
        <Badge tone="plain">Not encrypted</Badge>
        <Text style={s.plainText}>Sent by someone who is not a CryptMail user.</Text>
      </View>
    </View>
  );
}

export function StatusBanner({ opened }: { opened: OpenedMessage }) {
  if (opened.encryption.kind === 'plain') return <PlainBanner />;
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
 * The bar over an open message: a way back, and what can be done to it.
 *
 * It carries no identity — no avatar, no sender name. That is drawn a few
 * pixels below it, at full size with the address under it, and a second smaller
 * copy in the bar said the same thing twice while spending the whole width on
 * it. The width buys actions instead, which is what a reader wants at the top
 * of a mail they have just opened and have already decided about.
 *
 * Deliberately *not* an aurora bar. The band belongs to the screen this one
 * opened over — the inbox keeps drawing its own above the inset, unchanged and
 * still running — and a second band here would be a different bar arriving where
 * the reader was told nothing would move.
 *
 * Sitting under the aurora bar (`underBar`), this row wants almost no lead-in:
 * the band above is already the top of the screen, and padding under it reads
 * as a gap rather than as breathing room. Standing alone — opened from a
 * conversation, from Sent — it clears the status bar itself.
 */
export function CardBar({
  onBack,
  onHeight,
  actions,
  underBar,
}: {
  onBack: () => void;
  /** Measured so the ground below can start exactly where this row ends. */
  onHeight?: (height: number) => void;
  /** The trailing buttons. Absent while the message is missing — the bar is
   *  then just a way back. */
  actions?: React.ReactNode;
  underBar: boolean;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View
      onLayout={(e) => onHeight?.(Math.ceil(e.nativeEvent.layout.height))}
      style={[
        s.cardbar,
        { paddingTop: underBar ? space.xs : insets.top + space.sm },
        // The hairline is what separates this row from the list it covered.
        // Under the bar there is no list above it to separate from — only the
        // band, which the rule would cut across.
        underBar && { borderBottomWidth: 0 },
      ]}
    >
      {/* Pulled 2 further out than the padding, to land where the overflow
          at the other end does. Both boxes stop 16 from the edge, but the two
          glyphs meet that line differently: the dots are three circles on one
          centre, so every row of ink is flush with the box, while the arrow's
          leftmost pixel is the chevron's apex on a single row and the rest of
          it starts further in — measured, its mean edge sat 18.8 out against
          the dots' 16.5. A point reads as further from an edge than a flat
          side at the same distance, so the box is moved, not the glyph. */}
      <View style={{ marginLeft: -2 }}>
        <IconButton {...barIcon} icon="back" label="Back" onPress={onBack} />
      </View>
      <View style={{ flex: 1 }} />
      {actions}
    </View>
  );
}

const s = StyleSheet.create({
  // The card's own edge: the ground it stands on, with a hairline where the
  // list used to be. No fill of its own — the surface colour belongs to bars,
  // and the one bar on this screen is the inbox's, above.
  cardbar: {
    alignItems: 'center',
    borderBottomColor: color.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    // The flex spacer holds the back arrow apart from the actions; this gap
    // is just between the actions themselves. It sits on top of the 12 each
    // 36 box already puts between its 24 glyph and the next, so the number
    // here is smaller than the gap the eye ends up seeing.
    gap: 14,
    paddingBottom: space.xs,
    // Not the bar's own inset — what is left of it once the glyphs' side
    // bearing is taken off. Both end icons carry about ten points of nothing
    // inside their box (the arrow because it is drawn short of its 21, the
    // dots because they are a 4-wide column in one), so a padding of 18 put
    // their ink 28 from the edge and the row read inset from its own screen.
    // Ten lands it near 20 — clear of the message's 16 gutter without the
    // arrow drifting back toward the middle of the bar. Measured, not guessed.
    paddingHorizontal: 10,
  },

  plainBanner: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    padding: 11,
  },
  plainText: { color: color.inkDim, flex: 1, fontFamily: font.sans, fontSize: 12.5 },
});
