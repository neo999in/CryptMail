/**
 * HtmlReader — a safe renderer for incoming (attacker-controlled) email HTML.
 *
 * This is a standalone component: no `useApp()`, no provider calls. It reads
 * design tokens like every other component, so it is a drop-in anywhere a
 * message body needs rendering. Wiring it into a screen is a separate change.
 *
 * The pipeline, in order:
 *
 *  1. `sanitizePipeline` (html/sanitize.ts) resolves theme CSS variables first
 *     (`var(--cm-text)` → a real colour), then applies the auditable allowlist.
 *     Nothing that survives can execute — no scripts, no event handlers, no
 *     non-http(s) URLs. Malformed input never throws.
 *  2. react-native-render-html parses what survives into native views. Its
 *     transient render engine applies its own safe style allowlist a second
 *     time, independently of ours.
 *  3. Link taps are validated again at the exact tap moment (`hostOf` from
 *     lib/links.ts) and only then handed to the caller — or the system browser
 *     by default. A URL that somehow slipped the sanitizer still cannot be
 *     opened, because a non-http(s) scheme has no host.
 *  4. Remote images stay inert unless the caller opts in. The default posture
 *     (features.md §0.8) is that a sender's pixels are not fetched on the
 *     reader's say-so; a muted placeholder takes their place.
 *
 * Height: the component never scrolls itself. A non-scrolling ScrollView only
 * measures `onContentSizeChange`, and the outer container adopts the measured
 * height, so the surrounding screen scrolls the whole message as one unit. The
 * `prev` comparison bails re-renders out when a measurement repeats.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View, ViewStyle, useWindowDimensions } from 'react-native';
import RenderHTML, { CustomMixedRenderer, defaultSystemFonts } from 'react-native-render-html';

import { sanitizePipeline } from '../html/sanitize';
import { hostOf } from '../lib/links';
import { color, font, radius, space, type } from '../theme';
import { useAccent } from './appearance';
import { Icon } from './Icon';

export type HtmlReaderScheme = 'dark' | 'light';

export type HtmlReaderProps = {
  /** The raw incoming HTML. Treated as attacker-controlled. */
  html: string;
  /** Which theme's tokens the email's `var()`s resolve against. Default 'dark'. */
  scheme?: HtmlReaderScheme;
  /**
   * The width the content wraps to. Defaults to the window width; a screen
   * embedding the reader inside a padded container should pass its box width.
   */
  contentWidth?: number;
  /**
   * Called with a validated http(s) URL when a link is tapped. Defaults to
   * opening the system browser. A screen with a confirmation sheet passes its
   * own handler and returns instead of opening.
   */
  onLinkPress?: (url: string) => void;
  /**
   * When false (default) remote images render as a muted placeholder and are
   * never fetched. features.md §0.8: a sender's pixels need consent first.
   */
  allowRemoteImages?: boolean;
  /** Extra CSS variables, merged over the theme's defaults. */
  cssVars?: Record<string, string>;
  /**
   * Optional clamp on the rendered height. Without it the reader sizes itself
   * to its content; with it, content beyond the clamp is clipped (the caller
   * owns what happens below — e.g. a preview).
   */
  maxHeight?: number;
  style?: ViewStyle;
};

/**
 * The tokens each scheme maps to, and the CSS variables an email can reference.
 * `dark` is the app's actual token set; `light` is a provisional inverse so the
 * component stays general and usable outside this app's always-dark setting.
 */
function schemeTheme(scheme: HtmlReaderScheme, accent: string) {
  if (scheme === 'dark') {
    return {
      body: color.body,
      ink: color.ink,
      dim: color.inkDim,
      border: color.line,
      bg: color.ground2,
      vars: {
        '--cm-text': color.body,
        '--cm-ink': color.ink,
        '--cm-ink-dim': color.inkDim,
        '--cm-link': accent,
        '--cm-border': color.line,
        '--cm-bg': color.ground2,
      },
    };
  }
  return {
    body: '#1F2328',
    ink: '#0D1117',
    dim: '#57606A',
    border: '#D8DEE4',
    bg: '#F6F8FA',
    vars: {
      '--cm-text': '#1F2328',
      '--cm-ink': '#0D1117',
      '--cm-ink-dim': '#57606A',
      '--cm-link': accent,
      '--cm-border': '#D8DEE4',
      '--cm-bg': '#F6F8FA',
    },
  };
}

/** A muted, non-fetching stand-in for a remote image the reader is not allowed to load. */
function ImagePlaceholder() {
  return (
    <View style={s.imgPlaceholder} accessibilityLabel="Hidden image">
      <Icon name="image" color={color.inkFaint} size={15} strokeWidth={1.7} />
      <Text style={s.imgPlaceholderText}>image hidden</Text>
    </View>
  );
}

