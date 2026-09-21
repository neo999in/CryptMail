/**
 * Building a quantum link over email: the three legs, carried forward one per
 * sync, and what happens when the channel looks watched.
 *
 * Against the real service graph with the core faked, because what is under
 * test is the sequencing and the routing — which leg is answered with which,
 * and what reaches the wire — not the protocol, which is `core/tests/bb84.rs`.
 */
import { Session } from '../../auth';
import { isLinkSubject, linkSubject } from '../../core/bb84';
import { CoreError, Identity } from '../../core';
import { MailClient } from '../../mail/types';
import { createServices } from '../services';
import { createStore, initialState } from '../store';
import { InboxItem } from '../types';

/** What the fake core says a raw message is. */
const mockLeg = new Map<string, string | null>();
let mockLinks: Record<string, { at: string; state: string }> = {};
/** Set to make `bb84Judge` behave as though someone were listening. */
let mockWatched = false;
/** Who the fake core says signed what it opened. */
let mockSigner: { signature: string; signerFingerprint?: string } = { signature: 'valid', signerFingerprint: 'ADA-FP' };
/** Set to make the other end's key unknown. */
let mockNoKey = false;

jest.mock('@react-native-google-signin/google-signin', () => ({ GoogleSignin: { configure: jest.fn() } }));

jest.mock('../../core', () => {
  const actual = jest.requireActual('../../core');
  return {
    ...actual,
    core: {
      kind: 'native',
      bb84Begin: jest.fn(async () => 'PHOTONS-BLOCK'),
      bb84Measure: jest.fn(async () => 'MEASUREMENT-BLOCK'),
      bb84Judge: jest.fn(async () => {
        if (mockWatched) {
          throw new actual.CoreError('24.8% of the checked bits disagreed. No keys were built.', 'decrypt-failed');
        }
        return 'VERDICT-BLOCK';
      }),
      bb84Accept: jest.fn(async () => ({ account: 'me@example.com', role: 'Slave' })),
      bb84Leg: jest.fn(async (raw: string) => mockLeg.get(raw) ?? null),
      // Sealing, faked as a readable wrapper: what is under test is that the
      // legs go through it, to whose key, and what is refused on the way in.
      buildEncrypted: jest.fn(
        async (r: { to: string[]; subject: string; body: string; recipientKeys: string[]; level?: number }) =>
          `To: ${r.to.join(', ')}\nSubject: ${r.subject}\nX-Level: ${r.level}\nX-Sealed-To: ${r.recipientKeys.join(',')}\n\nSEALED:${r.body}`,
      ),
      looksEncrypted: jest.fn((raw: string) => raw.includes('SEALED:')),
      parseEncrypted: jest.fn(async (raw: string) => ({
        subject: '',
        body: raw.slice(raw.indexOf('SEALED:') + 'SEALED:'.length),
        attachments: [],
        ...mockSigner,
      })),
    },
  };
});

jest.mock('../../keys', () => ({
  directory: { listedAt: 'the test directory', lookup: async () => null, publish: jest.fn() },
  harvestAutocrypt: jest.fn(async (keyring: unknown) => keyring),
}));
jest.mock('../../store/keyring', () => ({
  ...jest.requireActual('../../store/keyring'),
  saveKeyring: jest.fn(async () => {}),
  loadKeyring: jest.fn(async () => ({})),
}));
jest.mock('../../store/linkStore', () => ({
  ...jest.requireActual('../../store/linkStore'),
  loadLinks: jest.fn(async () => mockLinks),
  saveLinks: jest.fn(async (_account: string, log: Record<string, { at: string; state: string }>) => {
    mockLinks = log;
  }),
}));

