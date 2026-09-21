import {
  clearHandshake,
  handshakeEntry,
  HANDSHAKE_RESEND_MS,
  HANDSHAKE_RETRY_MS,
  recordHandshake,
  recordHandshakeFailure,
  shouldHandshake,
} from '../handshakeStore';

const T0 = new Date('2026-09-21T10:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('handshake log', () => {
  it('sends to an address never tried', () => {
    expect(shouldHandshake({}, 'ada@example.com', T0)).toBe(true);
  });

  it('does not send again by itself for a week after one went out', () => {
    const log = recordHandshake({}, 'Ada@Example.com', T0);
    expect(shouldHandshake(log, 'ada@example.com', later(24 * 60 * 60 * 1000))).toBe(false);
    expect(shouldHandshake(log, 'ada@example.com', later(HANDSHAKE_RESEND_MS))).toBe(true);
  });

  it('retries a failure after a short pause, and keeps why it failed', () => {
    const log = recordHandshakeFailure({}, 'ada@example.com', 'Offline.', T0);
    expect(handshakeEntry(log, 'ada@example.com')).toEqual({ outcome: 'failed', at: T0.toISOString(), error: 'Offline.' });
    expect(shouldHandshake(log, 'ada@example.com', later(HANDSHAKE_RETRY_MS - 1))).toBe(false);
    expect(shouldHandshake(log, 'ada@example.com', later(HANDSHAKE_RETRY_MS))).toBe(true);
  });

  it('reads the earlier bare-timestamp format as sent', () => {
    const log = { 'ada@example.com': T0.toISOString() };
    expect(handshakeEntry(log, 'ada@example.com')).toEqual({ outcome: 'sent', at: T0.toISOString() });
    expect(shouldHandshake(log, 'ada@example.com', later(HANDSHAKE_RETRY_MS))).toBe(false);
  });

  it('clearing an address makes it due again', () => {
    const log = clearHandshake(recordHandshake({}, 'ada@example.com', T0), 'ADA@example.com');
    expect(handshakeEntry(log, 'ada@example.com')).toBeNull();
    expect(shouldHandshake(log, 'ada@example.com', T0)).toBe(true);
  });
});
