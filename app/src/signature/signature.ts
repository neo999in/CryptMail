/**
 * The signature and canned replies, as text operations on a message body.
 *
 * Pure: no storage, no React. Compose owns the body; this module decides where
 * a signature goes, how it is swapped when the From account changes, and where
 * a canned reply lands — and, just as important, when a body holding nothing
 * but the signature is still an empty message.
 *
 * All of it is plain text inside the body, so it is encrypted with the rest of
 * the message. Nothing here reaches a header.
 *
 * The block is the conventional `-- ` separator line (dash, dash, space;
 * RFC 3676 §4.3), which is what lets other clients fold or strip it.
 */

/** The separator line, trailing space included — it is what marks the block. */
export const SIGNATURE_SEPARATOR = '-- ';

/** The block a signature adds to a body: a blank line, the separator, the text. `''` for none. */
export function signatureBlock(signature: string | undefined): string {
  const text = (signature ?? '').replace(/\s+$/, '');
  if (text.trim() === '') return '';
  return `\n\n${SIGNATURE_SEPARATOR}\n${text}`;
}

/**
 * The body a new message opens with.
 *
 * The signature sits *above* anything quoted, the way a reply is read: what you
 * wrote, who you are, then what you are answering. Only ever called for a
 * message being started — a resumed draft already holds whatever it holds, and
 * seeding it again is how drafts accumulate copies of the signature.
 */
export function seedBody(signature: string | undefined, quoted = ''): string {
  return signatureBlock(signature) + quoted;
}

/**
 * Whether a body holds nothing the user wrote — empty, or exactly the seeded
 * signature. Autosave uses it so that opening Compose and leaving does not
 * leave a draft behind that is only a sign-off.
 */
export function isOnlySignature(body: string, signature: string | undefined): boolean {
  if (body.trim() === '') return true;
  const block = signatureBlock(signature);
  return block !== '' && body.trim() === block.trim();
}

/**
 * Replace one mailbox's signature with another's, for a From switch.
 *
 * Only an intact block is replaced. A signature the user has edited in this
 * message is theirs now, and is left exactly as written rather than guessed at.
 * A body with no signature in it gains one only if it is otherwise empty —
 * there is no telling where a signature belongs in text someone has written.
 */
export function swapSignature(body: string, from: string | undefined, to: string | undefined): string {
  const oldBlock = signatureBlock(from);
  const newBlock = signatureBlock(to);
  if (oldBlock === newBlock) return body;
  if (oldBlock === '') return body.trim() === '' ? newBlock : body;
  const at = findBlock(body, oldBlock);
  if (at < 0) return body;
  return body.slice(0, at) + newBlock + body.slice(at + oldBlock.length);
}

/**
 * Where an intact block starts, or -1. Intact means it ends the body or its
 * line: "Work" is not the block inside "Work, but on holiday".
 */
function findBlock(body: string, block: string): number {
  if (block === '') return -1;
  for (let at = body.indexOf(block); at >= 0; at = body.indexOf(block, at + 1)) {
    const next = body.charAt(at + block.length);
    if (next === '' || next === '\n') return at;
  }
  return -1;
}

/**
 * Where a canned reply goes when the caret has not said: before the signature
 * or the quoted text, whichever comes first, else at the end.
 */
export function defaultInsertionPoint(body: string, signature: string | undefined, quoted?: string): number {
  const candidates = [findBlock(body, signatureBlock(signature)), quoted ? body.indexOf(quoted) : -1];
  return Math.min(body.length, ...candidates.filter((at) => at >= 0));
}

/**
 * Put a canned reply into the body at `at`, on its own line.
 *
 * Returns the new body and where the caret should sit after it, so a second
 * insert follows the first instead of landing in front of it.
 */
export function insertSnippet(body: string, snippet: string, at: number): { body: string; caret: number } {
  const point = Math.max(0, Math.min(at, body.length));
  const before = body.slice(0, point);
  const after = body.slice(point);
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const trail = after === '' || after.startsWith('\n') ? '' : '\n';
  const text = `${lead}${snippet}${trail}`;
  return { body: before + text + after, caret: point + lead.length + snippet.length };
}
