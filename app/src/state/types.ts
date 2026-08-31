/**
 * The shape of everything `useApp()` hands a screen.
 *
 * Split out of `AppState.tsx` so the service modules can describe what they
 * read and write without importing the provider — which imports them.
 */
import { Session } from '../auth';
import { DecryptedMessage, Identity, RecoveryBackup } from '../core';
import { Draft, Drafts } from '../drafts/drafts';
import { Attachment } from '../mail/attachment';
import { MailSummary } from '../mail/types';
import { ScheduledOutbox } from '../outbox/outbox';
import { SearchIndex } from '../search/search';
import { AccountId, AccountRef } from '../store/accountScope';
import { InviteLog } from '../store/inviteStore';
import { ContactKey, Keyring } from '../store/keyring';
import { PublishState, PublishStatus } from '../store/publishStore';
import { RecoveryState } from '../store/recoveryStore';
import { RecipientState } from './recipients';

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
 * Ids are assumed unique across the accounts on a device — true for Gmail, and
 * made true for the demo fixtures by `idIn` in `mail/demoMail.ts`.
 */
export type InboxItem = MailSummary & { account: AccountId };

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
  error?: string;
};

/**
 * What happened to a message the user pressed Send on.
 *
 * `queued` is not a failure and not a success: the message is encrypted-only and
 * held until the recipient has a key, and the UI must say so rather than showing
 * "Sent" (docs/encryption.md, invite-and-queue).
 */
export type SendOutcome = { status: 'sent' } | { status: 'queued'; pending: string[] };

/** What a send asks for. The same shape a held message is replayed from. */
export type SendInput = {
  id?: string;
  to: string[];
  subject: string;
  body: string;
  /** Threading headers, emitted in the clear on the outer envelope (message-format.md). */
  inReplyTo?: string;
  references?: string[];
  /** Files to seal in alongside the body. Held with the message if it is held. */
  attachments?: Attachment[];
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
  /** True while a switch is loading the other account's stores. */
  switchingAccount: boolean;
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
  messages: InboxItem[];
  loadingInbox: boolean;
  error: string | null;
};

export type Actions = {
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Connect another mailbox alongside the ones already here, and switch to it. */
  addAccount(): Promise<void>;
  /** Put another connected mailbox in front, loading everything it owns. */
  switchAccount(id: AccountId): Promise<void>;
  /** Disconnect one mailbox and erase every local store belonging to it. */
  removeAccount(id: AccountId): Promise<void>;
  /** Show every account's mail in one list, or just the active one's. */
  setUnified(on: boolean): Promise<void>;
  refreshInbox(): Promise<void>;
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
  /** Adopt an identity from a backup, replacing whatever key this device holds. */
  restoreFromRecovery(blob: string, code: string): Promise<Identity>;
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
  scheduleSend(input: SendInput & { sendAt: string }): Promise<void>;
  cancelScheduled(id: string): Promise<void>;
  /**
   * Try a queued message now. Returns what happened — `null` when the id is no
   * longer in the outbox — and throws when a recipient's key changed.
   */
  sendScheduledNow(id: string): Promise<SendOutcome | null>;
};
