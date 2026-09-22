/**
 * Finding a recipient's key in mail they already sent us.
 *
 * The inbox sync harvests `Autocrypt` only from what it lists, so a contact
 * who last wrote before that window read as having no key. `discover` now
 * asks the mailbox for their mail first. What carries weight: only a message
 * whose `From` is exactly the address counts, junk is never searched, and a
 * search that failed is reported as "could not find out", not "no key".
 */
import { fakePublicKey } from '../../core/demoCore';
import { encodeUtf8Base64 } from '../../lib/base64';
import { MailClient, MailSummary, Mailbox } from '../../mail/types';
import { createServices } from '../services';
import { createStore, initialState } from '../store';

const mockLookup = jest.fn<Promise<{ armored: string } | null>, [string]>();

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

jest.mock('../../keys', () => ({
  ...jest.requireActual('../../keys/autocrypt'),
  directory: {
    listedAt: 'the test directory',
    lookup: (email: string) => mockLookup(email),
    publish: jest.fn(),
  },
}));

jest.mock('../../store/keyring', () => ({
  ...jest.requireActual('../../store/keyring'),
  saveKeyring: jest.fn(async () => {}),
  loadKeyring: jest.fn(async () => ({})),
}));

const ACCOUNT = 'gmail:me@example.com';
const BOB = 'bob@example.com';
const BOB_FP = '11112222333344445555666677778888AAAABBBB';

const header = (addr: string, armored: string) =>
  `addr=${addr}; prefer-encrypt=mutual; keydata=${encodeUtf8Base64(armored)}`;

const row = (from: string, autocrypt?: string): MailSummary =>
  ({
    id: `m-${Math.random()}`,
    threadId: 't',
    from: { address: from },
    to: ['me@example.com'],
    subject: 'hi',
    snippet: '',
    date: '2026-01-01T00:00:00.000Z',
    unread: false,
    starred: false,
    autocrypt,
  }) as MailSummary;

function harness(list: MailClient['list']) {
  const store = createStore(
    {
      ...initialState(),
      booting: false,
      session: { provider: 'gmail', email: 'me@example.com', accessToken: 't', expiresAt: Date.now() + 3_600_000 },
      accounts: [{ id: ACCOUNT, provider: 'gmail', email: 'me@example.com' }],
      activeAccount: ACCOUNT,
    },
    () => {},
  );
  const { services, mail } = createServices(store);
  mail.current = {
    kind: 'gmail',
    address: 'me@example.com',
    list,
    getRaw: async () => '',
    send: async () => {},
    updateFlags: async () => {},
  };
  return { store, services };
}

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue(null);
});

it('learns a key from the Autocrypt header of mail they sent, before asking the directory', async () => {
  const asked: { box: Mailbox; from?: string }[] = [];
  const { services } = harness(async (box, options) => {
    asked.push({ box, from: options?.from });
    return { messages: [row(BOB, header(BOB, fakePublicKey(BOB, BOB_FP)))] };
  });

  const [bob] = await services.contacts.discoverRecipients([BOB]);
  expect(bob.status).toBe('ok');
  expect(bob.key?.fingerprint).toBe(BOB_FP);
  expect(bob.key?.source).toBe('autocrypt');
  expect(asked).toEqual([{ box: 'inbox', from: BOB }]);
  expect(mockLookup).not.toHaveBeenCalled();
});

it('looks in archived mail when the inbox has none, and never in junk', async () => {
  const boxes: Mailbox[] = [];
  const { services } = harness(async (box) => {
    boxes.push(box);
    return { messages: box === 'archive' ? [row(BOB, header(BOB, fakePublicKey(BOB, BOB_FP)))] : [] };
  });

  const [bob] = await services.contacts.discoverRecipients([BOB]);
  expect(bob.status).toBe('ok');
  expect(boxes).toEqual(['inbox', 'archive']);
});

it('ignores a message the provider matched loosely, from another address', async () => {
  const other = 'bob@example.com.attacker.test';
  const { services } = harness(async () => ({
    messages: [row(other, header(other, fakePublicKey(BOB, BOB_FP)))],
  }));

  const [bob] = await services.contacts.discoverRecipients([BOB]);
  expect(bob.status).toBe('missing');
});

it('reports a mailbox it could not search as unresolved, not as "no key"', async () => {
  const { services, store } = harness(async () => {
    throw new Error('offline');
  });

  const [bob] = await services.contacts.discoverRecipients([BOB]);
  expect(bob.status).toBe('missing');
  expect(store.get().undiscoverable).toEqual([BOB]);
});

it('says nothing is unresolved when the search worked and found no key', async () => {
  const { services, store } = harness(async () => ({ messages: [row(BOB)] }));

  await services.contacts.discoverRecipients([BOB]);
  expect(store.get().undiscoverable).toEqual([]);
});
