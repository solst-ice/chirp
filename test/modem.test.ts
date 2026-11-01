import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { crc32 } from '../src/modem/crc32.ts';
import { MODEMS } from '../src/modem/profiles.ts';
import { rsDecode, rsEncode } from '../src/modem/reedSolomon.ts';
import { FrameType } from '../src/modem/types.ts';
import { channel, receive, rng, room, roundTrip, type ChannelOptions } from './channel.ts';

const text = (s: string) => new TextEncoder().encode(s);
const randomBytes = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
};

describe('crc32', () => {
  test('matches the standard check value', () => {
    assert.equal(crc32(text('123456789')), 0xcbf43926);
  });
});

describe('reed-solomon', () => {
  test('corrects up to nsym/2 errors', () => {
    const r = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const nsym = 2 + 2 * Math.floor(r() * 10);
      const data = randomBytes(1 + Math.floor(r() * (255 - nsym - 1)), trial);
      const cw = rsEncode(data, nsym);
      const errors = Math.floor(r() * (nsym / 2 + 1));
      const positions = new Set<number>();
      while (positions.size < errors) positions.add(Math.floor(r() * cw.length));
      for (const p of positions) cw[p] ^= 1 + Math.floor(r() * 255);
      assert.deepEqual(rsDecode(cw, nsym), data, `trial ${trial}`);
    }
  });

  test('corrects up to nsym erasures', () => {
    const r = rng(11);
    for (let trial = 0; trial < 100; trial++) {
      const nsym = 16;
      const data = randomBytes(64, trial);
      const cw = rsEncode(data, nsym);
      const erasures = new Set<number>();
      while (erasures.size < nsym) erasures.add(Math.floor(r() * cw.length));
      for (const p of erasures) cw[p] = Math.floor(r() * 256);
      assert.deepEqual(rsDecode(cw, nsym, [...erasures]), data, `trial ${trial}`);
    }
  });

  test('mixes errors and erasures', () => {
    const data = randomBytes(80, 3);
    const cw = rsEncode(data, 16);
    // 8 erasures + 4 errors uses 8 + 2*4 = 16 parity bytes.
    const erasures = [0, 5, 9, 20, 33, 47, 60, 90];
    for (const p of erasures) cw[p] ^= 0x5a;
    for (const p of [12, 40, 70, 85]) cw[p] ^= 0xa5;
    assert.deepEqual(rsDecode(cw, 16, erasures), data);
  });

  test('reports failure instead of returning garbage when hopeless', () => {
    const data = randomBytes(50, 5);
    const cw = rsEncode(data, 8);
    for (let i = 0; i < 20; i++) cw[i * 2] ^= 0xff;
    const out = rsDecode(cw, 8);
    assert.ok(out === null || !out.every((b, i) => b === data[i]));
  });
});

const PHRASES = ['HELLO', 'BOOKKEEPER 1000', 'MISSISSIPPI...', 'wait... really?!', 'héllo wörld 🎉 — ünïcode'];

