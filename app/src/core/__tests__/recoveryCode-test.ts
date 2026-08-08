/**
 * The recovery code is the one secret that makes a round trip through paper and
 * a human's handwriting, so these tests are mostly about transcription: what a
 * user types back has to open the backup even when it does not match what was
 * displayed character for character.
 */
import {
  CODE_LENGTH,
  formatRecoveryCode,
  generateRecoveryCode,
  isValidRecoveryCode,
  normaliseRecoveryCode,
} from '../recoveryCode';

describe('recovery code', () => {
  it('generates a grouped code of the documented length', () => {
    const code = generateRecoveryCode();

    expect(normaliseRecoveryCode(code)).toHaveLength(CODE_LENGTH);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
  });

  /**
   * 20 bytes of entropy divides evenly into 5-bit groups. If someone changes
   * ENTROPY_BYTES to a value that does not, the encoder silently drops the
   * remainder rather than padding — this is what would catch that.
   */
  it('encodes the full entropy with nothing left over', () => {
    expect(CODE_LENGTH).toBe(32);
    expect(normaliseRecoveryCode(generateRecoveryCode())).toHaveLength(32);
  });

  it('never emits the characters that were excluded to stop misreadings', () => {
    // 40 codes ≈ 1280 characters; an alphabet leak would show up long before this.
    const all = Array.from({ length: 40 }, generateRecoveryCode).join('');
    expect(all).not.toMatch(/[ILOU]/);
  });

  it('does not repeat itself', () => {
    const codes = new Set(Array.from({ length: 20 }, generateRecoveryCode));
    expect(codes.size).toBe(20);
  });

  describe('normalisation', () => {
    /**
     * The whole reason for Crockford's alphabet. Someone reading their own
     * handwriting types O for 0 and I for 1; treating that as a wrong code
     * would be an alarming lie when the key is in fact correct.
     */
    it('folds the confusable characters instead of rejecting them', () => {
      expect(normaliseRecoveryCode('OIL')).toBe('011');
      expect(normaliseRecoveryCode('oil')).toBe('011');
    });

    it('accepts any spacing, casing or separator', () => {
      const spaced = 'k7m2 nq8z r4j5 twxb 3hyp d6c9 fgkm 2n8q';
      const dashed = 'K7M2-NQ8Z-R4J5-TWXB-3HYP-D6C9-FGKM-2N8Q';

      expect(normaliseRecoveryCode(spaced)).toBe(normaliseRecoveryCode(dashed));
      expect(normaliseRecoveryCode(`  ${dashed}\n`)).toBe(normaliseRecoveryCode(dashed));
    });

    it('regroups a code however it was typed back', () => {
      const code = generateRecoveryCode();

      expect(formatRecoveryCode(code.replace(/-/g, ''))).toBe(code);
      expect(formatRecoveryCode(code.toLowerCase())).toBe(code);
      // Idempotent — re-formatting an already grouped code must not double up.
      expect(formatRecoveryCode(code)).toBe(code);
    });
  });

  describe('validity', () => {
    it('accepts a generated code however it is presented', () => {
      const code = generateRecoveryCode();

      expect(isValidRecoveryCode(code)).toBe(true);
      expect(isValidRecoveryCode(code.replace(/-/g, ' ').toLowerCase())).toBe(true);
    });

    it('rejects anything of the wrong length', () => {
      expect(isValidRecoveryCode('')).toBe(false);
      expect(isValidRecoveryCode('K7M2-NQ8Z')).toBe(false);
      expect(isValidRecoveryCode(generateRecoveryCode() + 'A')).toBe(false);
    });

    /** Length is all this can prove — it is a shape check, not authentication. */
    it('does not claim to know whether the code is correct', () => {
      expect(isValidRecoveryCode('0'.repeat(CODE_LENGTH))).toBe(true);
    });
  });
});
