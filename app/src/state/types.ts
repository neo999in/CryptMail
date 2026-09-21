/**
 * The shape of everything `useApp()` hands a screen.
 *
 * Split out of `AppState.tsx` so the service modules can describe what they
 * read and write without importing the provider — which imports them.
 */
import { ImapSignIn, Provider, Session } from '../auth';
import { Discovered } from '../mail/autoconfig';
import { ImapAccount } from '../mail/imap';
import { DecryptedMessage, DeviceTransfer, Identity, KmLink, KmStatus, RecoveryBackup, SecurityLevel } from '../core';
import { Draft, Drafts } from '../drafts/drafts';
import { Label, LabelChange, LabelState } from '../labels/labels';
import { Attachment } from '../mail/attachment';
import { Mailbox, MailSummary } from '../mail/types';
import type { NotificationTap, PermissionStatus } from '../notifications/os';
import { ScheduledOutbox } from '../outbox/outbox';
import { Rule, RulesState } from '../rules/rules';
import { SearchIndex } from '../search/search';
import { SnoozeMap } from '../snooze/snooze';
import type { LinkPair } from '../spam/spam';
import { AccountId, AccountRef, AccountSettings } from '../store/accountScope';
import { InviteLog } from '../store/inviteStore';
import { ContactKey, Keyring } from '../store/keyring';
import { NotificationPrefs } from '../store/notifyStore';
import { PublishState, PublishStatus } from '../store/publishStore';
import { RecoveryState } from '../store/recoveryStore';
import { SpamState } from '../store/spamModelStore';
import { StorageUsage } from '../store/storageUsage';
import { RecipientState } from './recipients';

export type { StorageUsage };

/**
 * How far a mailbox export has got. Listing has no total — the provider does
 * not say how many messages a folder holds until it has been paged — so only
 * fetching reports one.
 */
export type ExportProgress = { phase: 'listing'; done: number } | { phase: 'fetching'; done: number; total: number };

/** What an export wrote, and how many listed messages the provider refused to hand over. */
export type ExportResult = { written: number; skipped: number };

export type EncryptionState =
  | { kind: 'encrypted'; trust: 'verified' | 'seen' | 'changed' | 'unknown'; own?: boolean }
  | { kind: 'plain' };

/** Re-exported so screens keep a single import site for everything `useApp` returns. */
export type { RecipientState };

/**
 * An inbox row, tagged with the mailbox it came from.
 *
 * The tag is what makes a merged inbox openable: a row carries its own account,
 * so opening it can put that account in front rather than trying to decrypt
 * another mailbox's mail with this one's key. It is a `MailSummary` everywhere
 * a summary is expected, so nothing downstream had to learn about accounts.
 *
 * Ids are assumed unique across the accounts on a device — true for Gmail.
 */
export type InboxItem = MailSummary & { account: AccountId };

/** A transfer, with how much archived mail went into it and how much would not open. */
export type TransferMade = DeviceTransfer & { archived: number; unreadable: number };

export type OpenedMessage = {
  summary: MailSummary;
  encryption: EncryptionState;
  subject: string;
  body: string;
  decrypted: DecryptedMessage | null;
  /**
   * Files on this message — out of the decrypted tree for encrypted mail, out of
   * the raw MIME for plain. Empty when it carried none, so the reader has one
   * shape to render either way.
   */
  attachments: Attachment[];
  /** Raw source — the ciphertext the provider stores. Shown in "what Gmail sees". */
  raw: string;
  /**
   * The message's `text/html` part, when it had one, for `ui/HtmlReader` to
   * render instead of the flattened `body` text.
   *
   * Attacker-controlled markup, and carried as such: it is sanitised at the
   * point of render (`html/sanitize.ts`), not here, so whatever reads it treats
   * it as hostile input rather than trusting a field that looks pre-cleaned.
   * Set for encrypted mail too, from the decrypted tree — a sealed message
   * gets the same reader as any other, since the seal says who sent it, not
   * that its markup is safe. It is never the *ciphertext*: only content this
   * device has already decrypted.
   */
  html?: string;
  /**
   * Anchor `href`/label pairs from the message's HTML part, when it had one.
   *
   * Only ever the *readable* HTML: the body of a plaintext message, never the
   * ciphertext of an encrypted one. Extracted by a bounded scan that reads markup
   * and never renders or executes it (`spam/urls.ts`), and passed to the spam
   * engine so the message view can warn about a link whose visible text names one
   * site and whose destination is another — which is invisible in the flattened
   * text the reader sees.
   */
  links?: LinkPair[];
  /** The message could not be read. Replaces the body. */
  error?: string;
  /**
   * The message **was** read, but something about it needs saying — shown above
   * the body, never instead of it. Used when a forward-secret message decrypted
   * and could not be saved: this is the last time it can be shown at all.
   */
  notice?: string;
};

