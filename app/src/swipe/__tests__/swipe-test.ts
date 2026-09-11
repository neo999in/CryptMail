/**
 * What a swipe means, and how far it has to be pulled.
 *
 * The resolver is the interesting half. It is the one place that decides
 * whether a configured action does anything in the list the finger is in, and
 * both of its answers are load-bearing:
 *
 *  - a real operation, which `ui/swipeRun.tsx` then runs through the same
 *    `useApp()` actions the message screen calls;
 *  - `null`, which the row honours by not moving at all — a side turned off and
 *    an action with nothing to do are the same non-event. Nothing here may
 *    quietly substitute a different action for the one the user chose.
 *
 * The geometry is tested for the properties a phone can't be asked about in
 * CI: that the trigger distance scales with the row, that a destructive
 * operation asks for more of a pull than a reversible one, and that the fill is
 * two states switched at the line rather than a shade that creeps.
 */
import {
  deleteSide,
  fixedSwipeList,
  fixedSwipes,
  resolveSwipe,
  resolveSwipePair,
  SWIPE_ACTION_HINT,
  SWIPE_ACTION_LABEL,
  SWIPE_ACTIONS,
  SWIPE_PICKER_ACTIONS,
  SwipeAction,
  SwipeContext,
  swipeArmed,
  swipeFillState,
  swipeProgress,
  swipeRelease,
  swipeRemovesRow,
  swipeThreshold,
  swipeTravel,
} from '../swipe';

/** An unread inbox message in the mailbox in front — the ordinary case. */
const INBOX: SwipeContext = { box: null, junk: false, unread: true, category: null, foreign: false };

const ctx = (patch: Partial<SwipeContext> = {}): SwipeContext => ({ ...INBOX, ...patch });

describe('resolveSwipe — the side nobody has configured', () => {
  /**
   * The default right side. It offers to be configured — a neutral block saying
   * so — and that is the *only* thing it does: no archive, no delete, no spam
   * mark, no flag, nothing written about the message at all.
   */
  it('resolves "none" to the set-up prompt, in every list', () => {
    for (const c of [INBOX, ctx({ box: 'trash' }), ctx({ box: 'archive', unread: false }), ctx({ foreign: true })]) {
      expect(resolveSwipe('none', c)).toMatchObject({
        operation: 'set-up',
        tone: 'neutral',
        destructive: false,
      });
    }
  });

  it('touches no message: it is not one of the mail operations', () => {
    const mail = ['archive', 'trash', 'restore', 'mark-spam', 'mark-not-spam', 'mark-read', 'mark-unread', 'snooze'];

    expect(mail).not.toContain(resolveSwipe('none', INBOX)?.operation);
  });

  /** It opens a screen, so the row it was swiped on is still there behind it. */
  it('leaves the row in the list', () => {
    expect(swipeRemovesRow('set-up', INBOX)).toBe(false);
  });
});

describe('resolveSwipe — the side turned off', () => {
  /**
   * The user's answer, as opposed to the absence of one. `null` everywhere, so
   * the row is inert in every list — including the ones where an unconfigured
   * side would still be offering to be configured.
   */
  it('resolves to nothing at all, in every list', () => {
    for (const c of [INBOX, ctx({ box: 'trash' }), ctx({ box: 'archive', unread: false }), ctx({ foreign: true })]) {
      expect(resolveSwipe('off', c)).toBeNull();
    }
  });

  /** The distinction is the whole point: one asks a question, the other has answered it. */
  it('is not the unconfigured side', () => {
    expect(resolveSwipe('none', INBOX)?.operation).toBe('set-up');
    expect(resolveSwipe('off', INBOX)).toBeNull();
  });
});

