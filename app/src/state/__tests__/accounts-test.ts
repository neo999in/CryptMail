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

import { AuthError, Session } from '../../auth';
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
          // The provider returns a display name and avatar alongside the
          // address. Only the first mailbox has a picture here, so the tests
          // cover both an account that has one and one that does not.
          name: next === 'you@gmail.com' ? 'You Personal' : 'You At Work',
          ...(next === 'you@gmail.com' ? { photo: 'https://example.invalid/you.png' } : {}),
        };
        mockConnected.push(session);
        return session;
      },
      /**
       * Honours `known`, the way the real provider must: Play services cannot
       * enumerate its grants, so boot names the addresses it wants and asks for
       * them one at a time. A fake that ignored the argument and handed back
       * everything would make the two-phase boot untestable — and would hide
       * the case that matters, where one named mailbox is gone and the others
       * are not.
       */
      async restoreAll(known?: string[]) {
        if (!known?.length) return [...mockConnected];
        const found = mockConnected.filter((s) => known.includes(s.email));
        if (found.length === 0) throw new actual.AuthError('Not signed in.', 'reauth-required');
        return found;
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

/** Every `list` any fake mailbox has served — how a redundant sync is caught. */
const mockListCalls: string[] = [];

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
    async list(box, { limit = 20 } = {}) {
      mockListCalls.push(`${address}:${box}`);
      // One page holds every row this fake has, so it hands back no cursor.
      return { messages: box === 'inbox' ? rows.slice(0, limit) : [] };
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
  mockListCalls.length = 0;
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

/**
 * Launching with two mailboxes already connected.
 *
 * Boot restores the one that was in front, paints it, and brings the rest back
 * behind it — so these assert both halves, and that the background half never
 * moves the account the user is already looking at.
 */
/**
 * Let work that a synchronous entry point deliberately does not await finish —
 * boot's background restores, and the switch `handleAuthLoss` starts behind its
 * boolean return.
 */
const settle = async () => {
  // `setImmediate`, not a zero timer: a timer still pending when a test ends
  // is exactly what jest reports as a leaked handle.
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(() => resolve()));
};

describe('booting with two mailboxes', () => {
  /**
   * Boot, then let the background restores land — and then tell them to stop,
   * the way an unmounted provider would. Leaving them running past the end of
   * a test is a leaked handle, and jest is right to complain about it.
   */
  const boot = async (h: ReturnType<typeof harness>) => {
    let cancelled = false;
    await h.services.session.boot(() => cancelled);
    await settle();
    cancelled = true;
  };

  it('restores both, with the one that was in front still in front', async () => {
    const first = harness();
    await connectBoth(first);
    await first.services.accounts.switchAccount(ONE);

    // A fresh provider over the same storage: a relaunch.
    const next = harness();
    await boot(next);
    expect(next.get().activeAccount).toBe(ONE);
    expect(next.get().session?.email).toBe(FIRST);
    expect(next.get().accounts.map((a) => a.id).sort()).toEqual([ONE, TWO].sort());
    // Still ONE: a background restore that activated itself would pull the
    // mailbox out from under whatever the user had already started reading.
    expect(next.get().activeAccount).toBe(ONE);
  });

  it('opens the next mailbox when the one in front will no longer restore', async () => {
    const first = harness();
    await connectBoth(first);
    await first.services.accounts.switchAccount(ONE);

    // ONE's grant is gone; TWO's is not.
    const [gone] = mockConnected.splice(
      mockConnected.findIndex((s) => s.email === FIRST),
      1,
    );
    expect(gone.email).toBe(FIRST);

    const next = harness();
    await boot(next);

    // The app opens rather than landing on the connect screen, and says which
    // mailbox it could not reach instead of quietly dropping it.
    expect(next.get().session?.email).toBe(SECOND);
    expect(next.get().activeAccount).toBe(TWO);
    expect(next.get().needsReauth).toContain(ONE);
    expect(next.get().accounts.map((a) => a.id)).toContain(ONE);
  });

  it('flags a second mailbox that will not restore, rather than dropping it', async () => {
    const first = harness();
    await connectBoth(first);

    mockConnected.splice(
      mockConnected.findIndex((s) => s.email === FIRST),
      1,
    );

    const next = harness();
    await boot(next);

    expect(next.get().activeAccount).toBe(TWO);
    expect(next.get().needsReauth).toEqual([ONE]);
    // Its keyring, drafts and decrypted mail are untouched — a dead token says
    // nothing about whether the data on this device is still the user's.
    expect(next.get().accounts.map((a) => a.id)).toContain(ONE);
  });
});

/**
 * One revoked grant, two connected mailboxes.
 *
 * This is the case that was wrong for as long as the provider could only hold
 * one account: `handleAuthLoss` cleared the whole account list, so a second
 * mailbox's expiry signed the user out of the first one, which was working.
 */
describe('losing one account', () => {
  const revoked = () => new AuthError('Access was revoked.', 'reauth-required');

  it('flags the failed mailbox and keeps the other signed in', async () => {
    const h = harness();
    await connectBoth(h);

    // Returns at once — callers use it to decide whether to stop — and steps
    // off the dead mailbox behind that answer.
    expect(h.services.session.handleAuthLoss(revoked(), TWO)).toBe(true);
    await settle();

    expect(h.get().needsReauth).toEqual([TWO]);
    expect(h.get().accounts.map((a) => a.id)).toEqual([ONE, TWO]);
    // Stepped off the dead one rather than sitting on an inbox that can only
    // ever show an error.
    expect(h.get().activeAccount).toBe(ONE);
    expect(h.get().session?.email).toBe(FIRST);
  });

  it('signs out completely when the last mailbox goes', async () => {
    const h = harness();
    await h.services.session.boot(() => false);
    await h.services.session.signIn();

    expect(h.services.session.handleAuthLoss(revoked())).toBe(true);

    expect(h.get().session).toBeNull();
    expect(h.get().accounts).toEqual([]);
    expect(h.get().activeAccount).toBeNull();
  });

  it('is not an auth loss when the error is something else', async () => {
    const h = harness();
    await connectBoth(h);

    expect(h.services.session.handleAuthLoss(new Error('offline'))).toBe(false);
    expect(h.get().needsReauth).toEqual([]);
    expect(h.get().session?.email).toBe(SECOND);
  });

  it('clears the flag when the mailbox is signed into again', async () => {
    const h = harness();
    await connectBoth(h);
    h.services.session.handleAuthLoss(revoked(), TWO);
    await settle();
    expect(h.get().needsReauth).toEqual([TWO]);

    // The user picks that mailbox again in the Google picker, which is a new
    // grant for an address the provider is no longer holding.
    mockConnected.splice(
      mockConnected.findIndex((session) => session.email === SECOND),
      1,
    );
    await h.services.session.signIn();

    expect(h.get().needsReauth).toEqual([]);
    expect(h.get().activeAccount).toBe(TWO);
  });
});

/**
 * The display name and avatar the provider hands over at sign-in.
 *
 * They ride along with a sign-in that has already happened — no extra call and
 * no extra scope — which is the only reason they are worth carrying at all.
 * What matters here is that they land on the *right* account: the switcher
 * draws one face per mailbox, and a profile stored under the wrong id is a
 * mislabelled mailbox, which is the one thing a switcher must never be.
 */
describe('account profiles', () => {
  it('stores each mailbox its own name and photo', async () => {
    const h = harness();
    await connectBoth(h);

    const [first, second] = h.get().accounts;
    expect(first).toMatchObject({ id: ONE, name: 'You Personal', photo: 'https://example.invalid/you.png' });
    expect(second).toMatchObject({ id: TWO, name: 'You At Work' });
  });

  it('leaves the photo absent when the provider has none', async () => {
    // An account with no picture is ordinary, not broken — the switcher falls
    // back to initials, so nothing downstream may assume a URL is there.
    const h = harness();
    await connectBoth(h);

    expect(h.get().accounts.find((a) => a.id === TWO)?.photo).toBeUndefined();
  });

  it('survives a relaunch, so the switcher has faces before anything restores', async () => {
    const first = harness();
    await connectBoth(first);

    const next = harness();
    await next.services.session.boot(() => false);
    await settle();

    expect(next.get().accounts.find((a) => a.id === ONE)?.photo).toBe('https://example.invalid/you.png');
  });
});

/**
 * Leaving the merged view by picking a mailbox.
 *
 * The rail's account tap means "this mailbox, on its own", which is two changes
 * — active account and merged lens — that the user experiences as one. Doing
 * them as separate `switchAccount` + `setUnified` calls synced the mailbox
 * twice for a single tap: a full merged page, then a full unmerged one.
 */
describe('picking one mailbox out of the merged view', () => {
  it('switches and unmerges in a single sync', async () => {
    const h = harness();
    await connectBoth(h);
    await h.services.accounts.setUnified(true);

    mockListCalls.length = 0;
    await h.services.accounts.switchAccount(ONE, { unified: false });

    expect(h.get().activeAccount).toBe(ONE);
    expect(h.get().unified).toBe(false);
    // Only this mailbox's rows are listed now.
    expect(h.get().messages.every((m) => m.account === ONE)).toBe(true);
    // One sync of one mailbox — inbox and the provider's junk folder, and
    // nothing belonging to the account being left. Two calls per refresh, so a
    // second refresh (the old switch-then-unmerge pair) would show up as four
    // and as the other mailbox appearing here at all.
    expect(mockListCalls).toEqual([`${FIRST}:inbox`, `${FIRST}:spam`]);
  });

  it('unmerges without a switch when the mailbox is already in front', async () => {
    // The early return used to fire on `id === active` and swallow the lens
    // change entirely, so tapping the active avatar while merged did nothing.
    const h = harness();
    await connectBoth(h);
    await h.services.accounts.setUnified(true);

    await h.services.accounts.switchAccount(TWO, { unified: false });

    expect(h.get().activeAccount).toBe(TWO);
    expect(h.get().unified).toBe(false);
    expect(h.get().messages.every((m) => m.account === TWO)).toBe(true);
  });

  it('is still a no-op when nothing would change', async () => {
    const h = harness();
    await connectBoth(h);
    const before = h.get().messages;

    await h.services.accounts.switchAccount(TWO);

    expect(h.get().messages).toBe(before);
  });
});

/**
 * Both mailboxes losing their grant at once.
 *
 * One merged refresh asks every provider, so both can come back `401` in the
 * same tick — and then `markReauth` runs twice, concurrently. The first picks
 * the second as the mailbox to step onto while the second is dropping its own
 * session, and the switch lands on an account that no longer has one.
 *
 * Observed on a device on 2026-09-05 as a pair of
 * `Uncaught (in promise): "Error: That account is not connected."` — a throw
 * out of a `void` call, which is to say an error no user could ever see.
 */
describe('both accounts failing together', () => {
  const revoked = () => new AuthError('Access was revoked.', 'reauth-required');

  // The precise device interleaving is not reproducible here — this only fixes
  // the shape of it, that two concurrent `markReauth` calls settle with both
  // mailboxes flagged and neither promise rejecting. The two tests below are
  // the ones with teeth: they fail if `switchAccount` goes back to throwing.
  it('flags both, and neither call rejects', async () => {
    const h = harness();
    await connectBoth(h);

    await Promise.all([
      h.services.accounts.markReauth(ONE, 'gone'),
      h.services.accounts.markReauth(TWO, 'gone'),
    ]);
    await settle();

    expect(h.get().needsReauth.sort()).toEqual([ONE, TWO].sort());
  });

  it('reports an unreachable mailbox instead of throwing', async () => {
    const h = harness();
    await connectBoth(h);
    await h.services.accounts.markReauth(ONE);
    await settle();

    // A switch onto it is a no-op that says why, rather than a rejected promise
    // nothing is waiting on.
    await expect(h.services.accounts.switchAccount(ONE)).resolves.toBeUndefined();
    expect(h.get().error).toMatch(/sign in again/i);
    expect(h.get().activeAccount).toBe(TWO);
  });

  it('never opens a sign-in prompt on its own', async () => {
    // Google's picker as a side effect of a background token failure is a
    // prompt the user did not ask for. The drawer asks; the switch does not.
    const h = harness();
    await connectBoth(h);
    const before = mockConnected.length;

    await h.services.accounts.markReauth(TWO, 'gone');
    await settle();
    await h.services.accounts.switchAccount(TWO);

    expect(mockConnected.length).toBe(before);
  });
});
