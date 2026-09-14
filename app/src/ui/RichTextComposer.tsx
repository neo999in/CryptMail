/**
 * Rich-text compose: one editing session, and the two things drawn from it.
 *
 * ```tsx
 * <RichTextSession initialValue={html} onChangeHTML={…}>
 *   <ScrollView>… <RichTextEditor /> …</ScrollView>
 *   <RichTextToolbar onClose={…} />
 * </RichTextSession>
 * ```
 *
 * Split because the two live in different places on the screen. The editor is
 * part of the message and scrolls with it; the toolbar is pinned to the bottom
 * edge, where it rides on top of the keyboard, the way a mail app's formatting
 * bar does. A single component could only put its toolbar next to its editor.
 * The session owns the bridge and hands both halves the same one through
 * context. Remounting the session (a `key`) is how a caller replaces the
 * document with one the editor did not write itself.
 *
 * No `useApp()` and no provider calls: ComposeScreen mounts it when formatting
 * is on, and `compose/richText.ts` derives the text alternative from what it
 * writes.
 *
 * The engine is @10play/tentap-editor, a Tiptap webview. What it writes is
 * clean semantic HTML — `<p>`, `<h1>/<h2>`, `<strong>`, `<em>`, `<u>`, `<s>`,
 * `<span style="color">`, `<ul>/<ol>/<li>`, `<blockquote>`, `<a>` — all of which
 * `html/sanitize.ts` accepts, so composer output reads back through `HtmlReader`.
 *
 * ## Looking like the rest of the message
 *
 * The editor is borderless on the ground, in the same ink, size and line
 * height as Compose's plain body `Input`, so turning formatting on changes
 * the tools and not the page. The webview cannot load the app's Manrope
 * faces (they are native assets), so it writes in the system sans.
 *
 * Its stylesheet is injected once the engine reports ready, and every rule is
 * scoped `#root div .ProseMirror`: the engine's own sheet sets
 * `#root div .ProseMirror { min-height: 100% }`, an ID selector outranks a bare
 * class, and a rule that loses leaves the document one line tall — which
 * `dynamicHeight` then shrinks the webview to. That shipped once.
 *
 * **The webview never scrolls itself.** `dynamicHeight` makes it hug the
 * document, so the screen scrolls editor and fields as one — the contract
 * HtmlReader keeps on the read side.
 */
import React, { createContext, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BridgeState, EditorBridge, RichText, useBridgeState, useEditorBridge } from '@10play/tentap-editor';

import { color, font, messageTextColors, radius, space, type } from '../theme';
import { useAccent } from './appearance';
import { Icon, IconName } from './Icon';
import { Field, IconButton, Input, PressableRow, PrimaryButton, SecondaryButton, Sheet } from './primitives';

/** What a caller can do to the document from outside it. */
export type RichTextSessionHandle = {
  /**
   * Put text in at the caret, as the user would by pasting it — so a multi-line
   * snippet becomes paragraphs rather than one line with newlines in it. Before
   * the editor has been focused the caret is at the start of the document.
   */
  insertText(text: string): void;
};

type Session = { editor: EditorBridge; state: BridgeState; ready: boolean };

const SessionContext = createContext<Session | null>(null);

function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('RichTextEditor and RichTextToolbar must be inside a RichTextSession.');
  return session;
}

/** Reach the ProseMirror editor view from injected JS. Standard DOM handle. */
const PM_VIEW = `(() => {
  const el = document.querySelector('.ProseMirror');
  return el && el.pmViewDesc && el.pmViewDesc.view;
})()`;

/** The body `Input` this editor stands in for: `input` + `inputBig` in primitives. */
const BODY_FONT_SIZE = 15;
const BODY_LINE_HEIGHT = 22;

