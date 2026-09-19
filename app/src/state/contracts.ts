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
import { ImapSignIn, Provider, Session } from '../auth';
import { Discovered } from '../mail/autoconfig';
import { ImapAccount } from '../mail/imap';
import { Identity, RecoveryBackup } from '../core';
import { Draft } from '../drafts/drafts';
import { Label, LabelChange } from '../labels/labels';
import { NotificationTap } from '../notifications/os';
import { FlagPatch, MailClient, MailSummary } from '../mail/types';
import { Held } from '../outbox/outbox';
import { Rule } from '../rules/rules';
import { AccountId, AccountSettings } from '../store/accountScope';
import { ContactKey, Keyring } from '../store/keyring';
import { NotificationPrefs } from '../store/notifyStore';
import { PublishState } from '../store/publishStore';
import { StorageUsage } from '../store/storageUsage';
import { RecipientState } from './recipients';
import { userMessage } from '../lib/errors';
import { Store } from './store';
import {
  ExportProgress,
  ExportResult,
  InboxItem,
  OpenedMessage,
  PlainSendInput,
  RefreshOptions,
  RuleDraft,
  SecondaryBox,
  SendInput,
  SendOutcome,
  TransferMade,
} from './types';

/**
 * The provider for the signed-in account.
 *
 * Deliberately not part of `State`: nothing renders it, and swapping it must not
 * cost a re-render of every screen.
 */
export type MailHolder = {
  /** The active account's provider. Everything that sends or reads uses this. */
  current: MailClient | null;
  /**
   * A provider per connected account, so the merged inbox can list them all
   * without a sign-in round trip per switch. Keyed by `AccountId`.
   */
  clients: Map<AccountId, MailClient>;
};

export type SessionService = {
  /**
   * Restore every stored session on launch. `isCancelled` guards a unmounted provider.
   *
   * `restoreOthers: false` restores only the mailbox that was in front — what a
   * background scheduler pass wants, since the outbox it drains is that one's.
   */
  boot(isCancelled: () => boolean, opts?: { restoreOthers?: boolean }): Promise<void>;
  /** Restore the syncing mailboxes such a boot skipped, and wait for them. */
  restoreOthers(): Promise<void>;
  /**
   * Connect a mailbox. The first one signs in; a later one adds an account.
   * With no provider, the first one this build can reach. `imap` also needs
   * the details its setup sheet collected.
   */
  signIn(provider?: Provider, imap?: ImapSignIn): Promise<void>;
  /** Disconnect everything and return to the sign-in screen. */
  signOut(): Promise<void>;
  /** Load everything one account owns on this device and put it in front. */
  attach(session: Session): Promise<void>;
  /**
   * Drop a session the provider will no longer honour. True if that is what
   * happened.
   *
   * `account` names whose grant died, defaulting to the active one. It matters
   * because the answer is different for the last mailbox than for one of
   * several: the last one returns the app to the connect screen, while one of
   * several is flagged and stepped over, leaving the others signed in.
   */
  handleAuthLoss(e: unknown, account?: AccountId): boolean;
};

export type MailboxService = {
  refreshInbox(options?: RefreshOptions): Promise<void>;
  loadMoreInbox(): Promise<void>;
  loadBox(box: SecondaryBox, options?: RefreshOptions): Promise<void>;
  loadMoreBox(box: SecondaryBox): Promise<void>;
  openMessage(summary: MailSummary): Promise<OpenedMessage>;
  setFlags(id: string, change: FlagPatch): Promise<void>;
  toggleStar(id: string): Promise<void>;
  setUnread(id: string, unread: boolean): Promise<void>;
  archiveMessage(id: string): Promise<void>;
  /**
   * Put an archived message back in the inbox.
   *
   * The other half of `archiveMessage`, and the reason it exists is undo: a
   * swipe can archive a message with one gesture, so there has to be one gesture
   * back. Symmetrical with `trashMessage`/`restoreMessage` in every way.
   */
  unarchiveMessage(id: string): Promise<void>;
  /**
   * Move a message to the provider's trash, or bring it back out.
   *
   * A move, not an erasure: the mail is still on the server, in the Trash
   * destination, and `restoreMessage` puts it back where it was. Emptying the
   * trash is the provider's own action and CryptMail deliberately does not
   * offer it — an irreversible delete is not something a client should quietly
   * grow a button for.
   */
  trashMessage(id: string): Promise<void>;
  restoreMessage(id: string): Promise<void>;
  /** Record the user's spam verdict for a message and train the filter from it. */
  markSpam(id: string): Promise<void>;
  markNotSpam(id: string): Promise<void>;
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
  /** Unlock this run's backup with the typed code; clears the drill setup owes. */
  completeRecoveryDrill(code: string): Promise<void>;
  /** Release the setup gate only when the core itself cannot make backups. */
  waiveRecoveryDrill(): Promise<void>;
  /** Takes a recovery backup or a device transfer — it tells them apart. */
  restoreFromRecovery(blob: string, code: string): Promise<Identity>;
  exportTransfer(): Promise<TransferMade>;
  /** When this phone handed its conversations to another, or null. */
  transferStatus(): Promise<Date | null>;
  resumeSessions(): Promise<void>;
};

