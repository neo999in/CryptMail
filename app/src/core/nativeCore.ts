/**
 * Binding to the real `cryptmail-core` (Rust → UniFFI → Kotlin → Expo module).
 *
 * The native module does not exist until M2 of docs/prototype-plan.md. Until
 * then `getNativeCore()` returns null and the app falls back to `demoCore` with
 * encrypted sending clearly labelled — never silently.
 *
 * ## Why the bridge is crypto-only
 *
 * The Rust crate deliberately does **not** build or parse MIME. `mime.ts`
 * already implements docs/message-format.md and is covered by tests, so this
 * module composes the two: MIME assembly stays in TypeScript, and only the
 * operations that touch the private key cross into Rust.
 *
 * That keeps the `CryptCore` contract in types.ts unchanged — screens and
 * AppState are unaffected — while halving the amount of Rust and removing the
 * risk of two divergent implementations of the envelope spec.
 *
 * The private key never crosses this boundary. Plaintext does, but it already
 * must: `parseEncrypted` has always returned the decrypted body to JavaScript.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

import {
  buildEncryptedEnvelope,
  buildProtectedInner,
  extractArmor,
  isPgpMime,
  parseProtectedInner,
  parseRfc822,
} from './mime';
import { generateRecoveryCode, normaliseRecoveryCode } from './recoveryCode';
import { decodeUtf8Base64, encodeUtf8Base64 } from '../lib/base64';
import {
  BuildRequest,
  CoreError,
  CryptCore,
  DecryptedMessage,
  Identity,
  PublicKeyInfo,
  RecoveryBackup,
  SignatureStatus,
} from './types';

export const NATIVE_MODULE_NAME = 'CryptMailCore';

/**
 * The Kotlin surface. Five crypto operations, all string-in/string-out.
 *
 * `passphrase` is supplied by the native side from the Android Keystore — it is
 * never chosen, stored, or seen in JavaScript, which is why it is absent from
 * every signature here.
 */
type NativeBridge = {
  /** → Identity JSON. The secret key is stored Keystore-wrapped, never returned. */
  generateIdentity(email: string): Promise<string>;
  loadIdentity(email: string): Promise<string | null>;
  /** → PublicKeyInfo JSON. Throws on anything unusable. */
  importPublicKey(armored: string): Promise<string>;
  /**
   * → the armored blob: a standard OpenPGP secret key re-locked under an
   * Argon2id S2K derived from the code.
   *
   * The code is generated *here* and passed down, so Crockford base32 has
   * exactly one implementation — a second one in Rust would have to agree with
   * `recoveryCode.ts` character for character forever, with no test able to
   * span both languages.
   *
   * Optional: a Kotlin module built before recovery landed will not have these
   * two, and an app bundle can be newer than the native library it loads.
   */
  exportRecoveryBackup?(email: string, code: string): Promise<string>;
  /** → Identity JSON. Rewrites the secret key under this device's Keystore passphrase. */
  importRecoveryBackup?(blob: string, code: string): Promise<string>;
  /** Sign with this device's key, encrypt to every recipient. → armored PGP MESSAGE. */
  encryptSign(email: string, plaintext: string, recipientKeysJson: string): Promise<string>;
  /**
   * → { plaintext, signature, signerFingerprint } JSON.
   *
   * Takes no address: the native side decrypts with the identity it holds. The
   * envelope cannot tell us which identity to use — our address may sit in
   * `Cc`, or `To` may list several people — so reading it from the headers
   * would fail on ordinary multi-recipient mail.
   */
  decryptVerify(armored: string, senderKeysJson: string): Promise<string>;
};

type NativeDecrypted = {
  plaintext: string;
  signature: SignatureStatus;
  signerFingerprint?: string;
};

/**
 * The Kotlin side is an **Expo module** (`class CryptMailCoreModule : Module()`
 * with `Name("CryptMailCore")`), so it is resolved through `expo-modules-core`,
 * not React Native's legacy `NativeModules` registry.
 *
 * This was the first real bug the device build found. The two halves were
 * written against different module systems: the Kotlin registered itself with
 * Expo, and this file looked it up in `NativeModules`, where an Expo module
 * never appears. Nothing failed loudly — `getNativeCore()` simply returned null
 * and the app stayed in demo mode, reporting a missing core that was in fact
 * installed and working. Exactly the silent downgrade `demoReason()` exists to
 * make visible, arriving through a path nobody had tested.
 *
 * `requireOptionalNativeModule` returns null rather than throwing when the
 * module is absent, which is what keeps the demo fallback intact — and its web
 * implementation always returns null, so the browser build stays on `demoCore`
 * as documented.
 */
