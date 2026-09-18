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
 */
import { Services } from '../state/contracts';
import { createServices } from '../state/services';
import { createStore, initialState, Store } from '../state/store';

export type SchedulerHost = { store: Store; services: Services };

/**
 * What a pass did, and how many messages are still in the outbox after it —
 * which is what tells the task whether it is still needed.
 */
export type PassResult = { status: 'ran'; waiting: number } | { status: 'signed-out' };

let foreground: SchedulerHost | null = null;
let headless: Promise<PassResult> | null = null;

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
  while (headless) await headless.catch(() => undefined);
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

  const pass = (async () => {
    const host = build();
    await host.services.session.boot(() => false, { restoreOthers: false });
    return runOn(host);
  })();
  headless = pass;
  try {
    return await pass;
  } finally {
    headless = null;
  }
}

async function runOn(host: SchedulerHost): Promise<PassResult> {
  // Signed out, a grant that no longer restores, or a boot that failed on the
  // network: nothing to send with. No `waiting` either — it is unknown here,
  // not zero, and must not be read as "the outbox is empty".
  if (!host.store.get().session) return { status: 'signed-out' };
  await host.services.scheduler.run();
  return { status: 'ran', waiting: Object.keys(host.store.get().scheduled).length };
}
