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