export function getNativeCore(
  /**
   * The resolved native module. Defaulted rather than looked up inline so tests
   * can hand in a fake bridge directly: `expo-modules-core` exports through
   * getters, which neither `jest.spyOn` nor a module factory can replace
   * reliably — and a test that cannot substitute the bridge ends up asserting
   * against a registry instead of against this composition.
   */
  bridge: NativeBridge | null = requireOptionalNativeModule<NativeBridge>(NATIVE_MODULE_NAME),
): CryptCore | null {
  if (!bridge) return null;

  return {
    kind: 'native',

    generateIdentity: async (email) => JSON.parse(await bridge.generateIdentity(email)) as Identity,

    loadIdentity: async (email) => {
      const json = await bridge.loadIdentity(email);
      return json ? (JSON.parse(json) as Identity) : null;
    },

    importPublicKey: async (armored) =>
      JSON.parse(await bridge.importPublicKey(armored)) as PublicKeyInfo,

    /**
     * The code is generated here and shown to the user grouped, for writing
     * down; what crosses the bridge is the normalised bare form, which is what
     * Argon2 actually hashes. A code can be written spaced or lowercased, and
     * each variant is a different byte string — so the two sides have to agree
     * on exactly one of them.
     */
    exportRecoveryBackup: async (email): Promise<RecoveryBackup> => {
      const code = generateRecoveryCode();
      const blob = await required(bridge, 'exportRecoveryBackup', 'Backing up')(
        email,
        normaliseRecoveryCode(code),
      );
      return { code, blob };
    },

    importRecoveryBackup: async (blob, code) =>
      JSON.parse(
        await required(bridge, 'importRecoveryBackup', 'Restoring from a backup')(
          blob,
          normaliseRecoveryCode(code),
        ),
      ) as Identity,

    /**
     * Inner protected-headers tree → Rust encrypt+sign → outer PGP/MIME
     * envelope. The two MIME halves are the same functions `demoCore` uses, so
     * both cores emit byte-identical envelope structure and only the armored
     * payload differs.
     */
    async buildEncrypted(request: BuildRequest): Promise<string> {
      if (request.recipientKeys.length === 0) {
        throw new CoreError('Refusing to build a message with no recipient keys.', 'no-key');
      }
      const inner = buildProtectedInner({
        from: request.from,
        to: request.to,
        subject: request.subject,
        body: request.body,
      });
      const armored = await bridge.encryptSign(
        request.from,
        inner,
        JSON.stringify(request.recipientKeys),
      );
      return buildEncryptedEnvelope({
        from: request.from,
        to: request.to,
        armored,
        autocryptKeydata: request.autocryptKey ? encodeUtf8Base64(request.autocryptKey) : undefined,
      });
    },

    /**
     * The inverse. The sender's Autocrypt key, when present, is handed to the
     * core as a verification candidate — so a message that carries its own key
     * can be checked on first contact rather than reading as `unknown`.
     */
    async parseEncrypted(rfc822: string): Promise<DecryptedMessage> {
      const block = extractArmor(rfc822);
      if (!block) throw new CoreError('No PGP message block found.', 'malformed');

      const autocryptKey = autocryptKeyOf(parseRfc822(rfc822).headers['autocrypt']);

      const decrypted = JSON.parse(
        await bridge.decryptVerify(block, JSON.stringify(autocryptKey ? [autocryptKey] : [])),
      ) as NativeDecrypted;

      const { subject, body } = parseProtectedInner(decrypted.plaintext);
      return {
        subject,
        body,
        signature: decrypted.signature,
        signerFingerprint: decrypted.signerFingerprint,
        autocryptKey,
      };
    },

    looksEncrypted: isPgpMime,
  };
}

/**
 * Bind an optional bridge method, or fail with something a user can act on.
 *
 * The JavaScript bundle and the native library are versioned separately — an
 * OTA update ships new TypeScript against whatever `.so` is already installed.
 * Calling straight through would throw `bridge.exportRecoveryBackup is not a
 * function`, which tells the user nothing and looks like a crash rather than a
 * missing feature.
 */
function required<K extends 'exportRecoveryBackup' | 'importRecoveryBackup'>(
  bridge: NativeBridge,
  name: K,
  action: string,
): NonNullable<NativeBridge[K]> {
  const method = bridge[name];
  if (method) {
    // Bound, not passed bare: a native module's methods may rely on `this`.
    return method.bind(bridge) as NonNullable<NativeBridge[K]>;
  }
  return ((..._args: unknown[]) =>
    Promise.reject(
      new CoreError(
        `${action} needs a newer version of the CryptMail crypto core than this device has installed.`,
        'unavailable',
      ),
    )) as NonNullable<NativeBridge[K]>;
}

/** Unflatten an `Autocrypt:` header's base64 `keydata` back into armor. */
function autocryptKeyOf(header: string | undefined): string | undefined {
  const keydata = header?.match(/keydata=([^;]+)/)?.[1]?.trim();
  if (!keydata) return undefined;
  try {
    const decoded = decodeUtf8Base64(keydata);
    return decoded.includes('BEGIN PGP PUBLIC KEY BLOCK') ? decoded : undefined;
  } catch {
    // A malformed Autocrypt header must never prevent reading the message.
    return undefined;
  }
}
