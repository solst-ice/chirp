// Per-frame encryption with a pre-shared key, layered on top of any Modem: a
// frame is sealed into an `Encrypted` frame before modulation and opened after
// Reed–Solomon and the CRC have repaired and checked it, so the cipher only
// ever sees bytes that arrived intact.
//
// Payload of an Encrypted frame:
//   version (1) | nonce (12) | AES-256-GCM( inner type (1) | unix seconds (4) | inner payload ) + tag (16)
// The version byte is authenticated as additional data. The inner type is
// encrypted, so a listener cannot tell text from file frames; the frame
// length, the mode and the fact that something was sent remain visible.
//
// The key comes from a passphrase via PBKDF2 with a fixed salt, so both sides
// derive it once instead of per frame. The cost of that: anyone holding a
// recording can guess passphrases offline, so the passphrase has to be long.
// The timestamp lets a receiver reject recordings replayed later on;
// `ReplayGuard` catches replays within that window.

import { FrameType, type Frame } from './types.ts';

export const ENCRYPTION_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const INNER_HEADER = 5;
/** Bytes an encrypted frame adds to the payload it carries. */
export const ENCRYPTION_OVERHEAD = 1 + NONCE_BYTES + INNER_HEADER + TAG_BYTES;
/** Frames whose timestamp is further than this from the receiver's clock are refused. */
export const MAX_CLOCK_SKEW_S = 30 * 60;
/** Advisory: shorter passphrases are easy to guess from a recording. */
export const MIN_KEY_CHARS = 20;
export const PBKDF2_ITERATIONS = 600_000;
const SALT = new TextEncoder().encode('chirp/psk/v1');
const SEALABLE: ReadonlySet<number> = new Set([FrameType.Text, FrameType.FileManifest, FrameType.FileChunk]);

export type OpenResult =
  | { ok: true; frame: Frame; nonce: string }
  | { ok: false; reason: 'format' }
  | { ok: false; reason: 'key' }
  /** Seconds the sender's timestamp is ahead of (positive) or behind (negative) our clock. */
  | { ok: false; reason: 'clock'; skew: number };

/** The same passphrase typed on two keyboards should give the same key. */
export const normalizeKey = (passphrase: string) => passphrase.normalize('NFC').trim();

const subtle = () => {
  if (!globalThis.crypto?.subtle) throw new Error('encryption needs a secure page (https or localhost)');
  return globalThis.crypto.subtle;
};

let cached: { passphrase: string; key: Promise<CryptoKey> } | null = null;

/** AES-256-GCM key for a passphrase; the last one is cached since PBKDF2 is deliberately slow. */
export function deriveKey(passphrase: string): Promise<CryptoKey> {
  const normalized = normalizeKey(passphrase);
  if (!normalized) return Promise.reject(new Error('enter a pre-shared key'));
  if (cached?.passphrase === normalized) return cached.key;
  const key = (async () => {
    const s = subtle();
    const material = await s.importKey('raw', new TextEncoder().encode(normalized), 'PBKDF2', false, ['deriveKey']);
    return s.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: PBKDF2_ITERATIONS },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  })();
  cached = { passphrase: normalized, key };
  key.catch(() => {
    if (cached?.key === key) cached = null;
  });
  return key;
}

const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

export async function encryptFrame(
  key: CryptoKey,
  frame: Frame,
  options: { nonce?: Uint8Array; now?: number } = {},
): Promise<Frame> {
  if (!SEALABLE.has(frame.type)) throw new Error(`frame type ${frame.type} cannot be encrypted`);
  const nonce = options.nonce ?? crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  if (nonce.length !== NONCE_BYTES) throw new Error('nonce must be 12 bytes');
  const inner = new Uint8Array(INNER_HEADER + frame.payload.length);
  inner[0] = frame.type;
  new DataView(inner.buffer).setUint32(1, Math.floor((options.now ?? Date.now()) / 1000));
  inner.set(frame.payload, INNER_HEADER);
  const version = Uint8Array.of(ENCRYPTION_VERSION);
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: version }, key, inner));
  const payload = new Uint8Array(1 + NONCE_BYTES + sealed.length);
  payload.set(version);
  payload.set(nonce, 1);
  payload.set(sealed, 1 + NONCE_BYTES);
  return { type: FrameType.Encrypted, payload };
}

export async function decryptFrame(key: CryptoKey, payload: Uint8Array, options: { now?: number } = {}): Promise<OpenResult> {
  if (payload.length < ENCRYPTION_OVERHEAD || payload[0] !== ENCRYPTION_VERSION) return { ok: false, reason: 'format' };
  const nonce = payload.subarray(1, 1 + NONCE_BYTES);
  let inner: Uint8Array;
  try {
    inner = new Uint8Array(
      await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: payload.subarray(0, 1) }, key, payload.subarray(1 + NONCE_BYTES)),
    );
  } catch (err) {
    // A wrong key and a forged or altered frame look the same: the tag does not match.
    if (err instanceof Error && err.name === 'OperationError') return { ok: false, reason: 'key' };
    throw err;
  }
  if (!SEALABLE.has(inner[0])) return { ok: false, reason: 'format' };
  const skew = new DataView(inner.buffer).getUint32(1) - Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(skew) > MAX_CLOCK_SKEW_S) return { ok: false, reason: 'clock', skew };
  return { ok: true, frame: { type: inner[0], payload: inner.slice(INNER_HEADER) }, nonce: hex(nonce) };
}

/** Remembers the nonces of recently opened frames so a replayed recording is noticed. */
export class ReplayGuard {
  private readonly seen = new Set<string>();
  private readonly limit: number;

  constructor(limit = 1024) {
    this.limit = limit;
  }

  /** True if this nonce was already seen; otherwise remembers it. */
  replayed(nonce: string): boolean {
    if (this.seen.has(nonce)) return true;
    this.seen.add(nonce);
    if (this.seen.size > this.limit) this.seen.delete(this.seen.values().next().value!);
    return false;
  }
}
