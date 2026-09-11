/**
 * Running what a swipe resolved to.
 *
 * The last link of the chain the gesture starts:
 *
 *   mail row → SwipeableRow → resolveSwipe → **here** → useApp() → state/mailbox
 *
 * There is no new mail logic in this file and there must not be: every branch
 * ends in the same action the message screen's own toolbar calls, so a message
 * archived by a swipe and one archived from the reader take the identical path
 * through `state/mailbox.ts`. What this adds is the two things a gesture needs
 * and a button does not — a line saying what just happened, and a way back.
 *
 * **Every operation here can be undone**, because every one of them has an
 * opposite that already exists: Archive ↔ Move to inbox, Trash ↔ Restore,
 * Spam ↔ Not spam, read ↔ unread, Snooze → un-snooze. Archive was the exception
 * until `FlagPatch.archived` became two-way — which it became *for* this: a
 * gesture a thumb can reach by accident should not be the one action with no way
 * back.
 *
 * Failures are reported, never swallowed into a success line. `setFlags`
 * already re-fetches the list it could not change, so the state on screen is
 * the provider's again by the time the message is read.
 *
 * Lives here rather than in `state/`: it is one screen-side composition of
 * actions `useApp()` already exposes, exactly like the message screen's own
 * handlers, and adding a service for it would put toast copy in the seam.
 */
import React, { useCallback, useMemo, useState } from 'react';

import { MailSummary } from '../mail/types';
import { useApp } from '../state/AppState';
import { SecondaryBox } from '../state/types';
import { SwipeOperation, SwipeVisual } from '../swipe/swipe';
import { IconName } from './Icon';
import { SnoozeModal } from './SnoozeModal';
import { useToast } from './ToastContext';

/** Everything a swipe can do *to a message* — every operation but `set-up`. */
type MailOperation = Exclude<SwipeOperation, 'set-up'>;

/** How long an undo stays on offer. The same window the snooze toast uses. */
const UNDO_MS = 5000;

/**
 * What the toast says once the operation has gone through.
 *
 * `set-up` is absent, and that is the point: it opens a screen rather than
 * changing a message, so there is nothing to report and nothing to undo. A
 * toast there would be an app congratulating itself for showing you a setting.
 */
const DONE: Record<Exclude<SwipeOperation, 'set-up'>, { message: string; icon: IconName }> = {
  archive: { message: 'Archived', icon: 'archive' },
  unarchive: { message: 'Moved back to the inbox', icon: 'inbox' },
  trash: { message: 'Moved to Trash', icon: 'trash' },
  restore: { message: 'Moved back to the inbox', icon: 'inbox' },
  'mark-spam': { message: 'Filed as spam', icon: 'junk' },
  'mark-not-spam': { message: 'Marked not spam', icon: 'check' },
  'mark-read': { message: 'Marked read', icon: 'mail' },
  'mark-unread': { message: 'Marked unread', icon: 'mail' },
  snooze: { message: 'Snoozed message', icon: 'clock' },
};

/** What it says when the operation did not go through. Never a success line. */
const FAILED: Record<Exclude<SwipeOperation, 'set-up'>, string> = {
  archive: 'Couldn’t archive that message',
  unarchive: 'Couldn’t move that message back',
  trash: 'Couldn’t move that message to Trash',
  restore: 'Couldn’t move that message back',
  'mark-spam': 'Couldn’t file that message as spam',
  'mark-not-spam': 'Couldn’t unmark that message',
  'mark-read': 'Couldn’t mark that message read',
  'mark-unread': 'Couldn’t mark that message unread',
  snooze: 'Couldn’t snooze that message',
};

export type SwipeRunnerOptions = {
  /**
   * Where an unconfigured side sends the reader — the Swipe options screen.
   *
   * Passed in rather than navigated to from here, because this hook is mounted
   * by a destination *body* and only the body holds navigation. Omitted, a
   * completed swipe on an unconfigured side simply does nothing, which is the
   * same non-event it was before.
   */
  onSetUp?: () => void;
};

export type SwipeRunner = {
  /**
   * Run a resolved swipe against every message the swiped row stands for. Fire
   * and forget.
   *
   * A list, because an inbox row is a *conversation*: archiving it has to
   * archive the conversation, or the row springs back carrying the one older
   * message the gesture missed. Sent, Archive and Trash pass the single message
   * their row is.
   *
   * `box` is the list the swipe happened in — `null` for the inbox. It is what
   * an undo re-fetches: a message moved back arrives in the list it left, and
   * `applyFlagPatch` only ever *removes* rows (`mail/flags.ts`), so without the
   * re-fetch the message would be back in the mailbox and still missing from
   * the screen. That is not an undo the user can believe.
   */
  runSwipe: (visual: SwipeVisual, targets: MailSummary[], box: SecondaryBox | null) => void;
  /**
   * The snooze picker, mounted **once** per list.
   *
   * Snooze is the one operation that needs a second answer from the user before
   * anything happens, and the picker is the sheet the message screen already
   * uses. It belongs to the list rather than to a row: a mail list has hundreds
   * of rows and would otherwise mount hundreds of modals.
   */
  snoozePicker: React.ReactElement;
};

