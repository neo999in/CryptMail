/**
 * Mail preferences: what each swipe direction does.
 *
 * Global rather than per-account, for the same reason as `prefsStore` — a
 * gesture is a property of the hand holding the device, not of a mailbox, and
 * switching accounts must not change what a swipe does under the user. So this
 * key is deliberately **not** in `PER_ACCOUNT_STORE_KEYS`, and removing an
 * account leaves it alone.
 *
 * Separate from `prefsStore` rather than two more fields on it: that store is
 * *appearance* — theme, colour, density — read by `ui/appearance.tsx` on every
 * accented render. What a swipe does is behaviour, and behaviour that reaches
 * the send-adjacent mail operations at that. Keeping them apart means a screen
 * that reads one is not re-rendered by a change to the other.
 *
 * Sealed like every other store, through `secureJson`, and listed in
 * `SEALED_STORE_KEYS`. There is no secret in here, but the boot sweep works off
 * a list of keys and a store that opts out is a store someone has to remember
 * is different.
 */
import { SWIPE_ACTIONS, SwipeAction } from '../swipe/swipe';
import { loadJson, saveJson } from './secureJson';

export const MAIL_PREFS_STORE_KEY = 'cryptmail.mailprefs.v1';

export type MailPrefs = {
  /** What a swipe towards the left of the screen does. */
  swipeLeft: SwipeAction;
  /** What a swipe towards the right of the screen does. */
  swipeRight: SwipeAction;
};

/**
 * Archive on the left, and **nothing on the right**.
 *
 * The empty right side is deliberate and is not a placeholder waiting to be
 * filled in with something sensible. Every action on the other side of that
 * gesture moves or re-files mail, and a user who has not asked for one should
 * not discover it by brushing the screen. Someone who wants Delete under their
 * thumb says so once, in Settings, and it is theirs from then on.
 */
export const DEFAULT_MAIL_PREFS: MailPrefs = {
  swipeLeft: 'archive',
  swipeRight: 'none',
};

/**
 * Coerce anything read off disk into a valid `MailPrefs`.
 *
 * A value from a future build, a hand-edited store or a half-written blob must
 * not be able to hand the mail list an action id nothing can resolve — the row
 * would draw a pane with no operation behind it. One place decides, and it
 * decides per field: an unreadable left side does not reset a good right one.
 *
 * `none` is a value in here like any other — the side that has not been
 * answered for — and is validated, stored and reloaded as such. It is only the
 * *picker* that leaves it out; turning a side off from there writes `off`.
 *
 * An unknown action falls back to that side's **default**, not to `none`: the
 * left side is Archive in a fresh install and should be Archive again if its
 * stored value is nonsense, rather than silently going dead.
 */
export function normaliseMailPrefs(value: Partial<MailPrefs> | null | undefined): MailPrefs {
  return {
    swipeLeft: valid(value?.swipeLeft) ? value!.swipeLeft! : DEFAULT_MAIL_PREFS.swipeLeft,
    swipeRight: valid(value?.swipeRight) ? value!.swipeRight! : DEFAULT_MAIL_PREFS.swipeRight,
  };
}

const valid = (action: SwipeAction | undefined): boolean =>
  action !== undefined && SWIPE_ACTIONS.includes(action);

export async function loadMailPrefs(): Promise<MailPrefs> {
  return normaliseMailPrefs(await loadJson<Partial<MailPrefs>>(MAIL_PREFS_STORE_KEY, DEFAULT_MAIL_PREFS));
}

export async function saveMailPrefs(prefs: MailPrefs): Promise<MailPrefs> {
  const next = normaliseMailPrefs(prefs);
  await saveJson(MAIL_PREFS_STORE_KEY, next);
  return next;
}
