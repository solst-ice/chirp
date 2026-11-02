// Multi-tone FSK modem.
//
// Every symbol sounds `groups` tones at once; each group picks one of 16 tones,
// so a symbol carries 4 bits per group. Tones of different groups are
// interleaved across the band so a single frequency notch (room mode, speaker
// dip) only hurts one tone value instead of a whole group. With `alternate`,
// even and odd symbols use two interleaved tone sets, so echoes of the previous
// symbol land on tones the receiver is not looking at.
//
// Wire format, in symbols:
//   preamble (8 known symbols) | header (10 bytes) | body (RS blocks, interleaved)
// Header = [version<<4 | profile code, frame type, length hi, length lo] + 6 RS parity.
// Body   = payload + CRC-32, split into equal blocks, each RS-protected, then
//          byte-interleaved across blocks so a burst error is spread out.
//
// The receiver works on raw samples with a sample-count clock: it slides a
// window across the input looking for the preamble pattern, refines the timing,
// then reads each symbol at its known position with a small early/late timing
// tracker to follow clock drift between devices.

import { crc32 } from './crc32.ts';
import { rsDecode, rsEncode } from './reedSolomon.ts';
import type { DemodEvent, Demodulator, Frame, Modem } from './types.ts';

export interface MfskProfile {
  id: string;
  /** 4-bit identifier carried in the header. */
  code: number;
  label: string;
  description: string;
  /** Tones sounding simultaneously (4 bits each). */
  groups: number;
  /** Alternate between two tone sets on even/odd symbols to reject echoes. */
  alternate: boolean;
  baseFrequency: number;
  /** Must be a multiple of 1 / symbolSeconds so tones are orthogonal. */
  toneSpacing: number;
  /** Integration window per symbol. */
  symbolSeconds: number;
  /** Ramp-down/ramp-up time between symbols; also absorbs echoes and timing error. */
  guardSeconds: number;
  /** Reed–Solomon parity bytes per block. */
  parity: number;
  /** Maximum data bytes per Reed–Solomon block. */
  blockData: number;
  maxPayload: number;
  /** Peak output level, 0..1. */
  amplitude: number;
}

const TONES = 16;
export const PREAMBLE = [0, 11, 3, 14, 6, 9, 1, 12];
const VERSION = 1;
const HEADER_DATA = 4;
const HEADER_PARITY = 6;
export const HEADER_BYTES = HEADER_DATA + HEADER_PARITY;
const HEADER_NIBBLES = HEADER_BYTES * 2;
export const CRC_BYTES = 4;
export const LEAD_IN_SECONDS = 0.02;
export const TAIL_SECONDS = 0.02;

// Preamble detection: mean share of energy in the expected tone, and the
// weakest single preamble symbol, both as a fraction of the group's energy.
const SYNC_SCORE = 0.45;
const SYNC_MIN_SYMBOL = 0.2;
const SYNC_SETTLE_HOPS = 3;
const TIMING_GAIN = 0.1;
const RING_SIZE = 1 << 18;

const preambleValue = (symbol: number, group: number) => PREAMBLE[(symbol + 3 * group) % PREAMBLE.length];

interface Layout {
  blocks: number;
  perBlock: number;
  bodyBytes: number;
  symbols: number;
}

function layout(p: MfskProfile, payloadLength: number): Layout {
  const dataLength = payloadLength + CRC_BYTES;
  const blocks = Math.max(1, Math.ceil(dataLength / p.blockData));
  const perBlock = Math.ceil(dataLength / blocks);
  const bodyBytes = blocks * (perBlock + p.parity);
  const symbols = Math.ceil(((HEADER_BYTES + bodyBytes) * 2) / p.groups);
  return { blocks, perBlock, bodyBytes, symbols };
}

/** The bytes a frame puts on the wire after the preamble: header + interleaved RS body. */
export function frameBytes(p: MfskProfile, frame: Frame): Uint8Array {
  const { payload } = frame;
  if (payload.length > p.maxPayload) {
    throw new Error(`Payload of ${payload.length} bytes exceeds ${p.label} limit of ${p.maxPayload}`);
  }
  const l = layout(p, payload.length);
  const header = rsEncode(
    Uint8Array.of((VERSION << 4) | p.code, frame.type, payload.length >> 8, payload.length & 0xff),
    HEADER_PARITY,
  );

  const data = new Uint8Array(l.blocks * l.perBlock);
  data.set(payload);
  new DataView(data.buffer).setUint32(payload.length, crc32(payload));

  const n = l.perBlock + p.parity;
  const out = new Uint8Array(HEADER_BYTES + l.bodyBytes);
  out.set(header);
  for (let b = 0; b < l.blocks; b++) {
    const cw = rsEncode(data.subarray(b * l.perBlock, (b + 1) * l.perBlock), p.parity);
    for (let j = 0; j < n; j++) out[HEADER_BYTES + j * l.blocks + b] = cw[j];
  }
  return out;
}

