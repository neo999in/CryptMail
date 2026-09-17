/**
 * The frames of the decrypt reveal — pure, so the text it lands on is testable.
 *
 * A subject arrives as noise and resolves left to right into what was
 * decrypted. The noise is decoration only: it is never derived from the
 * plaintext or the ciphertext, and the last frame is always the target string
 * exactly, so the animation cannot leave anything but the real text on screen.
 */

export const DECRYPT_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&*+/<=>?@^';

/** Share of the run spent fully scrambled before the first character locks in. */
const HOLD = 0.2;

/** How long a reveal of `text` runs: longer for longer text, within bounds. */
export function decryptDuration(text: string): number {
  return Math.min(1100, Math.max(500, Array.from(text).length * 18));
}

/**
 * The string to show at `progress` (0…1) through the reveal.
 *
 * Whitespace is never scrambled, so words keep their shape and the line breaks
 * barely move. Characters are split by code point, so an emoji is one glyph
 * rather than two halves of a surrogate pair.
 */
export function decryptFrame(target: string, progress: number, random: () => number = Math.random): string {
  const chars = Array.from(target);
  if (progress >= 1) return target;
  const p = Math.max(0, (progress - HOLD) / (1 - HOLD));
  const revealed = Math.floor(p * chars.length);
  return chars
    .map((ch, i) =>
      i < revealed || /\s/.test(ch)
        ? ch
        : DECRYPT_GLYPHS[Math.floor(random() * DECRYPT_GLYPHS.length) % DECRYPT_GLYPHS.length],
    )
    .join('');
}
