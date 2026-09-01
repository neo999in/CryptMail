/**
 * Paging the inbox backwards.
 *
 * Before this existed the app asked each mailbox for its newest 20 messages and
 * nothing else, so a mailbox older than one page could never show its older
 * mail — no amount of refreshing reached it. These pin the three things that
 * makes true:
 *
 * - a refresh starts from the newest page again, forgetting where paging got to;
 * - "load older" *appends* rather than replacing, and asks the provider for the
 *   page behind the last one using the cursor it handed back;
 * - a mailbox that returns no cursor is finished, and is not asked again — which
 *   is what stops an exhausted list from re-fetching its newest page forever.
 */
import { MailPage, MailClient, MailSummary } from '../../mail/types';
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

/** `n` messages, newest first, dated a day apart, starting `from` days back. */
function rows(prefix: string, n: number, from = 0): MailSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    from: { address: 'someone@example.com' },
    to: ['me@example.com'],
    date: new Date(Date.UTC(2026, 0, 100 - from - i)).toISOString(),
    subject: `${prefix} ${i}`,
    snippet: 'Body text.',
    unread: false,
    starred: false,
  }));
}

/**
 * A mailbox two pages deep, recording exactly what it was asked for.
 *
 * The second page carries no `nextPageToken`, which is a provider saying it has
 * handed over its oldest message.
 */
function pagedClient() {
  const asked: (string | undefined)[] = [];
  const pages: Record<string, MailPage> = {
    first: { messages: rows('new', 2), nextPageToken: 'p2' },
    p2: { messages: rows('old', 2, 2) },
  };
  const client: MailClient = {
    kind: 'gmail',
    address: 'me@example.com',
    async list(box, { pageToken } = {}) {
      if (box !== 'inbox') return { messages: [] };
      asked.push(pageToken);
      return pages[pageToken ?? 'first'];
    },
    getRaw: async () => '',
    send: async () => {},
    updateFlags: async () => {},
  };
  return { client, asked };
}

function harness(over: Partial<State> = {}) {
  const store = createStore(
    {
      ...initialState(),
      booting: false,
      session: { provider: 'gmail', email: 'me@example.com', accessToken: 't', expiresAt: Date.now() + 3_600_000 },
      accounts: [{ id: ACCOUNT, provider: 'gmail', email: 'me@example.com' }],
      activeAccount: ACCOUNT,
      ...over,
    },
    () => {},
  );
  const { services, mail } = createServices(store);
  const { client, asked } = pagedClient();
  mail.current = client;
  mail.clients.set(ACCOUNT, client);
  return { store, services, asked };
}

it('loads the newest page on a sync, and reports there is more behind it', async () => {
  const { store, services, asked } = harness();

  await services.mailbox.refreshInbox();

  expect(asked).toEqual([undefined]);
  expect(store.get().messages.map((m) => m.id)).toEqual(['new-0', 'new-1']);
  expect(store.get().canLoadMore).toBe(true);
});

it('appends the page behind it, asking with the cursor the provider gave', async () => {
  const { store, services, asked } = harness();

  await services.mailbox.refreshInbox();
  await services.mailbox.loadMoreInbox();

  expect(asked).toEqual([undefined, 'p2']);
  // Newest first, and the older page really is on the list rather than having
  // replaced it — the bug this whole path exists to fix.
  expect(store.get().messages.map((m) => m.id)).toEqual(['new-0', 'new-1', 'old-0', 'old-1']);
  expect(store.get().loadingMore).toBe(false);
});

it('stops asking once a mailbox returns no cursor', async () => {
  const { store, services, asked } = harness();

  await services.mailbox.refreshInbox();
  await services.mailbox.loadMoreInbox();
  expect(store.get().canLoadMore).toBe(false);

  await services.mailbox.loadMoreInbox();

  expect(asked).toEqual([undefined, 'p2']);
});

it('starts from the newest page again on a refresh', async () => {
  const { store, services, asked } = harness();

  await services.mailbox.refreshInbox();
  await services.mailbox.loadMoreInbox();
  await services.mailbox.refreshInbox();

  expect(asked).toEqual([undefined, 'p2', undefined]);
  expect(store.get().messages.map((m) => m.id)).toEqual(['new-0', 'new-1']);
  expect(store.get().canLoadMore).toBe(true);
});

it('does not list the same message twice when a page overlaps what is on screen', async () => {
  const { store, services } = harness();
  await services.mailbox.refreshInbox();
  // Mail arriving between two pages shifts everything down, so a provider can
  // hand back a row that is already listed.
  store.patch({ messages: [...store.get().messages, { ...rows('old', 1, 2)[0], account: ACCOUNT }] });

  await services.mailbox.loadMoreInbox();

  const ids = store.get().messages.map((m) => m.id);
  expect(ids.filter((id) => id === 'old-0')).toHaveLength(1);
});
