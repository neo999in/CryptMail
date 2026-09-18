/**
 * What a sync announces — the ledger that decides "new mail" before the policy
 * decides what a notification may say about it.
 */
import { PLACEHOLDER_SUBJECT } from '../../core';
import { MailSummary } from '../../mail/types';
import {
  clearPending,
  EMPTY_LEDGER,
  ledgerChanged,
  MAX_AGE_MS,
  NotifyLedger,
  observe,
  ObserveOptions,
  SEEN_CAP,
  toNewMail,
} from '../newMail';

const NOW = new Date('2026-09-18T12:00:00Z');
const SINCE = '2026-09-18T09:00:00Z';
const OPTIONS: ObserveOptions = { self: 'me@example.com', scope: 'primary', now: NOW };

function row(id: string, patch: Partial<MailSummary> = {}): MailSummary {
  return {
    id,
    from: { address: 'ada@example.com', name: 'Ada' },
    to: ['me@example.com'],
    date: '2026-09-18T11:00:00Z',
    subject: `Subject ${id}`,
    snippet: `Snippet ${id}`,
    unread: true,
    starred: false,
    ...patch,
  };
}

const watching = (seen: string[] = [], pending: string[] = []): NotifyLedger => ({ since: SINCE, seen, pending });

describe('observe', () => {
  it('only primes on the first sync a mailbox is watched', () => {
    const result = observe(EMPTY_LEDGER, [row('a'), row('b')], OPTIONS);
    expect(result.fresh).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(result.ledger).toEqual({ since: NOW.toISOString(), seen: ['a', 'b'], pending: [] });
  });

  it('announces an unread row it has not seen', () => {
    const result = observe(watching(['a']), [row('b'), row('a')], OPTIONS);
    expect(result.fresh.map((r) => r.id)).toEqual(['b']);
    expect(result.ledger.pending).toEqual(['b']);
    expect(result.ledger.seen).toEqual(['a', 'b']);
  });

  it('never announces the same message twice', () => {
    const first = observe(watching(), [row('b')], OPTIONS);
    const second = observe(first.ledger, [row('b')], OPTIONS);
    expect(second.fresh).toEqual([]);
    // Still unread, still counted by the notification on the shade.
    expect(second.pending.map((r) => r.id)).toEqual(['b']);
  });

  it('records rows it did not announce, so marking one unread later stays quiet', () => {
    const read = observe(watching(), [row('b', { unread: false })], OPTIONS);
    expect(read.fresh).toEqual([]);
    const unreadAgain = observe(read.ledger, [row('b')], OPTIONS);
    expect(unreadAgain.fresh).toEqual([]);
  });

  it('stays quiet about read mail, own mail, junk and old mail', () => {
    const result = observe(
      watching(),
      [
        row('read', { unread: false }),
        row('mine', { from: { address: 'ME@example.com' } }),
        row('junk', { labels: ['SPAM'] }),
        row('ancient', { date: new Date(NOW.getTime() - MAX_AGE_MS - 1).toISOString() }),
        row('before-watching', { date: '2026-09-18T08:00:00Z' }),
      ],
      OPTIONS,
    );
    expect(result.fresh).toEqual([]);
  });

  it('allows for delivery lag just before watching began', () => {
    const result = observe(watching(), [row('late', { date: '2026-09-18T08:55:00Z' })], OPTIONS);
    expect(result.fresh.map((r) => r.id)).toEqual(['late']);
  });

  it('keeps promotions quiet in primary scope and announces them in all', () => {
    const promo = row('promo', { labels: ['INBOX', 'CATEGORY_PROMOTIONS'] });
    expect(observe(watching(), [promo], OPTIONS).fresh).toEqual([]);
    expect(observe(watching(), [promo], { ...OPTIONS, scope: 'all' }).fresh.map((r) => r.id)).toEqual(['promo']);
  });

  it('does not let a label on ciphertext silence encrypted mail', () => {
    const sealed = row('sealed', { subject: PLACEHOLDER_SUBJECT, labels: ['SPAM', 'CATEGORY_PROMOTIONS'] });
    expect(observe(watching(), [sealed], OPTIONS).fresh.map((r) => r.id)).toEqual(['sealed']);
  });

  it('counts pending mail newest first and drops what has since been read', () => {
    const first = observe(watching(), [row('b', { date: '2026-09-18T10:00:00Z' })], OPTIONS);
    const second = observe(
      first.ledger,
      [row('c', { date: '2026-09-18T11:30:00Z' }), row('b', { date: '2026-09-18T10:00:00Z' })],
      OPTIONS,
    );
    expect(second.pending.map((r) => r.id)).toEqual(['c', 'b']);

    const readElsewhere = observe(second.ledger, [row('c', { unread: false }), row('b')], OPTIONS);
    expect(readElsewhere.pending.map((r) => r.id)).toEqual(['b']);
    expect(readElsewhere.fresh).toEqual([]);
  });

  it('bounds what it remembers', () => {
    const many = Array.from({ length: SEEN_CAP + 20 }, (_, i) => `id${i}`);
    const result = observe(watching(many.slice(0, SEEN_CAP)), many.map((id) => row(id, { unread: false })), OPTIONS);
    expect(result.ledger.seen).toHaveLength(SEEN_CAP);
    expect(result.ledger.seen[SEEN_CAP - 1]).toBe(`id${SEEN_CAP + 19}`);
  });
});

describe('clearPending and ledgerChanged', () => {
  it('clears the count and reports the change', () => {
    const ledger = watching(['a'], ['a']);
    const cleared = clearPending(ledger);
    expect(cleared.pending).toEqual([]);
    expect(ledgerChanged(ledger, cleared)).toBe(true);
    expect(clearPending(cleared)).toBe(cleared);
    expect(ledgerChanged(cleared, { ...cleared })).toBe(false);
  });
});

describe('toNewMail', () => {
  it('passes plaintext through', () => {
    expect(toNewMail(row('a'))).toEqual({
      from: 'ada@example.com',
      fromName: 'Ada',
      subject: 'Subject a',
      snippet: 'Snippet a',
      encrypted: false,
      decrypted: false,
    });
  });

  it('never offers the placeholder or the provider snippet of encrypted mail', () => {
    const sealed = row('s', { subject: PLACEHOLDER_SUBJECT, snippet: '-----BEGIN PGP MESSAGE-----' });
    expect(toNewMail(sealed)).toMatchObject({ encrypted: true, decrypted: false, subject: undefined, snippet: undefined });
    expect(toNewMail(sealed, { subject: 'Real subject', body: 'Real body' })).toMatchObject({
      encrypted: true,
      decrypted: true,
      subject: 'Real subject',
      snippet: 'Real body',
    });
  });
});