/**
 * What happened to a message the user pressed Send on.
 *
 * `queued` is not a failure and not a success: the message is encrypted-only and
 * held until the recipient has a key, and the UI must say so rather than showing
 * "Sent" (docs/encryption.md, invite-and-queue).
 */
export type SendOutcome =
  | { status: 'sent' }
  /**
   * Held. `waitingFor` says on what: a key they have not published (`key`, the
   * default), or per-email keys not yet set up with them (`session`).
   */
  | { status: 'queued'; pending: string[]; waitingFor?: 'key' | 'session' };

/** What a send asks for. The same shape a held message is replayed from. */
export type SendInput = {
  id?: string;
  to: string[];
  subject: string;
  body: string;
  /** The message as HTML when it was written with formatting; `body` is then its text alternative. */
  html?: string;
  /** Threading headers, emitted in the clear on the outer envelope (message-format.md). */
  inReplyTo?: string;
  references?: string[];
  /** Files to seal in alongside the body. Held with the message if it is held. */
  attachments?: Attachment[];
  /** Which security level seals it (`core/qkd.ts`). Defaults to 4, per-email keys. */
  level?: SecurityLevel;
};

/**
 * What the deliberately-unencrypted send takes.
 *
 * Its own type rather than `SendInput`: nothing here is ever held, so there is
 * no id, and keeping the two apart means a held message can never be replayed
 * down the plaintext path by an accident of structural typing.
 */
export type PlainSendInput = {
  to: string[];
  subject: string;
  body: string;
  /** The message as HTML when it was written with formatting; `body` is then its text alternative. */
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Attachment[];
};

