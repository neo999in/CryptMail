import AsyncStorage from '@react-native-async-storage/async-storage';

import { createSnooze } from '../snooze';
import { createStore, initialState } from '../store';
import { Ctx, Services } from '../contracts';

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

jest.mock('../../keys', () => ({
  directory: { listedAt: 'the test directory' },
}));

describe('snooze service', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  function setup() {
    let state = initialState();
    const store = createStore(state, (next) => {
      state = next;
    });
    const services = {} as Services;
    const ctx: Ctx = {
      store,
      mail: { current: null },
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

    // Verified in storage
    const raw = await AsyncStorage.getItem('cryptmail.snooze.v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed['msg-42'].until).toBe(futureTime);
  });

  it('unsnoozeMessage removes entry from state and storage', async () => {
    const { store, snooze } = setup();
    const futureTime = new Date(Date.now() + 3600_000).toISOString();

    await snooze.snoozeMessage('msg-42', futureTime);
    expect(store.get().snoozed['msg-42']).toBeDefined();

    await snooze.unsnoozeMessage('msg-42');
    expect(store.get().snoozed['msg-42']).toBeUndefined();

    const raw = await AsyncStorage.getItem('cryptmail.snooze.v1');
    const parsed = JSON.parse(raw!);
    expect(parsed['msg-42']).toBeUndefined();
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
    await AsyncStorage.setItem('cryptmail.snooze.v1', JSON.stringify(seeded));

    const { store, snooze } = setup();
    expect(store.get().snoozed).toEqual({});

    await snooze.loadSnoozes();
    expect(store.get().snoozed['msg-10']).toEqual(seeded['msg-10']);
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
