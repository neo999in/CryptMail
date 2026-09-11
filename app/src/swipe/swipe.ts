/**
 * What a swipe on a mail row means — the model, not the gesture.
 *
 * A swipe is three separate things, and keeping them apart is what makes this
 * testable without a device:
 *
 *   1. what the user *configured* for a direction — a `SwipeAction`, one per
 *      side, stored in `store/mailPrefsStore.ts`;
 *   2. what that action *is* in the list being swiped — a `SwipeOperation`, or
 *      nothing at all, decided here by `resolveSwipe`;
 *   3. what running it does — one of the existing actions on `useApp()`, run by
 *      `ui/swipeRun.ts`. Nothing in this file performs anything.
 *
 * The split is the whole reason the preference can stay a preference. Archive
 * means archive, whichever list you are in — but the Archive list has nothing to
 * archive, and CryptMail has no un-archive operation to offer instead (Gmail
 * archiving is "remove the INBOX label", and `FlagPatch.archived` is one-way —
 * see `mail/flags.ts`). So the resolver answers `null` there and the row simply
 * does not move, rather than the app quietly rewriting what the user chose or
 * reporting a success that never happened. Trash is the interesting opposite:
 * Delete resolves to *Restore* in the Trash list, because a move out is the same
 * operation running the other way and it already exists.
 *
 * Deliberately free of React, colours and icons: the tone is a semantic name and
 * `ui/swipeRow.tsx` turns it into a fill. `store/` may import this — it may not
 * import `ui/` — which is why the ids and their defaults live here rather than
 * beside the component that draws them.
 */
import { Category } from '../categorizer/categorizer';
import { SecondaryBox } from '../state/types';

/** Which way the finger went. The row moves with it, and reveals the pane behind. */
export type SwipeDirection = 'left' | 'right';

export const SWIPE_DIRECTIONS: SwipeDirection[] = ['left', 'right'];

/**
 * What the user can put on a side.
 *
 * Only operations CryptMail actually has. There is no *Move to folder* because
 * there is no folder to move to: Archive, Trash and Spam are the three places a
 * message can go and each is its own action here. There is no *Flag* because
 * starring is a property of the inbox list alone (`toggleStar` reads
 * `state.messages`), and a swipe that silently did nothing in Sent would be
 * worse than no swipe. Adding one later is a case in `resolveSwipe`, a row in
 * `SWIPE_ACTIONS`, and a glyph — nothing else.
 */
export type SwipeAction = 'none' | 'archive' | 'trash' | 'spam' | 'read' | 'snooze';

/**
 * What actually runs. More operations than actions, because one action reads
 * differently depending on where the row is: Delete restores from the Trash,
 * Spam un-files a message already in Spam, and Read is whichever of the two the
 * row is not.
 */
export type SwipeOperation =
  | 'set-up'
  | 'archive'
  | 'unarchive'
  | 'trash'
  | 'restore'
  | 'mark-spam'
  | 'mark-not-spam'
  | 'mark-read'
  | 'mark-unread'
  | 'snooze';

/** Which colour family the revealed pane wears. Resolved to a hex in `ui/`. */
export type SwipeTone = 'positive' | 'destructive' | 'neutral' | 'accent';

/** The row being swiped, and the list it is being swiped in. */
export type SwipeContext = {
  /** The mailbox this list is, or `null` for the inbox and any category over it. */
  box: SecondaryBox | null;
  /** Whether this row is currently filed as junk — the same verdict the row's category came from. */
  junk: boolean;
  /** Whether it is unread right now, which is what Read toggles against. */
  unread: boolean;
  /**
   * Whether the row belongs to a mailbox other than the one in front — only
   * possible while the inbox is merged.
   *
   * Two of the operations are written against the *active* account and no other:
   * a spam mark trains that account's model (`mailbox.applyMark` refuses a row
   * from elsewhere), and a snooze is written to that account's snooze store
   * whichever row it came from. Both would appear to work and quietly not, so
   * the resolver takes them off the table instead — the row still opens, which
   * puts its own mailbox in front, and the swipe is there a gesture later.
   */
  foreign: boolean;
  /**
   * The category the list is filtered to, when it is the inbox under one of the
   * drawer's category rows, and `null` for everything else.
   *
   * Read only by `swipeRemovesRow`: a spam mark re-files a message without
   * moving it, so whether the row disappears is a question about *this* list,
   * not about the operation.
   */
  category: Category | null;
};

/** One resolved swipe: what will run, and how the pane behind the row reads. */
export type SwipeVisual = {
  operation: SwipeOperation;
  /** On the pane, and in Settings. The same word the message screen uses. */
  label: string;
  tone: SwipeTone;
  /**
   * Whether crossing the line has to be deliberate. Destructive operations get
   * a longer pull — see `swipeThreshold`.
   */
  destructive: boolean;
};

