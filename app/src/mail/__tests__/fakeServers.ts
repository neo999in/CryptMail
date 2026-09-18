/**
 * In-memory IMAP and SMTP servers behind the `OpenSocket` seam, for the
 * connector tests. Not a test file itself (no `-test` suffix, so jest's
 * `testMatch` skips it).
 *
 * They are small but honest about the parts the client is most likely to get
 * wrong: literals are counted in bytes, `{n}` waits for the client's go-ahead
 * unless it said `{n+}`, a UID that does not exist makes STORE and MOVE answer
 * OK having done nothing, and every command is logged so a test can assert what
 * was — and was not — sent before TLS.
 */
import { bytesToUtf8, decodeUtf8Base64, utf8ToBytes } from '../../lib/base64';
import { asText, ImapValue, tokenize } from '../imapWire';
import { bytesToLatin1, ByteQueue, MailSocket, OpenSocket } from '../socket';

/* -------------------------------------------------------------------------- */
/*  A socket pair                                                             */
/* -------------------------------------------------------------------------- */

export type ServerEnd = {
  send(text: string | Uint8Array): void;
  close(): void;
  /** Set by the test's server when the client upgrades; resolves the client's `startTls`. */
  onStartTls?: () => Promise<void>;
  tls: boolean;
};

/**
 * A connected pair: what the client writes arrives at `onClientBytes`, and
 * what the server sends is delivered to the client asynchronously — as a real
 * socket would — so nothing depends on synchronous re-entry.
 */
export function socketPair(
  tls: boolean,
  onClientBytes: (bytes: Uint8Array, server: ServerEnd) => void,
): { client: MailSocket; server: ServerEnd } {
  let dataListener: ((chunk: Uint8Array) => void) | null = null;
  const pending: Uint8Array[] = [];
  const closeListeners: ((e?: Error) => void)[] = [];
  let closed = false;

  const deliver = (chunk: Uint8Array) => {
    if (dataListener) dataListener(chunk);
    else pending.push(chunk);
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const l of closeListeners) l();
  };

  const server: ServerEnd = {
    tls,
    send(text) {
      const bytes = typeof text === 'string' ? utf8ToBytes(text) : text;
      setTimeout(() => !closed && deliver(bytes), 0);
    },
    close() {
      setTimeout(finish, 0);
    },
  };

  const client: MailSocket = {
    write(bytes) {
      if (closed) throw new Error('closed');
      onClientBytes(bytes, server);
    },
    async startTls() {
      // A handshake is round trips, not a microtask: anything the server had
      // already put on the wire arrives while it is under way.
      await new Promise((resolve) => setTimeout(resolve, 2));
      await server.onStartTls?.();
      server.tls = true;
    },
    close: finish,
    onData(listener) {
      dataListener = listener;
      for (const chunk of pending.splice(0)) listener(chunk);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
  };
  return { client, server };
}

/* -------------------------------------------------------------------------- */
/*  IMAP                                                                      */
/* -------------------------------------------------------------------------- */

export type FakeMessage = { uid: number; flags: Set<string>; raw: string; internalDate: string };
export type FakeBox = {
  name: string;
  attributes: string[];
  uidValidity: number;
  uidNext: number;
  messages: FakeMessage[];
};

export type ImapOptions = {
  capabilities?: string[];
  /** Offered only before TLS on a STARTTLS endpoint, as a real server does. */
  starttls?: boolean;
  password?: string;
  delimiter?: string;
  /** Tagged NO for LOGIN carries this code (e.g. `UNAVAILABLE`). */
  loginFailureCode?: string;
  /** Something sent in plaintext immediately after STARTTLS's OK — an injection. */
  injectAfterStartTls?: string;
  /** Send the injection in the same packet as the OK, rather than just after it. */
  injectInSameChunk?: boolean;
};

