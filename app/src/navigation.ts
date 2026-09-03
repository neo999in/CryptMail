import type { DrawerScreenProps } from '@react-navigation/drawer';
import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { Attachment } from './mail/attachment';
import type { OriginRect } from './ui/expand';

/**
 * `Home` is a drawer holding one screen, and **every drawer row is a
 * destination on that one screen** — Sent and Archive as much as Bills and Junk
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
  };
  Conversation: { threadId: string };
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
  Recovery: undefined;
  Settings: undefined;
  Appearance: undefined;
};

/**
 * What the home screen and every destination body is handed: the drawer (for
 * `openDrawer`) composed with the stack (for the message, compose and settings
 * pushes). One type, because a destination body is not its own route.
 */
export type HomeProps = CompositeScreenProps<
  DrawerScreenProps<InboxDrawerParamList, 'Inbox'>,
  NativeStackScreenProps<RootStackParamList>
>;
