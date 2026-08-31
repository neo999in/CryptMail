import {
  dueSnoozed,
  isSnoozed,
  listSnoozed,
  quickSnoozeDates,
  removeSnooze,
  SnoozeMap,
  upsertSnooze,
} from '../snooze';

describe('snooze pure model', () => {
  const m1 = { id: 'msg-1', until: '2026-09-01T12:00:00.000Z', snoozedAt: '2026-09-01T08:00:00.000Z' };
  const m2 = { id: 'msg-2', until: '2026-09-01T18:00:00.000Z', snoozedAt: '2026-09-01T08:00:00.000Z' };
  const m3 = { id: 'msg-3', until: '2026-09-02T09:00:00.000Z', snoozedAt: '2026-09-01T08:00:00.000Z' };

  it('upsertSnooze adds and replaces entries', () => {
    let map: SnoozeMap = {};
    map = upsertSnooze(map, m1);
    expect(map['msg-1']).toEqual(m1);

    const m1Updated = { ...m1, until: '2026-09-01T15:00:00.000Z' };
    map = upsertSnooze(map, m1Updated);
    expect(map['msg-1'].until).toBe('2026-09-01T15:00:00.000Z');
  });

  it('removeSnooze removes an entry and ignores missing id', () => {
    let map: SnoozeMap = { 'msg-1': m1, 'msg-2': m2 };
    map = removeSnooze(map, 'msg-1');
    expect(map['msg-1']).toBeUndefined();
    expect(map['msg-2']).toEqual(m2);

    map = removeSnooze(map, 'non-existent');
    expect(map['msg-2']).toEqual(m2);
  });

  it('listSnoozed sorts by until timestamp soonest first', () => {
    const map: SnoozeMap = { 'msg-3': m3, 'msg-1': m1, 'msg-2': m2 };
    const list = listSnoozed(map);
    expect(list.map((s) => s.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  it('dueSnoozed returns only entries whose until <= now', () => {
    const map: SnoozeMap = { 'msg-1': m1, 'msg-2': m2, 'msg-3': m3 };
    
    // Before any is due
    expect(dueSnoozed(map, '2026-09-01T10:00:00.000Z')).toEqual([]);

    // Exactly at m1's due time
    expect(dueSnoozed(map, '2026-09-01T12:00:00.000Z').map((s) => s.id)).toEqual(['msg-1']);

    // Between m2 and m3
    expect(dueSnoozed(map, '2026-09-01T20:00:00.000Z').map((s) => s.id)).toEqual(['msg-1', 'msg-2']);

    // After all are due
    expect(dueSnoozed(map, '2026-09-03T00:00:00.000Z').map((s) => s.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  it('isSnoozed checks if message is currently snoozed', () => {
    const map: SnoozeMap = { 'msg-1': m1 };
    
    // Before due: snoozed is true
    expect(isSnoozed(map, 'msg-1', '2026-09-01T10:00:00.000Z')).toBe(true);

    // After due: snoozed is false
    expect(isSnoozed(map, 'msg-1', '2026-09-01T14:00:00.000Z')).toBe(false);

    // Missing id: snoozed is false
    expect(isSnoozed(map, 'unknown', '2026-09-01T10:00:00.000Z')).toBe(false);
  });

  it('quickSnoozeDates returns valid future preset options', () => {
    const refDate = new Date('2026-09-01T08:00:00.000Z');
    const options = quickSnoozeDates(refDate);

    expect(options.length).toBe(4);
    expect(options.map((o) => o.key)).toEqual(['later_today', 'tomorrow', 'weekend', 'next_week']);

    for (const opt of options) {
      expect(new Date(opt.until).getTime()).toBeGreaterThan(refDate.getTime());
      expect(opt.label).toBeTruthy();
      expect(opt.sublabel).toBeTruthy();
    }
  });
});

