/**
 * The judgement calls in Microsoft sign-in, without a browser or a network.
 *
 * The state check and the reauth verdict are the two that matter most: the
 * first is what stops a forged redirect signing the user into someone else's
 * mailbox, the second is what stops a dropped connection signing them out of
 * their own.
 */
import {
  addressFromProfile,
  authorizeUrl,
  base64UrlFromBase64,
  credentialKey,
  isReauthError,
  photoDataUri,
  readRedirect,
  redirectParams,
} from '../microsoftToken';

describe('the profile photo', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  it('becomes a data URI the avatar can load without a token', () => {
    expect(photoDataUri(jpeg, 'image/jpeg')).toBe('data:image/jpeg;base64,/9j/4AECAw==');
  });

  it('assumes JPEG when Graph names no type, which is what it serves', () => {
    expect(photoDataUri(jpeg, null)).toMatch(/^data:image\/jpeg;base64,/);
  });

  /** An error body that slipped through as bytes must not render as a broken image. */
  it('refuses anything that is not an image', () => {
    expect(photoDataUri(jpeg, 'application/json; charset=utf-8')).toBeUndefined();
  });

  it('refuses nothing at all, and a picture too big to keep on the account', () => {
    expect(photoDataUri(new Uint8Array(0), 'image/jpeg')).toBeUndefined();
    expect(photoDataUri(new Uint8Array(200 * 1024), 'image/jpeg')).toBeUndefined();
  });
});

describe('the authorize request', () => {
  const url = authorizeUrl({
    authority: 'https://login.microsoftonline.com/common/oauth2/v2.0',
    clientId: 'client-1',
    redirectUri: 'cryptmail://auth',
    scopes: ['openid', 'offline_access', 'https://graph.microsoft.com/Mail.Send'],
    challenge: 'CHALLENGE',
    state: 'STATE',
  });
  const params = redirectParams(url);

  it('uses PKCE with S256, never the plain method', () => {
    expect(params.code_challenge).toBe('CHALLENGE');
    expect(params.code_challenge_method).toBe('S256');
  });

  it('asks for an account picker, so adding a mailbox cannot re-add the current one', () => {
    expect(params.prompt).toBe('select_account');
  });

  it('carries the redirect, the state and the scopes intact', () => {
    expect(url.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?')).toBe(true);
    expect(params.redirect_uri).toBe('cryptmail://auth');
    expect(params.state).toBe('STATE');
    expect(params.scope).toBe('openid offline_access https://graph.microsoft.com/Mail.Send');
  });
});

describe('the redirect', () => {
  it('yields the code when the state matches', () => {
    expect(readRedirect('cryptmail://auth?code=abc%2Fdef&state=S1', 'S1')).toEqual({ kind: 'code', code: 'abc/def' });
  });

  it('refuses a code whose state does not match the request', () => {
    expect(readRedirect('cryptmail://auth?code=abc&state=forged', 'S1').kind).toBe('error');
    expect(readRedirect('cryptmail://auth?code=abc', 'S1').kind).toBe('error');
  });

  it('treats a declined consent as a cancel, not a failure', () => {
    expect(readRedirect('cryptmail://auth?error=access_denied&state=S1', 'S1')).toEqual({ kind: 'cancelled' });
  });

  it('reports any other error with its description', () => {
    const outcome = readRedirect('cryptmail://auth?error=invalid_request&error_description=bad+scope&state=S1', 'S1');
    expect(outcome).toEqual({ kind: 'error', message: 'bad scope' });
  });

  it('reads parameters from the fragment as well as the query', () => {
    expect(redirectParams('http://localhost:8081/#code=c1&state=s1')).toEqual({ code: 'c1', state: 's1' });
  });
});

describe('which address a mailbox is', () => {
  it('prefers the SMTP address over the sign-in name', () => {
    expect(addressFromProfile({ mail: 'Kim@Contoso.com', userPrincipalName: 'kim_upn@contoso.onmicrosoft.com' })).toBe(
      'kim@contoso.com',
    );
  });

  it('falls back to the sign-in name, which is the address for a personal account', () => {
    expect(addressFromProfile({ mail: null, userPrincipalName: 'someone@outlook.com' })).toBe('someone@outlook.com');
  });

  it('is empty when the account has neither', () => {
    expect(addressFromProfile({})).toBe('');
  });
});

describe('the keystore key', () => {
  it('uses only characters the keystore accepts', () => {
    expect(credentialKey('first.last+tag@outlook.com')).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('is the same for the same address however it is written, and different for another', () => {
    expect(credentialKey(' Me@Outlook.com ')).toBe(credentialKey('me@outlook.com'));
    expect(credentialKey('a+b@x.com')).not.toBe(credentialKey('a_b@x.com'));
  });
});

describe('whether a token error ends the session', () => {
  it.each(['invalid_grant', 'interaction_required', 'consent_required'])('%s means sign in again', (code) => {
    expect(isReauthError(code)).toBe(true);
  });

  /** A wrong "permanent" verdict signs the user out of a working mailbox. */
  it.each([undefined, '', 'temporarily_unavailable', 'server_error'])('%s is transient', (code) => {
    expect(isReauthError(code)).toBe(false);
  });
});

it('produces the URL-safe, unpadded base64 PKCE requires', () => {
  expect(base64UrlFromBase64('ab+c/d==')).toBe('ab-c_d');
});
