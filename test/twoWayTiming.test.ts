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
import { ECHO_SETTLE_MS, Transmitter, holdoffAfter } from '../src/transfer/transmitter.ts';

const PASSPHRASE = 'otter velvet canyon lamp orbit';
const RATE = 48000;
const LATENCY_MS = 40;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

interface Sound {
  from: string;
  frame: Frame;
  start: number;
  end: number;
}

/**
 * `scale` speeds up airtime (and with it header time) to keep a test short;
 * 1 is real FAST tones. Echo settling, turnaround and frame gaps stay real.
 * `turnaround: false` removes the hold-off after hearing a frame, as before the fix.
 */
function room(o: { scale?: number; turnaround?: boolean; deps?: Partial<SessionDeps> } = {}) {
  const scale = o.scale ?? 1;
  const air: Sound[] = [];
  const frameOf = new WeakMap<Float32Array, Frame>();
  const carrier = getModem('fast');
  const modem: Modem = {
    ...carrier,
    supports: () => true,
    airtime: (length) => carrier.airtime(length) * scale,
    headerSeconds: carrier.headerSeconds * scale,
    modulate(frame) {
      const samples = new Float32Array(Math.round(carrier.airtime(frame.payload.length) * scale * RATE));
      frameOf.set(samples, frame);
      return samples;
    },
  };
  const detectMs = modem.headerSeconds * 1000;
  const devices = new Map<string, ReturnType<typeof device>>();

  const device = (name: string) => {
    const muted: [number, number][] = [];
    const received: string[] = [];
    const lost: Frame[] = [];
    const listeners: ((text: string) => void)[] = [];
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
          return s.from !== name && now() >= from + detectMs && now() <= to;
        }),
      lastHeard: () => {
        if (o.turnaround === false) return null;
        const ends = air.filter((s) => s.from !== name && heardAt(s)[1] <= now()).map((s) => heardAt(s)[1]);
        return ends.length ? { agoMs: now() - Math.max(...ends), modem } : null;
      },
      beforeAudio: () => void muted.push([now(), Infinity]),
      afterAudio: async () => {
        await delay(ECHO_SETTLE_MS);
        muted[muted.length - 1][1] = now();
      },
      onState: () => {},
    });
    const manager = new SessionManager({
      keys: () => deriveKeys(PASSPHRASE),
      // As the app answers: only when the speaker is free; listen before talk adds the hold-off.
      answer(frame) {
        if (tx.busy) return false;
        void tx.run('answer', async () => ({ modem, frames: [frame] }));
        return true;
      },
      // The same formulas as the app.
      replyTimeoutMs: holdoffAfter(modem) + modem.airtime(58) * 1000 + 2500,
      yieldBackoffMs: holdoffAfter(modem) + modem.headerSeconds * 1000 + 400,
      retryJitterMs: 1500,
      ...o.deps,
    });
    manager.setEnabled(true);

    const deliver = (s: Sound) => {
      for (const [other, d] of devices) {
        if (other === s.from) continue;
        const [from, to] = heardAt(s);
        const deaf = d.muted.some(([a, b]) => a < to && b > from);
        const collided = air.some((x) => x !== s && x.start + LATENCY_MS < to && x.end + LATENCY_MS > from);
        if (deaf || collided) {
          d.lost.push(s.frame);
          continue;
        }
        if (s.frame.type === FrameType.Handshake) void d.manager.onHandshake(s.frame.payload);
        else
          void d.manager.open(s.frame.payload).then((r) => {
            if (!r.ok) return;
            const text = new TextDecoder().decode(r.frame.payload);
            d.received.push(text);
            for (const l of d.listeners) l(text);
          });
      }
    };

    /** Send `frames` text frames in one job, like a file transfer: `${label}1`, `${label}2`, … */
    const send = (label: string, frames = 1) =>
      tx.run('message', async (signal, ctx) => {
        const session = await manager.establish((frame, sig) => ctx.say(modem, [frame], sig), signal);
        const sealed = [];
        for (let i = 1; i <= frames; i++) {
          const text = frames === 1 ? label : `${label}${i}`;
          sealed.push(await manager.seal(session, { type: FrameType.Text, payload: new TextEncoder().encode(text) }));
        }
        return { modem, frames: sealed };
      });

    return { name, tx, manager, muted, received, lost, listeners, send };
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

const range = (label: string, n: number) => Array.from({ length: n }, (_, i) => `${label}${i + 1}`);

describe('two-way exchange, with microphone muting and playback timing', () => {
  test('the first message of a new session is heard', async () => {
    const r = room({ scale: 0.5 });
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

  test('without the hold-off, answers start while the other device is still muted, and nothing gets through', async () => {
    const r = room({ scale: 0.5, turnaround: false });
    const a = r.add('a');
    const b = r.add('b');
    await a.send('first');
    await settle(a, b);
    assert.deepEqual(b.received, []);
    // Every reply B played began while A was still ignoring its own echo.
    assert.ok(a.lost.length > 0 && a.lost.every((f) => f.type === FrameType.Handshake));
  });

  test('at real speed, two devices sending multi-frame transfers at nearly the same time lose nothing', async () => {
    const r = room();
    const a = r.add('a');
    const b = r.add('b');
    const first = a.send('a', 4);
    // B starts once A's hello is recognisable, so it waits for the channel and the tie is decided.
    await delay(LATENCY_MS + getModem('fast').headerSeconds * 1000 + 60);
    const second = b.send('b', 4);
    assert.deepEqual([(await first).status, (await second).status], ['sent', 'sent']);
    await settle(a, b);
    assert.deepEqual(b.received, range('a', 4));
    assert.deepEqual(a.received, range('b', 4));
    assert.deepEqual([...a.lost, ...b.lost], []);
  });

  test('at real speed, a send started between the frames of a transfer waits for the transfer to end', async () => {
    const r = room();
    const a = r.add('a');
    const b = r.add('b');
    assert.equal((await a.send('hello')).status, 'sent');
    await settle(a, b);
    // B already has the session, so its send goes straight to listen before talk, right in a frame gap.
    let reply: ReturnType<typeof b.send> | undefined;
    b.listeners.push((text) => {
      if (text === 'a1') reply = b.send('reply');
    });
    assert.equal((await a.send('a', 4)).status, 'sent');
    await settle(a, b);
    assert.equal((await reply!).status, 'sent');
    await settle(a, b);
    assert.deepEqual(b.received, ['hello', ...range('a', 4)]);
    assert.deepEqual(a.received, ['reply']);
    assert.deepEqual([...a.lost, ...b.lost], []);
  });
});
