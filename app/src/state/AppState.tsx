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
 *   labels.ts     local labels on messages — never sent to the provider
 *   rules.ts      the user's filters & rules, run on this device
 *   notify.ts     noticing new mail, and posting what the policy allows
 *
 * Everything they expose is assembled below into exactly the object `useApp()`
 * has always returned.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState as OsAppState } from 'react-native';

import { attachForeground, backgroundIdle } from '../background/pass';
import { setBackgroundSchedule } from '../background/task';
import { MailSummary } from '../mail/types';
import { notificationPermission, onNotificationTap, requestNotificationPermission } from '../notifications/os';
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
  //
  // From here on a background pass runs on these services rather than building
  // its own. One that was already running headless when the app opened may
  // have sent a message without yet writing the outbox back, so boot — which
  // reads that outbox — waits for it first (`background/pass.ts`).
  useEffect(() => {
    let cancelled = false;
    const detach = attachForeground(wiring.current!);
    void backgroundIdle().then(() => {
      if (!cancelled) void services.session.boot(() => cancelled);
    });
    return () => {
      cancelled = true;
      detach();
    };
  }, [services]);

  // Client-side scheduler: deliver due messages while the app runs, and catch up
  // on launch. Closed, the background task takes over, at the OS's pace.
  useEffect(() => {
    if (!state.session) return;
    void services.scheduler.run();
    const handle = setInterval(() => void services.scheduler.run(), SCHEDULER_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [services, state.session]);

  // Background passes: the OS wakes one while the outbox holds anything, or
  // while a mailbox wants new-mail notifications, and not otherwise
  // (`background/task.ts`). Left alone while booting, when the outbox has not
  // been read yet and would look empty.
  const outboxWaiting = !!state.session && Object.keys(state.scheduled).length > 0;
  // Read through the service, which reads the store `state` was just set from.
  const notifying = !!state.session && services.notify.wanted();
  useEffect(() => {
    if (state.booting) return;
    void setBackgroundSchedule(outboxWaiting || notifying);
  }, [notifying, outboxWaiting, state.booting]);

  // Back in front: whatever the shade was counting for the mailboxes on screen
  // is about to be in view, so it is cleared rather than left to go stale.
  useEffect(() => {
    const subscription = OsAppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const { unified, activeAccount } = wiring.current!.store.get();
      if (unified) void services.notify.clear();
      else if (activeAccount) void services.notify.clear([activeAccount]);
    });
    return () => subscription.remove();
  }, [services]);

  // A tapped notification — including the one that launched the app — is put
  // in state; `ui/notificationRouter.tsx` opens it once a navigator exists.
  // Mark read opens nothing: it is done here, on these services. With the app
  // backgrounded, Android runs the notification task too, which lands on the
  // same services (`background/pass.ts`) — marking read twice is harmless.
  useEffect(
    () =>
      onNotificationTap((tap) => {
        if (tap.action !== 'mark-read') return services.notify.tapped(tap);
        const ids = tap.messageIds?.length ? tap.messageIds : tap.messageId ? [tap.messageId] : [];
        void services.notify.markRead(tap.account, ids);
      }),
    [services],
  );

  const value = useMemo(
    (): State & Actions => ({
      ...state,
      signIn: services.session.signIn,
      signOut: services.session.signOut,
      addAccount: services.accounts.addAccount,
      switchAccount: services.accounts.switchAccount,
      removeAccount: services.accounts.removeAccount,
      discoverImapSettings: services.accounts.discoverImapSettings,
      savedImapSettings: services.accounts.savedImapSettings,
      updateAccount: services.accounts.updateAccount,
      resetAccount: services.accounts.resetAccount,
      pauseAccount: services.accounts.pauseAccount,
      resumeAccount: services.accounts.resumeAccount,
      exportMailbox: services.accounts.exportMailbox,
      exportMessage: services.accounts.exportMessage,
      storageUsage: services.accounts.storageUsage,
      setUnified: services.accounts.setUnified,
      refreshInbox: services.mailbox.refreshInbox,
      loadMoreInbox: services.mailbox.loadMoreInbox,
      loadBox: services.mailbox.loadBox,
      loadMoreBox: services.mailbox.loadMoreBox,
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
      completeRecoveryDrill: services.identity.completeRecoveryDrill,
      waiveRecoveryDrill: services.identity.waiveRecoveryDrill,
      restoreFromRecovery: services.identity.restoreFromRecovery,
      exportTransfer: services.identity.exportTransfer,
      transferStatus: services.identity.transferStatus,
      resumeSessions: services.identity.resumeSessions,
      kmStatus: services.km.status,
      kmRegenerate: services.km.regenerate,
      kmExportLink: services.km.exportLink,
      kmImportLink: services.km.importLink,
      beginQuantumLink: services.bb84.begin,
      checkQuantumLink: services.bb84.check,
      sendEncrypted: services.send.sendEncrypted,
      sendPlain: services.send.sendPlain,
      canSendEncrypted: services.send.canSendEncrypted,
      saveDraft: services.drafts.saveDraft,
      deleteDraft: services.drafts.deleteDraft,
      toggleStar: services.mailbox.toggleStar,
      setUnread: services.mailbox.setUnread,
      archiveMessage: services.mailbox.archiveMessage,
      unarchiveMessage: services.mailbox.unarchiveMessage,
      trashMessage: services.mailbox.trashMessage,
      restoreMessage: services.mailbox.restoreMessage,
      scheduleSend: services.scheduler.scheduleSend,
      cancelScheduled: services.scheduler.cancelScheduled,
      sendScheduledNow: services.scheduler.sendScheduledNow,
      handshakeStatus: services.handshake.status,
      resendHandshake: services.handshake.resend,
      markSpam: services.mailbox.markSpam,
      markNotSpam: services.mailbox.markNotSpam,
      snoozeMessage: services.snooze.snoozeMessage,
      unsnoozeMessage: services.snooze.unsnoozeMessage,
      createLabel: services.labels.createLabel,
      renameLabel: services.labels.renameLabel,
      deleteLabel: services.labels.deleteLabel,
      setLabels: services.labels.setLabels,
      saveRule: services.rules.saveRule,
      deleteRule: services.rules.deleteRule,
      setNotificationPrefs: services.notify.setPrefs,
      notificationPermission,
      requestNotificationPermission,
      consumeNotificationTap: services.notify.consumeTap,
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
