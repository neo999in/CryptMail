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
  signIn(): Promise<Session>;
  restore(): Promise<Session | null>;
  signOut(): Promise<void>;
  /** Returns a valid access token, refreshing if needed. */
  freshAccessToken(): Promise<string>;
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
