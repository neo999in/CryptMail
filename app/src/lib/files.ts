/**
 * Getting a file's bytes in, and back out again.
 *
 * The one place that talks to the platform's file APIs, because they are the
 * part of attachments that differs everywhere: on the web a picked file arrives
 * as a `data:` URL and is saved with an anchor element; on Android it arrives as
 * a `content://` URI, is read through `expo-file-system`, and is handed back to
 * the user through the share sheet.
 *
 * Everything above this module works in base64 strings only — see
 * `mail/attachment.ts` for why that is, and why it is capped.
 *
 * ## The size limit is here, not a suggestion
 *
 * `readPickedFile` refuses a file over the cap before reading it. Reading first
 * and refusing after would mean holding the very string the cap exists to avoid
 * — on a 200 MB video, long enough to take the app down with it.
 */
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import {
  Attachment,
  attachmentRefusal,
  decodedSize,
  newAttachmentId,
} from '../mail/attachment';
import { decodeUtf8Base64 } from './base64';
import { whileAway } from './lockExemption';

/** A file the user chose, with its bytes still on disk. */
export type PickedFile = { name: string; mimeType: string; size: number; uri: string };

/** Either the attachment, or the sentence explaining why not. Never throws for a refusal. */
export type PickResult = { attachment: Attachment } | { refused: string };

/**
 * Open the system picker. Returns nothing at all when the user cancels —
 * cancelling is not an error and must not put a banner on the screen.
 */
export async function pickFiles(): Promise<PickedFile[]> {
  // `whileAway`: the picker is another activity, and coming back from it is
  // not a reason for the app lock to ask for the PIN.
  const result = await whileAway(() =>
    DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
      // Web returns the bytes inline as a `data:` URL; there is no path to read.
      base64: true,
    }),
  );
  if (result.canceled) return [];

  return result.assets.map((asset) => ({
    name: asset.name,
    mimeType: asset.mimeType ?? 'application/octet-stream',
    size: asset.size ?? 0,
    uri: asset.uri,
  }));
}

/**
 * Read a picked file into an attachment, or say why it cannot be attached.
 *
 * `existing` is the message's current attachments, so the total cap is checked
 * against what is already there rather than against this file alone.
 */
export async function readPickedFile(
  picked: PickedFile,
  existing: Attachment[],
): Promise<PickResult> {
  const refusal = attachmentRefusal(picked, existing);
  if (refusal) return { refused: refusal };

  const data = await readBase64(picked);
  // Web assets report a size; some Android providers do not, so the authority
  // on how big this is ends up being the bytes we actually read. Check the cap
  // again against that — a provider that under-reported must not get a free pass.
  const size = decodedSize(data);
  const second = attachmentRefusal({ name: picked.name, size }, existing);
  if (second) return { refused: second };

  return {
    attachment: {
      id: newAttachmentId(),
      name: picked.name,
      mimeType: picked.mimeType,
      size,
      data,
    },
  };
}

/** The file's bytes, base64, however this platform hands them over. */
async function readBase64(picked: PickedFile): Promise<string> {
  const inline = /^data:[^;,]*;base64,(.*)$/s.exec(picked.uri);
  if (inline) return inline[1];
  return new File(picked.uri).base64();
}

/**
 * Hand a received attachment back to the user as a file.
 *
 * Web downloads it; Android writes it to the cache directory and opens the share
 * sheet, which is the only way an app can put a file somewhere the user chooses.
 * The cache copy is deliberate and temporary: a decrypted attachment on disk is
 * exactly the plaintext-at-rest the prototype already carries as known debt
 * (docs/prototype-plan.md), and the cache is at least evictable.
 */
export async function saveAttachment(attachment: Attachment): Promise<void> {
  if (Platform.OS === 'web') {
    saveOnWeb(attachment);
    return;
  }

  const file = new File(Paths.cache, attachment.name);
  if (file.exists) file.delete();
  file.create();
  file.write(attachment.data, { encoding: 'base64' });

  if (await Sharing.isAvailableAsync()) {
    await whileAway(() => Sharing.shareAsync(file.uri, { mimeType: attachment.mimeType, UTI: attachment.mimeType }));
  }
}

/**
 * Hand the user a text file the app generated — today, a mailbox export.
 *
 * The same two platform paths as `saveAttachment`, and the same trade-off: on
 * Android the file is written to the cache and offered through the share sheet,
 * because that is the only way an app can put a file somewhere the user
 * chooses. The cache copy is temporary and evictable, which matters more here
 * than for an attachment — an mbox is *every* message it holds, in the clear
 * for anything that was not encrypted.
 */
export async function saveTextFile(name: string, text: string, mimeType: string): Promise<void> {
  if (Platform.OS === 'web') {
    const anchor = document.createElement('a');
    // A blob, not a `data:` URL: an export is megabytes, and a data URL that
    // size is refused outright by some browsers and truncated by others.
    const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return;
  }

  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(text);

  if (await Sharing.isAvailableAsync()) {
    await whileAway(() => Sharing.shareAsync(file.uri, { mimeType, UTI: mimeType }));
  }
}

