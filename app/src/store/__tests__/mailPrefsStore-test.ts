/**
 * The swipe preferences.
 *
 * Two properties matter here and neither is about storage mechanics:
 *
 *  - a fresh install swipes **Archive on the left and nothing on the right**,
 *    because every other action moves or re-files mail and nobody should meet
 *    one they did not ask for;
 *  - the two sides are independent, on disk as well as on screen — setting one
 *    must not disturb the other, whichever order they are written in.
 *
 * The round-trips go through the real sealed store, so they also prove the
 * preference survives being written and read back rather than only being
 * normalised correctly in memory.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { initLocalCrypto, resetLocalCryptoForTests, SecretStore } from '../localCrypto';
import {
  DEFAULT_MAIL_PREFS,
  loadMailPrefs,
  MAIL_PREFS_STORE_KEY,
  normaliseMailPrefs,
  saveMailPrefs,
} from '../mailPrefsStore';
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

describe('the defaults', () => {
  it('archives on the left and does nothing on the right', () => {
    expect(DEFAULT_MAIL_PREFS).toEqual({ swipeLeft: 'archive', swipeRight: 'none' });
  });

  it('is what a device with nothing stored reads', async () => {
    expect(await loadMailPrefs()).toEqual(DEFAULT_MAIL_PREFS);
  });
});

describe('normaliseMailPrefs', () => {
  it('returns the defaults for a missing store', () => {
    expect(normaliseMailPrefs(null)).toEqual(DEFAULT_MAIL_PREFS);
    expect(normaliseMailPrefs(undefined)).toEqual(DEFAULT_MAIL_PREFS);
  });

  it('keeps a fully valid stored value', () => {
    const stored = { swipeLeft: 'trash', swipeRight: 'read' } as const;

    expect(normaliseMailPrefs(stored)).toEqual(stored);
  });

  /**
   * An action a newer build understands and this one does not. The side falls
   * back to *its own* default rather than to `none`, so a left side that was
   * Archive in a fresh install is Archive again instead of going dead.
   */
  it('falls back per side, and to that side’s default', () => {
    const prefs = normaliseMailPrefs({ swipeLeft: 'teleport' as never, swipeRight: 'snooze' });

    expect(prefs).toEqual({ swipeLeft: 'archive', swipeRight: 'snooze' });
  });

  it('leaves a good side alone when the other is unreadable', () => {
    expect(normaliseMailPrefs({ swipeLeft: 'read', swipeRight: 42 as never })).toEqual({
      swipeLeft: 'read',
      swipeRight: DEFAULT_MAIL_PREFS.swipeRight,
    });
  });

  it('is idempotent', () => {
    const once = normaliseMailPrefs({ swipeLeft: 'nonsense' as never, swipeRight: 'trash' });

    expect(normaliseMailPrefs(once)).toEqual(once);
  });
});

describe('what is stored', () => {
  it('survives a save and a reload', async () => {
    await saveMailPrefs({ swipeLeft: 'read', swipeRight: 'trash' });

    expect(await loadMailPrefs()).toEqual({ swipeLeft: 'read', swipeRight: 'trash' });
  });

  it('changes one side without touching the other, in either order', async () => {
    // Right first: the side that ships empty.
    const afterRight = await saveMailPrefs({ ...DEFAULT_MAIL_PREFS, swipeRight: 'trash' });
    expect(afterRight).toEqual({ swipeLeft: 'archive', swipeRight: 'trash' });

    // Then left, over the top of it. The right side must still be Delete.
    const afterLeft = await saveMailPrefs({ ...afterRight, swipeLeft: 'snooze' });
    expect(afterLeft).toEqual({ swipeLeft: 'snooze', swipeRight: 'trash' });
    expect(await loadMailPrefs()).toEqual({ swipeLeft: 'snooze', swipeRight: 'trash' });
  });

  it('refuses to write an action it could not read back', async () => {
    await saveMailPrefs({ swipeLeft: 'archive', swipeRight: 'wormhole' as never });

    expect(await loadMailPrefs()).toEqual(DEFAULT_MAIL_PREFS);
  });

  it('is sealed on disk like every other store', async () => {
    await saveMailPrefs({ swipeLeft: 'trash', swipeRight: 'none' });

    // Sealed, so the action names are not sitting in the clear.
    expect(await AsyncStorage.getItem(MAIL_PREFS_STORE_KEY)).not.toContain('trash');
    expect(SEALED_STORE_KEYS).toContain(MAIL_PREFS_STORE_KEY);
  });

  /**
   * A gesture belongs to the hand holding the device, not to a mailbox — so
   * this is a global store, and removing an account must leave it alone.
   */
  it('is not per-account', () => {
    expect(PER_ACCOUNT_STORE_KEYS).not.toContain(MAIL_PREFS_STORE_KEY);
  });
});