export type State = {
  booting: boolean;
  session: Session | null;
  /** Every mailbox connected on this device. Empty until the first sign-in. */
  accounts: AccountRef[];
  /**
   * Whose keyring, identity, drafts and outbox are loaded.
   *
   * Exactly one account is ever *active*, including while the inbox is merged:
   * composing, sending and decrypting all need one identity, and picking it
   * per-message is how state leaks between mailboxes.
   */
  activeAccount: AccountId | null;
  /** Whether the inbox lists every account at once. Reading only. */
  unified: boolean;
  /**
   * Connected mailboxes this device can no longer reach, by id.
   *
   * A revoked or expired grant used to sign the user out of *everything*,
   * which with one account was indistinguishable from the truth and with two
   * is simply wrong. The account stays listed and keeps its keyring, drafts
   * and decrypted mail — none of that is invalidated by a dead token — but it
   * cannot be switched to or synced until the user signs in again, and the
   * drawer says so. Held in memory only: the next launch discovers it again by
   * failing to restore the account.
   */
  needsReauth: AccountId[];
  /** True while a switch is loading the other account's stores. */
  switchingAccount: boolean;
  /** True from the sign-in picker opening until the new mailbox is attached. */
  addingAccount: boolean;
  identity: Identity | null;
  /** Whether this device's key has ever been backed up. Drives the Keys warning. */
  recovery: RecoveryState;
  /** Whether this device's public key is listed in the key directory. */
  publish: PublishState;
  /**
   * The directory's own confirmation link, found in this mailbox.
   *
   * Only ever set while publication is `pending`, and only for a link that
   * passed every check in `keys/verifyLink.ts`. Null means there is nothing to
   * offer — which is the normal state, and the state the copy already covers.
   */
  verifyLink: string | null;
  /** Where a published key ends up, in words. Screens never import the directory. */
  directoryName: string;
  /** Addresses currently being looked up in the directory. Drives compose. */
  discovering: string[];
  /**
   * Addresses whose last lookup settled nothing — the directory was unreachable
   * or slow, or it answered with a key the core refused to import.
   *
   * Kept apart from "has no key" because they are different facts and only one
   * of them is about the recipient. Compose says so rather than announcing that
   * someone does not use encryption on the strength of a request that failed.
   */
  undiscoverable: string[];
  /** When each address was last invited, so nobody is invited twice a week. */
  invites: InviteLog;
  keyring: Keyring;
  /** Decrypted subjects/bodies seen on this device, so encrypted mail is searchable. */
  searchIndex: SearchIndex;
  /** Unsent compose drafts, keyed by id. */
  drafts: Drafts;
  /** Messages queued to send at a future time. */
  scheduled: ScheduledOutbox;
  /**
   * The personal spam model and the user's own spam/not-spam marks.
   *
   * Part of state because the inbox categorises rows during render, and both
   * halves change the answer: a mark decides one message outright, and training
   * shifts every score. Screens never read the model itself — they pass it
   * through `categorizeMessage`.
   */
  spam: SpamState;
  /**
   * Every row the inbox screen lists: the inbox itself **and** the provider's junk
   * folder, newest first.
   *
   * Spam is here rather than in `boxes` because in this app junk is a category
   * rather than a place — the drawer's Spam destination filters this list, and
   * `showsUnderTab` keeps that category out of the Primary and Encrypted tabs. One
   * list is what lets a message the provider flagged and a message this device
   * flagged be counted by one badge and reversed by one button; it is also what
   * keeps "mark as not spam" working on provider-flagged mail, since every mark
   * looks the message up here.
   */
  messages: InboxItem[];
  /** Messages snoozed until a future time — hidden from the inbox until then. */
  snoozed: SnoozeMap;
  /**
   * The active account's local labels, and which messages carry them.
   *
   * Local only — the provider never sees a label (`labels/labels.ts`). Keyed by
   * message id, so in a merged inbox only the active account's rows can show
   * or take one, exactly as with snoozes.
   */
  labels: LabelState;
  /** The active account's filters & rules, and which of them already fired. */
  rules: RulesState;
  loadingInbox: boolean;
  /**
   * A sync the **user asked for** is in flight — a pull-to-refresh, or the
   * Refresh action.
   *
   * Separate from `loadingInbox`, which is true for every sync including the
   * ones nobody asked for: a mount, a boot, an account switch, the refresh that
   * follows a send. Those used to drive the spinner too, so the list flashed a
   * loader over mail that was already on screen — and once a cached list paints
   * on the first frame, that is every launch.
   *
   * The rule is that a spinner answers a gesture. `loadingInbox` still decides
   * the skeleton and the empty state, which are about *having nothing to show*
   * and are right to appear whoever asked.
   */
  refreshingInbox: boolean;
  /** A page of *older* mail is in flight. Separate from a sync, which replaces the list. */
  loadingMore: boolean;
  /** At least one listed mailbox has mail older than the last page it handed over. */
  canLoadMore: boolean;
  /**
   * Sent and Archive, each fetched and paged on its own.
   *
   * Not a filter over `messages`: that list holds inbox mail, so filtering it
   * would show only the sent mail that happened to be in the inbox — which is
   * none. These are the active account's, even when the inbox is merged.
   */
  boxes: Record<SecondaryBox, BoxState>;
  /** What new-mail notifications may say, and which mail they are for. Device-wide. */
  notificationPrefs: NotificationPrefs;
  /**
   * A notification the user tapped, waiting for the navigator to open it.
   * Cleared by `consumeNotificationTap` once it has.
   */
  notificationTap: NotificationTap | null;
  error: string | null;
};

/**
 * The mailboxes that have their own screen rather than being the inbox.
 *
 * Named rather than derived from `Mailbox`, because `spam` is a `Mailbox` the
 * provider serves and deliberately **not** one of these: junk is fetched into
 * `messages` and reached through the drawer's category filter, so it has no box
 * and no screen of its own. See `state/mailbox.ts`, `collectInbox`.
 *
 * `trash` is one of these rather than a category for the opposite reason. Spam
 * is a verdict this app forms and can disagree with the provider about, so it
 * belongs beside the mail it is filing; deleted mail is a *place* the provider
 * moved the message to, and it must not appear in the list it was deleted from.
 */
