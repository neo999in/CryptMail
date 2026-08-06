import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { auth, Session } from '../auth';
import { cryptoMode } from '../config';
import { buildPlaintext, core, CoreError, DecryptedMessage, Identity, PLACEHOLDER_SUBJECT } from '../core';
import { createDemoMailClient, demoContactKeys, demoContacts } from '../mail/demoMail';
import { createGmailClient } from '../mail/gmail';
import { Draft, Drafts, removeDraft, upsertDraft } from '../drafts/drafts';
import { applyFlagPatch } from '../mail/flags';
import { FlagPatch, MailClient, MailSummary } from '../mail/types';
import { dueScheduled, removeScheduled, Scheduled, ScheduledOutbox, upsertScheduled } from '../outbox/outbox';
import { userIdDisplayName } from '../pgp/parseArmoredKey';
import { indexContent, SearchIndex } from '../search/search';
import { loadDrafts, saveDrafts } from '../store/draftsStore';
import { loadOutbox, saveOutbox } from '../store/outboxStore';
import { ContactKey, findKey, Keyring, loadKeyring, removeKey, saveKeyring, upsertKey } from '../store/keyring';
import { loadSearchIndex, saveSearchIndex } from '../store/searchIndex';

/* --------------------------------------------------------------- types ---- */

export type EncryptionState =
  | { kind: 'encrypted'; trust: 'verified' | 'seen' | 'changed' | 'unknown'; own?: boolean }
  | { kind: 'plain' };

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

/** Per-recipient outcome of key resolution — drives Compose's fail-safe. */
export type RecipientState = {
  email: string;
  key?: ContactKey;
  status: 'ok' | 'verified' | 'changed' | 'missing';
};

type State = {
  booting: boolean;
  session: Session | null;
  identity: Identity | null;
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
  markVerified(email: string): Promise<void>;
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
    ): Promise<{ identity: Identity; keyring: Keyring; searchIndex: SearchIndex; drafts: Drafts; scheduled: ScheduledOutbox }> => {
      mailRef.current =
        session.provider === 'demo'
          ? await createDemoMailClient(session.email)
          : createGmailClient(session.email, auth.freshAccessToken);

      const identity = (await core.loadIdentity(session.email)) ?? (await core.generateIdentity(session.email));

      let keyring = await loadKeyring();
      if (session.provider === 'demo' && Object.keys(keyring).length === 0) {
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
      return { identity, keyring, searchIndex, drafts, scheduled };
    },
    [],
  );

  // Boot: restore an existing session, if any.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await auth.restore();
        if (!session) {
          if (!cancelled) patch({ booting: false });
          return;
        }
        const { identity, keyring, searchIndex, drafts, scheduled } = await attach(session);
        if (!cancelled) patch({ booting: false, session, identity, keyring, searchIndex, drafts, scheduled });
      } catch (e) {
        if (!cancelled) patch({ booting: false, error: message(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attach, patch]);

  const refreshInbox = useCallback(async () => {
    if (!mailRef.current) return;
    patch({ loadingInbox: true, error: null });
    try {
      const messages = await mailRef.current.listInbox(20);
      patch({ messages, loadingInbox: false });
    } catch (e) {
      patch({ loadingInbox: false, error: message(e) });
    }
  }, [patch]);

  const signIn = useCallback(async () => {
    patch({ error: null });
    const session = await auth.signIn();
    const { identity, keyring, searchIndex, drafts, scheduled } = await attach(session);
    patch({ session, identity, keyring, searchIndex, drafts, scheduled });
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
    (emails: string[]): RecipientState[] =>
      emails.map((email) => {
        const key = findKey(state.keyring, email);
        if (!key) return { email, status: 'missing' };
        if (key.trust === 'changed') return { email, key, status: 'changed' };
        return { email, key, status: key.trust === 'verified' ? 'verified' : 'ok' };
      }),
    [state.keyring],
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

  const markVerified = useCallback(
    async (email: string) => {
      const existing = findKey(state.keyring, email);
      if (!existing) return;
      const keyring = { ...state.keyring, [email]: { ...existing, trust: 'verified' as const } };
      await saveKeyring(keyring);
      patch({ keyring });
    },
    [patch, state.keyring],
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
        // Encrypt to the sender too, so the message is readable in Sent.
        recipientKeys: [...recipients.map((r) => r.key!.armored), state.identity.publicKeyArmored],
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
      } catch {
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
  }, [deliver, patch, refreshInbox]);

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

function plainBodyOf(raw: string): string {
  const sep = raw.replace(/\r\n/g, '\n').indexOf('\n\n');
  return sep === -1 ? raw : raw.slice(sep + 2).trim();
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
