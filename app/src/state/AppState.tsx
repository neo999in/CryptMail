/**
 * The single seam between the screens and everything underneath them.
 *
 * Screens never call a provider, the core, or a store directly — they call
 * actions on `useApp()`. That boundary is what makes the demo/live swap and the
 * future Rust core a drop-in, so keep it.
 *
 * This file is now only the React end of that seam: state lives in `store.ts`,
 * and the work is in the service modules under `state/`, which are plain
 * TypeScript and know nothing about React —
 *
 *   session.ts    sign in/out, and loading what this account owns on the device
 *   accounts.ts   which mailbox is in front, and what else is connected
 *   mailbox.ts    syncing, opening a message, flags
 *   contacts.ts   the keyring: harvest, discovery, verification
 *   identity.ts   this device's own key, and its recovery backup
 *   publish.ts    listing that key in the directory
 *   send.ts       the send path — rule 1 lives there
 *   scheduler.ts  the outbox: waiting for a send time, or for a key
 *   drafts.ts     unsent compose drafts
 *
 * Everything they expose is assembled below into exactly the object `useApp()`
 * has always returned.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { MailSummary } from '../mail/types';
import { publishStatusFor, PublishStatus } from '../store/publishStore';
import { MailHolder, Services } from './contracts';
import { encryptionFor as deriveEncryptionFor } from './derive';
import { resolveRecipientStates } from './recipients';
import { createServices } from './services';
import { createStore, initialState, Store } from './store';
import { Actions, State } from './types';

export type { EncryptionState, OpenedMessage, RecipientState, SendOutcome } from './types';

/** How often the client-side scheduler looks for work while the app is open. */
const SCHEDULER_INTERVAL_MS = 15000;

const AppContext = createContext<(State & Actions) | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>(initialState);

  // Built once, on the first render, and never rebuilt: every action below is
  // therefore stable for the life of the app. Screens that hold one in a
  // dependency array get an effect that runs when its *inputs* change rather
  // than whenever the provider re-rendered.
  const wiring = useRef<{ store: Store; services: Services; mail: MailHolder } | null>(null);
  if (!wiring.current) {
    const store = createStore(state, setState);
    wiring.current = { store, ...createServices(store) };
  }
  const { services } = wiring.current;

  // The three derivations are the exception, and deliberately so: screens read
  // them during render and memoise on their identity, so each has to change
  // when the state it reads changes. See the note in `derive.ts`.
  const encryptionFor = useCallback(
    (summary: MailSummary) => deriveEncryptionFor(state.keyring, state.session?.email, summary),
    [state.keyring, state.session?.email],
  );

  const resolveRecipients = useCallback(
    (emails: string[]) => resolveRecipientStates(state.keyring, state.identity, emails),
    [state.identity, state.keyring],
  );

  const publishStatus = useCallback(
    (): PublishStatus => publishStatusFor(state.publish, state.identity?.fingerprint ?? null),
    [state.identity?.fingerprint, state.publish],
  );

  // Boot: restore an existing session, if any.
  useEffect(() => {
    let cancelled = false;
    void services.session.boot(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [services]);

  // Client-side scheduler: deliver due messages while the app runs, and catch up
  // on launch.
  useEffect(() => {
    if (!state.session) return;
    void services.scheduler.run();
    const handle = setInterval(() => void services.scheduler.run(), SCHEDULER_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [services, state.session]);

  const value = useMemo(
    (): State & Actions => ({
      ...state,
      signIn: services.session.signIn,
      signOut: services.session.signOut,
      addAccount: services.accounts.addAccount,
      switchAccount: services.accounts.switchAccount,
      removeAccount: services.accounts.removeAccount,
      setUnified: services.accounts.setUnified,
      refreshInbox: services.mailbox.refreshInbox,
      openMessage: services.mailbox.openMessage,
      encryptionFor,
      resolveRecipients,
      discoverRecipients: services.contacts.discoverRecipients,
      createIdentity: services.identity.createIdentity,
      publishOwnKey: services.publish.publishOwnKey,
      declinePublish: services.publish.declinePublish,
      publishStatus,
      importKey: services.contacts.importKey,
      forgetKey: services.contacts.forgetKey,
      markVerified: services.contacts.markVerified,
      safetyNumberFor: services.contacts.safetyNumberFor,
      exportRecovery: services.identity.exportRecovery,
      restoreFromRecovery: services.identity.restoreFromRecovery,
      sendEncrypted: services.send.sendEncrypted,
      sendPlain: services.send.sendPlain,
      canSendEncrypted: services.send.canSendEncrypted,
      saveDraft: services.drafts.saveDraft,
      deleteDraft: services.drafts.deleteDraft,
      toggleStar: services.mailbox.toggleStar,
      setUnread: services.mailbox.setUnread,
      archiveMessage: services.mailbox.archiveMessage,
      scheduleSend: services.scheduler.scheduleSend,
      cancelScheduled: services.scheduler.cancelScheduled,
      sendScheduledNow: services.scheduler.sendScheduledNow,
      markSpam: services.mailbox.markSpam,
      markNotSpam: services.mailbox.markNotSpam,
    }),
    [state, services, encryptionFor, resolveRecipients, publishStatus],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
