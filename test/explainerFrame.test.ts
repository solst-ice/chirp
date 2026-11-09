// The guide's pitch figure claims to show a slot exactly as FAST plays it. These
// check its labels against the encoder: the bits read back from each tone must be
// the byte half it is attributed to, in the slot's real tone set.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FIRST_TEXT_SLOT, PREAMBLE_SLOTS, fastFrame, slotTones, toneSet } from '../src/explainer/frame.ts';
import { HEADER_BYTES, binOf } from '../src/modem/mfsk.ts';
import { PROFILES } from '../src/modem/profiles.ts';

const FAST = PROFILES[0];
const enc = new TextEncoder();

describe('guide pitch figure', () => {
  test('"H" shares its slot with the first checksum byte, in tone set 2', () => {
    const frame = fastFrame(enc.encode('H'));
    const tones = slotTones(frame, FIRST_TEXT_SLOT);
    assert.equal(FIRST_TEXT_SLOT, 13);
    assert.equal(toneSet(FIRST_TEXT_SLOT), 2);
    assert.deepEqual(
      tones.map((t) => [t.byte, t.role, t.half]),
      [
        [0x48, 'message', 'high'],
        [0x48, 'message', 'low'],
        [0xaa, 'check', 'high'],
        [0xaa, 'check', 'low'],
      ],
    );
    assert.deepEqual(
      tones.map((t) => t.frequency),
      [3150, 4850, 5750, 5850],
    );
  });

  test('empty text starts with the checksum', () => {
    const frame = fastFrame(new Uint8Array(0));
    assert.deepEqual(
      slotTones(frame, FIRST_TEXT_SLOT).map((t) => t.role),
      ['check', 'check', 'check', 'check'],
    );
  });

  for (const text of ['', 'H', 'Hi ✓', 'é🙂 mixed bytes']) {
    test(`every slot's labels match its tones: ${JSON.stringify(text)}`, () => {
      const frame = fastFrame(enc.encode(text));
      for (let slot = PREAMBLE_SLOTS; slot < frame.tones.length; slot++) {
        slotTones(frame, slot).forEach((t, g) => {
          const byte = t.byte ?? 0;
          assert.equal(t.value, t.half === 'high' ? byte >> 4 : byte & 15, `slot ${slot} tone ${g + 1}`);
          assert.equal(frame.tones[slot][g], binOf(FAST, t.value, g, slot));
          if (t.role === 'message') assert.equal(t.byte, frame.payload[t.byteIndex - HEADER_BYTES]);
          if (t.byte === undefined) assert.equal(t.role, 'pad');
        });
      }
    });
  }
});
