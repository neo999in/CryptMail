/**
 * Reading a notification response back into what the user asked for.
 *
 * Everything else in `os.ts` is the OS itself; this is the one piece of logic,
 * and it is read as untrusted input.
 */
import { tapFromResponse } from '../os';

const response = (actionIdentifier: string, data: unknown) => ({
  actionIdentifier,
  notification: { request: { content: { data } } },
});

const ONE = { account: 'gmail:me@example.com', messageId: 'm1', messageIds: ['m1'] };
const MANY = { account: 'gmail:me@example.com', messageIds: ['m1', 'm2'] };

describe('tapFromResponse', () => {
  it('reads a tap on the notification itself as open', () => {
    expect(tapFromResponse(response('expo.modules.notifications.actions.DEFAULT', ONE))).toEqual({
      ...ONE,
      action: 'open',
    });
  });

  it('reads the Mark read and Reply buttons', () => {
    expect(tapFromResponse(response('mark-read', MANY))).toEqual({ ...MANY, messageId: undefined, action: 'mark-read' });
    expect(tapFromResponse(response('reply', ONE))?.action).toBe('reply');
  });

  it('never replies without exactly one message to reply to', () => {
    expect(tapFromResponse(response('reply', MANY))?.action).toBe('open');
  });

  it('refuses what is not ours, and drops ids that are not strings', () => {
    expect(tapFromResponse(null)).toBeNull();
    expect(tapFromResponse(response('mark-read', { messageIds: ['m1'] }))).toBeNull();
    expect(tapFromResponse({ notification: null })).toBeNull();
    expect(tapFromResponse(response('mark-read', { ...MANY, messageIds: ['m1', 7, null] }))?.messageIds).toEqual([
      'm1',
    ]);
  });
});