const toneFrequency = (p: MfskProfile, bin: number) => p.baseFrequency + bin * p.toneSpacing;
const toneSets = (p: MfskProfile) => (p.alternate ? 2 : 1);
const binCount = (p: MfskProfile) => p.groups * TONES * toneSets(p);
/** `symbol` is the absolute symbol index (preamble included); it selects the tone set. */
const binOf = (p: MfskProfile, value: number, group: number, symbol: number) =>
  (value * p.groups + group) * toneSets(p) + (symbol % toneSets(p));
const symbolPeriod = (p: MfskProfile) => p.symbolSeconds + p.guardSeconds;

/** Tone bin for every group of every symbol, preamble included: the full wire format. */
export function frameTones(p: MfskProfile, frame: Frame): number[][] {
  const bytes = frameBytes(p, frame);
  const l = layout(p, frame.payload.length);
  const nibbles: number[] = [];
  for (const b of bytes) nibbles.push(b >> 4, b & 0x0f);
  while (nibbles.length < l.symbols * p.groups) nibbles.push(0);
  const symbols: number[][] = [];
  for (let s = 0; s < PREAMBLE.length + l.symbols; s++) {
    const tones: number[] = [];
    for (let g = 0; g < p.groups; g++) {
      const value = s < PREAMBLE.length ? preambleValue(s, g) : nibbles[(s - PREAMBLE.length) * p.groups + g];
      tones.push(binOf(p, value, g, s));
    }
    symbols.push(tones);
  }
  return symbols;
}

function nibblesToBytes(nibbles: number[], start: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = (nibbles[start + 2 * i] << 4) | nibbles[start + 2 * i + 1];
  return out;
}

/** RS decode, retrying with the least-confident bytes marked as erasures. */
function decodeWithErasures(cw: Uint8Array, nsym: number, confidence: number[]): Uint8Array | null {
  const direct = rsDecode(cw, nsym);
  if (direct) return direct;
  const order = confidence.map((c, i) => [c, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  for (const count of [Math.floor(nsym / 2), nsym - 2]) {
    if (count <= 0) continue;
    const fixed = rsDecode(cw, nsym, order.slice(0, count));
    if (fixed) return fixed;
  }
  return null;
}

export function createMfskModem(p: MfskProfile): Modem {
  const bins = binCount(p);
  const period = symbolPeriod(p);
  return {
    id: p.id,
    label: p.label,
    description: p.description,
    band: [p.baseFrequency, toneFrequency(p, bins - 1)],
    rawBitRate: (4 * p.groups) / period,
    maxPayload: p.maxPayload,
    supports: (sampleRate) => toneFrequency(p, bins) < sampleRate * 0.46,
    airtime: (length) => LEAD_IN_SECONDS + (PREAMBLE.length + layout(p, length).symbols) * period + TAIL_SECONDS,

    modulate(frame, sampleRate) {
      const tones = frameTones(p, frame);
      const totalSymbols = tones.length;
      const out = new Float32Array(Math.ceil((LEAD_IN_SECONDS + totalSymbols * period + TAIL_SECONDS) * sampleRate));
      const ramp = p.guardSeconds / 2;
      const amp = p.amplitude / p.groups;
      const freqs = new Float64Array(p.groups);

      for (let s = 0; s < totalSymbols; s++) {
        for (let g = 0; g < p.groups; g++) freqs[g] = toneFrequency(p, tones[s][g]);
        const t0 = LEAD_IN_SECONDS + s * period;
        const n0 = Math.ceil(t0 * sampleRate);
        const n1 = Math.min(out.length, Math.floor((t0 + period) * sampleRate));
        for (let n = n0; n < n1; n++) {
          const t = n / sampleRate;
          const local = t - t0;
          let env = 1;
          if (local < ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * local) / ramp);
          else if (local > period - ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * (period - local)) / ramp);
          let y = 0;
          // Absolute-time phase keeps each tone phase-continuous; the per-group
          // offset keeps simultaneous tones from peaking together.
          for (let g = 0; g < p.groups; g++) y += Math.sin(2 * Math.PI * freqs[g] * t + g * 1.7);
          out[n] = amp * env * y;
        }
      }
      return out;
    },

    createDemodulator: (sampleRate) => new MfskDemodulator(p, sampleRate),
  };
}

