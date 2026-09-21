import { isLinkSubject, linkBody, linkSubject } from '../bb84';

describe('the emails a quantum link is made of', () => {
  it('numbers the three legs so a person can see where they are', () => {
    expect(linkSubject('photons')).toBe('Setting up a quantum link (1 of 3)');
    expect(linkSubject('measurement')).toBe('Setting up a quantum link (2 of 3)');
    expect(linkSubject('verdict')).toBe('Setting up a quantum link (3 of 3)');
  });

  it('recognises its own subjects and nothing else', () => {
    expect(isLinkSubject(linkSubject('photons'))).toBe(true);
    expect(isLinkSubject('  Setting up a quantum link (2 of 3) ')).toBe(true);
    expect(isLinkSubject('Setting up per-email keys')).toBe(false);
    expect(isLinkSubject('[Encrypted message]')).toBe(false);
    expect(isLinkSubject('')).toBe(false);
  });

  it('says what the message is before the block, in words', () => {
    const body = linkBody('photons', 'alice@example.com', '-----BEGIN CRYPTMAIL QKD PHOTONS-----\nAAA\n-----END CRYPTMAIL QKD PHOTONS-----');
    expect(body).toContain('alice@example.com');
    expect(body).toContain('quantum link');
    expect(body.indexOf('-----BEGIN')).toBeGreaterThan(body.indexOf('alice@example.com'));
    expect(body.trimEnd().endsWith('-----END CRYPTMAIL QKD PHOTONS-----')).toBe(true);
  });

  it('carries nothing but the fixed text and the block', () => {
    // The promise this file exists for: no argument but the sender's own
    // address and the core's armor can reach the wire.
    for (const leg of ['photons', 'measurement', 'verdict'] as const) {
      const body = linkBody(leg, 'alice@example.com', 'BLOCK');
      expect(body.replace('alice@example.com', '').replace('BLOCK', '')).not.toMatch(/[a-z]+@[a-z]/);
      expect(body).toContain('BLOCK');
    }
  });

  it('explains each leg differently, so the three are not one message repeated', () => {
    const bodies = (['photons', 'measurement', 'verdict'] as const).map((l) => linkBody(l, 'a@b.c', 'X'));
    expect(new Set(bodies).size).toBe(3);
  });
});
