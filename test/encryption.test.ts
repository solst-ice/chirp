import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ENCRYPTION_OVERHEAD,
  MAX_AGE_S,
  MAX_AHEAD_S,
  MAX_CLOCK_SKEW_S,
  ReplayGuard,
  decryptFrame,
  deriveKey,
  deriveKeys,
  encryptFrame,
  forgetKey,
  generateKey,
  normalizeKey,
} from '../src/modem/encryption.ts';
import { FileAssembler, buildFileFrames } from '../src/modem/fileTransfer.ts';
import { getModem } from '../src/modem/profiles.ts';
import { FrameType } from '../src/modem/types.ts';
import { roundTrip } from './channel.ts';

const text = (s: string) => new TextEncoder().encode(s);
const PASSPHRASE = 'otter velvet canyon lamp orbit';
const NOW = Date.UTC(2026, 10, 7, 12);

describe('encryption', () => {
  test('a sealed frame opens with the same key and adds exactly the stated overhead', async () => {
    const key = await deriveKey(PASSPHRASE);
    const frame = { type: FrameType.Text, payload: text('meet at the north gate ✓') };
    const sealed = await encryptFrame(key, frame, { now: NOW });
    assert.equal(sealed.type, FrameType.Encrypted);
    assert.equal(sealed.payload.length, frame.payload.length + ENCRYPTION_OVERHEAD);
    const opened = await decryptFrame(key, sealed.payload, { now: NOW });
    assert.ok(opened.ok);
    assert.deepEqual(opened.frame, frame);
    assert.equal(opened.sentAt, NOW / 1000);
  });

  test('the same message sealed twice looks different on the wire', async () => {
    const key = await deriveKey(PASSPHRASE);
    const frame = { type: FrameType.Text, payload: text('hello') };
    const [a, b] = await Promise.all([encryptFrame(key, frame), encryptFrame(key, frame)]);
    assert.notDeepEqual(a.payload, b.payload);
  });

  test('a different key, or any altered byte, is refused', async () => {
    const key = await deriveKey(PASSPHRASE);
    const sealed = await encryptFrame(key, { type: FrameType.Text, payload: text('secret') }, { now: NOW });
    const other = await deriveKey('otter velvet canyon lamp orbiT');
    assert.deepEqual(await decryptFrame(other, sealed.payload, { now: NOW }), { ok: false, reason: 'key' });

    const key2 = await deriveKey(PASSPHRASE);
    for (let i = 1; i < sealed.payload.length; i++) {
      const altered = sealed.payload.slice();
      altered[i] ^= 0x01;
      assert.deepEqual(await decryptFrame(key2, altered, { now: NOW }), { ok: false, reason: 'key' }, `byte ${i}`);
    }
    const versioned = sealed.payload.slice();
    versioned[0] = 2;
    assert.deepEqual(await decryptFrame(key2, versioned, { now: NOW }), { ok: false, reason: 'format' });
    assert.deepEqual(await decryptFrame(key2, sealed.payload.slice(0, ENCRYPTION_OVERHEAD - 1)), { ok: false, reason: 'format' });
  });

  test('frames sent too long ago or too far ahead are refused with their skew', async () => {
    const key = await deriveKey(PASSPHRASE);
    const sealed = await encryptFrame(key, { type: FrameType.Text, payload: text('hi') }, { now: NOW });
    const at = (s: number) => decryptFrame(key, sealed.payload, { now: NOW + s * 1000 });
    assert.ok((await at(MAX_AGE_S)).ok);
    assert.deepEqual(await at(MAX_AGE_S + 1), { ok: false, reason: 'clock', skew: -(MAX_AGE_S + 1) });
    assert.ok((await at(-MAX_AHEAD_S)).ok);
    assert.deepEqual(await at(-MAX_AHEAD_S - 1), { ok: false, reason: 'clock', skew: MAX_AHEAD_S + 1 });
  });

  test('the last frame of a 15-minute transfer, after a 2-minute wait, is accepted at the full clock difference', async () => {
    const key = await deriveKey(PASSPHRASE);
    // The sender's clock is MAX_CLOCK_SKEW_S behind; the frame is sealed before the wait and the transfer.
    const sealed = await encryptFrame(key, { type: FrameType.FileChunk, payload: text('last') }, { now: NOW - MAX_CLOCK_SKEW_S * 1000 });
    const received = NOW + (2 + 15) * 60_000;
    assert.ok((await decryptFrame(key, sealed.payload, { now: received })).ok);
  });

  test('only text and file frames can be sealed', async () => {
    const key = await deriveKey(PASSPHRASE);
    await assert.rejects(encryptFrame(key, { type: FrameType.SelfTest, payload: text('x') }));
    await assert.rejects(encryptFrame(key, { type: FrameType.Encrypted, payload: text('x') }));
  });

  test('passphrases are normalised, and an empty one is refused', async () => {
    assert.equal(normalizeKey('  café tram \n'), 'café tram');
    const key = await deriveKey('  ' + PASSPHRASE.normalize('NFD') + ' ');
    const sealed = await encryptFrame(key, { type: FrameType.Text, payload: text('same key') });
    assert.ok((await decryptFrame(await deriveKey(PASSPHRASE), sealed.payload)).ok);
    await assert.rejects(deriveKey('   '), /pre-shared key/);
  });

  test('the replay guard remembers a nonce for as long as its frame could still be accepted', () => {
    const sentAt = NOW / 1000;
    const guard = new ReplayGuard();
    assert.equal(guard.replayed('a', sentAt, NOW), false);
    assert.equal(guard.replayed('a', sentAt, NOW), true);
    // Many other frames in between do not push it out.
    for (let i = 0; i < 5000; i++) guard.replayed(`n${i}`, sentAt, NOW);
    assert.equal(guard.replayed('a', sentAt, NOW + MAX_AGE_S * 1000), true);
    // Once decryptFrame would refuse the frame for its age, the guard lets the entry go.
    assert.equal(guard.replayed('a', sentAt, NOW + (MAX_AGE_S + 1) * 1000), false);
  });

  test('the replay guard drops its oldest entries only past its limit', () => {
    const sentAt = NOW / 1000;
    const guard = new ReplayGuard(2);
    guard.replayed('a', sentAt, NOW);
    guard.replayed('b', sentAt, NOW);
    guard.replayed('c', sentAt, NOW);
    assert.equal(guard.replayed('b', sentAt, NOW), true);
    assert.equal(guard.replayed('a', sentAt, NOW), false);
  });

  test('generated keys are 25 unambiguous random characters in five groups', () => {
    const keys = new Set(Array.from({ length: 200 }, generateKey));
    assert.equal(keys.size, 200);
    for (const key of keys) assert.match(key, /^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){4}$/);
    // Every symbol of the alphabet turns up, so no bits are lost.
    assert.equal(new Set([...keys].join('').replaceAll('-', '')).size, 32);
  });

  test('forgetting the key drops the cached derivation', async () => {
    const first = deriveKeys(PASSPHRASE);
    assert.equal(deriveKeys(PASSPHRASE), first);
    forgetKey();
    assert.notEqual(deriveKeys(PASSPHRASE), first);
  });

  test('an encrypted file survives the FAST modem and reassembles from frames opened in any order', async () => {
    const key = await deriveKey(PASSPHRASE);
    const data = text('chirp '.repeat(60));
    const modem = getModem('fast');
    const { frames } = buildFileFrames({ fileId: 7, name: 'n.txt', mime: 'text/plain', size: data.length, data, compressed: false, chunkSize: 200 });
    const sealed = await Promise.all(frames.map((f) => encryptFrame(key, f)));
    assert.ok(sealed.every((f) => f.payload.length <= modem.maxPayload));

    const received = sealed.map((f) => {
      const { frames: out } = roundTrip(modem, f, 48000, { snrDb: 25 });
      assert.equal(out.length, 1);
      return out[0].frame;
    });
    const assembler = new FileAssembler();
    let done: Uint8Array | undefined;
    for (const f of received.reverse()) {
      const opened = await decryptFrame(key, f.payload);
      assert.ok(opened.ok);
      done = assembler.accept(opened.frame)?.data ?? done;
    }
    assert.deepEqual(done, data);
  });
});
