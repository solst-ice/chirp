// Playback for the explainer's "hear it" buttons, on its own AudioContext so it
// never touches the app's transmit path.

import { getModem } from '../modem/profiles';
import { FrameType } from '../modem/types';
import { V1, V1_FREQUENCIES } from './dsp';

let ctx: AudioContext | null = null;
let current: AudioBufferSourceNode | null = null;

function context(): AudioContext {
  ctx ??= new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  return ctx;
}

function playSamples(samples: Float32Array, rate: number): Promise<void> {
  const c = context();
  current?.stop();
  const buffer = c.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  const node = c.createBufferSource();
  node.buffer = buffer;
  node.connect(c.destination);
  current = node;
  return new Promise((resolve) => {
    node.onended = () => {
      node.disconnect();
      if (current === node) current = null;
      resolve();
    };
    node.start();
  });
}

/** Sine segments with short fades, as version 1 played them. */
function render(segments: { hz: number; seconds: number }[], rate: number): Float32Array {
  const total = segments.reduce((t, s) => t + s.seconds, 0);
  const out = new Float32Array(Math.ceil(total * rate));
  let offset = 0;
  for (const { hz, seconds } of segments) {
    const n = Math.floor(seconds * rate);
    const fade = Math.min(n / 2, Math.floor(0.005 * rate));
    for (let i = 0; i < n && hz > 0; i++) {
      const env = Math.min(1, i / fade, (n - i) / fade);
      out[offset + i] = 0.5 * env * Math.sin((2 * Math.PI * hz * i) / rate);
    }
    offset += n;
  }
  return out;
}

export function playTone(hz: number, seconds = 0.6) {
  const rate = context().sampleRate;
  return playSamples(render([{ hz, seconds }], rate), rate);
}

/** Version 1: start marker, one pitch per character, end marker. */
export function playV1(text: string) {
  const rate = context().sampleRate;
  const segments = [{ hz: V1.start, seconds: V1.markerSeconds }, { hz: 0, seconds: V1.gapSeconds }];
  for (const c of text.toUpperCase()) {
    const hz = V1_FREQUENCIES.get(c);
    if (hz) segments.push({ hz, seconds: V1.toneSeconds }, { hz: 0, seconds: V1.gapSeconds });
  }
  segments.push({ hz: V1.end, seconds: V1.markerSeconds });
  return playSamples(render(segments, rate), rate);
}

/** Today's FAST mode, rendered by the real modem. */
export function playV2(text: string) {
  const rate = context().sampleRate;
  const modem = getModem('fast');
  const frame = { type: FrameType.Text, payload: new TextEncoder().encode(text) };
  return playSamples(modem.modulate(frame, rate), rate);
}

export function stopSound() {
  current?.stop();
}
