// The FAST frame the guide's figures show: the real encoder's bytes and tones,
// with each slot and byte labelled by the part of the frame it carries.

import { CRC_BYTES, HEADER_BYTES, PREAMBLE, frameBytes, frameTones, toneFrequency } from '../modem/mfsk.ts';
import { PROFILES } from '../modem/profiles.ts';
import { FrameType } from '../modem/types.ts';

export const FAST = PROFILES[0];
export const PREAMBLE_SLOTS = PREAMBLE.length;
export const BYTES_PER_SLOT = FAST.groups / 2;
/** The first slot carrying text: right after the sync pattern and the header. */
export const FIRST_TEXT_SLOT = PREAMBLE_SLOTS + Math.floor(HEADER_BYTES / BYTES_PER_SLOT);

export type Role = 'sync' | 'header' | 'message' | 'check' | 'repair' | 'pad';

export interface FastFrame {
  payload: Uint8Array;
  /** Header and body as sent, after the preamble. */
  bytes: Uint8Array;
  /** Tone bins of every slot, preamble included. */
  tones: number[][];
  /** What each slot carries; a slot is named after its first byte. */
  roles: Role[];
}

/**
 * Labels assume the body is a single error-correction block, so its bytes are
 * the text, then the checksum, then repair bytes. The guide's input stops well
 * short of FAST's 96-byte block, which keeps that true.
 */
export function byteRole(frame: FastFrame, i: number): Role {
  const text = HEADER_BYTES + frame.payload.length;
  if (i < HEADER_BYTES) return 'header';
  if (i < text) return 'message';
  if (i < text + CRC_BYTES) return 'check';
  return i < frame.bytes.length ? 'repair' : 'pad';
}

export function fastFrame(payload: Uint8Array): FastFrame {
  const frame = { type: FrameType.Text, payload };
  const tones = frameTones(FAST, frame);
  const result: FastFrame = { payload, bytes: frameBytes(FAST, frame), tones, roles: [] };
  result.roles = tones.map((_, s) => (s < PREAMBLE_SLOTS ? 'sync' : byteRole(result, (s - PREAMBLE_SLOTS) * BYTES_PER_SLOT)));
  return result;
}

/** Slots alternate between two tone sets, A and B; B is A moved up one grid step. */
export const toneSet = (slot: number) => (slot % 2 ? 'B' : 'A');

export interface SlotTone {
  /** Index into `bytes`; past its end for the padding that fills the last slot. */
  byteIndex: number;
  byte: number | undefined;
  role: Role;
  half: 'high' | 'low';
  /** The 4-bit value, read back from the tone that plays it. */
  value: number;
  frequency: number;
}

/** The tones one data slot plays, each with the byte half it carries. */
export function slotTones(frame: FastFrame, slot: number): SlotTone[] {
  return frame.tones[slot].map((bin, g) => {
    const byteIndex = (slot - PREAMBLE_SLOTS) * BYTES_PER_SLOT + (g >> 1);
    return {
      byteIndex,
      byte: frame.bytes[byteIndex],
      role: byteRole(frame, byteIndex),
      half: g % 2 ? 'low' : 'high',
      // FAST alternates two tone sets, so a bin is (value × groups + group) × 2 + set.
      value: Math.floor((bin >> 1) / FAST.groups),
      frequency: toneFrequency(FAST, bin),
    };
  });
}
