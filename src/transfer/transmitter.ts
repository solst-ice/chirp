// Owns the speaker: one transmission at a time, cancellable, and polite.
//
// The lock is taken synchronously when `run` is called, before any file
// reading or compression, so overlapping requests (double clicks, hotkeys,
// automatic demo replies) are refused instead of playing on top of each other.
// Each job carries the modem it was prepared for, so changing the mode while a
// job is being prepared or played cannot mix modes. Before talking it waits for
// any frame currently being received to finish (listen before talk).

import type { Frame, Modem } from '../modem/types.ts';

export const FRAME_GAP_MS = 120;
const CHANNEL_POLL_MS = 100;
const MAX_CHANNEL_WAIT_MS = 120_000;
const PROGRESS_MS = 100;

export interface Playback {
  done: Promise<void>;
  stop(): void;
}

export interface SendingState {
  kind: 'sending';
  label: string;
  modem: string;
  progress: number;
  /** Seconds of audio left. */
  remaining: number;
  framesSent: number;
  frames: number;
}

export type TxState =
  | { kind: 'idle' }
  | { kind: 'preparing'; label: string }
  | { kind: 'waiting'; label: string; modem: string }
  | SendingState;

export interface TxJob {
  modem: Modem;
  frames: Frame[];
  /** Keep decoding the microphone while sending (loopback self-test). */
  monitor?: boolean;
}

export type TxOutcome =
  | { status: 'sent'; duration: number }
  | { status: 'cancelled' }
  | { status: 'busy' }
  | { status: 'failed'; error: Error };

export interface TransmitterDeps {
  sampleRate(): number;
  play(samples: Float32Array): Playback;
  /** True while a frame from another device is being received. */
  channelBusy(): boolean;
  /** Called just before the first frame plays. */
  beforeAudio(monitor: boolean): void;
  /** Called once after audio stops (finished, cancelled or failed); may wait for echoes. */
  afterAudio(monitor: boolean): Promise<void>;
  onState(state: TxState): void;
}

/** Seconds of audio a job will take, including gaps between frames. */
export const airtimeOf = (modem: Modem, frames: Frame[]) =>
  frames.reduce((t, f) => t + modem.airtime(f.payload.length), 0) + (Math.max(0, frames.length - 1) * FRAME_GAP_MS) / 1000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

const untilDoneOrAborted = (done: Promise<void>, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
    done.then(resolve, reject);
  });

export class Transmitter {
  private readonly deps: TransmitterDeps;
  private active: AbortController | null = null;

  constructor(deps: TransmitterDeps) {
    this.deps = deps;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  cancel() {
    this.active?.abort();
  }

  /**
   * Prepare and play one job exclusively. `prepare` may return null to back
   * out (e.g. the user declined a long transfer).
   */
  async run(
    label: string,
    prepare: (signal: AbortSignal) => Promise<TxJob | null>,
    onProgress?: (state: SendingState) => void,
  ): Promise<TxOutcome> {
    if (this.active) return { status: 'busy' };
    const controller = new AbortController();
    this.active = controller;
    const { signal } = controller;
    let audioStarted = false;
    let monitor = false;

    try {
      this.deps.onState({ kind: 'preparing', label });
      const job = await prepare(signal);
      if (!job || signal.aborted) return { status: 'cancelled' };
      const { modem, frames } = job;
      monitor = job.monitor ?? false;
      const rate = this.deps.sampleRate();
      if (!modem.supports(rate)) throw new Error(`${modem.label} mode is not available at ${rate} Hz`);

      const waitStarted = Date.now();
      while (this.deps.channelBusy() && Date.now() - waitStarted < MAX_CHANNEL_WAIT_MS && !signal.aborted) {
        this.deps.onState({ kind: 'waiting', label, modem: modem.label });
        await sleep(CHANNEL_POLL_MS, signal);
      }
      if (signal.aborted) return { status: 'cancelled' };

      const total = airtimeOf(modem, frames);
      const started = performance.now();
      let sent = 0;
      const report = () => {
        const elapsed = (performance.now() - started) / 1000;
        const state: SendingState = {
          kind: 'sending',
          label,
          modem: modem.label,
          progress: Math.min(0.99, elapsed / total),
          remaining: Math.max(0, total - elapsed),
          framesSent: sent,
          frames: frames.length,
        };
        this.deps.onState(state);
        onProgress?.(state);
      };

      audioStarted = true;
      this.deps.beforeAudio(monitor);
      report();
      const timer = setInterval(report, PROGRESS_MS);
      try {
        for (let i = 0; i < frames.length && !signal.aborted; i++) {
          // Rendered one frame at a time: a long file would not fit in memory as audio.
          const playback = this.deps.play(modem.modulate(frames[i], rate));
          await untilDoneOrAborted(playback.done, signal);
          if (signal.aborted) {
            playback.stop();
            break;
          }
          sent = i + 1;
          if (i < frames.length - 1) await sleep(FRAME_GAP_MS, signal);
        }
      } finally {
        clearInterval(timer);
      }
      if (signal.aborted) return { status: 'cancelled' };
      return { status: 'sent', duration: (performance.now() - started) / 1000 };
    } catch (err) {
      if (signal.aborted) return { status: 'cancelled' };
      return { status: 'failed', error: err instanceof Error ? err : new Error(String(err)) };
    } finally {
      try {
        if (audioStarted) await this.deps.afterAudio(monitor);
      } finally {
        this.active = null;
        this.deps.onState({ kind: 'idle' });
      }
    }
  }
}
