/**
 * How much of this device one mailbox takes up, in bytes.
 *
 * Measured from the stored values **without unsealing them**. That is the
 * property the whole module is for: the size of a sealed blob is a fact about
 * the ciphertext, so a mailbox that is not in front can be measured without its
 * search index, keyring or drafts being decrypted behind the user's back. Row
 * counts ("messages indexed") still need the plaintext, and stay with the
 * mailbox in front.
 *
 * The number is what the values occupy as UTF-8 — the sealed envelope for
 * everything written since encryption landed, which is base64 and so one byte
 * a character. It is not the SQLite file's size on disk, which carries page
 * overhead no store controls; it is the part that clearing a store gives back.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { utf8ByteLength } from '../lib/base64';
import { AccountId, scopedKey } from './accountScope';

export type StorageUsage = {
  /** Every store this account owns, together. */
  total: number;
  /** By unscoped base key; a store with nothing written reads 0. */
  byStore: Record<string, number>;
};

/**
 * Measure one account's stores.
 *
 * `bases` is passed in rather than imported so this module does not depend on
 * `store/index.ts`, which is where the list of per-account stores lives.
 */
export async function measureAccountStorage(account: AccountId, bases: string[]): Promise<StorageUsage> {
  const pairs = await AsyncStorage.multiGet(bases.map((base) => scopedKey(base, account)));
  const byStore: Record<string, number> = {};
  let total = 0;
  pairs.forEach(([, value], i) => {
    const bytes = value === null ? 0 : utf8ByteLength(value);
    byStore[bases[i]] = bytes;
    total += bytes;
  });
  return { total, byStore };
}
