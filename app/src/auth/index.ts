import { googleAuth } from './googleAuth';
import { AuthProvider } from './types';

/**
 * Sign-in is Google, always.
 *
 * This used to choose between `googleAuth` and a fixture provider based on
 * whether a client id was configured, which meant a missing `.env` silently
 * signed the user into a fake identity with a fake mailbox instead of telling
 * them the app was not set up. `googleAuth.signIn()` now raises
 * `AuthError('not-configured')` in that case and the Connect screen states the
 * fix, so the failure is visible and actionable rather than disguised as a
 * working inbox.
 */
export const auth: AuthProvider = googleAuth;

export * from './types';
