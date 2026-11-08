// The explainer's figures. Most compute what they show from the real code:
// version 1's character map and timing, a real FFT, and today's frame encoder.
// The sync and error-correction figures are simplified illustrations of the
// idea, and say so in their captions.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ENCRYPTION_OVERHEAD,
  MAX_AGE_S,
  MAX_AHEAD_S,
  PBKDF2_ITERATIONS,
  decryptFrame,
  deriveKey,
  encryptFrame,
  generateKey,
} from '../modem/encryption';
import { FrameType } from '../modem/types';
import { CRC_BYTES, HEADER_BYTES, LEAD_IN_SECONDS, PREAMBLE, TAIL_SECONDS, binOf, toneFrequency } from '../modem/mfsk';
import { MODEMS, PROFILES, getModem } from '../modem/profiles';
import Canvas, { type Draw } from './Canvas';
import { SAMPLE_RATE, V1, V1_FREQUENCIES, V1_RANGE, captureWindow, loudestHz, rng, spectrum, v1CharAt } from './dsp';
import { FAST, FIRST_TEXT_SLOT, PREAMBLE_SLOTS, type Role, type SlotTone, fastFrame, slotTones, toneSet } from './frame';
import { palette, useReducedMotion, useTicker, useVisible } from './hooks';
import { playTone, playV1, stopSound, useSound } from './sound';

const CELL = 8;
const enc = new TextEncoder();

/** A play button; while its sound plays it becomes STOP, and other demos wait their turn. */
export function DemoButton({ id, label, play }: { id: string; label: string; play: (id: string) => Promise<void> }) {
  const { playing } = useSound();
  if (playing === id) {
    return (
      <button className="btn" onClick={stopSound}>
        [ ■ STOP ]
      </button>
    );
  }
  return (
    <button className="btn" disabled={playing !== null} onClick={() => void play(id)}>
      [ ▶ {label} ]
    </button>
  );
}

/** Beside a row of demo buttons: why one of them just failed to play. */
export function DemoNote({ ids }: { ids: string[] }) {
  const { error } = useSound();
  return (
    <span className="ex-note err" role="status">
      {error && ids.includes(error.id) ? error.message : ''}
    </span>
  );
}
/** A byte in hexadecimal, marked as such: 0x48. */
const hex = (b: number) => `0x${b.toString(16).padStart(2, '0')}`;
/** A nibble in binary: 0100. */
const bits = (n: number) => n.toString(2).padStart(4, '0');
const hz = (f: number) => Math.round(f).toLocaleString('en-US');

/**
 * One of several texts, laid out in the space of the tallest. A figure that
 * steps through captions of different lengths keeps its height, so the page
 * below it doesn't move. Screen readers get only the current text.
 */
function SteadyText({ texts, index, className = '', live = false }: { texts: string[]; index: number; className?: string; live?: boolean }) {
  return (
    <p className={`ex-steady ${className}`}>
      {texts.map((t, i) => (
        <span key={i} aria-hidden="true" className={i === index ? undefined : 'ex-steady-off'}>
          {t}
        </span>
      ))}
      <span className="sr-only" aria-live={live ? 'polite' : 'off'}>
        {texts[index]}
      </span>
    </p>
  );
}

const text = (ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color: string, align: CanvasTextAlign = 'left') => {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
  ctx.textAlign = 'left';
};

/* ── 1 · a tone, sampled ─────────────────────────────── */

export function ToneFigure() {
  const [position, setPosition] = useState(0.6);
  const hz = Math.round(100 * Math.pow(90, position));

  const draw: Draw = (ctx, w, h, ms) => {
    const p = palette();
    const span = 0.001;
    const shift = ms < 0 ? 0 : (ms / 1000) * span * 0.2;
    const mid = (h - 20) / 2;
    const amp = mid * 0.8;
    const y = (t: number) => mid - amp * Math.sin(2 * Math.PI * hz * (t + shift));
    ctx.strokeStyle = p.line;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.strokeStyle = p.dim;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const v = y((x / w) * span);
      if (x === 0) ctx.moveTo(x, v);
      else ctx.lineTo(x, v);
    }
    ctx.stroke();
    // The microphone only ever sees these points.
    ctx.fillStyle = p.rx;
    for (let i = 0; i < span * SAMPLE_RATE; i++) {
      const t = i / SAMPLE_RATE;
      ctx.fillRect((t / span) * w - 1.5, y(t) - 1.5, 3, 3);
    }
    text(ctx, '0 ms', 0, h - 16, p.dim);
    text(ctx, '1 ms', w, h - 16, p.dim, 'right');
  };

  return (
    <figure className="ex-figure">
      <Canvas height={130} label={`A ${hz} Hz sine wave and the samples a microphone takes of it`} draw={draw} animate redraw={hz} />
      <div className="ex-controls">
        <label>
          pitch{' '}
          <input type="range" min={0} max={1} step={0.001} value={position} onChange={(e) => setPosition(Number(e.target.value))} />
        </label>
        <span className="ex-readout">{hz.toLocaleString()} Hz</span>
        <DemoButton id="tone" label="HEAR IT" play={(id) => playTone(id, hz)} />
        <DemoNote ids={['tone']} />
      </div>
      <figcaption>
        Each dot is one sample: the microphone measures the air pressure 48,000 times a second. Slide up and the wave squeezes
        together.
      </figcaption>
    </figure>
  );
}

/* ── 2 · version 1: a pitch per character ────────────── */

const DEMO = 'HELLO';
const MAP_MAX_HZ = 9000;

function v1Timeline(word: string) {
  const segments: { label: string; hz: number; t0: number; dur: number; marker?: boolean }[] = [];
  let t = V1.leadSeconds;
  segments.push({ label: 'start', hz: V1.start, t0: t, dur: V1.markerSeconds, marker: true });
  t += V1.markerSeconds + V1.gapSeconds;
  for (const c of word) {
    segments.push({ label: c, hz: V1_FREQUENCIES.get(c)!, t0: t, dur: V1.toneSeconds });
    t += V1.toneSeconds + V1.gapSeconds;
  }
  t += V1.endPauseSeconds;
  segments.push({ label: 'end', hz: V1.end, t0: t, dur: V1.markerSeconds, marker: true });
  return { segments, total: t + V1.markerSeconds };
}

