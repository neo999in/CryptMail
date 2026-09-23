/**
 * The Level 2 email: an ordinary text message around an armored block, so any
 * mail system carries it — and the bridge that seals and opens it.
 */
import { parseRfc822, PLACEHOLDER_SUBJECT } from '../mime';
import { getNativeCore } from '../nativeCore';
import {
  buildQkdEnvelope,
  extractQkdArmor,
  isQkdMessage,
  levelName,
  qkdLevelOf,
  QKD_BEGIN,
  QKD_END,
} from '../qkd';

const BLOCK = `${QKD_BEGIN}\nLevel: 2\nCipher: AES-256-GCM, key from HKDF-SHA256 over a QKD key and the sender\nSAE: sae-1\nKey-ID: a-0001\n\nQUJD\n${QKD_END}\n`;

/** What an older version sent at Level 3, the one-time pad, which is gone. */
const LEVEL_3_BLOCK = `${QKD_BEGIN}\nLevel: 3\nCipher: one-time pad, HMAC-SHA256 with a QKD key\nSAE: sae-1\nKey-ID: a-0001\nKey-ID: b-0002\n\nQUJD\n${QKD_END}\n`;

describe('the Level 2 email', () => {
  const rfc822 = buildQkdEnvelope({ from: 'a@x.com', to: ['b@x.com'], armored: BLOCK, level: 2 });

  it('is plain text with the placeholder subject, so every client and every list treats it as encrypted mail', () => {
    const { headers } = parseRfc822(rfc822);
    expect(headers['content-type']).toMatch(/^text\/plain/);
    expect(headers['subject']).toBe(PLACEHOLDER_SUBJECT);
    expect(headers['x-cryptmail-security']).toMatch(/Level 2/);
  });

  it('carries the block, found again whole', () => {
    expect(isQkdMessage(rfc822)).toBe(true);
    expect(extractQkdArmor(rfc822)).toBe(BLOCK.trim());
    expect(qkdLevelOf(rfc822)).toBe(2);
    expect(isQkdMessage('Subject: hi\n\nplain')).toBe(false);
  });

  /**
   * Observed between two installs on 2026-09-20: every Level 2 and Level 3
   * message opened on the sending device and failed on the receiving one with
   * "damaged or incomplete". Gmail had re-encoded the body it was handed as
   * `7bit`, which is its right — and the failure is silent, because the markers
   * survive QP untouched while the base64 between them does not.
   */
  it('reads the block out of a body a provider re-encoded as quoted-printable', () => {
    // What Gmail stores: soft breaks at the line limit, and `=` written `=3D`.
    const qp = buildQkdEnvelope({ from: 'a@x.com', to: ['b@x.com'], armored: `${QKD_BEGIN}
Level: 2

QUJDRA=
${QKD_END}
`, level: 2 })
      .replace('Content-Transfer-Encoding: 7bit', 'Content-Transfer-Encoding: quoted-printable')
      .replace('QUJDRA=', 'QUJDRA=3D');

    // The markers alone would have found it before this decoded anything, and
    // handed back a block whose payload had been rewritten.
    expect(extractQkdArmor(qp)).toContain('QUJDRA=');
    expect(extractQkdArmor(qp)).not.toContain('=3D');
    expect(qkdLevelOf(qp)).toBe(2);
  });

  it('leaves a 7bit body exactly as it found it', () => {
    // Decoding cannot be guessed: a base64 line ending in `=` and a QP soft
    // break are the same two bytes, so only the declared encoding may decide.
    const padded = buildQkdEnvelope({ from: 'a@x.com', to: ['b@x.com'], armored: `${QKD_BEGIN}
Level: 2

QUJDRA=
${QKD_END}
`, level: 2 });
    expect(extractQkdArmor(padded)).toContain('QUJDRA=');
  });
});