/** A text file written in pieces, then handed to the user once. */
export type TextFileWriter = {
  append(text: string): void;
  /** Close the file and offer it to the user — the share sheet, or a download. */
  finish(): Promise<void>;
};

/**
 * `saveTextFile` for a file too large to hold as one string.
 *
 * A whole mailbox is the case: thousands of messages joined into a single
 * JavaScript string is a copy of the mailbox in memory, and on a phone that is
 * how an export takes the app down with it. On Android each piece is appended
 * to the cache file as it arrives. The web has no file to append to, so the
 * pieces are kept as separate `Blob` parts, which the browser can hold without
 * concatenating them into one string.
 */
export function openTextFileWriter(name: string, mimeType: string): TextFileWriter {
  if (Platform.OS === 'web') {
    const parts: string[] = [];
    return {
      append: (text) => {
        parts.push(text);
      },
      finish: async () => {
        const anchor = document.createElement('a');
        const url = URL.createObjectURL(new Blob(parts, { type: mimeType }));
        anchor.href = url;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      },
    };
  }

  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  return {
    append: (text) => file.write(text, { append: true }),
    finish: async () => {
      if (await Sharing.isAvailableAsync()) {
        await whileAway(() => Sharing.shareAsync(file.uri, { mimeType, UTI: mimeType }));
      }
    },
  };
}

/** An anchor with `download` — the browser's only "save this bytes as a file". */
function saveOnWeb(attachment: Attachment): void {
  const anchor = document.createElement('a');
  anchor.href = `data:${attachment.mimeType};base64,${attachment.data}`;
  anchor.download = attachment.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** A backup file the user picked, or the sentence explaining why it was refused. */
export type TextReadResult = { text: string } | { refused: string };

/**
 * The largest picked file this module will read as text.
 *
 * A recovery backup is an armored key — a few kilobytes. The cap is here for
 * the same reason `attachmentRefusal` is: a user who picks a video by mistake
 * must get a sentence, not a string long enough to take the app down. It is
 * checked before the read, so the oversized string is never held at all.
 */
const TEXT_FILE_CAP = 256 * 1024;

/**
 * The cap for a restore field that also takes a device transfer. A transfer
 * carries every message read with per-email keys, attachments included, so it
 * can be far larger than a backup — but it is still one string across the
 * bridge, and this is where "a video picked by mistake" is still refused.
 */
export const TRANSFER_FILE_CAP = 64 * 1024 * 1024;

/**
 * Read a picked file as text — today, a recovery backup.
 *
 * Separate from `readPickedFile` because that one produces an `Attachment`:
 * base64, capped at the attachment budget, and destined for a MIME tree. A
 * backup is none of those things. It is text the user is about to paste into
 * the restore field, and reading it from a file rather than the clipboard is
 * the whole point — on a fresh install the blob usually lives in a file the
 * clipboard cannot reach.
 *
 * Refusals are returned, not thrown, exactly as `readPickedFile` does: picking
 * the wrong file is a mistake to explain, not a failure to report.
 */
export async function readTextFile(picked: PickedFile, cap: number = TEXT_FILE_CAP): Promise<TextReadResult> {
  const tooLarge = `${picked.name} is too large to be a ${cap > TEXT_FILE_CAP ? 'backup or transfer' : 'recovery backup'}.`;
  if (picked.size > cap) {
    return { refused: tooLarge };
  }

  const inline = /^data:[^;,]*;base64,(.*)$/s.exec(picked.uri);
  const text = inline ? decodeUtf8Base64(inline[1]) : await new File(picked.uri).text();

  // Some Android providers do not report a size, so the bytes actually read are
  // the authority — a provider that under-reported must not get a free pass.
  if (text.length > cap) {
    return { refused: tooLarge };
  }
  return { text };
}

/**
 * Ask for one file and read it as text. `null` when the user cancels.
 *
 * The pick and the read belong together for this caller: a restore form wants
 * "the backup, or the reason it isn't", and cancelling is neither — it is the
 * user changing their mind, which must leave the screen exactly as it was.
 */
export async function pickTextFile(cap?: number): Promise<TextReadResult | null> {
  const [picked] = await pickFiles();
  if (!picked) return null;
  return readTextFile(picked, cap);
}

/**
 * What a recovery backup is called when it is saved as a file.
 *
 * Names the address, because a backup restores into exactly one mailbox and
 * picking the wrong file is otherwise indistinguishable until it fails. Dated,
 * because taking a new backup supersedes the last one and the user needs to see
 * which is which in a folder of them.
 */
export function backupFileName(email: string, at: Date = new Date()): string {
  const safe = email.replace(/[^a-zA-Z0-9._@-]/g, '_');
  return `cryptmail-backup-${safe}-${at.toISOString().slice(0, 10)}.asc`;
}
