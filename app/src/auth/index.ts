import { canConnectGmail, canConnectImap, signInProviders } from '../config';
import { googleAuth } from './googleAuth';
import { imapAuth, ImapSignIn } from './imapAuth';
import { microsoftAuth } from './microsoftAuth';
import { AuthError, AuthProvider, Provider, Session } from './types';

/**
 * The one way in, for every provider.
 *
 * There used to be a `demoAuth` here, chosen when no OAuth client was
 * configured, which signed the user into a fixture mailbox. Nothing falls back
 * now: a build with no client id cannot sign in, and `degradedReason()` says
 * why instead of quietly handing over a mailbox that is not theirs.
 *
 * Each call names the provider of the mailbox it is about, because an address
 * alone does not say which grant to use. The provider is optional only for
 * the Gmail-era callers that predate a second one: with none given, sign-in
 * uses the first provider this build can reach, and everything else means
 * Gmail — which is what every account stored before Outlook existed is.
 */
export type Auth = {
  /**
   * `imap` is the one provider that cannot sign in from a button alone — it
   * needs the address, password and servers the setup sheet collected, and
   * refuses without them.
   */
  signIn(provider?: Provider, imap?: ImapSignIn): Promise<Session>;
  restoreAll(known?: string[], provider?: Provider): Promise<Session[]>;
  /** One mailbox's grant, or — with no address — every provider's. */
  signOut(email?: string, provider?: Provider): Promise<void>;
  freshAccessToken(email: string, provider?: Provider): Promise<string>;
};

function pick(provider: Provider = 'gmail'): AuthProvider {
  if (provider === 'outlook') return microsoftAuth;
  if (provider === 'gmail') return googleAuth;
  return imapAuth;
}

export const auth: Auth = {
  async signIn(provider = signInProviders[0], imap) {
    if (provider !== 'imap') return pick(provider).signIn();
    if (!imap) throw new AuthError('An IMAP mailbox needs its server details to sign in.', 'not-configured');
    return imapAuth.signInWith(imap);
  },

  async restoreAll(known, provider) {
    // Play services is a native module. Asking it for a Gmail mailbox on a
    // platform without it — the web build, where only Outlook can sign in —
    // throws instead of answering, which would turn an ordinary "not here" into
    // a boot error. Absent is the honest answer: the account is flagged, not lost.
    if ((provider ?? 'gmail') === 'gmail' && !canConnectGmail) return [];
    // Likewise an IMAP mailbox on a build that cannot open a socket.
    if (provider === 'imap' && !canConnectImap) return [];
    return pick(provider).restoreAll(known);
  },

  async signOut(email, provider) {
    if (email) return pick(provider).signOut(email);
    // Everything: each provider in turn, and a failure in one does not leave the
    // other's tokens behind. The first failure is still reported.
    const errors: unknown[] = [];
    for (const each of [canConnectGmail ? googleAuth : null, microsoftAuth, canConnectImap ? imapAuth : null]) {
      if (!each) continue;
      try {
        await each.signOut();
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length) throw errors[0];
  },

  freshAccessToken: (email, provider) => pick(provider).freshAccessToken(email),
};

export * from './types';
export type { ImapSignIn } from './imapAuth';
