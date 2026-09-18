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
import { attachForeground, backgroundIdle, runBackgroundPass, SchedulerHost } from '../pass';

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

function host(opts: { session?: Session | null; bootsTo?: Session | null; bootGate?: Promise<void> } = {}) {
  const store = createStore({ ...initialState(), session: opts.session ?? null }, () => {});
  const run = jest.fn(async () => {});
  const boot = jest.fn(async () => {
    await opts.bootGate;
    if (opts.bootsTo !== undefined) store.patch({ session: opts.bootsTo, scheduled: { 'sch-1': queued } });
  });
  const services = { scheduler: { run }, session: { boot } } as unknown as Services;
  return { host: { store, services } as SchedulerHost, run, boot };
}

describe('runBackgroundPass', () => {
  it('runs on the foreground services when the app is alive, and builds nothing', async () => {
    const fg = host({ session: SESSION });
    const detach = attachForeground(fg.host);
    const build = jest.fn();

    await expect(runBackgroundPass(build)).resolves.toEqual({ status: 'ran', waiting: 0 });
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

    await expect(runBackgroundPass(() => bg.host)).resolves.toEqual({ status: 'ran', waiting: 1 });
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
