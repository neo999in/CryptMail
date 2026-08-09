import { KEYSERVER_SENDER, verifyLinkFrom } from '../verifyLink';

/** The fingerprint of the key that was actually published. */
const OURS = 'CA7C3C2CEA146FAEC4F71A15CCE350E7794E8111';

const LINK = 'https://keys.openpgp.org/verify/ZWoNyoqHMrK0hVJk0PT1hKz62tvob6yeWOF2gYV7Rjr';

/**
 * The real mail, captured from `keys.openpgp.org` on 2026-08-09. Note that it
 * also contains `/about` and would defeat "the first keys.openpgp.org URL".
 */
const REAL_BODY = [
  'Hi,',
  'This is an automated message from keys.openpgp.org. …',
  `OpenPGP key: ${OURS}`,
  'To let others find this key from your email address "neotestmail9@gmail.com",',
  'please follow the link below:',
  `  ${LINK}`,
  'You can find more info at https://keys.openpgp.org/about',
].join('\n');

const check = (over: Partial<{ from: string; body: string; fingerprint: string }> = {}) =>
  verifyLinkFrom({ from: KEYSERVER_SENDER, body: REAL_BODY, fingerprint: OURS, ...over });

describe('verifyLinkFrom', () => {
  test('finds the link in the real confirmation email', () => {
    expect(check()).toBe(LINK);
  });

  test('picks the verify link over the /about decoy', () => {
    expect(check()).not.toContain('/about');
  });

  test('accepts a From with a display name around the address', () => {
    expect(check({ from: `keys.openpgp.org <${KEYSERVER_SENDER}>` })).toBe(LINK);
  });

  test('accepts the fingerprint printed in readable groups', () => {
    expect(check({ body: REAL_BODY.replace(OURS, 'CA7C 3C2C EA14 6FAE C4F7 1A15 CCE3 50E7 794E 8111') })).toBe(LINK);
  });

  test('accepts a fingerprint the transport soft-wrapped across two lines', () => {
    expect(check({ body: REAL_BODY.replace(OURS, `${OURS.slice(0, 20)}\n${OURS.slice(20)}`) })).toBe(LINK);
  });

  /* ------------------------------------------------------- check 1: from --- */

  test('rejects a different sender', () => {
    expect(check({ from: 'keyserver@keys.openpgp.org.evil.example' })).toBeNull();
    expect(check({ from: 'noreply@keys.openpgp.org' })).toBeNull();
    expect(check({ from: 'attacker@example.com' })).toBeNull();
  });

  /* ------------------------------------------- check 2: our fingerprint ---- */

  test("rejects a confirmation for somebody else's key", () => {
    expect(check({ fingerprint: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555' })).toBeNull();
  });

  test('rejects a body that names no fingerprint at all', () => {
    expect(check({ body: `Follow the link below:\n  ${LINK}` })).toBeNull();
  });

  test('rejects a fingerprint too short to mean anything', () => {
    // Without a floor, "the body contains our fingerprint" is true of every body.
    expect(check({ fingerprint: '' })).toBeNull();
    expect(check({ fingerprint: 'CA7C' })).toBeNull();
  });

  /* ---------------------------------------------------- check 3: the URL --- */

  test('rejects a look-alike host', () => {
    expect(check({ body: REAL_BODY.replace('keys.openpgp.org/verify', 'keys.openpgp.org.evil.example/verify') })).toBeNull();
  });

  test('rejects a host smuggled in as userinfo', () => {
    expect(
      check({ body: REAL_BODY.replace('https://keys.openpgp.org/verify', 'https://keys.openpgp.org@evil.example/verify') }),
    ).toBeNull();
  });

  test('rejects a keyserver URL that is not a verify path', () => {
    expect(check({ body: `${OURS}\nhttps://keys.openpgp.org/about\nhttps://keys.openpgp.org/search?q=/verify/x` })).toBeNull();
  });

  test('rejects a plain-http verify link', () => {
    expect(check({ body: REAL_BODY.replace('https://keys.openpgp.org/verify', 'http://keys.openpgp.org/verify') })).toBeNull();
  });

  test('rejects a body with no URL in it', () => {
    expect(check({ body: `OpenPGP key: ${OURS}\nnothing else here` })).toBeNull();
  });
});