export function RichTextSession({
  ref,
  initialValue,
  onChangeHTML,
  placeholder,
  autoFocus = false,
  minHeight = 200,
  children,
}: {
  ref?: React.Ref<RichTextSessionHandle>;
  /** The document. Read on mount only; remount the session to replace it. */
  initialValue?: string;
  /** Fired with the serialized HTML on every edit to the content. */
  onChangeHTML?: (html: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Smallest the editor is when empty, so the page is not a one-line target. */
  minHeight?: number;
  children: React.ReactNode;
}) {
  const accent = useAccent();
  const editor = useEditorBridge({
    initialContent: initialValue,
    autofocus: autoFocus,
    dynamicHeight: true,
    // ComposeScreen owns keyboard avoidance.
    avoidIosKeyboard: false,
    // The native view under the page; the engine's default is white.
    theme: { webview: { backgroundColor: color.ground } },
  });
  const state = useBridgeState(editor);
  const ready = !!state.isReady;

  // `_subscribeToContentUpdate` fires on content edits only — not on every
  // selection or focus nudge, which the state subscription would also deliver.
  const htmlCb = useRef(onChangeHTML);
  htmlCb.current = onChangeHTML;
  useEffect(
    () =>
      editor._subscribeToContentUpdate(() => {
        editor
          .getHTML()
          .then((html) => htmlCb.current?.(html))
          .catch(() => {
            /* a lost race during an edit must not break typing */
          });
      }),
    [editor],
  );

  const css = useMemo(() => {
    const PM = '#root div .ProseMirror';
    return [
      `body { background-color: ${color.ground}; }`,
      `.is-editor-empty:first-child::before { color: ${color.inkFaint} !important; }`,
      `${PM} { background-color: ${color.ground}; color: ${color.ink}; min-height: ${minHeight}px; outline: none;` +
        ` padding: 0; font-family: sans-serif; font-size: ${BODY_FONT_SIZE}px; line-height: ${BODY_LINE_HEIGHT}px; caret-color: ${accent}; }`,
      `${PM} p { margin: 0; padding: 0; }`,
      `${PM} h1 { font-size: 24px; line-height: 30px; margin: ${space.sm}px 0 ${space.xs}px; }`,
      `${PM} h2 { font-size: 19px; line-height: 26px; margin: ${space.sm}px 0 ${space.xs}px; }`,
      `${PM} ul, ${PM} ol { margin: ${space.xs}px 0; padding-left: ${space.xl}px; }`,
      `${PM} blockquote { border-left: 3px solid ${color.line}; margin: ${space.sm}px 0; padding-left: ${space.md}px; color: ${color.inkDim}; }`,
      `${PM} a { color: ${accent}; }`,
      `${PM} code { font-family: monospace; color: ${color.inkDim}; }`,
    ].join('\n');
  }, [accent, minHeight]);

  useEffect(() => {
    if (ready) editor.injectCSS(css, 'cm-composer');
  }, [editor, ready, css]);

  useEffect(() => {
    if (ready && placeholder) editor.setPlaceholder(placeholder);
  }, [editor, ready, placeholder]);

  useImperativeHandle(
    ref,
    () => ({
      insertText(text: string) {
        // JSON.stringify is the escaping: the text lands in the script as a
        // string literal and can never be read as code.
        editor.injectJS(`
          const view = ${PM_VIEW};
          if (view) {
            const text = ${JSON.stringify(text)};
            if (!(view.pasteText && view.pasteText(text))) view.dispatch(view.state.tr.insertText(text).scrollIntoView());
            view.focus();
          }
          true;
        `);
      },
    }),
    [editor],
  );

  const session = useMemo(() => ({ editor, state, ready }), [editor, state, ready]);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** The document, borderless, where the plain body `Input` would be. */
export function RichTextEditor() {
  const { editor, ready } = useSession();
  // Hidden until the stylesheet can land: before it, the engine paints a white
  // page with black text for a frame.
  return <RichText editor={editor} style={{ flex: 1, opacity: ready ? 1 : 0 }} />;
}

type Tool = { icon: IconName; label: string; active: boolean; onPress: () => void };

/**
 * The formatting bar, pinned to the bottom of the screen.
 *
 * Close, then text size, then the marks, then everything else in a row that
 * scrolls sideways. Size, colour and link each open a `Sheet` rather than a
 * popover: a menu the keyboard can cover is one a thumb cannot reach.
 */
export function RichTextToolbar({ onClose, bottomInset = 0 }: { onClose: () => void; bottomInset?: number }) {
  const { editor, state } = useSession();
  const accent = useAccent();
  const [sheet, setSheet] = useState<'size' | 'color' | 'link' | null>(null);
  const [linkDraft, setLinkDraft] = useState('');

  const tint = (active: boolean) => (active ? accent : color.inkDim);

  const marks: Tool[] = [
    { icon: 'bold', label: 'Bold', active: !!state.isBoldActive, onPress: () => editor.toggleBold() },
    { icon: 'italic', label: 'Italic', active: !!state.isItalicActive, onPress: () => editor.toggleItalic() },
    { icon: 'underline', label: 'Underline', active: !!state.isUnderlineActive, onPress: () => editor.toggleUnderline() },
  ];
  const blocks: Tool[] = [
    { icon: 'strike', label: 'Strikethrough', active: !!state.isStrikeActive, onPress: () => editor.toggleStrike() },
    { icon: 'list-ul', label: 'Bullet list', active: !!state.isBulletListActive, onPress: () => editor.toggleBulletList() },
    { icon: 'list-ol', label: 'Numbered list', active: !!state.isOrderedListActive, onPress: () => editor.toggleOrderedList() },
    { icon: 'quote', label: 'Quote', active: !!state.isBlockquoteActive, onPress: () => editor.toggleBlockquote() },
    {
      icon: 'link',
      label: 'Link',
      active: !!state.isLinkActive,
      onPress: () => {
        setLinkDraft(state.activeLink ?? '');
        setSheet('link');
      },
    },
  ];

  const level = state.headingLevel;
  const setSize = (next: 1 | 2 | undefined) => {
    setSheet(null);
    if (next === level) return;
    // `toggleHeading` toggles: turning the current level off is how a heading
    // goes back to a paragraph.
    if (next === undefined) {
      if (level) editor.toggleHeading(level as 1 | 2);
    } else editor.toggleHeading(next);
  };

  const activeColor = state.activeColor;
  const setTextColor = (value: string | undefined) => {
    setSheet(null);
    if (value) editor.setColor(value);
    else editor.unsetColor();
  };

  const applyLink = () => {
    const url = linkDraft.trim();
    if (url) editor.setLink(url);
    setSheet(null);
  };

  const tool = (t: Tool) => (
    <IconButton
      key={t.label}
      icon={t.icon}
      label={t.label}
      onPress={t.onPress}
      selected={t.active}
      tint={tint(t.active)}
      size={44}
      glyph={24}
      weight={2.1}
    />
  );

  return (
    <View style={[s.bar, { paddingBottom: bottomInset + space.xs }]}>
      <IconButton icon="close" label="Hide formatting" onPress={onClose} size={44} glyph={24} weight={2.1} />
      <View style={s.divider} />
      {tool({ icon: 'text-size', label: 'Text size', active: !!level, onPress: () => setSheet('size') })}
      <View style={s.divider} />
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.tools}
      >
        {marks.map(tool)}
        <Pressable
          accessibilityLabel={`Text colour, ${messageTextColors.find((c) => c.value === activeColor)?.label ?? 'default'}`}
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => setSheet('color')}
          style={({ pressed }) => [s.colorTool, pressed && { backgroundColor: color.iconPress }]}
        >
          <Icon name="text-color" size={24} color={color.inkDim} strokeWidth={2.1} />
          {/* The colour itself, which is the point of the control. Default ink
              when none is set, so an empty bar never reads as "no colour". */}
          <View style={[s.colorBar, { backgroundColor: activeColor ?? color.inkDim }]} />
        </Pressable>
        {blocks.map(tool)}
      </ScrollView>

      <Sheet visible={sheet === 'size'} onClose={() => setSheet(null)} title="Text size" bottomInset={bottomInset}>
        {(
          [
            { label: 'Title', value: 1, style: s.sizeTitle },
            { label: 'Heading', value: 2, style: s.sizeHeading },
            { label: 'Normal', value: undefined, style: s.sizeNormal },
          ] as const
        ).map((option) => {
          const selected = level === option.value || (!level && option.value === undefined);
          return (
            <PressableRow
              key={option.label}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => setSize(option.value)}
              style={s.sheetRow}
            >
              <Text style={[option.style, { flex: 1 }]}>{option.label}</Text>
              {selected ? <Icon name="check" size={18} color={accent} /> : null}
            </PressableRow>
          );
        })}
      </Sheet>

      <Sheet visible={sheet === 'color'} onClose={() => setSheet(null)} title="Text colour" bottomInset={bottomInset}>
        <View style={s.swatches}>
          <Swatch label="Default" value={undefined} selected={!activeColor} onPress={() => setTextColor(undefined)} />
          {messageTextColors.map((c) => (
            <Swatch
              key={c.value}
              label={c.label}
              value={c.value}
              selected={activeColor === c.value}
              onPress={() => setTextColor(c.value)}
            />
          ))}
        </View>
      </Sheet>

      <Sheet visible={sheet === 'link'} onClose={() => setSheet(null)} title="Add a link" bottomInset={bottomInset}>
        <Field label="URL">
          <Input
            value={linkDraft}
            onChangeText={setLinkDraft}
            placeholder="https://"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            onSubmitEditing={applyLink}
          />
        </Field>
        <View style={s.sheetActions}>
          <SecondaryButton
            title="Remove"
            onPress={() => {
              editor.setLink('');
              setSheet(null);
            }}
            disabled={!state.isLinkActive}
          />
          <PrimaryButton title="Apply" onPress={applyLink} disabled={!linkDraft.trim()} />
        </View>
      </Sheet>
    </View>
  );
}

