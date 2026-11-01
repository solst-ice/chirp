// Known-answer vectors. Round-trip tests cannot catch a change that alters the
// encoder and decoder together; these pin the wire format, so any change to it
// fails here and must be made deliberately (and versioned).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { crc32 } from '../src/modem/crc32.ts';
import { frameBytes, frameTones } from '../src/modem/mfsk.ts';
import { PROFILES } from '../src/modem/profiles.ts';
import { rsEncode } from '../src/modem/reedSolomon.ts';
import { FrameType } from '../src/modem/types.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('known-answer vectors', () => {
  test('Reed–Solomon matches published GF(256)/0x11d vectors', () => {
    // QR-code example and "hello world" from "Reed–Solomon codes for coders" (Wikiversity).
    const qr = Uint8Array.of(0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6, 0xc6, 0x96, 0x70, 0xec);
    assert.equal(hex(rsEncode(qr, 10).slice(qr.length)), 'bc2a90136bafeffd4be0');
    const hello = new TextEncoder().encode('hello world');
    assert.equal(hex(rsEncode(hello, 10).slice(hello.length)), 'ed2554c4fdfd89f3a8aa');
  });

  test('CRC-32 matches the standard check value', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  });

  // Frame for "Hi ✓": header [version|mode, type, length] + parity, then payload, CRC-32 and parity.
  const frame = { type: FrameType.Text, payload: new TextEncoder().encode('Hi ✓') };
  const golden: Record<string, { bytes: string; symbols: number; preamble: number[][]; tonesSha256: string }> = {
    fast: {
      bytes: '110100067b4093fa5317486920e29c93784d90869547eb46963c7da2fd7837967fa099a7',
      symbols: 26,
      preamble: [[0, 114, 12, 94], [89, 51, 101, 31], [24, 74, 4, 118], [113, 11, 93, 55], [48, 98, 28, 78], [73, 3, 117, 15], [8, 90, 52, 102], [97, 27, 77, 7]],
      tonesSha256: '96ef2adde9517c01',
    },
    robust: {
      bytes: '1201000617fccdb37efe486920e29c93784d90869547eb46963c7da2fd7837967fa099a7',
      symbols: 44,
      preamble: [[0, 58], [45, 27], [12, 38], [57, 7], [24, 50], [37, 3], [4, 46], [49, 15]],
      tonesSha256: '5431b1316110620c',
    },
    inaudible: {
      bytes: '1301000633630c7f6552486920e29c93784d908649c254dafa52d7358709b5bb',
      symbols: 72,
      preamble: [[0], [23], [6], [29], [12], [19], [2], [25]],
      tonesSha256: 'eb2ad5e37e1096cd',
    },
  };

  for (const p of PROFILES) {
    test(`${p.id} frame bytes and tone sequence are unchanged`, () => {
      const g = golden[p.id];
      assert.ok(g, `add a golden vector for profile ${p.id}`);
      assert.equal(hex(frameBytes(p, frame)), g.bytes);
      const tones = frameTones(p, frame);
      assert.equal(tones.length, g.symbols);
      assert.deepEqual(tones.slice(0, 8), g.preamble);
      assert.equal(createHash('sha256').update(JSON.stringify(tones)).digest('hex').slice(0, 16), g.tonesSha256);
    });
  }
});
