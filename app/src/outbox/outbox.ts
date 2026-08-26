/**
 * Scheduled send — the outbox.
 *
 * A message is held locally until it can go, then delivered. There are two
 * reasons to hold one, and the distinction is the whole of this module:
 *
 *  · `time` — the user asked for it later. Released when the clock says so.
 *  · `awaiting-key` — the recipient has no published key yet. Released when one
 *    appears, which is an external event with no notification attached.
 *
 * The second exists because encryption is not retroactive: a message sealed
 * before the recipient had a key could never be opened by them afterwards, so
 * "send now, they will catch up" is not a thing that can work. Holding it is the
 * only alternative to the plaintext downgrade rule 1 forbids.
 *
 * This module is the pure core: types + reducers + the two release queries the
 * scheduler polls. No storage, no React, no timers, no network.
 *
 * Honest limitation (prototype): sends fire from a client-side scheduler while
 * the app is running, and catch up on next launch — there is no backend outbox,
 * so a message can't leave a device that never reopens, and an awaiting-key hold
 * may wait days. docs/encryption.md records the intended fix (holding the
 * message as a self-addressed encrypted draft in the user's own mailbox). The
 * scheduler lives in state/scheduler.ts; persistence in store/outboxStore.ts.
 */
import { Identity } from '../core';
import { resolveRecipientStates } from '../state/recipients';
import { Keyring } from '../store/keyring';

/** Why a message is sitting in the outbox. */
export type HoldReason = 'time' | 'awaiting-key';

/** A message queued to send at a future time. */
export type Scheduled = {
  id: string;
  to: string[];
  subject: string;
  body: string;
  sendAt: string;
  /** Threading, carried so a drained hold still lands in its conversation. */
  inReplyTo?: string;
  references?: string[];
};

/** A queued message plus why it has not gone yet. */
export type Held = Scheduled & {
  /** Defaults to `time` — items written before awaiting-key holds existed. */
  reason?: HoldReason;
  /** Addresses that had no usable key when the message was held. */
  pending?: string[];
};

/** Everything in the outbox, keyed by id. */
export type ScheduledOutbox = Record<string, Held>;

/** Add or replace a queued message by id (pure). */
export function upsertScheduled(outbox: ScheduledOutbox, item: Held): ScheduledOutbox {
  return { ...outbox, [item.id]: item };
}

/** Remove a queued message by id; a missing id is a no-op (pure). */
export function removeScheduled(outbox: ScheduledOutbox, id: string): ScheduledOutbox {
  const next = { ...outbox };
  delete next[id];
  return next;
}

/** Everything in the outbox, soonest send-time first. */
export function listScheduled(outbox: ScheduledOutbox): Held[] {
  return Object.values(outbox).sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}

/** Why an item is held, defaulting to the behaviour that predates the field. */
export const holdReason = (item: Held): HoldReason => item.reason ?? 'time';

/**
 * Time-held messages whose send time has arrived, soonest first.
 *
 * Awaiting-key holds are excluded no matter what their `sendAt` says: their
 * release condition is a key, and letting the clock release one would send it
 * to a recipient who still cannot read it.
 */
export function dueScheduled(outbox: ScheduledOutbox, now: string): Held[] {
  return listScheduled(outbox).filter((item) => holdReason(item) === 'time' && item.sendAt <= now);
}

/**
 * Awaiting-key messages every recipient of which can now be encrypted to.
 *
 * Resolution goes through `resolveRecipientStates`, the same pure function the
 * send path uses, so "can this be encrypted?" has exactly one answer in the
 * codebase — including for the sender's own address, which resolves from the
 * identity and never appears in the keyring.
 *
 * A `changed` fingerprint is never resolvable by waiting: it is a possible key
 * substitution, and the only thing that clears it is a person re-verifying the
 * key (rule 1). Such a message stays held rather than quietly going out to
 * whoever now holds that address's key.
 */
export function resolvableHeld(
  outbox: ScheduledOutbox,
  keyring: Keyring,
  identity: Identity | null = null,
): Held[] {
  return listScheduled(outbox).filter(
    (item) => holdReason(item) === 'awaiting-key' && stillPending(item, keyring, identity).length === 0,
  );
}

/** Addresses on a held message that still have no usable key. */
export function stillPending(
  item: Held,
  keyring: Keyring,
  identity: Identity | null = null,
): string[] {
  return resolveRecipientStates(keyring, identity, item.to)
    .filter((r) => r.status === 'missing' || r.status === 'changed')
    .map((r) => r.email);
}
