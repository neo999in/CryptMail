/**
 * A mailbox as an `mbox` file — the format every other mail client can read.
 *
 * This is the product's honest answer to "there is no server-side archive":
 * your mail is yours and you can take it out. So the export is deliberately
 * **the bytes the provider stores**, not a re-rendering of what the app shows.
 * A faithful copy is the only kind worth calling a backup: it opens in
 * Thunderbird, it survives this app being uninstalled, and nothing about it
 * depends on CryptMail still existing to interpret it.
 *
 * Which means an encrypted message exports as the sealed message it is. That is
 * the correct outcome, not a shortcoming — the ciphertext *is* the mail, and a
 * PGP-capable client holding the same key reads it exactly as this one does.
 * Writing out the decrypted inner tree instead would mean the export quietly
 * strips the encryption off every message the user chose to encrypt, which is
 * the last thing this app should build a button for. The UI says which it is.
 *
 * The variant is **mboxrd**, the one that round-trips: a line already beginning
 * `>*From ` gains one more `>`, so unquoting on import is unambiguous. Plain
 * mboxo escapes `From ` and cannot tell an escaped line from a real one.
 */

/** One message, as it will be written: its envelope line, then its own bytes. */
export type MboxEntry = {
  /** The envelope sender for the `From ` line. Falls back below when absent. */
  from?: string;
  /** The message's date. Anything `Date` can parse; invalid falls back to now. */
  date?: string;
  /** Full RFC 5322 source, exactly as the provider served it. */
  raw: string;
};

/**
 * `MAILER-DAEMON` is what an mbox writes when the envelope sender is unknown,
 * and it is unknown here more often than it looks: the `From:` header is the
 * *author*, and a message may carry none the app could parse.
 */
const UNKNOWN_SENDER = 'MAILER-DAEMON';

export function toMbox(entries: MboxEntry[]): string {
  return entries.map(entryToMbox).join('');
}

/**
 * One message as it goes into the file.
 *
 * Exported so a large export can write each message as it is fetched rather
 * than holding them all for `toMbox`: the concatenation of these is exactly
 * `toMbox`'s output, message boundaries included.
 */
export function entryToMbox(entry: MboxEntry): string {
  const body = quoteFromLines(normaliseNewlines(entry.raw));
  // Each message ends with a blank line, which is the separator the next
  // `From ` line is found after. Written unconditionally rather than only when
  // the body lacks one, because a message that ends mid-line and one that ends
  // in a newline must both produce the same shape.
  const trailing = body.endsWith('\n') ? '' : '\n';
  return `From ${entry.from?.trim() || UNKNOWN_SENDER} ${asctime(entry.date)}\n${body}${trailing}\n`;
}

/**
 * CRLF in, LF out.
 *
 * The wire format is CRLF and the file format is LF. Readers vary in how much
 * they forgive, and a file with both is the one that trips them; a lone CR is
 * normalised too, since it can only have come from a mangled source.
 */
function normaliseNewlines(raw: string): string {
  return raw.replace(/\r\n?/g, '\n');
}

/** mboxrd quoting: `From ` and any already-quoted `>…>From ` gain one `>`. */
function quoteFromLines(body: string): string {
  return body.replace(/^(>*From )/gm, '>$1');
}

/**
 * The `From ` line's timestamp: asctime in C locale, never the user's.
 *
 * `toDateString`/`toTimeString` would follow the device's locale and produce a
 * line other clients cannot parse, so the parts are assembled by hand from UTC.
 */
function asctime(date?: string): string {
  const when = date ? new Date(date) : new Date();
  const at = Number.isNaN(when.getTime()) ? new Date() : when;
  const day = DAYS[at.getUTCDay()];
  const month = MONTHS[at.getUTCMonth()];
  const dayOfMonth = String(at.getUTCDate()).padStart(2, ' ');
  const time = [at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  return `${day} ${month} ${dayOfMonth} ${time} ${at.getUTCFullYear()}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `you-at-gmail-com-2026-09-06.mbox` — safe on every filesystem the app touches. */
export function mboxFilename(address: string, on: Date = new Date()): string {
  return `${slug(address)}-${on.toISOString().slice(0, 10)}.mbox`;
}

/**
 * `2026-08-30-quarterly-numbers.eml` — one message, named so a folder of them
 * sorts by date.
 *
 * `subject` must be the **header** subject, never a decrypted one. A filename
 * is written in the clear wherever the file lands, and for encrypted mail the
 * real subject is ciphertext for exactly that reason; the header carries the
 * `[Encrypted message]` placeholder, which is what the name then says.
 *
 * `id` breaks ties, since two messages on one day can share a subject.
 */
export function emlFilename(message: { id: string; date?: string; subject?: string }): string {
  const when = message.date ? new Date(message.date) : new Date(NaN);
  const day = Number.isNaN(when.getTime()) ? 'undated' : when.toISOString().slice(0, 10);
  const subject = slug(message.subject ?? '').slice(0, 60).replace(/-$/, '') || 'message';
  return `${day}-${subject}-${slug(message.id).slice(-8) || 'mail'}.eml`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
