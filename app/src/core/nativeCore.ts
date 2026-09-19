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
  autocryptKeydata,
  buildEncryptedEnvelope,
  buildProtectedInner,
  extractArmor,
  isForwardSecret,
  isPgpMime,
  parseProtectedInner,
  parseRfc822,
} from './mime';
import { generateRecoveryCode, normaliseRecoveryCode } from './recoveryCode';
import { decodeUtf8Base64 } from '../lib/base64';
import {
  BuildRequest,
  CoreError,
  CryptCore,
  DecryptedMessage,
  DeviceTransfer,
  Identity,
  ImportedTransfer,
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
  /**
   * → `{ armored, forwardSecret }`. A new, destroyable key per email when every
   * recipient can take one, otherwise exactly `encryptSign`.
   *
   * Optional for the same reason as the recovery pair: a JS bundle can be newer
   * than the installed `.so`. Without it, sending falls back to `encryptSign`,
   * which is what every message was before per-email keys existed.
   */
  seal?(email: string, plaintext: string, recipientKeysJson: string): Promise<string>;
  /** → the `decryptVerify` document plus `forwardSecret`. Opens either kind. */
  open?(armored: string, senderKeysJson: string): Promise<string>;
  /**
   * → the armored transfer file. Hands this phone's conversations over. The
   * code is generated here, as a recovery code is. Optional, like the rest.
   */
  exportTransfer?(email: string, code: string, archive: string): Promise<string>;
  /** → `{ identity, archive }` JSON. `expectedEmail` may be empty. */
  importTransfer?(armored: string, code: string, expectedEmail: string): Promise<string>;
  /** → `{ handedOverAt }` JSON, Unix seconds or null. */
  transferStatus?(): Promise<string>;
  resumeSessions?(): Promise<void>;
};

