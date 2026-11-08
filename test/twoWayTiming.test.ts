// The whole two-way exchange with the timing that matters on real devices:
// each device has its own Transmitter and SessionManager, ignores its
// microphone while it plays and for ECHO_SETTLE_MS after, hears the other
// after a short acoustic delay, notices a transmission (listen before talk)
// only once its preamble and header are in, and loses anything it was not
// listening to from start to end, or that overlapped another transmission.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deriveKeys } from '../src/modem/encryption.ts';
import { getModem } from '../src/modem/profiles.ts';
import { FrameType, type Frame, type Modem } from '../src/modem/types.ts';
import { SessionManager, type SessionDeps } from '../src/transfer/sessions.ts';
import { ECHO_SETTLE_MS, TURNAROUND_MS, Transmitter } from '../src/transfer/transmitter.ts';

const PASSPHRASE = 'otter velvet canyon lamp orbit';
const RATE = 48000;
// Airtime runs at half speed of real FAST tones, to keep the test short; the delays that decide
// whether a frame is heard (echo settling, turnaround) are real.
const SCALE = 0.5;
const LATENCY_MS = 40;
/** Preamble (8 symbols) and header (5 symbols) of a FAST frame, at the test's speed. */
const DETECT_MS = 13 * 30 * SCALE;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

interface Sound {
  from: string;
  frame: Frame;
  start: number;
  end: number;
}

function room(options: Partial<SessionDeps> = {}, o: { turnaround?: boolean } = {}) {
  const air: Sound[] = [];
  const frameOf = new WeakMap<Float32Array, Frame>();
  const carrier = getModem('fast');
  const modem: Modem = {
    ...carrier,
    supports: () => true,
    airtime: (length) => carrier.airtime(length) * SCALE,
    modulate(frame) {
      const samples = new Float32Array(Math.round(carrier.airtime(frame.payload.length) * SCALE * RATE));
      frameOf.set(samples, frame);
      return samples;
    },
  };

  const devices = new Map<string, ReturnType<typeof device>>();

  const device = (name: string) => {
    const muted: [number, number][] = [];
    const received: string[] = [];
    const lost: Frame[] = [];
    const heardAt = (s: Sound) => [s.start + LATENCY_MS, s.end + LATENCY_MS] as const;
    const tx = new Transmitter({
      sampleRate: () => RATE,
      clock: () => now() / 1000,
      play(samples) {
        const sound: Sound = { from: name, frame: frameOf.get(samples)!, start: now(), end: now() + (samples.length / RATE) * 1000 };
        air.push(sound);
        setTimeout(() => deliver(sound), sound.end - sound.start + LATENCY_MS + 2);
        let stop!: () => void;
        const done = new Promise<void>((resolve) => {
          stop = resolve;
          setTimeout(resolve, sound.end - sound.start);
        });
        return { done, stop };
      },
      channelBusy: () =>
        air.some((s) => {
          const [from, to] = heardAt(s);
          return s.from !== name && now() >= from + DETECT_MS && now() <= to;
        }),
      quietMs: () => (o.turnaround === false ? Infinity : now() - Math.max(-Infinity, ...air.filter((s) => s.from !== name && heardAt(s)[1] <= now()).map((s) => heardAt(s)[1]))),
      beforeAudio: () => void muted.push([now(), Infinity]),
      afterAudio: async () => {
        await delay(ECHO_SETTLE_MS);
        muted[muted.length - 1][1] = now();
      },
      onState: () => {},
    });
    const manager = new SessionManager({
      keys: () => deriveKeys(PASSPHRASE),
      // As the app answers: only when the speaker is free, after the turnaround.
      answer(frame) {
        if (tx.busy) return false;
        void tx.run('answer', async () => ({ modem, frames: [frame] }));
        return true;
      },
      replyTimeoutMs: TURNAROUND_MS + modem.airtime(58) * 1000 + 1500,
      yieldBackoffMs: TURNAROUND_MS + 1200 * SCALE,
      retryJitterMs: 600,
      ...options,
    });
    manager.setEnabled(true);

    const deliver = (s: Sound) => {
      for (const [other, d] of devices) {
        if (other === s.from) continue;
        const [from, to] = heardAt(s);
        const deaf = d.muted.some(([a, b]) => a < to && b > from);
        const collided = air.some((o) => o !== s && o.start + LATENCY_MS < to && o.end + LATENCY_MS > from);
        if (deaf || collided) {
          d.lost.push(s.frame);
          continue;
        }
        if (s.frame.type === FrameType.Handshake) void d.manager.onHandshake(s.frame.payload);
        else
          void d.manager.open(s.frame.payload).then((r) => {
            if (r.ok) d.received.push(new TextDecoder().decode(r.frame.payload));
          });
      }
    };

    const send = (text: string) =>
      tx.run('message', async (signal, ctx) => {
        const session = await manager.establish((frame, sig) => ctx.say(modem, [frame], sig), signal);
        const frame = await manager.seal(session, { type: FrameType.Text, payload: new TextEncoder().encode(text) });
        return { modem, frames: [frame] };
      });

    return { name, tx, manager, muted, received, lost, send };
  };

  const add = (name: string) => {
    const d = device(name);
    devices.set(name, d);
    return d;
  };
  return { add, air };
}

/** Wait until every transmitter is idle and the last sound has been delivered. */
const settle = async (...devices: { tx: Transmitter }[]) => {
  do await delay(100);
  while (devices.some((d) => d.tx.busy));
  await delay(LATENCY_MS + 50);
};

describe('two-way exchange, with microphone muting and playback timing', () => {
  test('the first message of a new session is heard', async () => {
    const r = room();
    const a = r.add('a');
    const b = r.add('b');
    assert.equal((await a.send('first')).status, 'sent');
    await settle(a, b);
    assert.deepEqual(b.received, ['first']);
    assert.deepEqual(r.air.map((s) => `${s.from}:${s.frame.type}`), ['a:6', 'b:6', 'a:5']);
    // And the answer back, in the same session.
    assert.equal((await b.send('second')).status, 'sent');
    await settle(a, b);
    assert.deepEqual(a.received, ['second']);
  });

  test('without the turnaround, answers start while the other device is still muted, and nothing gets through', async () => {
    const r = room({}, { turnaround: false });
    const a = r.add('a');
    const b = r.add('b');
    await a.send('first');
    await settle(a, b);
    assert.deepEqual(b.received, []);
    // Every reply B played began while A was still ignoring its own echo.
    assert.ok(a.lost.length > 0 && a.lost.every((f) => f.type === FrameType.Handshake));
  });

  test('two devices sending at nearly the same time both get through', async () => {
    const r = room();
    const a = r.add('a');
    const b = r.add('b');
    const first = a.send('from a');
    // B starts once A's hello is recognisable, so it waits for the channel and the tie is decided.
    await delay(LATENCY_MS + DETECT_MS + 60);
    const second = b.send('from b');
    assert.deepEqual([(await first).status, (await second).status], ['sent', 'sent']);
    await settle(a, b);
    assert.deepEqual(b.received, ['from a']);
    assert.deepEqual(a.received, ['from b']);
  });
});
