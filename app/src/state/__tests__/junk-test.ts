/**
 * The provider's junk folder, fetched alongside the inbox.
 *
 * This pins the defect that made the whole spam feature look broken against a real
 * account. Gmail moves a message it considers spam *out* of the inbox, and
 * `messages.list` hides SPAM from every result unless asked, so a client that
 * lists `INBOX` never sees junk at all — and the app's Junk destination, which
 * filters the list the inbox loaded, was therefore empty no matter how much spam
 * the account held. The engine was fine; nothing was ever handed to it.
 *
 * Five things have to hold:
 *
 * - a sync asks for the junk folder as well as the inbox, and merges both into one
 *   newest-first list;
 * - junk pages on **its own cursor**, so "load older mail" reaches older junk
 *   without disturbing where the inbox was paged to;
 * - a junk folder that cannot be listed is **not** a failed sync, while a failure
 *   to list the inbox still is;
 * - no key is learned from plaintext junk — a sync that harvested there would let
 *   anyone who can reach the junk folder seed this device's keyring;
 * - a key *is* still learned from encrypted junk, because the provider's verdict on
 *   ciphertext is not evidence of anything (`categorizer/categorizer.ts`).
 */
import { PLACEHOLDER_SUBJECT } from '../../core';
import { fakePublicKey } from '../../core/demoCore';
import { encodeUtf8Base64 } from '../../lib/base64';
import { MailClient, Mailbox, MailPage, MailSummary } from '../../mail/types';
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

const FINGERPRINT = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';

/** The header CryptMail itself emits: base64 of the armored key. */
const autocrypt = (address: string) =>
  `addr=${address}; prefer-encrypt=mutual; keydata=${encodeUtf8Base64(fakePublicKey(address, FINGERPRINT))}`;

function row(id: string, day: number, over: Partial<MailSummary> = {}): MailSummary {
  return {
    id,
    from: { address: 'someone@example.com' },
    to: ['me@example.com'],
    date: new Date(Date.UTC(2026, 0, day)).toISOString(),
    subject: id,
    snippet: 'Body text.',
    unread: false,
    starred: false,
    ...over,
  };
}

type Pages = Partial<Record<Mailbox, Record<string, MailPage>>>;

/** A provider whose every mailbox is its own page table, recording what it was asked. */
function client(pages: Pages, failing: Mailbox[] = []) {
  const asked: { box: Mailbox; pageToken?: string }[] = [];
  const impl: MailClient = {
    kind: 'gmail',
    address: 'me@example.com',
    async list(box, { pageToken } = {}) {
      asked.push({ box, pageToken });
      if (failing.includes(box)) throw new Error(`Gmail 403: ${box} cannot be listed`);
      return pages[box]?.[pageToken ?? 'first'] ?? { messages: [] };
    },
    getRaw: async () => '',
    send: async () => {},
    updateFlags: async () => {},
  };
  return { impl, asked };
}

function harness(pages: Pages, failing: Mailbox[] = [], over: Partial<State> = {}) {
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
  const { impl, asked } = client(pages, failing);
  mail.current = impl;
  mail.clients.set(ACCOUNT, impl);
  return { store, services, asked };
}

const ids = (list: { id: string }[]) => list.map((m) => m.id);

describe('a sync', () => {
  it('asks for the junk folder as well as the inbox', async () => {
    const { store, services, asked } = harness({
      inbox: { first: { messages: [row('inbox-1', 9)] } },
      spam: { first: { messages: [row('junk-1', 8)] } },
    });

    await services.mailbox.refreshInbox();

    expect(asked).toEqual([
      { box: 'inbox', pageToken: undefined },
      { box: 'spam', pageToken: undefined },
    ]);
    expect(ids(store.get().messages)).toEqual(['inbox-1', 'junk-1']);
  });

  it('merges the two into one newest-first list, not one appended to the other', async () => {
    const { store, services } = harness({
      inbox: { first: { messages: [row('inbox-old', 3)] } },
      spam: { first: { messages: [row('junk-new', 20)] } },
    });

    await services.mailbox.refreshInbox();

    expect(ids(store.get().messages)).toEqual(['junk-new', 'inbox-old']);
  });

  it('is not failed by a junk folder that cannot be listed', async () => {
    // A connector with no junk folder, or one that refuses it, is a legitimate
    // connector. The inbox is what the user asked for and it must still arrive.
    const { store, services } = harness({ inbox: { first: { messages: [row('inbox-1', 9)] } } }, ['spam']);

    await services.mailbox.refreshInbox();

    expect(ids(store.get().messages)).toEqual(['inbox-1']);
    expect(store.get().error).toBeNull();
    expect(store.get().loadingInbox).toBe(false);
  });

  it('still reports a failure to list the inbox itself', async () => {
    const { store, services } = harness({}, ['inbox']);

    await services.mailbox.refreshInbox();

    expect(store.get().error).toContain('Gmail 403');
  });
});