type NativeDecrypted = {
  plaintext: string;
  signature: SignatureStatus;
  signerFingerprint?: string;
  forwardSecret?: boolean;
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

    generateIdentity: async (email) => JSON.parse(await call(bridge.generateIdentity(email), WORDING.generateIdentity)) as Identity,

    loadIdentity: async (email) => {
      const json = await call(bridge.loadIdentity(email), WORDING.loadIdentity);
      return json ? (JSON.parse(json) as Identity) : null;
    },

    importPublicKey: async (armored) =>
      JSON.parse(await call(bridge.importPublicKey(armored), WORDING.importPublicKey)) as PublicKeyInfo,

    /**
     * The code is generated here and shown to the user grouped, for writing
     * down; what crosses the bridge is the normalised bare form, which is what
     * Argon2 actually hashes. A code can be written spaced or lowercased, and
     * each variant is a different byte string — so the two sides have to agree
     * on exactly one of them.
     */
    exportRecoveryBackup: async (email): Promise<RecoveryBackup> => {
      const code = generateRecoveryCode();
      const blob = await call(
        required(bridge, 'exportRecoveryBackup', 'Backing up')(email, normaliseRecoveryCode(code)),
        WORDING.exportRecoveryBackup,
      );
      return { code, blob };
    },

    importRecoveryBackup: async (blob, code) =>
      JSON.parse(
        await call(
          required(bridge, 'importRecoveryBackup', 'Restoring from a backup')(
            blob,
            normaliseRecoveryCode(code),
          ),
          WORDING.importRecoveryBackup,
        ),
      ) as Identity,

    exportTransfer: async (email, archive): Promise<DeviceTransfer> => {
      const code = generateRecoveryCode();
      const blob = await call(
        required(bridge, 'exportTransfer', 'Moving to a new phone')(email, normaliseRecoveryCode(code), archive),
        WORDING.exportTransfer,
      );
      return { code, blob };
    },

    importTransfer: async (blob, code, expectedEmail) =>
      JSON.parse(
        await call(
          required(bridge, 'importTransfer', 'Moving from another phone')(
            blob,
            normaliseRecoveryCode(code),
            expectedEmail,
          ),
          WORDING.importTransfer,
        ),
      ) as ImportedTransfer,

    /** A core without transfer has never handed anything over. */
    transferStatus: async () => {
      if (!bridge.transferStatus) return { handedOverAt: null };
      const { handedOverAt } = JSON.parse(await call(bridge.transferStatus())) as { handedOverAt: number | null };
      return { handedOverAt: handedOverAt === null ? null : new Date(handedOverAt * 1000) };
    },

    resumeSessions: async () => {
      await call(required(bridge, 'resumeSessions', 'Taking conversations back')());
    },

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
        html: request.html,
        attachments: request.attachments,
      });
      const keysJson = JSON.stringify(request.recipientKeys);
      // `seal` decides per message: per-email keys when every recipient can
      // take one, long-term keys otherwise. It drops the sender's own key from
      // a forward-secret message itself — a copy under our long-term key would
      // reopen it — and the send path archives what was sent instead.
      const armored = bridge.seal
        ? (JSON.parse(await call(bridge.seal(request.from, inner, keysJson), WORDING.encryptSign)) as {
            armored: string;
          }).armored
        : await call(bridge.encryptSign(request.from, inner, keysJson), WORDING.encryptSign);
      return buildEncryptedEnvelope({
        from: request.from,
        to: request.to,
        armored,
        autocryptKeydata: request.autocryptKey ? autocryptKeydata(request.autocryptKey) : undefined,
        inReplyTo: request.inReplyTo,
        references: request.references,
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

      const senderKeysJson = JSON.stringify(autocryptKey ? [autocryptKey] : []);
      // The one-time-key explanation is only true of a message that carries
      // per-email keys. An ordinary message that fails through `open` fails for
      // the ordinary reason — usually that it was sealed to an older key — and
      // saying otherwise sends the user looking for a second device they don't have.
      const wording = isForwardSecret(block) ? WORDING.open : WORDING.decryptVerify;
      const decrypted = JSON.parse(
        bridge.open
          ? await call(bridge.open(block, senderKeysJson), wording)
          : await call(bridge.decryptVerify(block, senderKeysJson), wording),
      ) as NativeDecrypted;

      const { subject, body, html, attachments } = parseProtectedInner(decrypted.plaintext);
      return {
        subject,
        body,
        html,
        attachments,
        signature: decrypted.signature,
        signerFingerprint: decrypted.signerFingerprint,
        autocryptKey,
        forwardSecret: decrypted.forwardSecret === true,
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
function required<
  K extends 'exportRecoveryBackup' | 'importRecoveryBackup' | 'exportTransfer' | 'importTransfer' | 'resumeSessions',
>(
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

const CORE_CODES: readonly CoreError['code'][] = ['no-key', 'malformed', 'decrypt-failed', 'unavailable'];

type Wording = Partial<Record<CoreError['code'], string>>;

/**
 * What each code means when nothing more specific is known. The core's own
 * text ("could not unlock the key: AEAD Decrypt { alg: Ocb }") is accurate and
 * says nothing to the person holding the phone, so it goes in `detail` instead.
 */
const DEFAULT_WORDING: Record<CoreError['code'], string> = {
  'no-key': 'There is no key for this account on this device yet.',
  malformed: 'That isn’t in a format CryptMail can read. It may be damaged or incomplete.',
  'decrypt-failed': 'The key on this device can’t unlock that.',
  unavailable: 'The encryption engine on this device couldn’t do that. Restart CryptMail and try again.',
};

/** What a failure means, call by call — the same code says different things. */
const WORDING = {
  generateIdentity: {
    unavailable: 'Couldn’t create a key on this device. Restart CryptMail and try again.',
  },
  loadIdentity: {
    unavailable: 'Couldn’t open this device’s key store. Restart CryptMail and try again.',
  },
  importPublicKey: {
    malformed: 'That doesn’t look like a public key. Paste the whole block, from BEGIN to END.',
  },
  exportRecoveryBackup: {
    'no-key': 'There is no key on this device to back up yet.',
  },
  importRecoveryBackup: {
    'decrypt-failed':
      'That recovery code doesn’t unlock this backup. Check each group against what you wrote down, in order.',
    malformed:
      'That isn’t a complete CryptMail backup. Load the backup file itself rather than pasting it, so nothing is cut off.',
  },
  exportTransfer: {
    'no-key': 'There is no key on this device to move yet.',
  },
  importTransfer: {
    'decrypt-failed':
      'That code doesn’t open this transfer. Check each group against the code your old phone showed, in order.',
    malformed:
      'That isn’t a complete CryptMail transfer, or it belongs to another address. Load the file itself rather than pasting it.',
  },
  encryptSign: {
    'no-key': 'There is no key on this device to sign with. Set up your key first.',
    malformed: 'A recipient’s key can’t be used for encryption. Check their key in Contacts.',
  },
  decryptVerify: {
    'decrypt-failed':
      'This message wasn’t encrypted to the key on this device, so it can’t be opened here. It may have been sent to an older key.',
    malformed: 'This message is damaged or incomplete, so it can’t be decrypted.',
    'no-key': 'There is no key on this device to open encrypted mail with.',
  },
  // `open` reaches the same failures as `decryptVerify`, plus one it alone can:
  // a message sealed with a per-email key that this device has already used.
  open: {
    'decrypt-failed':
      'This message can’t be opened on this device. It was sealed with a one-time key that no longer exists here — it was already opened, or it was sent to your other device.',
    malformed: 'This message is damaged or incomplete, so it can’t be decrypted.',
    'no-key': 'There is no key on this device to open encrypted mail with.',
  },
} satisfies Record<string, Wording>;

/** Await a bridge call, with its rejection translated by `toCoreError`. */
function call<T>(pending: Promise<T>, wording: Wording = {}): Promise<T> {
  return pending.catch((e: unknown) => {
    throw toCoreError(e, wording);
  });
}

/**
 * Turn a rejection from the Kotlin module into the `CoreError` the rest of the
 * app switches on.
 *
 * Kotlin throws `CodedException(code, message)` with one of the four codes, but
 * what reaches JavaScript is Expo's own error: it carries that `code`, is not an
 * instance of `CoreError`, and wraps the message as "Call to function
 * 'CryptMailCore.x' has been rejected. → Caused by: decrypt-failed: …". Left
 * untranslated, every `instanceof CoreError` check above this line is dead on a
 * real device — a mistyped recovery code reached the user as that raw string
 * instead of "that code does not unlock your backup".
 */
export function toCoreError(e: unknown, wording: Wording = {}): unknown {
  if (e instanceof CoreError || !(e instanceof Error)) return e;
  const raw = (e as { code?: unknown }).code;
  const named = e.message.match(/Caused by: ([a-z-]+):/)?.[1];
  const code = CORE_CODES.find((c) => c === raw) ?? CORE_CODES.find((c) => c === named);
  if (!code) return e;

  // Keep the core's own words for logs: drop Expo's wrapper, then the code
  // prefix the Rust `Display` (and its FFI twin) put in front of them.
  let detail = e.message.split('Caused by: ').pop() ?? e.message;
  while (detail.startsWith(`${code}: `)) detail = detail.slice(code.length + 2);
  return new CoreError(wording[code] ?? DEFAULT_WORDING[code], code, detail.trim());
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
