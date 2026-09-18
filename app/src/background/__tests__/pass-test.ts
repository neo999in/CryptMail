/**
 * Whose services a background pass runs on.
 *
 * The danger this guards is a double send: two service graphs each holding the
 * same outbox, each with its own `inFlight` set. So every case here is about
 * routing — the foreground's graph when there is one, exactly one headless graph
 * when there is not, and the app's boot waiting out a headless pass.
 *
 * The hosts are fakes. What `scheduler.run()` does with an outbox is covered in
 * `state/__tests__`; here it only has to be called on the right graph.
 */
import { Session } from '../../auth';
import { Services } from '../../state/contracts';
import { createStore, initialState } from '../../state/store';
import { attachForeground, backgroundIdle, runBackgroundPass, runNotificationAction, SchedulerHost } from '../pass';

// The real graph pulls in every provider and a native sign-in module; these
// tests never build it.
jest.mock('../../state/services', () => ({ createServices: jest.fn() }));

// Reached through the store's directory import; no native binary under jest.
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn() },
}));

const SESSION: Session = {
  provider: 'gmail',
  email: 'me@example.com',
  accessToken: 'token',
  expiresAt: Date.now() + 3_600_000,
};

const queued = { id: 'sch-1' } as never;

function host(
  opts: { session?: Session | null; bootsTo?: Session | null; bootGate?: Promise<void>; watching?: boolean } = {},
) {
  const store = createStore({ ...initialState(), session: opts.session ?? null }, () => {});
  const run = jest.fn(async () => {});
  const boot = jest.fn(async () => {
    await opts.bootGate;
    if (opts.bootsTo !== undefined) store.patch({ session: opts.bootsTo, scheduled: { 'sch-1': queued } });
  });
  const restoreOthers = jest.fn(async () => {});
  const checkAll = jest.fn(async () => {});
  const wanted = jest.fn(() => opts.watching ?? false);
  const markRead = jest.fn(async () => {});
  const services = {
    scheduler: { run },
    session: { boot, restoreOthers },
    notify: { wanted, checkAll, markRead },
  } as unknown as Services;
  return { host: { store, services } as SchedulerHost, run, boot, restoreOthers, checkAll, markRead };
}

describe('runBackgroundPass', () => {
  it('looks for new mail in every mailbox when headless and notifications are on', async () => {
    const bg = host({ bootsTo: SESSION, watching: true });

    await expect(runBackgroundPass(() => bg.host)).resolves.toEqual({ status: 'ran', waiting: 1, watching: true });
    expect(bg.restoreOthers).toHaveBeenCalledTimes(1);
    expect(bg.checkAll).toHaveBeenCalledTimes(1);
  });

  it('does not restore other mailboxes on an app that is alive, which has its own', async () => {
    const fg = host({ session: SESSION, watching: true });
    const detach = attachForeground(fg.host);

    await runBackgroundPass(jest.fn());
    expect(fg.restoreOthers).not.toHaveBeenCalled();
    expect(fg.checkAll).toHaveBeenCalledTimes(1);
    detach();
  });

  it('neither restores nor looks when notifications are off', async () => {
    const bg = host({ bootsTo: SESSION });

    await runBackgroundPass(() => bg.host);
    expect(bg.restoreOthers).not.toHaveBeenCalled();
    expect(bg.checkAll).not.toHaveBeenCalled();
  });

  it('still looks for new mail when the outbox pass fails, then reports the failure', async () => {
    const fg = host({ session: SESSION, watching: true });
    fg.run.mockRejectedValueOnce(new Error('send failed'));
    const detach = attachForeground(fg.host);

    await expect(runBackgroundPass(jest.fn())).rejects.toThrow('send failed');
    expect(fg.checkAll).toHaveBeenCalledTimes(1);
    detach();
  });

  it('runs on the foreground services when the app is alive, and builds nothing', async () => {
    const fg = host({ session: SESSION });
    const detach = attachForeground(fg.host);
    const build = jest.fn();

    await expect(runBackgroundPass(build)).resolves.toEqual({ status: 'ran', waiting: 0, watching: false });
    expect(fg.run).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
    detach();
  });

  it('does not run a foreground graph that has no session yet', async () => {
    const fg = host({ session: null });
    const detach = attachForeground(fg.host);

    await expect(runBackgroundPass(jest.fn())).resolves.toEqual({ status: 'signed-out' });
    expect(fg.run).not.toHaveBeenCalled();
    detach();
  });

  it('boots only the mailbox in front when headless, and reports what is still waiting', async () => {
    const bg = host({ bootsTo: SESSION });

    await expect(runBackgroundPass(() => bg.host)).resolves.toEqual({ status: 'ran', waiting: 1, watching: false });
    expect(bg.boot).toHaveBeenCalledWith(expect.any(Function), { restoreOthers: false });
    expect(bg.run).toHaveBeenCalledTimes(1);
  });

  it('reports signed-out, without a count, when the headless boot restores nothing', async () => {
    const bg = host({ bootsTo: null });

    const result = await runBackgroundPass(() => bg.host);
    expect(result).toEqual({ status: 'signed-out' });
    expect(bg.run).not.toHaveBeenCalled();
  });

  it('shares one headless pass between overlapping wake-ups', async () => {
    let open!: () => void;
    const bg = host({ bootsTo: SESSION, bootGate: new Promise<void>((r) => (open = r)) });
    const build = jest.fn(() => bg.host);

    const first = runBackgroundPass(build);
    const second = runBackgroundPass(build);
    open();
    await Promise.all([first, second]);

    expect(build).toHaveBeenCalledTimes(1);
    expect(bg.run).toHaveBeenCalledTimes(1);
  });

  it('stops routing to a foreground that detached', async () => {
    const fg = host({ session: SESSION });
    attachForeground(fg.host)();
    const bg = host({ bootsTo: SESSION });

    await runBackgroundPass(() => bg.host);
    expect(fg.run).not.toHaveBeenCalled();
    expect(bg.run).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer foreground attached when a stale one detaches', async () => {
    const old = host({ session: SESSION });
    const current = host({ session: SESSION });
    const detachOld = attachForeground(old.host);
    const detachCurrent = attachForeground(current.host);
    detachOld();

    await runBackgroundPass(jest.fn());
    expect(current.run).toHaveBeenCalledTimes(1);
    expect(old.run).not.toHaveBeenCalled();
    detachCurrent();
  });
});

