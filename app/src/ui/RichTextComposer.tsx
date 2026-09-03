/**
 * RichTextComposer — a generalized WYSIWYG email composer.
 *
 * This is a standalone component: no `useApp()`, no provider calls. It reads
 * design tokens like every other component, so it is a drop-in anywhere a
 * compose surface needs rich text. Wiring it into a screen is a separate change.
 *
 * The engine is @10play/tentap-editor, a Tiptap webview that runs its own
 * headless ProseMirror instance and bridges commands to native. Everything it
 * writes is clean semantic HTML — `<p>`, `<strong>`, `<em>`, `<s>`,
 * `<ul>/<ol>/<li>`, `<blockquote>`, `<a>`, `<hr>` — which is exactly the shape
 * `html/sanitize.ts`'s allowlist accepts, so composer output round-trips
 * through `HtmlReader` untouched.
 *
 * Vertical rule: **the webview never scrolls itself.** `dynamicHeight` makes
 * the container hug the document's measured height, so the enclosing screen
 * scrolls the whole composer as one unit — the same contract HtmlReader keeps
 * on the read side. The toolbar is the only fixed-height part.
 *
 * The webview's content is styled by injecting our own stylesheet once the
 * editor reports ready (`injectCSS`), because the engine's default theme is a
 * light one and this app's ground is always dark. The placeholder is styled the
 * same way, from `color.inkFaint`.
 *
 * Keyboard: when `keyboardAvoider` is on (default) the component wraps itself
 * in a `KeyboardAvoidingView` and lets the engine's `avoidIosKeyboard` keep the
 * caret in view. A caller that already owns keyboard avoidance (a compose
 * screen with its own KAV) passes `keyboardAvoider={false}` and the editor
 * defers to it.
 *
 * ## Horizontal rule and the default engine
 *
 * The default web bundle ships a fixed set of Tiptap extensions and exposes no
 * editor handle, so there is no `setHorizontalRule` bridge and no reachable
 * instance to call one on. The toolbar's rule button therefore goes through a
 * guarded `injectJS` that reaches the ProseMirror view via the DOM
 * (`document.querySelector('.ProseMirror').pmViewDesc.view`) and dispatches a
 * horizontal-rule node — but only when the schema actually has that node. On
 * the stock engine the schema has none, the guard is false, and nothing
 * happens. Supplying a `customSource` web bundle that ships the horizontal rule
 * extension is what makes the button live; this component degrades honestly
 * rather than pretending.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { RichText, useBridgeState, useEditorBridge } from '@10play/tentap-editor';

import { color, font, radius, space, type } from '../theme';
import { useAccent } from './appearance';
import { IconName } from './Icon';
import { Field, IconButton, Input, PrimaryButton, SecondaryButton, Sheet } from './primitives';

/** The formatting tools a toolbar can carry. Order in `toolbar` is render order. */
export type RichTextFormat =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'bulletList'
  | 'orderedList'
  | 'blockquote'
  | 'link'
  | 'hr';

const DEFAULT_TOOLBAR: RichTextFormat[] = [
  'bold',
  'italic',
  'strike',
  'bulletList',
  'orderedList',
  'blockquote',
  'link',
  'hr',
];

export type RichTextComposerProps = {
  /** Initial HTML content. Set on mount only; live updates remount the component. */
  initialValue?: string;
  /** Clean semantic HTML, fired whenever the content changes. */
  onChangeHTML?: (html: string) => void;
  /** Shown in the empty editor. Defaults to the engine's placeholder text. */
  placeholder?: string;
  /** Read-only render when false. */
  editable?: boolean;
  autoFocus?: boolean;
  /** Smallest the editor area can be when empty. Default 120 (matches `Input` big). */
  minHeight?: number;
  /** Which tools to show, in order. Defaults to all of them. */
  toolbar?: RichTextFormat[];
  /**
   * When true (default) the composer manages its own keyboard avoidance: a
   * KeyboardAvoidingView on iOS plus the engine's `avoidIosKeyboard`. Pass
   * `false` when the caller already wraps the composer in a keyboard-aware
   * container (ComposeScreen has its own KAV).
   */
  keyboardAvoider?: boolean;
  /** Offset for the KAV — a navigation header's height when one is present. */
  keyboardVerticalOffset?: number;
  onFocus?: () => void;
  onBlur?: () => void;
  style?: ViewStyle;
};

