/**
 * A minimal, dependency-free reader for **real** armored OpenPGP public keys.
 *
 * The demo core (`demoCore.importPublicKey`) can only read CryptMail's own
 * demo keys, which carry the address + fingerprint in armor headers. A key
 * exported from GnuPG, Proton Mail, or any other OpenPGP tool keeps those in
 * the *binary packet stream* instead — so this module dearmors the block, walks
 * the RFC 4880 packet structure, and pulls out the primary-key fingerprint and
 * the User ID.
 *
 * Scope: version-4 keys (RSA/ECC alike — both use the V4 packet layout, which
 * is essentially every key in circulation today). Version 5/6 keys hash their
 * fingerprint with SHA-256; rather than invent a wrong fingerprint we throw a
 * clear error. This is a *reader* only — it does not verify self-signatures or
 * key validity; that is the real (native) core's job.
 */
import { base64ToBytes, bytesToUtf8 } from '../lib/base64';
import { CoreError } from '../core/types';

export type ParsedPublicKey = {
  /** Address from the primary User ID, lower-cased for keyring lookups. */
  email: string;
  /** Uppercase hex, no spaces — matches `gpg --fingerprint`. */
  fingerprint: string;
  /** The full primary User ID string, e.g. "Ada Lovelace <ada@example.com>". */
  userId: string;
  /** OpenPGP key version (4). */
  version: number;
  /** Public-key algorithm id (RFC 4880 §9.1), for display/diagnostics. */
  algorithm: number;
  /** Key creation time, if the packet carried one. */
  createdAt?: string;
};

export function parseArmoredPublicKey(armored: string): ParsedPublicKey {
  const base64 = extractArmorBody(armored);
  if (base64 === null) {
    throw new CoreError('That does not look like an armored public key block.', 'malformed');
  }

  const packets = readPackets(base64ToBytes(base64));

  const keyPacket = packets.find((p) => p.tag === TAG_PUBLIC_KEY);
  if (!keyPacket) {
    throw new CoreError('No public-key packet found in that block.', 'malformed');
  }
  const primary = readPublicKeyPacket(keyPacket.body);

  const uidPacket = packets.find((p) => p.tag === TAG_USER_ID);
  const userId = uidPacket ? bytesToUtf8(uidPacket.body).trim() : '';
  const email = extractEmail(userId);
  if (!email) {
    throw new CoreError('Key has no user ID with an email address.', 'malformed');
  }

  return { email, userId, ...primary };
}

/** The display name of a User ID ("Ada Lovelace <ada@…>" → "Ada Lovelace"), if any. */
export function userIdDisplayName(userId: string): string | undefined {
  const m = userId.match(/^\s*(.+?)\s*<[^>]+>\s*$/);
  const name = m?.[1]?.trim();
  // A bare address has no name; the demo comment is not a person's name.
  if (!name || /demo key/i.test(name)) return undefined;
  return name;
}

/* ------------------------------------------------------------ armor ------- */

const BEGIN = '-----BEGIN PGP PUBLIC KEY BLOCK-----';
const END = '-----END PGP PUBLIC KEY BLOCK-----';

/**
 * Pull the base64 payload out of an armored block: skip armor headers (up to
 * the blank line), drop the `=CRC` line, and ignore any surrounding prose.
 * Returns null when there is no public-key block at all.
 */
function extractArmorBody(armored: string): string | null {
  const text = armored.replace(/\r\n/g, '\n');
  const begin = text.indexOf(BEGIN);
  if (begin === -1) return null;
  const afterBegin = text.indexOf('\n', begin);
  const end = text.indexOf(END, afterBegin === -1 ? begin : afterBegin);
  if (afterBegin === -1 || end === -1) return null;

  const lines = text.slice(afterBegin + 1, end).split('\n');
  const out: string[] = [];
  let inHeaders = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (inHeaders) {
      if (line === '') {
        inHeaders = false; // blank line ends the armor headers
        continue;
      }
      // Armor headers ("Comment: …", "Version: …") contain a colon; base64
      // data never does. A block may also carry no headers at all.
      if (line.includes(':')) continue;
      inHeaders = false; // data starts immediately, no headers present
    }
    if (line === '') continue;
    if (line.startsWith('=')) break; // the CRC-24 checksum line
    out.push(line);
  }
  return out.join('');
}