/** One colour to write in. Selection shows as a check, not only as a ring. */
function Swatch({
  label,
  value,
  selected,
  onPress,
}: {
  label: string;
  value: string | undefined;
  selected: boolean;
  onPress: () => void;
}) {
  const accent = useAccent();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={s.swatch}
    >
      <View
        style={[
          s.swatchDot,
          { backgroundColor: value ?? color.ink, borderColor: selected ? accent : color.borderStrong },
        ]}
      >
        {selected ? <Icon name="check" size={16} color={value ? color.ink : color.ground} strokeWidth={2.6} /> : null}
      </View>
      <Text style={s.swatchLabel}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  // A bar, so it lifts off the ground on `surface` like Compose's other bars.
  bar: {
    alignItems: 'center',
    backgroundColor: color.surface,
    borderTopColor: color.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    paddingHorizontal: space.xs,
    paddingTop: space.xs,
  },
  divider: { alignSelf: 'stretch', backgroundColor: color.line, marginHorizontal: space.xs, marginVertical: space.sm, width: 1 },
  tools: { alignItems: 'center', gap: space.xs, paddingRight: space.sm },
  colorTool: { alignItems: 'center', borderRadius: radius.pill, height: 44, justifyContent: 'center', width: 44 },
  colorBar: { borderRadius: radius.xs, height: 5, marginTop: -2, width: 20 },

  sheetRow: { alignItems: 'center', borderRadius: radius.sm, flexDirection: 'row', paddingHorizontal: 6, paddingVertical: 12 },
  sizeTitle: { color: color.ink, fontFamily: font.sansBold, fontSize: 22 },
  sizeHeading: { color: color.ink, fontFamily: font.sansSemibold, fontSize: 18 },
  sizeNormal: { ...type.settingsRow, color: color.ink },

  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, paddingBottom: space.sm },
  swatch: { alignItems: 'center', gap: space.xs, width: 64 },
  swatchDot: {
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 2,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  swatchLabel: { color: color.inkDim, fontFamily: font.sans, fontSize: 12 },

  sheetActions: { flexDirection: 'row', gap: space.md, justifyContent: 'flex-end', marginTop: space.lg },
});
