/**
 * New-mail notifications through the state layer, against a fake OS.
 *
 * - the first sync of a mailbox announces nothing; mail after it does, once;
 * - mail on screen is never announced, and clears what the shade was counting;
 * - a mailbox switched off, or notifications off, posts nothing;
 * - what is posted is what `policy.ts` allows for the lock state — detail only
 *   while unlocked, and on the channel the lock screen never shows;
 * - the background look covers every connected mailbox, and one failing
 *   provider does not silence the rest.
 */
import { PLACEHOLDER_SUBJECT } from '../../core';
import { MailClient, MailSummary } from '../../mail/types';
import { NotifyLedger } from '../../notifications/newMail';
import { NotificationTap, OsNotifier } from '../../notifications/os';
import { NotificationText } from '../../notifications/policy';
import { AccountId, accountRefFor, DEFAULT_ACCOUNT_SETTINGS } from '../../store/accountScope';
import { MailHolder, Services } from '../contracts';
import { createNotify } from '../notify';
import { createStore, initialState, Store } from '../store';
import { InboxItem } from '../types';

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

const mockDisk = new Map<string, NotifyLedger>();
jest.mock('../../store/notifyStore', () => ({
  ...jest.requireActual('../../store/notifyStore'),
  loadLedger: jest.fn(async (account: string) => mockDisk.get(account) ?? { since: null, seen: [], pending: [] }),
  saveLedger: jest.fn(async (account: string, ledger: NotifyLedger) => void mockDisk.set(account, ledger)),
  saveNotificationPrefs: jest.fn(async (prefs: unknown) => prefs),
}));

const ME = accountRefFor('gmail', 'me@example.com');
const WORK = accountRefFor('gmail', 'work@example.com');

type Posted = { key: string; text: NotificationText; detailed: boolean; tap: NotificationTap };

function fakeOs(opts: { foreground?: boolean; locked?: boolean } = {}) {
  const posted: Posted[] = [];
  const dismissed: string[] = [];
  const os: OsNotifier = {
    supported: true,
    post: async (key, text, detailed, tap) => void posted.push({ key, text, detailed, tap }),
    dismiss: async (key) => void dismissed.push(key),
    deviceLocked: () => opts.locked ?? true,
    foreground: () => opts.foreground ?? false,
  };
  return { os, posted, dismissed };
}

function setup(osOpts: { foreground?: boolean; locked?: boolean } = {}) {
  mockDisk.clear();
  const store: Store = createStore(
    { ...initialState(), accounts: [ME, WORK], activeAccount: ME.id, session: null },
    () => {},
  );
  const mail: MailHolder = { current: null, clients: new Map() };
  const fake = fakeOs(osOpts);
  const setFlags = jest.fn(async () => {});
  const restoreOthers = jest.fn(async () => {});
  const services = { mailbox: { setFlags }, session: { restoreOthers } } as unknown as Services;
  const notify = createNotify({ store, mail, services }, fake.os);
  return { store, mail, notify, setFlags, restoreOthers, ...fake };
}

let n = 0;
function row(account: AccountId, patch: Partial<MailSummary> = {}): InboxItem {
  n += 1;
  return {
    id: `m${n}`,
    from: { address: 'ada@example.com', name: 'Ada Lovelace' },
    to: ['me@example.com'],
    date: new Date().toISOString(),
    subject: `The engine plans ${n}`,
    snippet: 'Attached are the notes',
    unread: true,
    starred: false,
    ...patch,
    account,
  };
}

