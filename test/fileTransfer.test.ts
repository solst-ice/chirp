import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_LIMITS,
  FileAssembler,
  MAX_FILE_BYTES,
  buildFileFrames,
  chunkSizeFor,
  decodeManifest,
  decompress,
  encodeManifest,
  maybeCompress,
  type FileManifest,
} from '../src/modem/fileTransfer.ts';
import { getModem } from '../src/modem/profiles.ts';
import { FrameType } from '../src/modem/types.ts';
import { channel, receive, rng } from './channel.ts';

const bytes = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
};

const options = (data: Uint8Array) => ({
  fileId: 4242,
  name: 'notes ✓.txt',
  mime: 'text/plain',
  size: data.length,
  data,
  compressed: false,
  chunkSize: 100,
});

describe('file transfer', () => {
  test('manifest round-trips and truncates long names on character boundaries', () => {
    const { manifest } = buildFileFrames(options(bytes(10, 1)));
    assert.deepEqual(decodeManifest(encodeManifest(manifest)), manifest);
    const long = decodeManifest(encodeManifest({ ...manifest, name: '🎉'.repeat(40) }))!;
    assert.equal(long.name, '🎉'.repeat(25));
  });

  test('assembles shuffled, duplicated chunks with the manifest arriving last', () => {
    const data = bytes(1234, 2);
    const { frames } = buildFileFrames(options(data));
    const [manifest, ...rest] = frames;
    const shuffled = [...rest.slice(0, -1)].reverse();
    shuffled.splice(3, 0, shuffled[5]);
    const a = new FileAssembler();
    for (const f of shuffled) assert.equal(a.accept(f)?.data, undefined);
    const done = a.accept(manifest)!;
    assert.deepEqual(done.data, data);
    assert.equal(done.manifest?.name, 'notes ✓.txt');
    const repeat = a.accept(manifest)!;
    assert.equal(repeat.alreadyDelivered, true);
    assert.equal(repeat.data, undefined);
  });

  test('a resend fills in chunks that were missed the first time', () => {
    const data = bytes(700, 3);
    const { frames } = buildFileFrames(options(data));
    const a = new FileAssembler();
    frames.forEach((f, i) => i !== 2 && i !== 5 && a.accept(f));
    const results = frames.map((f) => a.accept(f));
    assert.deepEqual(results.find((r) => r?.data)?.data, data);
  });

  test('compression round-trips', async () => {
    const data = new TextEncoder().encode('chirp '.repeat(500));
    const packed = await maybeCompress(data);
    assert.ok(packed.compressed && packed.data.length < data.length / 10);
    assert.deepEqual(await decompress(packed.data, data.length), data);
  });

  test('decompression refuses output larger or smaller than declared', async () => {
    const bomb = await maybeCompress(new Uint8Array(200_000));
    await assert.rejects(decompress(bomb.data, 1000), /larger than declared/);
    await assert.rejects(decompress(bomb.data, 300_000), /smaller than declared/);
  });

  test('sends a file over the fast modem through a noisy channel', () => {
    const modem = getModem('fast');
    const data = bytes(900, 4);
    const { frames } = buildFileFrames({ ...options(data), chunkSize: chunkSizeFor(modem) });
    const parts = frames.map((f) => modem.modulate(f, 48000));
    const gap = new Float32Array(4800);
    const audio = new Float32Array(parts.reduce((n, p) => n + p.length + gap.length, 0));
    let offset = 0;
    for (const p of parts) {
      audio.set(p, offset);
      offset += p.length + gap.length;
    }
    const a = new FileAssembler();
    const events = receive(modem, channel(audio, 48000, { snrDb: 10, clockPpm: 120 }), 48000);
    const done = events.flatMap((e) => (e.kind === 'frame' ? [a.accept(e.frame)] : [])).find((r) => r?.data);
    assert.deepEqual(done?.data, data);
  });

  test('rejects hostile or inconsistent manifests before allocating anything', () => {
    const { manifest } = buildFileFrames(options(bytes(300, 9)));
    const bad: Partial<FileManifest>[] = [
      { chunkCount: 0, dataSize: 1 << 20, size: 1 }, // the review's reproduction
      { dataSize: 0xffffffff, size: 0xffffffff, chunkCount: 0xffff, chunkSize: 1000 },
      { dataSize: MAX_FILE_BYTES + 1, size: MAX_FILE_BYTES + 1, chunkSize: 1000, chunkCount: 263 },
      { chunkCount: manifest.chunkCount + 1 },
      { chunkSize: 0 },
      { chunkSize: 5000, chunkCount: 1 },
      { size: manifest.size + 1 }, // uncompressed sizes must match
      { fileId: 0 },
    ];
    for (const patch of bad) {
      const payload = encodeManifest({ ...manifest, ...patch });
      assert.equal(decodeManifest(payload), null, JSON.stringify(patch));
      const result = new FileAssembler().accept({ type: FrameType.FileManifest, payload });
      assert.equal(result?.error, 'invalid file manifest', JSON.stringify(patch));
    }
    const flags = encodeManifest(manifest);
    flags[17] = 0x80;
    assert.equal(decodeManifest(flags), null);
  });

  test('ignores chunks whose length does not match the manifest', () => {
    const data = bytes(250, 10);
    const { frames } = buildFileFrames(options(data));
    const a = new FileAssembler();
    a.accept(frames[0]);
    const forged = frames[1].payload.slice(0, 50);
    assert.equal(a.accept({ type: FrameType.FileChunk, payload: forged })?.received, 0);
    const done = frames.slice(1).map((f) => a.accept(f)).find((r) => r?.data);
    assert.deepEqual(done?.data, data);
  });

  test('a different file reusing a delivered id is delivered, not suppressed', () => {
    const a = new FileAssembler();
    const first = buildFileFrames({ ...options(Uint8Array.of(1, 2, 3)), fileId: 42 });
    const second = buildFileFrames({ ...options(Uint8Array.of(4, 5, 6)), fileId: 42 });
    assert.deepEqual(first.frames.map((f) => a.accept(f)).find((r) => r?.data)?.data, Uint8Array.of(1, 2, 3));
    const results = second.frames.map((f) => a.accept(f));
    assert.deepEqual(results.find((r) => r?.data)?.data, Uint8Array.of(4, 5, 6));
  });

  for (const size of [0, 3, 450]) {
    test(`a ${size}-byte file completes when its first manifest is lost`, () => {
      const data = bytes(size, size + 1);
      const { frames } = buildFileFrames(options(data));
      assert.equal(frames.at(-1)!.type, FrameType.FileManifest);
      const a = new FileAssembler();
      const done = frames.slice(1).map((f) => a.accept(f)).find((r) => r?.data);
      assert.deepEqual(done?.data, data);
    });
  }

  test('keeps a bounded number of incomplete transfers', () => {
    const a = new FileAssembler({ maxPending: 3 });
    const transfers = [1, 2, 3, 4].map((id) => buildFileFrames({ ...options(bytes(150, id)), fileId: id }).frames);
    for (const frames of transfers) a.accept(frames[1]); // one orphan chunk each
    // Transfer 1 was evicted, so its manifest finds no chunks; transfer 4 kept its chunk.
    assert.equal(a.accept(transfers[0][0])?.received, 0);
    assert.equal(a.accept(transfers[3][0])?.received, 1);
  });

  const orphan = (fileId: number, index: number, length: number) => {
    const payload = new Uint8Array(6 + length);
    new DataView(payload.buffer).setUint32(0, fileId);
    new DataView(payload.buffer).setUint16(4, index);
    return { type: FrameType.FileChunk, payload };
  };

  test('chunks without a manifest cannot buffer more than the largest valid file', () => {
    // The review's reproduction: 300 × 1018-byte chunks for one id, no manifest.
    const a = new FileAssembler();
    for (let i = 0; i < 300; i++) a.accept(orphan(42, i, 1018));
    assert.ok(a.bufferedBytes <= MAX_FILE_BYTES, `${a.bufferedBytes} bytes buffered`);
    // Indexes no valid file can have, and id 0, are refused outright.
    assert.equal(a.accept(orphan(43, 0xffff, 100)), null);
    assert.equal(a.accept(orphan(0, 0, 100)), null);
  });

  test('tiny orphan chunks are capped by count, not just bytes', () => {
    const a = new FileAssembler({ maxBytes: 1024 });
    for (let i = 0; i < 500; i++) a.accept(orphan(7, i, 0));
    // A 1 KB file has at most 1024 / 16 = 64 chunks.
    assert.equal(a.accept(orphan(7, 1, 0))?.received, 64);
  });

  test('a maximum-size file still completes when all its chunks precede the manifest', () => {
    const data = bytes(MAX_FILE_BYTES, 11);
    const { frames } = buildFileFrames({ ...options(data), chunkSize: 1018 });
    const a = new FileAssembler();
    for (const f of frames.slice(1, -1)) assert.equal(a.accept(f)?.data, undefined);
    assert.equal(a.bufferedBytes, MAX_FILE_BYTES);
    assert.deepEqual(a.accept(frames[0])?.data, data);
    assert.equal(a.bufferedBytes, 0);
  });

  test('evicts the stalest transfer to stay within the shared byte budget', () => {
    const a = new FileAssembler({ maxBuffered: 4000 });
    a.accept(orphan(1, 0, 1000));
    a.accept(orphan(1, 1, 1000));
    a.accept(orphan(2, 0, 1000));
    a.accept(orphan(1, 2, 500)); // transfer 1 is now the most recently active
    const result = a.accept(orphan(3, 0, 1000))!;
    assert.deepEqual(result.evicted, [2]);
    assert.equal(a.isPending(1), true);
    assert.equal(a.bufferedBytes, 3500);
  });

  test('expires transfers that stop arriving and reclaims their budget', () => {
    const a = new FileAssembler();
    const { frames } = buildFileFrames(options(bytes(500, 12)));
    a.accept(frames[1], 0);
    a.accept(frames[2], 1000);
    assert.deepEqual(a.expire(DEFAULT_LIMITS.pendingTtlMs), []);
    assert.deepEqual(a.expire(1000 + DEFAULT_LIMITS.pendingTtlMs), [4242]);
    assert.equal(a.bufferedBytes, 0);
    assert.equal(a.isPending(4242), false);
  });

  test('a manifest that changes how the data is interpreted restarts the transfer', () => {
    const data = bytes(300, 13);
    const { manifest, frames } = buildFileFrames(options(data));
    const a = new FileAssembler();
    a.accept(frames[0]);
    a.accept(frames[1]);
    const recompressed = encodeManifest({ ...manifest, compressed: true, size: 5000 });
    assert.equal(a.accept({ type: FrameType.FileManifest, payload: recompressed })?.received, 0);
    assert.equal(a.bufferedBytes, 0);
  });
});
