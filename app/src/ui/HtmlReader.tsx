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
 *  4. Remote images are fetched only when the caller opts in. Left alone, a
 *     sender's pixels are not loaded and a muted placeholder takes their
 *     place. The message screen does opt in — see features.md §0.8 for what
 *     that costs and how to put the block back.
 *
 * Height: the component never scrolls itself. A non-scrolling ScrollView only
 * measures `onContentSizeChange`, and the outer container adopts the measured
 * height, so the surrounding screen scrolls the whole message as one unit. The
 * `prev` comparison bails re-renders out when a measurement repeats.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View, ViewStyle, useWindowDimensions } from 'react-native';
import RenderHTML, {
  CustomMixedRenderer,
  CustomTagRendererRecord,
  defaultSystemFonts,
} from 'react-native-render-html';

import { droppedDeclarations, resetDroppedDeclarations } from '../html/properties';
import {
  INLINE_CLASS,
  INLINE_ITEM_CLASS,
  sanitizePipeline,
  STACK_CLASS,
} from '../html/sanitize';
import { ValueContext } from '../html/values';
import { hostOf } from '../lib/links';
import { color, font, radius, space, type } from '../theme';
import { useAccent } from './appearance';
import { Icon } from './Icon';

export type HtmlReaderScheme = 'dark' | 'light';

/**
 * Entity decoding, stated rather than inherited — same `defaultProps` gap as
 * the engine flags below. Emails are full of `&nbsp;` and `&mdash;`, and a
 * literal `&mdash;` in the reader is the visible symptom.
 */
const PARSER_OPTIONS = { decodeEntities: true } as const;

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
   * Whether remote images may be fetched.
   *
   * False by default, so a caller that says nothing fetches nothing — a
   * component handed attacker-controlled markup should not phone out on the
   * strength of an omitted prop. The message screen opts in explicitly, and
   * that call site is where the trade-off is written down. When off, each
   * image renders as a muted placeholder and no request is made.
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


/**
 * Which Manrope file each CSS weight resolves to.
 *
 * Manrope has no variable axis here — each weight is its own loaded face, and
 * React Native will not synthesize one from another. `fontWeight: '600'` over
 * the regular face therefore renders regular, with no warning, which is why the
 * app addresses weight by family everywhere else too.
 */
const WEIGHT_FACES: NonNullable<ValueContext['faces']> = {
  regular: font.sans,
  medium: font.sansMedium,
  semibold: font.sansSemibold,
  bold: font.sansBold,
};

