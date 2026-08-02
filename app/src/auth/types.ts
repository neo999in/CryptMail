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
  constructor(message: string, readonly code: 'cancelled' | 'not-configured' | 'failed') {
    super(message);
    this.name = 'AuthError';
  }
}
