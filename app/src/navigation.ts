export type RootStackParamList = {
  Inbox: undefined;
  Message: { id: string };
  Conversation: { threadId: string };
  Compose: {
    to?: string[];
    subject?: string;
    draftId?: string;
    quotedBody?: string;
    inReplyTo?: string;
    references?: string[];
  };
  Drafts: undefined;
  Scheduled: undefined;
  Keys: undefined;
  Recovery: undefined;
};
