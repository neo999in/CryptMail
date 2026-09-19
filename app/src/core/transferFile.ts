/**
 * Telling a device transfer from a recovery backup, so one restore field can
 * take either file. Both cores write this armor line; see `core/src/transfer.rs`.
 */
export const TRANSFER_ARMOR_HEADER = '-----BEGIN CRYPTMAIL TRANSFER-----';

export function isTransferFile(text: string): boolean {
  return text.includes(TRANSFER_ARMOR_HEADER);
}

/** What a transfer is called when it is saved as a file — named and dated, as a backup is. */
export function transferFileName(email: string, at: Date = new Date()): string {
  const safe = email.replace(/[^a-zA-Z0-9._@-]/g, '_');
  return `cryptmail-transfer-${safe}-${at.toISOString().slice(0, 10)}.txt`;
}
