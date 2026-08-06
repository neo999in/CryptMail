/**
 * The native core is MIME-in-TypeScript plus crypto-in-Rust. These tests drive
 * it against a fake bridge, so they cover the composition — which is where the
 * bugs would be — without needing the Rust module linked.
 *
 * What they are really protecting: the demo and native cores must produce the
 * *same* envelope, or swapping one for the other changes what lands in a
 * mailbox. That is the promise `core/index.ts` makes when it picks between them.
 */
import { NativeModules } from 'react-native';

import { demoCore } from '../demoCore';
import { PLACEHOLDER_SUBJECT, parseRfc822 } from '../mime';
import { getNativeCore, NATIVE_MODULE_NAME } from '../nativeCore';
import { CryptCore } from '../types';

/** Stand-in for Rust: records what it was asked to encrypt, returns fake armor. */
function fakeBridge() {
  const calls: { encryptSign?: { email: string; plaintext: string; keys: string[] } } = {};
  let lastPlaintext = '';

  return {
    calls,
    generateIdentity: jest.fn(async (email: string) =>
      JSON.stringify({
        email,
        fingerprint: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555',
        publicKeyArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----',
        createdAt: '2026-08-05T00:00:00.000Z',
      }),
    ),
    loadIdentity: jest.fn(async () => null),
    importPublicKey: jest.fn(async (armored: string) =>
      JSON.stringify({ email: 'bob@example.com', fingerprint: 'FFFF', armored }),
    ),
    encryptSign: jest.fn(async (email: string, plaintext: string, recipientKeysJson: string) => {
      calls.encryptSign = { email, plaintext, keys: JSON.parse(recipientKeysJson) };
      lastPlaintext = plaintext;
      return `-----BEGIN PGP MESSAGE-----\n\nZmFrZQ==\n=Ab3D\n-----END PGP MESSAGE-----`;
    }),
    decryptVerify: jest.fn(async () =>
      JSON.stringify({ plaintext: lastPlaintext, signature: 'valid', signerFingerprint: 'FFFF' }),
    ),
  };
}

function withBridge(): { core: CryptCore; bridge: ReturnType<typeof fakeBridge> } {
  const bridge = fakeBridge();
  (NativeModules as Record<string, unknown>)[NATIVE_MODULE_NAME] = bridge;
  const core = getNativeCore();
  if (!core) throw new Error('expected a native core once the module is registered');
  return { core, bridge };
}

afterEach(() => {
  delete (NativeModules as Record<string, unknown>)[NATIVE_MODULE_NAME];
});

describe('getNativeCore', () => {
  it('is null when the module is not registered, so the app falls back to demo', () => {
    expect(getNativeCore()).toBeNull();
  });

  it('reports kind "native" so the UI can stop calling itself a demo', () => {
    expect(withBridge().core.kind).toBe('native');
  });
});

describe('buildEncrypted', () => {
  const request = {
    from: 'alice@example.com',
    to: ['bob@example.com'],
    subject: 'Lunch on Friday?',
    body: 'Are we still on for noon?',
    recipientKeys: ['-----BEGIN PGP PUBLIC KEY BLOCK-----\nbob\n-----END PGP PUBLIC KEY BLOCK-----'],
  };

  it('hides the real subject and body behind the placeholder', async () => {
    const { core } = withBridge();
    const rfc822 = await core.buildEncrypted(request);
    const { headers } = parseRfc822(rfc822);

    expect(headers['subject']).toBe(PLACEHOLDER_SUBJECT);
    expect(rfc822).not.toContain('Lunch on Friday?');
    expect(rfc822).not.toContain('Are we still on for noon?');
  });

  it('sends the real subject to the core inside the protected tree, not the envelope', async () => {
    const { core, bridge } = withBridge();
    await core.buildEncrypted(request);

    expect(bridge.calls.encryptSign?.plaintext).toContain('Subject: Lunch on Friday?');
    expect(bridge.calls.encryptSign?.plaintext).toContain('protected-headers="v1"');
    expect(bridge.calls.encryptSign?.email).toBe('alice@example.com');
  });

  it('passes every recipient key through to the core', async () => {
    const { core, bridge } = withBridge();
    await core.buildEncrypted({ ...request, recipientKeys: ['key-a', 'key-b'] });
    expect(bridge.calls.encryptSign?.keys).toEqual(['key-a', 'key-b']);
  });

  it('refuses to build with no recipient keys rather than sending something readable', async () => {
    const { core, bridge } = withBridge();
    await expect(core.buildEncrypted({ ...request, recipientKeys: [] })).rejects.toThrow(/no recipient keys/i);
    expect(bridge.encryptSign).not.toHaveBeenCalled();
  });

  it('emits the sender key as an Autocrypt header when given one', async () => {
    const { core } = withBridge();
    const rfc822 = await core.buildEncrypted({ ...request, autocryptKey: 'PUBKEY' });
    expect(parseRfc822(rfc822).headers['autocrypt']).toContain('addr=alice@example.com');
  });
});

