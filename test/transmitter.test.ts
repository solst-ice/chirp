import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getModem } from '../src/modem/profiles.ts';
import { FrameType, type Frame, type Modem } from '../src/modem/types.ts';
import { FRAME_GAP_MS, TURNAROUND_MS, Transmitter, holdoffAfter, type TransmitterDeps, type TxState } from '../src/transfer/transmitter.ts';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (s: string): Frame => ({ type: FrameType.Text, payload: new TextEncoder().encode(s) });

function harness(opts: { playMs?: number; channelBusyFor?: number; clock?: () => number; heardAgoMs?: number } = {}) {
  let playing = 0;
  const log = {
    maxConcurrent: 0,
    played: [] as number[],
    stopped: 0,
    before: 0,
    after: 0,
    states: [] as TxState['kind'][],
    progress: [] as number[],
  };
  const busyUntil = Date.now() + (opts.channelBusyFor ?? 0);
  const heardAt = Date.now() - (opts.heardAgoMs ?? 0);
  const deps: TransmitterDeps = {
    sampleRate: () => 48000,
    clock: opts.clock ?? (() => performance.now() / 1000),
    play(samples) {
      playing++;
      log.maxConcurrent = Math.max(log.maxConcurrent, playing);
      log.played.push(samples.length);
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
        setTimeout(resolve, opts.playMs ?? 5);
      }).finally(() => playing--);
      return { done, stop: () => (log.stopped++, finish()) };
    },
    channelBusy: () => Date.now() < busyUntil,
    lastHeard: () => (opts.heardAgoMs === undefined ? null : { agoMs: Date.now() - heardAt, modem: getModem('fast') }),
    beforeAudio: () => void log.before++,
    afterAudio: async () => void log.after++,
    onState: (s) => {
      log.states.push(s.kind);
      if (s.kind === 'sending') log.progress.push(s.progress);
    },
  };
  return { tx: new Transmitter(deps), log };
}

const job = (modem: Modem, frames: Frame[], prepareMs = 0) => async () => {
  await delay(prepareMs);
  return { modem, frames };
};

