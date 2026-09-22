/**
 * Generic IMAP (read) + SMTP (send) connector — iCloud, Yahoo, Fastmail, a
 * company's own server, anything that speaks the standards.
 *
 * Same `MailClient` contract as `gmail.ts` and `graph.ts`, so nothing above this
 * line knows which one it has. Four things differ enough to shape this file:
 *
 *  1. **A message's id is where it is.** An IMAP UID is only unique inside one
 *     folder and one UIDVALIDITY, so an id here is all three:
 *     `<uidvalidity>:<uid>:<folder>`. Under the same validity a UID is never
 *     reused, which is what lets the raw cache key on it.
 *  2. **Moves change the id.** Archive, delete and junk are moves between
 *     folders, and the message gets a new UID in the destination — the problem
 *     Graph solves with immutable ids. The server reports the new UID
 *     (`COPYUID`, RFC 4315) and this client remembers the mapping, so the undo of
 *     a swipe still names the message it moved.
 *  3. **Folders are found, not assumed.** Sent, Archive, Junk and Trash are
 *     whatever the server marks with SPECIAL-USE (RFC 6154) attributes, and only
 *     failing that the usual names.
 *  4. **Sending does not file a copy.** SMTP delivers; it does not put anything
 *     in Sent. So after a send the same bytes — already ciphertext — are
 *     APPENDed there, unless the server is one known to file its own.
 */
import { AuthError } from '../auth/types';
import { bytesToUtf8, utf8ToBytes } from '../lib/base64';
import { addressesIn, decodeAddress, decodeEncodedWords, parseHeaderBlock, splitAddressList } from './headers';
import { connectImap, ImapConnection, ImapError } from './imapConnection';
import { asText, astring, fetchAttributes, ImapValue, imapDate, parseInternalDate, uidSet } from './imapWire';
import { sendSmtp, SmtpError } from './smtp';
import { OpenSocket, ServerEndpoint, TransportError } from './socket';
import { FlagPatch, MailClient, MailError, Mailbox, MailSummary } from './types';

/** Everything needed to reach one mailbox, except the password. */
export type ImapAccount = {
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  /** Usually the address, sometimes only its local part — the server decides. */
  username: string;
  /**
   * APPEND each sent message to the Sent folder. Off for servers that file
   * their own copy of mail submitted over SMTP, where it would be a duplicate.
   */
  saveSentCopy: boolean;
};

/** Hosts whose SMTP files the Sent copy itself. Appending there too would double it. */
const FILES_OWN_SENT = [/(^|\.)gmail\.com$/i, /(^|\.)googlemail\.com$/i, /(^|\.)office365\.com$/i, /(^|\.)outlook\.com$/i];

export function filesOwnSentCopy(smtpHost: string): boolean {
  return FILES_OWN_SENT.some((re) => re.test(smtpHost.trim()));
}

/** The folder a message was listed from, as the label the rest of the app reads — as in graph.ts. */
const LABEL: Record<Mailbox, string> = {
  inbox: 'INBOX',
  sent: 'SENT',
  archive: 'ARCHIVE',
  spam: 'JUNK',
  trash: 'TRASH',
};

/** SPECIAL-USE attributes (RFC 6154), and the names servers used before it. */
const SPECIAL: Record<Exclude<Mailbox, 'inbox'>, { attribute: string; names: string[]; create: string }> = {
  sent: { attribute: '\\sent', names: ['sent', 'sent items', 'sent messages', 'sent mail'], create: 'Sent' },
  archive: { attribute: '\\archive', names: ['archive', 'archives'], create: 'Archive' },
  spam: { attribute: '\\junk', names: ['junk', 'spam', 'junk e-mail', 'junk email', 'bulk mail'], create: 'Junk' },
  trash: { attribute: '\\trash', names: ['trash', 'deleted items', 'deleted messages', 'bin'], create: 'Trash' },
};

/**
 * Header fields fetched for a list row. The same set Gmail's metadata request
 * asks for, and for the same reasons — Autocrypt for key harvest, the envelope
 * four for the spam engine — plus In-Reply-To, which threading needs here
 * because IMAP has no thread id of its own.
 */
const ROW_HEADERS = [
  'FROM',
  'TO',
  'SUBJECT',
  'DATE',
  'MESSAGE-ID',
  'REFERENCES',
  'IN-REPLY-TO',
  'AUTOCRYPT',
  'REPLY-TO',
  'AUTHENTICATION-RESULTS',
  'LIST-UNSUBSCRIBE',
  'RETURN-PATH',
];

