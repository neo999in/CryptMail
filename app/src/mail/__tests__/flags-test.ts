import { applyFlagPatch } from '../flags';
import { MailSummary } from '../types';

function msg(id: string, over: Partial<MailSummary> = {}): MailSummary {
  return {
    id,
    from: { address: 'a@b.com', name: 'A' },
    to: ['you@gmail.com'],
    date: '2026-07-23T10:00:00Z',
    subject: 's',
    snippet: '',
    unread: false,
    starred: false,
    ...over,
  };
}

describe('applyFlagPatch', () => {
  const list = [msg('m1'), msg('m2', { starred: true })];

  /**
   * Archiving and un-archiving are one move in two directions, and each takes
   * the row out of the list it was patched in: out of the inbox one way, out of
   * Archive the other. Undoing an archive from a toast is the second of those,
   * so `archived: false` dropping the row is what makes the undo look right.
   */
  test('drops the message from the list it was archived out of', () => {
    expect(applyFlagPatch(list, 'm1', { archived: true }).map((m) => m.id)).toEqual(['m2']);
  });

  test('drops it again when un-archived, from the archive it left', () => {
    expect(applyFlagPatch(list, 'm1', { archived: false }).map((m) => m.id)).toEqual(['m2']);
  });

  test('stars the matching message and leaves others unchanged', () => {
    const next = applyFlagPatch(list, 'm1', { starred: true });
    expect(next.find((m) => m.id === 'm1')!.starred).toBe(true);
    expect(next.find((m) => m.id === 'm2')!.starred).toBe(true);
  });

  test('unstars a message', () => {
    const next = applyFlagPatch(list, 'm2', { starred: false });
    expect(next.find((m) => m.id === 'm2')!.starred).toBe(false);
  });

  test('marks a message unread', () => {
    const next = applyFlagPatch(list, 'm1', { unread: true });
    expect(next.find((m) => m.id === 'm1')!.unread).toBe(true);
  });

  test('applies several flags at once', () => {
    const next = applyFlagPatch(list, 'm1', { unread: true, starred: true });
    const m1 = next.find((m) => m.id === 'm1')!;
    expect(m1.unread).toBe(true);
    expect(m1.starred).toBe(true);
  });

  test('archiving removes the message from the list', () => {
    const next = applyFlagPatch(list, 'm1', { archived: true });
    expect(next.map((m) => m.id)).toEqual(['m2']);
  });

  test('deleting removes the message from the list it was in', () => {
    const next = applyFlagPatch(list, 'm1', { trashed: true });
    expect(next.map((m) => m.id)).toEqual(['m2']);
  });

  test('restoring removes the message from the trash list it was in', () => {
    // The other direction of the same move: a restored message leaves Trash.
    // Which list gains it is the business of that list, which refetches.
    const next = applyFlagPatch(list, 'm2', { trashed: false });
    expect(next.map((m) => m.id)).toEqual(['m1']);
  });

  test('an unknown id leaves the list unchanged', () => {
    const next = applyFlagPatch(list, 'nope', { starred: true });
    expect(next.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  test('does not mutate the input list or its messages', () => {
    const before = [msg('m1', { starred: false })];
    applyFlagPatch(before, 'm1', { starred: true });
    expect(before[0].starred).toBe(false);
  });
});
