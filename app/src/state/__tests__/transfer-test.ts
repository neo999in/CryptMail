/**
 * Moving to a new phone.
 *
 * What is under test is the sequencing around the core: the archive goes into
 * the transfer on the way out and back into storage on the way in, a transfer
 * file is recognised in the restore field a backup uses, the signed-in address
 * reaches the core so it can refuse someone else's transfer before changing
 * anything, and a failure to keep the archive is loud rather than a quiet loss.
 */
import { Identity } from '../../core';
import { createIdentityService } from '../identity';
import { createPublish } from '../publish';
import { createStore, initialState } from '../store';
import { Ctx, Services } from '../contracts';

const ADDRESS = 'you@gmail.com';
const FINGERPRINT = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';
const FILE = '-----BEGIN CRYPTMAIL TRANSFER-----\nabc\n-----END CRYPTMAIL TRANSFER-----';

const identity: Identity = {
  email: ADDRESS,
  fingerprint: FINGERPRINT,
  publicKeyArmored: `-----BEGIN PGP PUBLIC KEY BLOCK-----\n${FINGERPRINT}\n-----END PGP PUBLIC KEY BLOCK-----`,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const mockCalls: { method: string; args: unknown[] }[] = [];
let mockArchiveFails = false;

jest.mock('../../core', () => {
  const actual = jest.requireActual('../../core');
  const record = (method: string) => (...args: unknown[]) => void mockCalls.push({ method, args });
  return {
    ...actual,
    core: {
      exportTransfer: async (...args: unknown[]) => {
        record('exportTransfer')(...args);
        return { code: 'CODE', blob: 'FILE' };
      },
      importTransfer: async (...args: unknown[]) => {
        record('importTransfer')(...args);
        return { identity, archive: 'ARCHIVE' };
      },
      importRecoveryBackup: async (...args: unknown[]) => {
        record('importRecoveryBackup')(...args);
        return identity;
      },
      transferStatus: async () => ({ handedOverAt: new Date('2026-09-19T10:00:00Z') }),
      resumeSessions: async () => record('resumeSessions')(),
      importPublicKey: async (armored: string) => ({ email: ADDRESS, fingerprint: FINGERPRINT, armored }),
    },
  };
});

jest.mock('../../store/archiveStore', () => ({
  exportArchive: async (account: string) => {
    mockCalls.push({ method: 'exportArchive', args: [account] });
    return { archive: 'ARCHIVE', count: 3, unreadable: 1 };
  },
  importArchive: async (account: string, archive: string) => {
    mockCalls.push({ method: 'importArchive', args: [account, archive] });
    if (mockArchiveFails) throw new Error('disk full');
    return 3;
  },
}));

jest.mock('../../keys', () => ({
  directory: { listedAt: 'keys.openpgp.org', lookup: async () => null, publish: async () => ({ status: 'pending' }) },
}));
jest.mock('../../store/recoveryStore', () => ({
  ...jest.requireActual('../../store/recoveryStore'),
  clearBackupRecord: async () => ({ backedUpAt: null, fingerprint: null }),
}));
jest.mock('../../store/publishStore', () => ({
  ...jest.requireActual('../../store/publishStore'),
  savePublishState: async (_account: string, status: string, fingerprint: string | null) => ({
    status,
    fingerprint,
    updatedAt: null,
  }),
}));

function harness(withIdentity: boolean) {
  const store = createStore(
    { ...initialState(), session: { email: ADDRESS } as never, identity: withIdentity ? identity : null },
    () => {},
  );
  const services = {} as Services;
  const ctx: Ctx = { store, mail: { current: null, clients: new Map() }, services };
  services.accounts = { requireActive: () => `gmail:${ADDRESS}` } as never;
  services.publish = createPublish(ctx);
  services.identity = createIdentityService(ctx);
  return { store, services };
}

const methods = () => mockCalls.map((c) => c.method);

beforeEach(() => {
  mockCalls.length = 0;
  mockArchiveFails = false;
});

describe('leaving the old phone', () => {
  it('seals the archive into the transfer and says how much went in', async () => {
    const { services } = harness(true);
    const made = await services.identity.exportTransfer();

    expect(made).toEqual({ code: 'CODE', blob: 'FILE', archived: 3, unreadable: 1 });
    expect(mockCalls).toEqual([
      { method: 'exportArchive', args: [`gmail:${ADDRESS}`] },
      { method: 'exportTransfer', args: [ADDRESS, 'ARCHIVE'] },
    ]);
  });

  it('refuses with no key to move', async () => {
    const { services } = harness(false);
    await expect(services.identity.exportTransfer()).rejects.toMatchObject({ code: 'no-key' });
    expect(methods()).toEqual([]);
  });

  it('reports when the phone was handed over, and takes it back on request', async () => {
    const { services } = harness(true);
    expect(await services.identity.transferStatus()).toEqual(new Date('2026-09-19T10:00:00Z'));
    await services.identity.resumeSessions();
    expect(methods()).toEqual(['resumeSessions']);
  });
});

describe('arriving on the new phone', () => {
  it('takes a transfer file in the restore field, checks the address, and keeps the archive', async () => {
    const { store, services } = harness(false);
    await services.identity.restoreFromRecovery(FILE, 'CODE');

    expect(mockCalls).toEqual([
      { method: 'importTransfer', args: [FILE, 'CODE', ADDRESS] },
      { method: 'importArchive', args: [`gmail:${ADDRESS}`, 'ARCHIVE'] },
    ]);
    expect(store.get().identity?.fingerprint).toBe(FINGERPRINT);
  });

  it('still restores an ordinary backup the ordinary way', async () => {
    const { services } = harness(false);
    await services.identity.restoreFromRecovery('-----BEGIN PGP PRIVATE KEY BLOCK-----', 'CODE');
    expect(methods()).toEqual(['importRecoveryBackup']);
  });

  it('says plainly when the archive could not be kept, with the key already in place', async () => {
    const { store, services } = harness(false);
    mockArchiveFails = true;

    await expect(services.identity.restoreFromRecovery(FILE, 'CODE')).rejects.toThrow(
      /couldn’t be saved on this phone \(disk full\)\. Load the transfer file again/,
    );
    expect(store.get().identity?.fingerprint).toBe(FINGERPRINT);
  });
});
