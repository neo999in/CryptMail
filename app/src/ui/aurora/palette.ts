/**
 * Turning the chosen aurora palette into what the shader wants.
 *
 * The palettes themselves live in `theme.ts` beside `accents` and `DENSITIES`,
 * because `store/prefsStore` validates the stored id and nothing in `store/`
 * imports from `ui/`. This module is the bridge: the lookup is re-exported from
 * here so the aurora's own code has one import, and `hexToRgb` lives here
 * because nothing outside the band needs it.
 */
export { AURORA_PALETTES, DEFAULT_AURORA_PALETTE, auroraPalette } from '../../theme';
export type { AuroraPalette } from '../../theme';

/** `#RRGGBB` (or `#RGB`) to the 0..1 triple SkSL wants. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (!Number.isFinite(n) || h.length !== 6) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
