/**
 * SMTP submission (RFC 6409): hand one finished message to the user's own
 * outgoing server. Pure protocol over `MailSocket`.
 *
 * The message arrives here already built — for encrypted mail, already
 * ciphertext (docs/providers.md: connectors move opaque bytes). This file adds
 * nothing to it and removes exactly one thing: the `Bcc` header, which must
 * reach the server as envelope recipients and never as a line every recipient
 * can read.
 *
 * TLS is required the same way as in `imapConnection.ts`: `tls` from the first
 * byte, or STARTTLS before AUTH, never a fallback to plaintext, and nothing the
 * server sent on the plaintext leg survives the upgrade.
 */
import { encodeUtf8Base64, utf8ToBytes } from '../lib/base64';
import { addressesIn, decodeAddress, parseHeaderBlock, splitAddressList } from './headers';
import { ByteQueue, bytesToLatin1, latin1ToBytes, MailSocket, OpenSocket, ServerEndpoint } from './socket';

export type SmtpErrorKind = 'auth' | 'rejected' | 'closed' | 'protocol';

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly kind: SmtpErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

type Reply = { code: number; lines: string[] };

const DEFAULT_TIMEOUT_MS = 60_000;
/** The final reply to DATA can wait on the server's own scanning. RFC 5321 §4.5.3.2 suggests 10 minutes. */
const DATA_TIMEOUT_MS = 5 * 60_000;

/**
 * Who a message goes to, read from its own headers — `To`, `Cc` and `Bcc`.
 * The sender is the `From` address.
 */
export function envelopeOf(rfc822: string): { from: string; recipients: string[] } {
  const headers = parseHeaderBlock(headerBlockOf(rfc822));
  const recipients = [...addressesIn(headers['to']), ...addressesIn(headers['cc']), ...addressesIn(headers['bcc'])];
  return {
    from: decodeAddress(splitAddressList(headers['from'] ?? '')[0] ?? '').address,
    recipients: [...new Set(recipients)],
  };
}

function headerBlockOf(rfc822: string): string {
  const normalized = rfc822.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  return split === -1 ? normalized : normalized.slice(0, split);
}

/**
 * The bytes for DATA: `Bcc` removed, CRLF line endings, leading dots doubled
 * (RFC 5321 §4.5.2) so a line of "." in a body cannot end the message early,
 * and the terminating `.`.
 */
export function dataFor(rfc822: string): Uint8Array {
  const normalized = rfc822.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  const head = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? '' : normalized.slice(split + 2);

  // A header and its folded continuation lines go together.
  const kept: string[] = [];
  let dropping = false;
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line)) {
      if (!dropping) kept.push(line);
      continue;
    }
    dropping = /^bcc\s*:/i.test(line);
    if (!dropping) kept.push(line);
  }

  const text = `${kept.join('\n')}\n\n${body}`
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
  return utf8ToBytes(`${text.endsWith('\r\n') ? text : `${text}\r\n`}.\r\n`);
}

class SmtpSession {
  private queue = new ByteQueue();
  private waiting: { resolve(r: Reply): void; reject(e: Error): void } | null = null;
  private closedWith: Error | null = null;
  private lines: string[] = [];
  private replies: Reply[] = [];

  constructor(
    private socket: MailSocket,
    private host: string,
    private timeoutMs: number,
  ) {
    socket.onData((chunk) => this.receive(chunk));
    socket.onClose((error) => {
      this.closedWith = new SmtpError(`The connection to ${host} was lost${error ? `: ${error.message}` : '.'}`, 'closed');
      this.waiting?.reject(this.closedWith);
      this.waiting = null;
    });
  }

  /** Bytes or whole replies that arrived without being asked for. */
  get unread(): boolean {
    return this.queue.length > 0 || this.replies.length > 0 || this.lines.length > 0;
  }

  private receive(chunk: Uint8Array) {
    this.queue.push(chunk);
    for (;;) {
      const eol = this.queue.indexOfCrlf();
      if (eol === -1) break;
      const line = bytesToLatin1(this.queue.take(eol + 2), 0, eol);
      this.lines.push(line);
      // `250-…` continues a reply; `250 …` (or a bare `250`) ends it.
      if (/^\d{3}(?: |$)/.test(line)) {
        this.replies.push({ code: Number(line.slice(0, 3)), lines: this.lines.map((l) => l.slice(4)) });
        this.lines = [];
      }
    }
    if (this.waiting && this.replies.length) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve(this.replies.shift()!);
    }
  }

  read(timeoutMs = this.timeoutMs): Promise<Reply> {
    if (this.replies.length) return Promise.resolve(this.replies.shift()!);
    if (this.closedWith) return Promise.reject(this.closedWith);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        this.socket.close();
        reject(new SmtpError(`${this.host} did not answer in time.`, 'closed'));
      }, timeoutMs);
      this.waiting = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  /** Send a line and read the reply, which must be one of `expect`. */
  async command(line: string, expect: number[], describe = line.split(' ')[0]): Promise<Reply> {
    this.socket.write(latin1ToBytes(`${line}\r\n`));
    return this.expect(expect, describe);
  }

  async expect(expect: number[], describe: string, timeoutMs?: number): Promise<Reply> {
    const reply = await this.read(timeoutMs);
    if (!expect.includes(reply.code)) {
      throw new SmtpError(
        `${this.host} refused ${describe}: ${reply.code} ${reply.lines.join(' ').trim()}`,
        reply.code === 535 || reply.code === 534 ? 'auth' : 'rejected',
        reply.code,
      );
    }
    return reply;
  }

  write(bytes: Uint8Array) {
    this.socket.write(bytes);
  }

  async startTls() {
    await this.socket.startTls();
  }

  close() {
    this.socket.close();
  }
}

