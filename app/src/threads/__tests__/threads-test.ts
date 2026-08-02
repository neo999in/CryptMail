import { MailSummary } from '../../mail/types';
import { groupIntoThreads } from '../threads';

function msg(id: string, date: string, threadId?: string): MailSummary {
  return {
    id,
    threadId,
    from: { address: 'a@b.com', name: 'A' },
    to: ['you@gmail.com'],
    date,
    subject: 's',
    snippet: '',
    unread: false,
    starred: false,
  };
}

describe('groupIntoThreads', () => {
  test('groups messages that share a threadId into one thread', () => {
    const threads = groupIntoThreads([
      msg('m1', '2026-07-23T10:00:00Z', 't1'),
      msg('m2', '2026-07-23T11:00:00Z', 't1'),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].count).toBe(2);
  });

  test('a message with no threadId is its own thread', () => {
    const threads = groupIntoThreads([msg('m1', '2026-07-23T10:00:00Z'), msg('m2', '2026-07-23T11:00:00Z')]);
    expect(threads).toHaveLength(2);
  });

  test('messages within a thread are ordered oldest to newest', () => {
    const threads = groupIntoThreads([
      msg('m2', '2026-07-23T11:00:00Z', 't1'),
      msg('m1', '2026-07-23T10:00:00Z', 't1'),
    ]);
    expect(threads[0].messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  test('latest is the newest message in the thread', () => {
    const threads = groupIntoThreads([
      msg('m1', '2026-07-23T10:00:00Z', 't1'),
      msg('m2', '2026-07-23T11:00:00Z', 't1'),
    ]);
    expect(threads[0].latest.id).toBe('m2');
  });

  test('threads are ordered by their latest message, newest first', () => {
    const threads = groupIntoThreads([
      msg('old', '2026-07-23T08:00:00Z', 't-old'),
      msg('new', '2026-07-23T12:00:00Z', 't-new'),
    ]);
    expect(threads.map((t) => t.id)).toEqual(['t-new', 't-old']);
  });

  test('a single message yields one thread of count 1', () => {
    const threads = groupIntoThreads([msg('m1', '2026-07-23T10:00:00Z', 't1')]);
    expect(threads).toHaveLength(1);
    expect(threads[0].count).toBe(1);
    expect(threads[0].latest.id).toBe('m1');
  });
});
