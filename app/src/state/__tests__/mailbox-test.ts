/**
 * "Mark as spam" — the correction, and the two things it must not do.
 *
 * A mark is the only place a human decision enters the filter, so it has to be
 * exact in both directions. The suites below pin the two failures that would be
 * invisible in use:
 *
 * - **A reversal must leave nothing behind.** If a user marks a message spam and
 *   then not-spam, the first verdict has to be *untrained*, not merely
 *   outvoted — otherwise the counts hold both answers and the filter has learned
 *   that the message's words mean nothing in particular.
 * - **The encryption boundary holds here too.** An unopened encrypted message has
 *   a placeholder subject and a ciphertext snippet. Marking it must train from its
 *   cleartext headers and nothing else; once it has been opened and indexed, the
 *   real subject and body become fair game because they were decrypted on this
 *   device.
 *
 * The stores are stubbed because they seal their contents under a device key that
 * only exists after `initStorage`. What is asserted is the model and the marks the
 * service produced, plus the fact that they were persisted together.
 */
import { PLACEHOLDER_SUBJECT } from '../../core';
import { MailClient, MailSummary } from '../../mail/types';
import type { SpamModel } from '../../spam/bayes';
import type { SpamState } from '../../store/spamModelStore';
import { accountIdFor } from '../../store/accountScope';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { InboxItem, State } from '../types';

/** The one connected mailbox these tests mark mail in. */
const ACCOUNT = accountIdFor('gmail', 'me@example.com');

/** The two message tallies, which is what "trained once" has to mean. */
const counts = (model: SpamModel): { spam: number; ham: number } => ({
  spam: model.spamMessages,
  ham: model.hamMessages,
});

const mockSaveSpamState = jest.fn<Promise<void>, [string, SpamState]>(async () => {});

// Reached through `config.ts` and the auth provider; a native module with no
// binary under jest.
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