const VISUALS: Record<SwipeOperation, Omit<SwipeVisual, 'operation'>> = {
  /**
   * The side nobody has configured yet.
   *
   * Not a mail operation and deliberately not a dead side either: the pane says
   * what the gesture *could* be, in neutral grey, and completing it opens the
   * screen where you choose. Nothing is archived, moved, filed or flagged — the
   * rule that a first right swipe changes nothing about your mail is intact, and
   * this is what the row does instead of nothing at all.
   */
  'set-up': { label: 'Swipe to set up actions', tone: 'neutral', destructive: false },
  archive: { label: 'Archive', tone: 'positive', destructive: false },
  unarchive: { label: 'Move to inbox', tone: 'positive', destructive: false },
  trash: { label: 'Delete', tone: 'destructive', destructive: true },
  restore: { label: 'Restore', tone: 'positive', destructive: false },
  'mark-spam': { label: 'Spam', tone: 'destructive', destructive: true },
  'mark-not-spam': { label: 'Not spam', tone: 'positive', destructive: false },
  'mark-read': { label: 'Mark read', tone: 'neutral', destructive: false },
  'mark-unread': { label: 'Mark unread', tone: 'neutral', destructive: false },
  snooze: { label: 'Snooze', tone: 'accent', destructive: false },
};

/** The pane for an operation, once something has decided which one runs. */
export function swipeVisual(operation: SwipeOperation): SwipeVisual {
  return { operation, ...VISUALS[operation] };
}

/**
 * What this side does to this row, right now — or `null` for "nothing happens".
 *
 * `null` is a real answer and the row honours it by not moving at all: an
 * unconfigured side, and a side whose action has no meaning in this list, are
 * the same non-event as far as the finger is concerned. See the header for why
 * the preference is not rewritten instead.
 */
export function resolveSwipe(action: SwipeAction, ctx: SwipeContext): SwipeVisual | null {
  switch (action) {
    // Available in every list, because it is an offer to configure rather than
    // anything done to the message under the finger.
    case 'none':
      return swipeVisual('set-up');

    // The same move, in whichever direction the message is not already: out of
    // the inbox, or back into it from Archive. Sent and Trash have no INBOX
    // label to remove and are not the archive to come back from, so there the
    // row does not move.
    case 'archive':
      if (ctx.box === null) return swipeVisual('archive');
      return ctx.box === 'archive' ? swipeVisual('unarchive') : null;

    // A move, in whichever direction the row is not already in. Both halves
    // exist (`trashMessage` / `restoreMessage`) and neither erases anything.
    case 'trash':
      return swipeVisual(ctx.box === 'trash' ? 'restore' : 'trash');

    // Marking trains the personal filter from the row's own content, and
    // `mailbox.applyMark` only knows rows in the *active* account's inbox list —
    // which is also the only list where the Spam category is shown. Elsewhere
    // there is nothing honest to run.
    case 'spam':
      if (ctx.box !== null || ctx.foreign) return null;
      return swipeVisual(ctx.junk ? 'mark-not-spam' : 'mark-spam');

    // The one action that means the same thing in every list: `setFlags` finds
    // the row wherever it is (`state/mailbox.ts`, `locate`).
    case 'read':
      return swipeVisual(ctx.unread ? 'mark-read' : 'mark-unread');

    // Snoozing hides a row until a time, and only the inbox hides snoozed rows —
    // the active account's, since that is the store the snooze is written to.
    case 'snooze':
      return ctx.box === null && !ctx.foreign ? swipeVisual('snooze') : null;
  }
}

/* ------------------------------------------------------------ the picker ---- */

/** The action list, in the order the picker offers it. */
export const SWIPE_ACTIONS: SwipeAction[] = ['none', 'archive', 'trash', 'spam', 'read', 'snooze'];

/** What a configured action is called where the gesture is not in front of you. */
export const SWIPE_ACTION_LABEL: Record<SwipeAction, string> = {
  none: 'Set Up',
  archive: 'Archive',
  trash: 'Delete',
  spam: 'Mark as spam',
  read: 'Mark read or unread',
  snooze: 'Snooze',
};

/**
 * What each one does, said once, where the user is choosing between them.
 *
 * Each says where it applies, because half of them do nothing outside the
 * inbox and finding that out by swiping is exactly the confusion this avoids.
 */
export const SWIPE_ACTION_HINT: Record<SwipeAction, string> = {
  none: 'Swiping this way does nothing to the message — it opens this screen so you can choose an action.',
  archive: 'Takes the message out of the inbox and leaves it in the account. In Archive, it puts it back.',
  trash: 'Moves it to Trash — and back out again, when you swipe in Trash. Nothing is erased.',
  spam: 'Files it under Spam and trains this device’s filter. In Spam, it rescues the message instead. Inbox only.',
  read: 'Flips the message between read and unread.',
  snooze: 'Hides it until a time you pick. Inbox only.',
};

export const SWIPE_DIRECTION_LABEL: Record<SwipeDirection, string> = {
  left: 'Swipe left',
  right: 'Swipe right',
};

/* ---------------------------------------------------------- the geometry ---- */

/**
 * How far the finger travels before the row starts following it.
 *
 * A mail list scrolls vertically and the rows are tappable, so the pan has to
 * lose to both until the intent is unmistakably sideways.
 */
export const SWIPE_ENGAGE_PX = 14;

