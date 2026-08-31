/**
 * Attachments — the model, the limits, and the helpers screens read.
 *
 * An attachment is carried as base64 text because that is what crosses both
 * boundaries it has to cross: the MIME tree (`Content-Transfer-Encoding:
 * base64`) and the core bridge, which passes nothing but strings (rule 3).
 *
 * ## Where the 5 MB comes from — it is measured, not chosen
 *
 * Two independent limits bind, and the smaller one wins.
 *
 * **The arithmetic.** Sizes compound on the way out: base64 in the MIME part
 * (+33%), then PGP armor over the ciphertext (+33%). A provider's 25 MB is on
 * the *encoded message*, not on the file, so the largest file that can ever
 * arrive is about `25 / 1.78 ≈ 14 MB`. No optimisation moves that number, and a
 * cap set at the provider's own 25 MB is a promise the provider will break.
 *
 * **The measurement.** Everything here is held in memory and copied as a
 * JavaScript string several times between disk and the wire, all on the JS
 * thread. Timings for one send + open through the demo core, on desktop V8:
 *
 * ```
 *   1 MB → 0.3 s build ·  1.0 s open
 *   2 MB → 1.1 s build ·  2.6 s open
 *   5 MB → 3.6 s build ·  4.1 s open
 *  10 MB → 3.5 s build ·  7.6 s open
 *  25 MB →  21 s build ·   45 s open, peak memory in gigabytes
 * ```
 *
 * Hermes on a mid-range phone is roughly 2–5× slower than that, with an app
 * heap in the low hundreds of megabytes rather than gigabytes — so the 25 MB
 * row is not "slow", it is the process being killed. 5 MB covers photos, decks
 * and PDFs (very nearly every real attachment) while keeping the freeze in
 * single-digit seconds and the memory somewhere Android will tolerate.
 *
 * Raising it is not a matter of editing this constant. It needs the chunked
 * base64 helpers (`lib/base64.ts` builds a multi-million-element `number[]`),
 * Gmail's resumable upload endpoint, and ultimately the streaming path — a file
 * path across the bridge, read and encrypted in chunks by Rust (Phase 1). After
 * that, ~10 MB is honest and 14 MB is the ceiling.
 *
 * `MAX_STORED_ATTACHMENT_BYTES` is a different limit for a different reason: it
 * is about *drafts*, not sending. Autosaved drafts are sealed JSON in
 * AsyncStorage, SQLite-backed on Android with a ceiling in the low single-digit
 * megabytes, so a large file cannot be written there — and a failing autosave is
 * how a draft gets lost. Files past that budget stay in memory for the compose
 * session and the screen names them, which is the one behaviour here the user
 * has to be told about.
 *
 * Nothing here is provider-specific and nothing here is React: an attachment is
 * part of the *message*, and it lives next to `MailSummary` for the same reason.
 */

/** Refused past this, per file. Measured, not chosen — see above. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * And past this in total, so several files under the cap can't add up past it.
 *
 * The same 5 MB: what compounds into an oversized message is the whole tree,
 * not any one file in it.
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * How much attachment content an autosaved draft may carry.
 *
 * Not a policy about attachments — a fact about AsyncStorage (see above).
 * `splitForStorage` applies it; nothing else should compare against it.
 */
export const MAX_STORED_ATTACHMENT_BYTES = 1024 * 1024;

/**
 * One attached file, decoded content held as base64.
 *
 * `inline` marks a part meant to be shown inside the message body rather than
 * listed under it — an image pasted into the text. It carries a `contentId` so
 * the body can refer to it (`cid:`), which is the only reason the field exists.
 */
export type Attachment = {
  id: string;
  /** The filename as the sender saw it. Inside the ciphertext, never on the envelope. */
  name: string;
  mimeType: string;
  /** Decoded size in bytes — what the user is shown, not the base64 length. */
  size: number;
  /** Base64 of the file's bytes, unwrapped (no line breaks). */
  data: string;
  inline?: boolean;
  contentId?: string;
};

/** Bytes a base64 payload decodes to, without decoding it. */
export function decodedSize(base64: string): number {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(clean.length / 4) * 3 - padding);
}

export const totalBytes = (attachments: Attachment[]): number =>
  attachments.reduce((sum, a) => sum + a.size, 0);

/** Images are previewed in place; everything else is a row with an icon. */
export const isImage = (a: { mimeType: string }): boolean => /^image\//i.test(a.mimeType);

/** A `data:` URI for `<Image source>` — the only way to render bytes we hold. */
export const dataUri = (a: Attachment): string => `data:${a.mimeType};base64,${a.data}`;

/** "412 KB". Sizes are shown to people, so no byte counts past a kilobyte. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Why this file cannot be attached, in words, or null if it can.
 *
 * One function so compose, the draft resume path and any future share-sheet
 * entry point all refuse the same things for the same stated reason.
 */
export function attachmentRefusal(
  candidate: { name: string; size: number },
  existing: Attachment[],
): string | null {
  if (candidate.size > MAX_ATTACHMENT_BYTES) {
    return `${candidate.name} is ${formatBytes(candidate.size)}. CryptMail can carry ${formatBytes(
      MAX_ATTACHMENT_BYTES,
    )} of attachments a message: encryption roughly doubles a file on the wire, and everything is sealed on this device before it is sent.`;
  }
  if (totalBytes(existing) + candidate.size > MAX_TOTAL_ATTACHMENT_BYTES) {
    return `Adding ${candidate.name} would take this message past ${formatBytes(
      MAX_TOTAL_ATTACHMENT_BYTES,
    )} of attachments — more than CryptMail can seal and send in one message.`;
  }
  return null;
}

/**
 * Split attachments into the ones a draft can persist and the names of the rest.
 *
 * Files are kept in order until the storage budget is spent; whatever does not
 * fit is *named*, not dropped quietly. The compose screen still holds the real
 * files for as long as it is open, so this only changes what survives closing
 * the screen — and the user is told which ones those are, because a draft that
 * silently comes back without its 4 MB deck is worse than one that never
 * saved: nothing on screen would say the file is gone.
 */
export function splitForStorage(list: Attachment[]): { stored: Attachment[]; omitted: string[] } {
  const stored: Attachment[] = [];
  const omitted: string[] = [];
  let budget = MAX_STORED_ATTACHMENT_BYTES;

  for (const a of list) {
    if (a.size <= budget) {
      stored.push(a);
      budget -= a.size;
    } else {
      omitted.push(a.name);
    }
  }
  return { stored, omitted };
}

/** Add or replace by id (pure), the way the drafts reducers work. */
export function addAttachment(list: Attachment[], next: Attachment): Attachment[] {
  return [...list.filter((a) => a.id !== next.id), next];
}

export function removeAttachment(list: Attachment[], id: string): Attachment[] {
  return list.filter((a) => a.id !== id);
}

/** Ids are local and short-lived; they only have to be unique within a message. */
export function newAttachmentId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A `Content-ID` for an inline part, in the angle-bracket form MIME wants. */
export const contentIdFor = (id: string): string => `${id}@cryptmail`;
