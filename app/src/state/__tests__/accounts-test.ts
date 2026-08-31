/**
 * Two mailboxes on one device — the property the whole feature exists for.
 *
 * The tests are written against the *real* service graph and the *real* stores,
 * not against `accounts.ts` in isolation, because the failure mode this guards
 * is not a wrong return value. It is a store that was keyed globally, quietly
 * handing the second account the first one's keyring, drafts or search index.
 * Only an end-to-end sign-in / switch / read can show that has not happened.
 *
 * Demo mode is what makes it runnable: `demoAuth` connects a second mailbox
 * with no network and no credential, which is exactly why `DEMO_ADDRESSES` has
 * two entries.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { accountIdFor } from '../../store/accountScope';
import { DRAFTS_STORE_KEY, loadDrafts } from '../../store/draftsStore';
import { KEYRING_STORE_KEY, loadKeyring } from '../../store/keyring';
import { scopedKey } from '../../store/accountScope';
import { DEMO_ADDRESSES } from '../../mail/demoMail';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { State } from '../types';

// Reached through `config.ts`; a native module with no binary under jest.
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

// `expo-secure-store` is likewise native. Reporting it unavailable sends
// `initStorage` down its documented web path — the device key beside the data —
// which is the right shape for a test and changes nothing under test here.
jest.mock('expo-secure-store', () => ({ isAvailableAsync: async () => false }));

const [FIRST, SECOND] = DEMO_ADDRESSES;
const ONE = accountIdFor('demo', FIRST);
const TWO = accountIdFor('demo', SECOND);

function harness() {
  let state: State = initialState();
  const store = createStore(state, (next) => {
    state = next;
  });
  const { services } = createServices(store);
  return { services, get: () => store.get() };
}

/** Sign in twice: `auth.signIn` adds a mailbox rather than replacing one. */
async function connectBoth(h: ReturnType<typeof harness>) {
  await h.services.session.boot(() => false);
  await h.services.session.signIn();
  await h.services.session.signIn();
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.resetModules();
});

describe('connecting a second mailbox', () => {
  it('keeps both, with the newest in front', async () => {
    const h = harness();
    await connectBoth(h);

    expect(h.get().accounts.map((a) => a.id)).toEqual([ONE, TWO]);
    expect(h.get().activeAccount).toBe(TWO);
    expect(h.get().session?.email).toBe(SECOND);
  });

  it('loads the second account with its own, separate stores', async () => {
    const h = harness();
    await connectBoth(h);

    await h.services.drafts.saveDraft({
      id: 'd-two',
      to: ['someone@example.com'],
      subject: 'from the work account',
      body: '',
      updatedAt: new Date().toISOString(),
    });

    expect(await loadDrafts(TWO)).toHaveProperty('d-two');
    expect(await loadDrafts(ONE)).toEqual({});
  });
});

describe('switching', () => {
  it('swaps in the other account and does not carry the first one over', async () => {
    const h = harness();
    await connectBoth(h);

    await h.services.drafts.saveDraft({
      id: 'work-draft',
      to: [],
      subject: 'work',
      body: '',
      updatedAt: new Date().toISOString(),
    });
    await h.services.accounts.switchAccount(ONE);

    expect(h.get().activeAccount).toBe(ONE);
    expect(h.get().session?.email).toBe(FIRST);
    expect(h.get().drafts).toEqual({});
  });

  /**
   * The keyring is the one that would matter most. A contact trusted in one
   * mailbox must not be trusted in the other: trust is a decision made against
   * an identity, and the two accounts have different ones.
   */
  it('shows each account only its own keyring', async () => {
    const h = harness();
    await connectBoth(h);

    // Committed rather than imported: `importKey` parses the armor, and what is
    // under test is where the keyring is *written*, not whether a key is valid.
    await h.services.contacts.commitKeyring({
      ...h.get().keyring,
      'work-only@example.com': {
        email: 'work-only@example.com',
        fingerprint: 'ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234',
        armored: 'armored-public-key',
        trust: 'verified',
        source: 'manual',
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(h.get().keyring).toHaveProperty(['work-only@example.com']);

    await h.services.accounts.switchAccount(ONE);
    expect(h.get().keyring).not.toHaveProperty(['work-only@example.com']);
    expect(await loadKeyring(ONE)).not.toHaveProperty(['work-only@example.com']);
    expect(await loadKeyring(TWO)).toHaveProperty(['work-only@example.com']);
  });

  it('writes each account under its own storage key', async () => {
    const h = harness();
    await connectBoth(h);

    expect(await AsyncStorage.getItem(scopedKey(KEYRING_STORE_KEY, ONE))).not.toBeNull();
    expect(await AsyncStorage.getItem(KEYRING_STORE_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(DRAFTS_STORE_KEY)).toBeNull();
  });

  it('reopens the account that was in front, not whichever restored last', async () => {
    const first = harness();
    await connectBoth(first);
    await first.services.accounts.switchAccount(ONE);

    const relaunched = harness();
    await relaunched.services.session.boot(() => false);

    expect(relaunched.get().activeAccount).toBe(ONE);
    expect(relaunched.get().accounts).toHaveLength(2);
  });
});

describe('removing an account', () => {
  it('erases its stores and falls back to the other one', async () => {
    const h = harness();
    await connectBoth(h);
    await h.services.drafts.saveDraft({
      id: 'gone',
      to: [],
      subject: 'gone',
      body: '',
      updatedAt: new Date().toISOString(),
    });

    await h.services.accounts.removeAccount(TWO);

    expect(h.get().activeAccount).toBe(ONE);
    expect(h.get().accounts.map((a) => a.id)).toEqual([ONE]);
    expect(await loadDrafts(TWO)).toEqual({});
  });
});

describe('the merged inbox', () => {
  it('lists both mailboxes, each row tagged with where it came from', async () => {
    const h = harness();
    await connectBoth(h);

    await h.services.accounts.setUnified(true);
    const accounts = new Set(h.get().messages.map((m) => m.account));

    expect(accounts).toEqual(new Set([ONE, TWO]));
  });

  /**
   * Merging is a *reading* convenience. Exactly one account stays active, so
   * composing and decrypting still have one identity and one keyring — which is
   * what stops a merged view from being a leak.
   */
  it('leaves exactly one account active', async () => {
    const h = harness();
    await connectBoth(h);
    await h.services.accounts.setUnified(true);

    expect(h.get().activeAccount).toBe(TWO);
    expect(h.get().session?.email).toBe(SECOND);
  });

  it('switches to the account a row belongs to before opening it', async () => {
    const h = harness();
    await connectBoth(h);
    await h.services.accounts.setUnified(true);

    const other = h.get().messages.find((m) => m.account === ONE);
    await h.services.mailbox.openMessage(other!);

    expect(h.get().activeAccount).toBe(ONE);
  });
});