export function V1Figure() {
  const { segments, total } = useMemo(() => v1Timeline(DEMO), []);

  const drawMap: Draw = (ctx, w, h) => {
    const p = palette();
    const x = (hz: number) => 4 + (hz / MAP_MAX_HZ) * (w - 8);
    const axis = 34;
    ctx.fillStyle = p.line;
    ctx.fillRect(0, axis, w, 1);
    const used = new Set(DEMO);
    for (const [c, hz] of V1_FREQUENCIES) {
      ctx.fillStyle = used.has(c) ? p.rx : p.dim;
      ctx.fillRect(Math.round(x(hz)), axis - (used.has(c) ? 14 : 6), 1, used.has(c) ? 14 : 6);
      if (used.has(c)) text(ctx, c, x(hz), axis - 32, p.rx, 'center');
    }
    for (const hz of [V1.start, V1.end]) {
      ctx.fillStyle = p.accent;
      ctx.fillRect(Math.round(x(hz)), axis - 14, 1, 14);
    }
    text(ctx, 'start/end', x(2600), axis - 32, p.accent, 'center');
    const groups: [string, number][] = [
      ['␠', 900],
      ['symbols', 3000],
      ['0–9', 5150],
      ['A–Z', 6950],
    ];
    for (const [label, hz] of groups) text(ctx, label, x(hz), axis + 6, p.dim, 'center');
    text(ctx, '9 kHz', w, h - 16, p.dim, 'right');
    text(ctx, '0', 0, h - 16, p.dim);
  };

  const drawTimeline: Draw = (ctx, w, h, ms) => {
    const p = palette();
    const slow = 3;
    const now = ms < 0 ? Infinity : ((ms / 1000 / slow) % (total + 0.5)) - 0.1;
    const plotTop = 18;
    const plotBottom = h - 30;
    const lo = 2000;
    const hi = 8600;
    const x = (t: number) => (t / total) * w;
    const y = (hz: number) => plotBottom - ((hz - lo) / (hi - lo)) * (plotBottom - plotTop);
    ctx.fillStyle = p.line;
    ctx.fillRect(0, plotBottom + 4, w, 1);

    let heard = 0;
    let lastL = -1;
    let dropped = -1;
    segments.forEach((s, i) => {
      const done = now >= s.t0 + s.dur / 2;
      const color = s.marker ? p.accent : p.rx;
      ctx.globalAlpha = done ? 1 : 0.3;
      ctx.fillStyle = color;
      ctx.fillRect(x(s.t0), y(s.hz) - 3, Math.max(2, x(s.dur) - 1), 6);
      text(ctx, s.label, x(s.t0 + s.dur / 2), y(s.hz) - 22, color, 'center');
      ctx.globalAlpha = 1;
      if (!s.marker && done) {
        heard = i;
        if (s.label === 'L' && lastL >= 0 && s.t0 - segments[lastL].t0 < V1.lockoutMs / 1000) dropped = i;
        if (s.label === 'L') lastL = i;
      }
    });
    if (now <= total) {
      ctx.fillStyle = p.fg;
      ctx.fillRect(x(Math.max(0, now)), plotTop - 6, 1, plotBottom - plotTop + 10);
    }

    // What version 1's receiver printed.
    let cx = 0;
    text(ctx, 'heard:', cx, h - 18, p.dim);
    cx += 7 * CELL;
    for (let i = 1; i <= heard; i++) {
      const c = segments[i].label;
      const lost = i === dropped;
      text(ctx, c, cx, h - 18, lost ? p.err : p.fg);
      if (lost) {
        ctx.fillStyle = p.err;
        ctx.fillRect(cx - 1, h - 10, CELL + 2, 1);
      }
      cx += 2 * CELL;
    }
    if (dropped > 0 && now >= total) text(ctx, '← second L dropped', cx + CELL, h - 18, p.err);
  };

  return (
    <figure className="ex-figure">
      <Canvas height={56} label="Version 1 character map: every character at its own pitch, 100 Hz apart" draw={drawMap} />
      <Canvas height={150} label="HELLO in version 1: a start tone, one tone per letter, an end tone" draw={drawTimeline} animate />
      <div className="ex-controls">
        <DemoButton id="v1-map" label="HEAR HELLO, VERSION 1" play={(id) => playV1(id, DEMO)} />
        <DemoNote ids={['v1-map']} />
      </div>
      <figcaption>
        Each letter is 70 ms of its pitch, then 30 ms of quiet; slowed down 3× here. The receiver ignores a letter it heard less
        than {V1.lockoutMs} ms ago, so one long tone isn't counted twice. The second L often fell inside that window and
        vanished.
      </figcaption>
    </figure>
  );
}

/* ── 2b · version 1's character map, as a table ──────── */

const pitch = (c: string) => V1_FREQUENCIES.get(c)!;
const V1_TABLES: { caption: string; rows: [string, number][] }[] = [
  { caption: 'letters', rows: [...'ABCD'].map((c) => [c, pitch(c)]) },
  { caption: 'digits', rows: [...'1234'].map((c) => [c, pitch(c)]) },
  { caption: 'symbols', rows: [...'!@#$'].map((c) => [c, pitch(c)]) },
  {
    caption: 'markers',
    rows: [
      ['start', V1.start],
      ['end', V1.end],
    ],
  },
];