export type PublishService = {
  publishOwnKey(): Promise<PublishState>;
  declinePublish(): Promise<PublishState>;
  /** Notice that a pending publication has been confirmed. Cheap when it is not. */
  refreshPublish(): Promise<void>;
  /** Adopt the listing a restored key already had, so it is not published twice. */
  reconcilePublish(): Promise<void>;
};

/** First contact with per-email keys only — see `state/handshake.ts`. */
export type HandshakeService = {
  /** A contentless handshake to each address, at most once a day each. */
  send(emails: string[]): Promise<void>;
  /** Open the handshakes a sync brought in, and answer first contacts. */
  answer(messages: InboxItem[]): Promise<void>;
};

export type SendService = {
  canSendEncrypted(): { allowed: boolean; reason?: string };
  /** Encrypt and send, or hold — never plaintext. The whole of rule 1 lives here. */
  deliver(input: SendInput): Promise<SendOutcome>;
  sendEncrypted(input: SendInput): Promise<SendOutcome>;
  sendPlain(input: PlainSendInput): Promise<void>;
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

export type AccountsService = {
  /** The active account, or throw — every scoped store write is keyed on it. */
  requireActive(): AccountId;
  /** The session for one connected account, whichever is in front. */
  sessionFor(id: AccountId): Session | undefined;
  /**
   * Put one mailbox in front, optionally changing the merged lens at the same
   * time — the rail's "this account alone" tap is both at once, and doing them
   * as two calls would sync the mailbox twice.
   */
  switchAccount(id: AccountId, options?: { unified?: boolean }): Promise<void>;
  addAccount(provider?: Provider, imap?: ImapSignIn): Promise<void>;
  removeAccount(id: AccountId): Promise<void>;
  /**
   * Where an address's IMAP and SMTP servers probably are — the provider's own
   * autoconfig, then Mozilla's ISPDB, then a guess (`mail/autoconfig.ts`).
   * Never rejects: a guess is always an answer, and signing in tests it.
   */
  discoverImapSettings(email: string): Promise<Discovered>;
  /** The servers saved for an IMAP mailbox, without its password, to prefill a re-sign-in. */
  savedImapSettings(email: string): Promise<ImapAccount | null>;

  /**
   * Change what the user has decided about one mailbox — its name, its avatar,
   * whether its mail may fetch remote images, how far back it syncs.
   *
   * A patch, so a screen that owns one control writes one field. Changing the
   * sync window re-lists the mailbox, because the setting is only visible as a
   * different list.
   */
  updateAccount(id: AccountId, patch: Partial<AccountSettings>): Promise<void>;
  /**
   * Throw away what this device has *cached* of one mailbox and fetch it again.
   *
   * `scope: 'content'` clears the search index alone — the plaintext copy of
   * decrypted mail, which is the one people actually want a switch for
   * (features.md 0.12). `'all'` also drops the spam model and the snoozes.
   *
   * Neither touches the keyring, the recovery blob, drafts or the outbox: those
   * are the private key and the user's unsent work, and neither is a cache. A
   * control called "reset" must not silently destroy either — only
   * `removeAccount` erases them, and only because the user asked for the whole
   * account to be gone.
   */
  resetAccount(id: AccountId, scope?: 'content' | 'all'): Promise<void>;
  /**
   * Stop syncing a mailbox without disconnecting it.
   *
   * Everything it owns on this device stays; what goes is its `MailClient`, so
   * a merged sync steps over it and boot no longer asks the provider for a
   * token for it. If it was in front, another mailbox takes over — the same
   * reasoning as `markReauth`.
   *
   * Refuses when it is the last mailbox still syncing, and says why: an app
   * with nothing to read is the connect screen, and that is what signing out
   * is for. The refusal is reported through `State.error`, not thrown, because
   * every caller is a fire-and-forget tap.
   */
  /**
   * Write this mailbox out as an `mbox` file and hand it to the user.
   *
   * Pages **the whole mailbox** from the provider — Inbox, Sent and Archive,
   * regardless of the sync window — rather than the pages this device has
   * loaded, so a mailbox need not be in front, only syncing. Spam and Trash are
   * left out, and the screen says so.
   *
   * Returns how many messages were written and how many the provider refused,
   * which is what the caller reports. `onProgress` is how a screen shows an
   * export of thousands of messages is still moving.
   */
  exportMailbox(id: AccountId, options?: { onProgress?: (progress: ExportProgress) => void }): Promise<ExportResult>;
  /**
   * One message of the mailbox in front, as an `.eml` file: the provider's
   * bytes, so an encrypted message is saved sealed, and named by its header
   * subject so no decrypted text ends up in a filename.
   */
  exportMessage(summary: MailSummary): Promise<void>;
  /**
   * What one mailbox's stores occupy on this device, in bytes.
   *
   * Any account, not only the one in front, because it is measured from the
   * sealed values without opening them (`store/storageUsage.ts`).
   */
  storageUsage(id: AccountId): Promise<StorageUsage>;
  pauseAccount(id: AccountId): Promise<void>;
  /**
   * Start syncing it again, and put it in front — which is what the user is
   * asking for by resuming it.
   *
   * Reuses the session still held in memory when it was paused this run;
   * otherwise the provider is asked to restore it, and a mailbox whose grant
   * has died in the meantime is flagged rather than silently failing to come
   * back.
   */
  resumeAccount(id: AccountId): Promise<void>;
  setUnified(on: boolean): Promise<void>;
  /**
   * Remember a connected account. Returns its id.
   *
   * Active by default. `activate: false` is for boot's background restores,
   * which must not move the mailbox the user is already reading.
   */
  register(session: Session, options?: { activate?: boolean }): Promise<AccountId>;
  /**
   * Record that a listed account can no longer be reached without a new
   * sign-in, and step off it if it was in front.
   *
   * Its stores are left alone: a dead access token says nothing about whether
   * the keyring and decrypted mail on this device are still the user's. Only
   * `removeAccount` erases those, and only because the user asked.
   */
  markReauth(id: AccountId, reason?: string): Promise<void>;
};

export type DraftsService = {
  saveDraft(draft: Draft): Promise<void>;
  deleteDraft(id: string): Promise<void>;
};

export type SnoozeService = {
  /** Load one account's persisted snoozes into state. */
  loadSnoozes(account: AccountId): Promise<void>;
  /** Hide a message from the inbox until `until`. */
  snoozeMessage(id: string, until: string): Promise<void>;
  /** Immediately return a snoozed message to the inbox. */
  unsnoozeMessage(id: string): Promise<void>;
  /**
   * Wake any messages whose snooze time has passed.
   * Called on every scheduler tick and on launch.
   */
  wakedue(): Promise<void>;
};

export type LabelsService = {
  createLabel(name: string): Promise<Label>;
  renameLabel(id: string, name: string): Promise<void>;
  deleteLabel(id: string): Promise<void>;
  setLabels(messageIds: string[], change: LabelChange): Promise<void>;
};

export type RulesService = {
  saveRule(rule: RuleDraft): Promise<Rule>;
  deleteRule(id: string): Promise<void>;
  /**
   * Run every enabled rule over inbox rows, once per message.
   *
   * `rows` narrows the pass — the message that was just decrypted — and is
   * still held to the inbox: a row that is not in `messages` is skipped. With
   * no argument, the whole inbox is the pass. Never throws: a rule that could
   * not be recorded is not a failed sync.
   */
  runRules(rows?: MailSummary[]): Promise<void>;
};

export type NotifyService = {
  /** Read the device's notification preferences into state. Boot calls it. */
  loadPrefs(): Promise<void>;
  setPrefs(patch: Partial<NotificationPrefs>): Promise<void>;
  /**
   * Fold what a sync just listed into each mailbox's ledger, and post if
   * something is news and nobody is looking. Never throws.
   */
  observe(rows: InboxItem[]): Promise<void>;
  /** The background pass's own look at every connected mailbox's newest mail. */
  checkAll(): Promise<void>;
  /** The user is looking: clear these mailboxes' counts (default: every connected one). */
  clear(accounts?: AccountId[]): Promise<void>;
  /** Drop what is held in memory for a removed mailbox, and its notification. */
  forget(account: AccountId): Promise<void>;
  /** Whether anything should wake the app to look for mail. */
  wanted(): boolean;
  /**
   * A notification's Mark read button: mark these messages read at the
   * provider, drop them from the count, and clear the notification once every
   * one has gone through. Works headless — it restores the mailbox if the
   * boot did not.
   */
  markRead(account: AccountId, ids: string[]): Promise<void>;
  /** A notification was tapped; the navigator picks it up from state. */
  tapped(tap: NotificationTap): void;
  consumeTap(): void;
};

export type Services = {
  session: SessionService;
  accounts: AccountsService;
  mailbox: MailboxService;
  contacts: ContactsService;
  identity: IdentityService;
  publish: PublishService;
  send: SendService;
  scheduler: SchedulerService;
  drafts: DraftsService;
  snooze: SnoozeService;
  labels: LabelsService;
  rules: RulesService;
  notify: NotifyService;
  handshake: HandshakeService;
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

/** Error text for a caught `unknown`, in words a banner can show. See `lib/errors.ts`. */
export function message(e: unknown): string {
  return userMessage(e);
}
