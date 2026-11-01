// Signal helpers for the explainer: the first version's character map and a
// small FFT, so the diagrams compute what they show instead of faking it.

/** Version 1 timing and markers (from the original character-tone codec). */
export const V1 = {
  toneSeconds: 0.07,
  gapSeconds: 0.03,
  markerSeconds: 0.12,
  start: 2500,
  end: 2700,
  /** A detected pitch within this distance of a character's pitch counts as that character. */
  tolerance: 45,
  /** The same character heard again within this window was treated as the same tone. */
  lockoutMs: 120,
};

const run = (chars: string, from: number) => Array.from(chars, (c, i) => [c, from + i * 100] as const);

/** Version 1's map: every supported character had its own pitch, 100 Hz apart. */
export const V1_FREQUENCIES: ReadonlyMap<string, number> = new Map([
  [' ', 900],
  ...run('!@#$%^&*()-_', 1300),
  ['+', 2600],
  ['=', 2800],
  ...run('{}[]|\\:;"\'<>,.?/`~', 2900),
  ...run('0123456789', 4700),
  ...run('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 5700),
]);

export function v1CharAt(frequency: number): string | null {
  for (const [c, f] of V1_FREQUENCIES) if (Math.abs(f - frequency) < V1.tolerance) return c;
  return null;
}

export const SAMPLE_RATE = 48000;
export const FFT_SIZE = 2048;
export const BIN_HZ = SAMPLE_RATE / FFT_SIZE;

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(step * k);
        const wi = Math.sin(step * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** Deterministic pseudo-random numbers, so a given seed always draws the same noise. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** One FFT window of microphone input: a tone plus white noise of the given strength. */
export function captureWindow(frequency: number | null, noise: number, seed: number): Float64Array {
  const r = rng(seed);
  const x = new Float64Array(FFT_SIZE);
  const phase = r() * 2 * Math.PI;
  for (let n = 0; n < FFT_SIZE; n++) {
    // Box–Muller: Gaussian noise sounds like hiss.
    const g = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
    x[n] = (frequency ? Math.sin((2 * Math.PI * frequency * n) / SAMPLE_RATE + phase) : 0) + noise * g;
  }
  return x;
}

/** Magnitude of every FFT bin below `maxHz`, normalised so a clean full-scale tone peaks near 1. */
export function spectrum(x: Float64Array, maxHz: number): Float32Array {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  // Hann window, as an analyser would apply, so energy stays in its bin.
  for (let n = 0; n < FFT_SIZE; n++) re[n] = x[n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (FFT_SIZE - 1)));
  fft(re, im);
  const bins = Math.min(FFT_SIZE / 2, Math.ceil(maxHz / BIN_HZ));
  const out = new Float32Array(bins);
  for (let k = 0; k < bins; k++) out[k] = Math.hypot(re[k], im[k]) / (FFT_SIZE / 4);
  return out;
}

/** Version 1's receiver: the loudest bin above 400 Hz is the pitch being sent. */
export function loudestHz(spec: Float32Array): number {
  let best = Math.ceil(400 / BIN_HZ);
  for (let k = best; k < spec.length; k++) if (spec[k] > spec[best]) best = k;
  return best * BIN_HZ;
}
