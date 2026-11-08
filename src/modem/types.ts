// Shared modem interfaces. Any modem (our MFSK, or a future ggwave adapter)
// implements `Modem`, so the app and file-transfer layer never depend on a
// particular modulation scheme.

/** Frame payload types carried in the header. */
export const FrameType = {
  Text: 1,
  FileManifest: 2,
  FileChunk: 3,
  /** Loopback self-test; carries a random nonce and is never shown to other receivers. */
  SelfTest: 4,
  /** Another frame sealed with a pre-shared key; its real type travels inside the ciphertext. */
  Encrypted: 5,
  /** A two-way session handshake (hello or reply), sent in the clear; see session.ts. */
  Handshake: 6,
} as const;

export interface Frame {
  type: number;
  payload: Uint8Array;
}

export interface FrameStats {
  /** Byte errors fixed by Reed–Solomon across all blocks. */
  correctedBytes: number;
  /** Mean ratio of strongest to runner-up tone energy, in dB (higher = cleaner). */
  marginDb: number;
  /** Seconds of audio the frame occupied. */
  airtime: number;
}

export type DemodEvent =
  | { kind: 'sync'; modemId: string }
  | { kind: 'header'; modemId: string; type: number; length: number; totalSymbols: number }
  | { kind: 'progress'; modemId: string; symbols: number; totalSymbols: number; preview?: Uint8Array }
  | { kind: 'frame'; modemId: string; frame: Frame; stats: FrameStats }
  | { kind: 'error'; modemId: string; reason: string };

export interface Demodulator {
  /** Feed consecutive mono samples at the sample rate the demodulator was created for. */
  process(samples: Float32Array): DemodEvent[];
  reset(): void;
}

export interface Modem {
  id: string;
  label: string;
  description: string;
  /** Lowest and highest tone frequency in Hz (for visualisation and capability checks). */
  band: [number, number];
  /** Raw channel bit rate before framing and error-correction overhead. */
  rawBitRate: number;
  maxPayload: number;
  supports(sampleRate: number): boolean;
  /** Seconds of audio `modulate` will produce for a payload of this many bytes. */
  airtime(payloadLength: number): number;
  modulate(frame: Frame, sampleRate: number): Float32Array;
  createDemodulator(sampleRate: number): Demodulator;
}
