/**
 * The cached mail list.
 *
 * The properties that matter here are all about *containment*, not about
 * storage mechanics. This store exists so a launch has rows to draw, and it is
 * replaced by the first real sync — so what it must never do is outlive its
 * account or reach across to another one:
 *
 *  - it is keyed per account, and a merged inbox hands the writer every
 *    mailbox's mail, so only the owning account's rows may be stored;
 *  - it is capped, so a deep-paged session cannot grow it without bound and
 *    cannot paint a long list that the refresh behind it then visibly shortens;
 *  - it is removable with the account, which means being in `PER_ACCOUNT_STORE_KEYS`.
 *
 * The round-trips go through the real sealed store, so they also prove the rows
 * survive being written and read back rather than only being filtered correctly
 * in memory.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { accountIdFor } from '../accountScope';
import { initLocalCrypto, resetLocalCryptoForTests, SecretStore } from '../localCrypto';
import {
  cacheable,
  cacheableBox,
  CachedRow,
  emptyMailCache,
  loadMailCache,
  MAIL_CACHE_STORE_KEY,
  saveMailCache,
} from '../mailCacheStore';
import { PER_ACCOUNT_STORE_KEYS, SEALED_STORE_KEYS } from '..';

function memoryStore(): SecretStore {
  const data: Record<string, string> = {};
  return {
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

beforeEach(async () => {
  resetLocalCryptoForTests();
  await AsyncStorage.clear();
  await initLocalCrypto(memoryStore(), 'keystore');
});

const mine = accountIdFor('gmail', 'me@gmail.com');
const theirs = accountIdFor('gmail', 'other@gmail.com');

/** `n` rows, newest first, one day apart, all belonging to `account`. */
const rows = (n: number, account = mine): CachedRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    date: new Date(Date.UTC(2026, 0, 100 - i)).toISOString(),
    account,
  }));

describe('the store', () => {
  it('is erased with the account it belongs to', () => {
    expect(PER_ACCOUNT_STORE_KEYS).toContain(MAIL_CACHE_STORE_KEY);
  });

  it('is sealed at rest — it holds subjects and snippets', () => {
    expect(SEALED_STORE_KEYS).toContain(MAIL_CACHE_STORE_KEY);
  });

  it('reads empty on a device that has never synced', async () => {
    expect(await loadMailCache(mine)).toEqual(emptyMailCache());
  });

  it('round-trips the inbox and each box', async () => {
    const cache = { messages: rows(3), boxes: { sent: rows(2), archive: [] } };
    await saveMailCache(mine, cache);

    expect(await loadMailCache(mine)).toEqual(cache);
  });

  it('keeps one mailbox cache out of another mailbox', async () => {
    await saveMailCache(mine, { messages: rows(3), boxes: {} });

    expect(await loadMailCache(theirs)).toEqual(emptyMailCache());
  });

  /**
   * The write filters, so this should be unreachable — which is exactly why it
   * is asserted on the read too. A merged inbox is the one list in the app that
   * legitimately holds several mailboxes at once, and the cost of getting this
   * wrong is one account's subjects surfacing under another's id.
   */
  it('drops a foreign row that somehow reached the store', async () => {
    await saveMailCache(mine, {
      messages: [...rows(2), ...rows(2, theirs)],
      boxes: { sent: rows(1, theirs) },
    });

    const loaded = await loadMailCache(mine);
    expect(loaded.messages.map((m) => m.account)).toEqual([mine, mine]);
    expect(loaded.boxes.sent).toEqual([]);
  });
});

describe('cacheable', () => {
  it('keeps only the rows the owning mailbox holds', () => {
    const mixed = [...rows(2), ...rows(3, theirs)];

    expect(cacheable(mixed, mine)).toHaveLength(2);
  });

  it('sorts newest first, whatever order it was handed', () => {
    const shuffled = [...rows(3)].reverse();

    expect(cacheable(shuffled, mine).map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
  });

  /**
   * The cap is what stops a deep-paged session being painted and then visibly
   * trimmed when the refresh behind it lands: what survives is the newest rows,
   * which is the part of the list a just-mounted screen is actually showing.
   */
  it('caps the inbox at the newest rows', () => {
    const kept = cacheable(rows(200), mine);

    expect(kept).toHaveLength(60);
    expect(kept[0].id).toBe('m0');
  });

  it('caps a box more tightly than the inbox', () => {
    expect(cacheableBox(rows(200), mine)).toHaveLength(40);
  });

  it('leaves a list shorter than the cap alone', () => {
    expect(cacheable(rows(5), mine)).toHaveLength(5);
  });
});
