/**
 * The outbox: messages waiting for a send time, and messages waiting for a key.
 *
 * The two are the same queue with different `reason`s, because they need the
 * same thing — a durable copy that survives the app being closed, and one place
 * that decides when to try again.
 */
import { needsReauth } from '../auth/types';
import { CoreError } from '../core';
import { Draft, upsertDraft } from '../drafts/drafts';
import {
  dueScheduled,
  Held,
  holdReason,
  listScheduled,
  removeScheduled,
  resolvableHeld,
  stillPending,
  upsertScheduled,
} from '../outbox/outbox';
import { saveDrafts } from '../store/draftsStore';
import { saveOutbox } from '../store/outboxStore';
import { Ctx, SchedulerService } from './contracts';
import { SendInput, SendOutcome } from './types';

export const newOutboxId = () => `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * How often a held message may re-ask the directory about its recipients.
 *
 * The queue is drained on every launch, every scheduler tick and every sync;
 * without this, a single held message would poll a public keyserver four times a
 * minute for as long as it waits, which is days.
 */
const HELD_LOOKUP_INTERVAL_MS = 5 * 60 * 1000;

export function createScheduler(ctx: Ctx): SchedulerService {
  const { store } = ctx;

  /** A guard against sending the same outbox entry twice. */
  const inFlight = new Set<string>();
  /** When the queue last asked the directory about its pending addresses. */
  let lastDirectoryRetry = 0;

  /** Drop entries that went out, against whatever the outbox holds *now*. */
  async function forget(ids: string[]) {
    if (ids.length === 0) return;
    let scheduled = store.get().scheduled;
    for (const id of ids) scheduled = removeScheduled(scheduled, id);
    await saveOutbox(scheduled);
    store.patch({ scheduled });
  }

  const service: SchedulerService = {
    /**
     * Put a message in the outbox to wait for a key.
     *
     * Stored like any scheduled send — sealed at rest by `secureJson`, and no
     * ciphertext yet, because there is nothing to encrypt it to.
     */
    async hold(item: Held) {
      const scheduled = upsertScheduled(store.get().scheduled, item);
      await saveOutbox(scheduled);
      store.patch({ scheduled });
    },

    async scheduleSend(input: SendInput & { sendAt: string }) {
      // A changed fingerprint stops this here, exactly as it stops a send now:
      // it is a possible key substitution, and scheduling one for later is no
      // better than sending it. A recipient with *no* key is different — the
      // send path holds that message and invites them, so scheduling it is
      // honest and the hold simply starts when the send time arrives.
      const changed = (await ctx.services.contacts.discoverRecipients(input.to)).filter(
        (r) => r.status === 'changed',
      );
      if (changed.length > 0) {
        throw new CoreError(
          `The key for ${changed.map((r) => r.email).join(', ')} changed fingerprint. ` +
            'Compare the new safety number before scheduling this.',
          'malformed',
        );
      }
      await service.hold({
        id: input.id ?? newOutboxId(),
        to: input.to,
        subject: input.subject,
        body: input.body,
        sendAt: input.sendAt,
        reason: 'time',
      });
    },

    async cancelScheduled(id: string) {
      await forget([id]);
    },

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
    async sendScheduledNow(id: string): Promise<SendOutcome | null> {
      const item = store.get().scheduled[id];
      if (!item) return null;
      // The same id goes back in: if this turns out to be un-sendable yet,
      // `deliver` re-holds *this* message rather than leaving a duplicate, and
      // the removal below is skipped so nothing is silently dropped.
      const outcome = await ctx.services.send.deliver({
        id,
        to: item.to,
        subject: item.subject,
        body: item.body,
      });
      if (outcome.status !== 'sent') return outcome;
      await forget([id]);
      await ctx.services.mailbox.refreshInbox();
      return outcome;
    },

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
    async drainHeld() {
      const waiting = listScheduled(store.get().scheduled).filter(
        (item) => holdReason(item) === 'awaiting-key' && !inFlight.has(item.id),
      );
      if (waiting.length === 0) return;

      // One more look for the addresses still missing a key. This is the retry
      // that makes the whole queue work — but it is also a request to somebody
      // else's keyserver, and this runs every fifteen seconds and after every
      // sync. Checking the keyring costs nothing and happens every time; asking
      // the directory is rate-limited to something a stranger installing an app
      // could plausibly beat.
      const now = Date.now();
      if (now - lastDirectoryRetry >= HELD_LOOKUP_INTERVAL_MS) {
        lastDirectoryRetry = now;
        const { keyring, identity } = store.get();
        await ctx.services.contacts.discover(waiting.flatMap((item) => stillPending(item, keyring, identity)));
      }

      const { scheduled, keyring, identity } = store.get();
      const ready = resolvableHeld(scheduled, keyring, identity).filter((item) => !inFlight.has(item.id));

      const sent: string[] = [];
      for (const item of ready) {
        inFlight.add(item.id);
        try {
          const outcome = await ctx.services.send.deliver({
            id: item.id,
            to: item.to,
            subject: item.subject,
            body: item.body,
          });
          if (outcome.status === 'sent') sent.push(item.id);
        } catch (e) {
          if (needsReauth(e)) ctx.services.session.handleAuthLoss(e);
          // Anything else — a changed key, a provider hiccup — leaves the message
          // held. It is not lost, and the next drain will look again.
        } finally {
          inFlight.delete(item.id);
        }
      }
      await forget(sent);
    },

    /**
     * One tick of the client-side scheduler: release what was waiting for a key,
     * then send what is now due. A send that fails is preserved as a draft.
     */
    async run() {
      await service.drainHeld();

      const now = new Date().toISOString();
      const due = dueScheduled(store.get().scheduled, now).filter((s) => !inFlight.has(s.id));
      if (due.length === 0) return;
      for (const s of due) inFlight.add(s.id);

      const sent: string[] = [];
      const rescued: Draft[] = [];
      for (const item of due) {
        try {
          // Passing the id keeps a message that turns out to need a key from
          // being duplicated: `deliver` re-holds this same entry as awaiting-key,
          // and it is neither counted as sent nor rescued into drafts.
          const outcome = await ctx.services.send.deliver({
            id: item.id,
            to: item.to,
            subject: item.subject,
            body: item.body,
          });
          if (outcome.status === 'sent') sent.push(item.id);
        } catch (e) {
          // Rescued as a draft either way; but a revoked grant also has to stop
          // the 15-second loop from retrying a send that cannot succeed.
          if (needsReauth(e)) ctx.services.session.handleAuthLoss(e);
          rescued.push({
            id: item.id,
            to: item.to,
            subject: item.subject,
            body: item.body,
            updatedAt: new Date().toISOString(),
          });
        } finally {
          inFlight.delete(item.id);
        }
      }

      // Applied against the latest state rather than the copy read above, so a
      // schedule made while this tick was running is not clobbered.
      let scheduled = store.get().scheduled;
      let drafts = store.get().drafts;
      for (const id of sent) scheduled = removeScheduled(scheduled, id);
      for (const d of rescued) {
        scheduled = removeScheduled(scheduled, d.id);
        drafts = upsertDraft(drafts, d);
      }
      await saveOutbox(scheduled);
      if (rescued.length > 0) await saveDrafts(drafts);
      store.patch({
        scheduled,
        drafts,
        ...(rescued.length > 0
          ? { error: `Couldn't send ${rescued.length} scheduled message${rescued.length > 1 ? 's' : ''}; saved to drafts.` }
          : {}),
      });
      if (sent.length > 0) await ctx.services.mailbox.refreshInbox();
    },
  };

  return service;
}
