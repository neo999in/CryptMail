/**
 * Safety numbers (docs/key-management.md, "Verified").
 *
 * The load-bearing property is symmetry: if the two devices derive different
 * numbers, two honest people comparing them conclude they are under attack.
 */
import {
  formatFingerprint,
  normaliseFingerprint,
  safetyNumber,
  safetyNumberMatches,
} from '../safetyNumber';

const ALICE = '4F2A9C71E3081BD577A03E6CB2940F8AD5C36A1982EF4471';
const BOB = '91C4D0A7761E5B3388F2C40D1A9E7735E60B84C2DD173F56';
const CAROL = '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF';

describe('normalising a fingerprint', () => {
  it('strips spacing, casing and an 0x prefix', () => {
    expect(normaliseFingerprint('0x4f2a 9c71 e308')).toBe('4F2A9C71E308');
  });

  it('groups for reading aloud', () => {
    expect(formatFingerprint('4F2A9C71E308')).toBe('4F2A 9C71 E308');
  });
});

describe('deriving a safety number', () => {
  it('is the same number whichever side derives it', async () => {
    // If this fails, both people see different digits and abort a legitimate
    // verification — the failure mode that makes the feature useless.
    expect(await safetyNumber(ALICE, BOB)).toBe(await safetyNumber(BOB, ALICE));
  });

  it('ignores formatting differences between the two devices', async () => {
    const spaced = ALICE.toLowerCase().replace(/(.{4})/g, '$1 ').trim();
    expect(await safetyNumber(spaced, BOB)).toBe(await safetyNumber(`0x${ALICE}`, BOB));
  });

  it('differs for a different contact', async () => {
    expect(await safetyNumber(ALICE, BOB)).not.toBe(await safetyNumber(ALICE, CAROL));
  });

  it('is stable across calls', async () => {
    expect(await safetyNumber(ALICE, BOB)).toBe(await safetyNumber(ALICE, BOB));
  });

  it('is 30 digits in six groups of five', async () => {
    const number = await safetyNumber(ALICE, BOB);
    expect(number).toMatch(/^(\d{5} ){5}\d{5}$/);
  });

  it('refuses anything that is not a real fingerprint', async () => {
    // Junk still hashes to six confident-looking groups of digits, which the
    // user would compare, match, and treat as a verification.
    await expect(safetyNumber('', BOB)).rejects.toThrow();
    await expect(safetyNumber(ALICE, 'not-hex')).rejects.toThrow();
    await expect(safetyNumber(ALICE, '4F2A9C71')).rejects.toThrow();
  });
});

describe('comparing what the user entered', () => {
  it('accepts a match regardless of spacing', () => {
    expect(safetyNumberMatches('12345 67890', '1234567890')).toBe(true);
  });

  it('rejects a mismatch', () => {
    expect(safetyNumberMatches('12345 67890', '12345 67891')).toBe(false);
  });

  it('never treats empty as a match', () => {
    expect(safetyNumberMatches('', '')).toBe(false);
  });
});
