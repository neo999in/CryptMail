/**
 * Sent and Archive as their own lists.
 *
 * The point of these is that a mailbox screen is not a view over the inbox. Three
 * things have to hold, and each of them is a way the cheap implementation goes
 * wrong:
 *
 * - each box asks the provider for **itself**, so Sent shows sent mail rather
 *   than whatever inbox rows happen to be loaded;
 * - each box pages on **its own cursor**, so reaching the bottom of Sent does not
 *   move where the inbox was paged to, and vice versa;
 * - the boxes are the **active account's**, even when the inbox is merged —
 *   mixing two accounts' sent mail would misstate which mailbox a message left
 *   from.
 */
import { Mailbox, MailClient, MailSummary } from '../../mail/types';
import { accountIdFor } from '../../store/accountScope';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { State } from '../types';

const ACCOUNT = accountIdFor('gmail', 'me@example.com');
const OTHER = accountIdFor('gmail', 'work@example.com');

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

function row(id: string, day: number): MailSummary {
  return {
    id,
    from: { address: 'someone@example.com' },
    to: ['them@example.com'],
    date: new Date(Date.UTC(2026, 0, day)).toISOString(),
    subject: id,
    snippet: 'Body text.',
    unread: false,
    starred: false,
  };
}

/** A client whose every box is two pages deep, recording what each was asked. */
function client(address: string) {
  const asked: { box: Mailbox; pageToken?: string }[] = [];
  const impl: MailClient = {
    kind: 'gmail',
    address,
    async list(box, { pageToken } = {}) {
      asked.push({ box, pageToken });
      const tag = `${box}-${address}`;
      return pageToken
        ? { messages: [row(`${tag}-old`, 1)] }
        : { messages: [row(`${tag}-new`, 9)], nextPageToken: 'p2' };
    },
    getRaw: async () => '',
    send: async () => {},
    updateFlags: async () => {},
  };
  return { impl, asked };
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
  const mine = client('me@example.com');
  mail.current = mine.impl;
  mail.clients.set(ACCOUNT, mine.impl);
  return { store, services, asked: mine.asked, mail };
}

it('asks the provider for the box itself, not for the inbox', async () => {
  const { store, services, asked } = harness();

  await services.mailbox.loadBox('sent');

  expect(asked).toEqual([{ box: 'sent', pageToken: undefined }]);
  expect(store.get().boxes.sent.items.map((m) => m.id)).toEqual(['sent-me@example.com-new']);
  // The inbox is untouched: opening Sent is not a sync.
  expect(store.get().messages).toEqual([]);
});

it('pages each box on its own cursor', async () => {
  const { store, services, asked } = harness();

  await services.mailbox.loadBox('sent');
  await services.mailbox.loadBox('archive');
  await services.mailbox.loadMoreBox('sent');

  // Archive's page-one request did not consume Sent's cursor.
  expect(asked).toEqual([
    { box: 'sent', pageToken: undefined },
    { box: 'archive', pageToken: undefined },
    { box: 'sent', pageToken: 'p2' },
  ]);
  expect(store.get().boxes.sent.items.map((m) => m.id)).toEqual([
    'sent-me@example.com-new',
    'sent-me@example.com-old',
  ]);
  // Appended, not replaced — and Archive still holds only its own first page.
  expect(store.get().boxes.archive.items.map((m) => m.id)).toEqual(['archive-me@example.com-new']);
});

it('stops paging a box once the provider returns no cursor', async () => {
  const { store, services, asked } = harness();

  await services.mailbox.loadBox('sent');
  await services.mailbox.loadMoreBox('sent');
  expect(store.get().boxes.sent.canLoadMore).toBe(false);

  await services.mailbox.loadMoreBox('sent');

  expect(asked).toHaveLength(2);
});

it('lists the active account only, even while the inbox is merged', async () => {
  const { store, services, mail } = harness({ unified: true });
  const other = client('work@example.com');
  mail.clients.set(OTHER, other.impl);

  await services.mailbox.loadBox('sent');

  expect(other.asked).toEqual([]);
  expect(store.get().boxes.sent.items.every((m) => m.account === ACCOUNT)).toBe(true);
});

it('reports a failure on the box that failed, leaving the other alone', async () => {
  const { store, services, mail } = harness();
  mail.current = {
    ...mail.current!,
    list: async () => {
      throw new Error('Gmail 500: upstream');
    },
  };

  await services.mailbox.loadBox('archive');

  expect(store.get().boxes.archive.error).toContain('Gmail 500');
  expect(store.get().boxes.archive.loading).toBe(false);
  expect(store.get().boxes.sent.error).toBeNull();
});
