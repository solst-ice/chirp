import { createMfskModem, type MfskProfile } from './mfsk.ts';
import type { Modem } from './types.ts';

// Each profile trades speed for robustness. Tone spacing is always a multiple
// of 1 / symbolSeconds so the tones are orthogonal over the receive window.
export const PROFILES: MfskProfile[] = [
  {
    id: 'fast',
    code: 1,
    label: 'FAST',
    description: 'Audible, 4 tones at a time',
    groups: 4,
    alternate: true,
    baseFrequency: 1500,
    toneSpacing: 50,
    symbolSeconds: 0.02,
    guardSeconds: 0.01,
    parity: 16,
    blockData: 96,
    maxPayload: 1024,
    amplitude: 0.9,
  },
  {
    id: 'robust',
    code: 2,
    label: 'ROBUST',
    description: 'Slower, for noisy or echoey rooms',
    groups: 2,
    alternate: true,
    baseFrequency: 1500,
    toneSpacing: 50,
    symbolSeconds: 0.04,
    guardSeconds: 0.02,
    parity: 16,
    blockData: 64,
    maxPayload: 512,
    amplitude: 0.9,
  },
  {
    id: 'inaudible',
    code: 3,
    label: 'INAUDIBLE',
    // One tone at a time: two simultaneous ultrasonic tones can produce an
    // audible difference tone through a small speaker.
    description: 'Near-ultrasonic · some people and pets hear it',
    groups: 1,
    alternate: true,
    baseFrequency: 18000,
    toneSpacing: 100 / 3,
    symbolSeconds: 0.03,
    guardSeconds: 0.01,
    parity: 12,
    blockData: 48,
    maxPayload: 256,
    amplitude: 0.9,
  },
];

export const MODEMS: Modem[] = PROFILES.map(createMfskModem);

export const getModem = (id: string): Modem => {
  const modem = MODEMS.find((m) => m.id === id);
  if (!modem) throw new Error(`Unknown modem ${id}`);
  return modem;
};
