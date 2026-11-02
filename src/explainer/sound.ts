// Playback for the explainer's "hear it" buttons. The explainer is a page of
// its own, so the app is never listening or sending while a demo plays.
//
// Nothing here waits on `onended` alone: stopping, a suspended context and a
// failed start all end the playback straight away, so the buttons never stick.

import { useSyncExternalStore } from 'react';
import { getModem } from '../modem/profiles.ts';
import { FrameType } from '../modem/types.ts';
import { V1, V1_FREQUENCIES } from './dsp.ts';

type Playback = { id: string; node?: AudioBufferSourceNode; done: () => void };
export type SoundState = { playing: string | null; error: { id: string; message: string } | null };

let ctx: AudioContext | null = null;
let current: Playback | null = null;
let state: SoundState = { playing: null, error: null };
const listeners = new Set<() => void>();

function publish(next: SoundState) {
  state = next;
  listeners.forEach((l) => l());
}

/** Which demo is playing, if any, and why the last one failed. */
export const soundState = () => state;

export function useSound(): SoundState {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, soundState);
}

function end(p: Playback, error?: string) {
  if (current !== p) return;
  current = null;
  if (p.node) {
    p.node.onended = null;
    try {
      p.node.stop();
    } catch {
      // Never started, or already stopped.
    }
    p.node.disconnect();
  }
  publish({ playing: null, error: error ? { id: p.id, message: error } : null });
  p.done();
}

function context(): AudioContext {
  if (!ctx) {
    const c = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    // A call, a lock screen or a background tab can suspend the context mid-demo;
    // its source then never ends on its own.
    c.addEventListener('statechange', () => {
      if (c.state !== 'running' && current?.node) end(current, 'audio was interrupted');
    });
    ctx = c;
  }
  return ctx;
}

/** Resolves once the context is running. Called synchronously from the click so resume() counts as a gesture. */
async function running(): Promise<AudioContext> {
  const c = context();
  if (c.state !== 'running') await Promise.race([c.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
  if ((c.state as string) !== 'running') throw new Error('audio is paused · press again');
  return c;
}

function playSamples(id: string, make: (rate: number) => Float32Array): Promise<void> {
  if (current) end(current);
  return new Promise((done) => {
    const p: Playback = { id, done };
    current = p;
    publish({ playing: id, error: null });
    void (async () => {
      try {
        const c = await running();
        if (current !== p) return; // Stopped while resuming.
        const samples = make(c.sampleRate);
        const buffer = c.createBuffer(1, samples.length, c.sampleRate);
        buffer.copyToChannel(samples, 0);
        const node = c.createBufferSource();
        node.buffer = buffer;
        node.connect(c.destination);
        node.onended = () => end(p);
        p.node = node;
        node.start();
      } catch (err) {
        end(p, err instanceof Error ? err.message : 'could not play');
      }
    })();
  });
}

type Segment = { hz: number; seconds: number; partner?: boolean };

/** Sine segments with short fades, as version 1 played them; `partner` adds its second tone. */
function render(segments: Segment[], rate: number): Float32Array {
  const total = segments.reduce((t, s) => t + s.seconds, 0);
  const out = new Float32Array(Math.ceil(total * rate));
  let offset = 0;
  for (const { hz, seconds, partner } of segments) {
    const n = Math.floor(seconds * rate);
    const fade = Math.min(n / 2, Math.floor(0.005 * rate));
    const w = (2 * Math.PI * hz) / rate;
    const w2 = (2 * Math.PI * (hz + V1.partnerOffset)) / rate;
    const gain = partner ? 0.5 / (1 + V1.partnerGain) : 0.5;
    for (let i = 0; i < n && hz > 0; i++) {
      const env = Math.min(1, i / fade, (n - i) / fade);
      out[offset + i] = gain * env * (Math.sin(w * i) + (partner ? V1.partnerGain * Math.sin(w2 * i) : 0));
    }
    offset += n;
  }
  return out;
}

export function playTone(id: string, hz: number, seconds = 0.6) {
  return playSamples(id, (rate) => render([{ hz, seconds }], rate));
}

/** Version 1, timed as it was: start marker, each character's pitch and its partner tone, end marker. */
export function playV1(id: string, text: string) {
  const segments: Segment[] = [
    { hz: 0, seconds: V1.leadSeconds },
    { hz: V1.start, seconds: V1.markerSeconds },
    { hz: 0, seconds: V1.gapSeconds },
  ];
  for (const c of text.toUpperCase()) {
    const hz = V1_FREQUENCIES.get(c);
    if (hz) segments.push({ hz, seconds: V1.toneSeconds, partner: true }, { hz: 0, seconds: V1.gapSeconds });
  }
  segments.push({ hz: 0, seconds: V1.endPauseSeconds }, { hz: V1.end, seconds: V1.markerSeconds });
  return playSamples(id, (rate) => render(segments, rate));
}

/** Today's FAST mode, rendered by the real modem. */
export function playV2(id: string, text: string) {
  const modem = getModem('fast');
  const frame = { type: FrameType.Text, payload: new TextEncoder().encode(text) };
  return playSamples(id, (rate) => modem.modulate(frame, rate));
}

/** Ends the current demo immediately, whatever state its audio is in. */
export function stopSound() {
  if (current) end(current);
}