describe('transmitter', () => {
  test('refuses a second request while the first is still preparing', async () => {
    const { tx, log } = harness();
    const fast = getModem('fast');
    const first = tx.run('a', job(fast, [text('one')], 30));
    assert.equal(tx.busy, true);
    assert.deepEqual(await tx.run('b', job(fast, [text('two')])), { status: 'busy' });
    assert.equal((await first).status, 'sent');
    assert.equal(log.maxConcurrent, 1);
    assert.equal(tx.busy, false);
  });

  test('plays with the modem the job was prepared for', async () => {
    const { tx, log } = harness();
    const robust = getModem('robust');
    await tx.run('a', job(robust, [text('hi')]));
    assert.deepEqual(log.played, [robust.modulate(text('hi'), 48000).length]);
  });

  test('cancel stops the current frame and skips the rest', async () => {
    const { tx, log } = harness({ playMs: 1000 });
    const run = tx.run('file', job(getModem('fast'), [text('a'), text('b'), text('c')]));
    await delay(50);
    tx.cancel();
    assert.deepEqual(await run, { status: 'cancelled', reason: 'user' });
    assert.equal(log.played.length, 1);
    assert.equal(log.stopped, 1);
    assert.equal(log.after, 1);
    assert.equal(log.states.at(-1), 'idle');
    assert.equal(tx.busy, false);
  });

  test('cancel during preparation never touches the speaker', async () => {
    const { tx, log } = harness();
    const run = tx.run('file', job(getModem('fast'), [text('a')], 50));
    tx.cancel();
    assert.deepEqual(await run, { status: 'cancelled', reason: 'user' });
    assert.equal(log.played.length + log.before + log.after, 0);
  });

  test('waits for a reception in progress before talking', async () => {
    const { tx, log } = harness({ channelBusyFor: 250 });
    const started = Date.now();
    assert.equal((await tx.run('a', job(getModem('fast'), [text('x')]))).status, 'sent');
    assert.ok(log.states.includes('waiting'));
    assert.ok(Date.now() - started >= 240);
  });

  test('a failing preparation releases the lock', async () => {
    const { tx } = harness();
    const out = await tx.run('a', async () => {
      throw new Error('cannot read file');
    });
    assert.equal(out.status, 'failed');
    assert.equal(tx.busy, false);
    assert.equal((await tx.run('b', job(getModem('fast'), [text('ok')]))).status, 'sent');
  });

  test('backing out of a job reports cancelled', async () => {
    const { tx } = harness();
    assert.deepEqual(await tx.run('a', async () => null), { status: 'cancelled', reason: 'user' });
  });

  test('an audio interruption cancels with its own reason', async () => {
    const { tx, log } = harness({ playMs: 1000 });
    const run = tx.run('file', job(getModem('fast'), [text('a'), text('b')]));
    await delay(50);
    tx.cancel('interrupted');
    assert.deepEqual(await run, { status: 'cancelled', reason: 'interrupted' });
    assert.equal(log.stopped, 1);
    assert.equal(tx.busy, false);
  });

  test('progress follows the audio clock, not wall time', async () => {
    // A suspended context: its clock does not advance.
    const { tx, log } = harness({ playMs: 400, clock: () => 12.5 });
    await tx.run('a', job(getModem('fast'), [text('x')]));
    assert.ok(log.progress.length >= 3);
    assert.ok(log.progress.every((p) => p === 0), String(log.progress));
  });
  test('a job can play handshake frames first, under the same lock, unmuting after each', async () => {
    const { tx, log } = harness();
    const fast = getModem('fast');
    const out = await tx.run('message', async (_signal, ctx) => {
      await ctx.say(fast, [text('hello')]);
      ctx.status('waiting for an answer');
      assert.equal(log.after, 1, 'unmuted to hear the answer');
      assert.equal(tx.busy, true);
      return { modem: fast, frames: [text('data')] };
    });
    assert.equal(out.status, 'sent');
    assert.equal(log.played.length, 2);
    assert.equal(log.before, 2);
    assert.equal(log.after, 2);
    assert.ok(log.states.includes('handshake'));
  });

  test('aborting a handshake frame before it plays leaves the job running', async () => {
    const { tx, log } = harness({ channelBusyFor: 200 });
    const fast = getModem('fast');
    const out = await tx.run('message', async (_signal, ctx) => {
      const decided = new AbortController();
      setTimeout(() => decided.abort(), 50);
      await assert.rejects(ctx.say(fast, [text('hello')], decided.signal), { name: 'AbortError' });
      return { modem: fast, frames: [text('data')] };
    });
    assert.equal(out.status, 'sent');
    assert.equal(log.played.length, 1);
    assert.equal(log.before, log.after);
  });

  test('cancelling while waiting for an answer cancels the job', async () => {
    const { tx, log } = harness();
    const fast = getModem('fast');
    const run = tx.run('message', async (signal, ctx) => {
      await ctx.say(fast, [text('hello')]);
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      return null;
    });
    await delay(50);
    tx.cancel();
    assert.deepEqual(await run, { status: 'cancelled', reason: 'user' });
    assert.equal(log.before, log.after);
    assert.equal(tx.busy, false);
  });
  test('after hearing a frame, stays quiet long enough to notice the next frame of the same transfer', async () => {
    const fast = getModem('fast');
    // The next frame starts after the frame gap and is noticed once its header is in.
    assert.ok(holdoffAfter(fast) > FRAME_GAP_MS + fast.headerSeconds * 1000);
    assert.ok(holdoffAfter(fast) >= TURNAROUND_MS);
    // Slower modes take longer to recognise, so they hold off longer.
    assert.ok(holdoffAfter(getModem('inaudible')) > holdoffAfter(fast) + 500);
    const { tx } = harness({ heardAgoMs: 0 });
    const started = Date.now();
    assert.equal((await tx.run('a', job(fast, [text('x')]))).status, 'sent');
    assert.ok(Date.now() - started >= holdoffAfter(fast) - 10, `${Date.now() - started} ms`);
  });
});
