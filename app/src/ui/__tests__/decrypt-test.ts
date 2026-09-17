import { DECRYPT_GLYPHS, decryptDuration, decryptFrame } from '../decrypt';

describe('decryptFrame', () => {
  const subject = 'Quarterly plan 🔒 v2';

  it('lands on the target exactly', () => {
    expect(decryptFrame(subject, 1)).toBe(subject);
    expect(decryptFrame(subject, 1.5)).toBe(subject);
  });

  it('starts fully scrambled, keeping whitespace in place', () => {
    const frame = Array.from(decryptFrame(subject, 0, () => 0));
    const target = Array.from(subject);
    expect(frame).toHaveLength(target.length);
    frame.forEach((ch, i) => {
      if (/\s/.test(target[i])) expect(ch).toBe(target[i]);
      else expect(ch).toBe(DECRYPT_GLYPHS[0]);
    });
  });

  it('reveals from the start as progress advances', () => {
    const half = Array.from(decryptFrame('abcdefghij', 0.62, () => 0.999));
    expect(half.slice(0, 5).join('')).toBe('abcde');
    expect(half.slice(5).every((ch) => ch === DECRYPT_GLYPHS[DECRYPT_GLYPHS.length - 1])).toBe(true);
  });

  it('never indexes past the glyph set', () => {
    expect(decryptFrame('ab', 0, () => 1)).toBe(DECRYPT_GLYPHS[0].repeat(2));
  });
});

describe('decryptDuration', () => {
  it('stays within bounds', () => {
    expect(decryptDuration('')).toBe(500);
    expect(decryptDuration('x'.repeat(500))).toBe(1100);
  });
});
