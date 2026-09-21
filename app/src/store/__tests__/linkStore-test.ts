import { LINK_WINDOW_MS, linkState, LinkLog, recordLink, shouldLink } from '../linkStore';

const now = new Date('2026-09-20T12:00:00Z');

describe('quantum link log', () => {
  it('allows a first exchange with an address', () => {
    expect(shouldLink({}, 'bob@example.com', now)).toBe(true);
  });

  it('refuses a second exchange while one is still running', () => {
    const log = recordLink({}, 'bob@example.com', 'starting', now);
    expect(shouldLink(log, 'bob@example.com', now)).toBe(false);
  });

  it('lets a stalled exchange be started again after a day', () => {
    const log = recordLink({}, 'bob@example.com', 'starting', now);
    const later = new Date(now.getTime() + LINK_WINDOW_MS);
    expect(shouldLink(log, 'bob@example.com', later)).toBe(true);
  });

  it('allows relinking once an exchange has finished either way', () => {
    for (const state of ['linked', 'refused'] as const) {
      const log = recordLink({}, 'bob@example.com', state, now);
      expect(shouldLink(log, 'bob@example.com', now)).toBe(true);
    }
  });

  it('keys addresses the same however they are typed', () => {
    const log = recordLink({}, 'Bob@Example.com ', 'starting', now);
    expect(shouldLink(log, 'bob@example.com', now)).toBe(false);
    expect(linkState(log, 'BOB@EXAMPLE.COM')).toBe('starting');
  });

  it('keeps one address from affecting another', () => {
    const log = recordLink({}, 'bob@example.com', 'starting', now);
    expect(shouldLink(log, 'carol@example.com', now)).toBe(true);
    expect(linkState(log, 'carol@example.com')).toBeNull();
  });

  it('treats an unreadable time as no exchange at all', () => {
    const log: LinkLog = { 'bob@example.com': { at: 'not a date', state: 'starting' } };
    expect(shouldLink(log, 'bob@example.com', now)).toBe(true);
  });
});
