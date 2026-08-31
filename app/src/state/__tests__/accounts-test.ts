/**
 * Two mailboxes on one device — the property the whole feature exists for.
 *
 * The tests are written against the *real* service graph and the *real* stores,
 * not against `accounts.ts` in isolation, because the failure mode this guards
 * is not a wrong return value. It is a store that was keyed globally, quietly
 * handing the second account the first one's keyring, drafts or search index.
 * Only an end-to-end sign-in / switch / read can show that has not happened.
 *
 * The auth provider and the Gmail client are faked here, and that is now the
 * only way to reach two accounts at once: this used to ride on `demoAuth` and
 * the fixture mailbox, and both were removed with demo mail. The real
 * `googleAuth` can hold exactly one session, because Play services has one
 * signed-in user — so **the single-account limit lives in the provider, not in
 * the state layer**, and these tests are what keep that true. If a second
 * provider ever lands (Outlook, IMAP), the plumbing below is already correct.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Session } from '../../auth';
import { MailClient, MailSummary } from '../../mail/types';
import { accountIdFor, scopedKey } from '../../store/accountScope';
import { DRAFTS_STORE_KEY, loadDrafts } from '../../store/draftsStore';
import { KEYRING_STORE_KEY, loadKeyring } from '../../store/keyring';
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

const FIRST = 'you@gmail.com';
const SECOND = 'you@work.example';
const ONE = accountIdFor('gmail', FIRST);
const TWO = accountIdFor('gmail', SECOND);

/** Sessions this fake provider has handed out. `mock`-prefixed so jest may hoist. */
const mockConnected: Session[] = [];

/**
 * An auth provider that can hold more than one session.
 *
 * This is the whole reason the test can exercise two accounts: it adds a
 * session per `signIn` instead of replacing one, which is exactly the contract
 * `AuthProvider` declares and exactly what `googleAuth` cannot do.
 */
jest.mock('../../auth', () => {
  const actual = jest.requireActual('../../auth');
  const mailboxes = ['you@gmail.com', 'you@work.example'];
  return {
    ...actual,
    auth: {
      provider: 'gmail',
      async signIn() {
        const next = mailboxes.find((e) => !mockConnected.some((s) => s.email === e));
        if (!next) return mockConnected[0];
        const session: Session = {
          provider: 'gmail',
          email: next,
          accessToken: 'test-token',
          expiresAt: Date.now() + 3_600_000,
        };
        mockConnected.push(session);
        return session;
      },
      async restoreAll() {
        return [...mockConnected];
      },
      async signOut(email?: string) {
        const keep = email === undefined ? [] : mockConnected.filter((s) => s.email !== email);
        mockConnected.length = 0;
        mockConnected.push(...keep);
      },
      async freshAccessToken() {
        return 'test-token';
      },
    },
  };
});

/**
 * One fake mailbox per address, with ids derived from the whole address.
 *
 * Distinct ids matter: the merged inbox groups on them, so two mailboxes
 * sharing an id would collapse into one thread and a star would land on both.
 * That is a real bug this feature shipped once — see the id-collision test.
 */
// Built from char codes so no escape sequence has to survive being written
// into this file; RFC 5322 wants CRLF between header lines.
const CRLF = String.fromCharCode(13, 10);

function mockMailboxFor(address: string): MailClient {
  const tag = address.replace(/[^a-z0-9]+/gi, '-');
  const raw = (subject: string) =>
    [
      'From: someone@example.com',
      `To: ${address}`,
      `Subject: ${subject}`,
      '',
      'Body text.',
    ].join(CRLF);

  const rows: MailSummary[] = [
    {
      id: `${tag}-1`,
      from: { address: 'someone@example.com', name: 'Someone' },
      to: [address],
      date: '2026-08-30T10:00:00.000Z',
      subject: `Hello ${address}`,
      snippet: 'Body text.',
      unread: true,
      starred: false,
    },
    {
      id: `${tag}-2`,
      from: { address: 'other@example.com', name: 'Other' },
      to: [address],
      date: '2026-08-29T09:00:00.000Z',
      subject: 'Older note',
      snippet: 'Body text.',
      unread: false,
      starred: false,
    },
  ];

  return {
    kind: 'gmail',
    address,
    async listInbox(limit = 20) {
      return rows.slice(0, limit);
    },
    async getRaw(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`No such message: ${id}`);
      return raw(row.subject);
    },
    async send() {},
    async updateFlags() {},
  };
}

jest.mock('../../mail/gmail', () => ({
  createGmailClient: (address: string) => mockMailboxFor(address),
}));

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
  mockConnected.length = 0;
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

  /**
   * Scoped keys, and nothing left at the bare global one.
   *
   * The unscoped key is what a pre-multi-account install wrote; `loadScopedJson`
   * reads it once and moves it under the first account. A value still sitting
   * there afterwards would be handed to the *second* account as well, which is
   * the leak this whole feature exists to prevent.
   */
  it('writes each account under its own storage key', async () => {
    const h = harness();
    await connectBoth(h);
    await h.services.drafts.saveDraft({
      id: 'scoped',
      to: [],
      subject: 'scoped',
      body: '',
      updatedAt: new Date().toISOString(),
    });

    expect(await AsyncStorage.getItem(scopedKey(DRAFTS_STORE_KEY, TWO))).not.toBeNull();
    expect(await AsyncStorage.getItem(DRAFTS_STORE_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(KEYRING_STORE_KEY)).toBeNull();
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
   * Every row must be its own message. Ids are assumed unique across accounts,
   * and when the demo fixtures broke that assumption the merged list silently
   * grouped both mailboxes' copies into one thread -- so a star landed on two
   * messages in two different accounts at once. Checking the account set alone
   * did not catch it, because both accounts were still represented.
   */
  it('does not collide ids between the two mailboxes', async () => {
    const h = harness();
    await connectBoth(h);
    await h.services.accounts.setUnified(true);

    const ids = h.get().messages.map((m) => m.id);

    expect(new Set(ids).size).toBe(ids.length);
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
