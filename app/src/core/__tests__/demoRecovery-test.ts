/**
 * Recovery, through the demo core.
 *
 * The demo core encodes rather than encrypts, so these tests cannot say
 * anything about the cryptography — that lives in Rust and is tested there.
 * What they do pin down is the *contract* both cores implement: which errors
 * come back for which failure, and that restoring adopts the identity rather
 * than issuing a new one. Those are the parts the UI branches on, and they have
 * to behave identically once the native core is swapped in.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { demoCore } from '../demoCore';
import { CoreError, Identity } from '../types';

const EMAIL = 'user@example.com';

/** The error code, or a readable failure if the call unexpectedly succeeded. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'no error thrown';
  } catch (e) {
    return e instanceof CoreError ? e.code : `not a CoreError: ${String(e)}`;
  }
}

describe('demo core recovery', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  async function backedUpIdentity(): Promise<{ identity: Identity; code: string; blob: string }> {
    const identity = await demoCore.generateIdentity(EMAIL);
    const { code, blob } = await demoCore.exportRecoveryBackup(EMAIL);
    return { identity, code, blob };
  }

  describe('export', () => {
    it('refuses to back up a device that has no identity', async () => {
      expect(await codeOf(() => demoCore.exportRecoveryBackup(EMAIL))).toBe('no-key');
    });

    it('produces a labelled blob and a code', async () => {
      const { code, blob } = await backedUpIdentity();

      expect(blob).toContain('-----BEGIN CRYPTMAIL RECOVERY BACKUP-----');
      expect(blob).toContain('-----END CRYPTMAIL RECOVERY BACKUP-----');
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    });

    /**
     * The code is the whole security of the backup in the real core. If it were
     * recoverable from the blob, the blob would be the key.
     */
    it('does not leave the code inside the blob', async () => {
      const { code, blob } = await backedUpIdentity();

      expect(blob).not.toContain(code);
      expect(blob).not.toContain(code.replace(/-/g, ''));
    });

    it('issues a different code every time', async () => {
      await demoCore.generateIdentity(EMAIL);
      const first = await demoCore.exportRecoveryBackup(EMAIL);
      const second = await demoCore.exportRecoveryBackup(EMAIL);

      expect(first.code).not.toBe(second.code);
      // Either code opens its own backup; neither opens the other's.
      await expect(demoCore.importRecoveryBackup(second.blob, second.code)).resolves.toBeTruthy();
      expect(await codeOf(() => demoCore.importRecoveryBackup(second.blob, first.code))).toBe(
        'decrypt-failed',
      );
    });
  });

  describe('import', () => {
    /**
     * The point of the whole feature: the *same* identity comes back, not a new
     * one. A restore that minted a fresh key would silently orphan every
     * message ever sent to the old one.
     */
    it('restores the same identity, fingerprint included', async () => {
      const { identity, code, blob } = await backedUpIdentity();

      const restored = await demoCore.importRecoveryBackup(blob, code);

      expect(restored.fingerprint).toBe(identity.fingerprint);
      expect(restored.email).toBe(identity.email);
      expect(restored.publicKeyArmored).toBe(identity.publicKeyArmored);
      expect(restored.createdAt).toBe(identity.createdAt);
    });

    /** Restoring means adopting: the device must load it back on the next boot. */
    it('adopts the restored identity as this device key', async () => {
      const { identity, code, blob } = await backedUpIdentity();
      await AsyncStorage.clear();
      expect(await demoCore.loadIdentity(EMAIL)).toBeNull();

      await demoCore.importRecoveryBackup(blob, code);

      expect(await demoCore.loadIdentity(EMAIL)).toMatchObject({
        fingerprint: identity.fingerprint,
      });
    });

    it('accepts a code typed back with different spacing and case', async () => {
      const { identity, code, blob } = await backedUpIdentity();
      const retyped = code.replace(/-/g, ' ').toLowerCase();

      const restored = await demoCore.importRecoveryBackup(blob, retyped);

      expect(restored.fingerprint).toBe(identity.fingerprint);
    });

    /** Crockford's whole reason for existing — see recoveryCode.ts. */
    it('accepts a code whose 0 and 1 were written down as O and I', async () => {
      const { identity, code, blob } = await backedUpIdentity();
      const handwritten = code.replace(/0/g, 'O').replace(/1/g, 'I');

      const restored = await demoCore.importRecoveryBackup(blob, handwritten);

      expect(restored.fingerprint).toBe(identity.fingerprint);
    });

    it('rejects the wrong code as decrypt-failed, not malformed', async () => {
      const { blob } = await backedUpIdentity();
      const wrong = 'K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-2N8Q';

      expect(await codeOf(() => demoCore.importRecoveryBackup(blob, wrong))).toBe('decrypt-failed');
    });

    /**
     * The two are distinguished so the UI can say which thing is wrong. Telling
     * someone their code is wrong when they actually pasted the wrong text
     * sends them looking for a piece of paper that was fine all along.
     */
    it('rejects something that is not a backup as malformed', async () => {
      const { code } = await backedUpIdentity();

      expect(await codeOf(() => demoCore.importRecoveryBackup('hello', code))).toBe('malformed');
      expect(
        await codeOf(() =>
          demoCore.importRecoveryBackup('-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----', code),
        ),
      ).toBe('malformed');
    });

    it('rejects a truncated backup as malformed', async () => {
      const { code, blob } = await backedUpIdentity();
      const truncated = blob.replace(/-----END CRYPTMAIL RECOVERY BACKUP-----/, '');

      expect(await codeOf(() => demoCore.importRecoveryBackup(truncated, code))).toBe('malformed');
    });

    /**
     * A blob the *real* core produced is well-formed but unreadable here. That
     * has to say so, rather than blaming the user's code — otherwise someone in
     * demo mode retypes a correct code forever.
     */
    it('says a real backup needs the real core, rather than blaming the code', async () => {
      const { code } = await backedUpIdentity();
      const nativeBlob = [
        '-----BEGIN CRYPTMAIL RECOVERY BACKUP-----',
        '',
        'bmF0aXZlLXdyYXBwZWQtc2VjcmV0LWtleQ==',
        '-----END CRYPTMAIL RECOVERY BACKUP-----',
      ].join('\n');

      expect(await codeOf(() => demoCore.importRecoveryBackup(nativeBlob, code))).toBe(
        'decrypt-failed',
      );
      await expect(demoCore.importRecoveryBackup(nativeBlob, code)).rejects.toThrow(
        /real crypto core/,
      );
    });
  });
});