export class FakeImapServer {
  boxes = new Map<string, FakeBox>();
  /** Every command line received, `TLS:` or `PLAIN:` prefixed. */
  log: string[] = [];
  connections = 0;
  /** Live server ends, so a test can drop them. */
  ends: ServerEnd[] = [];
  appended: { box: string; raw: string; flags: string[] }[] = [];
  private options: Required<Omit<ImapOptions, 'loginFailureCode' | 'injectAfterStartTls' | 'injectInSameChunk'>> &
    Pick<ImapOptions, 'loginFailureCode' | 'injectAfterStartTls' | 'injectInSameChunk'>;

  constructor(options: ImapOptions = {}) {
    this.options = {
      capabilities: options.capabilities ?? ['IMAP4rev1', 'LITERAL+', 'MOVE', 'UIDPLUS', 'SPECIAL-USE'],
      starttls: options.starttls ?? false,
      password: options.password ?? 'secret',
      delimiter: options.delimiter ?? '/',
      loginFailureCode: options.loginFailureCode,
      injectAfterStartTls: options.injectAfterStartTls,
      injectInSameChunk: options.injectInSameChunk,
    };
    this.addBox('INBOX');
  }

  addBox(name: string, attributes: string[] = []): FakeBox {
    const box: FakeBox = { name, attributes, uidValidity: 1000 + this.boxes.size, uidNext: 1, messages: [] };
    this.boxes.set(name, box);
    return box;
  }

  addMessage(boxName: string, raw: string, options: { flags?: string[]; internalDate?: string } = {}): FakeMessage {
    const box = this.boxes.get(boxName)!;
    const message: FakeMessage = {
      uid: box.uidNext++,
      flags: new Set(options.flags ?? []),
      raw,
      internalDate: options.internalDate ?? '17-Sep-2026 10:00:00 +0000',
    };
    box.messages.push(message);
    return message;
  }

  /** Drop every open connection, as a server does to an idle session. */
  dropAll() {
    for (const end of this.ends) end.close();
    this.ends = [];
  }

  open: OpenSocket = async ({ tls }) => {
    this.connections++;
    const state = {
      queue: new ByteQueue(),
      parts: [] as (string | Uint8Array)[],
      awaiting: null as null | { size: number },
      selected: null as FakeBox | null,
      authed: false,
    };
    const { client, server } = socketPair(tls, (bytes, end) => {
      state.queue.push(bytes);
      this.pump(state, end);
    });
    this.ends.push(server);
    server.send(`* OK [CAPABILITY ${this.caps(server).join(' ')}] fake ready\r\n`);
    return client;
  };

  private caps(end: ServerEnd): string[] {
    const base = [...this.options.capabilities];
    if (this.options.starttls && !end.tls) return [...base, 'STARTTLS', 'LOGINDISABLED'];
    return base;
  }

  private pump(state: {
    queue: ByteQueue;
    parts: (string | Uint8Array)[];
    awaiting: null | { size: number };
    selected: FakeBox | null;
    authed: boolean;
  }, end: ServerEnd) {
    for (;;) {
      if (state.awaiting) {
        if (state.queue.length < state.awaiting.size) return;
        state.parts.push(state.queue.take(state.awaiting.size));
        state.awaiting = null;
        continue;
      }
      const eol = state.queue.indexOfCrlf();
      if (eol === -1) return;
      const line = bytesToLatin1(state.queue.take(eol + 2), 0, eol);
      const literal = line.match(/\{(\d+)(\+?)\}$/);
      state.parts.push(line);
      if (literal) {
        state.awaiting = { size: Number(literal[1]) };
        if (!literal[2]) end.send('+ go ahead\r\n');
        continue;
      }
      const parts = state.parts;
      state.parts = [];
      this.handle(parts, state, end);
    }
  }