type Folder = { name: string; delimiter: string | null; attributes: string[] };

type Deps = {
  open: OpenSocket;
  /** How long an unused session stays open before it is logged out. */
  idleMs?: number;
  timeoutMs?: number;
};

/**
 * Long enough that paging through a list reuses one session, short enough not
 * to hold a connection — and the radio — open while nobody is reading mail.
 */
const IDLE_CLOSE_MS = 2 * 60_000;

/* -------------------------------------------------------------------------- */
/*  Ids                                                                       */
/* -------------------------------------------------------------------------- */

export function messageId(folder: string, uidValidity: number, uid: number): string {
  return `${uidValidity}:${uid}:${folder}`;
}

export function parseMessageId(id: string): { folder: string; uidValidity: number; uid: number } {
  const m = id.match(/^(\d+):(\d+):(.+)$/s);
  if (!m) throw new MailError('That is not a message id from this mailbox.', 404);
  return { uidValidity: Number(m[1]), uid: Number(m[2]), folder: m[3] };
}

/* -------------------------------------------------------------------------- */
/*  The client                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The servers and the password, read when a connection is opened rather than
 * captured when the client is built — the keystore is async, and a re-sign-in
 * that changes either should reach the next connect without rebuilding clients.
 */
export type ImapCredentials = () => Promise<{ account: ImapAccount; password: string }>;

