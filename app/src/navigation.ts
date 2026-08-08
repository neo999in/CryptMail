export type RootStackParamList = {
  Inbox: undefined;
  Message: { id: string };
  Conversation: { threadId: string };
  Compose: { to?: string; subject?: string; draftId?: string };
  Drafts: undefined;
  Scheduled: undefined;
  Keys: undefined;
  Recovery: undefined;

  /** Simple UI (docs/simple-ui-plan.md). Mounted instead of the screens above. */
  SimpleInbox: undefined;
  SimpleMessage: { id: string };
  SimpleCompose: { to?: string } | undefined;
  SimpleKeys: undefined;
};
