/**
 * IMAP4rev1 on the wire (RFC 3501): framing responses out of a byte stream,
 * tokenizing them, and writing command arguments safely. Pure — no socket.
 *
 * The one thing that shapes this file is the **literal**: `{123}\r\n` followed
 * by exactly 123 *octets*, which may themselves contain CRLF. A message body
 * arrives that way, so framing counts bytes, never characters — a response
 * decoded to a JS string before its literals were cut out would be cut in the
 * wrong place by the first non-ASCII byte.
 */
import { bytesToUtf8, utf8ToBytes } from '../lib/base64';
import { ByteQueue, bytesToLatin1 } from './socket';

/** An atom or quoted string, a literal's bytes, NIL, or a parenthesised list. */
export type ImapValue = string | Uint8Array | null | ImapValue[];

export type ImapResponse = {
  /** `*` untagged, `+` continuation, or the tag of the command being answered. */
  tag: string;
  /** The response's keyword, upper-cased: OK, NO, BAD, BYE, PREAUTH, FETCH, EXISTS, LIST, SEARCH… */
  kind: string;
  /** The number before the keyword, for `* 12 EXISTS` and `* 3 FETCH (…)`. */
  num?: number;
  /** A status response's bracketed code, without the brackets: `UIDVALIDITY 3857529045`. */
  code?: string;
  /** A status response's human-readable text. */
  text: string;
  /** A data response's arguments, parsed. */
  values: ImapValue[];
};

const STATUS = new Set(['OK', 'NO', 'BAD', 'BYE', 'PREAUTH']);

/**
 * Cuts complete responses out of the incoming bytes.
 *
 * A response is a line, plus — for each line that ends in `{n}` — n bytes of
 * literal and a further line. Nothing is consumed until the whole response is
 * present, so a literal split across a hundred socket chunks is simply waited for.
 */
export class ResponseReader {
  private queue = new ByteQueue();
  private parts: (string | Uint8Array)[] = [];

  /** Feed bytes; get back every response they completed. */
  push(chunk: Uint8Array): ImapResponse[] {
    this.queue.push(chunk);
    const done: ImapResponse[] = [];
    for (;;) {
      const eol = this.queue.indexOfCrlf();
      if (eol === -1) break;
      const line = bytesToLatin1(this.queue.peek(0, eol));
      const literal = line.match(/\{(\d+)\+?\}$/);
      if (literal) {
        const size = Number(literal[1]);
        if (this.queue.length < eol + 2 + size) break;
        this.queue.take(eol + 2);
        this.parts.push(line, this.queue.take(size));
        continue;
      }
      this.queue.take(eol + 2);
      this.parts.push(line);
      done.push(parseResponse(this.parts));
      this.parts = [];
    }
    return done;
  }

  /** Bytes received but not yet part of a whole response. */
  get buffered(): number {
    return this.queue.length;
  }
}

/** Parse one framed response: its lines, with each literal's bytes between them. */
export function parseResponse(parts: (string | Uint8Array)[]): ImapResponse {
  const first = parts[0] as string;
  const space = first.indexOf(' ');
  const tag = space === -1 ? first : first.slice(0, space);
  let rest = space === -1 ? '' : first.slice(space + 1);

  if (tag === '+') {
    const { code, text } = splitCode(rest);
    return { tag, kind: 'CONTINUE', code, text, values: [] };
  }

  let num: number | undefined;
  let word = takeWord(rest);
  if (/^\d+$/.test(word.word)) {
    num = Number(word.word);
    word = takeWord(word.rest);
  }
  const kind = word.word.toUpperCase();
  rest = word.rest;

  if (STATUS.has(kind)) {
    const { code, text } = splitCode(rest);
    return { tag, kind, num, code, text, values: [] };
  }
  return { tag, kind, num, text: '', values: tokenize([rest, ...parts.slice(1)]) };
}

function takeWord(s: string): { word: string; rest: string } {
  const i = s.indexOf(' ');
  return i === -1 ? { word: s, rest: '' } : { word: s.slice(0, i), rest: s.slice(i + 1) };
}