/** A muted, non-fetching stand-in for a remote image the reader may not load. */
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

  /**
   * Sanitise + resolve `var()`s once per html change. Attacker input never
   * reaches the renderer unsanitised.
   *
   * The dropped-declaration tally is read here rather than in an effect, and
   * has to be: sanitising happens during render and effects run after it, so
   * anything resetting the tally afterwards would clear the very record it
   * was meant to report.
   */
  const { safeHtml, unreadable } = useMemo(() => {
    if (__DEV__) resetDroppedDeclarations();
    const sanitised = sanitizePipeline(html, mergedVars, WEIGHT_FACES, scheme === 'dark');
    return { safeHtml: sanitised, unreadable: __DEV__ ? droppedDeclarations() : [] };
  }, [html, mergedVars, scheme]);

  /**
   * What this message asked for and did not get.
   *
   * Every gap in the property table used to be found the same way: someone
   * opened a message, saw it render wrong, and asked why. That is a slow and
   * unreliable way to learn about a class of failure that is invisible by
   * construction — a dropped declaration looks exactly like one the sender
   * never wrote. The reader now says so itself, naming the properties it could
   * not read, so the next gap is a line in a log rather than a screenshot.
   *
   * Development only, and property names with counts only: a *value* can carry
   * the content of the message, and no diagnostic is worth putting a body into
   * a log for.
   */
  useEffect(() => {
    if (!__DEV__ || unreadable.length === 0) return;
    console.log(
      `[HtmlReader] declarations this message wanted and the table cannot read: ${unreadable
        .map(({ property, count }) => `${property} x${count}`)
        .join(', ')}`,
    );
  }, [unreadable]);

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
   * The img renderer is the remote-load gate, and it is all-or-nothing on
   * purpose.
   *
   * When images are allowed there is **no override**, so the library's own
   * `img` renderer runs. Delegating to `TDefaultRenderer` instead looks like
   * the same thing and is not: for `img` that is the *generic* element
   * renderer, not the image one, so it lays out an empty box and never
   * fetches anything — an image that silently occupies no space and makes no
   * request, which reads exactly like a network failure.
   *
   * When they are not allowed, every `img` becomes a placeholder and nothing
   * is fetched. The src needs no scheme check here: `allowedSchemes` in the
   * sanitizer already dropped every `src` that was not http(s), and this
   * component never sees unsanitised markup.
   */
  const renderers = useMemo(
    (): CustomTagRendererRecord =>
      allowRemoteImages ? {} : { img: (() => <ImagePlaceholder />) as CustomMixedRenderer },
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
        // A table cell sizes to what is in it, not to an equal share of the
        // row.
        //
        // The engine's own cell style is `flex: 1`, whose flex-basis is zero —
        // so every cell in a row gets the same width no matter what it holds.
        // Email is built out of layout tables, and the commonest thing in one
        // is a *gutter*: `<td width="20">&nbsp;</td>` either side of the
        // column. At a desktop's 600px that is 3% of the row; under an equal
        // split on a phone the two empty gutters took two thirds of the
        // screen, and the message read in a 100-point column down the middle
        // with words breaking mid-syllable.
        //
        // A basis of `auto` makes each cell start from its content: the
        // gutters stay narrow, the column takes what is left, and a row of
        // equals still divides evenly because their contents are equal. Grow
        // and shrink are left as the engine set them, so a cell still fills a
        // row that has room to spare.
        //
        // Its two points of default padding go too. React Native measures a
        // box including its padding, so a cell told to be 20 wide had 16 left
        // for a 20-point icon and the icon overflowed into its neighbour —
        // four of them in a row overlapped each other. Email states the
        // padding it wants on every cell that wants any, so the default is
        // only ever a thumb on the scale.
        th: {
          fontFamily: font.sansSemibold,
          color: theme.ink,
          flexBasis: 'auto' as const,
          padding: 0,
        },
        td: { color: theme.body, flexBasis: 'auto' as const, padding: 0 },
      },
      // Two classes, and the sanitizer wrote both: every class the sender sent
      // is dropped, and these are added where a group has to be laid out as a
      // group. `cm-stack` is a table row too crowded to stay one; `cm-inline`
      // is a run of siblings that asked to share a line — a footer's social
      // icons, which came down the margin as a ladder without it. See
      // `STACK_CLASS` and `INLINE_CLASS`.
      classesStyles: {
        [STACK_CLASS]: { flexDirection: 'column' as const },
        [INLINE_CLASS]: {
          flexDirection: 'row' as const,
          flexWrap: 'wrap' as const,
          alignItems: 'center' as const,
        },
        // The separation is the reader's, not the sender's. What an email
        // writes between such elements is a padding two levels inside each
        // one's own table, and it does not survive being laid out as a flex
        // item — four social icons came out touching, their glyphs
        // overlapping. Eight points is the smallest that reads as a row of
        // icons rather than one smudge, and it reaches nothing but a run this
        // module gathered itself.
        [INLINE_ITEM_CLASS]: { marginRight: 8 },
      },
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
          // Passed explicitly, not left to the library's own defaults.
          // react-native-render-html 6.x sets these through
          // `TRenderEngineProvider.defaultProps`, and React 19 ignores
          // `defaultProps` on a function component — so they arrive as
          // `undefined`, and the engine reads `undefined` as "off" rather than
          // falling back. With UA styles off, `<b>` stops being bold and
          // `<i>` stops being italic, which is most of what email markup is.
          enableUserAgentStyles
          enableCSSInlineProcessing
          emSize={14}
          htmlParserOptions={PARSER_OPTIONS}
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