export function useSwipeRunner({ onSetUp }: { onSetUp?: () => void } = {}): SwipeRunner {
  const {
    archiveMessage,
    unarchiveMessage,
    trashMessage,
    restoreMessage,
    markSpam,
    markNotSpam,
    setUnread,
    snoozeMessage,
    unsnoozeMessage,
    refreshInbox,
    loadBox,
  } = useApp();
  const { showToast } = useToast();
  /** The messages a Snooze swipe is waiting on a time for. */
  const [snoozing, setSnoozing] = useState<string[] | null>(null);

  /** Report success and offer the way back, when there is one. */
  const done = useCallback(
    (operation: MailOperation, count: number, undo?: () => void) => {
      const copy = DONE[operation];
      showToast({
        // The count only when there is one to report: "Archived" is what one
        // message deserves, and "Archived 1 message" is how a UI tells on itself.
        message: count > 1 ? `${copy.message} · ${count} messages` : copy.message,
        icon: copy.icon,
        durationMs: UNDO_MS,
        ...(undo ? { actionLabel: 'Undo', onAction: undo } : {}),
      });
    },
    [showToast],
  );

  const failed = useCallback(
    (operation: MailOperation) => {
      showToast({ message: FAILED[operation], icon: 'alert', durationMs: UNDO_MS });
    },
    [showToast],
  );

  /**
   * Run one operation over every message the row stands for.
   *
   * All of them or none of them is not on offer — these are independent
   * provider calls — so the rule is the weaker but honest one: if any of them
   * throws, the failure is what gets reported. A partial move is visible in the
   * list either way, since each call patches the row it touched.
   */
  const attempt = useCallback(
    async (
      operation: MailOperation,
      ids: string[],
      work: (id: string) => Promise<unknown>,
      undo?: (id: string) => Promise<unknown>,
      /** The list an undo puts the messages back into, so it can re-fetch. */
      undoReturnsTo?: SecondaryBox | null,
    ) => {
      try {
        await Promise.all(ids.map(work));
        done(
          operation,
          ids.length,
          undo
            ? () => {
                void Promise.all(ids.map(undo)).then(() => {
                  // The list the messages just came back to has to ask the
                  // provider for them: the optimistic patch removes rows and
                  // never adds them, by design (`mail/flags.ts`).
                  if (undoReturnsTo === undefined) return undefined;
                  return undoReturnsTo === null ? refreshInbox() : loadBox(undoReturnsTo);
                });
              }
            : undefined,
        );
      } catch {
        failed(operation);
      }
    },
    [done, failed, loadBox, refreshInbox],
  );

  const runSwipe = useCallback(
    (visual: SwipeVisual, targets: MailSummary[], box: SecondaryBox | null) => {
      const ids = targets.map((m) => m.id);
      if (ids.length === 0) return;
      switch (visual.operation) {
        // The side nobody has configured. Nothing is done to the mail — the
        // gesture's whole content is the offer to choose what it should do, so
        // it opens the screen where that choice is made.
        case 'set-up':
          onSetUp?.();
          return;
        // The four moves. Each undo puts the messages back where they were
        // swiped from, so each re-fetches that list.
        case 'archive':
          void attempt('archive', ids, archiveMessage, unarchiveMessage, box);
          return;
        case 'unarchive':
          void attempt('unarchive', ids, unarchiveMessage, archiveMessage, box);
          return;
        case 'trash':
          void attempt('trash', ids, trashMessage, restoreMessage, box);
          return;
        case 'restore':
          void attempt('restore', ids, restoreMessage, trashMessage, box);
          return;
        case 'mark-spam':
          void attempt('mark-spam', ids, markSpam, markNotSpam);
          return;
        case 'mark-not-spam':
          void attempt('mark-not-spam', ids, markNotSpam, markSpam);
          return;
        // The rest change a row rather than moving it, so their undo has
        // nothing to re-fetch — the list is already showing the message.
        case 'mark-read':
          void attempt(
            'mark-read',
            ids,
            (id) => setUnread(id, false),
            (id) => setUnread(id, true),
          );
          return;
        case 'mark-unread':
          void attempt(
            'mark-unread',
            ids,
            (id) => setUnread(id, true),
            (id) => setUnread(id, false),
          );
          return;
        case 'snooze':
          // Nothing has happened yet — the sheet asks until when, and only then
          // is anything written. Dismissing it leaves the messages where they are.
          setSnoozing(ids);
          return;
      }
    },
    [
      archiveMessage,
      attempt,
      markNotSpam,
      markSpam,
      onSetUp,
      restoreMessage,
      setUnread,
      trashMessage,
      unarchiveMessage,
    ],
  );

  const snoozePicker = useMemo(
    () => (
      <SnoozeModal
        visible={snoozing !== null}
        onClose={() => setSnoozing(null)}
        onSnooze={(until) => {
          const ids = snoozing;
          setSnoozing(null);
          if (!ids) return;
          // Un-snoozing needs no re-fetch: a snoozed message is filtered out of
          // the inbox this device already holds, so it reappears on the spot.
          void attempt('snooze', ids, (id) => snoozeMessage(id, until), unsnoozeMessage);
        }}
      />
    ),
    [attempt, snoozeMessage, snoozing, unsnoozeMessage],
  );

  return { runSwipe, snoozePicker };
}