describe('resolveSwipe — archive', () => {
  it('archives from the inbox', () => {
    expect(resolveSwipe('archive', INBOX)).toMatchObject({ operation: 'archive', destructive: false });
  });

  it('archives from a category filter over the inbox', () => {
    expect(resolveSwipe('archive', ctx({ category: 'bills' }))?.operation).toBe('archive');
  });

  /**
   * The same move the other way, now that `FlagPatch.archived` is two-way: a
   * message already out of the inbox is put back into it.
   */
  it('moves a message back to the inbox, in Archive', () => {
    const visual = resolveSwipe('archive', ctx({ box: 'archive' }));

    expect(visual).toMatchObject({ operation: 'unarchive', label: 'Move to inbox', destructive: false });
  });

  /**
   * Sent and Trash are neither: there is no INBOX label to remove, and neither
   * is the archive to come back from. The honest answer is that the row does not
   * move — not a silently substituted action, and not a call that would report
   * success having done nothing.
   */
  it('does nothing in Sent or Trash', () => {
    expect(resolveSwipe('archive', ctx({ box: 'sent' }))).toBeNull();
    expect(resolveSwipe('archive', ctx({ box: 'trash' }))).toBeNull();
  });

  /** Both directions of the move take the row out of the list it was in. */
  it('takes the row out of the list either way', () => {
    expect(swipeRemovesRow('archive', INBOX)).toBe(true);
    expect(swipeRemovesRow('unarchive', ctx({ box: 'archive' }))).toBe(true);
  });
});

describe('resolveSwipe — delete', () => {
  it('moves a message to Trash from anywhere it is not already there', () => {
    expect(resolveSwipe('trash', INBOX)).toMatchObject({ operation: 'trash', destructive: true });
    expect(resolveSwipe('trash', ctx({ box: 'sent' }))?.operation).toBe('trash');
    expect(resolveSwipe('trash', ctx({ box: 'archive' }))?.operation).toBe('trash');
  });

  /** The same move, the other way: CryptMail has `restoreMessage` already. */
  it('restores instead, in Trash', () => {
    const visual = resolveSwipe('trash', ctx({ box: 'trash' }));

    expect(visual).toMatchObject({ operation: 'restore', label: 'Restore', destructive: false });
  });
});

describe('resolveSwipe — spam', () => {
  it('files an ordinary inbox message as spam', () => {
    expect(resolveSwipe('spam', INBOX)).toMatchObject({ operation: 'mark-spam', destructive: true });
  });

  /** The useful action is always the opposite of where the message is filed. */
  it('rescues one already filed as junk', () => {
    expect(resolveSwipe('spam', ctx({ junk: true }))?.operation).toBe('mark-not-spam');
  });

  /**
   * The mark trains the *active* account's model, and `mailbox.applyMark` only
   * knows rows in that account's inbox. Anywhere else it would appear to work
   * and quietly not.
   */
  it('does nothing outside the inbox', () => {
    expect(resolveSwipe('spam', ctx({ box: 'archive' }))).toBeNull();
    expect(resolveSwipe('spam', ctx({ box: 'trash' }))).toBeNull();
  });

  it('does nothing on another mailbox’s row in a merged inbox', () => {
    expect(resolveSwipe('spam', ctx({ foreign: true }))).toBeNull();
  });
});

describe('resolveSwipe — read', () => {
  it('is whichever of the two the message is not', () => {
    expect(resolveSwipe('read', ctx({ unread: true }))).toMatchObject({ operation: 'mark-read' });
    expect(resolveSwipe('read', ctx({ unread: false }))).toMatchObject({ operation: 'mark-unread' });
  });

  /** `setFlags` finds the row in whichever list it is in, so this one travels. */
  it('works in every list, and on another mailbox’s row', () => {
    expect(resolveSwipe('read', ctx({ box: 'sent', unread: false }))?.operation).toBe('mark-unread');
    expect(resolveSwipe('read', ctx({ box: 'trash' }))?.operation).toBe('mark-read');
    expect(resolveSwipe('read', ctx({ foreign: true }))?.operation).toBe('mark-read');
  });
});

describe('resolveSwipe — snooze', () => {
  it('snoozes from the inbox', () => {
    expect(resolveSwipe('snooze', INBOX)).toMatchObject({ operation: 'snooze', tone: 'accent' });
  });

  /** Only the inbox hides snoozed mail, and only the active account's store is written. */
  it('does nothing elsewhere, or on another mailbox’s row', () => {
    expect(resolveSwipe('snooze', ctx({ box: 'archive' }))).toBeNull();
    expect(resolveSwipe('snooze', ctx({ foreign: true }))).toBeNull();
  });
});

