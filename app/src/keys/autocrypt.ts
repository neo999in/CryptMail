/**
 * Learning a correspondent's key from the mail that already arrives.
 *
 * `Autocrypt:` is a cleartext header (encryption.md, "Automatic key exchange"),
 * so harvesting needs no decryption and no network beyond the sync that is
 * happening anyway. That is the whole point of pulling this out of
 * `openMessage`: a key used to be learned only if the user happened to open
 * that particular message, and only from encrypted mail.
 *
 * Nothing here throws. A header that is malformed, truncated, or lying about
 * whose key it carries must leave the keyring exactly as it was — a broken
 * header on one message can never be allowed to break an inbox sync.
 */
import { core } from '../core';
import { decodeUtf8Base64 } from '../lib/base64';
import { Keyring, upsertKey } from '../store/keyring';

const ARMOR_BEGIN = '-----BEGIN PGP PUBLIC KEY BLOCK-----';
const ARMOR_END = '-----END PGP PUBLIC KEY BLOCK-----';

/**
 * The armored public key an `Autocrypt` header carries, or undefined.
 *
 * Accepts either shape the app has to deal with:
 *
 *  · a whole header value — `addr=…; prefer-encrypt=mutual; keydata=…`
 *  · an already-extracted armored block, which is what `parseEncrypted`
 *    hands back on `DecryptedMessage.autocryptKey`
 *
 * `from` is the message's actual sender. When both it and `addr` are present
 * and they disagree, the header is ignored: Autocrypt §"Header injection"
 * requires it, and without the check any sender could push a key for any
 * address into the recipient's keyring.
 */
export function autocryptKeyFrom(header: string, from?: string): string | undefined {
  const value = header.trim();
  if (value.length === 0) return undefined;
  if (value.includes(ARMOR_BEGIN)) return value;

  const addr = value.match(/(?:^|;)\s*addr=([^;]+)/)?.[1]?.trim().toLowerCase();
  if (addr && from && addr !== from.trim().toLowerCase()) return undefined;

  const keydata = value.match(/keydata=([\s\S]+?)(?:;|$)/)?.[1]?.replace(/\s+/g, '');
  if (!keydata) return undefined;

  // CryptMail flattens the *armored* key (mime.ts `autocryptKeydata`), while
  // the Autocrypt spec flattens the binary key packets. Try to read it as text
  // first; anything else is wrapped in armor so the packet reader can take it.
  try {
    const decoded = decodeUtf8Base64(keydata);
    if (decoded.includes(ARMOR_BEGIN)) return decoded;
  } catch {
    // Binary key material — fall through and armor it.
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(keydata)) return undefined;
  return [ARMOR_BEGIN, '', ...(keydata.match(/.{1,64}/g) ?? []), ARMOR_END].join('\n');
}

/**
 * Fold an `Autocrypt` header into the keyring, returning the new one.
 *
 * Pure with respect to storage — the caller persists — so the same helper
 * serves the inbox sync and the message-open path without either of them
 * having to know what the other does.
 *
 * A key that arrives for an address already in the ring with a *different*
 * fingerprint is marked `changed` by `upsertKey`, which blocks sending to it.
 * That is deliberate here too: a substituted key delivered by header is exactly
 * the attack the trust state exists to surface.
 */
export async function harvestAutocrypt(
  keyring: Keyring,
  from: string,
  header: string | undefined,
  name?: string,
): Promise<Keyring> {
  if (!header) return keyring;
  const armored = autocryptKeyFrom(header, from);
  if (!armored) return keyring;

  try {
    return upsertKey(keyring, await core.importPublicKey(armored), 'autocrypt', name);
  } catch {
    return keyring;
  }
}
