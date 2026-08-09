import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { auth, Session } from '../auth';
import { needsReauth } from '../auth/types';
import { cryptoMode } from '../config';
import {
  buildPlaintext,
  core,
  CoreError,
  DecryptedMessage,
  Identity,
  PLACEHOLDER_SUBJECT,
  RecoveryBackup,
} from '../core';
import { createDemoMailClient, demoContactKeys, demoContacts } from '../mail/demoMail';
import { createGmailClient } from '../mail/gmail';
import { Draft, Drafts, removeDraft, upsertDraft } from '../drafts/drafts';
import { directory, DiscoveryError, harvestAutocrypt } from '../keys';
import { isKeyserverSender, verifyLinkFrom } from '../keys/verifyLink';
import { applyFlagPatch } from '../mail/flags';
import { plainBodyOf } from '../mail/plainBody';
import { FlagPatch, MailClient, MailSummary } from '../mail/types';
import {
  dueScheduled,
  Held,
  holdReason,
  listScheduled,
  removeScheduled,
  resolvableHeld,
  ScheduledOutbox,
  stillPending,
  upsertScheduled,
} from '../outbox/outbox';
import { addressesInKey, userIdDisplayName } from '../pgp/parseArmoredKey';
import { normaliseFingerprint, safetyNumber } from '../pgp/safetyNumber';
import { indexContent, SearchIndex } from '../search/search';
import { loadDrafts, saveDrafts } from '../store/draftsStore';
import { InviteLog, loadInvites, recordInvite, saveInvites, shouldInvite } from '../store/inviteStore';
import { loadOutbox, saveOutbox } from '../store/outboxStore';
import { ContactKey, findKey, Keyring, loadKeyring, removeKey, saveKeyring, upsertKey } from '../store/keyring';
import {
  loadPublishState,
  PublishState,
  publishStatusFor,
  PublishStatus,
  savePublishState,
} from '../store/publishStore';
import { RecipientState, resolveRecipientStates } from './recipients';
import { loadSearchIndex, saveSearchIndex } from '../store/searchIndex';
import {
  clearBackupRecord,
  loadRecoveryState,
  recordBackup,
  RecoveryState,
} from '../store/recoveryStore';
import { initStorage } from '../store';

/* --------------------------------------------------------------- types ---- */

export type EncryptionState =
  | { kind: 'encrypted'; trust: 'verified' | 'seen' | 'changed' | 'unknown'; own?: boolean }
  | { kind: 'plain' };

/** Re-exported so screens keep a single import site for everything `useApp` returns. */
export type { RecipientState };

