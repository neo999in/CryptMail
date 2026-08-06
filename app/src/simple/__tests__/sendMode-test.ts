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

  it('blocks encryption and names the recipient when a key is missing', () => {
    const { encrypted } = evaluateSendModes(live([rcpt('a@x.com', 'verified'), rcpt('nokey@x.com', 'missing')]));
    expect(encrypted.available).toBe(false);
    expect(encrypted.blockedReason).toContain('nokey@x.com');
  });

  it('lists every recipient that is missing a key', () => {
    const { encrypted } = evaluateSendModes(live([rcpt('one@x.com', 'missing'), rcpt('two@x.com', 'missing')]));
    expect(encrypted.blockedReason).toContain('one@x.com');
    expect(encrypted.blockedReason).toContain('two@x.com');
  });

  it('blocks encryption when a key changed fingerprint — never a warning', () => {
    const { encrypted } = evaluateSendModes(live([rcpt('mitm@x.com', 'changed')]));
    expect(encrypted.available).toBe(false);
    expect(encrypted.blockedReason).toMatch(/changed fingerprint/i);
  });

  it('reports a missing key before a changed one when both are present', () => {
    const { encrypted } = evaluateSendModes(live([rcpt('gone@x.com', 'missing'), rcpt('mitm@x.com', 'changed')]));
    expect(encrypted.blockedReason).toContain('gone@x.com');
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

  it('checks recipient keys before the core gate, so the actionable error wins', () => {
    const { encrypted } = evaluateSendModes(demo([rcpt('nokey@x.com', 'missing')]));
    expect(encrypted.blockedReason).toContain('nokey@x.com');
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

  it('never falls back to plain when encryption is blocked — the user must choose', () => {
    const modes = evaluateSendModes(live([rcpt('nokey@x.com', 'missing')]));
    expect(modes.plain.available).toBe(true);
    expect(defaultSendMode(modes)).toBeNull();
  });
});
