/**
 * Whose sync is it — and therefore whether a spinner is right.
 *
 * The app syncs for several reasons the user did not ask for: a list mounting,
 * a launch, an account arriving, the refresh that follows a send. All of those
 * used to raise the same pull-to-refresh spinner as a deliberate pull, which put
 * a loader over mail that was already on screen. Once the inbox paints from its
 * cache on the first frame, that is every launch.
 *
 * So `refreshingInbox` — and a box's `refreshing` — answer a *gesture* and
 * nothing else, while `loadingInbox` still means "a sync is running" for the
 * things that legitimately care: the skeleton and the empty state, which are
 * about having nothing to show and are right to appear whoever asked.
 *
 * The in-flight observations below are taken while the provider is parked,
 * because that is the only moment either flag is true: `store.patch` is
 * synchronous, so a resolved refresh has already cleared them.
 */
import { MailClient, MailSummary } from '../../mail/types';
import { accountIdFor } from '../../store/accountScope';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { State } from '../types';

const ACCOUNT = accountIdFor('gmail', 'me@example.com');

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

jest.mock('../../store/searchIndex', () => ({
  ...jest.requireActual('../../store/searchIndex'),
  saveSearchIndex: jest.fn(async () => {}),
  loadSearchIndex: jest.fn(async () => ({})),
}));

jest.mock('../../store/keyring', () => ({
  ...jest.requireActual('../../store/keyring'),
  saveKeyring: jest.fn(async () => {}),
  loadKeyring: jest.fn(async () => ({})),
}));

jest.mock('../../store/mailCacheStore', () => ({
  ...jest.requireActual('../../store/mailCacheStore'),
  saveMailCache: jest.fn(async () => {}),
  loadMailCache: jest.fn(async () => ({ messages: [], boxes: {} })),
}));

const row = (id: string): MailSummary => ({
  id,
  from: { address: 'someone@example.com' },
  to: ['me@example.com'],
  date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  subject: id,
  snippet: 'Body text.',
  unread: false,
  starred: false,
});

const base = {
  kind: 'gmail',
  address: 'me@example.com',
  getRaw: async () => '',
  send: async () => {},
  updateFlags: async () => {},
} satisfies Omit<MailClient, 'list'>;

/**
 * A provider parked mid-list until released, so the in-flight state can be read.
 * Without this there is no moment to observe — the flags are set and cleared
 * within one synchronous run.
 */
function parkedClient() {
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: MailClient = {
    ...base,
    async list(box) {
      await parked;
      return { messages: box === 'spam' ? [] : [row(`${box}-1`)] };
    },
  };
  return { client, release: () => release() };
}

/** One that refuses outright, for the failure paths. */
const refusingClient: MailClient = {
  ...base,
  list: async () => {
    throw new Error('offline');
  },
};

function harness(client: MailClient) {
  const store = createStore(
    {
      ...initialState(),
      booting: false,
      session: {
        provider: 'gmail',
        email: 'me@example.com',
        accessToken: 't',
        expiresAt: Date.now() + 3_600_000,
      },
      accounts: [{ id: ACCOUNT, provider: 'gmail', email: 'me@example.com' }],
      activeAccount: ACCOUNT,
    } as State,
    () => {},
  );
  const { services, mail } = createServices(store);
  mail.current = client;
  mail.clients.set(ACCOUNT, client);
  return { store, services };
}

describe('the inbox', () => {
  it('raises no spinner for a sync nobody asked for', async () => {
    const { client, release } = parkedClient();
    const { store, services } = harness(client);

    const inFlight = services.mailbox.refreshInbox();
    expect(store.get().refreshingInbox).toBe(false);
    // Still a sync, and still says so — this is what the skeleton reads.
    expect(store.get().loadingInbox).toBe(true);

    release();
    await inFlight;
  });

  it('raises one for a pull the user made, and lowers it when the sync lands', async () => {
    const { client, release } = parkedClient();
    const { store, services } = harness(client);

    const inFlight = services.mailbox.refreshInbox({ manual: true });
    expect(store.get().refreshingInbox).toBe(true);

    release();
    await inFlight;
    expect(store.get().refreshingInbox).toBe(false);
    expect(store.get().messages.map((m) => m.id)).toEqual(['inbox-1']);
  });

  /**
   * A sync that started first and lands last must not paint over a newer one —
   * that is how an undone archive came back and then vanished again.
   */
  it('drops a sync that a newer one overtook', async () => {
    const releases: Array<(ids: string[]) => void> = [];
    const client: MailClient = {
      ...base,
      list: (box) =>
        box === 'spam'
          ? Promise.resolve({ messages: [] })
          : new Promise((resolve) => releases.push((ids) => resolve({ messages: ids.map(row) }))),
    };
    const { store, services } = harness(client);

    const older = services.mailbox.refreshInbox();
    const newer = services.mailbox.refreshInbox();
    releases[1](['restored', 'kept']);
    await newer;
    releases[0](['kept']);
    await older;

    expect(store.get().messages.map((m) => m.id).sort()).toEqual(['kept', 'restored']);
  });

  /** A spinner left spinning is worse than no spinner, so a failure clears it. */
  it('lowers it again when the sync fails', async () => {
    const { store, services } = harness(refusingClient);

    await services.mailbox.refreshInbox({ manual: true });

    expect(store.get().refreshingInbox).toBe(false);
    expect(store.get().loadingInbox).toBe(false);
    expect(store.get().error).toBe('Offline.');
  });
});