export function V1TableFigure() {
  return (
    <figure className="ex-figure">
      <div className="ex-v1map">
        {V1_TABLES.map((t) => (
          <table key={t.caption}>
            <caption>{t.caption}</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">character</th>
                <th scope="col">pitch</th>
              </tr>
            </thead>
            <tbody>
              {t.rows.map(([label, f]) => (
                <tr key={label}>
                  <th scope="row" className={label.length > 1 ? 'dim' : undefined}>
                    {label}
                  </th>
                  <td>{hz(f)} Hz</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
      <figcaption>
        A few of version 1's {V1_FREQUENCIES.size} characters, which spanned {hz(V1_RANGE[0])} to {hz(V1_RANGE[1])} Hz. Neighbours
        are 100 Hz apart, and the markers have pitches no character uses. The receiver read the table backwards: hear{' '}
        {hz(pitch('C'))} Hz, print C.
      </figcaption>
    </figure>
  );
}

/* ── 3 · the FFT ─────────────────────────────────────── */

export function FftFigure() {
  const [noise, setNoise] = useState(2);
  const ref = useRef<HTMLElement>(null);
  const visible = useVisible(ref);
  const reduced = useReducedMotion();
  const tick = useTicker(250, visible && !reduced);
  const letter = DEMO[Math.floor(tick / 6) % DEMO.length];
  const sent = V1_FREQUENCIES.get(letter)!;
  const { samples, spec, peak } = useMemo(() => {
    const samples = captureWindow(sent, noise, tick + 1);
    const spec = spectrum(samples, MAP_MAX_HZ);
    return { samples, spec, peak: loudestHz(spec) };
  }, [sent, noise, tick]);
  const heard = v1CharAt(peak);
  const ok = heard === letter;
  const snr = noise > 0 ? 10 * Math.log10(0.5 / (noise * noise)) : Infinity;

  const draw: Draw = (ctx, w, h) => {
    const p = palette();
    // Top: 2 ms of what the microphone delivers.
    const waveH = 50;
    const shown = 96;
    let maxAbs = 1.2;
    for (let i = 0; i < shown; i++) maxAbs = Math.max(maxAbs, Math.abs(samples[i]));
    ctx.strokeStyle = p.dim;
    ctx.beginPath();
    for (let i = 0; i < shown; i++) {
      const px = (i / (shown - 1)) * w;
      const py = waveH / 2 - (samples[i] / maxAbs) * (waveH / 2 - 2);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    text(ctx, 'samples in', 0, waveH + 2, p.dim);
    text(ctx, '↓ FFT', w / 2, waveH + 2, p.accent, 'center');

    // Bottom: how much of each frequency is in the window.
    const top = waveH + 24;
    const bottom = h - 20;
    let maxMag = 1;
    for (const v of spec) maxMag = Math.max(maxMag, v);
    const bx = (k: number) => (k / spec.length) * w;
    ctx.fillStyle = p.line;
    ctx.fillRect(0, bottom, w, 1);
    ctx.fillStyle = p.dim;
    for (let k = 0; k < spec.length; k++) {
      const bh = (spec[k] / maxMag) * (bottom - top);
      ctx.fillRect(bx(k), bottom - bh, Math.max(1, bx(1) - 0.5), bh);
    }
    const sentX = (sent / MAP_MAX_HZ) * w;
    ctx.fillStyle = p.tx;
    for (let yy = top; yy < bottom; yy += 6) ctx.fillRect(sentX, yy, 1, 3);
    const peakX = (peak / MAP_MAX_HZ) * w;
    const peakH = (spec[Math.round(peak / (SAMPLE_RATE / 2048))] / maxMag) * (bottom - top);
    ctx.fillStyle = ok ? p.tx : p.err;
    ctx.fillRect(peakX - 1, bottom - peakH, 3, peakH);
    text(ctx, 'loudest', Math.min(w - 32, Math.max(32, peakX)), Math.max(top - 2, bottom - peakH - 18), ok ? p.tx : p.err, 'center');
    for (const k of [0, 3, 6, 9]) text(ctx, `${k}k`, (k * 1000 * w) / MAP_MAX_HZ, h - 16, p.dim, k === 0 ? 'left' : k === 9 ? 'right' : 'center');
  };

  return (
    <figure className="ex-figure" ref={ref}>
      <Canvas height={210} label="Microphone samples turned into a spectrum by an FFT; the loudest peak picks the letter" draw={draw} redraw={`${tick}|${noise}`} />
      <div className="ex-controls">
        <label>
          hiss <input type="range" min={0} max={12} step={0.25} value={noise} onChange={(e) => setNoise(Number(e.target.value))} />
        </label>
        <span className="ex-readout">{snr === Infinity ? 'silent room' : snr >= 0 ? `tone ${snr.toFixed(0)} dB louder` : `hiss ${(-snr).toFixed(0)} dB louder than the tone`}</span>
      </div>
      <p className={`ex-verdict ${ok ? 'ok' : 'err'}`} aria-live="off">
        sent {letter} ({sent.toLocaleString()} Hz) · loudest {Math.round(peak).toLocaleString()} Hz → {heard ?? 'nothing'} {ok ? '✓' : '✗'}
      </p>
    </figure>
  );
}

/* ── 5a · bytes and nibbles ──────────────────────────── */

export const MAX_DEMO_BYTES = 40;

/** As many whole characters of `s` as fit in the example's byte limit. */
function fitDemo(s: string): string {
  let out = '';
  let size = 0;
  for (const c of s) {
    size += enc.encode(c).length;
    if (size > MAX_DEMO_BYTES) break;
    out += c;
  }
  return out;
}

export function NibbleFigure({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const [clipped, setClipped] = useState(false);
  const chars = Array.from(value);
  const total = enc.encode(value).length;
  // The caption's worked example: the first byte typed, or H's.
  const b = enc.encode(value)[0] ?? 0x48;
  return (
    <figure className="ex-figure">
      <label className="ex-input">
        <span aria-hidden="true">&gt;</span>
        <input
          value={value}
          spellCheck={false}
          aria-label="Text to encode"
          onChange={(e) => {
            const fitted = fitDemo(e.target.value);
            setClipped(fitted !== e.target.value);
            onChange(fitted);
          }}
        />
      </label>
      <p className="ex-limit warn" role="status">
        {clipped
          ? `This example stops at ${MAX_DEMO_BYTES} bytes so the figures stay readable. The app itself sends up to ${FAST.maxPayload.toLocaleString('en-US')} bytes in FAST.`
          : ''}
      </p>
      <div className="ex-nibbles">
        {chars.map((c, i) => (
          <div className="ex-char" key={i}>
            <span className="ex-glyph">{c === ' ' ? '␠' : c}</span>
            <span className="ex-bytes">
              {Array.from(enc.encode(c)).map((byte, j) => (
                <span className="ex-byte" key={j}>
                  <span className="dim">{hex(byte)}</span>
                  <span className="ex-halves">
                    {[byte >> 4, byte & 15].map((v, k) => (
                      <span className="ex-nib" key={k}>
                        <span className="ex-bits">{bits(v)}</span>
                        {v}
                      </span>
                    ))}
                  </span>
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
      <figcaption>
        Each character becomes one to four bytes (UTF-8). A byte is shown in hexadecimal, base 16, so {hex(b)} is {b}. Its two
        4-bit halves are shown in binary, then as a number from 0 to 15: {hex(b)} → {bits(b >> 4)} | {bits(b & 15)} →{' '}
        {b >> 4} | {b & 15}. {total} bytes → {total * 2} nibbles, each one of 16 tones. Try lowercase or an emoji: version 1
        had no pitch for them.
      </figcaption>
    </figure>
  );
}

/* ── 5b · the frame on the wire ──────────────────────── */

/** Bytes as quoted text, or nothing when they split a multi-byte character. */
const quoted = (bytes: number[]) => {
  try {
    return ` "${new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))}"`;
  } catch {
    return ' (part of a character)';
  }
};

const ROLE_LABELS: Record<Role, string> = { sync: 'sync', header: 'header', message: 'message', check: 'checksum', repair: 'repair bytes', pad: '' };

export function FrameFigure({ value }: { value: string }) {
  const ref = useRef<HTMLElement>(null);
  const visible = useVisible(ref);
  const reduced = useReducedMotion();
  const slotMs = (FAST.symbolSeconds + FAST.guardSeconds) * 1000;
  const tick = useTicker(slotMs * 10, visible && !reduced);
  const { tones, bytes, roles, payload } = useMemo(() => fastFrame(enc.encode(value)), [value]);
  const n = tones.length;
  const current = reduced ? -1 : tick % (n + 4);

  const colors = () => {
    const p = palette();
    return { sync: p.accent, header: p.warn, message: p.rx, check: p.tx, repair: p.fg, pad: p.dim } satisfies Record<Role, string>;
  };

  const draw: Draw = (ctx, w, h) => {
    const p = palette();
    const c = colors();
    const left = 5 * CELL;
    const top = 6;
    const bottom = h - 40;
    const colW = (w - left) / n;
    const bins = 16 * FAST.groups * 2;
    const y = (bin: number) => bottom - ((bin + 0.5) / bins) * (bottom - top);
    const khz = (hz: number) => `${(Math.round(hz / 100) / 10).toFixed(1)}k`;
    text(ctx, khz(FAST.baseFrequency + (bins - 1) * FAST.toneSpacing), 0, top, p.dim);
    text(ctx, khz(FAST.baseFrequency), 0, bottom - 14, p.dim);
    if (current >= 0 && current < n) {
      ctx.fillStyle = p.sel;
      ctx.fillRect(left + current * colW, top, colW, bottom - top);
    }
    for (let s = 0; s < n; s++) {
      ctx.globalAlpha = current < 0 || s <= current || current >= n ? 1 : 0.25;
      ctx.fillStyle = s === current ? p.fg : c[roles[s]];
      for (const bin of tones[s]) ctx.fillRect(left + s * colW + 0.5, y(bin) - 1.5, Math.max(1, colW - 1), 3);
    }
    ctx.globalAlpha = 1;
    // Which part of the frame each slot carries.
    let start = 0;
    for (let s = 1; s <= n; s++) {
      if (s < n && roles[s] === roles[start]) continue;
      const x0 = left + start * colW;
      const x1 = left + s * colW;
      ctx.fillStyle = c[roles[start]];
      ctx.globalAlpha = 0.7;
      ctx.fillRect(x0 + 1, bottom + 6, x1 - x0 - 2, 6);
      ctx.globalAlpha = 1;
      const label = ROLE_LABELS[roles[start]];
      if (label && label.length * CELL < x1 - x0) text(ctx, label, (x0 + x1) / 2, bottom + 18, c[roles[start]], 'center');
      start = s;
    }
  };

  const paddingMs = Math.round((LEAD_IN_SECONDS + TAIL_SECONDS) * 1000);
  // The summary, then one line per part of the frame. A line stays up while its
  // part plays, long enough to read; the next figure takes single slots apart.
  const sections: { role: Role; from: number; to: number }[] = [];
  roles.forEach((role, s) => {
    const last = sections[sections.length - 1];
    if (last && last.role === role) last.to = s;
    else sections.push({ role, from: s, to: s });
  });
  const repairBytes = bytes.length - HEADER_BYTES - payload.length - CRC_BYTES;
  const PARTS: Record<Role, string> = {
    sync: 'sync: a fixed pattern that marks the start',
    header: 'header: the mode, message type and length, with repair bytes of its own',
    message: `your text:${quoted(Array.from(payload))}`,
    check: 'checksum: confirms the text arrived intact',
    repair: `${repairBytes} repair bytes: enough to fix mistakes`,
    pad: 'padding',
  };
  const readouts = [
    `${payload.length} bytes of text become ${n} slots of ${slotMs} ms, plus ${paddingMs} ms of quiet lead-in and tail = ${getModem('fast').airtime(payload.length).toFixed(2)} s of sound`,
    ...sections.map(({ role, from, to }) => `${from === to ? `slot ${from + 1}` : `slots ${from + 1}–${to + 1}`} · ${PARTS[role]}`),
  ];
  const playing = current >= 0 && current < n ? sections.findIndex((x) => current <= x.to) + 1 : 0;

  return (
    <figure className="ex-figure" ref={ref}>
      <Canvas height={230} label={`Your text as FAST sends it: ${n} slots of four tones each`} draw={draw} redraw={`${current}|${value}`} />
      <SteadyText className="ex-verdict dim" texts={readouts} index={playing} />
      <figcaption>
        Your text above, exactly as FAST sends it, slowed down 10×. Time runs left to right, pitch bottom to top. Every column is
        one slot with four tones; the next figure takes one apart.
      </figcaption>
    </figure>
  );
}

/* ── 5b+ · which pitch carries which bits ───────────── */

const GROUP_COLORS = ['rx', 'tx', 'warn', 'accent'] as const;
/** The real modem's pitch for a 4-bit value in a group, in a given slot (which picks tone set A or B). */
const pitchOf = (value: number, group: number, slot: number) => toneFrequency(FAST, binOf(FAST, value, group, slot));

const SOURCE_LABELS: Partial<Record<Role, string>> = { header: 'header', check: 'checksum', repair: 'repair byte' };

/** Where a tone's bits come from, for the pitch table: 0x48 "H", high half. */
function toneSource(t: SlotTone) {
  if (t.byte === undefined) return 'padding after the last byte';
  const what = t.role === 'message' ? (t.byte >= 0x20 && t.byte < 0x7f ? `"${String.fromCharCode(t.byte)}"` : '(part of a character)') : `(${SOURCE_LABELS[t.role]})`;
  return `${hex(t.byte)} ${what}, ${t.half} half`;
}

export function PitchFigure({ value }: { value: string }) {
  const frame = useMemo(() => fastFrame(enc.encode(value)), [value]);
  const [chosen, setChosen] = useState(FIRST_TEXT_SLOT);
  const n = frame.tones.length;
  const slot = Math.min(chosen, n - 1);
  const tones = slotTones(frame, slot);
  const set = toneSet(slot);
  const dataSlots = n - PREAMBLE_SLOTS;
  // The arrows step through every slot that carries bytes, wrapping around; the sync slots carry none.
  const step = (by: number) => setChosen(PREAMBLE_SLOTS + ((slot - PREAMBLE_SLOTS + by + dataSlots) % dataSlots));
  const lo = FAST.baseFrequency;
  const hi = pitchOf(15, FAST.groups - 1, 1);

  const draw: Draw = (ctx, w, h) => {
    const p = palette();
    const left = 1;
    const x = (f: number) => left + ((f - lo) / (hi - lo)) * (w - 2 * left);
    const base = h - 22;
    // Every pitch this slot could use, coloured by tone.
    for (let g = 0; g < FAST.groups; g++) {
      ctx.fillStyle = p[GROUP_COLORS[g]];
      ctx.globalAlpha = 0.45;
      for (let v = 0; v < 16; v++) ctx.fillRect(Math.round(x(pitchOf(v, g, slot))) - 1, base - 8, 2, 8);
    }
    ctx.globalAlpha = 1;
    // The four that play, each bar reaching up to its label. Each label has its own
    // 16 px text row and clears a gap in any neighbouring bar that passes behind it.
    const xs = tones.map((t) => Math.round(x(t.frequency)));
    tones.forEach((_, g) => {
      const top = 4 + (g + 1) * 16 + 2;
      ctx.fillStyle = p[GROUP_COLORS[g]];
      ctx.fillRect(xs[g] - 2, top, 4, base - top);
    });
    tones.forEach((t, g) => {
      const label = bits(t.value);
      const width = ctx.measureText(label).width;
      const align = xs[g] > w - 40 ? 'right' : xs[g] < 40 ? 'left' : 'center';
      const x0 = align === 'right' ? xs[g] - width : align === 'left' ? xs[g] : xs[g] - width / 2;
      ctx.clearRect(x0 - 2, 2 + g * 16, width + 4, 18);
      text(ctx, label, xs[g], 4 + g * 16, p[GROUP_COLORS[g]], align);
    });
    ctx.fillStyle = p.line;
    ctx.fillRect(0, base, w, 1);
    for (const f of [1500, 3000, 4500, 6000, 7500]) text(ctx, `${f / 1000}k`, x(f), base + 6, p.dim, f === 1500 ? 'left' : 'center');
  };

  const slotBytes = tones.filter((t) => t.half === 'high').map((t) => (t.byte === undefined ? 'padding' : hex(t.byte)));

  return (
    <figure className="ex-figure">
      <Canvas
        height={110}
        label={`Slot ${slot + 1} uses tone set ${set}. Its four tones carry bytes ${slotBytes.join(' and ')} at ${tones.map((t) => hz(t.frequency)).join(', ')} Hz.`}
        draw={draw}
        redraw={`${slot}|${tones.map((t) => t.value).join()}`}
      />
      <table className="ex-pitches">
        <thead>
          <tr>
            <th scope="col">tone</th>
            <th scope="col">from byte</th>
            <th scope="col">bits</th>
            <th scope="col">pitch</th>
          </tr>
        </thead>
        <tbody>
          {tones.map((t, g) => (
            <tr key={g}>
              <th scope="row" className={`ex-group-${GROUP_COLORS[g]}`}>
                {g + 1}
              </th>
              <td>{toneSource(t)}</td>
              <td>{bits(t.value)}</td>
              <td>{hz(t.frequency)} Hz</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Both arrows first, so a narrow screen wraps the readout rather than splitting them. */}
      <div className="ex-controls">
        <button className="btn" onClick={() => step(-1)} aria-label="Previous slot">
          [ ← ]
        </button>
        <button className="btn" onClick={() => step(1)} aria-label="Next slot">
          [ → ]
        </button>
        <span className="ex-readout" aria-live="polite">
          slot {slot + 1} of {n} · tone set {set}
        </span>
      </div>
      <figcaption>
        One slot of the frame above, exactly as FAST plays it, starting at the first slot of your text. The arrows step to the
        header before it and the checksum and repair bytes after it. Faint marks are every pitch the slot's tone set offers; the
        tall ones are the four it plays.
      </figcaption>
    </figure>
  );
}

/* ── 5c · echoes and alternating tone sets ───────────── */

export function EchoFigure() {
  const [alternate, setAlternate] = useState(true);
  const rows = 8;
  const rowH = 16;
  const top = 22;
  const label = (r: number) => `${r % 2 ? 'B' : 'A'}${r >> 1}`;
  const rowY = (r: number) => top + (rows - 1 - r) * rowH;
  const slot1 = { x: 40, w: 120 };
  const slot2 = { x: 190, w: 120 };
  const sent1 = 2; // A1
  const sent2 = alternate ? 5 : 4; // B2 or A2
  const listening = Array.from({ length: rows }, (_, r) => r).filter((r) => (alternate ? r % 2 === 1 : r % 2 === 0));
  return (
    <figure className="ex-figure">
      <svg className="ex-svg" viewBox="0 0 320 172" role="img" aria-label="An echo of the previous slot landing on a tone the receiver does or does not listen to">
        <text x={slot1.x + slot1.w / 2} y={12} className="ex-svg-dim" textAnchor="middle">
          slot 1
        </text>
        <text x={slot2.x + slot2.w / 2} y={12} className="ex-svg-dim" textAnchor="middle">
          slot 2
        </text>
        {Array.from({ length: rows }, (_, r) => (
          <text key={r} x={0} y={rowY(r) + 12} className="ex-svg-dim">
            {label(r)}
          </text>
        ))}
        {listening.map((r) => (
          <rect key={r} x={slot2.x} y={rowY(r) + 2} width={slot2.w} height={rowH - 4} className="ex-listen" />
        ))}
        <rect x={slot1.x} y={rowY(sent1) + 4} width={slot1.w} height={rowH - 8} className="ex-tone" />
        <rect x={slot1.x + slot1.w} y={rowY(sent1) + 4} width={slot2.x + 70 - slot1.x - slot1.w} height={rowH - 8} className="ex-echo" />
        <text x={slot2.x + 76} y={rowY(sent1) + 12} className="ex-svg-warn">
          echo
        </text>
        <rect x={slot2.x} y={rowY(sent2) + 4} width={slot2.w} height={rowH - 8} className="ex-tone" />
        <text x={0} y={top + rows * rowH + 14} className="ex-svg-dim">
          dashed: rows the receiver reads in slot 2
        </text>
      </svg>
      <div className="ex-controls">
        <button className="btn" onClick={() => setAlternate((a) => !a)} aria-pressed={alternate}>
          [ alternating sets: {alternate ? 'ON' : 'OFF'} ]
        </button>
      </div>
      <p className={`ex-verdict ${alternate ? 'ok' : 'err'}`}>
        {alternate
          ? 'The echo rings on A1, a row slot 2 does not read, so here it does not compete with the real tone.'
          : 'The echo on A1 competes with the real tone on A2: slot 2 might be read as 1 instead of 2.'}
      </p>
    </figure>
  );
}

/* ── 5d · finding the start ──────────────────────────── */

// The real start pattern (one group's worth of it).
const SYNC_PATTERN = PREAMBLE;
const STREAM_LENGTH = 40;
const SYNC_AT = 19;

export function SyncFigure() {
  const { stream, scores, order, reach } = useMemo(() => {
    const r = rng(7);
    const stream = Array.from({ length: STREAM_LENGTH }, () => Math.floor(r() * 16));
    SYNC_PATTERN.forEach((v, i) => (stream[SYNC_AT + i] = v));
    const offsets = STREAM_LENGTH - SYNC_PATTERN.length + 1;
    const scores = Array.from({ length: offsets }, (_, o) => SYNC_PATTERN.filter((v, i) => stream[o + i] === v).length / SYNC_PATTERN.length);
    // Sweep, hold on the lock, sweep on, pause.
    const order = [...Array.from({ length: SYNC_AT + 1 }, (_, o) => o), ...Array(8).fill(SYNC_AT), ...Array.from({ length: offsets - SYNC_AT - 1 }, (_, o) => SYNC_AT + 1 + o), ...Array(4).fill(-1)];
    // How far the window has reached by each step, so the score graph only shows positions already tried.
    const reach = order.map((_, s) => Math.max(...order.slice(0, s + 1)) + 1);
    return { stream, scores, order, reach };
  }, []);

  const draw: Draw = (ctx, w, h, ms) => {
    const p = palette();
    const step = ms < 0 ? -2 : Math.floor(ms / 200) % order.length;
    const offset = step === -2 ? SYNC_AT : order[step];
    const seen = step === -2 ? scores.length : reach[step];
    const colW = w / STREAM_LENGTH;
    const lane = 64;
    const vy = (v: number) => 4 + (15 - v) * ((lane - 8) / 15);
    if (offset >= 0) {
      ctx.strokeStyle = p.accent;
      ctx.strokeRect(offset * colW + 0.5, 0.5, SYNC_PATTERN.length * colW - 1, lane);
    }
    stream.forEach((v, i) => {
      const inWindow = offset >= 0 && i >= offset && i < offset + SYNC_PATTERN.length;
      const match = inWindow && SYNC_PATTERN[i - offset] === v;
      ctx.fillStyle = match ? p.tx : inWindow ? p.fg : p.dim;
      ctx.fillRect(i * colW + colW / 2 - 2, vy(v) - 2, 4, 4);
      if (inWindow) {
        ctx.strokeStyle = p.accent;
        ctx.strokeRect(i * colW + colW / 2 - 3.5, vy(SYNC_PATTERN[i - offset]) - 3.5, 7, 7);
      }
    });
    // Match score at every position tried so far.
    const graphTop = lane + 12;
    const graphBottom = h - 20;
    ctx.fillStyle = p.line;
    ctx.fillRect(0, graphBottom, w, 1);
    for (let o = 0; o < seen && o < scores.length; o++) {
      const bh = scores[o] * (graphBottom - graphTop);
      ctx.fillStyle = scores[o] === 1 ? p.tx : o === offset ? p.accent : p.dim;
      ctx.fillRect(o * colW + 1, graphBottom - bh, colW - 2, bh);
    }
    const locked = offset === SYNC_AT || offset < 0;
    text(ctx, locked ? 'match 8/8 · locked: the message starts here' : `match ${Math.round(scores[Math.max(0, offset)] * 8)}/8`, 0, h - 16, locked ? p.tx : p.dim);
  };

  return (
    <figure className="ex-figure">
      <Canvas height={170} label="The receiver slides the known start pattern along what it hears until all eight slots match" draw={draw} animate />
      <figcaption>
        Simplified: one tone per slot, and a match means the exact tone. The real receiver compares how much of the sound
        falls on each expected tone, so it still locks on when some slots are noisy. Top: tones as heard (pink boxes are the
        pattern being tried). Bottom: how many of the 8 slots match at each position.
      </figcaption>
    </figure>
  );
}

/* ── 5e · error correction and interleaving ──────────── */

const FEC_BLOCKS = 3;
const FEC_DATA = 6;
const FEC_PARITY = 4;
const FEC_N = FEC_DATA + FEC_PARITY;
const FEC_TOTAL = FEC_BLOCKS * FEC_N;
const BURST = new Set([11, 12, 13, 14, 15]);
const FEC_STEPS = [
  `${FEC_BLOCKS} blocks: ${FEC_DATA} data bytes + ${FEC_PARITY} repair bytes each, enough to fix any ${FEC_PARITY / 2} bad bytes in a block`,
  'sent interleaved: one byte from each block in turn',
  `a burst of noise wrecks ${BURST.size} bytes in a row`,
  `back in blocks, no block lost more than ${FEC_PARITY / 2}`,
  'Reed–Solomon repairs every block, and the CRC-32 checksum confirms ✓',
];

export function FecFigure() {
  const ref = useRef<HTMLElement>(null);
  const visible = useVisible(ref);
  const reduced = useReducedMotion();
  // Steps on its own until the reader clicks; from then on the reader is in control.
  const [manual, setManual] = useState<number | null>(null);
  const tick = useTicker(1800, visible && !reduced && manual === null);
  const step = manual ?? tick % FEC_STEPS.length;
  const inLine = step === 1 || step === 2;
  return (
    <figure className="ex-figure" ref={ref}>
      <button className="ex-fec" onClick={() => setManual((step + 1) % FEC_STEPS.length)} aria-label="Next step">
        {Array.from({ length: FEC_TOTAL }, (_, i) => {
          const b = i % FEC_BLOCKS;
          const j = Math.floor(i / FEC_BLOCKS);
          const sendIndex = j * FEC_BLOCKS + b;
          const col = inLine ? sendIndex : FEC_N + j;
          const row = inLine ? 1 : b;
          const hit = BURST.has(sendIndex);
          const state = hit && (step === 2 || step === 3) ? ' bad' : hit && step === 4 ? ' fixed' : '';
          return (
            <span
              key={i}
              className={`ex-cell block-${b}${j >= FEC_DATA ? ' parity' : ''}${state}`}
              style={{ left: `calc(${(col / FEC_TOTAL) * 100}% + 1px)`, top: row * 20 }}
            />
          );
        })}
      </button>
      <SteadyText
        className="ex-verdict"
        texts={FEC_STEPS.map((s, i) => `${i + 1}/${FEC_STEPS.length} · ${s}`)}
        index={step}
        live={manual !== null}
      />
      <figcaption>
        Simplified, with tiny blocks so it fits. Without interleaving the burst would land in one block: {BURST.size} bad
        bytes, more than its repair bytes can fix. Click to step through at your own pace.
      </figcaption>
    </figure>
  );
}

/* ── 5f · files ──────────────────────────────────────── */

export function FilesFigure() {
  const parts = ['M', '0', '1', '2', '3', 'M'];
  return (
    <figure className="ex-figure">
      <div className="ex-files">
        <span className="dim">send</span>
        <span className="ex-row">
          {parts.map((part, i) => (
            <span key={i} className={`ex-box${part === 'M' ? ' manifest' : ''}${i === 3 ? ' lost' : ''}`}>
              {i === 3 ? '✗' : part}
            </span>
          ))}
        </span>
        <span className="dim">resend</span>
        <span className="ex-row">
          {parts.map((part, i) => (
            <span key={i} className={`ex-box${part === 'M' ? ' manifest' : ''}${i === 3 ? ' filled' : ' have'}`}>
              {part}
            </span>
          ))}
        </span>
        <span className="dim">result</span>
        <span className="ok">✓ photo.jpg · every chunk present, checksum ok</span>
      </div>
      <figcaption>
        M is the manifest (name, size, checksum); 0–3 are numbered chunks. A resend plays the whole file again; the receiver
        keeps the chunks it already has and only needs the one it missed.
      </figcaption>
    </figure>
  );
}

/* ── 5g · modes ──────────────────────────────────────── */

const SPECTRUM_TOP = 20000;
const goodput = (id: string) => Math.round(800 / getModem(id).airtime(100));

export function ModesFigure() {
  return (
    <figure className="ex-figure">
      <div className="ex-modes">
        {MODEMS.map((m, i) => {
          const profile = PROFILES[i];
          const [lo, hi] = m.band;
          return (
            <div className="ex-mode" key={m.id}>
              <span className="ex-mode-name">{m.label}</span>
              <span className="ex-track">
                <span className="ex-band" style={{ left: `${(lo / SPECTRUM_TOP) * 100}%`, width: `${Math.max(1, ((hi - lo) / SPECTRUM_TOP) * 100)}%` }} />
              </span>
              <span className="dim">
                <span className="ex-mode-range">
                  {hz(lo)}–{hz(hi)} Hz
                </span>{' '}
                {/* Non-breaking spaces keep each value with its unit when the line wraps. */}
                · {profile.groups}&nbsp;tone{profile.groups > 1 ? 's' : ''} · {Math.round((profile.symbolSeconds + profile.guardSeconds) * 1000)}
                &nbsp;ms · ~{goodput(m.id)}&nbsp;b/s
              </span>
            </div>
          );
        })}
        <div className="ex-mode">
          <span />
          <span className="ex-axis">
            <span>0</span>
            <span>5</span>
            <span>10</span>
            <span>15</span>
            <span>20 kHz</span>
          </span>
          <span />
        </div>
      </div>
      <figcaption>
        b/s is the speed of the message itself, in bits per second, for a 100-byte message: the time also spent on the sync
        pattern, header, checksum and repair bytes is counted against it.
      </figcaption>
    </figure>
  );
}

/* ── 7a · how long guessing takes ────────────────────── */

// Roughly one of today's fastest graphics cards against PBKDF2-SHA256 at 600,000 rounds.
const GUESSES_PER_SECOND = 15_000;
const YEAR_S = 365.25 * 86400;
const UNIVERSE_S = 13.8e9 * YEAR_S;
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** A duration in words, rounded to what matters at that scale. */
function duration(s: number): string {
  // Two significant figures past 100: the guessing rate is only a rough figure.
  const round = (n: number, unit: string) => {
    const r = n < 100 ? Math.round(n) : Number(n.toPrecision(2));
    return `${r.toLocaleString('en-US')} ${unit}${r === 1 ? '' : 's'}`;
  };
  if (s < 60) return round(s, 'second');
  if (s < 3600) return round(s / 60, 'minute');
  if (s < 86400) return round(s / 3600, 'hour');
  if (s < YEAR_S) return round(s / 86400, 'day');
  const y = s / YEAR_S;
  if (y < 1e6) return round(y, 'year');
  if (y < 1e9) return `${Math.round(y / 1e6)} million years`;
  if (y < 1e12) return `${Math.round(y / 1e9)} billion years`;
  const exponent = Math.floor(Math.log10(y));
  return `10${Array.from(String(exponent), (d) => SUPERSCRIPT[Number(d)]).join('')} years`;
}

const GUESS_ROWS: { name: string; note: string; keys: number; rate: number; tone: string }[] = [
  { name: 'a known phrase', note: 'a lyric, quote or saying: one of maybe a billion', keys: 1e9, rate: GUESSES_PER_SECOND, tone: 'err' },
  {
    name: '5 random words',
    note: `from a 7,776-word list, but hashed once instead of ${PBKDF2_ITERATIONS.toLocaleString('en-US')} times`,
    keys: 7776 ** 5,
    rate: GUESSES_PER_SECOND * PBKDF2_ITERATIONS,
    tone: 'warn',
  },
  { name: '5 random words', note: 'from a 7,776-word list', keys: 7776 ** 5, rate: GUESSES_PER_SECOND, tone: 'rx' },
  { name: 'GENERATE', note: '25 random characters', keys: 32 ** 25, rate: GUESSES_PER_SECOND, tone: 'tx' },
];
// On average the right key turns up halfway through.
const guessSeconds = (row: (typeof GUESS_ROWS)[number]) => row.keys / 2 / row.rate;
const GUESS_MAX_LOG = Math.ceil(Math.max(...GUESS_ROWS.map((r) => Math.log10(guessSeconds(r)))));
const logPosition = (s: number) => `${(Math.max(0, Math.log10(s)) / GUESS_MAX_LOG) * 100}%`;
const GUESS_MARKS = [
  { label: '1 year', s: YEAR_S },
  { label: "universe's age", s: UNIVERSE_S },
];

export function GuessFigure() {
  const phrase = guessSeconds(GUESS_ROWS[0]);
  const words = guessSeconds(GUESS_ROWS[2]);
  return (
    <figure className="ex-figure">
      <div className="ex-modes ex-guess">
        <div className="ex-mode">
          <span />
          <span className="ex-marks" aria-hidden="true">
            {GUESS_MARKS.map((m) => (
              <span key={m.label} style={{ left: logPosition(m.s) }}>
                {m.label}
              </span>
            ))}
          </span>
        </div>
        {GUESS_ROWS.map((row, i) => (
          <div className="ex-mode" key={i}>
            <span className={`ex-mode-name ${row.tone}`}>{row.name}</span>
            <span className="ex-track">
              <span className={`ex-band ex-band-${row.tone}`} style={{ left: 0, width: logPosition(guessSeconds(row)) }} />
              {GUESS_MARKS.map((m) => (
                <span key={m.label} className="ex-mark" style={{ left: logPosition(m.s) }} />
              ))}
            </span>
            <span className="dim">
              {row.note} · <span className="ex-mode-range">~{duration(guessSeconds(row))}</span>
            </span>
          </div>
        ))}
      </div>
      <figcaption>
        How long someone with a recording would take, on average, to find the key, trying about{' '}
        {GUESSES_PER_SECOND.toLocaleString('en-US')} passphrases a second: roughly one of today's fastest graphics cards. Each step
        along the bars is ten times longer. A thousand cards divide every time by a thousand: the phrase then falls in about{' '}
        {duration(phrase / 1000)}, while the random words still take {duration(words / 1000)}.
      </figcaption>
    </figure>
  );
}

/* ── 7b · sealing a frame ────────────────────────────── */

type SealPart = 'type' | 'time' | 'text' | 'version' | 'nonce' | 'cipher' | 'tag';
const SEAL_LABELS: Record<SealPart, string> = {
  type: 'type',
  time: 'time',
  text: 'your text',
  version: 'version',
  nonce: 'nonce',
  cipher: 'ciphertext',
  tag: 'tag',
};

type Sealed =
  | { inside: [SealPart, Uint8Array][]; outside: [SealPart, Uint8Array][]; opened: string; flippedOpens: boolean }
  | { error: string };

function SealRow({ label, parts }: { label: string; parts: [SealPart, Uint8Array][] }) {
  return (
    <div className="ex-seal-row">
      <span className="dim">{label}</span>
      <span className="ex-seal-bytes">
        {parts.map(([part, bytes]) => (
          <span key={part} className={`ex-seal-part seal-${part}`} title={SEAL_LABELS[part]}>
            {Array.from(bytes, (b, i) => (
              <span key={i}>{b.toString(16).padStart(2, '0')}</span>
            ))}
          </span>
        ))}
      </span>
    </div>
  );
}

export function SealFigure({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const [key, setKey] = useState(generateKey);
  const [nonce, setNonce] = useState(() => crypto.getRandomValues(new Uint8Array(12)));
  const [flip, setFlip] = useState(false);
  const [sealed, setSealed] = useState<Sealed | null>(null);

  // The app's own code: PBKDF2 (slow by design, so a pause in typing first), then AES-256-GCM.
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const k = await deriveKey(key);
        const now = Date.now();
        const frame = await encryptFrame(k, { type: FrameType.Text, payload: enc.encode(value) }, { nonce, now });
        const opened = await decryptFrame(k, frame.payload, { now });
        if (!opened.ok) throw new Error('could not open its own frame');
        const altered = frame.payload.slice();
        // One bit of the ciphertext: of the first text byte if there is one.
        altered[13 + (value ? 5 : 0)] ^= 1;
        const flippedOpens = (await decryptFrame(k, altered, { now })).ok;
        const time = new Uint8Array(4);
        new DataView(time.buffer).setUint32(0, opened.sentAt);
        const p = frame.payload;
        if (!live) return;
        setSealed({
          inside: [
            ['type', Uint8Array.of(opened.frame.type)],
            ['time', time],
            ['text', opened.frame.payload],
          ],
          outside: [
            ['version', p.subarray(0, 1)],
            ['nonce', p.subarray(1, 13)],
            ['cipher', (flip ? altered : p).subarray(13, p.length - 16)],
            ['tag', p.subarray(p.length - 16)],
          ],
          opened: new TextDecoder().decode(opened.frame.payload),
          flippedOpens,
        });
      } catch (err) {
        if (live) setSealed({ error: err instanceof Error ? err.message : String(err) });
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, value, nonce, flip]);

  const textBytes = enc.encode(value).length;
  return (
    <figure className="ex-figure">
      <label className="ex-input">
        <span aria-hidden="true">&gt;</span>
        <input value={value} spellCheck={false} aria-label="Text to seal" onChange={(e) => onChange(fitDemo(e.target.value))} />
      </label>
      <label className="ex-input ex-input-key">
        <span aria-hidden="true">#</span>
        <input value={key} spellCheck={false} autoCapitalize="none" aria-label="Pre-shared key" onChange={(e) => setKey(e.target.value)} />
      </label>
      {sealed && 'error' in sealed ? (
        <p className="ex-verdict err">{sealed.error}</p>
      ) : (
        sealed && (
          <>
            <SealRow label="inside: only key holders" parts={sealed.inside} />
            <p className="ex-seal-arrow dim">↓ AES-256-GCM with the key, and a fresh nonce</p>
            <SealRow label="on air: everyone hears" parts={sealed.outside} />
            <p className="ex-seal-legend">
              {(['version', 'nonce', 'cipher', 'tag'] as const).map((part) => (
                <span key={part} className={`seal-${part}`}>
                  ■ {SEAL_LABELS[part]}
                </span>
              ))}
            </p>
            <div className="ex-controls">
              <button className="btn" onClick={() => setNonce(crypto.getRandomValues(new Uint8Array(12)))}>
                [ ↻ SEAL AGAIN ]
              </button>
              <button className="btn" aria-pressed={flip} onClick={() => setFlip((f) => !f)}>
                [ {flip ? '✓ UNDO THE FLIP' : '⚡ FLIP ONE BIT'} ]
              </button>
            </div>
            <p className={`ex-verdict ${flip && !sealed.flippedOpens ? 'err' : 'ok'}`} role="status">
              {flip
                ? sealed.flippedOpens
                  ? 'the flipped frame still opened (this should never happen)'
                  : '✗ refused: one bit changed, so the tag no longer matches'
                : `✓ opens with this key: "${sealed.opened}"`}
            </p>
          </>
        )
      )}
      <figcaption>
        Computed in your browser by the app's own code. {textBytes} bytes of text go out as {textBytes + ENCRYPTION_OVERHEAD}. SEAL
        AGAIN picks a new nonce, and every byte after it changes. Change one character of the key, or flip one bit on the way,
        and the frame no longer opens.
      </figcaption>
    </figure>
  );
}

/* ── 7c · the receiver's checks ──────────────────────── */

const GATES = [
  { name: 'Reed–Solomon and CRC-32', test: 'did the bytes arrive intact?' },
  { name: 'the tag', test: 'sealed with this key, and not altered since?' },
  { name: 'the time', test: `sent at most ${MAX_AGE_S / 60} minutes ago, and at most ${MAX_AHEAD_S / 60} minutes ahead?` },
  { name: 'the nonce', test: 'not opened already?' },
];

const SCENARIOS: { label: string; stop: number | null; outcome: string }[] = [
  { label: 'GENUINE', stop: null, outcome: 'opened, and shown as decrypted' },
  { label: 'NOISE', stop: 0, outcome: 'too damaged to repair: marked corrupted' },
  { label: 'WRONG KEY', stop: 1, outcome: 'refused: wrong key, or the frame was altered' },
  {
    label: 'ALTERED',
    stop: 1,
    outcome: 'refused: anyone can fix up a CRC, so the edit passes the first check, but only the key makes a matching tag',
  },
  { label: 'REPLAYED TOMORROW', stop: 2, outcome: 'refused: sent too long ago' },
  { label: 'REPLAYED AT ONCE', stop: 3, outcome: 'ignored: this frame was already opened' },
];

export function GatesFigure() {
  const ref = useRef<HTMLElement>(null);
  const visible = useVisible(ref);
  const reduced = useReducedMotion();
  // Cycles on its own until the reader picks a scenario.
  const [manual, setManual] = useState<number | null>(null);
  const tick = useTicker(2600, visible && !reduced && manual === null);
  const index = manual ?? tick % SCENARIOS.length;
  const scenario = SCENARIOS[index];
  return (
    <figure className="ex-figure" ref={ref}>
      <div className="ex-controls ex-scenarios">
        {SCENARIOS.map((s, i) => (
          <button key={s.label} className={`btn${i === index ? ' btn-primary' : ''}`} aria-pressed={i === index} onClick={() => setManual(i)}>
            [ {s.label} ]
          </button>
        ))}
      </div>
      <ol className="ex-gates">
        {GATES.map((g, i) => {
          const state = scenario.stop === null || i < scenario.stop ? 'pass' : i === scenario.stop ? 'stop' : 'skip';
          return (
            <li key={g.name} className={`gate-${state}`}>
              <span aria-hidden="true">{state === 'pass' ? '✓' : state === 'stop' ? '✗' : '·'}</span>
              <span>
                <span className="ex-gate-name">{g.name}</span> · {g.test}
                <span className="sr-only">{state === 'pass' ? ' passed' : state === 'stop' ? ' failed' : ' not reached'}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <SteadyText
        className={`ex-verdict ${scenario.stop === null ? 'ok' : 'err'}`}
        texts={SCENARIOS.map((s) => `${s.stop === null ? '✓' : '✗'} ${s.outcome}`)}
        index={index}
        live={manual !== null}
      />
      <figcaption>
        The order matters. Error correction comes first, so the cipher only ever sees bytes that arrived intact. The CRC catches
        accidents; the tag catches people.
      </figcaption>
    </figure>
  );
}
