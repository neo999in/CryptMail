import type { DrawerScreenProps } from '@react-navigation/drawer';
import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { Attachment } from './mail/attachment';
import type { AccountId } from './store/accountScope';
import type { OriginRect } from './ui/expand';

/**
 * `Home` is a drawer holding one screen, and **every drawer row is a
 * destination on that one screen** — Sent and Archive as much as Bills and Spam
 * (`ui/destination.tsx`, `screens/HomeScreen.tsx`). What the drawer opens is
 * never a push, so the bar never swaps its account avatar for a back arrow.
 * Only genuine detail screens — a message, a compose, settings — are stack
 * routes. The drawer's own content is `screens/CategoryDrawer.tsx`.
 */
export type InboxDrawerParamList = {
  Inbox: undefined;
};

export type RootStackParamList = {
  Home: NavigatorScreenParams<InboxDrawerParamList> | undefined;
  Message: {
    id: string;
    /** The tapped row's rectangle, so closing the mail collapses back onto it
     *  rather than sliding back down. Absent from every other way in — see
     *  `ui/expand.tsx`. */
    origin?: OriginRect;
    /** Height of the top bar the opening screen keeps on show above the mail.
     *  The inbox passes its aurora bar; a screen with none passes nothing. */
    topInset?: number;
    /** How much of that bar is still band *below* `topInset` — the strip the
     *  message may leave unpainted so its own header stands on the aurora
     *  rather than on the ground. Absent wherever `topInset` is. */
    bandInset?: number;
  };
  /** A thread opens the way a message does — out of its row — so it carries
   *  the same three optional params, meaning the same things. */
  Conversation: { threadId: string; origin?: OriginRect; topInset?: number; bandInset?: number };
  Compose: {
    to?: string[];
    subject?: string;
    draftId?: string;
    quotedBody?: string;
    inReplyTo?: string;
    references?: string[];
    /** Files carried in from a forward. Base64 already in memory, never re-read. */
    attachments?: Attachment[];
  };
  Keys: undefined;
  /** The address book and per-contact trust dashboard (`contacts/contacts.ts`). */
  Recovery: undefined;
  Settings: undefined;
  Appearance: undefined;
  /** How mail behaves, as against how it looks. Swipe gestures live under it. */
  Mail: undefined;
  /** What each swipe direction does, and a live preview of both. */
  SwipeOptions: undefined;
  /** The active mailbox's local labels: make, rename, delete. Settings → Mail. */
  Labels: undefined;
  /** The active mailbox's filters & rules. Settings → Mail. */
  Rules: undefined;
  /** Saved snippets Compose can insert, shared by every mailbox. Settings → Mail. */
  CannedReplies: undefined;
  /**
   * One rule, new or existing.
   *
   * `id` edits a saved rule. Without it the editor starts a new one, seeded
   * from `from` and `subject` when it was opened as "Create rule from this
   * message" — the subject only when this device could read it.
   */
  RuleEdit: { id?: string; from?: string; subject?: string };
  /**
   * The animated swipe glyphs on a bench, `__DEV__` only.
   *
   * Registered in the release build too — a route that only exists in one build
   * is a navigation type that differs between them — but nothing links to it
   * outside `__DEV__`, so there is no way in.
   */
  SwipeGlyphDemo: undefined;
  /** The connected mailboxes. Switching stays in the drawer; managing is here. */
  Accounts: undefined;
  /** One mailbox's own name, avatar, image policy, sync window and storage. */
  Account: { id: AccountId };
};

/**
 * Pop one screen, if there is one under this.
 *
 * A second tap on a back arrow while the first pop is still animating
 * dispatches `GO_BACK` to a stack with nothing left to pop, which React
 * Navigation reports as an unhandled action. The first pop has already taken
 * the route off the stack, so checking here makes the extra tap a no-op.
 */
export function back(navigation: { canGoBack(): boolean; goBack(): void }): void {
  if (navigation.canGoBack()) navigation.goBack();
}

/**
 * What the home screen and every destination body is handed: the drawer (for
 * `openDrawer`) composed with the stack (for the message, compose and settings
 * pushes). One type, because a destination body is not its own route.
 */
export type HomeProps = CompositeScreenProps<
  DrawerScreenProps<InboxDrawerParamList, 'Inbox'>,
  NativeStackScreenProps<RootStackParamList>
>;
