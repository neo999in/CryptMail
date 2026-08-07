/**
 * Local encryption at rest (`docs/security.md`).
 *
 * The property that matters is negative: after a write, the sensitive text must
 * not be present in what lands on disk. Asserting only that a round-trip works
 * would pass just as happily against an implementation that stored plaintext.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  initLocalCrypto,
  isSealed,
  protectionLevel,
  resetLocalCryptoForTests,
  seal,
  SecretStore,
  unseal,
} from '../localCrypto';
import { loadJson, resealPlaintext, saveJson } from '../secureJson';

function memoryStore(initial: Record<string, string> = {}): SecretStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

beforeEach(async () => {
  resetLocalCryptoForTests();
  await AsyncStorage.clear();
});

describe('the device key', () => {
  it('is generated once and reused', async () => {
    const store = memoryStore();
    await initLocalCrypto(store, 'keystore');
    const first = { ...store.data };

    resetLocalCryptoForTests();
    await initLocalCrypto(store, 'keystore');
    expect(store.data).toEqual(first);
  });

  it('reports where it is kept', async () => {
    await initLocalCrypto(memoryStore(), 'weak');
    expect(protectionLevel()).toBe('weak');
  });

  it('refuses to run with a corrupt key rather than generating a new one', async () => {
    // Silently replacing it would decrypt nothing and discard the keyring.
    const store = memoryStore({ 'cryptmail.dek.v1': 'AAAA' });
    await expect(initLocalCrypto(store, 'keystore')).rejects.toThrow(/corrupt/i);
  });

  it('will not seal before it is initialised', () => {
    expect(() => seal('secret')).toThrow(/not initialised/i);
  });
});

describe('sealing', () => {
  beforeEach(() => initLocalCrypto(memoryStore(), 'keystore'));

  it('round-trips', () => {
    expect(unseal(seal('Hey, are we still on for lunch?'))).toBe('Hey, are we still on for lunch?');
  });

  it('does not leave the plaintext in the sealed value', () => {
    expect(seal('board deck final numbers')).not.toContain('board deck');
  });

  it('uses a fresh nonce, so the same value seals differently each time', () => {
    expect(seal('same')).not.toBe(seal('same'));
  });

  it('rejects a tampered ciphertext instead of returning something', () => {
    const sealed = seal('trusted content');
    const flipped = sealed.slice(0, -4) + (sealed.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    expect(() => unseal(flipped)).toThrow();
  });

  it('passes through a value written before encryption existed', () => {
    expect(unseal('{"legacy":true}')).toBe('{"legacy":true}');
  });
});

describe('the JSON stores', () => {
  beforeEach(() => initLocalCrypto(memoryStore(), 'keystore'));

  it('round-trips a value', async () => {
    await saveJson('cryptmail.test.v1', { hello: 'world' });
    expect(await loadJson('cryptmail.test.v1', {})).toEqual({ hello: 'world' });
  });

  it('writes ciphertext, not readable JSON', async () => {
    await saveJson('cryptmail.searchindex.v1', { 'msg-1': 'Q3 board deck final numbers' });

    const onDisk = (await AsyncStorage.getItem('cryptmail.searchindex.v1'))!;
    expect(isSealed(onDisk)).toBe(true);
    // The decrypted search index is the most sensitive thing stored locally.
    expect(onDisk).not.toContain('board deck');
    expect(onDisk).not.toContain('msg-1');
  });

  it('returns the fallback when nothing is stored', async () => {
    expect(await loadJson('cryptmail.absent.v1', { fallback: true })).toEqual({ fallback: true });
  });

  it('reads data written before encryption existed', async () => {
    await AsyncStorage.setItem('cryptmail.keyring.v1', JSON.stringify({ 'a@b.c': { trust: 'seen' } }));
    expect(await loadJson('cryptmail.keyring.v1', {})).toEqual({ 'a@b.c': { trust: 'seen' } });
  });
});

describe('upgrading an install that predates encryption', () => {
  beforeEach(() => initLocalCrypto(memoryStore(), 'keystore'));

  it('re-seals plaintext without losing it', async () => {
    const original = { 'anya@partner.com': { trust: 'verified' } };
    await AsyncStorage.setItem('cryptmail.keyring.v1', JSON.stringify(original));

    const upgraded = await resealPlaintext(['cryptmail.keyring.v1']);

    expect(upgraded).toEqual(['cryptmail.keyring.v1']);
    expect(isSealed((await AsyncStorage.getItem('cryptmail.keyring.v1'))!)).toBe(true);
    expect(await loadJson('cryptmail.keyring.v1', {})).toEqual(original);
  });

  it('is a no-op on an install that is already sealed', async () => {
    await saveJson('cryptmail.drafts.v1', { d1: 'draft' });
    const before = await AsyncStorage.getItem('cryptmail.drafts.v1');

    expect(await resealPlaintext(['cryptmail.drafts.v1'])).toEqual([]);
    expect(await AsyncStorage.getItem('cryptmail.drafts.v1')).toBe(before);
  });

  it('ignores stores that hold nothing', async () => {
    expect(await resealPlaintext(['cryptmail.never-written.v1'])).toEqual([]);
  });
});
