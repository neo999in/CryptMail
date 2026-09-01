import { AURORA_PALETTES, DEFAULT_AURORA_PALETTE, auroraPalette, hexToRgb } from '../palette';

describe('hexToRgb', () => {
  it('converts a 6-digit hex to a 0..1 triple', () => {
    expect(hexToRgb('#44DCEA')).toEqual([0x44 / 255, 0xdc / 255, 0xea / 255]);
  });

  it('accepts a shorthand hex', () => {
    expect(hexToRgb('#fff')).toEqual([1, 1, 1]);
  });

  it('accepts a hex without the hash', () => {
    expect(hexToRgb('000000')).toEqual([0, 0, 0]);
  });

  // The shader multiplies these straight into a colour, so a bad value has to
  // land somewhere harmless rather than as NaN across the whole band.
  it('falls back to black on anything unparseable', () => {
    expect(hexToRgb('not a colour')).toEqual([0, 0, 0]);
    expect(hexToRgb('#12')).toEqual([0, 0, 0]);
  });
});

describe('auroraPalette', () => {
  it('looks a palette up by id', () => {
    expect(auroraPalette('violet').name).toBe('Cosmic Violet');
  });

  // The id comes off disk and in through a prop, so an unknown one must render
  // the band rather than throw or paint it black.
  it('falls back to the default for an unknown or missing id', () => {
    expect(auroraPalette('nonsense')).toBe(DEFAULT_AURORA_PALETTE);
    expect(auroraPalette(undefined)).toBe(DEFAULT_AURORA_PALETTE);
  });

  it('defaults to the reference Borealis Cyan', () => {
    expect(DEFAULT_AURORA_PALETTE.id).toBe('borealis');
    expect(DEFAULT_AURORA_PALETTE.auroraColors).toEqual(['#44DCEA', '#968CFF', '#4ADE80']);
    expect(DEFAULT_AURORA_PALETTE.skyColors).toEqual(['#090B14', '#000000']);
  });
});

describe('the ported palettes', () => {
  it('carries all five of the reference’s, in its order', () => {
    expect(AURORA_PALETTES.map((p) => p.name)).toEqual([
      'Borealis Cyan',
      'Emerald Forest',
      'Cosmic Violet',
      'Solar Horizon',
      'Arctic Glow',
    ]);
  });

  it.each(AURORA_PALETTES)('$id is shaped the way the shader expects', (p) => {
    expect(p.auroraColors).toHaveLength(3);
    expect(p.skyColors).toHaveLength(2);
    for (const hex of [...p.auroraColors, ...p.skyColors, p.accent]) {
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  // Whichever palette is chosen, the band still has to meet the app's ground
  // cleanly — this is the property that keeps it AMOLED-safe, so it is asserted
  // for every palette rather than assumed of new ones.
  it.each(AURORA_PALETTES)('$id falls to true black', (p) => {
    expect(p.skyColors[1]).toBe('#000000');
  });

  it('has no duplicate ids for the store to resolve ambiguously', () => {
    const ids = AURORA_PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
