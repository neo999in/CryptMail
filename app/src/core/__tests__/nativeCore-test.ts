/**
 * The native core is MIME-in-TypeScript plus crypto-in-Rust. These tests drive
 * it against a fake bridge, so they cover the composition — which is where the
 * bugs would be — without needing the Rust module linked.
 *
 * What they are really protecting: the demo and native cores must produce the
 * *same* envelope, or swapping one for the other changes what lands in a
 * mailbox. That is the promise `core/index.ts` makes when it picks between them.
 */
import { demoCore } from '../demoCore';
import { HANDSHAKE_SUBJECT, PLACEHOLDER_SUBJECT, parseRfc822 } from '../mime';
import { getNativeCore, NATIVE_MODULE_NAME } from '../nativeCore';
import { CoreError, CryptCore } from '../types';

/** Stand-in for Rust: records what it was asked to encrypt, returns fake armor. */
function fakeBridge() {
  const calls: { seal?: { email: string; plaintext: string; keys: string[] } } = {};
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
    // Kept on the bridge so a test can prove it is never used: per-email keys
    // only, so everything goes through `seal`.
    encryptSign: jest.fn(async () => `-----BEGIN PGP MESSAGE-----\n\nZmFrZQ==\n=Ab3D\n-----END PGP MESSAGE-----`),
    seal: jest.fn(async (email: string, plaintext: string, recipientKeysJson: string) => {
      calls.seal = { email, plaintext, keys: JSON.parse(recipientKeysJson) };
      lastPlaintext = plaintext;
      return JSON.stringify({
        armored: `-----BEGIN PGP MESSAGE-----\nCryptMail-Session: AAAA\n\nZmFrZQ==\n=Ab3D\n-----END PGP MESSAGE-----`,
        forwardSecret: true,
      });
    }),
    decryptVerify: jest.fn(async () =>
      JSON.stringify({ plaintext: lastPlaintext, signature: 'valid', signerFingerprint: 'FFFF' }),
    ),
    // The blob is a standard armored secret key locked under the code, and the
    // code is generated on this side and passed *down* — see the Rust half in
    // `core/src/recovery.rs`.
    exportRecoveryBackup: jest.fn(
      async (email: string, _code: string) =>
        `-----BEGIN PGP PRIVATE KEY BLOCK-----\nd3JhcHBlZDoke${email}}\n-----END PGP PRIVATE KEY BLOCK-----`,
    ),
    importRecoveryBackup: jest.fn(async () =>
      JSON.stringify({
        email: 'alice@example.com',
        fingerprint: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555',
        publicKeyArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----',
        createdAt: '2026-08-05T00:00:00.000Z',
      }),
    ),
  };
}

function withBridge(): { core: CryptCore; bridge: ReturnType<typeof fakeBridge> } {
  const bridge = fakeBridge();
  const core = getNativeCore(bridge);
  if (!core) throw new Error('expected a native core once the module is registered');
  return { core, bridge };
}

describe('getNativeCore', () => {
  it('is null when the module is not registered, so the app falls back to demo', () => {
    expect(getNativeCore(null)).toBeNull();
  });

  /**
   * The real lookup, unmocked. Under jest there is no Android runtime, so
   * `expo-modules-core` finds nothing — which is the same path the web build
   * takes, and it must yield the demo core rather than throwing.
   */
  it('resolves through expo-modules-core, not the legacy NativeModules registry', () => {
    expect(getNativeCore()).toBeNull();
  });

  it('reports kind "native" so the UI can stop calling itself a demo', () => {
    expect(withBridge().core.kind).toBe('native');
  });
});

