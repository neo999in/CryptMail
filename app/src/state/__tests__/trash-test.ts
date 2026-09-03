/**
 * Trash: a mailbox, and a move in both directions.
 *
 * Three things have to hold, and each is a way the cheap implementation goes
 * wrong:
 *
 * - Trash is **fetched**, like Sent and Archive. A client that hid rows it had
 *   flagged locally would disagree with every other app on the account, and
 *   would show nothing for mail deleted anywhere else;
 * - deleting **reaches the provider** and takes the row out of the list it was
 *   deleted from, at once. Anything less leaves the message the reader just
 *   deleted sitting where they deleted it from until the next fetch;
 * - restoring works from a row that is **not in the inbox**. Trash is the only
 *   list a restore is ever made from, so a patch applied to `messages` alone
 *   would appear to do nothing.
 *
 * Nothing here erases mail. `trashed` is a move, both ways, and emptying the
 * trash stays the provider's own action — see `state/types.ts`.
 */
import { FlagPatch, Mailbox, MailClient, MailSummary } from '../../mail/types';
import { accountIdFor } from '../../store/accountScope';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { InboxItem, State } from '../types';

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

function row(id: string): MailSummary {
  return {
    id,
    from: { address: 'someone@example.com' },
    to: ['me@example.com'],
    date: '2026-01-09T10:00:00.000Z',
    subject: id,
    snippet: 'Body text.',
    unread: false,
    starred: false,
  };
}

const tagged = (id: string): InboxItem => ({ ...row(id), account: ACCOUNT });

/** A client that records what it was asked to list and to change. */
function client(over: Partial<MailClient> = {}) {
  const listed: Mailbox[] = [];
  const flagged: { id: string; patch: FlagPatch }[] = [];
  const impl: MailClient = {
    kind: 'gmail',
    address: 'me@example.com',
    async list(box) {
      listed.push(box);
      return { messages: [row(`${box}-row`)] };
    },
    getRaw: async () => '',
    send: async () => {},
    async updateFlags(id, patch) {
      flagged.push({ id, patch });
    },
    ...over,
  };
  return { impl, listed, flagged };
}

function harness(over: Partial<State> = {}, impl = client()) {
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
  mail.current = impl.impl;
  mail.clients.set(ACCOUNT, impl.impl);
  return { store, services, ...impl };
}

it('asks the provider for the trash mailbox itself', async () => {
  const { store, services, listed } = harness();

  await services.mailbox.loadBox('trash');

  expect(listed).toEqual(['trash']);
  expect(store.get().boxes.trash.items.map((m) => m.id)).toEqual(['trash-row']);
  // Deleted mail is not the inbox's business: opening Trash is not a sync.
  expect(store.get().messages).toEqual([]);
});

it('deletes from the inbox: the row leaves at once, and the move reaches the provider', async () => {
  const { store, services, flagged } = harness({ messages: [tagged('m1'), tagged('m2')] });

  await services.mailbox.trashMessage('m1');

  expect(flagged).toEqual([{ id: 'm1', patch: { trashed: true } }]);
  expect(store.get().messages.map((m) => m.id)).toEqual(['m2']);
});

it('restores a row that is in Trash and nowhere else', async () => {
  // The regression this exists for: before the state layer looked past
  // `messages`, a restore from Trash patched a list the row was not in, so the
  // provider was told and the screen was not.
  const { store, services, flagged } = harness();
  await services.mailbox.loadBox('trash');

  await services.mailbox.restoreMessage('trash-row');

  expect(flagged).toEqual([{ id: 'trash-row', patch: { trashed: false } }]);
  expect(store.get().boxes.trash.items).toEqual([]);
});

it('patches the one list the row is in, and leaves the others alone', async () => {
  const { store, services } = harness({ messages: [tagged('m1')] });
  await services.mailbox.loadBox('sent');

  await services.mailbox.trashMessage('sent-row');

  // A sent message that is deleted leaves Sent. The inbox never held it and is
  // not rewritten on its behalf.
  expect(store.get().boxes.sent.items).toEqual([]);
  expect(store.get().messages.map((m) => m.id)).toEqual(['m1']);
});

it('refetches the list it came from when the provider rejects the move', async () => {
  const impl = client({
    async updateFlags() {
      throw new Error('Gmail 500: upstream');
    },
  });
  const { services, listed } = harness({}, impl);
  await services.mailbox.loadBox('trash');

  await services.mailbox.restoreMessage('trash-row');
  // The catch refetches; let the refetch it kicked off settle.
  await new Promise<void>((resolve) => setImmediate(() => resolve()));

  // Asked twice: the row is put back on screen because the server still has it.
  expect(listed).toEqual(['trash', 'trash']);
});
