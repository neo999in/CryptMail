export type Provider = 'gmail' | 'outlook' | 'imap';

export type Session = {
  provider: Provider;
  email: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  /**
   * The account's display name and avatar, as the provider reports them.
   *
   * Both come back from the sign-in that already happened — no extra call and
   * no extra scope — which is the only reason they are here: a profile worth a
   * network request of its own would not be worth it, since the switcher works
   * perfectly well on initials.
   *
   * Optional at every layer below, because a provider that has neither is
   * ordinary, not broken.
   */
  name?: string;
  photo?: string;
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
   * Every session this device can still use, in the order asked for.
   *
   * Boot restores all of them so a second mailbox does not vanish when the app
   * is closed. `known` names the addresses this device has connected before,
   * because the provider cannot discover them: Play services will silently
   * restore whichever account it is *asked* for, but it does not enumerate the
   * grants an app holds. The list comes from `accountsStore`, which is already
   * the record of which mailboxes this device has, rather than from a second
   * copy kept down here that could disagree with it.
   *
   * An empty list means "restore whoever is in front", which is what a first
   * launch — and an install that predates multi-account — needs.
   *
   * An address that cannot be restored is **omitted**, not thrown for: one
   * revoked grant must not cost the user the other mailbox that still works.
   * A failure that leaves nothing at all restored does throw, so an offline
   * boot still reaches the user as an error rather than as "signed out".
   */
  restoreAll(known?: string[]): Promise<Session[]>;
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