describe('fixed layouts — Sent, Drafts, Archive, Spam', () => {
  const SPAM = ctx({ category: 'spam', junk: true });

  it('knows which lists wear one, and leaves the inbox and Trash to the preference', () => {
    expect(fixedSwipeList(ctx({ box: 'sent' }))).toBe('sent');
    expect(fixedSwipeList(ctx({ box: 'archive' }))).toBe('archive');
    expect(fixedSwipeList(SPAM)).toBe('spam');
    expect(fixedSwipeList(INBOX)).toBeNull();
    expect(fixedSwipeList(ctx({ category: 'bills' }))).toBeNull();
    expect(fixedSwipeList(ctx({ box: 'trash' }))).toBeNull();
  });

  it('puts Delete where Delete is configured, and on the left otherwise', () => {
    expect(deleteSide('trash', 'none')).toBe('left');
    expect(deleteSide('archive', 'trash')).toBe('right');
    expect(deleteSide('archive', 'none')).toBe('left');
    expect(deleteSide('trash', 'trash')).toBe('left');
  });

  it('gives Sent and Drafts Delete alone', () => {
    for (const list of ['sent', 'drafts'] as const) {
      expect(fixedSwipes(list, 'archive', 'none')).toEqual({ left: expect.objectContaining({ operation: 'trash' }), right: null });
      expect(fixedSwipes(list, 'read', 'trash')).toEqual({ left: null, right: expect.objectContaining({ operation: 'trash' }) });
    }
  });

  it('gives Archive Delete and Move to inbox', () => {
    const pair = resolveSwipePair('archive', 'none', ctx({ box: 'archive' }));
    expect(pair.left?.operation).toBe('trash');
    expect(pair.right?.operation).toBe('unarchive');
    const flipped = resolveSwipePair('archive', 'trash', ctx({ box: 'archive' }));
    expect(flipped.left?.operation).toBe('unarchive');
    expect(flipped.right?.operation).toBe('trash');
  });

  it('gives Spam Delete and Not spam — but not Not spam on another mailbox’s row', () => {
    const pair = resolveSwipePair('archive', 'none', SPAM);
    expect(pair.left?.operation).toBe('trash');
    expect(pair.right?.operation).toBe('mark-not-spam');
    expect(resolveSwipePair('archive', 'none', { ...SPAM, foreign: true })).toEqual({
      left: expect.objectContaining({ operation: 'trash' }),
      right: null,
    });
  });

  it('takes the row out of the list either way', () => {
    expect(swipeRemovesRow('trash', SPAM)).toBe(true);
    expect(swipeRemovesRow('mark-not-spam', SPAM)).toBe(true);
    expect(swipeRemovesRow('unarchive', ctx({ box: 'archive' }))).toBe(true);
  });

  it('leaves the inbox exactly as the preference says', () => {
    expect(resolveSwipePair('archive', 'none', INBOX)).toEqual({
      left: resolveSwipe('archive', INBOX),
      right: resolveSwipe('none', INBOX),
    });
  });
});

