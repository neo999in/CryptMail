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

/** A file the user chose, with its bytes still on disk. */
export type PickedFile = { name: string; mimeType: string; size: number; uri: string };

/** Either the attachment, or the sentence explaining why not. Never throws for a refusal. */
export type PickResult = { attachment: Attachment } | { refused: string };

/**
 * Open the system picker. Returns nothing at all when the user cancels —
 * cancelling is not an error and must not put a banner on the screen.
 */
export async function pickFiles(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
    // Web returns the bytes inline as a `data:` URL; there is no path to read.
    base64: true,
  });
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
    await Sharing.shareAsync(file.uri, { mimeType: attachment.mimeType, UTI: attachment.mimeType });
  }
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
