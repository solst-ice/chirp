// Per-frame encryption with a pre-shared key, layered on top of any Modem: a
// frame is sealed into an `Encrypted` frame before modulation and opened after
// Reed–Solomon and the CRC have repaired and checked it, so the cipher only
// ever sees bytes that arrived intact.
//
// Payload of an Encrypted frame:
//   version (1) | nonce (12) | AES-256-GCM( inner type (1) | unix seconds (4) | inner payload ) + tag (16)
// The version byte is authenticated as additional data. The inner type is
// encrypted, but lengths and traffic patterns (a run of similar-sized chunks
// between two manifests) can still give away whether it is text or a file;
// the mode and the fact that something was sent are visible too.
//
// The key comes from a passphrase via PBKDF2 with a fixed salt, so both sides
// derive it once instead of per frame. The cost of that: anyone holding a
// recording can guess passphrases offline, so the passphrase has to be long,
// or better, random (`generateKey`).
// The timestamp lets a receiver reject recordings replayed later on;
// `ReplayGuard` catches replays within that window.

import { FrameType, type Frame } from './types.ts';

export const ENCRYPTION_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const INNER_HEADER = 5;
/** Bytes an encrypted frame adds to the payload it carries. */
export const ENCRYPTION_OVERHEAD = 1 + NONCE_BYTES + INNER_HEADER + TAG_BYTES;
/** How far the two devices' clocks may disagree. */
export const MAX_CLOCK_SKEW_S = 30 * 60;
/**
 * Oldest frame accepted. Frames are stamped when sealed, before they play, so
 * this also covers the longest transfer (15 minutes) and the wait for a clear
 * channel (2 minutes).
 */
export const MAX_AGE_S = MAX_CLOCK_SKEW_S + 20 * 60;
/** Furthest ahead of the receiver's clock a frame may be stamped. */
export const MAX_AHEAD_S = MAX_CLOCK_SKEW_S;
/** Advisory: shorter passphrases are easy to guess from a recording. */
export const MIN_KEY_CHARS = 20;
export const PBKDF2_ITERATIONS = 600_000;
const SALT = new TextEncoder().encode('chirp/psk/v1');
const SEALABLE: ReadonlySet<number> = new Set([FrameType.Text, FrameType.FileManifest, FrameType.FileChunk]);

export type OpenResult =
  /** `sentAt`: the sender's authenticated timestamp, in unix seconds. */
  | { ok: true; frame: Frame; nonce: string; sentAt: number }
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

/** Drop the cached passphrase and key. JavaScript cannot wipe memory, but it need not keep references. */
export function forgetKey() {
  cached = null;
}

// Crockford's base32: no i, l, o or u, so a key read out loud or copied by hand is not misread.
const KEY_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const KEY_GROUPS = 5;
const KEY_GROUP_CHARS = 5;

/** A random key of 25 characters (125 bits) in dash-separated groups of five. */
export function generateKey(): string {
  // 256 is a multiple of 32, so taking the low five bits of each byte is unbiased.
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(KEY_GROUPS * KEY_GROUP_CHARS)), (b) => KEY_ALPHABET[b & 31]);
  return Array.from({ length: KEY_GROUPS }, (_, i) => chars.slice(i * KEY_GROUP_CHARS, (i + 1) * KEY_GROUP_CHARS).join('')).join('-');
}

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
  const sentAt = new DataView(inner.buffer).getUint32(1);
  const skew = sentAt - Math.floor((options.now ?? Date.now()) / 1000);
  if (skew < -MAX_AGE_S || skew > MAX_AHEAD_S) return { ok: false, reason: 'clock', skew };
  return { ok: true, frame: { type: inner[0], payload: inner.slice(INNER_HEADER) }, nonce: hex(nonce), sentAt };
}

/**
 * Remembers the nonce of every opened frame until its timestamp is too old to
 * be accepted anyway, so a recording replayed within that window is noticed.
 * It lives in memory: a reload forgets it, and it cannot notice a replay of a
 * frame this receiver never heard the first time.
 */
export class ReplayGuard {
  /** Nonce → the time (ms) after which `decryptFrame` refuses its frame anyway. */
  private readonly expiries = new Map<string, number>();
  private readonly limit: number;

  // Far more frames than sound can carry within the acceptance window (one
  // every ~0.5 s for 80 minutes is under 10,000), so in practice nothing is
  // dropped before it expires. Past the limit the oldest entries go first.
  constructor(limit = 20_000) {
    this.limit = limit;
  }

  /** True if this nonce was already opened; otherwise remembers it. `sentAt` comes from `decryptFrame`. */
  replayed(nonce: string, sentAt: number, now = Date.now()): boolean {
    for (const [n, expires] of this.expiries) if (expires <= now) this.expiries.delete(n);
    if (this.expiries.has(nonce)) return true;
    this.expiries.set(nonce, (sentAt + MAX_AGE_S + 1) * 1000);
    if (this.expiries.size > this.limit) this.expiries.delete(this.expiries.keys().next().value!);
    return false;
  }
}
