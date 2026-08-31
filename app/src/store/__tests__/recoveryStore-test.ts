/**
 * The "you have never backed up this key" mark.
 *
 * The interesting logic is `needsBackup`, which decides whether to warn. Both
 * of its failure directions are bad in different ways: nagging a user who has a
 * backup trains them to dismiss the warning, and staying quiet for a key with
 * no backup is the exact silence this feature exists to break.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { initLocalCrypto, resetLocalCryptoForTests, SecretStore } from '../localCrypto';
import {
  clearBackupRecord,
  loadRecoveryState,
  needsBackup,
  recordBackup,
  RECOVERY_STORE_KEY,
} from '../recoveryStore';
import { scopedKey } from '../accountScope';
import { SEALED_STORE_KEYS } from '../index';

/** Two accounts, so the per-account scoping is exercised rather than assumed. */
const ACCOUNT = 'demo:you@gmail.com';
const OTHER_ACCOUNT = 'demo:you@work.example';

const FINGERPRINT = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';
const OTHER = 'FFFF9999EEEE8888DDDD7777CCCC6666BBBB5555';

function memoryStore(): SecretStore {
  const data: Record<string, string> = {};
  return {
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

describe('recovery store', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetLocalCryptoForTests();
    await initLocalCrypto(memoryStore(), 'keystore');
  });

  it('reports a fresh install as never backed up', async () => {
    expect(await loadRecoveryState(ACCOUNT)).toEqual({ backedUpAt: null, fingerprint: null });
  });

  it('records and reloads a backup', async () => {
    const at = new Date('2026-08-07T12:00:00.000Z');
    await recordBackup(ACCOUNT, FINGERPRINT, at);

    expect(await loadRecoveryState(ACCOUNT)).toEqual({
      backedUpAt: at.toISOString(),
      fingerprint: FINGERPRINT,
    });
  });

  it('clears the mark on restore', async () => {
    await recordBackup(ACCOUNT, FINGERPRINT);
    await clearBackupRecord(ACCOUNT);

    expect(await loadRecoveryState(ACCOUNT)).toEqual({ backedUpAt: null, fingerprint: null });
  });

  /**
   * Not a secret, but it goes through the same seal as everything else rather
   * than becoming the one store written in the clear — which is how a store
   * that later grows a sensitive field ends up unprotected.
   */
  it('is sealed on disk like every other store', async () => {
    await recordBackup(ACCOUNT, FINGERPRINT);

    expect(SEALED_STORE_KEYS).toContain(RECOVERY_STORE_KEY);
    expect(await AsyncStorage.getItem(scopedKey(RECOVERY_STORE_KEY, ACCOUNT))).toMatch(/^CMSEAL1\./);
  });

  /**
   * The whole point of scoping: one account's backup mark must not answer for
   * another's. Without it, connecting a second mailbox would show it as already
   * backed up — the one false reassurance that costs a user their mail.
   */
  it('keeps each account to itself', async () => {
    await recordBackup(ACCOUNT, FINGERPRINT);

    expect(await loadRecoveryState(OTHER_ACCOUNT)).toEqual({ backedUpAt: null, fingerprint: null });
  });

  describe('needsBackup', () => {
    it('warns when the key has never been backed up', async () => {
      expect(needsBackup(await loadRecoveryState(ACCOUNT), FINGERPRINT)).toBe(true);
    });

    it('stops warning once this key is backed up', async () => {
      const state = await recordBackup(ACCOUNT, FINGERPRINT);

      expect(needsBackup(state, FINGERPRINT)).toBe(false);
    });

    /**
     * The case that makes the fingerprint worth storing. A device that backed
     * up one identity and now holds another has no backup of the key it is
     * actually using, and a stale "backed up" mark would say otherwise.
     */
    it('warns again when the identity changed since the backup', async () => {
      const state = await recordBackup(ACCOUNT, OTHER);

      expect(needsBackup(state, FINGERPRINT)).toBe(true);
    });

    it('says nothing when there is no identity yet', async () => {
      expect(needsBackup(await loadRecoveryState(ACCOUNT), null)).toBe(false);
    });
  });
});