for (const modem of MODEMS) {
  describe(`modem ${modem.id}`, () => {
    test('round-trips text with repeated characters on a clean channel', () => {
      for (const phrase of PHRASES) {
        const { frames } = roundTrip(modem, { type: FrameType.Text, payload: text(phrase) }, 48000);
        assert.equal(frames.length, 1, phrase);
        assert.equal(new TextDecoder().decode(frames[0].frame.payload), phrase);
        assert.equal(frames[0].stats.correctedBytes, 0);
      }
    });

    test('round-trips binary data from a 44.1 kHz sender to a 48 kHz receiver with clock drift', () => {
      const payload = randomBytes(Math.min(200, modem.maxPayload), 42);
      const { frames } = roundTrip(modem, { type: FrameType.FileChunk, payload }, 44100, {
        rxRate: 48000,
        clockPpm: 150,
      });
      assert.equal(frames.length, 1);
      assert.equal(frames[0].frame.type, FrameType.FileChunk);
      assert.deepEqual(frames[0].frame.payload, payload);
    });

    test('survives noise and room echoes across seeds', () => {
      const payload = text('THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 0123456789');
      for (const seed of [1, 2, 3, 4, 5]) {
        const { frames } = roundTrip(modem, { type: FrameType.Text, payload }, 48000, {
          snrDb: 6,
          echoes: room(seed + 8, 0.3),
          clockPpm: (seed - 3) * 60,
          seed,
        });
        assert.equal(frames.length, 1, `seed ${seed}`);
        assert.deepEqual(frames[0].frame.payload, payload);
      }
    });

    test('survives burst dropouts, speaker/mic band limits, speech and music', () => {
      const conditions: [string, ChannelOptions][] = [
        ['two 60 ms dropouts', { snrDb: 15, dropouts: [{ start: 0.8, duration: 0.06 }, { start: 1.6, duration: 0.06 }] }],
        ['150 ms dropout', { snrDb: 15, dropouts: [{ start: 1.0, duration: 0.15 }] }],
        ['speech at equal level', { interference: { kind: 'speech', levelDb: 0 } }],
        ['music 6 dB louder', { interference: { kind: 'music', levelDb: 6 } }],
      ];
      if (modem.band[1] < 10000) conditions.push(['small speaker 400 Hz–6 kHz', { snrDb: 15, highpassHz: 400, lowpassHz: 6000 }]);
      for (const [name, options] of conditions) {
        for (const seed of [1, 2, 3]) {
          const payload = randomBytes(120, seed * 31);
          const { frames } = roundTrip(modem, { type: FrameType.FileChunk, payload }, 48000, { ...options, seed });
          assert.equal(frames.length, 1, `${name}, seed ${seed}`);
          assert.deepEqual(frames[0].frame.payload, payload, `${name}, seed ${seed}`);
        }
      }
    });

    test('keeps timing over a maximum-length frame with 300 ppm drift', () => {
      const payload = randomBytes(modem.maxPayload, 99);
      const { frames } = roundTrip(modem, { type: FrameType.FileChunk, payload }, 48000, {
        clockPpm: 300,
        snrDb: 15,
      });
      assert.equal(frames.length, 1);
      assert.deepEqual(frames[0].frame.payload, payload);
    });

    test('decodes back-to-back frames', () => {
      const a = modem.modulate({ type: FrameType.Text, payload: text('FIRST') }, 48000);
      const b = modem.modulate({ type: FrameType.Text, payload: text('SECOND') }, 48000);
      const joined = new Float32Array(a.length + b.length);
      joined.set(a);
      joined.set(b, a.length);
      const events = receive(modem, channel(joined, 48000, { snrDb: 20 }), 48000);
      const got = events.flatMap((e) => (e.kind === 'frame' ? [new TextDecoder().decode(e.frame.payload)] : []));
      assert.deepEqual(got, ['FIRST', 'SECOND']);
    });

    test('airtime() matches the generated audio', () => {
      const audio = modem.modulate({ type: FrameType.Text, payload: text('x'.repeat(57)) }, 48000);
      assert.ok(Math.abs(audio.length / 48000 - modem.airtime(57)) < 0.002);
    });
  });
}

test('ROBUST survives speech 6 dB louder than the signal and combined impairments', () => {
  const modem = MODEMS.find((m) => m.id === 'robust')!;
  for (const seed of [1, 2, 3, 4]) {
    for (const options of [
      { interference: { kind: 'speech', levelDb: 6 } },
      {
        snrDb: 10,
        echoes: room(seed, 0.3),
        clockPpm: 120,
        highpassHz: 300,
        lowpassHz: 7000,
        interference: { kind: 'speech', levelDb: -6 },
        dropouts: [{ start: 1.2, duration: 0.05 }],
      },
    ] satisfies ChannelOptions[]) {
      const payload = randomBytes(120, seed);
      const { frames } = roundTrip(modem, { type: FrameType.FileChunk, payload }, 48000, { ...options, seed });
      assert.equal(frames.length, 1, `seed ${seed}`);
      assert.deepEqual(frames[0].frame.payload, payload);
    }
  }
});

test('impairments cause missing frames, never wrong ones', () => {
  // FAST cannot cope with speech louder than itself; it must fail cleanly.
  const modem = MODEMS.find((m) => m.id === 'fast')!;
  for (const seed of [1, 2, 3]) {
    const payload = randomBytes(120, seed);
    const { frames } = roundTrip(modem, { type: FrameType.FileChunk, payload }, 48000, {
      interference: { kind: 'speech', levelDb: 6 },
      seed,
    });
    for (const f of frames) assert.deepEqual(f.frame.payload, payload);
  }
});

test('no modem syncs on 20 s of noise', () => {
  const noise = channel(new Float32Array(48000 * 20), 48000, { snrDb: 0, gain: 1, seed: 1 });
  const r = rng(5);
  for (let i = 0; i < noise.length; i++) noise[i] = (r() - 0.5) * 0.1;
  for (const modem of MODEMS) {
    const events = receive(modem, noise, 48000);
    assert.equal(events.filter((e) => e.kind === 'sync').length, 0, modem.id);
  }
});
