/**
 * One scheduler pass run by the OS while CryptMail is in the background.
 *
 * The scheduler itself (`state/scheduler.ts`) needs no React — it is a service
 * over a `Store` — so a background pass is the same `scheduler.run()` the 15 s
 * in-app interval calls. What this file adds is the answer to *whose* services
 * run it, because there are two situations the OS can wake us in:
 *
 * - **The app's JS is alive** (backgrounded, not killed). `AppProvider` has
 *   attached its services here, and the pass goes through *those*. A second
 *   service graph would carry a second outbox and a second `inFlight` set, and
 *   the in-app interval and this pass would each send the same message.
 * - **The app's JS is not alive.** The task runs headless, with no React tree.
 *   A throwaway graph is built over a store nothing renders, boots only the
 *   mailbox that was in front — the outbox `run()` drains is that one's — and
 *   is dropped when the pass ends.
 *
 * The one remaining overlap is the app opening *during* a headless pass. The
 * pass may already have sent a message and not yet written the outbox back, so
 * the app's boot waits on `backgroundIdle()` before it reads that outbox.
 *
 * Nothing here decides what is sent: `run()` goes through `deliver`, so rule 1
 * holds in the background exactly as it does on screen.
 *
 * The same pass is also how new mail is noticed while the app is closed
 * (`state/notify.ts`): after the outbox, it looks at each mailbox's newest
 * inbox page and posts what the notification policy allows.
 */
import type { NotificationTap } from '../notifications/os';
import { Services } from '../state/contracts';
import { createServices } from '../state/services';
import { createStore, initialState, Store } from '../state/store';

export type SchedulerHost = { store: Store; services: Services };

/**
 * What a pass did: how many messages are still in the outbox after it, and
 * whether notifications still want the mail looked at — the two things that
 * tell the task whether it is still needed.
 */
export type PassResult = { status: 'ran'; waiting: number; watching: boolean } | { status: 'signed-out' };

let foreground: SchedulerHost | null = null;
let headless: Promise<PassResult> | null = null;
/** A notification button being handled with no app around it (`runNotificationAction`). */
let headlessAction: Promise<void> | null = null;

/** The app's own services, for as long as `AppProvider` is mounted. */
export function attachForeground(host: SchedulerHost): () => void {
  foreground = host;
  return () => {
    if (foreground === host) foreground = null;
  };
}

/**
 * Resolves once no headless pass is running.
 *
 * Never rejects: a pass that failed has still stopped, and that is all the
 * caller is waiting to know.
 */
export async function backgroundIdle(): Promise<void> {
  while (headless || headlessAction) {
    if (headless) await headless.catch(() => undefined);
    if (headlessAction) await headlessAction.catch(() => undefined);
  }
}

/** A service graph nothing renders, for a pass with no app around it. */
export function buildHeadless(): SchedulerHost {
  const store = createStore(initialState(), () => {});
  return { store, services: createServices(store).services };
}

/**
 * Run the scheduler once, from the background.
 *
 * `build` exists for tests; the task passes nothing.
 */
export async function runBackgroundPass(build: () => SchedulerHost = buildHeadless): Promise<PassResult> {
  if (foreground) return runOn(foreground);
  // A pass is already under way — the OS can re-fire a task that overran. Its
  // result is this one's; a second graph would race it for the same outbox.
  if (headless) return headless;
  // A button press being handled headless has its own graph; let it finish
  // rather than run two over the same stores.
  if (headlessAction) await headlessAction.catch(() => undefined);
  if (foreground) return runOn(foreground);
  if (headless) return headless;

  const pass = (async () => {
    const host = build();
    await host.services.session.boot(() => false, { restoreOthers: false });
    return runOn(host, { headless: true });
  })();
  headless = pass;
  try {
    return await pass;
  } finally {
    headless = null;
  }
}

async function runOn(host: SchedulerHost, opts: { headless?: boolean } = {}): Promise<PassResult> {
  // Signed out, a grant that no longer restores, or a boot that failed on the
  // network: nothing to send with. No `waiting` either — it is unknown here,
  // not zero, and must not be read as "the outbox is empty".
  if (!host.store.get().session) return { status: 'signed-out' };

  // A failed send must not stop the look for new mail, nor the other way
  // round; the failure is still reported once both have had their turn.
  let failure: { error: unknown } | null = null;
  try {
    await host.services.scheduler.run();
  } catch (error) {
    failure = { error };
  }

  // New mail, in every mailbox that notifies. Headless, only the mailbox in
  // front was booted — enough for the outbox, not for this — so the rest are
  // restored first. An app that is alive has already restored its own.
  const watching = host.services.notify.wanted();
  if (watching) {
    if (opts.headless) await host.services.session.restoreOthers().catch(() => undefined);
    await host.services.notify.checkAll();
  }

  if (failure) throw failure.error;
  return { status: 'ran', waiting: Object.keys(host.store.get().scheduled).length, watching };
}

/**
 * Handle a notification button the OS delivered while the app was in the
 * background or not running — today, only Mark read (Android; `task.ts`).
 *
 * The same routing as a scheduler pass, for the same reasons: the app's own
 * services when its JS is alive, otherwise one headless graph that boots the
 * mailbox in front — `notify.markRead` restores the one the button belongs
 * to if that was another. Never two graphs at once, and the app's boot waits
 * for this one through `backgroundIdle()`.
 */
export async function runNotificationAction(
  tap: NotificationTap,
  build: () => SchedulerHost = buildHeadless,
): Promise<void> {
  if (tap.action !== 'mark-read') return;
  const ids = tap.messageIds?.length ? tap.messageIds : tap.messageId ? [tap.messageId] : [];
  if (ids.length === 0) return;

  if (foreground) return foreground.services.notify.markRead(tap.account, ids);

  // Claimed synchronously, so an app boot starting this very tick already
  // waits for it; queued behind an earlier press and any headless pass.
  const previous = headlessAction;
  const action = (async () => {
    if (previous) await previous.catch(() => undefined);
    while (headless) await headless.catch(() => undefined);
    // The app may have opened while this waited. (Re-read: TypeScript keeps
    // the narrowing from before the closure.)
    const alive = foreground as SchedulerHost | null;
    if (alive) return alive.services.notify.markRead(tap.account, ids);
    const host = build();
    await host.services.session.boot(() => false, { restoreOthers: false });
    if (!host.store.get().session) return;
    await host.services.notify.markRead(tap.account, ids);
  })();
  headlessAction = action;
  try {
    await action;
  } finally {
    if (headlessAction === action) headlessAction = null;
  }
}
