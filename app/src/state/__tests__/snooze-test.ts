import AsyncStorage from '@react-native-async-storage/async-storage';

import { initLocalCrypto, resetLocalCryptoForTests, SecretStore } from '../../store/localCrypto';
import { loadSnoozes, saveSnoozes } from '../../store/snoozeStore';
import { createSnooze } from '../snooze';
import { createStore, initialState } from '../store';
import { Ctx, Services } from '../contracts';

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

jest.mock('../../keys', () => ({
  directory: { listedAt: 'the test directory' },
}));

/** The scoped store is sealed at rest, so the tests need a device key. */
function memoryStore(): SecretStore {
  const data: Record<string, string> = {};
  return {
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

/** The snooze map is scoped like every other mailbox store. */
const ACCOUNT = 'gmail:me@example.com';

describe('snooze service', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    resetLocalCryptoForTests();
    await initLocalCrypto(memoryStore(), 'keystore');
  });

  function setup() {
    let state = initialState();
    const store = createStore(state, (next) => {
      state = next;
    });
    const services = {} as Services;
    // The only sibling the snooze service reaches: every write is keyed on the
    // account, so there is one to require.
    services.accounts = { requireActive: () => ACCOUNT } as Services['accounts'];
    const ctx: Ctx = {
      store,
      mail: { current: null, clients: new Map() },
      services,
    };
    const snooze = createSnooze(ctx);
    services.snooze = snooze;
    return { store, snooze };
  }

  it('snoozes a message, persists to storage, and updates state', async () => {
    const { store, snooze } = setup();
    const futureTime = new Date(Date.now() + 3600_000).toISOString();

    await snooze.snoozeMessage('msg-42', futureTime);

    // Verified in state
    expect(store.get().snoozed['msg-42']).toBeDefined();
    expect(store.get().snoozed['msg-42'].until).toBe(futureTime);

    // Verified in storage, under this account's key
    const stored = await loadSnoozes(ACCOUNT);
    expect(stored['msg-42'].until).toBe(futureTime);
  });

  it('unsnoozeMessage removes entry from state and storage', async () => {
    const { store, snooze } = setup();
    const futureTime = new Date(Date.now() + 3600_000).toISOString();

    await snooze.snoozeMessage('msg-42', futureTime);
    expect(store.get().snoozed['msg-42']).toBeDefined();

    await snooze.unsnoozeMessage('msg-42');
    expect(store.get().snoozed['msg-42']).toBeUndefined();

    expect((await loadSnoozes(ACCOUNT))['msg-42']).toBeUndefined();
  });

  it('loadSnoozes restores persisted snoozes into store on boot', async () => {
    // Seed storage
    const seeded = {
      'msg-10': {
        id: 'msg-10',
        until: '2026-09-02T10:00:00.000Z',
        snoozedAt: '2026-09-01T10:00:00.000Z',
      },
    };
    await saveSnoozes(ACCOUNT, seeded);

    const { store, snooze } = setup();
    expect(store.get().snoozed).toEqual({});

    await snooze.loadSnoozes(ACCOUNT);
    expect(store.get().snoozed['msg-10']).toEqual(seeded['msg-10']);
  });

  /**
   * The Snoozed folder draws rows the inbox may no longer hold, so a snooze
   * keeps the envelope it was taken from — and keeps it across a re-snooze
   * made after that row has left the loaded page.
   */
  it('snapshots the summary from the inbox, and keeps it on a re-snooze', async () => {
    const { store, snooze } = setup();
    const summary = {
      id: 'msg-7',
      from: { address: 'a@example.com' },
      to: ['me@example.com'],
      date: '2026-09-01T10:00:00.000Z',
      subject: 'Hello',
      snippet: '',
      unread: true,
      starred: false,
      account: ACCOUNT,
    };
    store.patch({ messages: [summary] });
    const later = new Date(Date.now() + 3600_000).toISOString();

    await snooze.snoozeMessage('msg-7', later);
    expect(store.get().snoozed['msg-7'].summary).toEqual(summary);
    expect((await loadSnoozes(ACCOUNT))['msg-7'].summary).toEqual(summary);

    store.patch({ messages: [] });
    const evenLater = new Date(Date.now() + 7200_000).toISOString();
    await snooze.snoozeMessage('msg-7', evenLater);
    expect(store.get().snoozed['msg-7']).toMatchObject({ until: evenLater, summary });
  });

  it('writes no snapshot for a message it has never seen', async () => {
    const { store, snooze } = setup();
    await snooze.snoozeMessage('msg-unknown', new Date(Date.now() + 3600_000).toISOString());
    expect(store.get().snoozed['msg-unknown']).not.toHaveProperty('summary');
  });

  it('wakedue cleans up snoozes whose due time has passed', async () => {
    const { store, snooze } = setup();
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const futureTime = new Date(Date.now() + 3600_000).toISOString();

    await snooze.snoozeMessage('msg-due', pastTime);
    await snooze.snoozeMessage('msg-future', futureTime);

    expect(Object.keys(store.get().snoozed).length).toBe(2);

    await snooze.wakedue();

    // Due message is removed (resurfacing in inbox)
    expect(store.get().snoozed['msg-due']).toBeUndefined();
    // Future message remains snoozed
    expect(store.get().snoozed['msg-future']).toBeDefined();
  });
});
