import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ENCRYPTION_OVERHEAD,
  MAX_CLOCK_SKEW_S,
  ReplayGuard,
  decryptFrame,
  deriveKey,
  encryptFrame,
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
    const late = NOW + (MAX_CLOCK_SKEW_S + 60) * 1000;
    assert.deepEqual(await decryptFrame(key, sealed.payload, { now: late }), { ok: false, reason: 'clock', skew: -(MAX_CLOCK_SKEW_S + 60) });
    const early = NOW - (MAX_CLOCK_SKEW_S + 1) * 1000;
    assert.deepEqual(await decryptFrame(key, sealed.payload, { now: early }), { ok: false, reason: 'clock', skew: MAX_CLOCK_SKEW_S + 1 });
    // A 15-minute file transfer's last frame is still accepted.
    assert.ok((await decryptFrame(key, sealed.payload, { now: NOW + 15 * 60_000 })).ok);
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

  test('the replay guard notices a nonce it has seen and forgets the oldest beyond its limit', () => {
    const guard = new ReplayGuard(2);
    assert.equal(guard.replayed('a'), false);
    assert.equal(guard.replayed('a'), true);
    guard.replayed('b');
    guard.replayed('c');
    assert.equal(guard.replayed('a'), false);
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