  private handle(
    parts: (string | Uint8Array)[],
    state: { selected: FakeBox | null; authed: boolean },
    end: ServerEnd,
  ) {
    const first = parts[0] as string;
    const [tag, ...restWords] = first.split(' ');
    let command = (restWords[0] ?? '').toUpperCase();
    let argText = restWords.slice(1).join(' ');
    if (command === 'UID') {
      command = `UID ${(restWords[1] ?? '').toUpperCase()}`;
      argText = restWords.slice(2).join(' ');
    }
    this.log.push(`${end.tls ? 'TLS' : 'PLAIN'}: ${first}`);
    const args = tokenize([argText, ...parts.slice(1)]);
    const ok = (text = 'done') => end.send(`${tag} OK ${text}\r\n`);
    const no = (text: string) => end.send(`${tag} NO ${text}\r\n`);

    switch (command) {
      case 'CAPABILITY':
        end.send(`* CAPABILITY ${this.caps(end).join(' ')}\r\n`);
        return ok();
      case 'STARTTLS': {
        const inject = this.options.injectAfterStartTls ?? '';
        if (this.options.injectInSameChunk) return end.send(`${tag} OK begin TLS\r\n${inject}`);
        ok('begin TLS');
        if (inject) end.send(inject);
        return;
      }
      case 'LOGIN': {
        if (!end.tls) return no('Plaintext login refused');
        if (this.options.loginFailureCode) return no(`[${this.options.loginFailureCode}] try later`);
        if (asText(args[1]) !== this.options.password) return no('[AUTHENTICATIONFAILED] Invalid credentials');
        state.authed = true;
        return ok(`[CAPABILITY ${this.caps(end).join(' ')}] logged in`);
      }
      case 'LIST':
        for (const box of this.boxes.values()) {
          end.send(`* LIST (${box.attributes.join(' ')}) "${this.options.delimiter}" "${box.name}"\r\n`);
        }
        return ok();
      case 'SELECT': {
        const box = this.boxes.get(asText(args[0]));
        if (!box) return no('No such mailbox');
        state.selected = box;
        end.send(`* ${box.messages.length} EXISTS\r\n`);
        end.send(`* OK [UIDVALIDITY ${box.uidValidity}] ok\r\n`);
        end.send(`* OK [UIDNEXT ${box.uidNext}] ok\r\n`);
        return ok('[READ-WRITE] selected');
      }
      case 'CREATE':
        this.addBox(asText(args[0]));
        return ok();
      case 'SUBSCRIBE':
      case 'NOOP':
        return ok();
      case 'APPEND': {
        const box = this.boxes.get(asText(args[0]));
        if (!box) return no('[TRYCREATE] No such mailbox');
        const flags = Array.isArray(args[1]) ? args[1].map(asText) : [];
        const body = args.find((a): a is Uint8Array => a instanceof Uint8Array)!;
        const raw = bytesToUtf8(body);
        this.appended.push({ box: box.name, raw, flags });
        this.addMessage(box.name, raw, { flags });
        return ok();
      }
      case 'UID SEARCH':
        return this.search(args, state.selected!, end, tag);
      case 'UID FETCH':
        return this.fetch(args, state.selected!, end, tag);
      case 'UID STORE':
        return this.store(args, state.selected!, end, tag);
      case 'UID MOVE':
      case 'UID COPY':
        return this.move(command === 'UID MOVE', args, state.selected!, end, tag);
      case 'UID EXPUNGE': {
        const box = state.selected!;
        const uids = parseSet(asText(args[0]));
        box.messages = box.messages.filter((m) => {
          const gone = uids.includes(m.uid) && m.flags.has('\\Deleted');
          if (gone) end.send(`* ${box.messages.indexOf(m) + 1} EXPUNGE\r\n`);
          return !gone;
        });
        return ok();
      }
      case 'LOGOUT':
        end.send('* BYE bye\r\n');
        ok();
        return end.close();
      default:
        return end.send(`${tag} BAD unknown command ${command}\r\n`);
    }
  }

  private search(args: ImapValue[], box: FakeBox, end: ServerEnd, tag: string) {
    let matches = box.messages;
    for (let i = 0; i < args.length; i++) {
      const word = asText(args[i]).toUpperCase();
      if (word === 'UNDELETED') matches = matches.filter((m) => !m.flags.has('\\Deleted'));
      if (word === 'UID') {
        const set = parseSet(asText(args[++i]));
        matches = matches.filter((m) => set.includes(m.uid));
      }
      if (word === 'SINCE') i++;
    }
    end.send(`* SEARCH${matches.map((m) => ` ${m.uid}`).join('')}\r\n`);
    end.send(`${tag} OK search done\r\n`);
  }