interface HopRecord {
  start: number;
  /** Per-bin energy share within its group. */
  share: Float32Array;
}

interface Lock {
  /** Absolute sample index of preamble symbol 0's integration window. */
  base: number;
  /** Accumulated timing correction in samples. */
  adjust: number;
  symbol: number;
  nibbles: number[];
  confidence: number[];
  marginSum: number;
  marginCount: number;
  header?: { type: number; length: number; layout: Layout; totalSymbols: number };
}

class MfskDemodulator implements Demodulator {
  private readonly p: MfskProfile;
  private readonly bins: number;
  private readonly window: number;
  private readonly period: number;
  private readonly hop: number;
  private readonly trackOffset: number;
  private readonly maxAdjust: number;
  private readonly cos: Float32Array[];
  private readonly sin: Float32Array[];
  private readonly ring = new Float32Array(RING_SIZE);
  private readonly frame: Float32Array;
  private readonly energy: Float32Array;
  private readonly hopOffsets: number[];

  private written = 0;
  private nextHop = 0;
  private hopCount = 0;
  private hops: HopRecord[] = [];
  private candidate: { score: number; start: number; age: number } | null = null;
  private lock: Lock | null = null;

  constructor(p: MfskProfile, sampleRate: number) {
    this.p = p;
    this.bins = binCount(p);
    this.window = Math.round(p.symbolSeconds * sampleRate);
    this.period = symbolPeriod(p) * sampleRate;
    this.hop = Math.max(1, Math.floor(this.window / 4));
    this.trackOffset = Math.max(1, Math.round((p.guardSeconds * sampleRate) / 4));
    this.maxAdjust = (p.guardSeconds * sampleRate) / 2;
    this.frame = new Float32Array(this.window);
    this.energy = new Float32Array(this.bins);
    this.cos = [];
    this.sin = [];
    for (let b = 0; b < this.bins; b++) {
      const w = (2 * Math.PI * toneFrequency(p, b)) / sampleRate;
      const c = new Float32Array(this.window);
      const s = new Float32Array(this.window);
      for (let n = 0; n < this.window; n++) {
        c[n] = Math.cos(w * n);
        s[n] = Math.sin(w * n);
      }
      this.cos.push(c);
      this.sin.push(s);
    }
    this.hopOffsets = PREAMBLE.map((_, i) => Math.round((i * this.period) / this.hop));
  }

  reset() {
    this.written = 0;
    this.nextHop = 0;
    this.resumeSearch(0);
  }

  process(samples: Float32Array): DemodEvent[] {
    const events: DemodEvent[] = [];
    const chunk = RING_SIZE / 4;
    for (let off = 0; off < samples.length; off += chunk) {
      const part = samples.subarray(off, Math.min(samples.length, off + chunk));
      for (let i = 0; i < part.length; i++) this.ring[(this.written + i) & (RING_SIZE - 1)] = part[i];
      this.written += part.length;
      this.run(events);
    }
    return events;
  }

  private run(events: DemodEvent[]) {
    for (;;) {
      if (this.lock) {
        if (!this.stepLocked(events)) return;
      } else if (!this.stepSearch(events)) {
        return;
      }
    }
  }

  private resumeSearch(at: number) {
    this.lock = null;
    this.candidate = null;
    this.hops = [];
    this.hopCount = 0;
    this.nextHop = Math.max(at, this.written - RING_SIZE / 2);
  }

  /** Energy at every tone for the window starting at absolute sample `start`. */
  private measure(start: number): Float32Array {
    const mask = RING_SIZE - 1;
    const f = this.frame;
    for (let n = 0; n < this.window; n++) f[n] = this.ring[(start + n) & mask];
    for (let b = 0; b < this.bins; b++) {
      const c = this.cos[b];
      const s = this.sin[b];
      let re = 0;
      let im = 0;
      for (let n = 0; n < this.window; n++) {
        re += f[n] * c[n];
        im += f[n] * s[n];
      }
      this.energy[b] = re * re + im * im;
    }
    return this.energy;
  }