/** Above this much of the pull, the pane spells the action out as well as drawing it. */
export const SWIPE_LABEL_AT = 0.55;

/**
 * The block's fill at the moment it appears, and at the moment it arms.
 *
 * The floor rose with the colours: washed to 16%, a deep green over a true-black
 * ground is indistinguishable from the ground, so the first centimetre of the
 * pull looked like nothing was happening at all.
 */
export const SWIPE_FILL_MIN_ALPHA = 0.24;
export const SWIPE_FILL_MAX_ALPHA = 1;

/**
 * How far this operation has to be pulled to run, in points.
 *
 * A fraction of the row's own width rather than a constant, so it is the same
 * gesture on a 5" phone and a tablet, and clamped at both ends so neither
 * extreme turns into a flick or a haul. Destructive operations are pulled
 * further — Delete and Spam are the two a thumb should not be able to reach by
 * accident while scrolling.
 *
 * The last term is the guard for a genuinely narrow row: a floor taller than the
 * row itself would be a threshold no finger could cross.
 */
export function swipeThreshold(width: number, destructive: boolean): number {
  const fraction = destructive ? 0.42 : 0.3;
  const floor = destructive ? 120 : 88;
  const ceiling = destructive ? 240 : 190;
  return Math.min(Math.max(width * fraction, floor), ceiling, width * 0.8);
}

/** How far through the pull the finger is: 0 at rest, 1 at the trigger line. */
export function swipeProgress(distance: number, threshold: number): number {
  'worklet';
  if (threshold <= 0) return 0;
  return Math.min(Math.max(Math.abs(distance) / threshold, 0), 1);
}

/** Whether releasing now runs the operation. */
export function swipeArmed(progress: number): boolean {
  'worklet';
  return progress >= 1;
}

/**
 * The pane's opacity at this much of the pull — light when the action first
 * appears, full colour by the time it will run.
 *
 * Squared rather than linear so the deepening is felt near the line rather than
 * spent in the first centimetre, which is the difference between "this is
 * about to happen" and a background that simply exists.
 */
export function swipeFillAlpha(progress: number): number {
  'worklet';
  const p = Math.min(Math.max(progress, 0), 1);
  return SWIPE_FILL_MIN_ALPHA + (SWIPE_FILL_MAX_ALPHA - SWIPE_FILL_MIN_ALPHA) * p * p;
}

/**
 * How far past the trigger line the pull is allowed to go.
 *
 * Beyond it the row keeps moving but at a fraction of the finger's speed, so a
 * deliberate haul still feels connected while the pane cannot be dragged into a
 * blank screen.
 */
export const SWIPE_OVERPULL = 0.35;

/**
 * How far the row has actually moved for a finger this far across.
 *
 * One-to-one up to the trigger line — the row is under the finger, and it should
 * feel like it — and damped after it.
 */
export function swipeTravel(distance: number, threshold: number): number {
  'worklet';
  const raw = Math.abs(distance);
  if (threshold <= 0) return 0;
  const travelled = raw <= threshold ? raw : threshold + (raw - threshold) * SWIPE_OVERPULL;
  return distance < 0 ? -travelled : travelled;
}

/**
 * What letting go here does.
 *
 * The only two answers, and `'cancel'` is the one that matters: a pull that did
 * not reach the line runs nothing and changes nothing, however far it got and
 * however fast it was moving. There is deliberately no velocity term — a flick
 * that happens to be quick is not a decision to delete a message.
 */
export function swipeRelease(distance: number, threshold: number): 'run' | 'cancel' {
  'worklet';
  if (threshold <= 0) return 'cancel';
  return Math.abs(distance) >= threshold ? 'run' : 'cancel';
}

/**
 * Whether an operation takes the row out of the list it was swiped in.
 *
 * The row is animated off the screen for those and snapped back for the rest —
 * a message that is still in front of you must not slide away as though it
 * moved, and one that has genuinely gone must not spring back under a toast
 * saying it was archived.
 *
 * The two spam marks are the reason this takes a context. Marking does not move
 * the message anywhere; it changes which category it is filed under. So the row
 * leaves a list that is *showing* one category and stays put in the unfiltered
 * inbox, which is exactly what the list itself does on the next render.
 */
export function swipeRemovesRow(operation: SwipeOperation, ctx: SwipeContext): boolean {
  switch (operation) {
    // Opens a screen; the message is untouched and the row is still there
    // behind it.
    case 'set-up':
      return false;
    case 'archive':
    case 'unarchive':
    case 'trash':
    case 'restore':
      return true;
    // Nothing has happened yet when a Snooze swipe completes — the picker still
    // has to ask until when. So the row springs back, and leaves the list a
    // moment later when the snooze is actually written, or stays if the sheet
    // is dismissed.
    case 'snooze':
      return false;
    case 'mark-spam':
      // It leaves Primary, Bills, Purchases or Promotions; in the whole inbox
      // it is still one of the messages in front of you.
      return ctx.category !== null && ctx.category !== 'spam';
    case 'mark-not-spam':
      return ctx.category === 'spam';
    case 'mark-read':
    case 'mark-unread':
      return false;
  }
}