const ACCOUNT = 'gmail:me@example.com';
const SESSION: Session = {
  provider: 'gmail',
  email: 'me@example.com',
  accessToken: 't',
  expiresAt: Date.now() + 3_600_000,
};
const IDENTITY: Identity = {
  email: 'me@example.com',
  fingerprint: 'AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000',
  publicKeyArmored: 'MY-KEY',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function harness() {
  const wire: string[] = [];
  const raws = new Map<string, string>();
  const store = createStore(
    {
      ...initialState(),
      booting: false,
      session: SESSION,
      accounts: [{ id: ACCOUNT, provider: 'gmail', email: SESSION.email }],
      activeAccount: ACCOUNT,
      identity: IDENTITY,
    },
    () => {},
  );
  const { services, mail } = createServices(store);
  const client: MailClient = {
    kind: 'gmail',
    address: SESSION.email,
    list: async () => ({ messages: [] }),
    getRaw: async (id) => raws.get(id) ?? '',
    send: async (rfc822) => {
      wire.push(rfc822);
    },
    updateFlags: async () => {},
  };
  mail.current = client;
  services.contacts.discoverRecipients = async (emails: string[]) =>
    emails.map((email) =>
      mockNoKey
        ? ({ email, status: 'awaiting-key' } as never)
        : ({ email, status: 'ok', key: { armored: 'ADA-KEY', fingerprint: 'ADA-FP' } } as never),
    );
  return { store, services, wire, raws };
}

/** A leg that arrived, with its raw text and what the core makes of it. */
function arrived(
  h: ReturnType<typeof harness>,
  id: string,
  leg: 'photons' | 'measurement' | 'verdict',
  over: Partial<InboxItem> = {},
): InboxItem {
  const raw = `RAW-${id}`;
  h.raws.set(id, `SEALED:${raw}`);
  mockLeg.set(raw, leg);
  return {
    id,
    from: { address: 'ada@example.com' },
    to: ['me@example.com'],
    date: '2026-09-20T00:00:00.000Z',
    subject: linkSubject(leg),
    snippet: '',
    unread: true,
    starred: false,
    account: ACCOUNT,
    ...over,
  };
}

const subjectOf = (rfc822: string) => /^Subject: (.*)$/m.exec(rfc822)?.[1] ?? '';

beforeEach(() => {
  mockLeg.clear();
  mockLinks = {};
  mockWatched = false;
  mockNoKey = false;
  mockSigner = { signature: 'valid', signerFingerprint: 'ADA-FP' };
});

describe('starting a quantum link', () => {
  it('sends the states and records that one is running', async () => {
    const h = harness();
    await h.services.bb84.begin('ada@example.com');

    expect(h.wire).toHaveLength(1);
    expect(isLinkSubject(subjectOf(h.wire[0]))).toBe(true);
    expect(h.wire[0]).toContain('PHOTONS-BLOCK');
    expect(h.wire[0]).toContain('ada@example.com');
    expect(mockLinks['ada@example.com'].state).toBe('starting');
  });

  it('refuses a second exchange with the same address while one is running', async () => {
    const h = harness();
    await h.services.bb84.begin('ada@example.com');
    await expect(h.services.bb84.begin('ada@example.com')).rejects.toThrow(/already being set up/);
    expect(h.wire).toHaveLength(1);
  });

  it('carries nothing the user wrote', async () => {
    const h = harness();
    await h.services.bb84.begin('ada@example.com');
    // The only variable parts are the two addresses and the core's block.
    expect(h.wire[0]).not.toMatch(/Subject: (?!Setting up a quantum link)/);
  });
});

describe('carrying an exchange forward during a sync', () => {
  it('answers the states with a measurement', async () => {
    const h = harness();
    await h.services.bb84.answer([arrived(h, 'm1', 'photons')]);

    expect(h.wire).toHaveLength(1);
    expect(subjectOf(h.wire[0])).toBe(linkSubject('measurement'));
    expect(h.wire[0]).toContain('MEASUREMENT-BLOCK');
  });

  it('answers a measurement with a verdict, and counts itself linked', async () => {
    const h = harness();
    await h.services.bb84.answer([arrived(h, 'm2', 'measurement')]);

    expect(subjectOf(h.wire[0])).toBe(linkSubject('verdict'));
    expect(h.wire[0]).toContain('VERDICT-BLOCK');
    expect(mockLinks['ada@example.com'].state).toBe('linked');
  });

  it('finishes on a verdict without sending anything more', async () => {
    const h = harness();
    await h.services.bb84.answer([arrived(h, 'm3', 'verdict')]);

    expect(h.wire).toHaveLength(0);
    expect(mockLinks['ada@example.com'].state).toBe('linked');
  });

  it('ignores a message whose subject says leg but whose body is not one', async () => {
    const h = harness();
    const row = arrived(h, 'm4', 'photons');
    mockLeg.set('RAW-m4', null);
    await h.services.bb84.answer([row]);
    expect(h.wire).toHaveLength(0);
  });

  it('ignores ordinary mail, our own messages, and other accounts', async () => {
    const h = harness();
    await h.services.bb84.answer([
      arrived(h, 'a', 'photons', { subject: 'Lunch?' }),
      arrived(h, 'b', 'photons', { from: { address: 'me@example.com' } }),
      arrived(h, 'c', 'photons', { account: 'gmail:someone@else.com' }),
    ]);
    expect(h.wire).toHaveLength(0);
  });

  it('looks at each message once, however many syncs bring it back', async () => {
    const h = harness();
    const row = arrived(h, 'm5', 'photons');
    await h.services.bb84.answer([row]);
    await h.services.bb84.answer([row]);
    expect(h.wire).toHaveLength(1);
  });
});

describe('when the channel looks watched', () => {
  it('builds nothing, sends nothing, and says so', async () => {
    mockWatched = true;
    const h = harness();
    await h.services.bb84.answer([arrived(h, 'm6', 'measurement')]);

    expect(h.wire).toHaveLength(0);
    expect(mockLinks['ada@example.com'].state).toBe('refused');
    expect(h.store.get().error).toMatch(/disagreed/);
  });

  it('lets the user try again afterwards', async () => {
    mockWatched = true;
    const h = harness();
    await h.services.bb84.answer([arrived(h, 'm7', 'measurement')]);

    mockWatched = false;
    await h.services.bb84.begin('ada@example.com');
    expect(h.wire).toHaveLength(1);
  });

  it('says nothing for an ordinary failure, which is not evidence of anything', async () => {
    const h = harness();
    const { core } = jest.requireMock('../../core');
    core.bb84Measure.mockRejectedValueOnce(new CoreError('no exchange waiting', 'unavailable'));

    await h.services.bb84.answer([arrived(h, 'm8', 'photons')]);
    expect(h.store.get().error).toBeNull();
    expect(h.wire).toHaveLength(0);
  });
});

describe('checking by hand', () => {
  /** A sync that brings `rows` in, the way `refreshInbox` does. */
  function syncs(h: ReturnType<typeof harness>, rows: InboxItem[]) {
    h.services.mailbox.refreshInbox = async () => {
      h.store.patch({ messages: rows });
      await h.services.bb84.answer(rows);
    };
  }

  it('says when there is no link message at all', async () => {
    const h = harness();
    syncs(h, []);
    await expect(h.services.bb84.check()).resolves.toMatch(/No link messages/);
  });

  it('reports the reply it sent', async () => {
    const h = harness();
    syncs(h, [arrived(h, 'c1', 'photons')]);
    await expect(h.services.bb84.check()).resolves.toMatch(/replied \(2 of 3\)/);
    expect(h.wire).toHaveLength(1);
  });

  it('says why a leg failed, and retries it when asked again', async () => {
    const h = harness();
    const { core } = jest.requireMock('../../core');
    core.bb84Measure.mockRejectedValueOnce(new CoreError('no exchange waiting', 'unavailable'));
    syncs(h, [arrived(h, 'c2', 'photons')]);

    await expect(h.services.bb84.check()).resolves.toMatch(/no exchange waiting/i);
    expect(h.wire).toHaveLength(0);

    await expect(h.services.bb84.check()).resolves.toMatch(/replied/);
    expect(h.wire).toHaveLength(1);
  });
});

describe('the legs are sealed and signed', () => {
  it('seals every leg at Level 1 to the other end’s key', async () => {
    const h = harness();
    await h.services.bb84.begin('ada@example.com');
    await h.services.bb84.answer([arrived(h, 's1', 'photons')]);

    expect(h.wire).toHaveLength(2);
    for (const sent of h.wire) {
      expect(sent).toContain('X-Level: 1');
      expect(sent).toContain('X-Sealed-To: ADA-KEY');
    }
  });

  it('will not start without their key', async () => {
    mockNoKey = true;
    const h = harness();
    const { core } = jest.requireMock('../../core');
    const begun = core.bb84Begin.mock.calls.length;
    await expect(h.services.bb84.begin('ada@example.com')).rejects.toThrow(/needs their key/);
    expect(h.wire).toHaveLength(0);
    expect(core.bb84Begin.mock.calls.length).toBe(begun);
  });

  it('refuses a leg that arrived in the clear', async () => {
    const h = harness();
    const row = arrived(h, 's2', 'photons');
    h.raws.set('s2', 'RAW-s2');
    await h.services.bb84.answer([row]);
    expect(h.wire).toHaveLength(0);
  });

  it('refuses a leg not signed by their known key', async () => {
    mockSigner = { signature: 'valid', signerFingerprint: 'SOMEONE-ELSE' };
    const h = harness();
    await h.services.bb84.answer([arrived(h, 's3', 'photons')]);
    expect(h.wire).toHaveLength(0);

    mockSigner = { signature: 'invalid' };
    await h.services.bb84.answer([arrived(h, 's4', 'photons')]);
    expect(h.wire).toHaveLength(0);
  });
});
