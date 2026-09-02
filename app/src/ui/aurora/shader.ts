/**
 * The aurora fragment shader (SkSL), from the `reacticx-aurora` component.
 *
 * Unchanged from upstream except for the notes here — the maths is theirs. What
 * matters for how it is driven from `index.tsx`:
 *
 * Every coefficient on `t` in this file is a multiple of 0.1 — 0.3, 0.5, 0.7,
 * 0.8, 0.9, 1.2, 2.1. So every term repeats exactly when `t` advances by 20π
 * (each `k·t` then advances by 2π·10k, and 10k is a whole number for all of
 * them). That makes 20π a *seamless* loop, which is what lets the driver be a
 * single `withRepeat(withTiming(...))` on the UI thread instead of a per-frame
 * callback accumulating unbounded time. Change a coefficient to something that
 * is not a multiple of 0.1 and the wrap becomes a visible jump.
 */
export const AURORA_SHADER_SKSL = `
uniform float2 resolution;
uniform float  time;
uniform float3 color1;
uniform float3 color2;
uniform float3 color3;
uniform float3 skyTop;
uniform float3 skyBottom;
uniform float  speed;
uniform float  intensity;
uniform float2 waveDirection;

// Precision-safe hash. The reference used fract(sin(dot(p, k)) * 43758.5),
// which is the canonical GPU hash and is broken on real hardware here.
//
// By the second fbm octave p has been doubled and shifted to roughly 100-200,
// so dot(p, (127.1, 311.7)) reaches ~87000. sin() of that leaves almost no
// mantissa left for the fractional part, so the hash collapses into large flat
// plateaus with hard edges between them - visible as seams across the band.
// It survives on a desktop GPU (and therefore on the emulator, which uses one)
// and fails on a phone, which is the worst way for a bug like this to behave.
//
// This is Hoskins' hash12: every value is folded into [0,1) by the first fract
// and stays there, so there is no large argument to lose precision on and no
// sin() at all. Cheaper too.
float hash(float2 p) {
  float3 p3 = fract(float3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);

  float a = hash(i + float2(0.0, 0.0));
  float b = hash(i + float2(1.0, 0.0));
  float c = hash(i + float2(0.0, 1.0));
  float d = hash(i + float2(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Two octaves, not the reference's three.
//
// Each octave is four hashes — four 'sin' — per pixel, so the third cost 4 of
// the shader's ~20 transcendentals and contributed at amplitude 0.125, the
// finest detail in a band a few hundred pixels tall. It is the cheapest real
// saving available here.
//
// What is deliberately *not* done: replacing the noise with a product of sines.
// That is much cheaper again and looks wrong — a periodic ray field puts all
// its energy at one frequency and reads as evenly spaced vertical bars. Two
// octaves of value noise still has no spectral peak, which is the property that
// makes the rays look like light instead of a barcode.
//
// The 1.0 / 0.75 restores the amplitude the dropped octave was contributing, so
// the ray contrast matches the three-octave version.
float fbm(float2 p) {
  float v = 0.0;
  float a = 0.5;
  float2 shift = float2(100.0);
  float2x2 rot = float2x2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
  for (int i = 0; i < 2; ++i) {
    v += a * noise(p);
    p = rot * p * 2.0 + shift;
    a *= 0.5;
  }
  return v * 1.3333333;
}

half4 main(float2 fragCoord) {
  float2 uv = fragCoord / resolution;
  float t = time * speed;

  // Sky background vertical gradient
  float3 sky = mix(skyTop, skyBottom, clamp(uv.y * 1.5, 0.0, 1.0));

  // Directional wave coordinate. 'waveDirection' arrives already normalised —
  // it depends only on a uniform, so normalising here would be the same answer
  // recomputed once per fragment.
  float flowCoord = dot(uv, waveDirection) * 4.0 + t * 0.8;

  // Multi-layered organic aurora ribbons
  float wave1 = sin(uv.x * 6.28318 + t * 1.2 + sin(uv.y * 5.0 + t * 0.7));
  float wave2 = cos(uv.x * 4.5 - t * 0.9 + cos(uv.y * 4.0 + t * 0.5));
  float wave3 = sin(flowCoord + wave1 * 0.4);

  // Vertical light rays & ray striations
  float rayField = fbm(float2(uv.x * 12.0 + t * 0.3, uv.y * 2.0));
  float rays = pow(0.5 + 0.5 * sin(uv.x * 24.0 + wave1 * 1.5 + rayField * 2.0), 2.5);

  // Elevation curtain envelope: starts at top and softly drapes down
  float curtainEnvelope = exp(-pow(max(0.0, uv.y - 0.22 - (wave1 * 0.12 + wave2 * 0.08)) * 3.2, 2.0));
  curtainEnvelope *= smoothstep(-0.1, 0.15, uv.y);

  // Aurora intensity mask
  float auroraField = (curtainEnvelope * 0.7 + rays * curtainEnvelope * 0.5) * intensity;
  auroraField = clamp(auroraField, 0.0, 1.5);

  // Color blending across wave dynamics
  float colorMix1 = clamp(0.5 + 0.5 * wave1 + wave3 * 0.25, 0.0, 1.0);
  float colorMix2 = clamp(0.5 + 0.5 * wave2 + rays * 0.3, 0.0, 1.0);

  float3 auroraCol = mix(color1, color2, colorMix1);
  auroraCol = mix(auroraCol, color3, colorMix2);

  // Blend aurora over celestial sky
  float3 finalCol = mix(sky, auroraCol, clamp(auroraField, 0.0, 1.0));
  // Additive luminance bloom
  finalCol += auroraCol * pow(clamp(auroraField, 0.0, 1.0), 2.5) * 0.45;

  // Dither, at roughly half a step of an 8-bit channel.
  //
  // The band is a wide, very gradual gradient at low alpha, which is the exact
  // shape that quantises into visible contour bands on a phone panel - the
  // reference has no dithering because it was tuned on a desktop display. The
  // noise is broken across 2-pixel cells rather than 1 so it survives being
  // viewed below native resolution, and is far too small to read as grain.
  finalCol += (hash(floor(fragCoord * 0.5)) - 0.5) * (1.5 / 255.0);

  return half4(clamp(finalCol, 0.0, 1.0), 1.0);
}
`;

/**
 * One seamless cycle of `t`, in shader units. See the note above.
 */
export const AURORA_LOOP = 20 * Math.PI;