describe('recovery', () => {
  /**
   * The JS bundle and the native library version separately — an OTA update
   * ships this TypeScript against whatever `.so` is already installed. Calling
   * a method the older Kotlin does not have would throw "is not a function",
   * which reads as a crash rather than a missing feature.
   */
  describe('against a native core built before recovery landed', () => {
    function withOlderBridge(): CryptCore {
      const bridge = fakeBridge();
      delete (bridge as Partial<typeof bridge>).exportRecoveryBackup;
      delete (bridge as Partial<typeof bridge>).importRecoveryBackup;
      const core = getNativeCore(bridge);
      if (!core) throw new Error('expected a native core once the module is registered');
      return core;
    }

    it('still loads, so the rest of the app keeps working', () => {
      expect(withOlderBridge().kind).toBe('native');
    });

    it('reports "unavailable" and names the upgrade, rather than crashing', async () => {
      const core = withOlderBridge();

      await expect(core.exportRecoveryBackup('alice@example.com')).rejects.toMatchObject({
        code: 'unavailable',
        message: expect.stringMatching(/newer version of the CryptMail crypto core/),
      });
      await expect(core.importRecoveryBackup('BLOB', 'CODE')).rejects.toMatchObject({
        code: 'unavailable',
      });
    });
  });
});

describe('recovery through the native bridge', () => {
  it('generates the code itself and hands the bridge the normalised form', async () => {
    const { core, bridge } = withBridge();

    const backup = await core.exportRecoveryBackup('me@example.com');

    expect(backup.blob).toContain('BEGIN PGP PRIVATE KEY BLOCK');
    // The code shown to the user is grouped, for writing down…
    expect(backup.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    // …but what Argon2 hashes is the bare 32 characters. If these two ever
    // disagree, every code shown to a user opens nothing.
    expect(bridge.exportRecoveryBackup).toHaveBeenCalledWith(
      'me@example.com',
      backup.code.replace(/-/g, ''),
    );
  });

  it('issues a different code every time, so one backup never unlocks another', async () => {
    const { core } = withBridge();
    const first = await core.exportRecoveryBackup('me@example.com');
    const second = await core.exportRecoveryBackup('me@example.com');
    expect(first.code).not.toBe(second.code);
  });

  it('normalises a code the user typed, and parses the restored identity back out', async () => {
    const { core, bridge } = withBridge();

    const identity = await core.importRecoveryBackup(
      'BLOB',
      ' k7m2-nq8z-r4j5-twxb-3hyp-d6c9-fgkm-ln8q ',
    );

    expect(bridge.importRecoveryBackup).toHaveBeenCalledWith(
      'BLOB',
      'K7M2NQ8ZR4J5TWXB3HYPD6C9FGKM1N8Q',
    );
    expect(identity.fingerprint).toBe('AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555');
  });

  /**
   * What Expo actually hands JavaScript when the Kotlin side throws
   * `CodedException("decrypt-failed", …)`: a plain Error carrying the code, with
   * the message wrapped. The screen switches on `instanceof CoreError`, so this
   * is the difference between "that code does not unlock your backup" and the
   * raw rejection text a device showed for a mistyped code.
   */
  it('turns a coded rejection from the module into a CoreError a person can read', async () => {
    const { core, bridge } = withBridge();
    const rejection = Object.assign(
      new Error(
        "Call to function 'CryptMailCore.importRecoveryBackup' has been rejected.\n" +
          '→ Caused by: decrypt-failed: decrypt-failed: could not unlock the key: AEAD Decrypt { alg: Ocb }',
      ),
      { code: 'decrypt-failed' },
    );
    bridge.importRecoveryBackup.mockRejectedValueOnce(rejection);

    const error = await core.importRecoveryBackup('BLOB', 'K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-2N8Q').catch((e) => e);

    expect(error).toBeInstanceOf(CoreError);
    expect(error).toMatchObject({
      code: 'decrypt-failed',
      message: expect.stringMatching(/recovery code doesn’t unlock this backup/),
      // The core's own words are kept for logs, not shown.
      detail: 'could not unlock the key: AEAD Decrypt { alg: Ocb }',
    });
  });

  it('leaves an error with no core code alone', async () => {
    const { core, bridge } = withBridge();
    const odd = Object.assign(new Error('something else'), { code: 'ERR_UNEXPECTED' });
    bridge.loadIdentity.mockRejectedValueOnce(odd);

    await expect(core.loadIdentity('me@example.com')).rejects.toBe(odd);
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

    expect(bridge.calls.seal?.plaintext).toContain('Subject: Lunch on Friday?');
    expect(bridge.calls.seal?.plaintext).toContain('protected-headers="v1"');
    expect(bridge.calls.seal?.email).toBe('alice@example.com');
  });

  it('passes every recipient key through to the core', async () => {
    const { core, bridge } = withBridge();
    await core.buildEncrypted({ ...request, recipientKeys: ['key-a', 'key-b'] });
    expect(bridge.calls.seal?.keys).toEqual(['key-a', 'key-b']);
  });

  it('refuses to build with no recipient keys rather than sending something readable', async () => {
    const { core, bridge } = withBridge();
    await expect(core.buildEncrypted({ ...request, recipientKeys: [] })).rejects.toThrow(/no recipient keys/i);
    expect(bridge.seal).not.toHaveBeenCalled();
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

/**
 * Per-email keys. The bridge gains `seal`/`open`, but a JS bundle can be newer
 * than the installed `.so`, so both paths have to work: the new methods when
 * present, the old ones exactly as before when not.
 */
describe('per-email keys', () => {
  const request = {
    from: 'alice@example.com',
    to: ['bob@example.com'],
    subject: 'subject',
    body: 'body',
    recipientKeys: ['bob-key', 'alice-key'],
  };

  function withSessions(forwardSecret: boolean) {
    const bridge = fakeBridge();
    let sealed = '';
    const withSeal = {
      ...bridge,
      seal: jest.fn(async (_email: string, plaintext: string, _keys: string) => {
        sealed = plaintext;
        return JSON.stringify({
          armored: `-----BEGIN PGP MESSAGE-----\nCryptMail-Session: AAAA\n\nZmFrZQ==\n-----END PGP MESSAGE-----`,
          forwardSecret,
        });
      }),
      open: jest.fn(async () =>
        JSON.stringify({ plaintext: sealed, signature: 'valid', signerFingerprint: 'FFFF', forwardSecret }),
      ),
    };
    const core = getNativeCore(withSeal);
    if (!core) throw new Error('expected a native core');
    return { core, bridge: withSeal };
  }

  it('seals through the new method when the native library has it', async () => {
    const { core, bridge } = withSessions(true);
    const rfc822 = await core.buildEncrypted(request);

    expect(bridge.seal).toHaveBeenCalledTimes(1);
    expect(bridge.encryptSign).not.toHaveBeenCalled();
    // Every key is handed down, the sender's included: it is the core that
    // decides whether a long-term copy may exist.
    expect(JSON.parse(bridge.seal.mock.calls[0][2])).toEqual(['bob-key', 'alice-key']);
    expect(rfc822).toContain('CryptMail-Session: AAAA');
  });

  it('opens through the new method and reports forward secrecy', async () => {
    const { core, bridge } = withSessions(true);
    const opened = await core.parseEncrypted(await core.buildEncrypted(request));

    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.decryptVerify).not.toHaveBeenCalled();
    expect(opened.body).toBe('body');
    expect(opened.forwardSecret).toBe(true);
  });

  it('reports an ordinary message as not forward-secret', async () => {
    const { core } = withSessions(false);
    const opened = await core.parseEncrypted(await core.buildEncrypted(request));
    expect(opened.forwardSecret).toBe(false);
  });

  it('refuses to send on a native library that predates them, rather than use long-term keys', async () => {
    const bridge = fakeBridge();
    delete (bridge as Partial<typeof bridge>).seal;
    const core = getNativeCore(bridge)!;

    await expect(core.buildEncrypted(request)).rejects.toMatchObject({ code: 'unavailable' });
    expect(bridge.encryptSign).not.toHaveBeenCalled();
  });

  it('never calls the long-term-key method, even when the library has both', async () => {
    const { core, bridge } = withSessions(true);
    await core.buildEncrypted(request);
    expect(bridge.encryptSign).not.toHaveBeenCalled();
  });

  it('explains a refusal for want of a session as something that is being set up', async () => {
    const { core, bridge } = withSessions(true);
    bridge.seal.mockRejectedValueOnce(
      Object.assign(new Error('no-key: no-session: no per-email keys yet'), { code: 'no-key' }),
    );
    await expect(core.buildEncrypted(request)).rejects.toThrow(/aren’t set up with everyone/);
  });

  it('says what happened when a one-time key is already gone', async () => {
    const { core, bridge } = withSessions(true);
    // Shaped as Expo delivers a Kotlin CodedException: the code on the error.
    bridge.open.mockRejectedValueOnce(
      Object.assign(new Error('decrypt-failed: key no longer exists'), { code: 'decrypt-failed' }),
    );
    const rfc822 = await core.buildEncrypted(request);

    await expect(core.parseEncrypted(rfc822)).rejects.toThrow(/one-time key/i);
  });

  // Found on the emulator: old mail sealed to a previous key was reported as
  // "sealed with a one-time key", pointing the user at a device that does not exist.
  it('explains an ordinary message’s failure the ordinary way, not as a one-time key', async () => {
    const { core, bridge } = withSessions(false);
    bridge.seal.mockResolvedValueOnce(
      JSON.stringify({ armored: '-----BEGIN PGP MESSAGE-----\n\nZmFrZQ==\n-----END PGP MESSAGE-----', forwardSecret: false }),
    );
    bridge.open.mockRejectedValueOnce(
      Object.assign(new Error('decrypt-failed: no matching key'), { code: 'decrypt-failed' }),
    );
    const rfc822 = await core.buildEncrypted(request);

    const failure = core.parseEncrypted(rfc822);
    await expect(failure).rejects.toThrow(/wasn’t encrypted to the key on this device/i);
    await expect(core.parseEncrypted(rfc822)).resolves.toBeTruthy();
  });
});

describe('device transfer through the native bridge', () => {
  const IDENTITY = {
    email: 'me@example.com',
    fingerprint: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555',
    publicKeyArmored: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----',
    createdAt: '2026-08-05T00:00:00.000Z',
  };

  function withTransfer() {
    const bridge = {
      ...fakeBridge(),
      exportTransfer: jest.fn(async () => '-----BEGIN CRYPTMAIL TRANSFER-----\nx\n-----END CRYPTMAIL TRANSFER-----'),
      importTransfer: jest.fn(async () => JSON.stringify({ identity: IDENTITY, archive: 'ARCHIVE' })),
      transferStatus: jest.fn(async () => JSON.stringify({ handedOverAt: 1_790_000_000 })),
      resumeSessions: jest.fn(async () => undefined),
    };
    return { core: getNativeCore(bridge)!, bridge };
  }

  it('generates the code, hands down the bare form, and passes the archive through untouched', async () => {
    const { core, bridge } = withTransfer();
    const made = await core.exportTransfer('me@example.com', 'ARCHIVE');
    expect(made.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    expect(bridge.exportTransfer).toHaveBeenCalledWith('me@example.com', made.code.replace(/-/g, ''), 'ARCHIVE');
  });

  it('normalises a typed code on the way in and passes the signed-in address', async () => {
    const { core, bridge } = withTransfer();
    const imported = await core.importTransfer('FILE', ' k7m2-nq8z-r4j5-twxb-3hyp-d6c9-fgkm-ln8q ', 'me@example.com');
    expect(imported).toEqual({ identity: IDENTITY, archive: 'ARCHIVE' });
    expect(bridge.importTransfer).toHaveBeenCalledWith('FILE', 'K7M2NQ8ZR4J5TWXB3HYPD6C9FGKM1N8Q', 'me@example.com');
  });

  it('turns seconds into a date', async () => {
    expect(await withTransfer().core.transferStatus()).toEqual({ handedOverAt: new Date(1_790_000_000_000) });
  });

  it('explains a wrong code in terms of the code the old phone showed', async () => {
    const { core, bridge } = withTransfer();
    bridge.importTransfer.mockRejectedValueOnce(
      Object.assign(new Error('decrypt-failed: the code does not open this transfer'), { code: 'decrypt-failed' }),
    );
    await expect(core.importTransfer('FILE', 'CODE', '')).rejects.toMatchObject({
      code: 'decrypt-failed',
      message: expect.stringMatching(/code your old phone showed/),
    });
  });

  it('on an older core: never handed over, and moving says it needs an update', async () => {
    const { core } = withBridge();
    expect(await core.transferStatus()).toEqual({ handedOverAt: null });
    await expect(core.exportTransfer('me@example.com', '')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(core.importTransfer('FILE', 'CODE', '')).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('device transfer in the demo core', () => {
  it('round-trips the identity and the archive, and refuses another mailbox', async () => {
    const me = await demoCore.generateIdentity('demo-transfer@example.com');
    const made = await demoCore.exportTransfer(me.email, 'ARCHIVE');
    expect(made.blob).toContain('-----BEGIN CRYPTMAIL TRANSFER-----');

    await expect(demoCore.importTransfer(made.blob, made.code, 'someone@example.com')).rejects.toMatchObject({
      code: 'malformed',
    });
    const back = await demoCore.importTransfer(made.blob, made.code, me.email);
    expect(back).toEqual({ identity: me, archive: 'ARCHIVE' });
  });
});

describe('handshakes through the native bridge', () => {
  function withHandshake() {
    const bridge = {
      ...fakeBridge(),
      handshake: jest.fn(async () => '-----BEGIN PGP MESSAGE-----\nCryptMail-Offer: AAAA\n\nZmFrZQ==\n-----END PGP MESSAGE-----'),
      sessionStatus: jest.fn(async () => JSON.stringify(['session', 'none', 'self'])),
    };
    return { core: getNativeCore(bridge)!, bridge };
  }

  it('seals only the fixed text, to the one recipient, and marks the outer subject', async () => {
    const { core, bridge } = withHandshake();
    const rfc822 = await core.buildHandshake({
      from: 'alice@example.com',
      to: 'bob@example.com',
      recipientKey: 'bob-key',
    });

    const [email, plaintext, keys] = bridge.handshake.mock.calls[0] as unknown as [string, string, string];
    expect(email).toBe('alice@example.com');
    expect(JSON.parse(keys)).toEqual(['bob-key']);
    expect(plaintext).toContain('Subject: Setting up per-email keys');
    expect(parseRfc822(rfc822).headers['subject']).toBe(HANDSHAKE_SUBJECT);
  });

  it('marks an answer’s outer subject, and only an answer’s', async () => {
    const { core } = withHandshake();
    const base = { from: 'a@x', to: ['b@x'], subject: 's', body: 'b', recipientKeys: ['k'] };
    expect(parseRfc822(await core.buildEncrypted({ ...base, handshake: true })).headers['subject']).toBe(
      HANDSHAKE_SUBJECT,
    );
    expect(parseRfc822(await core.buildEncrypted(base)).headers['subject']).toBe(PLACEHOLDER_SUBJECT);
  });

  it('reads the session status in key order', async () => {
    const { core, bridge } = withHandshake();
    expect(await core.sessionStatus('alice@example.com', ['b', 'c', 'a'])).toEqual(['session', 'none', 'self']);
    expect(bridge.sessionStatus).toHaveBeenCalledWith('alice@example.com', JSON.stringify(['b', 'c', 'a']));
  });

  it('says a handed-over phone cannot send, in words', async () => {
    const { core, bridge } = withHandshake();
    bridge.sessionStatus.mockRejectedValueOnce(
      Object.assign(new Error('unavailable: handed-over: this phone handed its conversations'), { code: 'unavailable' }),
    );
    await expect(core.sessionStatus('a@x', ['k'])).rejects.toThrow(/handed its conversations to another phone/);
  });
});
