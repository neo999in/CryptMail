/**
 * Moving a mailbox's encrypted mail to Trash, all of it.
 *
 * What has to hold, each a way the cheap version goes wrong:
 *
 * - "All" means the **whole mailbox** on the server — every page of Inbox,
 *   Sent and Archive — not the rows this device happened to load;
 * - only CryptMail's sealed mail is taken: plain mail stays, and so do the legs
 *   of a quantum link, which a link still being set up reads from the inbox;
 * - it is a **move**, the same `trashed: true` as a single delete, and rows
 *   leave the lists they were in — this mailbox's rows only, in a merged inbox;
 * - one refused move is counted, not fatal; a dead grant ends the sweep, and
 *   what had already moved still leaves the screen.
 */
import { AuthError } from '../../auth/types';
import { linkSubject } from '../../core/bb84';
import { PLACEHOLDER_SUBJECT } from '../../core/mime';
import { FlagPatch, Mailbox, MailClient, MailSummary } from '../../mail/types';
import { accountIdFor } from '../../store/accountScope';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { InboxItem, State } from '../types';

const ACCOUNT = accountIdFor('gmail', 'me@example.com');
const OTHER = accountIdFor('gmail', 'other@example.com');

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

function row(id: string, subject: string): MailSummary {
  return {
    id,
    from: { address: 'someone@example.com' },
    to: ['me@example.com'],
    date: '2026-01-09T10:00:00.000Z',
    subject,
    snippet: '',
    unread: false,
    starred: false,
  };
}

const sealed = (id: string) => row(id, PLACEHOLDER_SUBJECT);
const plain = (id: string) => row(id, `Hello ${id}`);
const tagged = (summary: MailSummary, account = ACCOUNT): InboxItem => ({ ...summary, account });

/**
 * A provider holding `folders`, served one row per page so a sweep that stops
 * after the first page is caught.
 */
function client(folders: Partial<Record<Mailbox, MailSummary[]>>, over: Partial<MailClient> = {}) {
  const flagged: { id: string; patch: FlagPatch }[] = [];
  const impl: MailClient = {
    kind: 'gmail',
    address: 'me@example.com',
    async list(box, options) {
      const all = folders[box] ?? [];
      const at = Number(options?.pageToken ?? 0);
      return { messages: all.slice(at, at + 1), nextPageToken: at + 1 < all.length ? String(at + 1) : undefined };
    },
    getRaw: async () => '',
    send: async () => {},
    async updateFlags(id, patch) {
      flagged.push({ id, patch });
    },
    ...over,
  };
  return { impl, flagged };
}

function harness(impl: MailClient, over: Partial<State> = {}) {
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
  mail.current = impl;
  mail.clients.set(ACCOUNT, impl);
  return { store, services };
}

it('finds every sealed message in Inbox, Sent and Archive, paging each to the end', async () => {
  const { impl } = client({
    inbox: [plain('p1'), sealed('e1'), sealed('e2')],
    sent: [sealed('e3'), plain('p2')],
    archive: [sealed('e4'), sealed('e1')],
    // Spam and Trash are not what the row says it sweeps.
    spam: [sealed('junk')],
    trash: [sealed('gone')],
  });
  const { services } = harness(impl);
  const progress: string[] = [];

  const found = await services.accounts.findEncrypted(ACCOUNT, {
    onProgress: (p) => progress.push(p.phase === 'listing' ? `${p.found}/${p.scanned}` : 'trashing'),
  });

  // e1 is listed twice and counted once.
  expect(found).toEqual(['e1', 'e2', 'e3', 'e4']);
  expect(progress[progress.length - 1]).toBe('4/6');
});

it('leaves quantum-link legs alone', async () => {
  const { impl } = client({ inbox: [row('leg', linkSubject('photons')), sealed('e1')] });
  const { services } = harness(impl);

  expect(await services.accounts.findEncrypted(ACCOUNT)).toEqual(['e1']);
});

it('moves each one to Trash and takes it off the lists it was in', async () => {
  const { impl, flagged } = client({});
  const { store, services } = harness(impl, {
    messages: [tagged(sealed('e1')), tagged(plain('p1'))],
  });
  store.patch({ boxes: { ...store.get().boxes, sent: { ...store.get().boxes.sent, items: [tagged(sealed('e2'))] } } });

  const result = await services.accounts.trashEncrypted(ACCOUNT, ['e1', 'e2']);

  expect(result).toEqual({ moved: 2, failed: 0 });
  expect(flagged).toEqual([
    { id: 'e1', patch: { trashed: true } },
    { id: 'e2', patch: { trashed: true } },
  ]);
  expect(store.get().messages.map((m) => m.id)).toEqual(['p1']);
  expect(store.get().boxes.sent.items).toEqual([]);
});

it('touches only this mailbox’s rows in a merged inbox', async () => {
  const { impl } = client({});
  const { store, services } = harness(impl, {
    unified: true,
    messages: [tagged(sealed('same-id')), tagged(sealed('same-id'), OTHER)],
  });

  await services.accounts.trashEncrypted(ACCOUNT, ['same-id']);

  expect(store.get().messages.map((m) => m.account)).toEqual([OTHER]);
});

it('counts a move the provider refuses and carries on', async () => {
  const { impl } = client(
    {},
    {
      async updateFlags(id) {
        if (id === 'e2') throw new Error('Gmail 404: not found');
      },
    },
  );
  const { store, services } = harness(impl, { messages: [tagged(sealed('e1')), tagged(sealed('e2'))] });

  const result = await services.accounts.trashEncrypted(ACCOUNT, ['e1', 'e2']);

  expect(result).toEqual({ moved: 1, failed: 1 });
  // The one that did not move is still where it was.
  expect(store.get().messages.map((m) => m.id)).toEqual(['e2']);
});

it('stops on a dead grant, and what already moved still leaves the screen', async () => {
  const ids = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
  const { impl } = client(
    {},
    {
      async updateFlags(id) {
        if (id === 'e6') throw new AuthError('Sign in again.', 'reauth-required');
      },
    },
  );
  const { store, services } = harness(impl, { messages: ids.map((id) => tagged(sealed(id))) });

  await expect(services.accounts.trashEncrypted(ACCOUNT, ids)).rejects.toThrow(AuthError);

  // The first batch of five reached Trash before the second failed.
  expect(store.get().messages.map((m) => m.id)).toEqual(['e6']);
});

it('refuses a mailbox that is not syncing', async () => {
  const { impl } = client({});
  const { services } = harness(impl);

  await expect(services.accounts.findEncrypted(OTHER)).rejects.toThrow(/not syncing/i);
  await expect(services.accounts.trashEncrypted(OTHER, ['e1'])).rejects.toThrow(/not syncing/i);
});
