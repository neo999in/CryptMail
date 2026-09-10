/**
 * Reading a recovery backup off disk.
 *
 * Only the parts that are platform-free: the cap, and the web `data:` URL path
 * that `pickFiles` produces. The `content://` branch is `expo-file-system` and
 * belongs to a device.
 */
import { backupFileName, readTextFile } from '../files';
import { encodeUtf8Base64 } from '../base64';

jest.mock('expo-document-picker', () => ({}));
jest.mock('expo-file-system', () => ({ File: class {}, Paths: { cache: '' } }));
jest.mock('expo-sharing', () => ({}));

const asDataUrl = (text: string) => `data:text/plain;base64,${encodeUtf8Base64(text)}`;

const picked = (text: string, name = 'backup.asc') => ({
  name,
  mimeType: 'text/plain',
  size: text.length,
  uri: asDataUrl(text),
});

describe('readTextFile', () => {
  it('reads an armored backup out of a picked file', async () => {
    const blob = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----';

    expect(await readTextFile(picked(blob))).toEqual({ text: blob });
  });

  it('survives the non-ASCII a comment header can carry', async () => {
    const blob = 'Comment: sauvegarde — clé\nabc';

    expect(await readTextFile(picked(blob))).toEqual({ text: blob });
  });

  it('refuses an oversized file by its reported size, before reading it', async () => {
    // The uri is deliberately tiny: a refusal that had to read the file first
    // would be holding the very string the cap exists to avoid.
    const result = await readTextFile({
      name: 'holiday.mp4',
      mimeType: 'video/mp4',
      size: 200 * 1024 * 1024,
      uri: asDataUrl('x'),
    });

    expect(result).toEqual({ refused: 'holiday.mp4 is too large to be a recovery backup.' });
  });

  it('refuses on the bytes read when the provider under-reported the size', async () => {
    const huge = 'x'.repeat(300 * 1024);
    const result = await readTextFile({
      name: 'lying.bin',
      mimeType: 'application/octet-stream',
      size: 0,
      uri: asDataUrl(huge),
    });

    expect(result).toEqual({ refused: 'lying.bin is too large to be a recovery backup.' });
  });
});

describe('backupFileName', () => {
  it('names the address and the day, so one backup is tellable from another', () => {
    expect(backupFileName('you@gmail.com', new Date('2026-09-09T12:00:00Z'))).toBe(
      'cryptmail-backup-you@gmail.com-2026-09-09.asc',
    );
  });

  it('keeps a path separator out of the file name', () => {
    expect(backupFileName('a/b@x.com', new Date('2026-09-09T12:00:00Z'))).toBe(
      'cryptmail-backup-a_b@x.com-2026-09-09.asc',
    );
  });
});