export function createImapClient(address: string, credentials: ImapCredentials, deps: Deps): MailClient {
  /** For error messages before the credentials have been read. */
  let host = address.split('@')[1] ?? address;
  let connection: Promise<ImapConnection> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let folders: Folder[] | null = null;
  /** Old id → id after a move, so an undo still finds the message. */
  const moved = new Map<string, string>();
  /**
   * Whole operations, one at a time. A connection has one selected folder, so
   * two lists running at once — the merged inbox asks for inbox and junk
   * together — would each SELECT under the other's SEARCH.
   */
  let operations: Promise<unknown> = Promise.resolve();

  async function connect(): Promise<ImapConnection> {
    if (connection) {
      const existing = await connection.catch(() => null);
      if (existing && !existing.closed) return existing;
    }
    const opening = (async () => {
      const { account, password } = await credentials();
      host = account.imap.host;
      return connectImap(deps.open, account.imap, account.username, password, deps);
    })();
    connection = opening;
    opening.catch(() => {
      if (connection === opening) connection = null;
    });
    return opening;
  }

  /** Run one operation on a live session, reconnecting once if the old one had died. */
  function exclusive<T>(work: (c: ImapConnection) => Promise<T>): Promise<T> {
    const run = operations.then(async () => {
      clearTimeout(idleTimer);
      try {
        try {
          return await work(await connect());
        } catch (e) {
          // A server drops an idle session without telling anyone; the first
          // command after that finds out. One retry on a fresh connection, and
          // only for that — a NO is an answer, not a dropped line.
          if (e instanceof ImapError && e.kind === 'closed') {
            connection = null;
            return await work(await connect());
          }
          throw e;
        }
      } catch (e) {
        throw translate(e, host);
      } finally {
        // Queued like any operation, so an idle logout can never land between
        // another operation's SELECT and its SEARCH.
        idleTimer = setTimeout(() => {
          operations = operations.then(close).catch(() => undefined);
        }, deps.idleMs ?? IDLE_CLOSE_MS);
      }
    });
    operations = run.catch(() => undefined);
    return run;
  }

  async function close() {
    const c = connection;
    connection = null;
    const live = await c?.catch(() => null);
    await live?.logout();
  }

  async function listFolders(c: ImapConnection): Promise<Folder[]> {
    if (folders) return folders;
    const { untagged } = await c.run('LIST "" "*"');
    folders = untagged
      .filter((r) => r.kind === 'LIST')
      .map((r) => ({
        attributes: (Array.isArray(r.values[0]) ? r.values[0] : []).map((a) => asText(a).toLowerCase()),
        delimiter: r.values[1] == null ? null : asText(r.values[1]),
        name: asText(r.values[2]),
      }))
      .filter((f) => f.name && !f.attributes.includes('\\noselect') && !f.attributes.includes('\\nonexistent'));
    return folders;
  }

  /** The folder behind a mailbox, or null when the server has none. */
  async function folderFor(c: ImapConnection, box: Mailbox): Promise<string | null> {
    if (box === 'inbox') return 'INBOX';
    const all = await listFolders(c);
    const want = SPECIAL[box];
    const marked = all.find((f) => f.attributes.includes(want.attribute));
    if (marked) return marked.name;
    const leaf = (f: Folder) => (f.delimiter ? f.name.split(f.delimiter).pop()! : f.name).toLowerCase();
    // Name order, not LIST order: "Sent" beats "Sent Messages" when a server has both.
    for (const name of want.names) {
      const found = all.find((f) => leaf(f) === name);
      if (found) return found.name;
    }
    return null;
  }

  /**
   * The folder to move into, made if it does not exist — as Thunderbird does
   * the first time a user archives on a server with no Archive folder. Placed
   * beside the others: under `INBOX.` on servers that keep every folder there.
   */
  async function ensureFolder(c: ImapConnection, box: Mailbox): Promise<string> {
    const existing = await folderFor(c, box);
    if (existing) return existing;
    const all = await listFolders(c);
    const delimiter = all.find((f) => f.delimiter)?.delimiter ?? '/';
    const nested = all.length > 1 && all.every((f) => f.name.toUpperCase() === 'INBOX' || f.name.toUpperCase().startsWith(`INBOX${delimiter}`));
    const name = nested ? `INBOX${delimiter}${SPECIAL[box as Exclude<Mailbox, 'inbox'>].create}` : SPECIAL[box as Exclude<Mailbox, 'inbox'>].create;
    await c.run(['CREATE ', astring(name)]);
    await c.run(['SUBSCRIBE ', astring(name)]).catch(() => undefined);
    folders = null;
    return name;
  }

  /** Follow the move chain to where a message is now. */
  function current(id: string): string {
    let at = id;
    for (let hops = 0; moved.has(at) && hops < 16; hops++) at = moved.get(at)!;
    return at;
  }

  /** Select the message's folder and check its UIDs still mean what they did. */
  async function locate(c: ImapConnection, id: string) {
    const where = parseMessageId(current(id));
    if (where.uidValidity === 0) {
      throw new MailError('The server moved this message without saying where to. Refresh to find it.', 404);
    }
    const selected = await c.select(where.folder);
    if (selected.uidValidity !== where.uidValidity) {
      throw new MailError('This folder was rebuilt on the server since the list was loaded. Refresh to see it again.', 404);
    }
    return where;
  }

  return {
    kind: 'imap',
    address,

    list(box, { limit = 20, pageToken, newerThanDays, from } = {}) {
      return exclusive(async (c) => {
        const folder = await folderFor(c, box);
        if (!folder) return { messages: [] };
        // A folder already selected on this session is not selected again, so
        // ask the server to report what arrived since — a list is exactly where
        // new mail has to show up. NOOP is the cheapest command that does it.
        if (c.selected?.name === folder) await c.run('NOOP');
        const selected = await c.select(folder);

        let before: number | undefined;
        if (pageToken) {
          const [validity, uid] = pageToken.split(':').map(Number);
          // A cursor from before the folder was rebuilt points at nothing.
          if (validity !== selected.uidValidity || !(uid > 1)) return { messages: [] };
          before = uid;
        }

        // UNDELETED: on a server without MOVE, a moved message lingers flagged
        // \Deleted until it is expunged, and it is already in its new folder.
        const criteria = ['UNDELETED'];
        if (before) criteria.push(`UID 1:${before - 1}`);
        if (newerThanDays && newerThanDays > 0) {
          criteria.push(`SINCE ${imapDate(new Date(Date.now() - Math.floor(newerThanDays) * 86_400_000))}`);
        }
        if (from) {
          // A quoted string: an address carrying a quote, a backslash or a line
          // break could otherwise end it and add commands, so none is searched.
          if (/["\\\r\n]/.test(from)) return { messages: [] };
          criteria.push(`FROM "${from}"`);
        }
        const { untagged } = await c.run(`UID SEARCH ${criteria.join(' ')}`);
        const uids = untagged
          .filter((r) => r.kind === 'SEARCH')
          .flatMap((r) => r.values.map((v) => Number(asText(v))))
          .filter((n) => Number.isInteger(n) && n > 0)
          .sort((a, b) => b - a);

        const page = uids.slice(0, limit);
        if (page.length === 0) return { messages: [] };
        const fetched = await c.run(
          `UID FETCH ${uidSet(page)} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (${ROW_HEADERS.join(' ')})])`,
        );
        const messages = fetched.untagged
          .filter((r) => r.kind === 'FETCH')
          .map((r) => toSummary(fetchAttributes(r.values), folder, selected.uidValidity, box))
          .filter((m): m is MailSummary => m !== null)
          .sort((a, b) => parseMessageId(b.id).uid - parseMessageId(a.id).uid);

        return {
          messages,
          // Only while older mail remains: an absent cursor is what ends paging.
          nextPageToken: uids.length > limit ? `${selected.uidValidity}:${page[page.length - 1]}` : undefined,
        };
      });
    },

    getRaw(id) {
      return exclusive(async (c) => {
        const { uid } = await locate(c, id);
        // PEEK, so opening a message does not mark it read behind the app's back
        // — reading is its own flag change, made through `updateFlags`.
        const { untagged } = await c.run(`UID FETCH ${uid} (UID BODY.PEEK[])`);
        for (const r of untagged) {
          if (r.kind !== 'FETCH') continue;
          const attrs = fetchAttributes(r.values);
          const body = attrs['BODY[]'];
          if (body instanceof Uint8Array) return bytesToUtf8(body);
          if (typeof body === 'string') return body;
        }
        throw new MailError('That message is no longer on the server.', 404);
      });
    },

    async send(rfc822) {
      // Delivery first, and on its own: once SMTP has accepted the message it
      // is sent, whatever happens to the Sent copy. Letting an APPEND failure
      // throw from here would tell the outbox the send failed, and its retry
      // would deliver the message twice.
      const { account, password } = await credentials();
      try {
        await sendSmtp(deps.open, account.smtp, account.username, password, rfc822, deps);
      } catch (e) {
        throw translate(e, account.smtp.host);
      }
      if (!account.saveSentCopy) return;
      try {
        await exclusive(async (c) => {
          const sent = await ensureFolder(c, 'sent');
          // The same bytes that were submitted — so for encrypted mail, the Sent
          // copy is ciphertext too, exactly as Gmail's and Outlook's are.
          await c.run(['APPEND ', astring(sent), ' (\\Seen) ', { literal: utf8ToBytes(crlf(rfc822)) }]);
        });
      } catch (e) {
        console.warn(`[imap] sent, but could not file a copy in Sent: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    updateFlags(id, patch) {
      return exclusive(async (c) => {
        const { uid, folder } = await locate(c, id);

        const add: string[] = [];
        const remove: string[] = [];
        if (patch.unread === true) remove.push('\\Seen');
        if (patch.unread === false) add.push('\\Seen');
        if (patch.starred === true) add.push('\\Flagged');
        if (patch.starred === false) remove.push('\\Flagged');
        for (const [sign, flags] of [['+', add], ['-', remove]] as const) {
          if (flags.length === 0) continue;
          // Not .SILENT: the FETCH it answers with is how a UID that no longer
          // exists is told apart from a change that happened — a STORE on a
          // missing UID is an OK that did nothing.
          const { untagged } = await c.run(`UID STORE ${uid} ${sign}FLAGS (${flags.join(' ')})`);
          if (!untagged.some((r) => r.kind === 'FETCH')) {
            throw new MailError('That message is no longer in this folder.', 404);
          }
        }

        const box = destinationOf(patch);
        if (!box) return;
        const target = box === 'inbox' ? 'INBOX' : await ensureFolder(c, box);
        if (target === folder) return;
        const next = await move(c, uid, target);
        moved.set(current(id), next);
      });
    },
  };

  /**
   * Move one message and return its id in the destination.
   *
   * MOVE where the server has it (RFC 6851). Otherwise COPY, flag the original
   * \Deleted, and expunge *only that UID* — which needs UIDPLUS; a plain EXPUNGE
   * would also erase anything else the user had flagged for deletion in
   * another client. Without UIDPLUS the original is left flagged, and the list
   * skips it (UNDELETED).
   */
  async function move(c: ImapConnection, uid: number, target: string): Promise<string> {
    const canMove = c.hasCapability('MOVE');
    const uidPlus = c.hasCapability('UIDPLUS');
    const responses = await c.run([canMove ? 'UID MOVE ' : 'UID COPY ', `${uid} `, astring(target)]);

    const copyUid = [...responses.untagged, responses.done]
      .map((r) => r.code?.match(/^COPYUID (\d+) (\d+) (\d+)$/i))
      .find(Boolean);
    const expunged = responses.untagged.some((r) => r.kind === 'EXPUNGE' || r.kind === 'VANISHED');
    // A MOVE or COPY of a UID that no longer exists is an OK that did nothing.
    // What gives it away is the absence of what a real move reports: the source
    // copy expunged, or — with UIDPLUS — the new UID. Without either, a server
    // with neither MOVE nor UIDPLUS cannot say, and the copy is trusted.
    const nothingMoved = canMove ? !copyUid && !expunged : uidPlus && !copyUid;
    if (nothingMoved) throw new MailError('That message is no longer in this folder.', 404);

    if (!canMove) {
      await c.run(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
      if (uidPlus) await c.run(`UID EXPUNGE ${uid}`);
    }

    if (!copyUid) {
      // Moved, but the server did not say to where. The id the app holds can
      // no longer be followed, so an undo will fail loudly rather than act on
      // some other message.
      return messageId(target, 0, 0);
    }
    return messageId(target, Number(copyUid[1]), Number(copyUid[3]));
  }
}

/** Which folder a patch moves a message to — trash, then junk, then archive, as in graph.ts. */
function destinationOf(patch: FlagPatch): Mailbox | null {
  if (patch.trashed !== undefined) return patch.trashed ? 'trash' : 'inbox';
  if (patch.junk !== undefined) return patch.junk ? 'spam' : 'inbox';
  if (patch.archived !== undefined) return patch.archived ? 'archive' : 'inbox';
  return null;
}

/** RFC 5322 wants CRLF; APPEND stores exactly what it is given. */
function crlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/**
 * The conversation a message belongs to, from its own headers.
 *
 * IMAP has no thread id, but a reply names its ancestors: the first id in
 * `References` is the conversation's root, and a message that names none is a
 * root itself. Cleartext metadata, like Gmail's threadId — encrypted mail
 * carries the same threading headers in the clear (message-format.md).
 */
export function threadRoot(headers: Record<string, string>): string | undefined {
  const ids = (value?: string) => value?.match(/<[^<>\s]+>/g) ?? [];
  return ids(headers['references'])[0] ?? ids(headers['in-reply-to'])[0] ?? ids(headers['message-id'])[0];
}

function toSummary(
  attrs: Record<string, ImapValue>,
  folder: string,
  uidValidity: number,
  box: Mailbox,
): MailSummary | null {
  const uid = Number(asText(attrs['UID']));
  if (!Number.isInteger(uid) || uid <= 0) return null;
  const headerKey = Object.keys(attrs).find((k) => k.startsWith('BODY['));
  const headers = parseHeaderBlock(headerKey ? asText(attrs[headerKey]) : '');
  const flags = (Array.isArray(attrs['FLAGS']) ? attrs['FLAGS'] : []).map((f) => asText(f).toLowerCase());
  const header = (name: string) => headers[name] ?? '';

  const sent = parseInternalDate(asText(attrs['INTERNALDATE'])) ?? dateHeader(header('date'));

  return {
    id: messageId(folder, uidValidity, uid),
    threadId: threadRoot(headers),
    from: decodeAddress(splitAddressList(header('from'))[0] ?? ''),
    to: addressesIn(header('to')),
    date: sent,
    subject: decodeEncodedWords(header('subject')) || '(no subject)',
    // IMAP has no preview short of fetching the body, which for encrypted mail
    // is ciphertext anyway. Graph's is empty for many messages too.
    snippet: '',
    unread: !flags.includes('\\seen'),
    starred: flags.includes('\\flagged'),
    messageId: header('message-id') || undefined,
    references: header('references') || undefined,
    autocrypt: header('autocrypt') || undefined,
    replyTo: header('reply-to') || undefined,
    authenticationResults: header('authentication-results') || undefined,
    listUnsubscribe: header('list-unsubscribe') || undefined,
    returnPath: header('return-path') || undefined,
    labels: [LABEL[box]],
  };
}

function dateHeader(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

/**
 * What the layers above understand.
 *
 * A refused password is `reauth-required` — the same answer a revoked OAuth
 * grant gets — because the app's response is the same: this mailbox needs the
 * user to sign in again. Everything else is a `MailError`, including a dropped
 * connection: being offline must never read as "your password is wrong".
 */
export function translate(e: unknown, host: string): Error {
  if (e instanceof AuthError || e instanceof MailError) return e;
  if (e instanceof ImapError && e.kind === 'auth') {
    return new AuthError(`${host} refused the password. Sign in again to continue.`, 'reauth-required');
  }
  if (e instanceof SmtpError && e.kind === 'auth') {
    return new AuthError(`${host} refused the password for sending. Sign in again to continue.`, 'reauth-required');
  }
  if (e instanceof ImapError || e instanceof SmtpError || e instanceof TransportError) {
    return new MailError(e.message);
  }
  return e instanceof Error ? e : new Error(String(e));
}