describe('backgroundIdle', () => {
  it('resolves at once with no pass running', async () => {
    await expect(backgroundIdle()).resolves.toBeUndefined();
  });

  it('waits for a headless pass to finish before the app boots', async () => {
    let open!: () => void;
    const bg = host({ bootsTo: SESSION, bootGate: new Promise<void>((r) => (open = r)) });
    const pass = runBackgroundPass(() => bg.host);

    let idle = false;
    const waiting = backgroundIdle().then(() => (idle = true));
    await Promise.resolve();
    expect(idle).toBe(false);

    open();
    await pass;
    await waiting;
    expect(idle).toBe(true);
    expect(bg.run).toHaveBeenCalledTimes(1);
  });

  it('resolves, rather than rejects, when the pass it waited on failed', async () => {
    const bg = host();
    (bg.boot as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const pass = runBackgroundPass(() => bg.host);

    await expect(backgroundIdle()).resolves.toBeUndefined();
    await expect(pass).rejects.toThrow('offline');
  });
});

describe('runNotificationAction', () => {
  const MARK = { account: 'gmail:me@example.com', messageIds: ['m1', 'm2'], action: 'mark-read' as const };

  it('marks read on the services of an app that is alive', async () => {
    const fg = host({ session: SESSION });
    const detach = attachForeground(fg.host);
    const build = jest.fn();

    await runNotificationAction(MARK, build);
    expect(fg.markRead).toHaveBeenCalledWith(MARK.account, ['m1', 'm2']);
    expect(build).not.toHaveBeenCalled();
    detach();
  });

  it('boots a headless graph when it is not, and app boot waits for it', async () => {
    let open!: () => void;
    const bg = host({ bootsTo: SESSION, bootGate: new Promise<void>((r) => (open = r)) });
    const action = runNotificationAction(MARK, () => bg.host);

    let idle = false;
    const waiting = backgroundIdle().then(() => (idle = true));
    await Promise.resolve();
    expect(idle).toBe(false);

    open();
    await action;
    await waiting;
    expect(bg.boot).toHaveBeenCalledWith(expect.any(Function), { restoreOthers: false });
    expect(bg.markRead).toHaveBeenCalledWith(MARK.account, ['m1', 'm2']);
  });

  it('does nothing headless when no mailbox restores, or for anything but Mark read', async () => {
    const signedOut = host({ bootsTo: null });
    await runNotificationAction(MARK, () => signedOut.host);
    expect(signedOut.markRead).not.toHaveBeenCalled();

    const build = jest.fn();
    await runNotificationAction({ account: MARK.account, messageId: 'm1', action: 'reply' }, build);
    expect(build).not.toHaveBeenCalled();
  });
});
