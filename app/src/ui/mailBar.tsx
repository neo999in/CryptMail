/**
 * The top bar every mail list wears.
 *
 * Choosing Bills or Spam in the drawer never leaves the home screen: the same
 * aurora bar stays put, its title changes, and the body underneath swaps. Sent
 * and Archive are their own provider fetch rather than a filter over `messages`,
 * and Drafts and Scheduled read local stores — but none of that is a reason to
 * look different, so all five wear this one bar: same band, same title row, same
 * search, same fade while a mail is open above it.
 *
 * What a body supplies is only what actually differs — the title, its own
 * actions, and an optional controls strip beneath (the inbox's tabs and filter).
 * `leading` is the account avatar that opens the drawer on every one of them:
 * nothing the drawer reaches is a push, so nothing it reaches wears a back
 * arrow. Everything the aurora's terms depend on lives here, once:
 *
 *  - the band is sized from this bar's **measured** height, never `absoluteFill`;
 *  - it is `pointerEvents="none"`, so the avatar, tabs and buttons keep their taps;
 *  - it animates only while the screen is focused *or* a mail is open above it —
 *    see `ui/chrome.tsx` for why those are not the same question. Foreground,
 *    reduced motion and battery saver are checked inside `Aurora` itself.
 *
 * The demo-crypto strip rides here too (rule 2): it is a statement about the
 * core, which is no more true on the inbox than it is on Sent.
 */
import { useIsFocused } from '@react-navigation/native';
import { MotiView } from 'moti';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cryptoMode } from '../config';
import { color, font, motion, space, type } from '../theme';
import { Icon } from './Icon';
import { Aurora } from './aurora';
import { useAccent, useAppearance } from './appearance';
import { useChrome } from './chrome';
import { barIcon, Field, IconButton, Input, useFocus } from './primitives';

/** The bar's own lead-in above its first row, past the status bar. */
export const BAR_LEAD = 6;

/**
 * How far an open mail rides up into the title row.
 *
 * The row's own breathing room is under the title, and with the title faded out
 * it is just gap; past that the mail takes back about half the row itself. The
 * band that remains is the strip behind the status bar plus a little colour —
 * enough to read as the same bar, without holding the mail down against it.
 */
const MAIL_LIFT = space.xl + space.md;

/**
 * Where a mail opened from this bar's list should start.
 *
 * The status bar plus the title row — not the bar's full height. The controls
 * below it are faded out while a mail is open, so keeping their height would
 * hold the message down against dead space. Clamped, so however the bar is
 * measured the mail never starts under the clock.
 */
export function mailTopInset(safeTop: number, headerHeight: number): number {
  return Math.max(safeTop, safeTop + BAR_LEAD + headerHeight - MAIL_LIFT);
}

/**
 * How much band is still lit *below* where an open mail starts.
 *
 * The bar is taller than `mailTopInset` — the strip it lifts off the title row
 * plus the controls, which fade but keep their height — so the band goes on
 * being painted behind the top of the message. That strip is what an open mail
 * may leave unpainted so its own chrome reads as standing on the band rather
 * than on a black block below it; past this line there is a list underneath,
 * not a bar, so nothing may be transparent there. Measured, never assumed: the
 * demo strip and the safe area both change it.
 */
export function mailBandBelow(barHeight: number, topInset: number): number {
  return Math.max(0, barHeight - topInset);
}

export type MailBarSearch = {
  value: string;
  onChange: (query: string) => void;
  placeholder?: string;
};