describe('the pane', () => {
  it('gives every action a label and a line saying where it applies', () => {
    for (const action of SWIPE_ACTIONS) {
      expect(SWIPE_ACTION_LABEL[action].length).toBeGreaterThan(0);
      expect(SWIPE_ACTION_HINT[action].length).toBeGreaterThan(0);
    }
  });

  it('offers No action, so a side can be emptied again', () => {
    expect(SWIPE_PICKER_ACTIONS).toContain<SwipeAction>('off');
    expect(SWIPE_ACTION_LABEL.off).toBe('No action');
  });

  /**
   * `none` stays a valid stored value — it is what a fresh install's right side
   * is — but it is not something to choose: a side that has been answered for
   * does not go back to asking. Emptying it is `off`.
   */
  it('keeps the unconfigured state storable and out of the picker', () => {
    expect(SWIPE_ACTIONS).toContain<SwipeAction>('none');
    expect(SWIPE_PICKER_ACTIONS).not.toContain<SwipeAction>('none');
    expect(SWIPE_ACTION_LABEL.none).toBe('Set Up');
  });

  /** Everything the picker shows is an action the store will accept back. */
  it('offers only ids the store validates', () => {
    for (const action of SWIPE_PICKER_ACTIONS) expect(SWIPE_ACTIONS).toContain(action);
  });

  /**
   * Colour is never the only thing carrying the meaning: every operation has a
   * word as well, and the two destructive ones are the pair that must not read
   * as the reversible ones.
   */
  it('marks the two operations that need a deliberate pull', () => {
    expect(resolveSwipe('trash', INBOX)?.destructive).toBe(true);
    expect(resolveSwipe('spam', INBOX)?.destructive).toBe(true);
    expect(resolveSwipe('archive', INBOX)?.destructive).toBe(false);
    expect(resolveSwipe('read', INBOX)?.destructive).toBe(false);
  });
});

describe('swipeThreshold', () => {
  it('scales with the row rather than being one phone’s number', () => {
    expect(swipeThreshold(400, false)).toBeGreaterThan(swipeThreshold(320, false));
  });

  it('asks for more of a pull before something destructive', () => {
    for (const width of [320, 390, 480, 820]) {
      expect(swipeThreshold(width, true)).toBeGreaterThan(swipeThreshold(width, false));
    }
  });

  it('stays crossable on a phone and reachable on a tablet', () => {
    for (const width of [320, 360, 390, 430, 600, 820, 1280]) {
      for (const destructive of [true, false]) {
        const limit = swipeThreshold(width, destructive);
        // Never more than the row: a threshold a finger cannot reach is no
        // threshold at all.
        expect(limit).toBeLessThanOrEqual(width * 0.8);
        expect(limit).toBeGreaterThan(0);
      }
    }
  });

  it('does not demand a haul across a wide screen', () => {
    expect(swipeThreshold(1280, false)).toBeLessThanOrEqual(190);
    expect(swipeThreshold(1280, true)).toBeLessThanOrEqual(240);
  });

  it('survives a row that has not been measured yet', () => {
    expect(swipeThreshold(0, false)).toBe(0);
  });
});

describe('swipeProgress', () => {
  const limit = swipeThreshold(390, false);

  it('is nothing at rest', () => {
    expect(swipeProgress(0, limit)).toBe(0);
    expect(swipeArmed(swipeProgress(0, limit))).toBe(false);
  });

  it('reads the same either way — the pane is on the side the row uncovered', () => {
    expect(swipeProgress(40, limit)).toBe(swipeProgress(-40, limit));
  });

  it('is short of the line for a partial pull', () => {
    const partial = swipeProgress(limit / 2, limit);

    expect(partial).toBeCloseTo(0.5);
    expect(swipeArmed(partial)).toBe(false);
  });

  it('arms exactly at the line, and stays armed past it', () => {
    expect(swipeArmed(swipeProgress(limit, limit))).toBe(true);
    expect(swipeProgress(limit * 3, limit)).toBe(1);
    expect(swipeArmed(swipeProgress(limit * 3, limit))).toBe(true);
  });

  it('is nothing at all against an unmeasured row', () => {
    expect(swipeProgress(120, 0)).toBe(0);
  });
});

describe('swipeFillState', () => {
  /**
   * The block has two looks and switches between them. There is deliberately no
   * third value and no ramp: a pull that will not fire must not be able to look
   * like one that will, and the step across the line is the whole signal.
   */
  it('holds the resting shade for the whole of the pull', () => {
    for (const p of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) expect(swipeFillState(p)).toBe('rest');
  });

  it('switches to full colour at the line, and stays there through an over-pull', () => {
    expect(swipeFillState(1)).toBe('armed');
    expect(swipeFillState(1.8)).toBe('armed');
  });

  /** The one place the switch is decided, so nothing on the block disagrees. */
  it('flips exactly where the release fires', () => {
    for (const p of [0, 0.5, 0.99, 1, 2]) {
      expect(swipeFillState(p) === 'armed').toBe(swipeArmed(p));
    }
  });
});