  private binEnergy(bin: number, start: number): number {
    const mask = RING_SIZE - 1;
    const c = this.cos[bin];
    const s = this.sin[bin];
    let re = 0;
    let im = 0;
    for (let n = 0; n < this.window; n++) {
      const x = this.ring[(start + n) & mask];
      re += x * c[n];
      im += x * s[n];
    }
    return re * re + im * im;
  }

  private stepSearch(events: DemodEvent[]): boolean {
    if (this.nextHop + this.window > this.written) return false;
    const { p } = this;
    const e = this.measure(this.nextHop);
    const share = new Float32Array(this.bins);
    for (let set = 0; set < toneSets(p); set++) {
      for (let g = 0; g < p.groups; g++) {
        let total = 1e-20;
        for (let v = 0; v < TONES; v++) total += e[binOf(p, v, g, set)];
        for (let v = 0; v < TONES; v++) share[binOf(p, v, g, set)] = e[binOf(p, v, g, set)] / total;
      }
    }
    this.hops[this.hopCount % 128] = { start: this.nextHop, share };
    this.hopCount++;
    this.nextHop += this.hop;

    const span = this.hopOffsets[this.hopOffsets.length - 1];
    const first = this.hopCount - 1 - span;
    if (first < 0) return true;

    let sum = 0;
    let weakest = 1;
    for (let s = 0; s < PREAMBLE.length; s++) {
      const rec = this.hops[(first + this.hopOffsets[s]) % 128];
      let symbolShare = 0;
      for (let g = 0; g < p.groups; g++) symbolShare += rec.share[binOf(p, preambleValue(s, g), g, s)];
      symbolShare /= p.groups;
      sum += symbolShare;
      weakest = Math.min(weakest, symbolShare);
    }
    const score = sum / PREAMBLE.length;
    const start = this.hops[first % 128].start;

    if (score > SYNC_SCORE && weakest > SYNC_MIN_SYMBOL && (!this.candidate || score > this.candidate.score)) {
      this.candidate = { score, start, age: 0 };
    } else if (this.candidate && ++this.candidate.age >= SYNC_SETTLE_HOPS) {
      const base = this.refine(this.candidate.start);
      this.candidate = null;
      this.lock = { base, adjust: 0, symbol: 0, nibbles: [], confidence: [], marginSum: 0, marginCount: 0 };
      events.push({ kind: 'sync', modemId: p.id });
    }
    return true;
  }

  /** Fine timing search around a coarse preamble position. */
  private refine(coarse: number): number {
    const { p } = this;
    const step = Math.max(1, Math.round(this.hop / 8));
    const scores: [number, number][] = [];
    for (let off = -this.hop; off <= this.hop; off += step) {
      let hit = 0;
      let all = 1e-20;
      for (let s = 0; s < PREAMBLE.length; s++) {
        const e = this.measure(Math.round(coarse + off + s * this.period));
        for (let g = 0; g < p.groups; g++) {
          hit += e[binOf(p, preambleValue(s, g), g, s)];
          for (let v = 0; v < TONES; v++) all += e[binOf(p, v, g, s)];
        }
      }
      scores.push([off, hit / all]);
    }
    const best = Math.max(...scores.map((s) => s[1]));
    const plateau = scores.filter((s) => s[1] >= best - 0.01);
    return coarse + plateau.reduce((acc, s) => acc + s[0], 0) / plateau.length;
  }

