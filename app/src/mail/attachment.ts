/**
 * Attachments — the model, the limits, and the helpers screens read.
 *
 * An attachment is carried as base64 text because that is what crosses both
 * boundaries it has to cross: the MIME tree (`Content-Transfer-Encoding:
 * base64`) and the core bridge, which passes nothing but strings (rule 3).
 *
 * That is also why there is a size cap. Everything here is held in memory and
 * copied as a JavaScript string at least twice on the way to Rust, so the
 * prototype refuses anything past `MAX_ATTACHMENT_BYTES` rather than dying in a
 * way the user cannot read (docs/prototype-plan.md: "text bodies only, cap at
 * ~1MB"). The real fix is a file path and a streaming read on the Rust side —
 * Phase 1 — and the cap is the honest stand-in until then, stated to the user
 * up front instead of discovered at send time.
 *
 * Nothing here is provider-specific and nothing here is React: an attachment is
 * part of the *message*, and it lives next to `MailSummary` for the same reason.
 */

/** Refused past this, per file. See the note above — it is a bridge limit. */
export const MAX_ATTACHMENT_BYTES = 1024 * 1024;

/** And past this in total, so ten files under the cap can't add up past it. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 4 * 1024 * 1024;

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
    return `${candidate.name} is ${formatBytes(candidate.size)}. CryptMail can attach files up to ${formatBytes(
      MAX_ATTACHMENT_BYTES,
    )} for now — larger files need the streaming path that is not built yet.`;
  }
  if (totalBytes(existing) + candidate.size > MAX_TOTAL_ATTACHMENT_BYTES) {
    return `Adding ${candidate.name} would take this message past ${formatBytes(
      MAX_TOTAL_ATTACHMENT_BYTES,
    )} of attachments.`;
  }
  return null;
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