/** Reach the ProseMirror editor view from injected JS. Standard DOM handle. */
const PM_VIEW = `(() => {
  const el = document.querySelector('.ProseMirror');
  return el && el.pmViewDesc && el.pmViewDesc.view;
})()`;

export function RichTextComposer({
  initialValue,
  onChangeHTML,
  placeholder = 'Write your message…',
  editable = true,
  autoFocus = false,
  minHeight = 120,
  toolbar = DEFAULT_TOOLBAR,
  keyboardAvoider = true,
  keyboardVerticalOffset = 0,
  onFocus,
  onBlur,
  style,
}: RichTextComposerProps) {
  const accent = useAccent();
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');
  const linkInput = useRef<React.ElementRef<typeof Input>>(null);

  const editor = useEditorBridge({
    initialContent: initialValue,
    autofocus: autoFocus,
    dynamicHeight: true,
    editable,
    avoidIosKeyboard: keyboardAvoider,
    theme: {
      // The webview's native background — the engine's default is white and
      // this app's ground is always dark. Content colors are injected below.
      webview: { backgroundColor: color.surface },
    },
  });

  const state = useBridgeState(editor);
  const isReady = !!state.isReady;

  /** Called with the serialized HTML only when the content actually changes. */
  const htmlCb = useRef(onChangeHTML);
  htmlCb.current = onChangeHTML;
  useEffect(() => {
    // `_subscribeToContentUpdate` fires exactly on content edits — not on
    // every selection/focus nudge (which is what the state subscription would
    // hand us). Serialize once per edit.
    return editor._subscribeToContentUpdate(() => {
      editor
        .getHTML()
        .then((html) => htmlCb.current?.(html))
        .catch(() => {
          /* a lost race during an edit must not break typing */
        });
    });
  }, [editor]);

  /* ---- the injected stylesheet — the webview's entire look ---- */

  const editorCss = useMemo(() => {
    const linkUnderline = accent;
    return [
      // Placeholder: `.is-editor-empty:first-child::before` is the rule the
      // engine already ships; re-declare it with our color so the empty state
      // reads in app tokens.
      `.is-editor-empty:first-child::before { color: ${color.inkFaint} !important; }`,
      `.ProseMirror { background-color: ${color.surface}; color: ${color.ink}; min-height: ${minHeight}px; outline: none; }`,
      `.ProseMirror p { margin: 0; padding: 0; }`,
      `.ProseMirror blockquote { border-left: 3px solid ${color.line}; margin: ${space.sm}px 0; padding-left: ${space.md}px; color: ${color.inkDim}; }`,
      `.ProseMirror a { color: ${linkUnderline}; }`,
      `.ProseMirror pre { background-color: ${color.ground2}; color: ${color.ink}; border-radius: ${radius.sm}px; padding: ${space.md}px; font-family: ${font.mono}; }`,
      `.ProseMirror code { font-family: ${font.mono}; color: ${color.inkDim}; }`,
      `.ProseMirror hr { border: none; border-top: 1px solid ${color.line}; margin: ${space.md}px 0; }`,
    ].join('\n');
  }, [accent, minHeight]);

  useEffect(() => {
    if (!isReady) return;
    editor.injectCSS(editorCss, 'cm-composer');
  }, [editor, isReady, editorCss]);

  useEffect(() => {
    if (!isReady) return;
    editor.setPlaceholder(placeholder);
  }, [editor, isReady, placeholder]);

  /* ---- focus / blur are bridge state, not WebView events ---- */

  const wasFocused = useRef(state.isFocused);
  useEffect(() => {
    const f = !!state.isFocused;
    if (f === wasFocused.current) return;
    wasFocused.current = f;
    if (f) onFocus?.();
    else onBlur?.();
  }, [state.isFocused, onFocus, onBlur]);

  /* ---- editable follows the prop at runtime ---- */

  useEffect(() => {
    if (!isReady) return;
    editor.setEditable(editable);
  }, [editor, isReady, editable]);

  /* ---- hyperlink sheet ---- */

  const openLink = useCallback(() => {
    setLinkDraft(state.activeLink ?? '');
    setLinkOpen(true);
  }, [state.activeLink]);

  const applyLink = useCallback(() => {
    const url = linkDraft.trim();
    if (url) editor.setLink(url);
    setLinkOpen(false);
  }, [editor, linkDraft]);

  const removeLink = useCallback(() => {
    editor.setLink('');
    setLinkOpen(false);
  }, [editor]);

  /* ---- horizontal rule: guarded, because the default engine has no schema ---- */

  const insertRule = useCallback(() => {
    editor.injectJS(`
      const view = ${PM_VIEW};
      if (view && view.state.schema.nodes.horizontal_rule) {
        view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.horizontal_rule.create()).scrollIntoView());
        view.focus();
      }
      true;
    `);
  }, [editor]);

  /* ---- toolbar ---- */

  const items = useMemo(() => {
    const enabled = editable;
    return toolbar.map((f) => {
      switch (f) {
        case 'bold':
          return { icon: 'bold' as IconName, label: 'Bold', active: state.isBoldActive, onPress: () => editor.toggleBold() };
        case 'italic':
          return { icon: 'italic' as IconName, label: 'Italic', active: state.isItalicActive, onPress: () => editor.toggleItalic() };
        case 'strike':
          return { icon: 'strike' as IconName, label: 'Strikethrough', active: state.isStrikeActive, onPress: () => editor.toggleStrike() };
        case 'bulletList':
          return { icon: 'list-ul' as IconName, label: 'Bullet list', active: state.isBulletListActive, onPress: () => editor.toggleBulletList() };
        case 'orderedList':
          return { icon: 'list-ol' as IconName, label: 'Numbered list', active: state.isOrderedListActive, onPress: () => editor.toggleOrderedList() };
        case 'blockquote':
          return { icon: 'quote' as IconName, label: 'Blockquote', active: state.isBlockquoteActive, onPress: () => editor.toggleBlockquote() };
        case 'link':
          return { icon: 'link' as IconName, label: 'Hyperlink', active: state.isLinkActive, onPress: openLink };
        case 'hr':
          return { icon: 'hr' as IconName, label: 'Horizontal rule', active: false, onPress: insertRule };
      }
    });
  }, [toolbar, state, editor, editable, openLink, insertRule]);

  const wrap = (node: React.ReactNode) =>
    keyboardAvoider ? (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardVerticalOffset}
        style={[s.wrap, style]}
      >
        {node}
      </KeyboardAvoidingView>
    ) : (
      <View style={[s.wrap, style]}>{node}</View>
    );

  return wrap(
    <>
      {editable && items.length > 0 ? (
        <View style={s.toolbarRow}>
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.toolbar}
          >
            {items.map((item) => (
              <IconButton
                key={item.label}
                icon={item.icon}
                label={item.label}
                onPress={item.onPress}
                tint={item.active ? accent : color.inkDim}
                size={34}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}
      <RichText
        editor={editor}
        // dynamicHeight makes the container hug the document; flex makes the
        // WebView fill whatever the container measured.
        style={{ flex: 1, opacity: isReady ? 1 : 0 }}
      />
      <Sheet visible={linkOpen} onClose={() => setLinkOpen(false)} title="Add a link">
        <Field label="URL">
          <Input
            ref={linkInput}
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
          <SecondaryButton title="Remove" onPress={removeLink} disabled={!state.isLinkActive} />
          <PrimaryButton title="Apply" onPress={applyLink} disabled={!linkDraft.trim()} />
        </View>
      </Sheet>
    </>,
  );
}

const s = StyleSheet.create({
  wrap: {
    alignSelf: 'stretch',
  },
  toolbarRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
    backgroundColor: color.surfaceRaised,
    borderTopLeftRadius: radius.sm,
    borderTopRightRadius: radius.sm,
  },
  toolbar: {
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
    gap: space.xs,
  },
  sheetActions: {
    flexDirection: 'row',
    gap: space.md,
    marginTop: space.lg,
    justifyContent: 'flex-end',
  },
});
