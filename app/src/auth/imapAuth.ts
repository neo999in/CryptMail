/**
 * Sign-in for a generic IMAP/SMTP mailbox: an address, a password, and the two
 * servers it works against.
 *
 * This is the one provider where CryptMail holds the user's **password** rather
 * than a revocable grant, and everything here follows from that:
 *
 *  - It goes to the OS keystore (`expo-secure-store`), one entry per mailbox,
 *    and nowhere else — never onto `Session`, which flows into app state, and
 *    never into the account registry. There is no AsyncStorage fallback: the
 *    one platform without a keystore (web) cannot open a socket either, so it
 *    never reaches here.
 *  - It is only kept once it has **worked**: signing in logs in to the IMAP
 *    server and authenticates to the SMTP server, over TLS, before anything is
 *    saved. A typo is found at the form, not at the first send.
 *  - It is only ever sent inside TLS, to the hosts saved beside it
 *    (`mail/imapConnection.ts`, `mail/smtp.ts`).
 *  - Signing out deletes it. There is nothing to revoke at the provider — which
 *    is why the setup sheet steers toward app-specific passwords, the one kind
 *    the user *can* revoke on their own.
 *
 * Restoring at launch reads the keystore and nothing else: no network, so an
 * offline boot still opens the mailbox. A password changed elsewhere is found
 * by the first sync, which reports it as `reauth-required` (`mail/imap.ts`).
 */
import * as SecureStore from 'expo-secure-store';

import { ImapAccount } from '../mail/imap';
import { connectImap, ImapError } from '../mail/imapConnection';
import { SmtpError, verifySmtp } from '../mail/smtp';
import { OpenSocket, TransportError } from '../mail/socket';
import { openTcpSocket } from '../mail/tcpSocket';
import { AuthError, AuthProvider, Session } from './types';

/** What the setup sheet hands over. */
export type ImapSignIn = {
  email: string;
  password: string;
  account: ImapAccount;
  /** The name to show for this mailbox, if the user gave one. */
  name?: string;
};

type Credential = { account: ImapAccount; password: string; name?: string };

const normalise = (email: string) => email.trim().toLowerCase();

/** SecureStore keys allow `[A-Za-z0-9._-]` only, so the address goes in as hex. */
export function imapCredentialKey(email: string): string {
  let hex = '';
  for (const b of new TextEncoder().encode(normalise(email))) hex += b.toString(16).padStart(2, '0');
  return `cryptmail.imap.v1.${hex}`;
}

/** Every address with a stored credential, so a blanket sign-out can find them. */
const INDEX_KEY = 'cryptmail.imap.v1.index';

async function readIndex(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(INDEX_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

async function loadCredential(email: string): Promise<Credential | null> {
  const raw = await SecureStore.getItemAsync(imapCredentialKey(email));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Credential;
  } catch {
    return null;
  }
}

async function saveCredential(email: string, credential: Credential) {
  await SecureStore.setItemAsync(imapCredentialKey(email), JSON.stringify(credential));
  const index = await readIndex();
  if (!index.includes(email)) await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...index, email]));
}

async function forget(email: string) {
  await SecureStore.deleteItemAsync(imapCredentialKey(email));
  const index = await readIndex();
  if (index.includes(email)) await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(index.filter((e) => e !== email)));
}

function sessionFor(email: string, credential: Credential): Session {
  return {
    provider: 'imap',
    email,
    // There is no token. The client reads the password from the keystore on
    // each connect (`credentialFor`), so nothing secret rides on the session.
    accessToken: '',
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...(credential.name ? { name: credential.name } : {}),
  };
}

/** A sign-in failure the user can act on, in their words rather than the server's. */
function describeSignInFailure(e: unknown, account: ImapAccount): AuthError {
  if (e instanceof ImapError && e.kind === 'auth') {
    return new AuthError(
      `${account.imap.host} refused the username or password. iCloud, Yahoo and many others need an app-specific password here, not the one you sign in to their website with.`,
      'failed',
    );
  }
  if (e instanceof SmtpError && e.kind === 'auth') {
    return new AuthError(
      `Reading mail works, but ${account.smtp.host} refused the same username and password for sending. Check the outgoing server settings.`,
      'failed',
    );
  }
  if (e instanceof ImapError || e instanceof SmtpError || e instanceof TransportError) {
    return new AuthError(e.message, 'failed');
  }
  return new AuthError(e instanceof Error ? e.message : String(e), 'failed');
}

/** Prove the settings: log in to both servers over TLS, send nothing, keep nothing. */
export async function verifyImapSignIn(open: OpenSocket, details: ImapSignIn): Promise<void> {
  const { account, password } = details;
  try {
    const connection = await connectImap(open, account.imap, account.username, password);
    await connection.logout();
    await verifySmtp(open, account.smtp, account.username, password);
  } catch (e) {
    throw describeSignInFailure(e, account);
  }
}

export const imapAuth: AuthProvider & {
  signInWith(details: ImapSignIn): Promise<Session>;
  /** The saved servers for a mailbox — without the password — to prefill a re-sign-in. */
  savedAccount(email: string): Promise<ImapAccount | null>;
  /** What the connector needs to connect: the servers and the password. */
  credentialFor(email: string): Promise<{ account: ImapAccount; password: string }>;
} = {
  provider: 'imap',

  async signIn(): Promise<Session> {
    throw new AuthError('An IMAP mailbox needs its server details to sign in.', 'not-configured');
  },

  async signInWith(details) {
    if (!openTcpSocket) {
      throw new AuthError('This build cannot open a connection to a mail server (no socket module).', 'not-configured');
    }
    const email = normalise(details.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('That is not an email address.', 'failed');
    if (!details.password) throw new AuthError('Enter the password for this mailbox.', 'failed');

    await verifyImapSignIn(openTcpSocket, { ...details, email });
    const credential: Credential = {
      account: details.account,
      password: details.password,
      ...(details.name?.trim() ? { name: details.name.trim() } : {}),
    };
    await saveCredential(email, credential);
    return sessionFor(email, credential);
  },

  async restoreAll(known: string[] = []) {
    const sessions: Session[] = [];
    const failures: unknown[] = [];
    for (const address of [...new Set(known.map(normalise).filter(Boolean))]) {
      const credential = await loadCredential(address).catch(() => null);
      if (credential) sessions.push(sessionFor(address, credential));
      else failures.push(new AuthError(`${address} is not signed in on this device.`, 'reauth-required'));
    }
    // As in the other providers: one working mailbox is a working app.
    if (sessions.length === 0 && failures.length > 0) throw failures[0];
    return sessions;
  },

  async signOut(email?: string) {
    const addresses = email ? [normalise(email)] : await readIndex();
    for (const address of addresses) await forget(address);
  },

  async freshAccessToken(): Promise<string> {
    throw new AuthError('An IMAP mailbox signs in with a password; it has no access token.', 'not-configured');
  },

  async savedAccount(email) {
    return (await loadCredential(normalise(email)).catch(() => null))?.account ?? null;
  },

  async credentialFor(email) {
    const credential = await loadCredential(normalise(email));
    if (!credential) throw new AuthError(`${email} is not signed in on this device.`, 'reauth-required');
    return { account: credential.account, password: credential.password };
  },
};
