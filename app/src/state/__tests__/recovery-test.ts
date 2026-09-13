/**
 * Restoring a key onto a fresh install.
 *
 * This is the path a reinstall actually takes, and its failures are quiet ones:
 * a key that restores into the wrong mailbox looks like it worked and is gone
 * at the next launch, and a key whose listing the device has forgotten gets
 * published a second time, superseding a confirmation the user already gave.
 * Neither shows up as an error, so only a test says they did not happen.
 *
 * Written against the real `identity` and `publish` services with the core, the
 * directory and the scoped stores faked, because what is under test is how
 * those three are sequenced — not what any one of them returns.
 */
import { Identity } from '../../core';
import { drillOutstanding } from '../../store/recoveryStore';
import { createIdentityService } from '../identity';
import { createPublish } from '../publish';
import { createStore, initialState } from '../store';
import { Ctx, Services } from '../contracts';

const ADDRESS = 'you@gmail.com';
const OTHER = 'someone.else@gmail.com';
const FINGERPRINT = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';

const identityFor = (email: string, fingerprint = FINGERPRINT): Identity => ({
  email,
  fingerprint,
  publicKeyArmored: `-----BEGIN PGP PUBLIC KEY BLOCK-----\n${fingerprint}\n-----END PGP PUBLIC KEY BLOCK-----`,
  createdAt: '2026-01-01T00:00:00.000Z',
});

/** What `importRecoveryBackup` will hand back on the next call. */
let mockRestored: Identity = identityFor(ADDRESS);
/** What the directory serves for the looked-up address, or nothing. */
let mockListed: Identity | null = null;
/** The one code the fake core's backups open with. */
const mockCode = 'code';
/** Set to make `exportRecoveryBackup` behave like a core with no recovery methods. */
let mockBackupUnavailable = false;
/** Every blob `importRecoveryBackup` was handed — how the drill's blob is traced. */
const mockImported: string[] = [];

jest.mock('../../core', () => {
  const actual = jest.requireActual('../../core');
  return {
    ...actual,
    core: {
      generateIdentity: async () => mockRestored,
      exportRecoveryBackup: async () => {
        if (mockBackupUnavailable) {
          throw new actual.CoreError('Backing up needs a newer core.', 'unavailable');
        }
        return { code: mockCode, blob: 'fresh-blob' };
      },
      importRecoveryBackup: async (blob: string, code: string) => {
        mockImported.push(blob);
        if (code !== mockCode) throw new actual.CoreError('wrong code', 'decrypt-failed');
        return mockRestored;
      },
      // The reconcile path re-reads the armored key the directory served; the
      // fake blob above carries its fingerprint on the middle line.
      importPublicKey: async (armored: string) => ({
        email: ADDRESS,
        fingerprint: armored.split('\n')[1],
        armored,
      }),
    },
  };
});

jest.mock('../../keys', () => ({
  directory: {
    listedAt: 'keys.openpgp.org',
    lookup: async () =>
      mockListed ? { armored: mockListed.publicKeyArmored, source: 'vks' as const } : null,
    publish: async () => ({ status: 'pending' as const }),
  },
}));

// Both stores are AsyncStorage-backed and scoped by account; the state patch is
// what the assertions read, so the write only has to not throw.
jest.mock('../../store/recoveryStore', () => ({
  ...jest.requireActual('../../store/recoveryStore'),
  clearBackupRecord: async () => ({ backedUpAt: null, fingerprint: null }),
  recordBackup: async (_account: string, fingerprint: string, at: Date, drillPending: string | null) => ({
    backedUpAt: at.toISOString(),
    fingerprint,
    drillPending,
  }),
  markDrillPending: async (_account: string, fingerprint: string) => ({
    backedUpAt: null,
    fingerprint: null,
    drillPending: fingerprint,
  }),
  recordDrill: async (_account: string, fingerprint: string) => ({
    backedUpAt: '2026-09-13T00:00:00.000Z',
    fingerprint,
    drillPending: null,
  }),
  waiveDrill: async (_account: string, state: object) => ({ ...state, drillPending: null }),
}));
jest.mock('../../store/publishStore', () => ({
  ...jest.requireActual('../../store/publishStore'),
  savePublishState: async (_account: string, status: string, fingerprint: string | null) => ({
    status,
    fingerprint,
    updatedAt: '2026-09-09T00:00:00.000Z',
  }),
}));

function harness() {
  const store = createStore({ ...initialState(), session: { email: ADDRESS } as never }, () => {});
  const services = {} as Services;
  const ctx: Ctx = { store, mail: { current: null, clients: new Map() }, services };

  services.accounts = { requireActive: () => `gmail:${ADDRESS}` } as never;
  services.publish = createPublish(ctx);
  services.identity = createIdentityService(ctx);

  return { store, services };
}

beforeEach(() => {
  mockRestored = identityFor(ADDRESS);
  mockListed = null;
  mockBackupUnavailable = false;
  mockImported.length = 0;
});

/**
 * Setup's recovery drill (features.md 0.15): a new key is not done until its
 * code has been typed back and has really unlocked the backup.
 */