describe('notify.observe', () => {
  it('primes on the first sync, then announces what arrives after it, once', async () => {
    const { notify, posted } = setup();
    const old = row(ME.id);
    await notify.observe([old]);
    expect(posted).toEqual([]);

    const fresh = row(ME.id);
    await notify.observe([fresh, old]);
    expect(posted).toEqual([
      {
        key: ME.id,
        text: { title: 'CryptMail', body: 'New message' },
        detailed: false,
        tap: { account: ME.id, messageId: fresh.id, messageIds: [fresh.id] },
      },
    ]);

    await notify.observe([fresh, old]);
    expect(posted).toHaveLength(1);
  });

  it('counts mail that arrives before the first was looked at into one notification', async () => {
    const { notify, posted } = setup();
    await notify.observe([row(ME.id)]);
    const first = row(ME.id);
    await notify.observe([first]);
    const second = row(ME.id);
    await notify.observe([second, first]);

    expect(posted).toHaveLength(2);
    expect(posted[1].text).toEqual({ title: 'CryptMail', body: '2 new messages' });
    // Several messages open the inbox, not one of them.
    expect(posted[1].tap).toMatchObject({ account: ME.id, messageId: undefined });
    // Both, for Mark all read. Order is by date, and these two share one.
    expect([...posted[1].tap.messageIds!].sort()).toEqual([first.id, second.id].sort());
  });

  it('announces nothing for a mailbox on screen, and clears what the shade counted', async () => {
    const { notify, posted, dismissed } = setup();
    await notify.observe([row(ME.id)]);
    await notify.observe([row(ME.id)]);
    expect(posted).toHaveLength(1);

    const looking = setup({ foreground: true });
    mockDisk.set(ME.id, { since: new Date(Date.now() - 60_000).toISOString(), seen: [], pending: ['x'] });
    await looking.notify.observe([row(ME.id)]);
    expect(looking.posted).toEqual([]);
    expect(looking.dismissed).toEqual([ME.id]);
    expect(mockDisk.get(ME.id)!.pending).toEqual([]);
    expect(dismissed).toEqual([]);
  });

  it('still announces a mailbox that is not on screen while the app is open', async () => {
    const { notify, posted } = setup({ foreground: true });
    await notify.observe([row(WORK.id)]);
    await notify.observe([row(WORK.id)]);
    expect(posted.map((p) => p.key)).toEqual([WORK.id]);
  });

  it('posts nothing for a mailbox switched off, or with notifications off', async () => {
    const muted = setup();
    muted.store.patch({ accounts: [{ ...ME, settings: { ...DEFAULT_ACCOUNT_SETTINGS, notify: false } }, WORK] });
    await muted.notify.observe([row(ME.id)]);
    await muted.notify.observe([row(ME.id)]);
    expect(muted.posted).toEqual([]);

    const off = setup();
    off.store.patch({ notificationPrefs: { preview: 'off', scope: 'primary' } });
    await off.notify.observe([row(ME.id)]);
    await off.notify.observe([row(ME.id)]);
    expect(off.posted).toEqual([]);
  });

  it('names the sender only while unlocked, on the channel the lock screen hides', async () => {
    const unlocked = setup({ locked: false });
    unlocked.store.patch({ notificationPrefs: { preview: 'sender', scope: 'primary' } });
    await unlocked.notify.observe([row(ME.id)]);
    await unlocked.notify.observe([row(ME.id)]);
    expect(unlocked.posted[0]).toMatchObject({
      text: { title: 'Ada Lovelace', body: 'New message' },
      detailed: true,
    });

    const locked = setup({ locked: true });
    locked.store.patch({ notificationPrefs: { preview: 'full', scope: 'primary' } });
    await locked.notify.observe([row(ME.id)]);
    await locked.notify.observe([row(ME.id)]);
    expect(locked.posted[0]).toMatchObject({ text: { title: 'CryptMail', body: 'New message' }, detailed: false });
  });

  it('shows encrypted mail only as far as this device has decrypted it', async () => {
    const { notify, posted, store } = setup({ locked: false });
    store.patch({ notificationPrefs: { preview: 'full', scope: 'primary' } });
    await notify.observe([row(ME.id)]);

    const sealed = row(ME.id, { subject: PLACEHOLDER_SUBJECT, snippet: '-----BEGIN PGP MESSAGE-----' });
    await notify.observe([sealed]);
    expect(posted[0]).toMatchObject({ text: { title: 'CryptMail', body: 'New message' }, detailed: false });

    const opened = row(ME.id, { subject: PLACEHOLDER_SUBJECT });
    store.patch({ searchIndex: { [opened.id]: { subject: 'Protected subject', body: 'Protected body' } } });
    await notify.observe([opened, sealed]);
    // Two pending: one readable (named), one not (counted, never named).
    expect(posted[1].text).toEqual({ title: '2 new messages', body: 'Ada Lovelace and 1 more' });
  });

  it('dismisses the notification once everything it counted was read elsewhere', async () => {
    const { notify, dismissed } = setup();
    await notify.observe([row(ME.id)]);
    const fresh = row(ME.id);
    await notify.observe([fresh]);
    await notify.observe([{ ...fresh, unread: false }]);
    expect(dismissed).toEqual([ME.id]);
  });
});

