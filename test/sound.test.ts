import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

// A stand-in for the browser's AudioContext. Sources never end on their own;
// a test ends them with `finish()`, or never, as an interrupted context would.
class FakeSource {
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  buffer: unknown = null;
  connect() {}
  disconnect() {}
  start() {
    started.push(this);
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  finish() {
    this.onended?.();
  }
}

class FakeContext {
  state: AudioContextState = 'running';
  sampleRate = 48000;
  resumes = 'succeed' as 'succeed' | 'fail' | 'hang';
  destination = {};
  private listeners: (() => void)[] = [];
  addEventListener(_: string, l: () => void) {
    this.listeners.push(l);
  }
  setState(state: AudioContextState) {
    this.state = state;
    this.listeners.forEach((l) => l());
  }
  resume() {
    if (this.resumes === 'fail') return Promise.reject(new Error('not allowed'));
    if (this.resumes === 'hang') return new Promise<void>(() => {});
    this.setState('running');
    return Promise.resolve();
  }
  createBuffer(_: number, length: number) {
    return { length, copyToChannel() {} };
  }
  createBufferSource() {
    return new FakeSource();
  }
}

let started: FakeSource[] = [];
const contexts: FakeContext[] = [];
(globalThis as unknown as { window: unknown }).window = {
  AudioContext: class extends FakeContext {
    constructor() {
      super();
      contexts.push(this);
    }
  },
};
const sound = await import('../src/explainer/sound.ts');
// The module makes one context on first use and keeps it.
void sound.playTone('setup', 440);
sound.stopSound();
const fake = contexts[0];

const read = sound.soundState;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('explainer demo playback', () => {
  beforeEach(async () => {
    sound.stopSound();
    started = [];
    fake.state = 'running';
    fake.resumes = 'succeed';
    await tick();
  });

  test('plays and clears when the sound ends', async () => {
    const done = sound.playTone('tone', 440);
    await tick();
    assert.equal(read().playing, 'tone');
    assert.equal(started.length, 1);
    started[0].finish();
    await done;
    assert.deepEqual(read(), { playing: null, error: null });
  });

  test('STOP clears at once even if the source never reports ending', async () => {
    const done = sound.playTone('tone', 440);
    await tick();
    fake.state = 'suspended'; // Suspended without an event: onended will never fire.
    sound.stopSound();
    assert.equal(read().playing, null);
    assert.equal(started[0].stopped, true);
    await done;
  });

  test('a context suspended mid-demo ends it and says why', async () => {
    const done = sound.playTone('tone', 440);
    await tick();
    fake.setState('suspended');
    await done;
    assert.deepEqual(read(), { playing: null, error: { id: 'tone', message: 'audio was interrupted' } });
  });

  test('a context that will not resume fails visibly instead of sticking', async () => {
    fake.state = 'suspended';
    fake.resumes = 'fail';
    await sound.playV1('v1', 'HI');
    assert.equal(started.length, 0);
    assert.deepEqual(read(), { playing: null, error: { id: 'v1', message: 'audio is paused · press again' } });
  });

  test('stopping while the context resumes never starts the sound', async () => {
    fake.state = 'suspended';
    fake.resumes = 'hang';
    const done = sound.playTone('tone', 440);
    assert.equal(read().playing, 'tone');
    sound.stopSound();
    await done;
    assert.equal(read().playing, null);
    await new Promise((r) => setTimeout(r, 1100)); // Past the resume timeout.
    assert.equal(started.length, 0);
    assert.equal(read().error, null);
  });

  test('a new demo replaces the current one', async () => {
    const first = sound.playTone('tone', 440);
    await tick();
    const second = sound.playV2('v2', 'HI');
    await first;
    await tick();
    assert.equal(started[0].stopped, true);
    assert.equal(read().playing, 'v2');
    started[1].finish();
    await second;
    assert.equal(read().playing, null);
  });
});
