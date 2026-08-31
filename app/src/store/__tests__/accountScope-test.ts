/**
 * Per-account storage keys, and the one-way door into them.
 *
 * Two properties matter and they pull in opposite directions: an install that
 * predates multi-account must not lose its keyring, and a *second* account must
 * not inherit the first one's mail. The carry-over in `loadScopedJson` is what
 * satisfies both, and it only works because it moves the value rather than
 * copying it — which is precisely the part worth pinning down.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { accountIdFor, scopedKey } from '../accountScope';
import { initLocalCrypto, resetLocalCryptoForTests, seal, SecretStore } from '../localCrypto';
import { loadScopedJson, removeScoped, saveScopedJson } from '../secureJson';

const BASE = 'cryptmail.keyring.v1';
const ONE = accountIdFor('gmail', 'you@gmail.com');
const TWO = accountIdFor('gmail', 'you@work.example');

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
  await AsyncStorage.clear();
  resetLocalCryptoForTests();
  await initLocalCrypto(memoryStore(), 'keystore');
});

describe('account ids', () => {
  it('pairs the provider with the address, lower-cased', () => {
    expect(accountIdFor('gmail', '  You@Gmail.com ')).toBe('gmail:you@gmail.com');
  });

  /**
   * One address reached through two providers is two different sets of local
   * data — a different identity, a different keyring, a different search index
   * — so the id has to keep them apart even when the address is identical.
   */
  it('keeps the same address apart across providers', () => {
    expect(accountIdFor('imap', 'a@b.com')).not.toBe(accountIdFor('gmail', 'a@b.com'));
  });

  it('scopes a store key without losing it', () => {
    expect(scopedKey(BASE, ONE)).toBe(`${BASE}@gmail:you@gmail.com`);
  });
});

describe('scoped stores', () => {
  it('keeps each account to itself', async () => {
    await saveScopedJson(BASE, ONE, { a: 1 });
    await saveScopedJson(BASE, TWO, { b: 2 });

    expect(await loadScopedJson(BASE, ONE, {})).toEqual({ a: 1 });
    expect(await loadScopedJson(BASE, TWO, {})).toEqual({ b: 2 });
  });

  it('is empty for an account that has never been written', async () => {
    expect(await loadScopedJson(BASE, TWO, { fallback: true })).toEqual({ fallback: true });
  });

  it('seals what it writes', async () => {
    await saveScopedJson(BASE, ONE, { a: 1 });

    expect(await AsyncStorage.getItem(scopedKey(BASE, ONE))).toMatch(/^CMSEAL1\./);
  });

  describe('adopting a pre-multi-account store', () => {
    it('carries the old global value into the first account', async () => {
      await AsyncStorage.setItem(BASE, seal(JSON.stringify({ legacy: true })));

      expect(await loadScopedJson(BASE, ONE, {})).toEqual({ legacy: true });
      expect(await AsyncStorage.getItem(scopedKey(BASE, ONE))).not.toBeNull();
    });

    /**
     * The reason it is a move. If the global key survived, connecting a second
     * mailbox would hand it the first one's keyring and drafts — the exact leak
     * this feature exists to prevent, on the very first switch.
     */
    it('does not hand it to a second account as well', async () => {
      await AsyncStorage.setItem(BASE, seal(JSON.stringify({ legacy: true })));
      await loadScopedJson(BASE, ONE, {});

      expect(await loadScopedJson(BASE, TWO, {})).toEqual({});
      expect(await AsyncStorage.getItem(BASE)).toBeNull();
    });

    /** An install that predates encryption too: read it, then seal it on the way across. */
    it('seals a value that was still in the clear', async () => {
      await AsyncStorage.setItem(BASE, JSON.stringify({ legacy: true }));

      expect(await loadScopedJson(BASE, ONE, {})).toEqual({ legacy: true });
      expect(await AsyncStorage.getItem(scopedKey(BASE, ONE))).toMatch(/^CMSEAL1\./);
    });
  });

  /**
   * Removing an account has to remove its data. Leaving a search index — a
   * plaintext copy of that mailbox's mail — behind would make the button a lie,
   * and re-adding the address would silently adopt it.
   */
  it('erases one account and leaves the other alone', async () => {
    await saveScopedJson(BASE, ONE, { a: 1 });
    await saveScopedJson(BASE, TWO, { b: 2 });

    await removeScoped([BASE], ONE);

    expect(await loadScopedJson(BASE, ONE, {})).toEqual({});
    expect(await loadScopedJson(BASE, TWO, {})).toEqual({ b: 2 });
  });
});
