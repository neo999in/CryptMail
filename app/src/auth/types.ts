export type Provider = 'gmail' | 'outlook' | 'imap' | 'demo';

export type Session = {
  provider: Provider;
  email: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
};

export interface AuthProvider {
  readonly provider: Provider;
  /**
   * Sign in to *another* mailbox, in addition to any already connected.
   *
   * Adding rather than replacing is the whole of multi-account at this layer:
   * the app can hold several sessions at once and `state/accounts.ts` decides
   * which one is in front.
   */
  signIn(): Promise<Session>;
  /**
   * Every session this device can still use, oldest first.
   *
   * Boot restores all of them so a second mailbox does not vanish when the app
   * is closed. A provider that can only hold one returns an array of one.
   */
  restoreAll(): Promise<Session[]>;
  /** Drop one account's session, or every one when no address is given. */
  signOut(email?: string): Promise<void>;
  /**
   * A valid access token for one account, refreshing if needed.
   *
   * Takes the address because a device with two mailboxes has two grants, and
   * handing the Gmail client the wrong one would read the wrong inbox.
   */
  freshAccessToken(email: string): Promise<string>;
}

export class AuthError extends Error {
  constructor(
    message: string,
    /**
     * `reauth-required` is distinct from `failed` on purpose. It means the
     * grant is gone for good — revoked in the Google account, expired, or the
     * password changed — so the only way forward is a new sign-in. `failed`
     * covers everything that might succeed on the next try, and being offline
     * must never be treated as a revocation: that would sign the user out of a
     * working account every time the network dropped.
     */
    readonly code: 'cancelled' | 'not-configured' | 'failed' | 'reauth-required',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Whether an error means the user has to sign in again. */
export function needsReauth(error: unknown): boolean {
  return error instanceof AuthError && error.code === 'reauth-required';
}