  private stepLocked(events: DemodEvent[]): boolean {
    const lock = this.lock!;
    const { p } = this;
    const start = Math.round(lock.base + (PREAMBLE.length + lock.symbol) * this.period + lock.adjust);
    if (start + this.window + this.trackOffset > this.written) return false;

    const e = this.measure(start);
    const symbol = PREAMBLE.length + lock.symbol;
    const chosen: number[] = [];
    for (let g = 0; g < p.groups; g++) {
      let best = -1;
      let bestE = -1;
      let second = 1e-20;
      for (let v = 0; v < TONES; v++) {
        const x = e[binOf(p, v, g, symbol)];
        if (x > bestE) {
          second = Math.max(second, bestE);
          bestE = x;
          best = v;
        } else if (x > second) {
          second = x;
        }
      }
      lock.nibbles.push(best);
      lock.confidence.push(bestE / second);
      lock.marginSum += 10 * Math.log10(Math.max(bestE, 1e-20) / second);
      lock.marginCount++;
      chosen.push(binOf(p, best, g, symbol));
    }

    // Early/late gate: nudge timing toward where the decided tones are strongest.
    let early = 0;
    let late = 0;
    for (const bin of chosen) {
      early += this.binEnergy(bin, start - this.trackOffset);
      late += this.binEnergy(bin, start + this.trackOffset);
    }
    if (early + late > 0) {
      lock.adjust += TIMING_GAIN * ((late - early) / (late + early)) * this.trackOffset;
      lock.adjust = Math.max(-this.maxAdjust, Math.min(this.maxAdjust, lock.adjust));
    }
    lock.symbol++;

    if (!lock.header) {
      if (lock.nibbles.length < HEADER_NIBBLES) return true;
      const header = this.parseHeader(lock);
      if (!header) {
        this.resumeSearch(Math.round(lock.base + this.period));
        return true;
      }
      lock.header = header;
      events.push({ kind: 'header', modemId: p.id, type: header.type, length: header.length, totalSymbols: header.totalSymbols });
    }

    const h = lock.header;
    const progress: DemodEvent = { kind: 'progress', modemId: p.id, symbols: lock.symbol, totalSymbols: h.totalSymbols };
    if (h.layout.blocks === 1) {
      const received = Math.min(h.length, Math.floor((lock.nibbles.length - HEADER_NIBBLES) / 2));
      progress.preview = nibblesToBytes(lock.nibbles, HEADER_NIBBLES, received);
    }
    events.push(progress);

    if (lock.symbol < h.totalSymbols) return true;
    events.push(this.finish(lock, h));
    this.resumeSearch(Math.round(lock.base + (PREAMBLE.length + h.totalSymbols) * this.period + lock.adjust));
    return true;
  }

  private byteConfidence(lock: Lock, index: number): number {
    return Math.min(lock.confidence[2 * index], lock.confidence[2 * index + 1]);
  }

  private parseHeader(lock: Lock): Lock['header'] | null {
    const { p } = this;
    const raw = nibblesToBytes(lock.nibbles, 0, HEADER_BYTES);
    const conf = Array.from({ length: HEADER_BYTES }, (_, i) => this.byteConfidence(lock, i));
    const h = decodeWithErasures(raw, HEADER_PARITY, conf);
    if (!h) return null;
    if (h[0] >> 4 !== VERSION || (h[0] & 0x0f) !== p.code || h[1] === 0) return null;
    const length = (h[2] << 8) | h[3];
    if (length > p.maxPayload) return null;
    const l = layout(p, length);
    return { type: h[1], length, layout: l, totalSymbols: l.symbols };
  }

  private finish(lock: Lock, h: NonNullable<Lock['header']>): DemodEvent {
    const { p } = this;
    const { blocks, perBlock } = h.layout;
    const n = perBlock + p.parity;
    const raw = nibblesToBytes(lock.nibbles, HEADER_NIBBLES, h.layout.bodyBytes);
    const data = new Uint8Array(blocks * perBlock);
    let correctedBytes = 0;
    for (let b = 0; b < blocks; b++) {
      const cw = new Uint8Array(n);
      const conf: number[] = [];
      for (let j = 0; j < n; j++) {
        cw[j] = raw[j * blocks + b];
        conf.push(this.byteConfidence(lock, HEADER_BYTES + j * blocks + b));
      }
      const fixed = decodeWithErasures(cw, p.parity, conf);
      if (!fixed) return { kind: 'error', modemId: p.id, reason: 'too many errors to correct' };
      for (let j = 0; j < perBlock; j++) if (fixed[j] !== cw[j]) correctedBytes++;
      data.set(fixed, b * perBlock);
    }
    const payload = data.slice(0, h.length);
    if (new DataView(data.buffer).getUint32(h.length) !== crc32(payload)) {
      return { kind: 'error', modemId: p.id, reason: 'checksum mismatch' };
    }
    return {
      kind: 'frame',
      modemId: p.id,
      frame: { type: h.type, payload },
      stats: {
        correctedBytes,
        marginDb: lock.marginSum / Math.max(1, lock.marginCount),
        airtime: (PREAMBLE.length + h.totalSymbols) * symbolPeriod(p),
      },
    };
  }
}