export type OpenedMessage = {
  summary: MailSummary;
  encryption: EncryptionState;
  subject: string;
  body: string;
  decrypted: DecryptedMessage | null;
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

type State = {
  booting: boolean;
  session: Session | null;
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
  messages: MailSummary[];
  loadingInbox: boolean;
  error: string | null;
};

type Actions = {
  signIn(): Promise<void>;
  signOut(): Promise<void>;
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
  sendEncrypted(input: { id?: string; to: string[]; subject: string; body: string }): Promise<SendOutcome>;
  /**
   * Send a normal, unencrypted email. Never called as a fallback when
   * encryption fails — see `sendPlain` in the provider for why that distinction
   * is the whole of rule 1.
   */
  sendPlain(input: { to: string[]; subject: string; body: string }): Promise<void>;
  canSendEncrypted(): { allowed: boolean; reason?: string };
  saveDraft(draft: Draft): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  toggleStar(id: string): Promise<void>;
  setUnread(id: string, unread: boolean): Promise<void>;
  archiveMessage(id: string): Promise<void>;
  scheduleSend(input: { id?: string; to: string[]; subject: string; body: string; sendAt: string }): Promise<void>;
  cancelScheduled(id: string): Promise<void>;
  /**
   * Try a queued message now. Returns what happened — `null` when the id is no
   * longer in the outbox — and throws when a recipient's key changed.
   */
  sendScheduledNow(id: string): Promise<SendOutcome | null>;
};

const AppContext = createContext<(State & Actions) | null>(null);

/* ------------------------------------------------------------ provider ---- */

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({
    booting: true,
    session: null,
    identity: null,
    recovery: { backedUpAt: null, fingerprint: null },
    publish: { status: 'unpublished', fingerprint: null, updatedAt: null },
    verifyLink: null,
    directoryName: directory.listedAt,
    discovering: [],
    undiscoverable: [],
    invites: {},
    keyring: {},
    searchIndex: {},
    drafts: {},
    scheduled: {},
    messages: [],
    loadingInbox: false,
    error: null,
  });

  const mailRef = useRef<MailClient | null>(null);
  const patch = useCallback((next: Partial<State>) => setState((s) => ({ ...s, ...next })), []);

  // Scheduler bookkeeping: a guard against sending the same item twice, and refs
  // to the latest outbox/drafts so results are applied against current state
  // after async delivery (a concurrent schedule must not be clobbered).
  const inFlight = useRef<Set<string>>(new Set());
  const scheduledRef = useRef<ScheduledOutbox>(state.scheduled);
  const draftsRef = useRef<Drafts>(state.drafts);
  scheduledRef.current = state.scheduled;
  draftsRef.current = state.drafts;

  // The keyring, identity and invite log are read *and written* from async work
  // that outlives a render — a directory lookup, an inbox harvest, a queue
  // drain. Going through refs is what keeps two of those running at once from
  // writing back a keyring that is missing the other's key.
  const keyringRef = useRef<Keyring>(state.keyring);
  const identityRef = useRef<Identity | null>(state.identity);
  const invitesRef = useRef<InviteLog>(state.invites);
  const sessionRef = useRef<Session | null>(state.session);
  const publishRef = useRef<PublishState>(state.publish);
  // The synced inbox, for work that runs inside the same sync that fetched it:
  // `refreshPublish` reads it looking for the directory's confirmation mail, and
  // `state.messages` is still the previous list at that point.
  const messagesRef = useRef<MailSummary[]>(state.messages);
  const verifyLinkRef = useRef<string | null>(state.verifyLink);
  keyringRef.current = state.keyring;
  identityRef.current = state.identity;
  invitesRef.current = state.invites;
  sessionRef.current = state.session;
  publishRef.current = state.publish;
  messagesRef.current = state.messages;
  verifyLinkRef.current = state.verifyLink;

  // Late-bound so the inbox sync can trigger a queue drain and a publish-state
  // check without being defined after them; both need `deliver`, which needs
  // most of the file. Assigned once below.
  const drainRef = useRef<() => Promise<void>>(async () => {});
  const refreshPublishRef = useRef<() => Promise<void>>(async () => {});
  /** When the queue last asked the directory about its pending addresses. */
  const lastDirectoryRetry = useRef(0);

  /** Persist a new keyring and make it visible to concurrent async work at once. */
  const commitKeyring = useCallback(
    async (next: Keyring) => {
      if (next === keyringRef.current) return next;
      keyringRef.current = next;
      await saveKeyring(next);
      patch({ keyring: next });
      return next;
    },
    [patch],
  );

  /**
   * Connect the provider and load everything this account owns on this device.
   *
   * It deliberately does **not** generate an identity. A fresh device that mints
   * a throwaway key before the user has been offered "restore from your recovery
   * code" leaves them restoring over a key their correspondents may already have
   * seen — a fingerprint change for everyone, caused by the app, for nothing.
   * Generation is a decision the user makes on the setup screen.
   */
  const attach = useCallback(
    async (
      session: Session,
    ): Promise<{
      identity: Identity | null;
      recovery: RecoveryState;
      publish: PublishState;
      invites: InviteLog;
      keyring: Keyring;
      searchIndex: SearchIndex;
      drafts: Drafts;
      scheduled: ScheduledOutbox;
      /** Nothing found for a previous account belongs to this one. */
      verifyLink: null;
    }> => {
      mailRef.current =
        session.provider === 'demo'
          ? await createDemoMailClient(session.email)
          : createGmailClient(session.email, auth.freshAccessToken);

      const identity = await core.loadIdentity(session.email);

      let keyring = await loadKeyring();
      // Seeded only for the demo core. `demoContactKeys` are `fakePublicKey()`
      // armor, which a real OpenPGP parser rejects — feeding them to a native
      // core throws, leaving an error banner and an *empty* keyring, so
      // encrypted send would be blocked for every recipient. Demo mail with a
      // real core is handled in `demoMail.ts`; see the note there.
      if (session.provider === 'demo' && core.kind === 'demo' && Object.keys(keyring).length === 0) {
        // Seed the demo keyring so the inbox shows every trust state in the design:
        // Anya verified, Jordan trusted-on-first-use, the newsletter sender unknown.
        keyring = upsertKey(keyring, await core.importPublicKey(demoContactKeys.anya), 'manual', demoContacts.anya.name);
        keyring = upsertKey(keyring, await core.importPublicKey(demoContactKeys.jordan), 'autocrypt', demoContacts.jordan.name);
        keyring[demoContacts.anya.email] = { ...keyring[demoContacts.anya.email], trust: 'verified' };
        await saveKeyring(keyring);
      }

      const searchIndex = await loadSearchIndex();
      const drafts = await loadDrafts();
      const scheduled = await loadOutbox();
      const recovery = await loadRecoveryState();
      const publish = await loadPublishState();
      const invites = await loadInvites();
      keyringRef.current = keyring;
      identityRef.current = identity;
      invitesRef.current = invites;
      verifyLinkRef.current = null;
      return { identity, recovery, publish, invites, keyring, searchIndex, drafts, scheduled, verifyLink: null };
    },
    [],
  );

  // Boot: restore an existing session, if any.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Before anything reads a store. Every local store is encrypted at rest
        // and none of them can be decrypted until the device key is loaded.
        await initStorage();

        const session = await auth.restore();
        if (!session) {
          if (!cancelled) patch({ booting: false });
          return;
        }
        sessionRef.current = session;
        const attached = await attach(session);
        if (!cancelled) patch({ booting: false, session, ...attached });
      } catch (e) {
        // A grant revoked while the app was closed shows up here. Land on the
        // sign-in screen with the reason, not on a broken inbox.
        if (!cancelled) patch({ booting: false, session: null, error: message(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attach, patch]);

  /**
   * Drop a session Google will no longer honour.
   *
   * Returning to signed-out is the point: leaving a dead session in place shows
   * an inbox that cannot refresh and a compose screen that cannot send, with an
   * error the user has no way to act on. `signOut` has already cleared the
   * stored tokens by the time this runs.
   */
  const handleAuthLoss = useCallback(
    (e: unknown): boolean => {
      if (!needsReauth(e)) return false;
      mailRef.current = null;
      messagesRef.current = [];
      verifyLinkRef.current = null;
      patch({
        session: null,
        identity: null,
        messages: [],
        verifyLink: null,
        loadingInbox: false,
        error: message(e),
      });
      return true;
    },
    [patch],
  );

  /**
   * Learn every key the mailbox just handed us.
   *
   * `Autocrypt` is a cleartext header, so this costs one metadata field per
   * message and no decryption at all. Before this existed a key was only learned
   * if the user happened to *open* that message — which meant the common case,
   * "they wrote to me first", still ended in "no key for them" at compose time.
   */
  const harvestFrom = useCallback(
    async (messages: MailSummary[]) => {
      let keyring = keyringRef.current;
      for (const summary of messages) {
        if (!summary.autocrypt) continue;
        if (summary.from.address === sessionRef.current?.email) continue;
        keyring = await harvestAutocrypt(keyring, summary.from.address, summary.autocrypt, summary.from.name);
      }
      await commitKeyring(keyring);
    },
    [commitKeyring],
  );

  const refreshInbox = useCallback(async () => {
    if (!mailRef.current) return;
    patch({ loadingInbox: true, error: null });
    try {
      const messages = await mailRef.current.listInbox(20);
      // Ahead of the patch, for the same reason `signIn` sets `sessionRef`:
      // everything awaited below runs before React re-renders.
      messagesRef.current = messages;
      patch({ messages, loadingInbox: false });
      await harvestFrom(messages);
      // Someone installing CryptMail is an external event with no notification
      // attached, so every sync is also a chance to notice that a held message
      // can finally go. Cheap: it only touches the network if something is held.
      await drainRef.current();
      await refreshPublishRef.current();
    } catch (e) {
      if (handleAuthLoss(e)) return;
      patch({ loadingInbox: false, error: message(e) });
    }
  }, [handleAuthLoss, harvestFrom, patch]);

  const signIn = useCallback(async () => {
    patch({ error: null });
    const session = await auth.signIn();
    // Ahead of the patch: the refresh below runs before React re-renders, and
    // the harvest it triggers has to know whose mailbox this is.
    sessionRef.current = session;
    patch({ session, ...(await attach(session)) });
    await refreshInbox();
  }, [attach, patch, refreshInbox]);

  const signOut = useCallback(async () => {
    await auth.signOut();
    mailRef.current = null;
    messagesRef.current = [];
    verifyLinkRef.current = null;
    patch({ session: null, identity: null, messages: [], verifyLink: null });
  }, [patch]);

  /** Inbox-row state, from headers only — no decryption, no network. */
  const encryptionFor = useCallback(
    (summary: MailSummary): EncryptionState => {
      if (summary.subject.trim() !== PLACEHOLDER_SUBJECT) return { kind: 'plain' };
      // Our own copy: encrypted to our key, so it is readable and trusted here.
      if (summary.from.address === state.session?.email) {
        return { kind: 'encrypted', trust: 'verified', own: true };
      }
      const key = findKey(state.keyring, summary.from.address);
      if (!key) return { kind: 'encrypted', trust: 'unknown' };
      return { kind: 'encrypted', trust: key.trust === 'verified' ? 'verified' : key.trust };
    },
    [state.keyring, state.session?.email],
  );

  const openMessage = useCallback(
    async (summary: MailSummary): Promise<OpenedMessage> => {
      if (!mailRef.current) throw new Error('Not connected.');
      const raw = await mailRef.current.getRaw(summary.id);

      if (!core.looksEncrypted(raw)) {
        return {
          summary,
          encryption: { kind: 'plain' },
          subject: summary.subject,
          body: plainBodyOf(raw),
          decrypted: null,
          raw,
        };
      }

      try {
        const decrypted = await core.parseEncrypted(raw);

        // Autocrypt: cache the sender's key so replies encrypt without a paste
        // step. Same helper the inbox sync uses, and it swallows a malformed
        // header rather than letting it break reading the message.
        const keyring = await commitKeyring(
          await harvestAutocrypt(
            keyringRef.current,
            summary.from.address,
            decrypted.autocryptKey,
            summary.from.name,
          ),
        );

        // Index the decrypted subject/body so the inbox can search encrypted mail
        // by its real content — not just its sender. Only content decrypted on
        // this device is stored; unopened ciphertext stays unsearchable.
        const searchIndex = indexContent(state.searchIndex, summary.id, {
          subject: decrypted.subject,
          body: decrypted.body,
        });
        await saveSearchIndex(searchIndex);
        patch({ searchIndex });

        if (summary.from.address === state.session?.email) {
          return {
            summary,
            encryption: { kind: 'encrypted', trust: 'verified', own: true },
            subject: decrypted.subject,
            body: decrypted.body,
            decrypted,
            raw,
          };
        }

        const key = findKey(keyring, summary.from.address);
        const signedByKnownKey =
          decrypted.signature === 'valid' &&
          !!key &&
          (!decrypted.signerFingerprint || decrypted.signerFingerprint === key.fingerprint);

        return {
          summary,
          encryption: {
            kind: 'encrypted',
            trust: !key ? 'unknown' : key.trust === 'changed' ? 'changed' : signedByKnownKey && key.trust === 'verified' ? 'verified' : 'seen',
          },
          subject: decrypted.subject,
          body: decrypted.body,
          decrypted,
          raw,
        };
      } catch (e) {
        return {
          summary,
          encryption: { kind: 'encrypted', trust: 'unknown' },
          subject: summary.subject,
          body: '',
          decrypted: null,
          raw,
          error: message(e),
        };
      }
    },
    [patch, state.keyring, state.searchIndex, state.session?.email],
  );

  const resolveRecipients = useCallback(
    (emails: string[]): RecipientState[] => resolveRecipientStates(state.keyring, state.identity, emails),
    [state.identity, state.keyring],
  );

  /**
   * Fetch keys for addresses we do not already hold one for.
   *
   * This is the step that makes the first message to a stranger encrypt. It runs
   * *before* `resolveRecipientStates` rather than inside it, because that
   * function decides whether a send is allowed and is worth keeping pure,
   * synchronous and free of anything that can fail.
   *
   * A directory key lands as `seen`, never `verified`: a keyserver is a party
   * that can hand out the wrong key, and only an out-of-band safety-number
   * comparison says otherwise. If the address already has a key with a different
   * fingerprint, `upsertKey` marks it `changed` and the send stops — which is
   * exactly what stops a keyserver from swapping a key you already trust.
   */
  const discover = useCallback(
    async (emails: string[]): Promise<Keyring> => {
      const self = identityRef.current?.email.trim().toLowerCase();
      const unknown = emails
        .map((e) => e.trim().toLowerCase())
        .filter((e, i, all) => e.length > 0 && all.indexOf(e) === i)
        .filter((e) => e !== self && !findKey(keyringRef.current, e));
      if (unknown.length === 0) return keyringRef.current;

      patch({ discovering: unknown });
      let keyring = keyringRef.current;
      // Rebuilt from this round rather than accumulated: an address that
      // resolves on a retry must stop being reported as unresolved.
      const unresolved: string[] = [];
      try {
        for (const email of unknown) {
          try {
            const found = await directory.lookup(email);
            if (!found) continue;
            const info = await core.importPublicKey(found.armored);
            // The directory answering an address with a key that does not claim
            // that address is either a bug or an attempt to get a key into the
            // ring under someone else's name. Either way it is not an answer.
            //
            // "Claims it" means *any* of the key's User IDs, not just the
            // primary one the core reports: one key commonly carries several
            // addresses, and a keyserver serves it for each. Comparing against
            // the primary alone rejects a perfectly good key and reports the
            // recipient as having none — which holds their message forever.
            // (`addressesInKey` reads real OpenPGP packets, which demo armor is
            // not — so the core's own answer is checked first and demo mode
            // keeps working exactly as before.)
            const claims =
              info.email.trim().toLowerCase() === email || addressesInKey(found.armored).includes(email);
            if (!claims) continue;
            // Filed under the address we asked about, which is what every
            // keyring lookup uses. The same key legitimately appears under each
            // of its addresses; `fingerprint` still identifies the one key.
            keyring = upsertKey(keyring, { ...info, email }, 'directory');
          } catch {
            // Reaching here means we did *not* establish that the address has no
            // key: a definite "nothing published" leaves via `continue` above,
            // never by throwing. What throws is a directory we could not reach,
            // or a key that came back and would not import — and neither is
            // evidence about whether this person uses encryption.
            //
            // The send path treats all of it as "not yet", never as "send it in
            // the clear". But the *user* is owed the difference, because "they
            // have no key" invites them and waits, while "we could not find out"
            // is a fault on our side that may clear on the next attempt.
            unresolved.push(email);
          }
        }
        return await commitKeyring(keyring);
      } finally {
        patch({ discovering: [], undiscoverable: unresolved });
      }
    },
    [commitKeyring, patch],
  );

  const discoverRecipients = useCallback(
    async (emails: string[]): Promise<RecipientState[]> =>
      resolveRecipientStates(await discover(emails), identityRef.current, emails),
    [discover],
  );

  /**
   * Mint this device's identity.
   *
   * Only ever called from the setup screen, and only after the user has been
   * offered a restore — see `attach`.
   */
  const createIdentity = useCallback(async (): Promise<Identity> => {
    const session = sessionRef.current;
    if (!session) throw new Error('Not connected.');
    const identity = await core.generateIdentity(session.email);
    identityRef.current = identity;
    // Nothing found for the old key says anything about this one.
    verifyLinkRef.current = null;
    patch({ identity, verifyLink: null });
    return identity;
  }, [patch]);

  const publishStatus = useCallback(
    (): PublishStatus => publishStatusFor(state.publish, state.identity?.fingerprint ?? null),
    [state.identity?.fingerprint, state.publish],
  );

  /**
   * List this device's public key in the directory.
   *
   * Only ever called from an explicit user action. The listing is public —
   * anyone can learn from it that this address has a key — so it is a consent
   * decision, and one the app states plainly rather than making quietly.
   */
  const publishOwnKey = useCallback(async (): Promise<PublishState> => {
    const identity = identityRef.current;
    if (!identity) throw new CoreError('This device has no identity key yet.', 'no-key');

    const { status } = await directory.publish(identity.publicKeyArmored, identity.email);
    const publish = await savePublishState(
      status === 'published' ? 'published' : 'pending',
      identity.fingerprint,
    );
    // A fresh upload means a fresh confirmation mail. Any link found before this
    // belongs to the previous attempt, and offering it would send the user to a
    // token the keyserver has already superseded.
    verifyLinkRef.current = null;
    patch({ publish, verifyLink: null });
    return publish;
  }, [patch]);

  const declinePublish = useCallback(async (): Promise<PublishState> => {
    const publish = await savePublishState('declined', identityRef.current?.fingerprint ?? null);
    verifyLinkRef.current = null;
    patch({ publish, verifyLink: null });
    return publish;
  }, [patch]);

  /**
   * Find the directory's confirmation link in the mailbox it was sent to.
   *
   * The link is what turns a stored key into a *findable* one, and it arrives as
   * an ordinary email in the account CryptMail is already syncing. Sending the
   * user off to another mail client to finish something they started here is
   * where this flow loses people.
   *
   * Deliberately no new `MailClient` method: the seam is provider-agnostic, and
   * adding a search primitive to it for one feature is not a trade worth making.
   * This reads the messages the last sync already returned, which is also the
   * honest limitation — see `verifyLink` in the Keys screen copy.
   *
   * Costs one `getRaw` per keyserver message in the synced window, which in
   * practice is zero or one, and only while publication is pending.
   */
  const findVerifyLink = useCallback(
    async (identity: Identity) => {
      if (!mailRef.current || verifyLinkRef.current) return;

      // Newest first: publishing twice means two confirmation mails, and only
      // the most recent one names the key this device now holds.
      const candidates = messagesRef.current
        .filter((m) => isKeyserverSender(m.from.address))
        .sort((a, b) => b.date.localeCompare(a.date));

      for (const summary of candidates) {
        try {
          const raw = await mailRef.current.getRaw(summary.id);
          const link = verifyLinkFrom({
            from: summary.from.address,
            body: plainBodyOf(raw),
            fingerprint: identity.fingerprint,
          });
          if (link) {
            verifyLinkRef.current = link;
            patch({ verifyLink: link });
            return;
          }
        } catch {
          // A message that will not fetch is not a reason to stop looking, and
          // not a reason to say anything: the pending copy already stands on
          // its own without this button.
        }
      }
    },
    [patch],
  );

  /**
   * Notice that a pending publication has been confirmed.
   *
   * `keys.openpgp.org` will not serve a key by address until the address owner
   * clicks the link it emails. Rather than parse that mail *for the answer*, the
   * app asks the directory the same question a stranger would: is this key
   * served for this address yet? A yes is the confirmation, whichever device
   * clicked the link.
   *
   * Only if the answer is still no does it look for the link itself — an offer
   * to finish the job, never the thing that decides the state.
   */
  const refreshPublish = useCallback(async () => {
    const identity = identityRef.current;
    if (!identity) return;
    if (publishStatusFor(publishRef.current, identity.fingerprint) !== 'pending') return;

    try {
      const found = await directory.lookup(identity.email);
      const info = found ? await core.importPublicKey(found.armored) : null;
      if (info && normaliseFingerprint(info.fingerprint) === normaliseFingerprint(identity.fingerprint)) {
        verifyLinkRef.current = null;
        patch({ publish: await savePublishState('published', identity.fingerprint), verifyLink: null });
        return;
      }
    } catch {
      // The directory being unreachable says nothing about the key's state.
    }

    await findVerifyLink(identity);
  }, [findVerifyLink, patch]);

  const importKey = useCallback(
    async (armored: string, name?: string) => {
      const info = await core.importPublicKey(armored);
      // A real key carries a User ID ("Ada Lovelace <ada@…>"); use its name so
      // the contact isn't shown as just an address. An explicit name still wins.
      const displayName = name ?? (info.userId ? userIdDisplayName(info.userId) : undefined);
      const keyring = upsertKey(state.keyring, info, 'manual', displayName);
      await saveKeyring(keyring);
      patch({ keyring });
      return keyring[info.email];
    },
    [patch, state.keyring],
  );

  const forgetKey = useCallback(
    async (email: string) => {
      const keyring = removeKey(state.keyring, email);
      await saveKeyring(keyring);
      patch({ keyring });
    },
    [patch, state.keyring],
  );

  /**
   * Record that the user compared this contact's key out of band.
   *
   * Takes the fingerprint they actually verified rather than trusting the call
   * site. Two things follow:
   *
   *  · A stale screen cannot certify the wrong key. If the contact's key
   *    changed after the safety number was rendered, `confirmedFingerprint` no
   *    longer matches what is stored, and verification fails instead of
   *    marking the *new* key verified on the strength of the old one's check.
   *  · `verified` always means a specific key was checked, not an address.
   */
  const markVerified = useCallback(
    async (email: string, confirmedFingerprint: string) => {
      const existing = findKey(state.keyring, email);
      if (!existing) {
        throw new CoreError(`No key stored for ${email}.`, 'no-key');
      }

      if (normaliseFingerprint(existing.fingerprint) !== normaliseFingerprint(confirmedFingerprint)) {
        throw new CoreError(
          `${email}'s key changed while you were verifying it. Compare the new safety number before trusting it.`,
          'malformed',
        );
      }

      const keyring = {
        ...state.keyring,
        [existing.email]: { ...existing, trust: 'verified' as const, verifiedAt: new Date().toISOString() },
      };
      await saveKeyring(keyring);
      patch({ keyring });
    },
    [patch, state.keyring],
  );

  /**
   * The digits both people compare. Needs our identity, so it lives here rather
   * than in the screen.
   */
  const safetyNumberFor = useCallback(
    async (email: string): Promise<string> => {
      const contact = findKey(state.keyring, email);
      if (!contact) throw new CoreError(`No key stored for ${email}.`, 'no-key');
      if (!state.identity) throw new CoreError('This device has no identity key yet.', 'no-key');
      return safetyNumber(state.identity.fingerprint, contact.fingerprint);
    },
    [state.identity, state.keyring],
  );

  /**
   * Wrap this device's key under a fresh recovery code.
   *
   * The code is returned to the caller and deliberately goes no further — only
   * the *fact* of a backup is recorded. A recovery code stored on the device it
   * recovers protects nothing, since whatever can read the store can already
   * read the key.
   *
   * Each call issues a new code and supersedes the last blob, so a user who
   * loses the paper can simply take another backup.
   */
  const exportRecovery = useCallback(async (): Promise<RecoveryBackup> => {
    if (!state.identity) throw new CoreError('This device has no identity key yet.', 'no-key');

    const backup = await core.exportRecoveryBackup(state.identity.email);
    patch({ recovery: await recordBackup(state.identity.fingerprint) });
    return backup;
  }, [patch, state.identity]);

  /**
   * Adopt an identity from a backup, replacing whatever key this device holds.
   *
   * The keyring, drafts and search index are left alone — they are this
   * device's, not the backup's, and the restored identity can read everything
   * that was encrypted to it regardless.
   *
   * The backup mark is cleared rather than kept: it described the key this
   * device used to hold. Whether the *restored* key has a backup elsewhere is
   * not something this device can know, and claiming it does would be the one
   * false reassurance that costs a user their mail.
   */
  const restoreFromRecovery = useCallback(
    async (blob: string, code: string): Promise<Identity> => {
      const identity = await core.importRecoveryBackup(blob, code);
      identityRef.current = identity;
      verifyLinkRef.current = null;
      patch({ identity, recovery: await clearBackupRecord(), verifyLink: null });
      return identity;
    },
    [patch],
  );

  /**
   * The fail-safe gate. Encrypted send is only possible with the real core;
   * in demo mode the UI offers the flow but never puts unencrypted bytes on a
   * real wire (encryption.md: never silently downgrade to plaintext).
   */
  const canSendEncrypted = useCallback((): { allowed: boolean; reason?: string } => {
    if (cryptoMode === 'real') return { allowed: true };
    return { allowed: true, reason: 'Demo mode — the message is encoded, not encrypted.' };
  }, []);

  const saveDraft = useCallback(
    async (draft: Draft) => {
      const drafts = upsertDraft(state.drafts, draft);
      await saveDrafts(drafts);
      patch({ drafts });
    },
    [patch, state.drafts],
  );

  const deleteDraft = useCallback(
    async (id: string) => {
      const drafts = removeDraft(state.drafts, id);
      await saveDrafts(drafts);
      patch({ drafts });
    },
    [patch, state.drafts],
  );

  /**
   * Optimistic flag update: apply locally at once for a responsive feel, then
   * persist to the provider. If the provider rejects it, resync from the inbox.
   */
  const setFlags = useCallback(
    async (id: string, change: FlagPatch) => {
      if (!mailRef.current) return;
      patch({ messages: applyFlagPatch(state.messages, id, change) });
      try {
        await mailRef.current.updateFlags(id, change);
      } catch {
        void refreshInbox();
      }
    },
    [patch, refreshInbox, state.messages],
  );

  const toggleStar = useCallback(
    async (id: string) => {
      const starred = state.messages.find((m) => m.id === id)?.starred ?? false;
      await setFlags(id, { starred: !starred });
    },
    [setFlags, state.messages],
  );

  const setUnread = useCallback((id: string, unread: boolean) => setFlags(id, { unread }), [setFlags]);

  const archiveMessage = useCallback((id: string) => setFlags(id, { archived: true }), [setFlags]);

  /**
   * Invite people who have no key yet — and say nothing about the message.
   *
   * A plaintext email whose entire content is "someone sent you an encrypted
   * message; install CryptMail to read it", plus the sender's public key in an
   * `Autocrypt` header so a fresh install can answer encrypted with no setup.
   * It carries no subject, no body, no hint of either: the held message is the
   * thing being protected, and an invite that leaked its subject line would be
   * the plaintext downgrade wearing a different hat.
   *
   * This is deliberately *not* `sendPlain`. That action is the user's explicit
   * choice to send their message in the clear, and nothing on the encrypted
   * path may reach it (rule 1).
   */
  const sendInvites = useCallback(
    async (emails: string[]) => {
      const session = sessionRef.current;
      const identity = identityRef.current;
      if (!mailRef.current || !session || !identity) return;

      const now = new Date();
      let log = invitesRef.current;
      for (const email of emails) {
        if (!shouldInvite(log, email, now)) continue;
        try {
          await mailRef.current.send(
            buildPlaintext({
              from: session.email,
              to: [email],
              subject: 'An encrypted message is waiting for you',
              body:
                `${session.email} sent you a message with CryptMail, which encrypts mail so that ` +
                'only the two of you can read it.\n\n' +
                'It has not been delivered: encryption cannot be added after the fact, so the ' +
                'message is waiting until there is a key to encrypt it to. Install CryptMail and ' +
                'sign in with this address and it arrives on its own.\n\n' +
                'This email contains none of that message — not its subject, not a word of its ' +
                'contents. It carries the sender\'s public key, so your first reply can be ' +
                'encrypted too.\n\n' +
                'https://github.com/neo999in/cryptmail',
              autocryptKey: identity.publicKeyArmored,
            }),
          );
          log = recordInvite(log, email, now);
        } catch {
          // An invite that cannot be sent must not lose the message it is about.
          // The held message stays held and the next drain tries again.
        }
      }
      if (log !== invitesRef.current) {
        invitesRef.current = log;
        await saveInvites(log);
        patch({ invites: log });
      }
    },
    [patch],
  );

  /**
   * Put a message in the outbox to wait for a key.
   *
   * Stored like any scheduled send — sealed at rest by `secureJson`, and no
   * ciphertext yet, because there is nothing to encrypt it to.
   */
  const holdForKey = useCallback(
    async (item: Held) => {
      const scheduled = upsertScheduled(scheduledRef.current, item);
      scheduledRef.current = scheduled;
      await saveOutbox(scheduled);
      patch({ scheduled });
    },
    [patch],
  );

  /**
   * Build and hand an encrypted message to the provider — or hold it.
   *
   * Three outcomes, and plaintext is not one of them:
   *
   *  · every recipient has a usable key → encrypted and sent.
   *  · someone has no key at all → the message waits in the outbox and they get
   *    a contentless invite. Delivery happens when they have a key.
   *  · someone's key *changed* → nothing is sent and nothing is held. A changed
   *    fingerprint is a possible key substitution, and waiting cannot resolve
   *    it; only a person re-verifying the key can.
   */
  const deliver = useCallback(
    async ({
      id,
      to,
      subject,
      body,
    }: {
      id?: string;
      to: string[];
      subject: string;
      body: string;
    }): Promise<SendOutcome> => {
      const session = sessionRef.current;
      const identity = identityRef.current;
      if (!mailRef.current || !session || !identity) throw new Error('Not connected.');

      const recipients = await discoverRecipients(to);

      const changed = recipients.filter((r) => r.status === 'changed');
      if (changed.length > 0) {
        throw new CoreError(
          `The key for ${changed.map((r) => r.email).join(', ')} changed fingerprint. ` +
            'Compare the new safety number before sending — CryptMail will not send to a key it cannot vouch for.',
          'malformed',
        );
      }

      const missing = recipients.filter((r) => r.status === 'missing').map((r) => r.email);
      if (missing.length > 0) {
        await holdForKey({
          id: id ?? newOutboxId(),
          to,
          subject,
          body,
          sendAt: new Date().toISOString(),
          reason: 'awaiting-key',
          pending: missing,
        });
        await sendInvites(missing);
        return { status: 'queued', pending: missing };
      }

      const gate = canSendEncrypted();
      if (!gate.allowed) throw new CoreError(gate.reason ?? 'Sending is disabled.', 'unavailable');

      const rfc822 = await core.buildEncrypted({
        from: session.email,
        to,
        subject,
        body,
        // Encrypt to the sender too, so the message is readable in Sent. A
        // self-addressed message already resolved to this same key, hence the
        // dedupe — encrypting to one key twice would emit two PKESK packets for
        // it.
        recipientKeys: [...new Set([...recipients.map((r) => r.key!.armored), identity.publicKeyArmored])],
        autocryptKey: identity.publicKeyArmored,
      });

      await mailRef.current.send(rfc822);
      return { status: 'sent' };
    },
    [canSendEncrypted, discoverRecipients, holdForKey, sendInvites],
  );

  const sendEncrypted = useCallback(
    async (input: { id?: string; to: string[]; subject: string; body: string }): Promise<SendOutcome> => {
      const outcome = await deliver(input);
      if (outcome.status === 'sent') await refreshInbox();
      return outcome;
    },
    [deliver, refreshInbox],
  );

  /**
   * Plaintext send (prototype-plan.md M4).
   *
   * This is *not* a downgrade path. encryption.md permits an explicit opt-out
   * ("Requires an explicit, logged action") and features.md 0.14 asks for it,
   * but only as a choice the user makes up front. So: nothing in `deliver` or
   * `sendEncrypted` may ever call this, and this never inspects the keyring —
   * consulting keys here would be the first step toward "encrypt if we can,
   * send clear if we can't", which is exactly the behaviour rule 1 forbids.
   *
   * It does still carry the sender's own `Autocrypt` header, which
   * encryption.md requires of *every* outgoing message — "encrypted mail and
   * the plaintext invite alike". Omitting it here was an oversight, and a
   * costly one: a deliberately-unencrypted email is precisely the message that
   * has to bootstrap, and without the header the recipient learns nothing about
   * how to answer encrypted.
   *
   * That is not a crack in rule 1, and the difference is worth being exact
   * about, because it decides how this is written. The invariant is not "the
   * plaintext path touches no key material" — it is that **nothing here may
   * branch on the recipient's key state**. Our own public key is attached
   * unconditionally: nothing is read about the recipient, no decision is made
   * from one, and the sentence above stays literally true.
   */
  const sendPlain = useCallback(
    async (input: { to: string[]; subject: string; body: string }) => {
      if (!mailRef.current || !state.session) throw new Error('Not connected.');
      if (input.to.length === 0) throw new Error('Add a recipient first.');

      await mailRef.current.send(
        buildPlaintext({
          from: state.session.email,
          to: input.to,
          subject: input.subject,
          body: input.body,
          // Undefined until the user has generated a key — being signed in
          // without an identity is a real state, since setup is its own step —
          // and `buildPlaintext` simply omits the header when it is.
          autocryptKey: identityRef.current?.publicKeyArmored,
        }),
      );
      await refreshInbox();
    },
    [refreshInbox, state.session],
  );

  const scheduleSend = useCallback(
    async (input: { id?: string; to: string[]; subject: string; body: string; sendAt: string }) => {
      // A changed fingerprint stops this here, exactly as it stops a send now:
      // it is a possible key substitution, and scheduling one for later is no
      // better than sending it. A recipient with *no* key is different — the
      // send path holds that message and invites them, so scheduling it is
      // honest and the hold simply starts when the send time arrives.
      const changed = (await discoverRecipients(input.to)).filter((r) => r.status === 'changed');
      if (changed.length > 0) {
        throw new CoreError(
          `The key for ${changed.map((r) => r.email).join(', ')} changed fingerprint. ` +
            'Compare the new safety number before scheduling this.',
          'malformed',
        );
      }
      const item: Held = {
        id: input.id ?? newOutboxId(),
        to: input.to,
        subject: input.subject,
        body: input.body,
        sendAt: input.sendAt,
        reason: 'time',
      };
      const scheduled = upsertScheduled(scheduledRef.current, item);
      scheduledRef.current = scheduled;
      await saveOutbox(scheduled);
      patch({ scheduled });
    },
    [discoverRecipients, patch],
  );

  const cancelScheduled = useCallback(
    async (id: string) => {
      const scheduled = removeScheduled(state.scheduled, id);
      await saveOutbox(scheduled);
      patch({ scheduled });
    },
    [patch, state.scheduled],
  );

  /**
   * Try a queued message now, and say what happened.
   *
   * The outcome is returned rather than swallowed because for an `awaiting-key`
   * hold this action is not "send", it is *"check whether they have a key yet"* —
   * and a check whose answer is discarded is indistinguishable from a button
   * that does nothing. `null` means the id was no longer in the outbox.
   *
   * Note that this can still *throw*: `deliver` refuses outright when a
   * recipient's key changed fingerprint. That is a third outcome, and the caller
   * has to show it.
   */
  const sendScheduledNow = useCallback(
    async (id: string): Promise<SendOutcome | null> => {
      const item = scheduledRef.current[id];
      if (!item) return null;
      // The same id goes back in: if this turns out to be un-sendable yet,
      // `deliver` re-holds *this* message rather than leaving a duplicate, and
      // the removal below is skipped so nothing is silently dropped.
      const outcome = await deliver({ id, to: item.to, subject: item.subject, body: item.body });
      if (outcome.status !== 'sent') return outcome;
      const scheduled = removeScheduled(scheduledRef.current, id);
      scheduledRef.current = scheduled;
      await saveOutbox(scheduled);
      patch({ scheduled });
      await refreshInbox();
      return outcome;
    },
    [deliver, patch, refreshInbox],
  );

  /**
   * Release messages that were waiting for a recipient's key.
   *
   * Runs on launch, on every scheduler tick and after every inbox sync, because
   * the event it is waiting for — somebody installing CryptMail and publishing a
   * key — arrives with no notification of any kind. Frequent cheap checks beat a
   * clever schedule: with nothing held this does no work at all.
   *
   * Each message goes back through `deliver`, so a recipient whose key turned up
   * `changed` in the meantime is not swept out with the rest.
   */
  const drainHeld = useCallback(async () => {
    const waiting = listScheduled(scheduledRef.current).filter(
      (item) => holdReason(item) === 'awaiting-key' && !inFlight.current.has(item.id),
    );
    if (waiting.length === 0) return;

    // One more look for the addresses still missing a key. This is the retry
    // that makes the whole queue work — but it is also a request to somebody
    // else's keyserver, and this runs every fifteen seconds and after every
    // sync. Checking the keyring costs nothing and happens every time; asking
    // the directory is rate-limited to something a stranger installing an app
    // could plausibly beat.
    const now = Date.now();
    if (now - lastDirectoryRetry.current >= HELD_LOOKUP_INTERVAL_MS) {
      lastDirectoryRetry.current = now;
      await discover(waiting.flatMap((item) => stillPending(item, keyringRef.current, identityRef.current)));
    }

    const ready = resolvableHeld(scheduledRef.current, keyringRef.current, identityRef.current).filter(
      (item) => !inFlight.current.has(item.id),
    );

    const sent: string[] = [];
    for (const item of ready) {
      inFlight.current.add(item.id);
      try {
        const outcome = await deliver({ id: item.id, to: item.to, subject: item.subject, body: item.body });
        if (outcome.status === 'sent') sent.push(item.id);
      } catch (e) {
        if (needsReauth(e)) handleAuthLoss(e);
        // Anything else — a changed key, a provider hiccup — leaves the message
        // held. It is not lost, and the next drain will look again.
      } finally {
        inFlight.current.delete(item.id);
      }
    }
    if (sent.length === 0) return;

    let scheduled = scheduledRef.current;
    for (const id of sent) scheduled = removeScheduled(scheduled, id);
    scheduledRef.current = scheduled;
    await saveOutbox(scheduled);
    patch({ scheduled });
  }, [deliver, discover, handleAuthLoss, patch]);

  drainRef.current = drainHeld;
  refreshPublishRef.current = refreshPublish;

  // Client-side scheduler: deliver due messages while the app runs and catch up
  // on launch. Results are applied against the latest state (refs) so a schedule
  // made mid-tick is not lost; a send that fails is preserved as a draft.
  const runScheduler = useCallback(async () => {
    await drainHeld();

    const now = new Date().toISOString();
    const due = dueScheduled(scheduledRef.current, now).filter((s) => !inFlight.current.has(s.id));
    if (due.length === 0) return;
    for (const s of due) inFlight.current.add(s.id);

    const sent: string[] = [];
    const rescued: Draft[] = [];
    for (const item of due) {
      try {
        // Passing the id keeps a message that turns out to need a key from
        // being duplicated: `deliver` re-holds this same entry as awaiting-key,
        // and it is neither counted as sent nor rescued into drafts.
        const outcome = await deliver({ id: item.id, to: item.to, subject: item.subject, body: item.body });
        if (outcome.status === 'sent') sent.push(item.id);
      } catch (e) {
        // Rescued as a draft either way; but a revoked grant also has to stop
        // the 15-second loop from retrying a send that cannot succeed.
        if (needsReauth(e)) handleAuthLoss(e);
        rescued.push({
          id: item.id,
          to: item.to,
          subject: item.subject,
          body: item.body,
          updatedAt: new Date().toISOString(),
        });
      } finally {
        inFlight.current.delete(item.id);
      }
    }

    let scheduled = scheduledRef.current;
    let drafts = draftsRef.current;
    for (const id of sent) scheduled = removeScheduled(scheduled, id);
    for (const d of rescued) {
      scheduled = removeScheduled(scheduled, d.id);
      drafts = upsertDraft(drafts, d);
    }
    await saveOutbox(scheduled);
    if (rescued.length > 0) await saveDrafts(drafts);
    patch({
      scheduled,
      drafts,
      ...(rescued.length > 0
        ? { error: `Couldn't send ${rescued.length} scheduled message${rescued.length > 1 ? 's' : ''}; saved to drafts.` }
        : {}),
    });
    if (sent.length > 0) await refreshInbox();
  }, [deliver, drainHeld, handleAuthLoss, patch, refreshInbox]);

  const schedulerRef = useRef(runScheduler);
  schedulerRef.current = runScheduler;
  useEffect(() => {
    if (!state.session) return;
    void schedulerRef.current(); // catch up on launch / after sign-in
    const handle = setInterval(() => void schedulerRef.current(), 15000);
    return () => clearInterval(handle);
  }, [state.session]);

  const value = useMemo(
    () => ({
      ...state,
      signIn,
      signOut,
      refreshInbox,
      openMessage,
      encryptionFor,
      resolveRecipients,
      discoverRecipients,
      createIdentity,
      publishOwnKey,
      declinePublish,
      publishStatus,
      importKey,
      forgetKey,
      markVerified,
      safetyNumberFor,
      exportRecovery,
      restoreFromRecovery,
      sendEncrypted,
      sendPlain,
      canSendEncrypted,
      saveDraft,
      deleteDraft,
      toggleStar,
      setUnread,
      archiveMessage,
      scheduleSend,
      cancelScheduled,
      sendScheduledNow,
    }),
    [
      state,
      signIn,
      signOut,
      refreshInbox,
      openMessage,
      encryptionFor,
      resolveRecipients,
      discoverRecipients,
      createIdentity,
      publishOwnKey,
      declinePublish,
      publishStatus,
      importKey,
      forgetKey,
      markVerified,
      safetyNumberFor,
      exportRecovery,
      restoreFromRecovery,
      sendEncrypted,
      sendPlain,
      canSendEncrypted,
      saveDraft,
      deleteDraft,
      toggleStar,
      setUnread,
      archiveMessage,
      scheduleSend,
      cancelScheduled,
      sendScheduledNow,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

/* ------------------------------------------------------------- helpers ---- */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const newOutboxId = () => `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * How often a held message may re-ask the directory about its recipients.
 *
 * The queue is drained on every launch, every scheduler tick and every sync;
 * without this, a single held message would poll a public keyserver four times a
 * minute for as long as it waits, which is days.
 */
const HELD_LOOKUP_INTERVAL_MS = 5 * 60 * 1000;
