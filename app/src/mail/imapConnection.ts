/**
 * One authenticated IMAP session: greeting, TLS, login, then tagged commands
 * one at a time.
 *
 * Commands are strictly sequential. IMAP allows pipelining, but a mail client's
 * work here is a handful of commands per user action, and a queue is what lets
 * every caller read "the untagged responses to *my* command" without
 * attributing a stray `* 3 EXPUNGE` to the wrong request.
 *
 * Security, in the order it is enforced:
 *
 *  1. TLS before anything else is written. `tls` connects over TLS; `starttls`
 *     refuses a server that does not offer STARTTLS rather than falling back to
 *     plaintext, and issues nothing but CAPABILITY and STARTTLS before the upgrade.
 *  2. After STARTTLS, any bytes the server sent *before* the handshake are
 *     discarded — and their presence is treated as an attack (the STARTTLS
 *     command-injection class, CVE-2011-0411), because a correct server sends
 *     nothing between its OK and the handshake.
 *  3. Capabilities advertised before TLS are forgotten and asked for again: an
 *     attacker on the plaintext leg can strip them.
 */
import { encodeUtf8Base64 } from '../lib/base64';
import { astring, CommandPart, ImapResponse, ResponseReader } from './imapWire';
import { MailSocket, OpenSocket, ServerEndpoint } from './socket';
import { latin1ToBytes } from './socket';

export type ImapErrorKind =
  /** The server answered NO. */
  | 'no'
  /** The server answered BAD — this client sent something it could not parse. */
  | 'bad'
  /** The username or password was refused. */
  | 'auth'
  /** The connection is gone: closed, timed out, or never finished connecting. */
  | 'closed'
  /** The server broke the protocol, or refused a security requirement. */
  | 'protocol';

export class ImapError extends Error {
  constructor(
    message: string,
    readonly kind: ImapErrorKind,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ImapError';
  }
}

export type CommandResult = {
  /** The untagged responses that arrived while this command ran. */
  untagged: ImapResponse[];
  /** The tagged completion, always `OK` — NO and BAD throw. */
  done: ImapResponse;
};

export type Selected = { name: string; uidValidity: number; exists: number };

/**
 * Response codes that mean "the server could not check the password right now",
 * as against "the password is wrong" (RFC 5530). Only the second may sign the
 * user out — the first is the server having a bad minute.
 */
const TRANSIENT_AUTH_CODES = ['UNAVAILABLE', 'SERVERBUG', 'INUSE', 'LIMIT', 'CONTACTADMIN'];

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** A command piece, or a line sent only once the server says `+` (SASL without SASL-IR). */
type Part = CommandPart | { continuation: string };

type Pending = {
  tag: string;
  untagged: ImapResponse[];
  resolve(result: CommandResult): void;
  reject(error: Error): void;
  /** Resolved by the next `+` continuation, when the command is waiting for one. */
  onContinue?: () => void;
};

export class ImapConnection {
  capabilities = new Set<string>();
  selected: Selected | null = null;

  private reader = new ResponseReader();
  private pending: Pending | null = null;
  private greeting: { resolve(r: ImapResponse): void; reject(e: Error): void } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private counter = 0;
  private closedWith: Error | null = null;
  /** STARTTLS is running: its OK closes the plaintext leg. */
  private sealing = false;
  /** STARTTLS answered OK and the handshake has not finished: nothing may arrive. */
  private sealed = false;
  /** Something did arrive in that window. */
  private injected = false;

  constructor(
    private socket: MailSocket,
    private host: string,
    private timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ) {
    socket.onData((chunk) => this.receive(chunk));
    socket.onClose((error) => this.lost(error));
  }

  get closed(): boolean {
    return this.closedWith !== null;
  }

  /** The server's first line: `* OK`, `* PREAUTH`, or a refusal. */
  waitForGreeting(): Promise<ImapResponse> {
    return this.withTimeout(
      new Promise<ImapResponse>((resolve, reject) => {
        this.greeting = { resolve, reject };
      }),
      'greeting',
    );
  }

  /**
   * Run one command. Queued behind any command already running, so callers
   * never interleave.
   */
  run(parts: Part | Part[]): Promise<CommandResult> {
    const next = this.chain.then(() => this.execute(Array.isArray(parts) ? parts : [parts]));
    // The queue must survive a failed command; the caller still sees the failure.
    this.chain = next.catch(() => undefined);
    return next;
  }

  hasCapability(name: string): boolean {
    return this.capabilities.has(name.toUpperCase());
  }

  async refreshCapabilities(): Promise<void> {
    const { untagged } = await this.run('CAPABILITY');
    const line = untagged.find((r) => r.kind === 'CAPABILITY');
    this.capabilities = new Set((line?.values ?? []).map((v) => String(v).toUpperCase()));
  }