export type SecondaryBox = Extract<Mailbox, 'sent' | 'archive' | 'trash'>;

/**
 * Every one of them, in drawer order.
 *
 * A value rather than a type, because the state layer has to *walk* the boxes —
 * finding which list a row is in, patching one and leaving the others alone —
 * and a union cannot be iterated. Adding a box means adding it here, or it will
 * simply be skipped rather than failing to compile.
 */
export const SECONDARY_BOXES: SecondaryBox[] = ['sent', 'archive', 'trash'];

/**
 * Who asked for a sync.
 *
 * `manual: true` means a gesture — a pull-to-refresh, or the Refresh action —
 * and is what puts a spinner on screen. Every other caller omits it, so a sync
 * the app decided to run on its own is silent.
 */
export type RefreshOptions = {
  manual?: boolean;
  /**
   * Fetch only if this list has not been fetched recently — "make sure it is
   * loaded", rather than "load it again".
   *
   * What the mount effects pass, and the reason switching destination is no
   * longer a provider round trip: arriving at Archive from Sent used to re-list
   * a mailbox that was already in state and already drawn, so every switch paid
   * for a fetch whose answer was on screen before it was asked.
   *
   * Nothing else passes it. A pull, the Refresh action, a boot, an account
   * arriving, and the sync after a send all still fetch unconditionally, so
   * "show me what is there now" is never silently answered from memory.
   */
  ifStale?: boolean;
};

/**
 * How long a list stays fresh for `ifStale`.
 *
 * Long enough that moving between destinations is free, short enough that a
 * list you come back to after reading something is re-checked. Anything the
 * user does to *ask* for mail ignores it entirely.
 */
export const FRESH_FOR_MS = 30_000;

/** One such list, with the same loading vocabulary the inbox uses. */
export type BoxState = {
  items: InboxItem[];
  loading: boolean;
  /** The user asked for this one — see `State.refreshingInbox`. */
  refreshing: boolean;
  loadingMore: boolean;
  canLoadMore: boolean;
  error: string | null;
};