describe('paging', () => {
  it('pages junk on its own cursor, without disturbing the inbox', async () => {
    const { store, services, asked } = harness({
      inbox: {
        first: { messages: [row('inbox-new', 9)], nextPageToken: 'i2' },
        i2: { messages: [row('inbox-old', 2)] },
      },
      spam: {
        first: { messages: [row('junk-new', 8)], nextPageToken: 's2' },
        s2: { messages: [row('junk-old', 1)] },
      },
    });

    await services.mailbox.refreshInbox();
    await services.mailbox.loadMoreInbox();

    expect(asked).toEqual([
      { box: 'inbox', pageToken: undefined },
      { box: 'spam', pageToken: undefined },
      { box: 'inbox', pageToken: 'i2' },
      { box: 'spam', pageToken: 's2' },
    ]);
    // Appended rather than replaced, and interleaved by date rather than by which
    // mailbox they came from.
    expect(ids(store.get().messages)).toEqual(['inbox-new', 'junk-new', 'inbox-old', 'junk-old']);
    expect(store.get().canLoadMore).toBe(false);
  });

  it('keeps "load older mail" available while only the junk folder has more', async () => {
    const { store, services } = harness({
      inbox: { first: { messages: [row('inbox-1', 9)] } },
      spam: { first: { messages: [row('junk-1', 8)], nextPageToken: 's2' } },
    });

    await services.mailbox.refreshInbox();

    expect(store.get().canLoadMore).toBe(true);
  });

  it('stops asking for junk once the folder has handed over its oldest message', async () => {
    const { services, asked } = harness({
      inbox: { first: { messages: [row('inbox-1', 9)] } },
      spam: { first: { messages: [row('junk-1', 8)] } },
    });

    await services.mailbox.refreshInbox();
    await services.mailbox.loadMoreInbox();

    // Both mailboxes reported no cursor, so `canLoadMore` is false and the second
    // call returns without asking either of them again.
    expect(asked).toHaveLength(2);
  });
});

describe('keys are not learned from junk', () => {
  it('skips a plaintext junk sender, and still learns from the inbox', async () => {
    const { store, services } = harness({
      inbox: {
        first: {
          messages: [
            row('inbox-1', 9, { from: { address: 'friend@example.com' }, autocrypt: autocrypt('friend@example.com') }),
          ],
        },
      },
      spam: {
        first: {
          messages: [
            row('junk-1', 8, {
              from: { address: 'spammer@junk.example' },
              autocrypt: autocrypt('spammer@junk.example'),
              labels: ['SPAM'],
            }),
          ],
        },
      },
    });

    await services.mailbox.refreshInbox();

    expect(Object.keys(store.get().keyring)).toEqual(['friend@example.com']);
  });

  it('still learns from encrypted junk, where the verdict was about ciphertext', async () => {
    const { store, services } = harness({
      spam: {
        first: {
          messages: [
            row('junk-1', 8, {
              subject: PLACEHOLDER_SUBJECT,
              from: { address: 'sealed@example.com' },
              autocrypt: autocrypt('sealed@example.com'),
              labels: ['SPAM'],
            }),
          ],
        },
      },
    });

    await services.mailbox.refreshInbox();

    expect(store.get().keyring['sealed@example.com']?.fingerprint).toBe(FINGERPRINT);
  });
});
