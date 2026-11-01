import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getModem } from '../src/modem/profiles.ts';
import { FrameType, type Frame, type Modem } from '../src/modem/types.ts';
import { Transmitter, type TransmitterDeps, type TxState } from '../src/transfer/transmitter.ts';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (s: string): Frame => ({ type: FrameType.Text, payload: new TextEncoder().encode(s) });

function harness(opts: { playMs?: number; channelBusyFor?: number } = {}) {
  let playing = 0;
  const log = {
    maxConcurrent: 0,
    played: [] as number[],
    stopped: 0,
    before: 0,
    after: 0,
    states: [] as TxState['kind'][],
  };
  const busyUntil = Date.now() + (opts.channelBusyFor ?? 0);
  const deps: TransmitterDeps = {
    sampleRate: () => 48000,
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
    beforeAudio: () => void log.before++,
    afterAudio: async () => void log.after++,
    onState: (s) => log.states.push(s.kind),
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
    assert.deepEqual(await run, { status: 'cancelled' });
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
    assert.deepEqual(await run, { status: 'cancelled' });
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
    assert.deepEqual(await tx.run('a', async () => null), { status: 'cancelled' });
  });
});