describe('notify.checkAll', () => {
  it('looks at every connected mailbox, and one failing does not silence the rest', async () => {
    const { notify, mail, posted } = setup();
    const pages = new Map<AccountId, InboxItem[][]>([
      [ME.id, [[row(ME.id)], [row(ME.id)]]],
      [WORK.id, [[row(WORK.id)], [row(WORK.id)]]],
    ]);
    const clientFor = (account: AccountId, fail = false) =>
      ({
        list: jest.fn(async () => {
          if (fail) throw new Error('offline');
          return { messages: pages.get(account)!.shift()! };
        }),
      }) as unknown as MailClient;

    mail.clients.set(ME.id, clientFor(ME.id));
    mail.clients.set(WORK.id, clientFor(WORK.id));
    await notify.checkAll();
    await notify.checkAll();
    expect(posted.map((p) => p.key).sort()).toEqual([ME.id, WORK.id].sort());

    mail.clients.set(WORK.id, clientFor(WORK.id, true));
    pages.set(ME.id, [[row(ME.id)]]);
    await expect(notify.checkAll()).resolves.toBeUndefined();
    expect(posted.filter((p) => p.key === ME.id)).toHaveLength(2);
  });
});

describe('notify.wanted', () => {
  it('is true only while notifications are on for a mailbox that syncs', () => {
    const { notify, store } = setup();
    expect(notify.wanted()).toBe(true);

    const quiet = { ...DEFAULT_ACCOUNT_SETTINGS, notify: false };
    const paused = { ...DEFAULT_ACCOUNT_SETTINGS, paused: true };
    store.patch({ accounts: [{ ...ME, settings: quiet }, { ...WORK, settings: paused }] });
    expect(notify.wanted()).toBe(false);

    store.patch({ accounts: [ME], notificationPrefs: { preview: 'off', scope: 'primary' } });
    expect(notify.wanted()).toBe(false);
  });
});

describe('notify.markRead', () => {
  const client = (fail: string[] = []) =>
    ({
      updateFlags: jest.fn(async (id: string) => {
        if (fail.includes(id)) throw new Error('offline');
      }),
    }) as unknown as MailClient & { updateFlags: jest.Mock };

  async function withPending() {
    const t = setup();
    await t.notify.observe([row(ME.id)]);
    const a = row(ME.id);
    const b = row(ME.id);
    await t.notify.observe([a, b]);
    return { ...t, a, b };
  }

  it('marks each message read — on-screen rows through the tap path — then clears the notification', async () => {
    const { notify, mail, store, setFlags, dismissed, a, b } = await withPending();
    const provider = client();
    mail.clients.set(ME.id, provider);
    store.patch({ messages: [a] });

    await notify.markRead(ME.id, [a.id, b.id]);
    expect(setFlags).toHaveBeenCalledWith(a.id, { unread: false });
    expect(provider.updateFlags).toHaveBeenCalledWith(b.id, { unread: false });
    expect(provider.updateFlags).not.toHaveBeenCalledWith(a.id, expect.anything());
    expect(dismissed).toEqual([ME.id]);
    expect(mockDisk.get(ME.id)!.pending).toEqual([]);
  });

  it('keeps the notification, and what failed, when the provider refuses one', async () => {
    const { notify, mail, dismissed, a, b } = await withPending();
    mail.clients.set(ME.id, client([b.id]));

    await notify.markRead(ME.id, [a.id, b.id]);
    expect(dismissed).toEqual([]);
    expect(mockDisk.get(ME.id)!.pending).toEqual([b.id]);
  });

  it('restores the mailbox first when a headless boot left it out, and does nothing without it', async () => {
    const { notify, restoreOthers, dismissed, a } = await withPending();
    await notify.markRead(ME.id, [a.id]);
    expect(restoreOthers).toHaveBeenCalledTimes(1);
    expect(dismissed).toEqual([]);
  });
});
