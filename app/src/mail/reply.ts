/**
 * Reply / Reply-All / Forward — the pure derivation of a new draft from the
 * message being acted on.
 *
 * No React, no storage, no network: it only reshapes fields the caller already
 * holds in memory (the decrypted subject/body and the summary's headers), so it
 * is the one piece of the reply path worth testing on its own. Screens call
 * `buildReplyDraft` and hand the result to Compose as navigation params.
 *
 * Threading (`In-Reply-To`/`References`) rides in the clear — it is provider
 * metadata, see docs/message-format.md — and is emitted on replies but not on a
 * forward, which starts a new conversation the way Gmail does.
 */
import { displayName } from '../lib/format';

export type ReplyKind = 'reply' | 'replyAll' | 'forward';

/** Everything the builder needs from the message being acted on. */
export type ReplySource = {
  from: { address: string; name?: string };
  /** Original recipients (addresses), for Reply-All. */
  to: string[];
  date: string;
  /** The real (decrypted) subject, not the `[Encrypted message]` placeholder. */
  subject: string;
  /** The real (decrypted) body — read from memory, never re-fetched. */
  body: string;
  /** The original message's `Message-ID`, if the provider gave us one. */
  messageId?: string;
  /** The original message's raw `References` header, if any. */
  references?: string;
};

/** The prefilled compose fields a reply/forward produces. */
export type ReplyDraft = {
  to: string[];
  subject: string;
  quotedBody: string;
  inReplyTo?: string;
  references?: string[];
};

const canonical = (email: string) => email.trim().toLowerCase();

/** Drop empties and case-insensitive duplicates, preserving order. */
function dedupe(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const email = canonical(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

// A run of leading `Re:` / `Fwd:` (or `Fw:`) prefixes, so we collapse rather
// than stack them: `Re: Re: x` → `Re: x`.
const RE_PREFIX = /^\s*(re:\s*)+/i;
const FWD_PREFIX = /^\s*(fwd?:\s*)+/i;

export function replySubject(subject: string): string {
  const base = subject.replace(RE_PREFIX, '').trim();
  return base ? `Re: ${base}` : 'Re:';
}

export function forwardSubject(subject: string): string {
  const base = subject.replace(FWD_PREFIX, '').trim();
  return base ? `Fwd: ${base}` : 'Fwd:';
}

/**
 * Who a plain Reply goes to: the original sender.
 *
 * Replying to your *own* sent message is the exception — the sender is you, so
 * the reply goes to whoever you sent it to instead.
 */
export function replyRecipients(src: ReplySource, self: string): string[] {
  const me = canonical(self);
  const sender = canonical(src.from.address);
  if (sender && sender !== me) return [sender];
  return dedupe(src.to).filter((email) => email !== me);
}

/**
 * Who a Reply-All goes to: the sender plus every original recipient, minus
 * yourself. Cc is folded into this single list — everyone here is encrypted-to,
 * so the send-path fail-safe (rule 1) covers them all uniformly.
 */
export function replyAllRecipients(src: ReplySource, self: string): string[] {
  const me = canonical(self);
  return dedupe([src.from.address, ...src.to]).filter((email) => email !== me);
}

/**
 * The `References` chain for a reply: the original's chain with its own
 * Message-ID appended. Message-IDs are case-sensitive, so they are deduped
 * exactly rather than canonicalised.
 */
export function buildReferences(src: ReplySource): string[] {
  const prior = (src.references ?? '').split(/\s+/).filter(Boolean);
  const all = src.messageId ? [...prior, src.messageId] : prior;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of all) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** GMT, so the quote reads the same regardless of the device's timezone. */
function quoteDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toUTCString();
}

function quoteLines(body: string): string {
  return body
    .split('\n')
    .map((line) => (line.length ? `> ${line}` : '>'))
    .join('\n');
}

/** Gmail-style attribution line above the `>`-quoted original. */
export function quotedReplyBody(src: ReplySource): string {
  const who = displayName(src.from.address, src.from.name);
  const attribution = `On ${quoteDate(src.date)}, ${who} <${src.from.address}> wrote:`;
  return `\n\n${attribution}\n${quoteLines(src.body)}`;
}

/** The Gmail forward header block, followed by the original body verbatim. */
export function forwardedBody(src: ReplySource): string {
  const who = displayName(src.from.address, src.from.name);
  const header = [
    '---------- Forwarded message ---------',
    `From: ${who} <${src.from.address}>`,
    `Date: ${quoteDate(src.date)}`,
    `Subject: ${src.subject}`,
    `To: ${src.to.join(', ')}`,
  ].join('\n');
  return `\n\n${header}\n\n${src.body}`;
}

/**
 * The single entry point the screen calls. Reply/Reply-All thread onto the
 * original conversation; Forward deliberately does not (`to` empty, no
 * threading), matching Gmail.
 */
export function buildReplyDraft(kind: ReplyKind, src: ReplySource, self: string): ReplyDraft {
  if (kind === 'forward') {
    return { to: [], subject: forwardSubject(src.subject), quotedBody: forwardedBody(src) };
  }
  const to = kind === 'replyAll' ? replyAllRecipients(src, self) : replyRecipients(src, self);
  const references = buildReferences(src);
  return {
    to,
    subject: replySubject(src.subject),
    quotedBody: quotedReplyBody(src),
    inReplyTo: src.messageId,
    references: references.length ? references : undefined,
  };
}
