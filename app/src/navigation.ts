import type { NavigatorScreenParams } from '@react-navigation/native';

/**
 * `Home` is a drawer that holds only the inbox; every detail screen stays on the
 * parent stack, so nothing but the inbox lives behind the drawer gesture. The
 * category drawer's content is `screens/CategoryDrawer.tsx`.
 */
export type InboxDrawerParamList = {
  Inbox: undefined;
};

export type RootStackParamList = {
  Home: NavigatorScreenParams<InboxDrawerParamList> | undefined;
  Message: { id: string };
  Conversation: { threadId: string };
  Compose: { to?: string; subject?: string; draftId?: string };
  Drafts: undefined;
  Scheduled: undefined;
  Keys: undefined;
  Recovery: undefined;
};
