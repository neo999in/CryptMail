/**
 * The last mail this device listed, so a launch has something to draw.
 *
 * Everything else in `state` is either cheap to recompute or already persisted;
 * `messages` was neither. It lived only in memory, so every cold start, every
 * account switch and every process kill met an empty list and a spinner until
 * a full sync came back — thirty-odd requests before the first row appeared,
 * on mail this device had already seen.
 *
 * This is a **cache and nothing more**. It is never the source of truth, never
 * merged with a fetch, and never consulted after the first paint: `refreshInbox`
 * replaces what it holds with what the provider says, which is why nothing here
 * has to reason about a row deleted from another client. It is capped for the
 * same reason — see `CACHE_LIMIT`.
 *
 * It holds subjects, snippets and addresses of plaintext mail, which makes it
 * sensitive in the same way `searchIndex` is, and it is written through
 * `secureJson` like every other store. `resetAccount(id, 'content')` erases it:
 * "drop this device's copy of my mail" has to mean this too, or the button is a
 * lie.
 */
import { AccountId } from './accountScope';
import { loadScopedJson, saveScopedJson } from './secureJson';

export const MAIL_CACHE_STORE_KEY = 'cryptmail.mailcache.v1';

/**
 * How many rows are kept, per list.
 *
 * Deliberately close to what one sync returns rather than as much as the user
 * has paged in. The cache is replaced wholesale by the first refresh, so a cache
 * much *deeper* than a page would paint a long list and then visibly shorten it
 * a second later — the list on screen shrinking under a reader who has not
 * touched it. At roughly two pages the trim happens below the fold of a list
 * that is scrolled to the top, which is where a list that was just mounted is.
 *
 * Paging deeper than this still works and still costs nothing extra: "load older
 * mail" asks the provider, as it always did.
 */
const CACHE_LIMIT = 60;

/** Sent, Archive and Trash are opened less often, and shallower. */
const BOX_CACHE_LIMIT = 40;

/**
 * One account's cached lists.
 *
 * Typed on the row shape rather than importing `InboxItem`, so this module stays
 * a store and does not depend on `state/`. The caller writes rows that already
 * carry their account and reads them straight back.
 */
export type CachedRow = { id: string; date: string; account: AccountId };

export type MailCache<Row extends CachedRow> = {
  messages: Row[];
  /** Keyed by `SecondaryBox`; partial because a box the user never opened has none. */
  boxes: Record<string, Row[]>;
};

export const emptyMailCache = <Row extends CachedRow>(): MailCache<Row> => ({
  messages: [],
  boxes: {},
});

/**
 * Read this account's cached lists.
 *
 * Rows belonging to any *other* account are dropped on the way out. They cannot
 * normally be there — writes filter them — but a merged inbox is the one list in
 * the app that legitimately holds several mailboxes' mail at once, so the
 * invariant is enforced on both sides rather than assumed on one.
 */
export async function loadMailCache<Row extends CachedRow>(
  account: AccountId,
): Promise<MailCache<Row>> {
  const stored = await loadScopedJson<MailCache<Row>>(
    MAIL_CACHE_STORE_KEY,
    account,
    emptyMailCache<Row>(),
  );
  const own = (rows: Row[] | undefined) => (rows ?? []).filter((row) => row.account === account);

  return {
    messages: own(stored.messages),
    boxes: Object.fromEntries(
      Object.entries(stored.boxes ?? {}).map(([box, rows]) => [box, own(rows)]),
    ),
  };
}

export async function saveMailCache<Row extends CachedRow>(
  account: AccountId,
  cache: MailCache<Row>,
): Promise<void> {
  await saveScopedJson(MAIL_CACHE_STORE_KEY, account, cache);
}

/**
 * The rows of one list worth keeping: this account's own, newest first, capped.
 *
 * A merged inbox hands this every mailbox's mail. Storing all of it would put
 * one account's subjects in another account's store — the exact leak
 * `accountScope` exists to prevent — so the filter is load-bearing, not tidiness.
 */
export function cacheable<Row extends CachedRow>(
  rows: Row[],
  account: AccountId,
  limit = CACHE_LIMIT,
): Row[] {
  return rows
    .filter((row) => row.account === account)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

export const cacheableBox = <Row extends CachedRow>(rows: Row[], account: AccountId): Row[] =>
  cacheable(rows, account, BOX_CACHE_LIMIT);