  private fetch(args: ImapValue[], box: FakeBox, end: ServerEnd, tag: string) {
    const set = parseSet(asText(args[0]));
    const items = (Array.isArray(args[1]) ? args[1] : [args[1]]).map(asText).join(' ').toUpperCase();
    for (const m of box.messages) {
      if (!set.includes(m.uid)) continue;
      const seq = box.messages.indexOf(m) + 1;
      const pieces: (string | Uint8Array)[] = [
        `* ${seq} FETCH (UID ${m.uid} FLAGS (${[...m.flags].join(' ')}) INTERNALDATE "${m.internalDate}"`,
      ];
      if (items.includes('HEADER.FIELDS')) {
        const header = utf8ToBytes(`${m.raw.replace(/\r?\n\r?\n[\s\S]*$/, '').replace(/\r?\n/g, '\r\n')}\r\n\r\n`);
        pieces.push(` BODY[HEADER.FIELDS (FROM)] {${header.length}}\r\n`, header);
      }
      if (items.includes('BODY.PEEK[]')) {
        const body = utf8ToBytes(m.raw);
        pieces.push(` BODY[] {${body.length}}\r\n`, body);
      }
      pieces.push(')\r\n');
      for (const piece of pieces) end.send(piece);
    }
    end.send(`${tag} OK fetch done\r\n`);
  }

  private store(args: ImapValue[], box: FakeBox, end: ServerEnd, tag: string) {
    const set = parseSet(asText(args[0]));
    const op = asText(args[1]).toUpperCase();
    const flags = (Array.isArray(args[2]) ? args[2] : []).map(asText);
    for (const m of box.messages) {
      if (!set.includes(m.uid)) continue;
      for (const f of flags) {
        if (op.startsWith('+')) m.flags.add(f);
        else m.flags.delete(f);
      }
      if (!op.endsWith('.SILENT')) {
        end.send(`* ${box.messages.indexOf(m) + 1} FETCH (UID ${m.uid} FLAGS (${[...m.flags].join(' ')}))\r\n`);
      }
    }
    end.send(`${tag} OK store done\r\n`);
  }

  private move(isMove: boolean, args: ImapValue[], box: FakeBox, end: ServerEnd, tag: string) {
    const uid = Number(asText(args[0]));
    const target = this.boxes.get(asText(args[1]));
    if (!target) return end.send(`${tag} NO [TRYCREATE] No such mailbox\r\n`);
    const message = box.messages.find((m) => m.uid === uid);
    if (!message) return end.send(`${tag} OK nothing to do\r\n`);
    const copy: FakeMessage = { ...message, flags: new Set(message.flags), uid: target.uidNext++ };
    copy.flags.delete('\\Deleted');
    target.messages.push(copy);
    const uidPlus = this.options.capabilities.includes('UIDPLUS');
    const code = uidPlus ? `[COPYUID ${target.uidValidity} ${uid} ${copy.uid}] ` : '';
    if (isMove) {
      if (uidPlus) end.send(`* OK ${code}moved\r\n`);
      end.send(`* ${box.messages.indexOf(message) + 1} EXPUNGE\r\n`);
      box.messages = box.messages.filter((m) => m !== message);
      return end.send(`${tag} OK done\r\n`);
    }
    return end.send(`${tag} OK ${code}copied\r\n`);
  }
}

