import { dueScheduled, listScheduled, removeScheduled, Scheduled, ScheduledOutbox, upsertScheduled } from '../outbox';

function item(id: string, sendAt: string, over: Partial<Scheduled> = {}): Scheduled {
  return { id, to: ['a@b.com'], subject: 's', body: 'b', sendAt, ...over };
}

describe('listScheduled', () => {
  test('orders by sendAt, soonest first', () => {
    const o: ScheduledOutbox = {
      a: item('a', '2026-07-23T12:00:00Z'),
      b: item('b', '2026-07-23T09:00:00Z'),
      c: item('c', '2026-07-23T10:00:00Z'),
    };
    expect(listScheduled(o).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  test('is empty for an empty outbox', () => {
    expect(listScheduled({})).toEqual([]);
  });
});

describe('dueScheduled', () => {
  const o: ScheduledOutbox = {
    past: item('past', '2026-07-23T08:00:00Z'),
    now: item('now', '2026-07-23T10:00:00Z'),
    future: item('future', '2026-07-23T12:00:00Z'),
  };

  test('returns items at or before now, soonest first', () => {
    expect(dueScheduled(o, '2026-07-23T10:00:00Z').map((s) => s.id)).toEqual(['past', 'now']);
  });

  test('excludes future items', () => {
    expect(dueScheduled(o, '2026-07-23T09:00:00Z').map((s) => s.id)).toEqual(['past']);
  });

  test('is empty when nothing is due yet', () => {
    expect(dueScheduled(o, '2026-07-23T07:00:00Z')).toEqual([]);
  });
});

describe('upsertScheduled / removeScheduled', () => {
  test('upsert adds an item without mutating the input', () => {
    const before: ScheduledOutbox = {};
    const next = upsertScheduled(before, item('a', '2026-07-23T10:00:00Z'));
    expect(next.a.id).toBe('a');
    expect(before).toEqual({});
  });

  test('remove deletes an item without mutating the input', () => {
    const before: ScheduledOutbox = { a: item('a', '2026-07-23T10:00:00Z') };
    const next = removeScheduled(before, 'a');
    expect(next.a).toBeUndefined();
    expect(before.a).toBeDefined();
  });

  test('remove is a no-op for an unknown id', () => {
    const before: ScheduledOutbox = { a: item('a', '2026-07-23T10:00:00Z') };
    expect(Object.keys(removeScheduled(before, 'x'))).toEqual(['a']);
  });
});
