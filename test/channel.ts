// Acoustic channel simulator for offline modem testing.

import type { DemodEvent, Frame, Modem } from '../src/modem/types.ts';

export interface Echo {
  delay: number;
  gain: number;
}

export interface ChannelOptions {
  rxRate?: number;
  /** Receiver clock error relative to the transmitter, in parts per million. */
  clockPpm?: number;
  gain?: number;
  /** White noise power relative to the signal power, in dB. Omit for a noiseless channel. */
  snrDb?: number;
  echoes?: Echo[];
  leadSeconds?: number;
  tailSeconds?: number;
  seed?: number;
  /** Second-order corners modelling a small speaker / microphone response, in Hz. */
  highpassHz?: number;
  lowpassHz?: number;
  /** Silenced spans, in seconds from the start of the signal (e.g. a hand over the mic). */
  dropouts?: { start: number; duration: number }[];
  /** Speech-like babble or music-like chords, relative to the signal power in dB. */
  interference?: { kind: 'speech' | 'music'; levelDb: number };
}

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** A sparse room impulse response: early reflections decaying with the given RT60. */
export function room(seed: number, rt60 = 0.3, count = 12): Echo[] {
  const rand = rng(seed);
  return Array.from({ length: count }, () => {
    const delay = 0.002 + rand() * 0.08;
    return { delay, gain: (rand() < 0.5 ? -0.5 : 0.5) * Math.exp((-6.9 * delay) / rt60) };
  });
}

function resample(x: Float32Array, ratio: number): Float32Array {
  // ratio = output rate / input rate; windowed-sinc, 32 taps.
  const half = 16;
  const cutoff = Math.min(1, ratio);
  const out = new Float32Array(Math.floor(x.length * ratio));
  for (let m = 0; m < out.length; m++) {
    const pos = m / ratio;
    const i0 = Math.floor(pos);
    let acc = 0;
    for (let k = i0 - half + 1; k <= i0 + half; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = pos - k;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / half);
      const a = Math.PI * d * cutoff;
      acc += x[k] * w * cutoff * (a === 0 ? 1 : Math.sin(a) / a);
    }
    out[m] = acc;
  }
  return out;
}

/** RBJ biquad, applied in place. */
function biquad(x: Float32Array, rate: number, type: 'lowpass' | 'highpass', f0: number, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f0) / rate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const [b0, b1, b2] = type === 'lowpass' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < x.length; n++) {
    const y = (b0 * x[n] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[n];
    y2 = y1;
    y1 = y;
    x[n] = y;
  }
}

function interferer(kind: 'speech' | 'music', length: number, rate: number, seed: number): Float32Array {
  const rand = rng(seed * 7919 + 13);
  const out = new Float32Array(length);
  if (kind === 'speech') {
    // Band-limited noise with a ~4 Hz syllable envelope and occasional pauses.
    for (let n = 0; n < length; n++) out[n] = rand() * 2 - 1;
    biquad(out, rate, 'highpass', 300);
    biquad(out, rate, 'lowpass', 3400);
    let gate = 1;
    for (let n = 0; n < length; n++) {
      if (n % Math.round(rate * 0.25) === 0) gate = rand() < 0.2 ? 0 : 1;
      const syllable = Math.sin((2 * Math.PI * 4 * n) / rate);
      out[n] *= gate * syllable * syllable;
    }
  } else {
    // Chords of harmonic tones, changing every half second.
    const roots = [220, 247, 262, 294, 330, 349, 392];
    let notes: number[] = [];
    for (let n = 0; n < length; n++) {
      if (n % Math.round(rate * 0.5) === 0) {
        const r = roots[Math.floor(rand() * roots.length)];
        notes = [r, r * 1.26, r * 1.5];
      }
      let v = 0;
      for (const f of notes) for (let k = 1; k <= 8; k++) v += Math.sin((2 * Math.PI * f * k * n) / rate) / k;
      out[n] = v;
    }
  }
  return out;
}

export function channel(signal: Float32Array, txRate: number, o: ChannelOptions = {}): Float32Array {
  const rxRate = o.rxRate ?? txRate;
  let x = signal;

  if (o.echoes?.length) {
    const maxDelay = Math.max(...o.echoes.map((e) => e.delay));
    const y = new Float32Array(x.length + Math.ceil(maxDelay * txRate));
    y.set(x);
    for (const e of o.echoes) {
      const d = Math.round(e.delay * txRate);
      for (let n = 0; n < x.length; n++) y[n + d] += e.gain * x[n];
    }
    x = y;
  }

  const ratio = (rxRate / txRate) * (1 + (o.clockPpm ?? 0) * 1e-6);
  if (ratio !== 1) x = resample(x, ratio);
  if (o.highpassHz || o.lowpassHz) {
    x = x.slice();
    if (o.highpassHz) biquad(x, rxRate, 'highpass', o.highpassHz);
    if (o.lowpassHz) biquad(x, rxRate, 'lowpass', o.lowpassHz);
  }
  for (const d of o.dropouts ?? []) {
    x.fill(0, Math.round(d.start * rxRate), Math.round((d.start + d.duration) * rxRate));
  }

  const gain = o.gain ?? 0.05;
  const lead = Math.round((o.leadSeconds ?? 0.3) * rxRate);
  const out = new Float32Array(lead + x.length + Math.round((o.tailSeconds ?? 0.3) * rxRate));
  let power = 0;
  let active = 0;
  for (let n = 0; n < x.length; n++) {
    const v = x[n] * gain;
    out[lead + n] = v;
    if (Math.abs(v) > 1e-6) {
      power += v * v;
      active++;
    }
  }

  const signalPower = power / Math.max(1, active);
  if (o.interference) {
    const i = interferer(o.interference.kind, out.length, rxRate, o.seed ?? 1);
    let p = 0;
    for (const v of i) p += v * v;
    const scale = Math.sqrt((signalPower * 10 ** (o.interference.levelDb / 10)) / (p / i.length));
    for (let n = 0; n < out.length; n++) out[n] += i[n] * scale;
  }

  if (o.snrDb !== undefined) {
    const rand = rng(o.seed ?? 1);
    const sigma = Math.sqrt(signalPower / 10 ** (o.snrDb / 10));
    for (let n = 0; n < out.length; n++) {
      const u = Math.max(rand(), 1e-12);
      out[n] += sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    }
  }
  return out;
}

/** Feed audio through a fresh demodulator in worklet-sized chunks. */
export function receive(modem: Modem, audio: Float32Array, rxRate: number, chunk = 2048): DemodEvent[] {
  const demod = modem.createDemodulator(rxRate);
  const events: DemodEvent[] = [];
  for (let i = 0; i < audio.length; i += chunk) events.push(...demod.process(audio.subarray(i, i + chunk)));
  return events;
}

export function roundTrip(modem: Modem, frame: Frame, txRate: number, o: ChannelOptions = {}) {
  const audio = channel(modem.modulate(frame, txRate), txRate, o);
  const events = receive(modem, audio, o.rxRate ?? txRate);
  const frames = events.flatMap((e) => (e.kind === 'frame' ? [e] : []));
  return { events, frames };
}