function parseSet(set: string): number[] {
  const out: number[] = [];
  for (const piece of set.split(',')) {
    const [a, b] = piece.split(':');
    const lo = Number(a);
    const hi = b === undefined ? lo : b === '*' ? 1_000_000 : Number(b);
    for (let n = Math.min(lo, hi); n <= Math.max(lo, hi) && n <= 100_000; n++) out.push(n);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  SMTP                                                                      */
/* -------------------------------------------------------------------------- */

export type SmtpOptions = {
  starttls?: boolean;
  password?: string;
  auth?: string[];
  rejectRecipient?: string;
};

export class FakeSmtpServer {
  log: string[] = [];
  messages: { from: string; recipients: string[]; data: string }[] = [];
  connections = 0;
  private options: Required<Omit<SmtpOptions, 'rejectRecipient'>> & Pick<SmtpOptions, 'rejectRecipient'>;

  constructor(options: SmtpOptions = {}) {
    this.options = {
      starttls: options.starttls ?? false,
      password: options.password ?? 'secret',
      auth: options.auth ?? ['PLAIN', 'LOGIN'],
      rejectRecipient: options.rejectRecipient,
    };
  }

  open: OpenSocket = async ({ tls }) => {
    this.connections++;
    const queue = new ByteQueue();
    const state = { inData: false, from: '', recipients: [] as string[], data: [] as string[], login: 0, user: '' };
    const { client, server } = socketPair(tls, (bytes, end) => {
      queue.push(bytes);
      for (;;) {
        const eol = queue.indexOfCrlf();
        if (eol === -1) return;
        const line = bytesToUtf8(queue.take(eol + 2)).slice(0, -2);
        this.line(line, state, end);
      }
    });
    server.send('220 fake.smtp ready\r\n');
    return client;
  };

  private line(
    line: string,
    state: { inData: boolean; from: string; recipients: string[]; data: string[]; login: number; user: string },
    end: ServerEnd,
  ) {
    if (state.inData) {
      if (line === '.') {
        state.inData = false;
        this.messages.push({ from: state.from, recipients: state.recipients, data: state.data.join('\r\n') });
        state.data = [];
        return end.send('250 queued\r\n');
      }
      state.data.push(line);
      return;
    }
    this.log.push(`${end.tls ? 'TLS' : 'PLAIN'}: ${line}`);
    if (state.login === 1) {
      state.user = line;
      state.login = 2;
      return end.send('334 UGFzc3dvcmQ6\r\n');
    }
    if (state.login === 2) {
      state.login = 0;
      return end.send(
        decodeUtf8Base64(line) === this.options.password ? '235 ok\r\n' : '535 bad credentials\r\n',
      );
    }
    const upper = line.toUpperCase();
    if (upper.startsWith('EHLO')) {
      const ext = [...(this.options.starttls && !end.tls ? ['STARTTLS'] : []), `AUTH ${this.options.auth.join(' ')}`, '8BITMIME'];
      return end.send(['250-fake.smtp', ...ext.map((e, i) => `250${i === ext.length - 1 ? ' ' : '-'}${e}`)].join('\r\n') + '\r\n');
    }
    if (upper === 'STARTTLS') return end.send('220 go ahead\r\n');
    if (upper.startsWith('AUTH PLAIN ')) {
      if (!end.tls) return end.send('538 encryption required\r\n');
      const [, , pass] = decodeUtf8Base64(line.slice(11)).split('\u0000');
      return end.send(pass === this.options.password ? '235 ok\r\n' : '535 bad credentials\r\n');
    }
    if (upper === 'AUTH LOGIN') {
      state.login = 1;
      return end.send('334 VXNlcm5hbWU6\r\n');
    }
    if (upper.startsWith('MAIL FROM:')) {
      state.from = line.match(/<([^>]*)>/)![1];
      state.recipients = [];
      return end.send('250 ok\r\n');
    }
    if (upper.startsWith('RCPT TO:')) {
      const to = line.match(/<([^>]*)>/)![1];
      if (to === this.options.rejectRecipient) return end.send('550 no such user\r\n');
      state.recipients.push(to);
      return end.send('250 ok\r\n');
    }
    if (upper === 'DATA') {
      state.inData = true;
      return end.send('354 go\r\n');
    }
    if (upper === 'QUIT') {
      end.send('221 bye\r\n');
      return end.close();
    }
    return end.send('502 unknown\r\n');
  }
}
