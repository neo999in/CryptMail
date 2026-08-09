import { RecipientState } from '../../state/AppState';
import { defaultSendMode, evaluateSendModes, SendModeInput } from '../sendMode';

const rcpt = (email: string, status: RecipientState['status']): RecipientState => ({ email, status });

/** The real core is linked — the configuration that ships. */
const live = (recipients: RecipientState[]): SendModeInput => ({ recipients, cryptoMode: 'real' });

/** Today's configuration: the non-cryptographic stand-in core. */
const demo = (recipients: RecipientState[]): SendModeInput => ({ recipients, cryptoMode: 'demo' });

describe('evaluateSendModes — encrypted', () => {
  it('allows encryption when every recipient has a verified key', () => {
    const { encrypted } = evaluateSendModes(live([rcpt('a@x.com', 'verified')]));
    expect(encrypted.available).toBe(true);
    expect(encrypted.warning).toBeUndefined();
  });

  it('allows encryption but warns when keys are trust-on-first-use', () => {
    const { encrypted } = evaluateSendModes(live([rcpt('a@x.com', 'ok')]));
    expect(encrypted.available).toBe(true);
    expect(encrypted.warning).toMatch(/trusted on first use/i);
  });

  it('distinguishes some-unverified from all-unverified', () => {
    const { encrypted } = evaluateSendModes(live([rcpt('a@x.com', 'ok'), rcpt('b@x.com', 'verified')]));
    expect(encrypted.warning).toMatch(/^Some recipient keys/);
  });

  it('queues rather than blocks when a recipient has no key — and says so', () => {
    const { encrypted } = evaluateSendModes(live([rcpt('a@x.com', 'verified'), rcpt('nokey@x.com', 'missing')]));
    expect(encrypted.available).toBe(true);
    expect(encrypted.queued).toBe(true);
    expect(encrypted.pending).toEqual(['nokey@x.com']);
    expect(encrypted.warning).toContain('nokey@x.com');
    // The one thing it must never imply is that the message has gone.
    expect(encrypted.warning).toMatch(/not delivered/i);
  });

  it('lists every recipient that is missing a key', () => {
    const { encrypted } = evaluateSendModes(live([rcpt('one@x.com', 'missing'), rcpt('two@x.com', 'missing')]));
    expect(encrypted.pending).toEqual(['one@x.com', 'two@x.com']);
    expect(encrypted.warning).toContain('one@x.com');
    expect(encrypted.warning).toContain('two@x.com');
  });

  it('blocks encryption when a key changed fingerprint — never a warning', () => {
    const { encrypted } = evaluateSendModes(live([rcpt('mitm@x.com', 'changed')]));
    expect(encrypted.available).toBe(false);
    expect(encrypted.queued).toBeFalsy();
    expect(encrypted.blockedReason).toMatch(/changed fingerprint/i);
  });

  it('blocks on a changed key even when another recipient is merely missing one', () => {
    // The two are not comparable: a missing key is something to wait for, a
    // changed one is a possible key substitution. Waiting never resolves it, so
    // the changed key decides the outcome for the whole message.
    const { encrypted } = evaluateSendModes(live([rcpt('gone@x.com', 'missing'), rcpt('mitm@x.com', 'changed')]));
    expect(encrypted.available).toBe(false);
    expect(encrypted.queued).toBeFalsy();
    expect(encrypted.blockedReason).toContain('mitm@x.com');
  });

  it('blocks encryption with no recipients', () => {
    const { encrypted } = evaluateSendModes(live([]));
    expect(encrypted.available).toBe(false);
    expect(encrypted.blockedReason).toMatch(/recipient/i);
  });

  it('stays usable in demo mode but says the bytes are only encoded', () => {
    const { encrypted } = evaluateSendModes(demo([rcpt('a@x.com', 'ok')]));
    expect(encrypted.available).toBe(true);
    expect(encrypted.warning).toMatch(/encoded, not encrypted/i);
  });

  it('reports the queue and the demo core together — neither hides the other', () => {
    const { encrypted } = evaluateSendModes(demo([rcpt('nokey@x.com', 'missing')]));
    expect(encrypted.queued).toBe(true);
    expect(encrypted.warning).toContain('nokey@x.com');
    expect(encrypted.warning).toMatch(/encoded, not encrypted/i);
  });
});

describe('evaluateSendModes — plain', () => {
  it('is available with a recipient, and always warns', () => {
    const { plain } = evaluateSendModes(live([rcpt('a@x.com', 'missing')]));
    expect(plain.available).toBe(true);
    expect(plain.warning).toMatch(/not encrypted/i);
  });

  it('needs a recipient like any other send', () => {
    expect(evaluateSendModes(live([])).plain.available).toBe(false);
  });

  it('does not depend on keys — a verified recipient can still be mailed in the clear', () => {
    expect(evaluateSendModes(live([rcpt('a@x.com', 'verified')])).plain.available).toBe(true);
  });
});

describe('defaultSendMode', () => {
  it('prefers encrypted whenever it is usable', () => {
    expect(defaultSendMode(evaluateSendModes(live([rcpt('a@x.com', 'verified')])))).toBe('encrypted');
  });

  it('stays on encrypted for a queued message — waiting is not a reason to downgrade', () => {
    expect(defaultSendMode(evaluateSendModes(live([rcpt('nokey@x.com', 'missing')])))).toBe('encrypted');
  });

  it('never falls back to plain when encryption is blocked — the user must choose', () => {
    const modes = evaluateSendModes(live([rcpt('mitm@x.com', 'changed')]));
    expect(modes.plain.available).toBe(true);
    expect(defaultSendMode(modes)).toBeNull();
  });
});