describe('envelope parity with the demo core', () => {
  // The swap in core/index.ts is only safe if both cores put the same structure
  // on the wire. Compare everything except the armored payload itself.
  it('produces the same headers and MIME structure as demoCore', async () => {
    const request = {
      from: 'alice@example.com',
      to: ['bob@example.com'],
      subject: 'Lunch on Friday?',
      body: 'Are we still on for noon?',
      recipientKeys: ['-----BEGIN PGP PUBLIC KEY BLOCK-----\nbob\n-----END PGP PUBLIC KEY BLOCK-----'],
    };

    const { core } = withBridge();
    const native = parseRfc822(await core.buildEncrypted(request));
    const demo = parseRfc822(await demoCore.buildEncrypted(request));

    expect(native.headers['subject']).toBe(demo.headers['subject']);
    expect(native.headers['mime-version']).toBe(demo.headers['mime-version']);
    // Boundaries are random per message, so compare the content type without it.
    const withoutBoundary = (ct: string) => ct.replace(/boundary="[^"]*"/, 'boundary="X"');
    expect(withoutBoundary(native.headers['content-type'])).toBe(
      withoutBoundary(demo.headers['content-type']),
    );

    for (const marker of [
      'application/pgp-encrypted',
      'Version: 1',
      'OpenPGP encrypted message',
      'filename="encrypted.asc"',
    ]) {
      expect(native.body).toContain(marker);
      expect(demo.body).toContain(marker);
    }
  });
});

describe('parseEncrypted', () => {
  it('round-trips the protected subject and body back out', async () => {
    const { core } = withBridge();
    const rfc822 = await core.buildEncrypted({
      from: 'alice@example.com',
      to: ['bob@example.com'],
      subject: 'Lunch on Friday?',
      body: 'Are we still on for noon?',
      recipientKeys: ['key'],
    });

    const opened = await core.parseEncrypted(rfc822);
    expect(opened.subject).toBe('Lunch on Friday?');
    expect(opened.body).toBe('Are we still on for noon?');
    expect(opened.signature).toBe('valid');
    expect(opened.signerFingerprint).toBe('FFFF');
  });

  it('does not ask the core to identify itself from the envelope', async () => {
    // Regression guard: reading our own address out of To:/Cc: breaks on any
    // multi-recipient message. The native side uses the identity it holds.
    const { core, bridge } = withBridge();
    const rfc822 = await core.buildEncrypted({
      from: 'alice@example.com',
      to: ['bob@example.com', 'carol@example.com'],
      subject: 's',
      body: 'b',
      recipientKeys: ['key'],
    });
    await core.parseEncrypted(rfc822);

    expect(bridge.decryptVerify).toHaveBeenCalledTimes(1);
    const [armored, senderKeysJson] = bridge.decryptVerify.mock.calls[0] as unknown as [string, string];
    expect(armored).toContain('BEGIN PGP MESSAGE');
    expect(() => JSON.parse(senderKeysJson)).not.toThrow();
  });

  it('throws when there is no armored block to decrypt', async () => {
    const { core } = withBridge();
    await expect(core.parseEncrypted('Subject: hi\n\nplain text')).rejects.toThrow(/no pgp message/i);
  });

  it('hands the sender Autocrypt key to the core as a verification candidate', async () => {
    const { core, bridge } = withBridge();
    const rfc822 = await core.buildEncrypted({
      from: 'alice@example.com',
      to: ['bob@example.com'],
      subject: 's',
      body: 'b',
      recipientKeys: ['key'],
      autocryptKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nalice\n-----END PGP PUBLIC KEY BLOCK-----',
    });

    const opened = await core.parseEncrypted(rfc822);
    expect(opened.autocryptKey).toContain('BEGIN PGP PUBLIC KEY BLOCK');

    const [, senderKeysJson] = bridge.decryptVerify.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(senderKeysJson)).toHaveLength(1);
  });

  it('survives a malformed Autocrypt header rather than failing to open the message', async () => {
    const { core } = withBridge();
    const rfc822 = await core.buildEncrypted({
      from: 'alice@example.com',
      to: ['bob@example.com'],
      subject: 's',
      body: 'b',
      recipientKeys: ['key'],
    });
    const broken = rfc822.replace('MIME-Version: 1.0', 'Autocrypt: addr=alice@example.com; keydata=!!!not-base64!!!\nMIME-Version: 1.0');

    const opened = await core.parseEncrypted(broken);
    expect(opened.body).toBe('b');
    expect(opened.autocryptKey).toBeUndefined();
  });
});

describe('looksEncrypted', () => {
  it('recognises a PGP/MIME envelope and ignores plain mail', async () => {
    const { core } = withBridge();
    const rfc822 = await core.buildEncrypted({
      from: 'a@x.com',
      to: ['b@x.com'],
      subject: 's',
      body: 'b',
      recipientKeys: ['key'],
    });
    expect(core.looksEncrypted(rfc822)).toBe(true);
    expect(core.looksEncrypted('Subject: hi\n\nnot encrypted')).toBe(false);
  });
});