/** EHLO's extension keywords, upper-cased, each with its parameters. */
function extensionsOf(reply: Reply): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of reply.lines.slice(1)) {
    const [keyword, ...rest] = line.trim().split(/\s+/);
    if (keyword) out.set(keyword.toUpperCase(), rest.join(' ').toUpperCase());
  }
  return out;
}

/**
 * Deliberately not the device's hostname: EHLO's argument lands in the
 * `Received:` header every recipient sees, and a phone's name is not theirs to
 * know. A bare address literal is what Thunderbird sends for the same reason.
 */
const EHLO_NAME = '[127.0.0.1]';

async function openSession(
  open: OpenSocket,
  endpoint: ServerEndpoint,
  username: string,
  password: string,
  timeoutMs: number,
): Promise<{ session: SmtpSession; extensions: Map<string, string> }> {
  const socket = await open({ host: endpoint.host, port: endpoint.port, tls: endpoint.security === 'tls' });
  const session = new SmtpSession(socket, endpoint.host, timeoutMs);
  try {
    await session.expect([220], 'the connection');
    let extensions = extensionsOf(await session.command(`EHLO ${EHLO_NAME}`, [250]));

    if (endpoint.security === 'starttls') {
      if (!extensions.has('STARTTLS')) {
        throw new SmtpError(
          `${endpoint.host} does not offer STARTTLS, so the connection cannot be encrypted. CryptMail will not send your password over it.`,
          'protocol',
        );
      }
      await session.command('STARTTLS', [220]);
      if (session.unread) {
        throw new SmtpError(`${endpoint.host} sent data before the TLS handshake. The connection was dropped.`, 'protocol');
      }
      await session.startTls();
      // Again once the handshake is done: bytes that arrived while it ran were
      // still plaintext, and must not be read as the answer to the next command.
      if (session.unread) {
        throw new SmtpError(`${endpoint.host} sent data before the TLS handshake. The connection was dropped.`, 'protocol');
      }
      // Re-asked inside TLS: the plaintext answer could have been edited.
      extensions = extensionsOf(await session.command(`EHLO ${EHLO_NAME}`, [250]));
    }

    const mechanisms = (extensions.get('AUTH') ?? '').split(/\s+/);
    if (mechanisms.includes('PLAIN')) {
      const token = encodeUtf8Base64(`\u0000${username}\u0000${password}`);
      await session.command(`AUTH PLAIN ${token}`, [235], 'the password');
    } else if (mechanisms.includes('LOGIN')) {
      await session.command('AUTH LOGIN', [334], 'the password');
      await session.command(encodeUtf8Base64(username), [334], 'the username');
      await session.command(encodeUtf8Base64(password), [235], 'the password');
    } else {
      throw new SmtpError(`${endpoint.host} accepts no password sign-in method CryptMail supports.`, 'protocol');
    }
    return { session, extensions };
  } catch (e) {
    session.close();
    throw e;
  }
}

async function quit(session: SmtpSession) {
  try {
    await session.command('QUIT', [221]);
  } catch {
    // The message is already accepted; how the goodbye goes changes nothing.
  }
  session.close();
}

/**
 * Submit one message. Resolves only once the server has accepted it for
 * delivery (the 250 after DATA) — before that, nothing has been sent.
 */
export async function sendSmtp(
  open: OpenSocket,
  endpoint: ServerEndpoint,
  username: string,
  password: string,
  rfc822: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const { from, recipients } = envelopeOf(rfc822);
  if (!from) throw new SmtpError('The message has no From address.', 'protocol');
  if (recipients.length === 0) throw new SmtpError('The message has no recipients.', 'protocol');
  // Each address becomes part of a command line, so one carrying a space, an
  // angle bracket or a line break could smuggle a second command in.
  for (const address of [from, ...recipients]) {
    if (!/^[^\s<>]+@[^\s<>]+$/.test(address)) {
      throw new SmtpError(`"${address}" is not an address CryptMail can send to.`, 'protocol');
    }
  }

  const { session, extensions } = await openSession(open, endpoint, username, password, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const data = dataFor(rfc822);
    const eightBit = data.some((b) => b > 0x7f);
    const params = [
      eightBit && extensions.has('8BITMIME') ? 'BODY=8BITMIME' : '',
      /[^\x00-\x7f]/.test([from, ...recipients].join('')) && extensions.has('SMTPUTF8') ? 'SMTPUTF8' : '',
    ].filter(Boolean);
    await session.command(`MAIL FROM:<${from}>${params.length ? ` ${params.join(' ')}` : ''}`, [250], 'the sender');
    for (const to of recipients) {
      await session.command(`RCPT TO:<${to}>`, [250, 251], `the recipient ${to}`);
    }
    await session.command('DATA', [354], 'the message');
    session.write(data);
    await session.expect([250], 'the message', DATA_TIMEOUT_MS);
  } catch (e) {
    session.close();
    throw e;
  }
  await quit(session);
}

/** Sign in and out again — proof the settings work, sending nothing. */
export async function verifySmtp(
  open: OpenSocket,
  endpoint: ServerEndpoint,
  username: string,
  password: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const { session } = await openSession(open, endpoint, username, password, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  await quit(session);
}