function splitCode(rest: string): { code?: string; text: string } {
  const m = rest.match(/^\[([^\]]*)\]\s?/);
  return m ? { code: m[1], text: rest.slice(m[0].length) } : { text: rest };
}

/**
 * Tokenize a data response's arguments.
 *
 * An atom may carry a bracketed section with spaces inside it —
 * `BODY[HEADER.FIELDS (FROM TO)]` is one key in a FETCH response — so a `[`
 * inside an atom runs to its matching `]`.
 */
export function tokenize(parts: (string | Uint8Array)[]): ImapValue[] {
  const root: ImapValue[] = [];
  const stack: ImapValue[][] = [root];
  const top = () => stack[stack.length - 1];

  for (const part of parts) {
    if (typeof part !== 'string') {
      top().push(part);
      continue;
    }
    let i = 0;
    while (i < part.length) {
      const c = part[i];
      if (c === ' ') {
        i++;
      } else if (c === '(') {
        const list: ImapValue[] = [];
        top().push(list);
        stack.push(list);
        i++;
      } else if (c === ')') {
        if (stack.length > 1) stack.pop();
        i++;
      } else if (c === '"') {
        let j = i + 1;
        let raw = '';
        while (j < part.length && part[j] !== '"') {
          if (part[j] === '\\' && j + 1 < part.length) j++;
          raw += part[j++];
        }
        top().push(latin1ToUtf8(raw));
        i = j + 1;
      } else if (c === '{' && /^\{\d+\+?\}$/.test(part.slice(i))) {
        // The literal's own marker; its bytes are the next part.
        break;
      } else {
        let j = i;
        let depth = 0;
        while (j < part.length) {
          const d = part[j];
          if (d === '[') depth++;
          else if (d === ']') depth = Math.max(0, depth - 1);
          else if (depth === 0 && (d === ' ' || d === '(' || d === ')')) break;
          j++;
        }
        const atom = part.slice(i, j);
        top().push(atom.toUpperCase() === 'NIL' ? null : atom);
        i = j;
      }
    }
  }
  return root;
}

/** Protocol text is octets; anything non-ASCII in it is UTF-8 (RFC 6855). */
function latin1ToUtf8(raw: string): string {
  if (!/[\x80-\xff]/.test(raw)) return raw;
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytesToUtf8(bytes);
}

/** A value as text — a literal decoded as UTF-8, NIL as empty. */
export function asText(value: ImapValue | undefined): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return bytesToUtf8(value);
  return '';
}

/** The `KEY value KEY value…` list of a FETCH response, keyed upper-case. */
export function fetchAttributes(values: ImapValue[]): Record<string, ImapValue> {
  const list = Array.isArray(values[0]) ? (values[0] as ImapValue[]) : [];
  const out: Record<string, ImapValue> = {};
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = list[i];
    if (typeof key === 'string') out[key.toUpperCase()] = list[i + 1];
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One piece of a command. A string is written as-is; a literal is sent as
 * `{n}` and its bytes, which is how anything that cannot be quoted — a password
 * with a non-ASCII character, a message for APPEND — goes over.
 */
export type CommandPart = string | { literal: Uint8Array };

/**
 * A string argument: quoted when it can be, a literal when it cannot.
 *
 * Quoting covers printable ASCII only. CR or LF inside a quoted string would
 * end the command early, and that is how an injected command gets in — so any
 * such value, and anything non-ASCII, goes as a literal whose length the server
 * reads rather than trusting its content.
 */
export function astring(value: string): CommandPart {
  if (/^[\x20-\x7e]*$/.test(value)) return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return { literal: utf8ToBytes(value) };
}

/** A sorted, compressed UID set: `[5, 4, 3, 1]` → `1,3:5`. */
export function uidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return runs.join(',');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A SEARCH date: `18-Sep-2026`. UTC, since the protocol carries no zone for it. */
export function imapDate(date: Date): string {
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

/** An INTERNALDATE (`17-Jul-1996 02:44:25 -0700`) as ISO, or null when malformed. */
export function parseInternalDate(value: string): string | null {
  const m = value.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!m) return null;
  const month = MONTHS.findIndex((name) => name.toLowerCase() === m[2].toLowerCase());
  if (month === -1) return null;
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000;
  return new Date(utc).toISOString();
}