describe('a secondary box', () => {
  it('raises no spinner on the load its screen runs when it mounts', async () => {
    const { client, release } = parkedClient();
    const { store, services } = harness(client);

    const inFlight = services.mailbox.loadBox('archive');
    expect(store.get().boxes.archive.refreshing).toBe(false);
    expect(store.get().boxes.archive.loading).toBe(true);

    release();
    await inFlight;
  });

  it('raises one for a pull, and lowers it when the load lands', async () => {
    const { client, release } = parkedClient();
    const { store, services } = harness(client);

    const inFlight = services.mailbox.loadBox('archive', { manual: true });
    expect(store.get().boxes.archive.refreshing).toBe(true);

    release();
    await inFlight;
    expect(store.get().boxes.archive.refreshing).toBe(false);
    expect(store.get().boxes.archive.items.map((m) => m.id)).toEqual(['archive-1']);
  });

  it('lowers it again when the load fails', async () => {
    const { store, services } = harness(refusingClient);

    await services.mailbox.loadBox('archive', { manual: true });

    expect(store.get().boxes.archive.refreshing).toBe(false);
    expect(store.get().boxes.archive.error).toBe('Offline.');
  });

  /** One box's pull must not put a spinner on its siblings. */
  it('keeps its spinner to itself', async () => {
    const { client, release } = parkedClient();
    const { store, services } = harness(client);

    const inFlight = services.mailbox.loadBox('archive', { manual: true });
    expect(store.get().boxes.sent.refreshing).toBe(false);
    expect(store.get().boxes.trash.refreshing).toBe(false);

    release();
    await inFlight;
  });
});

/**
 * Arriving at a destination should not re-ask the provider for a list it just
 * fetched. This is what made switching slow: every mount was a round trip whose
 * answer was already in state and already on screen.
 *
 * `ifStale` is deliberately the *only* thing that skips. Anything the user does
 * to ask for mail — and anything the app does after changing it — still fetches.
 */
describe('the staleness gate', () => {
  /** A provider that counts how many times it was actually asked. */
  function countingClient() {
    let calls = 0;
    const client: MailClient = {
      ...base,
      async list(box) {
        calls += 1;
        return { messages: box === 'spam' ? [] : [row(`${box}-1`)] };
      },
    };
    return { client, calls: () => calls };
  }

  it('fetches the first time a box is arrived at', async () => {
    const { client, calls } = countingClient();
    const { services } = harness(client);

    await services.mailbox.loadBox('archive', { ifStale: true });

    expect(calls()).toBe(1);
  });

  it('does not fetch again when the box is arrived at a moment later', async () => {
    const { client, calls } = countingClient();
    const { services } = harness(client);

    await services.mailbox.loadBox('archive', { ifStale: true });
    await services.mailbox.loadBox('archive', { ifStale: true });
    await services.mailbox.loadBox('archive', { ifStale: true });

    expect(calls()).toBe(1);
  });

  it('still fetches when the user asks, however recent the last one was', async () => {
    const { client, calls } = countingClient();
    const { services } = harness(client);

    await services.mailbox.loadBox('archive', { ifStale: true });
    await services.mailbox.loadBox('archive', { manual: true });

    expect(calls()).toBe(2);
  });

  it('fetches unconditionally for a caller that passes nothing', async () => {
    const { client, calls } = countingClient();
    const { services } = harness(client);

    await services.mailbox.loadBox('archive', { ifStale: true });
    // A send, a boot, an account arriving — none of them may be answered from
    // memory, because each of them is a reason the list has changed.
    await services.mailbox.loadBox('archive');

    expect(calls()).toBe(2);
  });

  it('keeps one box’s freshness out of another’s', async () => {
    const { client, calls } = countingClient();
    const { services } = harness(client);

    await services.mailbox.loadBox('archive', { ifStale: true });
    await services.mailbox.loadBox('sent', { ifStale: true });

    expect(calls()).toBe(2);
  });

  it('applies to the inbox too, and the junk page with it', async () => {
    const { client, calls } = countingClient();
    const { services } = harness(client);

    // One sync lists the inbox and the junk folder, so two calls.
    await services.mailbox.refreshInbox({ ifStale: true });
    expect(calls()).toBe(2);

    await services.mailbox.refreshInbox({ ifStale: true });
    expect(calls()).toBe(2);

    await services.mailbox.refreshInbox({ manual: true });
    expect(calls()).toBe(4);
  });
});
