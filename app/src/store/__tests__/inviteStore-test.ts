/**
 * Invite throttling.
 *
 * An invite is a plaintext email to someone who has never heard of this app.
 * Writing three notes to a colleague must not send them three identical "install
 * this" emails — that is spam, and it comes from an address they trust.
 */
import { INVITE_WINDOW_MS, InviteLog, recordInvite, shouldInvite } from '../inviteStore';

const AT = new Date('2026-08-09T12:00:00.000Z');
const later = (ms: number) => new Date(AT.getTime() + ms);

describe('shouldInvite', () => {
  it('invites someone who has never been invited', () => {
    expect(shouldInvite({}, 'new@example.com', AT)).toBe(true);
  });

  it('does not invite the same address again inside the window', () => {
    const log = recordInvite({}, 'bob@example.com', AT);
    expect(shouldInvite(log, 'bob@example.com', later(INVITE_WINDOW_MS - 1000))).toBe(false);
  });

  it('invites again once the window has passed', () => {
    const log = recordInvite({}, 'bob@example.com', AT);
    expect(shouldInvite(log, 'bob@example.com', later(INVITE_WINDOW_MS))).toBe(true);
  });

  it('matches addresses case-insensitively, as mailboxes do', () => {
    const log = recordInvite({}, 'Bob@Example.com', AT);
    expect(shouldInvite(log, 'bob@example.com', AT)).toBe(false);
  });

  it('treats a damaged timestamp as never invited rather than just invited', () => {
    // Failing towards one extra invite is better than failing towards silence,
    // which would leave a queued message with nothing prompting its delivery.
    const log: InviteLog = { 'bob@example.com': 'not a date' };
    expect(shouldInvite(log, 'bob@example.com', AT)).toBe(true);
  });
});

describe('recordInvite', () => {
  it('does not mutate the log it is given', () => {
    const before: InviteLog = {};
    recordInvite(before, 'bob@example.com', AT);
    expect(before).toEqual({});
  });
});