export type Actions = {
  /**
   * With no provider, the first one this build can reach. `imap` needs the
   * address, password and servers from `ui/imapSetupSheet.tsx`.
   */
  signIn(provider?: Provider, imap?: ImapSignIn): Promise<void>;
  signOut(): Promise<void>;
  /** Connect another mailbox alongside the ones already here, and switch to it. */
  addAccount(provider?: Provider, imap?: ImapSignIn): Promise<void>;
  /** Put another connected mailbox in front, loading everything it owns. */
  /** Put a mailbox in front; `unified: false` also leaves the merged view. */
  switchAccount(id: AccountId, options?: { unified?: boolean }): Promise<void>;
  /** Disconnect one mailbox and erase every local store belonging to it. */
  removeAccount(id: AccountId): Promise<void>;
  /**
   * Where an address's IMAP and SMTP servers probably are — the provider's own
   * autoconfig, then Mozilla's ISPDB, then a guess (`mail/autoconfig.ts`).
   * Never rejects: a guess is always an answer, and signing in tests it.
   */
  discoverImapSettings(email: string): Promise<Discovered>;
  /** The servers saved for an IMAP mailbox, without its password, to prefill a re-sign-in. */
  savedImapSettings(email: string): Promise<ImapAccount | null>;

  /** Rename a mailbox, or change its avatar, image policy or sync window. */
  updateAccount(id: AccountId, patch: Partial<AccountSettings>): Promise<void>;
  /**
   * Clear this device's cache of one mailbox — the decrypted-mail index alone
   * (`'content'`), or that plus the spam model and snoozes (`'all'`). Keys,
   * drafts and the outbox are never touched.
   */
  resetAccount(id: AccountId, scope?: 'content' | 'all'): Promise<void>;
  /**
   * Stop syncing a mailbox without disconnecting it — keys, drafts and indexed
   * mail all stay. Refuses on the last mailbox still syncing, and says why.
   */
  pauseAccount(id: AccountId): Promise<void>;
  /** Sync it again, and put it in front. */
  resumeAccount(id: AccountId): Promise<void>;
  /**
   * Page a whole mailbox — Inbox, Sent and Archive — from its provider and write
   * it out as an `.mbox` file. Any syncing mailbox, in front or not.
   */
  exportMailbox(id: AccountId, options?: { onProgress?: (progress: ExportProgress) => void }): Promise<ExportResult>;
  /** Save one message of the mailbox in front as an `.eml` file — the provider's bytes, sealed if it was. */
  exportMessage(summary: MailSummary): Promise<void>;
  /** Bytes one mailbox's stores take on this device, measured without decrypting them. */
  storageUsage(id: AccountId): Promise<StorageUsage>;
  /** Show every account's mail in one list, or just the active one's. */
  setUnified(on: boolean): Promise<void>;
  /**
   * Sync the inbox. `manual` marks a sync the user asked for, which is the only
   * kind that shows a spinner — see `State.refreshingInbox`.
   */
  refreshInbox(options?: RefreshOptions): Promise<void>;
  /** Append the next page of older mail. No-op once every mailbox is exhausted. */
  loadMoreInbox(): Promise<void>;
  /** Load Sent or Archive from its newest page. */
  loadBox(box: SecondaryBox, options?: RefreshOptions): Promise<void>;
  /** Append the next page of older mail to Sent or Archive. */
  loadMoreBox(box: SecondaryBox): Promise<void>;
  openMessage(summary: MailSummary): Promise<OpenedMessage>;
  encryptionFor(summary: MailSummary): EncryptionState;
  /** Local state only: pure, synchronous, no network. The input to rule 1. */
  resolveRecipients(emails: string[]): RecipientState[];
  /**
   * Look up any addresses with no local key in the directory, then resolve.
   *
   * The lookup happens *before* `resolveRecipientStates`, never inside it — that
   * function stays pure and synchronous because it is the one piece of the send
   * path worth testing on its own.
   */
  discoverRecipients(emails: string[]): Promise<RecipientState[]>;
  /** Generate this device's identity. First run only, and only once the user asks. */
  createIdentity(): Promise<Identity>;
  /** Upload this device's public key to the directory. Requires the user's say-so. */
  publishOwnKey(): Promise<PublishState>;
  /** Record that the user does not want their key listed. Not asked again. */
  declinePublish(): Promise<PublishState>;
  /** The publish state of the key this device currently holds. */
  publishStatus(): PublishStatus;
  importKey(armored: string, name?: string): Promise<ContactKey>;
  forgetKey(email: string): Promise<void>;
  /** Record an out-of-band verification. Fails if the key changed meanwhile. */
  markVerified(email: string, confirmedFingerprint: string): Promise<void>;
  /** The safety number to compare with this contact, out of band. */
  safetyNumberFor(email: string): Promise<string>;
  /**
   * Wrap this device's key under a new recovery code. The code is returned for
   * the user to write down and is deliberately not stored anywhere.
   */
  exportRecovery(): Promise<RecoveryBackup>;
  /**
   * The setup drill: unlock the backup `exportRecovery` just made with the code
   * the user types back. Throws if it does not open; on success setup may finish.
   */
  completeRecoveryDrill(code: string): Promise<void>;
  /**
   * Let setup finish without a drill — refused unless the crypto core reports it
   * cannot make backups at all, which is the one case a drill cannot run.
   */
  waiveRecoveryDrill(): Promise<void>;
  /**
   * Adopt an identity from a backup or a device transfer, replacing whatever key
   * this device holds. A transfer also brings the conversations and archive.
   */
  restoreFromRecovery(blob: string, code: string): Promise<Identity>;
  /**
   * Seal this phone for a replacement and hand its conversations over: from
   * then on it sends with long-term keys. The code is shown once, never stored.
   */
  exportTransfer(): Promise<TransferMade>;
  /** When this phone handed its conversations to another, or null. */
  transferStatus(): Promise<Date | null>;
  /** Take the conversations back — only safe if the other phone never sent. */
  resumeSessions(): Promise<void>;
  /** The quantum Key Manager for the signed-in mailbox — the one login. */
  kmStatus(): Promise<KmStatus>;
  /** A fresh bank of 100 × 1 Kb keys. A linked bank must be linked again. */
  kmRegenerate(): Promise<KmStatus>;
  /** Seal this bank for another phone; the code is shown once. */
  kmExportLink(): Promise<KmLink>;
  kmImportLink(blob: string, code: string): Promise<KmStatus>;
  /**
   * Start a quantum link with an address by running BB84 over email
   * (`state/bb84.ts`). Three messages and as many syncs on each side; the bank
   * appears when the last one lands, and nothing is copied.
   */
  beginQuantumLink(email: string): Promise<void>;
  /**
   * Encrypt and send. Never sends anything unencrypted: a recipient with no key
   * yet gets an invite and the message waits — see `SendOutcome`.
   */
  sendEncrypted(input: SendInput): Promise<SendOutcome>;
  /**
   * Send a normal, unencrypted email. Never called as a fallback when
   * encryption fails — see `sendPlain` in `state/send.ts` for why that
   * distinction is the whole of rule 1.
   */
  sendPlain(input: PlainSendInput): Promise<void>;
  canSendEncrypted(): { allowed: boolean; reason?: string };
  saveDraft(draft: Draft): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  toggleStar(id: string): Promise<void>;
  setUnread(id: string, unread: boolean): Promise<void>;
  archiveMessage(id: string): Promise<void>;
  /** Put an archived message back in the inbox — what undoes an archive. */
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
  scheduleSend(input: SendInput & { sendAt: string }): Promise<void>;
  cancelScheduled(id: string): Promise<void>;
  /**
   * Try a queued message now. Returns what happened — `null` when the id is no
   * longer in the outbox — and throws when a recipient's key changed.
   */
  sendScheduledNow(id: string): Promise<SendOutcome | null>;
  /**
   * Move a message to spam, and teach the filter from it.
   *
   * Both marks do two things that must not come apart: they record the user's
   * decision for *this* message, which overrides any score, and they train the
   * personal model so similar mail is scored differently next time. Learning is
   * persisted, so it survives a restart.
   *
   * Only content this device can actually read is learned from — the same
   * boundary the categoriser enforces. Marking an unopened encrypted message
   * records the mark and trains on its cleartext headers alone.
   */
  markSpam(id: string): Promise<void>;
  markNotSpam(id: string): Promise<void>;
  /** Snooze a message: hide it from the inbox until `until` (ISO-8601 string). */
  snoozeMessage(id: string, until: string): Promise<void>;
  /** Unsnooze a message early: immediately return it to the inbox. */
  unsnoozeMessage(id: string): Promise<void>;
  /** Add a local label. Throws with a sentence when the name cannot be used. */
  createLabel(name: string): Promise<Label>;
  renameLabel(id: string, name: string): Promise<void>;
  /** Delete a label: off every message, and off every rule that filed under it. */
  deleteLabel(id: string): Promise<void>;
  /** Put labels on and take labels off a set of messages. Local only. */
  setLabels(messageIds: string[], change: LabelChange): Promise<void>;
  /**
   * Add or replace a rule, then run it over the inbox at once. Throws with a
   * sentence when the rule cannot be saved (`ruleProblem`).
   */
  saveRule(rule: RuleDraft): Promise<Rule>;
  deleteRule(id: string): Promise<void>;
  /** Change what notifications say, or which mail they announce. */
  setNotificationPrefs(patch: Partial<NotificationPrefs>): Promise<void>;
  /** Whether the OS lets CryptMail post, as it stands. */
  notificationPermission(): Promise<PermissionStatus>;
  /** Ask the OS — or, where it will not ask again, open the app's system settings. */
  requestNotificationPermission(): Promise<PermissionStatus>;
  /** The tapped notification has been opened; forget it. */
  consumeNotificationTap(): void;
};

/** A rule as an editor hands it over: no id yet when it is new. */
export type RuleDraft = Omit<Rule, 'id' | 'createdAt'> & { id?: string };