export function HtmlReader({
  html,
  scheme = 'dark',
  contentWidth,
  onLinkPress,
  allowRemoteImages = false,
  cssVars,
  maxHeight,
  style,
}: HtmlReaderProps) {
  const accent = useAccent();
  const windowWidth = useWindowDimensions().width;
  const width = contentWidth ?? windowWidth;

  const theme = useMemo(() => schemeTheme(scheme, accent), [scheme, accent]);

  /** Theme CSS variables, with the caller's overrides on top. */
  const mergedVars = useMemo(
    () => (cssVars ? { ...theme.vars, ...cssVars } : theme.vars),
    [theme, cssVars],
  );

  /** Sanitise + resolve `var()`s once per html change. Attacker input never reaches the renderer unsanitised. */
  const safeHtml = useMemo(() => sanitizePipeline(html, mergedVars), [html, mergedVars]);

  const handleLinkPress = useCallback(
    (url: string) => {
      // The sanitizer already dropped bad schemes; this is the second gate, at
      // the exact tap. A non-http(s) URL has no host and is never opened.
      if (!hostOf(url)) return;
      if (onLinkPress) {
        onLinkPress(url);
        return;
      }
      Linking.openURL(url).catch(() => {
        /* opening the browser is best-effort; a dead URL must not crash the reader */
      });
    },
    [onLinkPress],
  );

  const renderersProps = useMemo(
    () => ({
      a: { onPress: (_event: unknown, href: string) => handleLinkPress(href) },
    }),
    [handleLinkPress],
  );

  /**
   * The img renderer is the remote-load gate. When the caller has not allowed
   * remote images — or the src is somehow not http(s) — the element is
   * replaced with a placeholder and nothing is fetched. Only then does the
   * default renderer (the native Image) get a chance.
   */
  const renderers = useMemo(
    () => ({
      img: (({ TDefaultRenderer, tnode, ...props }) => {
        const src = tnode?.attributes?.src ?? '';
        if (allowRemoteImages && /^https?:\/\//i.test(src)) {
          return <TDefaultRenderer {...props} tnode={tnode} />;
        }
        return <ImagePlaceholder />;
      }) as CustomMixedRenderer,
    }),
    [allowRemoteImages],
  );

  const engineConfig = useMemo(
    () => ({
      baseStyle: {
        fontFamily: font.sans,
        fontSize: 15.5,
        lineHeight: 25,
        color: theme.body,
      },
      tagsStyles: {
        p: { marginVertical: space.sm },
        div: { marginVertical: space.sm },
        li: { lineHeight: 25, marginVertical: 2 },
        ul: { marginVertical: space.sm, paddingLeft: space.lg },
        ol: { marginVertical: space.sm, paddingLeft: space.lg },
        blockquote: {
          borderLeftWidth: 3,
          borderLeftColor: theme.border,
          backgroundColor: theme.bg,
          paddingVertical: 2,
          paddingLeft: space.md,
          marginVertical: space.sm,
          borderRadius: radius.xs,
        },
        h1: { ...type.display, color: theme.ink, fontSize: 24, lineHeight: 30 },
        h2: { ...type.heading, color: theme.ink, fontSize: 20, lineHeight: 26 },
        h3: { ...type.heading, color: theme.ink, fontSize: 17, lineHeight: 23 },
        h4: { fontFamily: font.sansSemibold, fontSize: 16, lineHeight: 22, color: theme.ink },
        h5: { fontFamily: font.sansSemibold, fontSize: 15, lineHeight: 21, color: theme.ink },
        h6: { fontFamily: font.sansSemibold, fontSize: 14, lineHeight: 20, color: theme.dim },
        a: { color: accent, textDecorationLine: 'underline' as const },
        code: { fontFamily: font.mono, fontSize: 13.5, color: theme.ink },
        pre: {
          fontFamily: font.mono,
          fontSize: 13,
          lineHeight: 20,
          backgroundColor: theme.bg,
          padding: space.md,
          borderRadius: radius.sm,
          marginVertical: space.sm,
        },
        img: { marginVertical: space.sm },
        hr: { backgroundColor: theme.border, height: StyleSheet.hairlineWidth, marginVertical: space.lg },
        table: { marginVertical: space.sm },
        th: { fontFamily: font.sansSemibold, color: theme.ink },
        td: { color: theme.body },
      },
      // Hooks for a caller that passes classesStyles later; empty for now
      // because the sanitizer drops `class` and an external stylesheet can
      // never be honored by a native renderer anyway.
      classesStyles: {},
      systemFonts: [
        ...defaultSystemFonts,
        font.sans,
        font.sansMedium,
        font.sansSemibold,
        font.sansBold,
        font.mono,
      ],
    }),
    [theme, accent],
  );

  /** Measured content height — never scrolled, always adopted wholesale. */
  const [contentHeight, setContentHeight] = useState(0);
  const onContentSizeChange = useCallback((_w: number, h: number) => {
    // Bail when the measurement repeats; the loop guard from primitives.tsx.
    setContentHeight((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
  }, []);

  if (safeHtml.trim() === '') return null;

  return (
    <View
      style={[s.outer, { width, height: maxHeight ? Math.min(contentHeight, maxHeight) : contentHeight }, style]}
    >
      <ScrollView scrollEnabled={false} showsVerticalScrollIndicator={false} onContentSizeChange={onContentSizeChange}>
        <RenderHTML
          source={{ html: safeHtml }}
          contentWidth={width}
          baseStyle={engineConfig.baseStyle}
          tagsStyles={engineConfig.tagsStyles}
          classesStyles={engineConfig.classesStyles}
          systemFonts={engineConfig.systemFonts}
          renderers={renderers}
          renderersProps={renderersProps}
        />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  outer: {
    overflow: 'hidden',
  },
  imgPlaceholder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: radius.xs,
    backgroundColor: color.segment,
    marginVertical: space.sm,
  },
  imgPlaceholderText: {
    ...type.small,
    color: color.inkFaint,
    fontSize: 12,
  },
});
