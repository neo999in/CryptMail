/**
 * The attachment model: sizes, and the refusals that keep a >1 MB file from
 * being turned into a JavaScript string in the first place.
 */
import {
  Attachment,
  addAttachment,
  attachmentRefusal,
  decodedSize,
  formatBytes,
  isImage,
  MAX_ATTACHMENT_BYTES,
  MAX_STORED_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  removeAttachment,
  splitForStorage,
  totalBytes,
} from '../attachment';
import { bytesToBase64 } from '../../lib/base64';

const file = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'a1',
  name: 'menu.pdf',
  mimeType: 'application/pdf',
  size: 1024,
  data: 'AAAA',
  ...over,
});

describe('decodedSize', () => {
  it('matches the real byte length for every padding case', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 17, 300]) {
      const bytes = Uint8Array.from({ length }, (_, i) => i % 256);
      expect(decodedSize(bytesToBase64(bytes))).toBe(length);
    }
  });

  it('ignores the line breaks a wrapped MIME part carries', () => {
    const bytes = Uint8Array.from({ length: 200 }, (_, i) => i % 256);
    const wrapped = (bytesToBase64(bytes).match(/.{1,76}/g) ?? []).join('\n');
    expect(decodedSize(wrapped)).toBe(200);
  });
});

describe('attachmentRefusal', () => {
  it('allows a file under the cap', () => {
    expect(attachmentRefusal({ name: 'a.pdf', size: 500_000 }, [])).toBeNull();
  });

  it('allows the everyday attachment — a photo, a deck, a PDF', () => {
    expect(attachmentRefusal({ name: 'deck.pdf', size: 4 * 1024 * 1024 }, [])).toBeNull();
  });

  it('refuses what the wire cannot take, whatever a provider advertises', () => {
    // Base64 (+33%) then armor (+33%) roughly doubles a file, so a 10 MB
    // attachment is a ~18 MB message; the cap is on what arrives, not on disk.
    expect(attachmentRefusal({ name: 'video.mp4', size: 10 * 1024 * 1024 }, [])).not.toBeNull();
  });

  it('refuses a file over the per-file cap, and says how big it was', () => {
    const refusal = attachmentRefusal({ name: 'video.mp4', size: MAX_ATTACHMENT_BYTES + 1 }, []);
    expect(refusal).toContain('video.mp4');
    expect(refusal).toContain(formatBytes(MAX_ATTACHMENT_BYTES));
  });

  it('refuses a file that would take the message past the total cap', () => {
    const existing = [file({ size: MAX_TOTAL_ATTACHMENT_BYTES - 100 })];
    expect(attachmentRefusal({ name: 'b.pdf', size: 500 }, existing)).toContain('past');
  });

  it('counts what is already attached, not just this file', () => {
    const half = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 2);
    const existing = [file({ size: half })];
    // Under the per-file cap on its own — but the pair is over the total.
    expect(attachmentRefusal({ name: 'b.pdf', size: MAX_ATTACHMENT_BYTES }, [])).toBeNull();
    expect(
      attachmentRefusal({ name: 'b.pdf', size: MAX_ATTACHMENT_BYTES }, [...existing, file({ id: 'a2', size: half })]),
    ).not.toBeNull();
  });
});

describe('the list reducers', () => {
  it('adds, replaces by id, and removes', () => {
    const one = file();
    const two = file({ id: 'a2', name: 'deck.key', size: 2048 });

    let list = addAttachment([], one);
    list = addAttachment(list, two);
    expect(list.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(totalBytes(list)).toBe(1024 + 2048);

    list = addAttachment(list, file({ name: 'menu-v2.pdf' }));
    expect(list).toHaveLength(2);
    expect(list.find((a) => a.id === 'a1')?.name).toBe('menu-v2.pdf');

    expect(removeAttachment(list, 'a1').map((a) => a.id)).toEqual(['a2']);
    expect(removeAttachment(list, 'nope')).toHaveLength(2);
  });
});

describe('presentation', () => {
  it('shows sizes in units people read', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('treats only image types as images', () => {
    expect(isImage({ mimeType: 'image/png' })).toBe(true);
    expect(isImage({ mimeType: 'IMAGE/JPEG' })).toBe(true);
    expect(isImage({ mimeType: 'application/pdf' })).toBe(false);
  });
});

describe('splitForStorage', () => {
  const KB = 1024;

  it('keeps everything when it fits the draft budget', () => {
    const list = [file({ size: 10 * KB }), file({ id: 'a2', size: 20 * KB })];
    expect(splitForStorage(list)).toEqual({ stored: list, omitted: [] });
  });

  it('names what a draft cannot hold instead of dropping it silently', () => {
    const big = file({ id: 'big', name: 'holiday.mov', size: 20 * 1024 * KB });
    const small = file({ id: 'small', name: 'notes.txt', size: 4 * KB });

    const { stored, omitted } = splitForStorage([big, small]);
    expect(stored.map((a) => a.name)).toEqual(['notes.txt']);
    expect(omitted).toEqual(['holiday.mov']);
  });

  it('spends the budget in order, so a run of files cannot overrun it', () => {
    const half = Math.floor(MAX_STORED_ATTACHMENT_BYTES / 2);
    const list = [
      file({ id: 'a1', name: 'one', size: half }),
      file({ id: 'a2', name: 'two', size: half }),
      file({ id: 'a3', name: 'three', size: half }),
    ];

    const { stored, omitted } = splitForStorage(list);
    expect(stored.map((a) => a.name)).toEqual(['one', 'two']);
    expect(omitted).toEqual(['three']);
    expect(stored.reduce((n, a) => n + a.size, 0)).toBeLessThanOrEqual(MAX_STORED_ATTACHMENT_BYTES);
  });
});