export function MailTopBar({
  title,
  subtitle,
  leading,
  actions,
  search,
  controls,
  onHeaderHeight,
  onBarHeight,
}: {
  title: string;
  /** Second line under the title — used only when the mailbox is ambiguous. */
  subtitle?: string;
  /** The account avatar that opens the drawer — the same on every body. */
  leading?: React.ReactNode;
  /** Trailing buttons, before the search one this bar adds itself. */
  actions?: React.ReactNode;
  /** Filters rows already on the device; omit on a list that cannot be searched. */
  search?: MailBarSearch;
  /** The strip under the title row — the inbox's tabs and filter. */
  controls?: React.ReactNode;
  /** The title row's height, for `mailTopInset`. */
  onHeaderHeight?: (height: number) => void;
  /** The whole bar's height, for `mailBandBelow`. */
  onBarHeight?: (height: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const accent = useAccent();
  const { auroraColors } = useAppearance();
  const isFocused = useIsFocused();
  const { overlay } = useChrome();
  /** Covered by an open mail — but not while it is on its way back. */
  const covered = overlay === 'open';
  // Measured rather than assumed: the bar grows with the safe area, and again
  // when the demo strip or the subtitle is up. The band is sized from it so it
  // ends exactly where the bar does and the true-black ground is never lit.
  const [barHeight, setBarHeight] = useState(0);
  const [searching, setSearching] = useState(false);
  const focus = useFocus();

  const closeSearch = () => {
    setSearching(false);
    search?.onChange('');
  };

  return (
    <View
      // Rounded up: a fractional dp height leaves a sub-pixel gap at the band's
      // lower edge on a high-density panel, which reads as a hairline seam.
      onLayout={(e) => {
        const height = Math.ceil(e.nativeEvent.layout.height);
        setBarHeight(height);
        onBarHeight?.(height);
      }}
      style={[s.topbar, { paddingTop: insets.top + BAR_LEAD }]}
    >
      <View pointerEvents="none" style={s.auroraLayer}>
        <Aurora active={isFocused || overlay !== 'none'} height={barHeight} palette={auroraColors} />
      </View>

      {/* An open mail leaves the band on show and takes everything else off it:
          the title and the controls describe a list that is not what is being
          read. Faded rather than unmounted — the bar's height is what the
          message is inset by. `covered`, not "something is open": a closing
          mail reveals the list from its first frame. */}
      <MotiView
        accessibilityElementsHidden={covered}
        animate={{ opacity: covered ? 0 : 1 }}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
        pointerEvents={covered ? 'none' : 'auto'}
        transition={{ type: 'timing', duration: motion.fast }}
      >
        <View onLayout={(e) => onHeaderHeight?.(Math.ceil(e.nativeEvent.layout.height))}>
          {searching && search ? (
            <View style={s.header}>
              <IconButton {...barIcon} icon="back" label="Close search" onPress={closeSearch} />
              <Field focused={focus.focused} style={s.searchField}>
                <View style={s.searchRow}>
                  <Icon name="search" size={16} color={focus.focused ? accent : color.inkFaint} />
                  <Input
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus
                    onChangeText={search.onChange}
                    placeholder={search.placeholder ?? 'Search sender or subject'}
                    returnKeyType="search"
                    style={s.searchInput}
                    value={search.value}
                    {...focus.bind}
                  />
                  {search.value.length > 0 ? (
                    <Pressable accessibilityLabel="Clear search" hitSlop={10} onPress={() => search.onChange('')}>
                      <Icon name="close" size={16} color={color.inkDim} />
                    </Pressable>
                  ) : null}
                </View>
              </Field>
            </View>
          ) : (
            <View style={s.header}>
              {leading}
              <View style={s.titleWrap}>
                <Text numberOfLines={1} style={s.headerTitle}>
                  {title}
                </Text>
                {subtitle ? (
                  <Text numberOfLines={1} style={s.headerSub}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              {actions}
              {search ? (
                <IconButton {...barIcon} icon="search" label="Search" onPress={() => setSearching(true)} />
              ) : null}
            </View>
          )}
        </View>

        {/* Rule 2: the demo core must never be presented as secure — and that is
            as true of Sent as it is of the inbox. */}
        {cryptoMode === 'demo' ? (
          <View style={s.demoStrip}>
            <Icon name="alert" size={13} color={color.coral} />
            <Text style={s.demoText}>DEMO CRYPTO · nothing here is really encrypted</Text>
          </View>
        ) : null}

        {controls}
      </MotiView>
    </View>
  );
}

const s = StyleSheet.create({
  topbar: { backgroundColor: color.surface, overflow: 'hidden', position: 'relative' },
  auroraLayer: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  titleWrap: { flex: 1 },
  headerTitle: { ...type.display, color: color.ink },
  headerSub: { ...type.small, color: color.inkDim, marginTop: 1 },

  searchField: { flex: 1, marginBottom: 0, paddingVertical: 9 },
  searchRow: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
  searchInput: { flex: 1, fontSize: 15 },

  demoStrip: {
    alignItems: 'center',
    backgroundColor: color.coralBg,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: space.lg,
    paddingVertical: 6,
  },
  demoText: { color: color.coralInk, fontFamily: font.mono, fontSize: 10.5, letterSpacing: 0.6 },
});
