import { fullTimestamp, relativeTime } from '../format';

/**
 * Assertions are on the *content* of the stamp, not on one locale's punctuation:
 * `toLocaleString` is deliberately given no locale so the device decides field
 * order, separators and 12- vs 24-hour, and pinning the exact string here would
 * lock the app to whichever locale CI happens to run in.
 */
describe('fullTimestamp', () => {
  const iso = '2026-09-02T12:13:37Z';

  test('names the weekday, the day, the month and the year', () => {
    const out = fullTimestamp(iso);
    expect(out).toMatch(/Wed/);
    expect(out).toMatch(/Sep/);
    expect(out).toMatch(/\b2\b/);
    expect(out).toMatch(/2026/);
  });

  test('carries a time as well as a date', () => {
    // The whole point of the change: the inbox's "Wed" says nothing about when.
    expect(fullTimestamp(iso)).toMatch(/\d{1,2}:\d{2}/);
  });

  test('spells out the year even for a message from this year', () => {
    const thisYear = `${new Date().getFullYear()}-03-04T09:05:00Z`;
    expect(fullTimestamp(thisYear)).toMatch(String(new Date().getFullYear()));
  });

  test('an unparseable date yields nothing rather than "Invalid Date"', () => {
    expect(fullTimestamp('not a date')).toBe('');
    expect(fullTimestamp('')).toBe('');
  });
});

describe('relativeTime', () => {
  // Kept as it was — the inbox column still wants the short form, and this is
  // the contrast `fullTimestamp` exists against.
  const now = new Date('2026-09-02T18:00:00Z');

  test('a message from today is a time of day', () => {
    expect(relativeTime('2026-09-02T09:30:00Z', now)).toMatch(/\d{1,2}:\d{2}/);
  });

  test('a message from this week is a weekday', () => {
    expect(relativeTime('2026-08-31T09:30:00Z', now)).toMatch(/^[A-Za-z]{3}/);
  });

  test('anything older carries a day and a month', () => {
    expect(relativeTime('2026-06-01T09:30:00Z', now)).toMatch(/Jun/);
  });

  test('an unparseable date yields nothing', () => {
    expect(relativeTime('not a date', now)).toBe('');
  });
});
