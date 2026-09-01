import { AURORA_LOOP, AURORA_SHADER_SKSL } from '../shader';

/**
 * The band is driven by `withRepeat(withTiming(0 → AURORA_LOOP))` rather than a
 * per-frame callback, which is only seamless because every coefficient on `t`
 * in the shader is a multiple of 0.1 — each term then advances by a whole
 * number of turns over 20π and the wrap is invisible.
 *
 * That is an invariant of the shader *source*, so it is checked against the
 * source. Change a coefficient to something like 1.15 and the band jumps once
 * per loop on a device — exactly the kind of thing nobody catches in a diff.
 */
describe('the aurora shader loops seamlessly', () => {
  /** Every `t * k` / `- t * k` in the shader body. */
  const coefficients = () =>
    [...AURORA_SHADER_SKSL.matchAll(/\bt\s*\*\s*([0-9.]+)/g)].map((m) => Number(m[1]));

  it('finds the time coefficients it is meant to be checking', () => {
    // Guards the regex itself: a rename that made this match nothing would
    // otherwise turn the assertion below into a vacuous pass.
    expect(coefficients().length).toBeGreaterThanOrEqual(6);
  });

  it('advances every term by a whole number of turns over one loop', () => {
    for (const k of coefficients()) {
      const turns = (k * AURORA_LOOP) / (2 * Math.PI);
      expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-9);
    }
  });
});

describe('the aurora shader', () => {
  /** The name of every `uniform <type> <name>;` it declares. */
  const declared = AURORA_SHADER_SKSL.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('uniform '))
    .map((line) => line.replace(';', '').split(/\s+/).pop());

  // `index.tsx` builds this exact object every frame. A uniform renamed on one
  // side and not the other compiles fine and then draws nothing.
  it.each([
    'resolution',
    'time',
    'color1',
    'color2',
    'color3',
    'skyTop',
    'skyBottom',
    'speed',
    'intensity',
    'waveDirection',
  ])('declares the %s uniform the component supplies', (name) => {
    expect(declared).toContain(name);
  });
});
