/**
 * Scheduled send — the outbox.
 *
 * A scheduled message is held locally until its `sendAt` time, then delivered.
 * This module is the pure core: types + reducers + the due-time query the
 * scheduler polls. No storage, no React, no timers.
 *
 * Honest limitation (prototype): sends fire from a client-side scheduler while
 * the app is running, and catch up on next launch — there is no backend outbox,
 * so a message can't leave a device that never reopens. The scheduler lives in
 * state/AppState.tsx; persistence in store/outboxStore.ts.
 */

/** A message queued to send at a future time. */
export type Scheduled = { id: string; to: string[]; subject: string; body: string; sendAt: string };

/** All scheduled messages, keyed by id. */
export type ScheduledOutbox = Record<string, Scheduled>;

/** Add or replace a scheduled message by id (pure). */
export function upsertScheduled(outbox: ScheduledOutbox, item: Scheduled): ScheduledOutbox {
  return { ...outbox, [item.id]: item };
}

/** Remove a scheduled message by id; a missing id is a no-op (pure). */
export function removeScheduled(outbox: ScheduledOutbox, id: string): ScheduledOutbox {
  const next = { ...outbox };
  delete next[id];
  return next;
}

/** Scheduled messages, soonest send-time first. */
export function listScheduled(outbox: ScheduledOutbox): Scheduled[] {
  return Object.values(outbox).sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}

/** Messages whose send time has arrived (sendAt at or before `now`), soonest first. */
export function dueScheduled(outbox: ScheduledOutbox, now: string): Scheduled[] {
  return listScheduled(outbox).filter((item) => item.sendAt <= now);
}
