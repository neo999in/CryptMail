/**
 * The IMAP provider holds a password, so the rules that matter are about when
 * it is kept: only after both servers accepted it, only in the keystore, and
 * gone on sign-out.
 */
import { FakeImapServer, FakeSmtpServer } from '../../mail/__tests__/fakeServers';
import { ImapAccount } from '../../mail/imap';

const mockKeystore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => mockKeystore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void mockKeystore.set(k, v),
  deleteItemAsync: async (k: string) => void mockKeystore.delete(k),
}));

let mockImap: FakeImapServer;
let mockSmtp: FakeSmtpServer;
jest.mock('../../mail/tcpSocket', () => ({
  hasSocketModule: true,
  openTcpSocket: (target: { port: number; host: string; tls: boolean }) =>
    target.port === 465 ? mockSmtp.open(target) : mockImap.open(target),
}));

// Required after the mocks, so it binds to them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { imapAuth, imapCredentialKey } = require('../imapAuth') as typeof import('../imapAuth');

const account: ImapAccount = {
  imap: { host: 'imap.example.org', port: 993, security: 'tls' },
  smtp: { host: 'smtp.example.org', port: 465, security: 'tls' },
  username: 'me@example.org',
  saveSentCopy: true,
};

beforeEach(() => {
  mockKeystore.clear();
  mockImap = new FakeImapServer();
  mockSmtp = new FakeSmtpServer();
});

it('keeps the password only once both servers accepted it', async () => {
  const session = await imapAuth.signInWith({ email: 'Me@Example.org', password: 'secret', account });
  expect(session).toMatchObject({ provider: 'imap', email: 'me@example.org', accessToken: '' });
  // Nothing secret rides on the session, which flows into app state.
  expect(JSON.stringify(session)).not.toContain('secret');
  expect(await imapAuth.credentialFor('me@example.org')).toEqual({ account, password: 'secret' });
});

it('saves nothing when reading works but sending is refused', async () => {
  mockSmtp = new FakeSmtpServer({ password: 'different' });
  const error = await imapAuth.signInWith({ email: 'me@example.org', password: 'secret', account }).catch((e) => e);
  expect(error.code).toBe('failed');
  expect(error.message).toMatch(/refused the same username and password for sending/);
  expect(mockKeystore.has(imapCredentialKey('me@example.org'))).toBe(false);
});

it('names app-specific passwords when the password is refused', async () => {
  mockImap = new FakeImapServer({ password: 'different' });
  const error = await imapAuth.signInWith({ email: 'me@example.org', password: 'secret', account }).catch((e) => e);
  expect(error.message).toMatch(/app-specific password/);
  expect(mockKeystore.size).toBe(0);
});

it('restores from the keystore alone, without touching the network', async () => {
  await imapAuth.signInWith({ email: 'me@example.org', password: 'secret', account });
  const before = mockImap.connections;
  const sessions = await imapAuth.restoreAll(['me@example.org']);
  expect(sessions.map((s) => s.email)).toEqual(['me@example.org']);
  expect(mockImap.connections).toBe(before);
});

it('reports a mailbox with no stored password as needing sign-in', async () => {
  await expect(imapAuth.restoreAll(['gone@example.org'])).rejects.toMatchObject({ code: 'reauth-required' });
  await expect(imapAuth.credentialFor('gone@example.org')).rejects.toMatchObject({ code: 'reauth-required' });
});

it('forgets the password on sign-out, one mailbox or all', async () => {
  await imapAuth.signInWith({ email: 'a@example.org', password: 'secret', account });
  await imapAuth.signInWith({ email: 'b@example.org', password: 'secret', account });

  await imapAuth.signOut('a@example.org');
  await expect(imapAuth.credentialFor('a@example.org')).rejects.toMatchObject({ code: 'reauth-required' });
  expect(await imapAuth.savedAccount('b@example.org')).toEqual(account);

  await imapAuth.signOut();
  expect([...mockKeystore.keys()].filter((k) => k !== 'cryptmail.imap.v1.index')).toEqual([]);
});