/* ----------------------------------------------------------- packets ------ */

const TAG_PUBLIC_KEY = 6;
const TAG_USER_ID = 13;

type Packet = { tag: number; body: Uint8Array };

/** Walk the RFC 4880 §4.2 packet stream (old- and new-format headers). */
function readPackets(data: Uint8Array): Packet[] {
  const packets: Packet[] = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i++];
    if ((b & 0x80) === 0) break; // not a packet tag byte — stop, keep what we have

    let tag: number;
    let len: number;
    if (b & 0x40) {
      // New format.
      tag = b & 0x3f;
      const o1 = data[i++];
      if (o1 < 192) {
        len = o1;
      } else if (o1 < 224) {
        len = ((o1 - 192) << 8) + data[i++] + 192;
      } else if (o1 === 255) {
        len = read4(data, i);
        i += 4;
      } else {
        break; // partial body lengths (streaming) — not used by public keys
      }
    } else {
      // Old format.
      tag = (b >> 2) & 0x0f;
      const lenType = b & 0x03;
      if (lenType === 0) {
        len = data[i++];
      } else if (lenType === 1) {
        len = (data[i] << 8) | data[i + 1];
        i += 2;
      } else if (lenType === 2) {
        len = read4(data, i);
        i += 4;
      } else {
        len = data.length - i; // indeterminate length: to the end
      }
    }

    if (len < 0 || i + len > data.length) {
      // Truncated/corrupt: keep whatever body remains and stop.
      packets.push({ tag, body: data.subarray(i) });
      break;
    }
    packets.push({ tag, body: data.subarray(i, i + len) });
    i += len;
  }
  return packets;
}

const read4 = (d: Uint8Array, i: number): number => d[i] * 0x1000000 + (d[i + 1] << 16) + (d[i + 2] << 8) + d[i + 3];

function readPublicKeyPacket(body: Uint8Array): {
  fingerprint: string;
  version: number;
  algorithm: number;
  createdAt?: string;
} {
  const version = body[0];
  if (version !== 4) {
    throw new CoreError(
      `Unsupported key version (v${version}). This build can import version 4 keys.`,
      'malformed',
    );
  }
  const created = read4(body, 1);
  const algorithm = body[5];

  // V4 fingerprint = SHA-1( 0x99 || uint16(len(body)) || body )  (RFC 4880 §12.2).
  const prefixed = new Uint8Array(3 + body.length);
  prefixed[0] = 0x99;
  prefixed[1] = (body.length >> 8) & 0xff;
  prefixed[2] = body.length & 0xff;
  prefixed.set(body, 3);

  return {
    version,
    algorithm,
    fingerprint: sha1Hex(prefixed),
    createdAt: created > 0 ? new Date(created * 1000).toISOString() : undefined,
  };
}

function extractEmail(userId: string): string | undefined {
  const angled = userId.match(/<([^>]+@[^>]+)>/);
  if (angled) return angled[1].trim().toLowerCase();
  const bare = userId.match(/[^\s<>]+@[^\s<>]+/);
  return bare?.[0].toLowerCase();
}

/* -------------------------------------------------------------- sha1 ------ */

/**
 * SHA-1 over bytes → uppercase hex. Used only to derive OpenPGP key
 * fingerprints (an identifier, not a security decision — the native core does
 * real signature verification). Pinned to NIST FIPS-180 vectors in the tests.
 */
export function sha1Hex(bytes: Uint8Array): string {
  const bitLen = bytes.length * 8;
  const total = ((bytes.length + 8) >> 6 << 6) + 64; // room for 0x80 + 64-bit length, padded to 64
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4);
    for (let t = 16; t < 80; t++) {
      const v = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = ((v << 1) | (v >>> 31)) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('').toUpperCase();
}