describe('the recovery drill', () => {
  const owes = (store: ReturnType<typeof harness>['store']) =>
    drillOutstanding(store.get().recovery, store.get().identity?.fingerprint);

  it('is owed from the moment setup makes a key', async () => {
    const { store, services } = harness();

    await services.identity.createIdentity();

    expect(owes(store)).toBe(true);
  });

  it('is still owed after the backup is taken', async () => {
    const { store, services } = harness();
    await services.identity.createIdentity();

    await services.identity.exportRecovery();

    expect(owes(store)).toBe(true);
    expect(store.get().recovery.backedUpAt).not.toBeNull();
  });

  it('refuses a wrong code and leaves the drill owed', async () => {
    const { store, services } = harness();
    await services.identity.createIdentity();
    await services.identity.exportRecovery();

    await expect(services.identity.completeRecoveryDrill('WRONG')).rejects.toThrow(/does not unlock/);
    expect(owes(store)).toBe(true);
  });

  it('settles on the right code, unlocking the backup this run took', async () => {
    const { store, services } = harness();
    await services.identity.createIdentity();
    await services.identity.exportRecovery();

    await services.identity.completeRecoveryDrill(mockCode);

    expect(owes(store)).toBe(false);
    // A real unlock of the fresh backup — not a pasted one, and not a string
    // comparison that never touched the core.
    expect(mockImported).toEqual(['fresh-blob']);
  });

  it('cannot be completed before a backup exists', async () => {
    const { store, services } = harness();
    await services.identity.createIdentity();

    await expect(services.identity.completeRecoveryDrill(mockCode)).rejects.toThrow(/recovery code first/);
    expect(owes(store)).toBe(true);
  });

  it('refuses a backup that unlocks some other key', async () => {
    const { store, services } = harness();
    await services.identity.createIdentity();
    await services.identity.exportRecovery();
    mockRestored = identityFor(ADDRESS, 'FFFF9999FFFF9999FFFF9999FFFF9999FFFF9999');

    await expect(services.identity.completeRecoveryDrill(mockCode)).rejects.toThrow(/different key/);
    expect(owes(store)).toBe(true);
  });

  it('will not be waived on a core that can make backups', async () => {
    const { store, services } = harness();
    await services.identity.createIdentity();

    await expect(services.identity.waiveRecoveryDrill()).rejects.toThrow(/can make a backup/);
    expect(owes(store)).toBe(true);
  });

  it('is waived only when the core cannot make backups at all', async () => {
    const { store, services } = harness();
    await services.identity.createIdentity();
    mockBackupUnavailable = true;

    await services.identity.waiveRecoveryDrill();

    expect(owes(store)).toBe(false);
    // Waiving is not a backup, and the warning on Keys must still fire.
    expect(store.get().recovery.backedUpAt).toBeNull();
  });

  it('is not owed after a restore — restoring was the code entry', async () => {
    const { store, services } = harness();

    await services.identity.restoreFromRecovery('blob', mockCode);

    expect(owes(store)).toBe(false);
  });
});

describe('restoring onto a fresh install', () => {
  it('refuses a backup for a different address and keeps this mailbox’s key', async () => {
    const { store, services } = harness();
    mockRestored = identityFor(OTHER);

    await expect(services.identity.restoreFromRecovery('blob', 'code')).rejects.toThrow(
      /someone\.else@gmail\.com/,
    );
    // The point of refusing: nothing was adopted, so the next launch — which
    // loads by the *session's* address — finds exactly what it found before.
    expect(store.get().identity).toBeNull();
  });

  it('adopts the listing the restored key already has, instead of publishing twice', async () => {
    const { store, services } = harness();
    mockListed = identityFor(ADDRESS);

    await services.identity.restoreFromRecovery('blob', 'code');

    expect(store.get().identity?.fingerprint).toBe(FINGERPRINT);
    expect(store.get().publish).toMatchObject({ status: 'published', fingerprint: FINGERPRINT });
  });

  it('stays unpublished when the directory serves some other key for the address', async () => {
    const { store, services } = harness();
    // A listing exists, but for a key this device does not hold — the case a
    // fingerprint comparison is there to catch.
    mockListed = identityFor(ADDRESS, 'FFFF9999FFFF9999FFFF9999FFFF9999FFFF9999');

    await services.identity.restoreFromRecovery('blob', 'code');

    expect(store.get().publish.status).toBe('unpublished');
  });

  it('stays unpublished when the directory has nothing at all', async () => {
    const { store, services } = harness();

    await services.identity.restoreFromRecovery('blob', 'code');

    expect(store.get().publish.status).toBe('unpublished');
  });
});

describe('reconcilePublish', () => {
  it('leaves a declined key alone — that mark is the user’s answer', async () => {
    const { store, services } = harness();
    mockListed = identityFor(ADDRESS);
    store.patch({
      identity: identityFor(ADDRESS),
      publish: { status: 'declined', fingerprint: FINGERPRINT, updatedAt: null },
    });

    await services.publish.reconcilePublish();

    expect(store.get().publish.status).toBe('declined');
  });

  it('does nothing when this device has no key', async () => {
    const { store, services } = harness();
    mockListed = identityFor(ADDRESS);

    await services.publish.reconcilePublish();

    expect(store.get().publish.status).toBe('unpublished');
  });
});
