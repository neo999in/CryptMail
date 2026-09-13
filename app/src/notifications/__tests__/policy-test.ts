/**
 * The notification policy, one setting at a time, against features.md 0.10.
 *
 * The invariant every case checks is the same: the lock-screen text never
 * contains a sender, an address or a subject, whatever the setting.
 */
import {
  DEFAULT_NOTIFICATION_PREVIEW,
  GENERIC_TITLE,
  MAX_PREVIEW_CHARS,
  NewMail,
  NOTIFICATION_PREVIEW_LABEL,
  NOTIFICATION_PREVIEWS,
  NotificationPlan,
  NotificationPreview,
  parseRelayPayload,
  planFor,
} from '../policy';

const ADA: NewMail = {
  from: 'ada@example.com',
  fromName: 'Ada Lovelace',
  subject: 'The engine plans',
  snippet: 'Attached are the notes on',
  encrypted: true,
  decrypted: true,
};
const PLAIN: NewMail = {
  from: 'news@shop.test',
  subject: 'Sale ends tonight',
  encrypted: false,
  decrypted: false,
};
const SEALED: NewMail = {
  from: 'grace@example.com',
  fromName: 'Grace Hopper',
  subject: '[Encrypted message]',
  encrypted: true,
  decrypted: false,
};

const UNLOCKED = { locked: false };
const LOCKED = { locked: true };

const SECRETS = [ADA.from, ADA.fromName!, ADA.subject!, ADA.snippet!, PLAIN.from, PLAIN.subject!, SEALED.from, SEALED.fromName!];

function posted(plan: NotificationPlan) {
  if (!plan.post) throw new Error('expected a notification');
  return plan;
}

function expectGenericLockScreen(plan: NotificationPlan) {
  const { lockScreen, visibility } = posted(plan);
  expect(visibility).toBe('private');
  expect(lockScreen.title).toBe(GENERIC_TITLE);
  for (const secret of SECRETS) {
    expect(lockScreen.title).not.toContain(secret);
    expect(lockScreen.body).not.toContain(secret);
  }
}

describe('every setting', () => {
  const batches = [[ADA], [PLAIN], [SEALED], [ADA, PLAIN, SEALED]];

  it.each(NOTIFICATION_PREVIEWS.filter((p) => p !== 'off'))(
    '%s never puts a sender or subject on the lock screen',
    (preview) => {
      for (const mail of batches) {
        for (const device of [LOCKED, UNLOCKED]) expectGenericLockScreen(planFor(mail, preview, device));
      }
    },
  );

  it.each(NOTIFICATION_PREVIEWS.filter((p) => p !== 'off'))('%s shows only generic text while locked', (preview) => {
    const plan = posted(planFor([ADA], preview, LOCKED));
    expect(plan.content).toEqual(plan.lockScreen);
  });

  it('posts nothing for an empty batch', () => {
    for (const preview of NOTIFICATION_PREVIEWS) expect(planFor([], preview, UNLOCKED)).toEqual({ post: false });
  });

  it('has a label for each', () => {
    expect(Object.keys(NOTIFICATION_PREVIEW_LABEL).sort()).toEqual([...NOTIFICATION_PREVIEWS].sort());
  });
});

describe('off', () => {
  it('posts nothing', () => {
    expect(planFor([ADA], 'off', UNLOCKED)).toEqual({ post: false });
  });
});

describe('private — the default', () => {
  it('is the default', () => {
    expect(DEFAULT_NOTIFICATION_PREVIEW).toBe<NotificationPreview>('private');
  });

  it('says that mail arrived and nothing else, even unlocked', () => {
    expect(posted(planFor([ADA], 'private', UNLOCKED)).content).toEqual({ title: GENERIC_TITLE, body: 'New message' });
    expect(posted(planFor([ADA, PLAIN], 'private', UNLOCKED)).content).toEqual({
      title: GENERIC_TITLE,
      body: '2 new messages',
    });
  });
});

describe('sender', () => {
  it('names the sender of a decrypted message, but not what it is about', () => {
    const { content } = posted(planFor([ADA], 'sender', UNLOCKED));
    expect(content).toEqual({ title: 'Ada Lovelace', body: 'New message' });
  });

  it('falls back to the address when there is no name', () => {
    expect(posted(planFor([PLAIN], 'sender', UNLOCKED)).content.title).toBe('news@shop.test');
  });

  it('reveals nothing from an encrypted message this device has not decrypted', () => {
    const plan = posted(planFor([SEALED], 'sender', UNLOCKED));
    expect(plan.content).toEqual(plan.lockScreen);
  });
});

