/**
 * A byte stream to a mail server — the one thing IMAP and SMTP need that
 * `fetch` cannot give them.
 *
 * Everything protocol-shaped (`imapConnection.ts`, `smtp.ts`) is written against
 * this interface and nothing else, so it runs under jest against a scripted
 * server and never learns which native library carries the bytes. The one
 * implementation that touches the network is `tcpSocket.ts`.
 *
 * TLS is not optional anywhere in this seam (docs/providers.md: "Reject
 * plaintext ports"). A connection is either TLS from its first byte, or it is
 * upgraded with STARTTLS before a credential is written — and the upgrade is
 * something the protocol layer must complete, not attempt.
 */

/** How a server is reached. There is deliberately no `'none'`. */
export type Security = 'tls' | 'starttls';

export type ServerEndpoint = {
  host: string;
  port: number;
  security: Security;
};

export interface MailSocket {
  write(bytes: Uint8Array): void;
  /**
   * Upgrade this connection to TLS in place (STARTTLS), resolving once the
   * handshake is done **and** the certificate has been checked against the host.
   * A mismatch rejects and closes the socket; nothing more is written to it.
   */
  startTls(): Promise<void>;
  close(): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  /** Fires once, however the connection ended. `error` is absent for a clean close. */
  onClose(listener: (error?: Error) => void): void;
}

/**
 * Open a connection. With `tls: true` the promise resolves only after the
 * handshake and the host check, so a caller never writes to an unverified peer.
 */
export type OpenSocket = (target: { host: string; port: number; tls: boolean }) => Promise<MailSocket>;

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

/**
 * Whether a certificate's subject common name names this host (RFC 6125 §6.4).
 *
 * Only the CN, because it is all the socket library reports — see `tcpSocket.ts`
 * for why the check has to happen here at all. A wildcard covers exactly one
 * whole leftmost label: `*.example.com` names `imap.example.com`, but neither
 * `example.com` nor `a.b.example.com`, and a wildcard never names an IP address.
 *
 * Being strict costs a refusal on the rare server whose CN is a different one of
 * its names; being loose would accept a certificate for a host the user never
 * typed, which is the attack this exists to stop.
 */
export function certificateMatchesHost(commonName: string | undefined, host: string): boolean {
  if (!commonName) return false;
  const name = commonName.trim().toLowerCase().replace(/\.$/, '');
  const target = host.trim().toLowerCase().replace(/\.$/, '');
  if (!name || !target) return false;
  if (name === target) return true;
  if (!name.startsWith('*.')) return false;
  if (/^[\d.]+$/.test(target) || target.includes(':')) return false;
  const suffix = name.slice(1); // ".example.com"
  if (!target.endsWith(suffix)) return false;
  const label = target.slice(0, -suffix.length);
  return label.length > 0 && !label.includes('.');
}

/* -------------------------------------------------------------------------- */
/*  Bytes                                                                     */
/* -------------------------------------------------------------------------- */

/** ASCII/latin-1 text to bytes, one byte per char. Protocol lines are ASCII. */
export function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Bytes to a string of one char per byte — lossless, for protocol parsing. */
export function bytesToLatin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = '';
  // Chunked, because `String.fromCharCode(...bigArray)` overflows the stack on
  // a multi-megabyte literal.
  for (let i = start; i < end; i += 8192) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + 8192, end))));
  }
  return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A growable receive buffer: bytes arrive in arbitrary chunks, and both
 * protocols read whole lines (plus, for IMAP, exact-length literals) off it.
 *
 * Capacity doubles rather than the buffer being re-concatenated per chunk: a
 * 5 MB message arrives in hundreds of small chunks, and copying everything held
 * on each one is quadratic in the size of the message.
 */
export class ByteQueue {
  private buf = new Uint8Array(4096);
  private start = 0;
  private end = 0;

  push(chunk: Uint8Array) {
    if (this.end + chunk.length > this.buf.length) {
      const held = this.end - this.start;
      const next = held + chunk.length > this.buf.length ? new Uint8Array(Math.max(this.buf.length * 2, held + chunk.length)) : this.buf;
      next.set(this.buf.subarray(this.start, this.end), 0);
      this.buf = next;
      this.start = 0;
      this.end = held;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }

  get length() {
    return this.end - this.start;
  }

  /** Index (relative to the front) of the first CRLF at or after `from`, or -1. */
  indexOfCrlf(from = 0): number {
    for (let i = this.start + from; i + 1 < this.end; i++) {
      if (this.buf[i] === 13 && this.buf[i + 1] === 10) return i - this.start;
    }
    return -1;
  }

  peek(start: number, end: number): Uint8Array {
    return this.buf.subarray(this.start + start, this.start + end);
  }

  /** Remove and return the first `n` bytes. */
  take(n: number): Uint8Array {
    const head = this.buf.slice(this.start, this.start + n);
    this.start += n;
    if (this.start === this.end) this.start = this.end = 0;
    return head;
  }
}
