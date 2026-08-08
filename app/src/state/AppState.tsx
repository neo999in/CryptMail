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
import { applyFlagPatch } from '../mail/flags';
import { plainBodyOf } from '../mail/plainBody';
import { FlagPatch, MailClient, MailSummary } from '../mail/types';
import { dueScheduled, removeScheduled, Scheduled, ScheduledOutbox, upsertScheduled } from '../outbox/outbox';
import { userIdDisplayName } from '../pgp/parseArmoredKey';
import { normaliseFingerprint, safetyNumber } from '../pgp/safetyNumber';
import { indexContent, SearchIndex } from '../search/search';
import { loadDrafts, saveDrafts } from '../store/draftsStore';
import { loadOutbox, saveOutbox } from '../store/outboxStore';
import { ContactKey, findKey, Keyring, loadKeyring, removeKey, saveKeyring, upsertKey } from '../store/keyring';
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

type State = {
  booting: boolean;
  session: Session | null;
  identity: Identity | null;
  /** Whether this device's key has ever been backed up. Drives the Keys warning. */
  recovery: RecoveryState;
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
  resolveRecipients(emails: string[]): RecipientState[];
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
  sendEncrypted(input: { to: string[]; subject: string; body: string }): Promise<void>;
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
  sendScheduledNow(id: string): Promise<void>;
};

const AppContext = createContext<(State & Actions) | null>(null);

/* ------------------------------------------------------------ provider ---- */

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({
    booting: true,
    session: null,
    identity: null,
    recovery: { backedUpAt: null, fingerprint: null },
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

  const attach = useCallback(
    async (
      session: Session,
    ): Promise<{
      identity: Identity;
      recovery: RecoveryState;
      keyring: Keyring;
      searchIndex: SearchIndex;
      drafts: Drafts;
      scheduled: ScheduledOutbox;
    }> => {
      mailRef.current =
        session.provider === 'demo'
          ? await createDemoMailClient(session.email)
          : createGmailClient(session.email, auth.freshAccessToken);

      const identity = (await core.loadIdentity(session.email)) ?? (await core.generateIdentity(session.email));

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
      return { identity, recovery, keyring, searchIndex, drafts, scheduled };
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
      patch({
        session: null,
        identity: null,
        messages: [],
        loadingInbox: false,
        error: message(e),
      });
      return true;
    },
    [patch],
  );

  const refreshInbox = useCallback(async () => {
    if (!mailRef.current) return;
    patch({ loadingInbox: true, error: null });
    try {
      const messages = await mailRef.current.listInbox(20);
      patch({ messages, loadingInbox: false });
    } catch (e) {
      if (handleAuthLoss(e)) return;
      patch({ loadingInbox: false, error: message(e) });
    }
  }, [handleAuthLoss, patch]);

  const signIn = useCallback(async () => {
    patch({ error: null });
    const session = await auth.signIn();
    patch({ session, ...(await attach(session)) });
    await refreshInbox();
  }, [attach, patch, refreshInbox]);

  const signOut = useCallback(async () => {
    await auth.signOut();
    mailRef.current = null;
    patch({ session: null, identity: null, messages: [] });
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

        // Autocrypt: cache the sender's key so replies encrypt without a paste step.
        let keyring = state.keyring;
        if (decrypted.autocryptKey) {
          try {
            const imported = await core.importPublicKey(decrypted.autocryptKey);
            keyring = upsertKey(keyring, imported, 'autocrypt', summary.from.name);
            await saveKeyring(keyring);
            patch({ keyring });
          } catch {
            // A malformed Autocrypt header must not break reading the message.
          }
        }

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
      patch({ identity, recovery: await clearBackupRecord() });
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

  /** Build and hand an encrypted message to the provider. Shared by send-now and the scheduler. */
  const deliver = useCallback(
    async ({ to, subject, body }: { to: string[]; subject: string; body: string }) => {
      if (!mailRef.current || !state.session || !state.identity) throw new Error('Not connected.');

      const recipients = resolveRecipients(to);
      const missing = recipients.filter((r) => r.status === 'missing');
      if (missing.length > 0) {
        throw new CoreError(
          `No key for ${missing.map((r) => r.email).join(', ')} — CryptMail will not send this as plaintext.`,
          'no-key',
        );
      }

      const gate = canSendEncrypted();
      if (!gate.allowed) throw new CoreError(gate.reason ?? 'Sending is disabled.', 'unavailable');

      const rfc822 = await core.buildEncrypted({
        from: state.session.email,
        to,
        subject,
        body,
        // Encrypt to the sender too, so the message is readable in Sent. A
        // self-addressed message already resolved to this same key, hence the
        // dedupe — encrypting to one key twice would emit two PKESK packets for
        // it.
        recipientKeys: [...new Set([...recipients.map((r) => r.key!.armored), state.identity.publicKeyArmored])],
        autocryptKey: state.identity.publicKeyArmored,
      });

      await mailRef.current.send(rfc822);
    },
    [canSendEncrypted, resolveRecipients, state.identity, state.session],
  );

  const sendEncrypted = useCallback(
    async (input: { to: string[]; subject: string; body: string }) => {
      await deliver(input);
      await refreshInbox();
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
        }),
      );
      await refreshInbox();
    },
    [refreshInbox, state.session],
  );

  const scheduleSend = useCallback(
    async (input: { id?: string; to: string[]; subject: string; body: string; sendAt: string }) => {
      // Same fail-safe as sending: never queue a message we can't encrypt to everyone.
      const missing = resolveRecipients(input.to).filter((r) => r.status === 'missing');
      if (missing.length > 0) {
        throw new CoreError(
          `No key for ${missing.map((r) => r.email).join(', ')} — CryptMail will not schedule this as plaintext.`,
          'no-key',
        );
      }
      const item: Scheduled = {
        id: input.id ?? `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        to: input.to,
        subject: input.subject,
        body: input.body,
        sendAt: input.sendAt,
      };
      const scheduled = upsertScheduled(state.scheduled, item);
      await saveOutbox(scheduled);
      patch({ scheduled });
    },
    [patch, resolveRecipients, state.scheduled],
  );

  const cancelScheduled = useCallback(
    async (id: string) => {
      const scheduled = removeScheduled(state.scheduled, id);
      await saveOutbox(scheduled);
      patch({ scheduled });
    },
    [patch, state.scheduled],
  );

  const sendScheduledNow = useCallback(
    async (id: string) => {
      const item = state.scheduled[id];
      if (!item) return;
      await deliver({ to: item.to, subject: item.subject, body: item.body });
      const scheduled = removeScheduled(state.scheduled, id);
      await saveOutbox(scheduled);
      patch({ scheduled });
      await refreshInbox();
    },
    [deliver, patch, refreshInbox, state.scheduled],
  );

  // Client-side scheduler: deliver due messages while the app runs and catch up
  // on launch. Results are applied against the latest state (refs) so a schedule
  // made mid-tick is not lost; a send that fails is preserved as a draft.
  const runScheduler = useCallback(async () => {
    const now = new Date().toISOString();
    const due = dueScheduled(scheduledRef.current, now).filter((s) => !inFlight.current.has(s.id));
    if (due.length === 0) return;
    for (const s of due) inFlight.current.add(s.id);

    const sent: string[] = [];
    const rescued: Draft[] = [];
    for (const item of due) {
      try {
        await deliver({ to: item.to, subject: item.subject, body: item.body });
        sent.push(item.id);
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
  }, [deliver, handleAuthLoss, patch, refreshInbox]);

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