describe('full', () => {
  it('shows sender and subject of a decrypted message', () => {
    expect(posted(planFor([ADA], 'full', UNLOCKED)).content).toEqual({
      title: 'Ada Lovelace',
      body: 'The engine plans',
    });
  });

  it('uses the snippet when there is no subject, and a fixed line when there is neither', () => {
    expect(posted(planFor([{ ...ADA, subject: '' }], 'full', UNLOCKED)).content.body).toBe(ADA.snippet);
    expect(posted(planFor([{ ...ADA, subject: undefined, snippet: undefined }], 'full', UNLOCKED)).content.body).toBe(
      'New message',
    );
  });

  it('still reveals nothing from an undecrypted message — not even the envelope sender', () => {
    const plan = posted(planFor([SEALED], 'full', UNLOCKED));
    expect(plan.content).toEqual(plan.lockScreen);
    expect(JSON.stringify(plan)).not.toContain('grace');
  });

  it('keeps a subject to one short line', () => {
    const { body } = posted(planFor([{ ...ADA, subject: `line one\nline two ${'x'.repeat(300)}` }], 'full', UNLOCKED)).content;
    expect(body).not.toContain('\n');
    expect(body.length).toBe(MAX_PREVIEW_CHARS);
    expect(body.endsWith('…')).toBe(true);
  });
});

describe('a batch', () => {
  it.each<NotificationPreview>(['sender', 'full'])('%s names the senders once each and never a subject', (preview) => {
    const { content } = posted(planFor([ADA, { ...ADA, subject: 'Second' }, PLAIN], preview, UNLOCKED));
    expect(content.title).toBe('3 new messages');
    expect(content.body).toBe('Ada Lovelace, news@shop.test');
    expect(content.body).not.toContain('engine');
    expect(content.body).not.toContain('Sale');
  });

  it('counts the messages it cannot read instead of naming them', () => {
    const { content } = posted(planFor([ADA, SEALED], 'full', UNLOCKED));
    expect(content).toEqual({ title: '2 new messages', body: 'Ada Lovelace and 1 more' });
  });

  it('is generic when none of it was readable', () => {
    const plan = posted(planFor([SEALED, SEALED], 'full', UNLOCKED));
    expect(plan.content).toEqual({ title: GENERIC_TITLE, body: '2 new messages' });
  });
});

describe('parseRelayPayload — the push contract', () => {
  const TOKEN = 'k3J9xQ2mZ7pL0vB8nR4tYw';

  it('accepts exactly the contract', () => {
    expect(parseRelayPayload({ v: 1, t: 'sync', a: TOKEN })).toEqual({ v: 1, t: 'sync', a: TOKEN });
    // FCM data values arrive as strings.
    expect(parseRelayPayload({ v: '1', t: 'sync', a: TOKEN })).toEqual({ v: 1, t: 'sync', a: TOKEN });
  });

  it('refuses a payload carrying anything more', () => {
    for (const extra of [
      { subject: 'Hello' },
      { from: 'ada@example.com' },
      { messageId: 'abc' },
      { count: 3 },
      { notification: { title: 'New mail' } },
    ]) {
      expect(parseRelayPayload({ v: 1, t: 'sync', a: TOKEN, ...extra })).toBeNull();
    }
  });

  it('refuses a wrong version, instruction or token', () => {
    expect(parseRelayPayload({ v: 2, t: 'sync', a: TOKEN })).toBeNull();
    expect(parseRelayPayload({ v: 1, t: 'show', a: TOKEN })).toBeNull();
    expect(parseRelayPayload({ v: 1, t: 'sync', a: 'ada@example.com' })).toBeNull();
    expect(parseRelayPayload({ v: 1, t: 'sync', a: 'short' })).toBeNull();
    expect(parseRelayPayload({ v: 1, t: 'sync' })).toBeNull();
  });

  it('refuses what is not an object', () => {
    for (const bad of [null, undefined, 'sync', 1, [TOKEN]]) expect(parseRelayPayload(bad)).toBeNull();
  });
});