  /** Adopt a `[CAPABILITY …]` code when the server volunteers one, saving a round trip. */
  adoptCapabilityCode(response: ImapResponse): boolean {
    const m = response.code?.match(/^CAPABILITY (.*)$/i);
    if (!m) return false;
    this.capabilities = new Set(m[1].trim().split(/\s+/).map((c) => c.toUpperCase()));
    return true;
  }

  /**
   * STARTTLS, done so that nothing from the plaintext leg survives it.
   */
  async startTls(): Promise<void> {
    if (!this.hasCapability('STARTTLS')) {
      throw new ImapError(
        `${this.host} does not offer STARTTLS, so the connection cannot be encrypted. CryptMail will not send your password over it.`,
        'protocol',
      );
    }
    this.sealing = true;
    try {
      await this.run('STARTTLS');
    } finally {
      this.sealing = false;
    }
    if (this.injected || this.reader.buffered > 0) {
      this.close();
      throw new ImapError(`${this.host} sent data before the TLS handshake. The connection was dropped.`, 'protocol');
    }
    await this.socket.startTls();
    this.sealed = false;
    // Checked again after the handshake: injected bytes need not share a
    // packet with the OK, and anything that landed while TLS was being set up
    // was still sent in the clear.
    if (this.injected) {
      this.close();
      throw new ImapError(`${this.host} sent data before the TLS handshake. The connection was dropped.`, 'protocol');
    }
    this.capabilities = new Set();
    await this.refreshCapabilities();
  }

  /**
   * Authenticate. LOGIN where it is allowed; AUTHENTICATE PLAIN where the
   * server has disabled LOGIN. Both send the password once, inside TLS.
   */
  async login(username: string, password: string): Promise<void> {
    try {
      let done: ImapResponse;
      if (!this.hasCapability('LOGINDISABLED')) {
        ({ done } = await this.run(['LOGIN ', astring(username), ' ', astring(password)]));
      } else if (this.hasCapability('AUTH=PLAIN')) {
        const token = encodeUtf8Base64(`\u0000${username}\u0000${password}`);
        ({ done } = await this.run(
          this.hasCapability('SASL-IR') ? `AUTHENTICATE PLAIN ${token}` : ['AUTHENTICATE PLAIN', { continuation: token }],
        ));
      } else {
        throw new ImapError(`${this.host} accepts no password sign-in method CryptMail supports.`, 'protocol');
      }
      if (!this.adoptCapabilityCode(done)) await this.refreshCapabilities();
    } catch (e) {
      if (e instanceof ImapError && e.kind === 'no' && !TRANSIENT_AUTH_CODES.includes(firstWord(e.code))) {
        throw new ImapError(e.message, 'auth', e.code);
      }
      throw e;
    }
  }

  /** SELECT, skipped when the mailbox is already selected. */
  async select(name: string): Promise<Selected> {
    if (this.selected?.name === name) return this.selected;
    this.selected = null;
    const { untagged } = await this.run(['SELECT ', astring(name)]);
    let uidValidity = 0;
    let exists = 0;
    for (const r of untagged) {
      if (r.kind === 'EXISTS' && r.num !== undefined) exists = r.num;
      const m = r.code?.match(/^UIDVALIDITY (\d+)/i);
      if (m) uidValidity = Number(m[1]);
    }
    this.selected = { name, uidValidity, exists };
    return this.selected;
  }

