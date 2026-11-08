// Owns the speaker: one transmission at a time, cancellable, and polite.
//
// The lock is taken synchronously when `run` is called, before any file
// reading or compression, so overlapping requests (double clicks, hotkeys)
// are refused instead of playing on top of each other.
// Each job carries the modem it was prepared for, so changing the mode while a
// job is being prepared or played cannot mix modes. Before talking it waits for
// any frame currently being received to finish (listen before talk).
//
// Progress follows the audio clock, so it stops if the output is suspended.
// The app cancels with reason 'interrupted' when that happens: resuming
// mid-frame after a gap would not keep the receiver's timing.

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
  /** Between handshake frames, listening for the other device; `label` says what for. */
  | { kind: 'handshake'; label: string }
  | SendingState;

export interface TxJob {
  modem: Modem;
  frames: Frame[];
  /** Keep decoding the microphone while sending (loopback self-test). */
  monitor?: boolean;
}

/** What `prepare` can do while it holds the speaker. */
export interface PrepareContext {
  /**
   * Play frames now, before the job's own (a handshake): waits for a clear
   * channel, mutes the receiver while playing and unmutes after. Rejects if
   * the job is cancelled, or `signal` aborts, before it finishes.
   */
  say(modem: Modem, frames: Frame[], signal?: AbortSignal): Promise<void>;
  /** Show that the job is waiting on the other device. */
  status(label: string): void;
}

/** 'user': the user cancelled or backed out. 'interrupted': audio stopped underneath us. */
export type CancelReason = 'user' | 'interrupted';

export type TxOutcome =
  | { status: 'sent'; duration: number }
  | { status: 'cancelled'; reason: CancelReason }
  | { status: 'busy' }
  | { status: 'failed'; error: Error };

export interface TransmitterDeps {
  sampleRate(): number;
  /** Seconds on the clock that drives playback (the AudioContext's currentTime). */
  clock(): number;
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

// Both helpers remove their abort listener when they settle normally, so a
// long job does not accumulate one per frame.
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

const abortError = () => new DOMException('cancelled', 'AbortError');

const untilDoneOrAborted = (done: Promise<void>, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    done.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
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

  cancel(reason: CancelReason = 'user') {
    this.active?.abort(reason);
  }

  /**
   * Prepare and play one job exclusively. `prepare` may return null to back
   * out (e.g. the user declined a long transfer).
   */
  async run(
    label: string,
    prepare: (signal: AbortSignal, context: PrepareContext) => Promise<TxJob | null>,
    onProgress?: (state: SendingState) => void,
  ): Promise<TxOutcome> {
    if (this.active) return { status: 'busy' };
    const controller = new AbortController();
    this.active = controller;
    const { signal } = controller;
    // Set once the job's own frames start playing; afterAudio is then owed.
    const audio = { started: false, at: 0 };
    let monitor = false;
    const cancelled = (): TxOutcome => ({ status: 'cancelled', reason: signal.reason === 'interrupted' ? 'interrupted' : 'user' });

    try {
      this.deps.onState({ kind: 'preparing', label });
      const context: PrepareContext = {
        say: async (modem, frames, extra) => {
          const sub = extra ? AbortSignal.any([signal, extra]) : signal;
          if (sub.aborted) throw abortError();
          const audio = { started: false, at: 0 };
          try {
            await this.play(label, modem, frames, sub, false, audio);
          } finally {
            if (audio.started) await this.deps.afterAudio(false);
          }
          if (sub.aborted) throw abortError();
        },
        status: (text) => {
          if (!signal.aborted) this.deps.onState({ kind: 'handshake', label: text });
        },
      };
      const job = await prepare(signal, context);
      if (!job || signal.aborted) return cancelled();
      monitor = job.monitor ?? false;
      await this.play(label, job.modem, job.frames, signal, monitor, audio, onProgress);
      if (signal.aborted) return cancelled();
      return { status: 'sent', duration: this.deps.clock() - audio.at };
    } catch (err) {
      if (signal.aborted) return cancelled();
      return { status: 'failed', error: err instanceof Error ? err : new Error(String(err)) };
    } finally {
      try {
        if (audio.started) await this.deps.afterAudio(monitor);
      } finally {
        this.active = null;
        this.deps.onState({ kind: 'idle' });
      }
    }
  }

  /**
   * Wait for a clear channel, then play the frames; stops early if `signal`
   * aborts. Sets `audio.started` (the caller then owes `afterAudio`, even if
   * this throws) and `audio.at`, the clock time playback began.
   */
  private async play(
    label: string,
    modem: Modem,
    frames: Frame[],
    signal: AbortSignal,
    monitor: boolean,
    audio: { started: boolean; at: number },
    onProgress?: (state: SendingState) => void,
  ): Promise<void> {
    const rate = this.deps.sampleRate();
    if (!modem.supports(rate)) throw new Error(`${modem.label} mode is not available at ${rate} Hz`);

    const waitStarted = Date.now();
    while (this.deps.channelBusy() && Date.now() - waitStarted < MAX_CHANNEL_WAIT_MS && !signal.aborted) {
      this.deps.onState({ kind: 'waiting', label, modem: modem.label });
      await sleep(CHANNEL_POLL_MS, signal);
    }
    if (signal.aborted) return;

    const total = airtimeOf(modem, frames);
    const started = this.deps.clock();
    let sent = 0;
    const report = () => {
      const elapsed = this.deps.clock() - started;
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

    audio.started = true;
    audio.at = started;
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
  }
}