describe('levels through the native bridge', () => {
  function bridge() {
    const calls: Record<string, unknown[]> = {};
    const record =
      (name: string, result: string) =>
      async (...args: unknown[]) => {
        calls[name] = args;
        return result;
      };
    const b = {
      generateIdentity: record('generateIdentity', '{}'),
      loadIdentity: async () => null,
      importPublicKey: record('importPublicKey', '{}'),
      encryptSign: record('encryptSign', '-----BEGIN PGP MESSAGE-----\n\nQUJD\n-----END PGP MESSAGE-----'),
      decryptVerify: record('decryptVerify', '{}'),
      seal: record('seal', JSON.stringify({ armored: '-----BEGIN PGP MESSAGE-----\nCryptMail-Session: A\n\nQQ==\n-----END PGP MESSAGE-----', forwardSecret: true })),
      qkdSeal: record('qkdSeal', BLOCK),
      qkdOpen: record(
        'qkdOpen',
        JSON.stringify({ plaintext: 'Subject: Launch\r\nContent-Type: text/plain\r\n\r\nAt noon.', level: 2, senderSae: 'sae-1' }),
      ),
      kmStatus: record('kmStatus', JSON.stringify({ account: 'a@x.com', available: 100 })),
      kmExportLink: record('kmExportLink', '-----BEGIN CRYPTMAIL KM LINK-----'),
    };
    return { core: getNativeCore(b)!, calls };
  }
  const request = { from: 'a@x.com', to: ['b@x.com'], subject: 'Launch', body: 'At noon.', recipientKeys: ['k'] };

  it('Level 2 goes to the Key Manager with no recipient key, and never to the PGP paths', async () => {
    const { core, calls } = bridge();
    const rfc822 = await core.buildEncrypted({ ...request, recipientKeys: [], level: 2 });
    expect(calls.qkdSeal?.[0]).toBe('a@x.com');
    expect(calls.qkdSeal?.[1]).toBe(2);
    expect(String(calls.qkdSeal?.[2])).toContain('Subject: Launch');
    expect(calls.encryptSign).toBeUndefined();
    expect(isQkdMessage(rfc822)).toBe(true);
    expect(rfc822).not.toContain('At noon.');
  });

  it('Level 1 — the default — is standard OpenPGP to long-term keys', async () => {
    const { core, calls } = bridge();
    await core.buildEncrypted(request);
    expect(calls.encryptSign).toBeDefined();
  });

  it('opens a Level 2 email with the signed-in mailbox’s Key Manager, and reports the level', async () => {
    const { core, calls } = bridge();
    const rfc822 = buildQkdEnvelope({ from: 'b@x.com', to: ['a@x.com'], armored: BLOCK, level: 2 });
    expect(core.looksEncrypted(rfc822)).toBe(true);
    const opened = await core.parseEncrypted(rfc822, 'a@x.com');
    expect(calls.qkdOpen?.[0]).toBe('a@x.com');
    expect(opened).toMatchObject({ subject: 'Launch', securityLevel: 2, forwardSecret: true, signature: 'none' });
  });

  it('refuses a Level 3 email in its own words, without asking the Key Manager', async () => {
    const { core, calls } = bridge();
    const rfc822 = buildQkdEnvelope({ from: 'b@x.com', to: ['a@x.com'], armored: LEVEL_3_BLOCK, level: 2 });
    await expect(core.parseEncrypted(rfc822, 'a@x.com')).rejects.toThrow(/Level 3, the one-time pad/);
    expect(calls.qkdOpen).toBeUndefined();
  });

  it('asks the Key Manager as the signed-in mailbox, and makes the link code here', async () => {
    const { core, calls } = bridge();
    expect((await core.kmStatus('a@x.com')).available).toBe(100);
    expect(calls.kmStatus).toEqual(['a@x.com']);
    const link = await core.kmExportLink('a@x.com');
    expect(link.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    expect(calls.kmExportLink).toEqual(['a@x.com', link.code.replace(/-/g, '')]);
  });

  it('explains running out of quantum keys in words', async () => {
    const { core } = bridge();
    const failing = getNativeCore({
      ...(core as unknown as object),
      generateIdentity: async () => '{}',
      loadIdentity: async () => null,
      importPublicKey: async () => '{}',
      encryptSign: async () => '',
      decryptVerify: async () => '{}',
      qkdSeal: async () => {
        throw Object.assign(new Error('no-key: no-qkd-keys: this needs 9 quantum keys'), { code: 'no-key' });
      },
    })!;
    await expect(failing.buildEncrypted({ ...request, level: 2 })).rejects.toThrow(/no quantum keys left/);
  });
});

describe('Level 3 is gone', () => {
  it('cannot be picked — only 1 and 2 are offered', () => {
    const { LEVEL_GROUPS } = jest.requireActual('../qkd');
    const offered = LEVEL_GROUPS.flatMap((g: { levels: number[] }) => g.levels);
    expect(offered).toEqual([1, 2]);
  });

  it('is still named, for the archived copies that still open', () => {
    expect(levelName(3)).toMatch(/Level 3.*removed/);
    expect(levelName(2)).toBe('Level 2 — Quantum');
  });
});
