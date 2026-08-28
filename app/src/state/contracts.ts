/**
 * What the service modules are, and what each one may ask of the others.
 *
 * Kept in its own file so nothing imports the provider. Each module takes a
 * `Ctx` and returns its slice of `Services`; `services.ts` assembles them.
 *
 * The indirection through `ctx.services` is not ceremony — it is what lets an
 * inbox sync trigger a queue drain, a drain deliver a message, and a delivered
 * message trigger a sync, without any of the three being defined before the
 * others. The provider used to do this with two late-bound refs
 * (`drainRef`, `refreshPublishRef`) assigned halfway down the file.
 */
import { Identity, RecoveryBackup } from '../core';
import { Draft } from '../drafts/drafts';
import { FlagPatch, MailClient, MailSummary } from '../mail/types';
import { Held } from '../outbox/outbox';
import { ContactKey, Keyring } from '../store/keyring';
import { PublishState } from '../store/publishStore';
import { RecipientState } from './recipients';
import { Store } from './store';
import { OpenedMessage, SendInput, SendOutcome } from './types';

/**
 * The provider for the signed-in account.
 *
 * Deliberately not part of `State`: nothing renders it, and swapping it must not
 * cost a re-render of every screen.
 */
export type MailHolder = { current: MailClient | null };

export type SessionService = {
  /** Restore a stored session on launch. `isCancelled` guards a unmounted provider. */
  boot(isCancelled: () => boolean): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Drop a session the provider will no longer honour. True if that is what happened. */
  handleAuthLoss(e: unknown): boolean;
};

export type MailboxService = {
  refreshInbox(): Promise<void>;
  openMessage(summary: MailSummary): Promise<OpenedMessage>;
  setFlags(id: string, change: FlagPatch): Promise<void>;
  toggleStar(id: string): Promise<void>;
  setUnread(id: string, unread: boolean): Promise<void>;
  archiveMessage(id: string): Promise<void>;
};

export type ContactsService = {
  /** Persist a new keyring and make it visible to concurrent async work at once. */
  commitKeyring(next: Keyring): Promise<Keyring>;
  discover(emails: string[]): Promise<Keyring>;
  discoverRecipients(emails: string[]): Promise<RecipientState[]>;
  importKey(armored: string, name?: string): Promise<ContactKey>;
  forgetKey(email: string): Promise<void>;
  markVerified(email: string, confirmedFingerprint: string): Promise<void>;
  safetyNumberFor(email: string): Promise<string>;
};

export type IdentityService = {
  createIdentity(): Promise<Identity>;
  exportRecovery(): Promise<RecoveryBackup>;
  restoreFromRecovery(blob: string, code: string): Promise<Identity>;
};

export type PublishService = {
  publishOwnKey(): Promise<PublishState>;
  declinePublish(): Promise<PublishState>;
  /** Notice that a pending publication has been confirmed. Cheap when it is not. */
  refreshPublish(): Promise<void>;
};

export type SendService = {
  canSendEncrypted(): { allowed: boolean; reason?: string };
  /** Encrypt and send, or hold — never plaintext. The whole of rule 1 lives here. */
  deliver(input: SendInput): Promise<SendOutcome>;
  sendEncrypted(input: SendInput): Promise<SendOutcome>;
  sendPlain(input: { to: string[]; subject: string; body: string; inReplyTo?: string; references?: string[] }): Promise<void>;
};

export type SchedulerService = {
  /** Put a message in the outbox to wait — for a key, or for its send time. */
  hold(item: Held): Promise<void>;
  scheduleSend(input: SendInput & { sendAt: string }): Promise<void>;
  cancelScheduled(id: string): Promise<void>;
  sendScheduledNow(id: string): Promise<SendOutcome | null>;
  /** Release messages that were waiting for a recipient's key. */
  drainHeld(): Promise<void>;
  /** One scheduler tick: drain the held queue, then send anything now due. */
  run(): Promise<void>;
};

export type DraftsService = {
  saveDraft(draft: Draft): Promise<void>;
  deleteDraft(id: string): Promise<void>;
};

export type Services = {
  session: SessionService;
  mailbox: MailboxService;
  contacts: ContactsService;
  identity: IdentityService;
  publish: PublishService;
  send: SendService;
  scheduler: SchedulerService;
  drafts: DraftsService;
};

export type Ctx = {
  store: Store;
  mail: MailHolder;
  /**
   * The other services. Populated by `createServices` before anything can run,
   * so a module may hold this object at construction and dereference the
   * service it needs at call time.
   */
  services: Services;
};

/** Error text for a caught `unknown`, which is all a banner ever needs. */
export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