describe('swipeRemovesRow', () => {
  it('takes the row away for the three moves', () => {
    expect(swipeRemovesRow('archive', INBOX)).toBe(true);
    expect(swipeRemovesRow('trash', INBOX)).toBe(true);
    expect(swipeRemovesRow('restore', ctx({ box: 'trash' }))).toBe(true);
  });

  it('leaves it in place for a read flag, which changes the row rather than moving it', () => {
    expect(swipeRemovesRow('mark-read', INBOX)).toBe(false);
    expect(swipeRemovesRow('mark-unread', INBOX)).toBe(false);
  });

  /**
   * Nothing has happened yet when a Snooze swipe completes — the picker still
   * has to ask until when — so the row springs back and leaves only once the
   * snooze is written, or stays if the sheet is dismissed.
   */
  it('leaves it in place for a snooze, which has not happened yet', () => {
    expect(swipeRemovesRow('snooze', INBOX)).toBe(false);
  });

  /** A spam mark re-files rather than moves: whether the row goes is a question
   *  about the list, not about the operation. */
  it('takes the row away only from a list showing one category', () => {
    expect(swipeRemovesRow('mark-spam', ctx({ category: 'primary' }))).toBe(true);
    expect(swipeRemovesRow('mark-spam', INBOX)).toBe(false);
    expect(swipeRemovesRow('mark-not-spam', ctx({ category: 'spam', junk: true }))).toBe(true);
    expect(swipeRemovesRow('mark-not-spam', ctx({ junk: true }))).toBe(false);
  });
});

describe('swipeTravel', () => {
  const limit = swipeThreshold(390, false);

  it('keeps the row under the finger up to the line', () => {
    expect(swipeTravel(0, limit)).toBe(0);
    expect(swipeTravel(30, limit)).toBe(30);
    expect(swipeTravel(-30, limit)).toBe(-30);
    expect(swipeTravel(limit, limit)).toBe(limit);
  });

  it('damps the pull past it, in both directions', () => {
    const over = swipeTravel(limit * 2, limit);

    expect(over).toBeGreaterThan(limit);
    expect(over).toBeLessThan(limit * 2);
    expect(swipeTravel(-limit * 2, limit)).toBe(-over);
  });

  it('never goes backwards as the finger goes further', () => {
    let previous = -1;
    for (const d of [0, 20, 60, limit, limit * 1.5, limit * 4]) {
      const travelled = swipeTravel(d, limit);
      expect(travelled).toBeGreaterThan(previous);
      previous = travelled;
    }
  });

  it('does not move a row that has not been measured', () => {
    expect(swipeTravel(200, 0)).toBe(0);
  });
});

describe('swipeRelease', () => {
  const limit = swipeThreshold(390, true);

  /** The cancelled swipe: it got somewhere, and it does nothing. */
  it('cancels anything short of the line', () => {
    expect(swipeRelease(0, limit)).toBe('cancel');
    expect(swipeRelease(limit * 0.4, limit)).toBe('cancel');
    expect(swipeRelease(limit - 1, limit)).toBe('cancel');
    expect(swipeRelease(-(limit - 1), limit)).toBe('cancel');
  });

  it('runs at the line and beyond, either way', () => {
    expect(swipeRelease(limit, limit)).toBe('run');
    expect(swipeRelease(limit * 3, limit)).toBe('run');
    expect(swipeRelease(-limit, limit)).toBe('run');
  });

  /**
   * A destructive operation has to be pulled further than a reversible one, so
   * the same gesture that deletes would only have archived.
   */
  it('holds Delete back where Archive would already have run', () => {
    const archive = swipeThreshold(390, false);
    const del = swipeThreshold(390, true);
    const pull = (archive + del) / 2;

    expect(swipeRelease(pull, archive)).toBe('run');
    expect(swipeRelease(pull, del)).toBe('cancel');
  });

  it('cancels against an unmeasured row rather than firing on nothing', () => {
    expect(swipeRelease(500, 0)).toBe('cancel');
  });
});
