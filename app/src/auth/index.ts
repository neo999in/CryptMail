import { googleAuth } from './googleAuth';
import { AuthProvider } from './types';

/**
 * The one way in.
 *
 * There used to be a `demoAuth` here, chosen when no OAuth client was
 * configured, which signed the user into a fixture mailbox. Nothing falls back
 * now: a build with no client id cannot sign in, and `degradedReason()` says
 * why instead of quietly handing over a mailbox that is not theirs.
 */
export const auth: AuthProvider = googleAuth;

export * from './types';