  /** Politely end the session, then close. Never throws — it is cleanup. */
  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      await this.run('LOGOUT');
    } catch {
      // Already going away.
    }
    this.close();
  }

  close() {
    this.socket.close();
    this.lost();
  }

  /* ------------------------------------------------------------------------ */

  private async execute(parts: Part[]): Promise<CommandResult> {
    if (this.closedWith) throw this.closedWith;
    const tag = `C${++this.counter}`;
    const result = new Promise<CommandResult>((resolve, reject) => {
      this.pending = { tag, untagged: [], resolve, reject };
    });

    const sendAll = async () => {
      let line = `${tag} `;
      for (const part of parts) {
        if (typeof part === 'string') {
          line += part;
        } else if ('literal' in part) {
          // LITERAL+ lets the bytes follow at once; without it the server has to
          // say `+` first, or it would read the literal as the next command.
          const plus = this.hasCapability('LITERAL+');
          this.write(`${line}{${part.literal.length}${plus ? '+' : ''}}\r\n`);
          if (!plus) await this.continuation();
          this.socket.write(part.literal);
          line = '';
        } else {
          this.write(`${line}\r\n`);
          await this.continuation();
          line = part.continuation;
        }
      }
      this.write(`${line}\r\n`);
    };
    sendAll().catch((e) => this.pending?.reject(e instanceof Error ? e : new Error(String(e))));

    try {
      return await this.withTimeout(result, firstWord(typeof parts[0] === 'string' ? parts[0] : '') || 'command');
    } finally {
      this.pending = null;
    }
  }

  private continuation(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.pending) this.pending.onContinue = resolve;
    });
  }

  private write(text: string) {
    // Every command line this client builds is ASCII — `astring` turns anything
    // else into a literal — so one byte per char is exact.
    this.socket.write(latin1ToBytes(text));
  }

  private receive(chunk: Uint8Array) {
    if (this.sealed) {
      this.injected = true;
      return;
    }
    let responses: ImapResponse[];
    try {
      responses = this.reader.push(chunk);
    } catch (e) {
      this.fail(new ImapError(`${this.host} sent a response CryptMail could not read.`, 'protocol'));
      return;
    }
    for (let i = 0; i < responses.length; i++) {
      this.dispatch(responses[i]);
      // Anything after STARTTLS's OK — the rest of this batch, or bytes still
      // being framed — was sent in plaintext to be read as if it were encrypted.
      if (this.sealed && (i < responses.length - 1 || this.reader.buffered > 0)) this.injected = true;
    }
  }

  private dispatch(r: ImapResponse) {
    if (this.greeting) {
      const g = this.greeting;
      this.greeting = null;
      if (r.tag === '*' && (r.kind === 'OK' || r.kind === 'PREAUTH')) g.resolve(r);
      else g.reject(new ImapError(`${this.host} refused the connection: ${r.text || r.kind}`, 'closed'));
      return;
    }
    const pending = this.pending;
    if (r.tag === '+') {
      const go = pending?.onContinue;
      if (pending) pending.onContinue = undefined;
      go?.();
      return;
    }
    if (r.tag === '*') {
      if (r.kind === 'BYE') {
        this.fail(new ImapError(`${this.host} closed the session: ${r.text || 'BYE'}`, 'closed'));
        return;
      }
      pending?.untagged.push(r);
      return;
    }
    if (!pending || r.tag !== pending.tag) return;
    if (r.kind === 'OK' && this.sealing) this.sealed = true;
    if (r.kind === 'OK') pending.resolve({ untagged: pending.untagged, done: r });
    else pending.reject(new ImapError(r.text || `${r.kind} from ${this.host}`, r.kind === 'NO' ? 'no' : 'bad', r.code));
  }

  private withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ImapError(`${this.host} did not answer (${what}) in time.`, 'closed');
        this.fail(error);
        reject(error);
      }, this.timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private fail(error: Error) {
    this.socket.close();
    this.lost(error);
  }

  private lost(error?: Error) {
    if (this.closedWith) return;
    this.closedWith =
      error instanceof ImapError ? error : new ImapError(`The connection to ${this.host} was lost${error ? `: ${error.message}` : '.'}`, 'closed');
    this.selected = null;
    this.greeting?.reject(this.closedWith);
    this.greeting = null;
    this.pending?.reject(this.closedWith);
  }
}

function firstWord(text: string | undefined): string {
  return (text ?? '').trim().split(/\s+/)[0].toUpperCase();
}

/**
 * Connect, secure, and log in — or throw, leaving nothing open.
 */
export async function connectImap(
  open: OpenSocket,
  endpoint: ServerEndpoint,
  username: string,
  password: string,
  options: { timeoutMs?: number } = {},
): Promise<ImapConnection> {
  const socket = await open({ host: endpoint.host, port: endpoint.port, tls: endpoint.security === 'tls' });
  const connection = new ImapConnection(socket, endpoint.host, options.timeoutMs);
  try {
    const greeting = await connection.waitForGreeting();
    if (greeting.kind === 'PREAUTH') {
      // Authenticated before TLS could be negotiated, which on a `starttls`
      // endpoint means the session can never be upgraded (RFC 3501 §7.1.4).
      if (endpoint.security === 'starttls') {
        throw new ImapError(`${endpoint.host} skipped authentication, so the connection cannot be encrypted.`, 'protocol');
      }
    }
    if (endpoint.security === 'starttls') {
      // Asked for, never adopted from the greeting: capabilities on the
      // plaintext leg are only good for deciding whether STARTTLS exists.
      await connection.refreshCapabilities();
      await connection.startTls();
    } else if (!connection.adoptCapabilityCode(greeting)) {
      await connection.refreshCapabilities();
    }
    if (greeting.kind !== 'PREAUTH') await connection.login(username, password);
    return connection;
  } catch (e) {
    connection.close();
    throw e;
  }
}