jest.mock('../../store/spamModelStore', () => ({
  ...jest.requireActual('../../store/spamModelStore'),
  saveSpamState: (account: string, state: SpamState) => mockSaveSpamState(account, state),
  loadSpamState: jest.fn(async () => jest.requireActual('../../store/spamModelStore').emptySpamState()),
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

/** A junk mail with enough in it that both halves of the model see tokens. */
const JUNK: InboxItem = {
  account: ACCOUNT,
  id: 'junk-1',
  from: { address: 'promo@coin-blast.example', name: 'Coin Blast' },
  to: ['me@example.com'],
  date: '2026-08-09T12:00:00.000Z',
  subject: 'Bitcoin doubling event closes tonight',
  snippet: 'Send bitcoin to our wallet and receive double back before the doubling round closes.',
  unread: true,
  starred: false,
};

/** The same message as the provider shows it while it is still encrypted. */
const SEALED: InboxItem = {
  ...JUNK,
  id: 'sealed-1',
  subject: PLACEHOLDER_SUBJECT,
  snippet: '-----BEGIN PGP MESSAGE----- hQIMA0x9 ...',
};

function harness(over: Partial<State> = {}) {
  const store = createStore(
    {
      ...initialState(),
      booting: false,
      session: { provider: 'gmail', email: 'me@example.com', accessToken: 't', expiresAt: Date.now() + 3_600_000 },
      accounts: [{ id: ACCOUNT, provider: 'gmail', email: 'me@example.com' }],
      activeAccount: ACCOUNT,
      messages: [JUNK],
      ...over,
    },
    () => {},
  );
  const { services, mail } = createServices(store);
  const client: MailClient = {
    kind: 'gmail',
    address: 'me@example.com',
    listInbox: async () => [],
    getRaw: async () => '',
    send: async () => {},
    updateFlags: async () => {},
  };
  mail.current = client;
  return { store, services };
}

beforeEach(() => {
  mockSaveSpamState.mockClear();
});

describe('markSpam', () => {
  it('records the mark and trains the model from the message', async () => {
    const { services, store } = harness();

    await services.mailbox.markSpam('junk-1');

    const { spam } = store.get();
    expect(spam.marks['junk-1']).toBe('spam');
    expect(counts(spam.model)).toEqual({ spam: 1, ham: 0 });
    expect(Object.keys(spam.model.spam).length).toBeGreaterThan(0);
  });

  it('persists the mark and the model together, in one record', async () => {
    const { services } = harness();

    await services.mailbox.markSpam('junk-1');

    expect(mockSaveSpamState).toHaveBeenCalledTimes(1);
    const [account, saved] = mockSaveSpamState.mock.calls[0];
    // Scoped to the mailbox it was learned in — another account's model is not
    // evidence about this one's mail.
    expect(account).toBe(ACCOUNT);
    // One record, so a restart cannot restore a mark whose training was lost.
    expect(saved.marks['junk-1']).toBe('spam');
    expect(counts(saved.model)).toEqual({ spam: 1, ham: 0 });
  });

  it('does not archive or delete the message', async () => {
    const { services, store } = harness();

    await services.mailbox.markSpam('junk-1');

    // Filing is not removal: the row stays in the mailbox so the decision is
    // reversible from where the user made it.
    expect(store.get().messages.map((m) => m.id)).toEqual(['junk-1']);
  });

  it('ignores an id that is not in the mailbox', async () => {
    const { services, store } = harness();

    await services.mailbox.markSpam('no-such-message');

    expect(store.get().spam).toEqual(initialState().spam);
    expect(mockSaveSpamState).not.toHaveBeenCalled();
  });

  it('does nothing when the same mark is applied twice', async () => {
    const { services, store } = harness();

    await services.mailbox.markSpam('junk-1');
    const after = store.get().spam;
    await services.mailbox.markSpam('junk-1');

    // Not merely idempotent in the marks — the second call must not train a
    // second time, or one message would count double.
    expect(store.get().spam).toBe(after);
    expect(counts(store.get().spam.model)).toEqual({ spam: 1, ham: 0 });
    expect(mockSaveSpamState).toHaveBeenCalledTimes(1);
  });

  it('counts a double tap once, even with nothing awaited in between', async () => {
    const { services, store } = harness();

    // A user can tap twice faster than the persist resolves. `store.patch` is
    // synchronous, so the second call reads the mark the first one just wrote and
    // returns at the `previous === mark` guard — the guard is what stops one
    // message being trained twice, and it only holds because of that synchrony.
    await Promise.all([services.mailbox.markSpam('junk-1'), services.mailbox.markSpam('junk-1')]);

    expect(counts(store.get().spam.model)).toEqual({ spam: 1, ham: 0 });
    expect(mockSaveSpamState).toHaveBeenCalledTimes(1);
  });

  it('applies a reversal exactly once when both buttons are tapped in the same tick', async () => {
    const { services, store } = harness();

    await Promise.all([services.mailbox.markSpam('junk-1'), services.mailbox.markNotSpam('junk-1')]);

    const { spam } = store.get();
    expect(spam.marks['junk-1']).toBe('ham');
    // The spam training the first tap added has been untrained by the second, so
    // an interleaved pair leaves the same state a sequential pair would.
    expect(counts(spam.model)).toEqual({ spam: 0, ham: 1 });
    expect(spam.model.spam).toEqual({});
  });
});

describe('markNotSpam, and reversing a decision', () => {
  it('records the opposite mark and trains the ham side', async () => {
    const { services, store } = harness();

    await services.mailbox.markNotSpam('junk-1');

    expect(store.get().spam.marks['junk-1']).toBe('ham');
    expect(counts(store.get().spam.model)).toEqual({ spam: 0, ham: 1 });
  });

  it('untrains the previous mark, leaving exactly one verdict in the counts', async () => {
    const { services, store } = harness();

    await services.mailbox.markSpam('junk-1');
    await services.mailbox.markNotSpam('junk-1');

    const { spam } = store.get();
    expect(spam.marks['junk-1']).toBe('ham');
    expect(counts(spam.model)).toEqual({ spam: 0, ham: 1 });
    // The spam side is not just outvoted, it is empty: every token the first
    // verdict added has been decremented back to zero and deleted.
    expect(spam.model.spam).toEqual({});
  });

  it('returns the model to where it started after a full round trip', async () => {
    const { services, store } = harness();
    const before = store.get().spam.model;

    await services.mailbox.markSpam('junk-1');
    await services.mailbox.markNotSpam('junk-1');
    await services.mailbox.markSpam('junk-1');
    await services.mailbox.markNotSpam('junk-1');

    const after = store.get().spam.model;
    expect(after.spam).toEqual(before.spam);
    expect(counts(after)).toEqual({ spam: 0, ham: 1 });
  });
});

describe('the encryption boundary', () => {
  it('trains an unopened encrypted message from its headers only', async () => {
    const { services, store } = harness({ messages: [SEALED] });

    await services.mailbox.markSpam('sealed-1');

    const tokens = Object.keys(store.get().spam.model.spam);
    expect(tokens.length).toBeGreaterThan(0);
    // The sender's domain is cleartext and is learned.
    expect(tokens.some((t) => t.includes('coin-blast.example'))).toBe(true);
    // The placeholder subject and the ciphertext snippet are provider artefacts,
    // not content, so nothing from either may appear.
    for (const token of tokens) {
      expect(token).not.toContain('encrypted');
      expect(token).not.toContain('bitcoin');
      expect(token).not.toContain('begin');
    }
  });

  it('trains an encrypted message from its real content once this device has decrypted it', async () => {
    const { services, store } = harness({
      messages: [SEALED],
      // What `openMessage` writes after a successful local decrypt.
      searchIndex: {
        'sealed-1': {
          subject: 'Bitcoin doubling event closes tonight',
          body: 'Send bitcoin to our wallet and receive double back.',
        },
      },
    });

    await services.mailbox.markSpam('sealed-1');

    const tokens = Object.keys(store.get().spam.model.spam);
    expect(tokens.some((t) => t.includes('bitcoin'))).toBe(true);
  });
});
