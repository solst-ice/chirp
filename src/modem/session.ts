// Two-way sessions: the pre-shared key plus an ephemeral X25519 Diffie–Hellman
// exchange, in the spirit of Noise NNpsk0 / TLS psk_dhe_ke.
//
// Handshake frames (FrameType.Handshake, sent in the clear):
//   hello: version (1) | kind = 1 | initiator public key (32)
//   reply: version (1) | kind = 2 | hello ref (8) | responder public key (32) | confirm (16)
// The hello ref is the first 8 bytes of the hello's public key, so an initiator
// recognises answers to its own hello among others' without any secret.
//
// Both sides compute
//   dh   = X25519(own ephemeral private key, peer public key)
//   prk  = HMAC-SHA256(psk mixing key, dh)                (an HKDF-Extract salted with the PSK)
//   i→r, r→i AES-256-GCM keys and confirm = HKDF-SHA256(prk, no salt, label | "chirp/dh/v1" | hello key | reply key)
// so the session key needs both the PSK and an ephemeral private key that never
// leaves its device and is dropped once the keys are derived. Someone who
// records everything cannot open a session even if they know (or later learn)
// the PSK, and cannot test passphrase guesses against a recording, since every
// guess would need `dh` too. The hello deliberately carries nothing keyed by the
// PSK: a tag on it would be exactly such a test.
// An active attacker who sends their own hello does learn `dh` for the session
// they start, so the reply's confirm lets them guess passphrases offline: the
// passphrase still has to be strong. A PSK holder in the middle is not detected
// at all, except by comparing the session code (a hash of both public keys) on
// the two screens, which a careless one gets wrong; it is not a committed SAS.
//
// Frames sealed in a session (FrameType.Encrypted, version 2):
//   version (1) | session id (4) | nonce (12) | AES-256-GCM( inner type (1) | inner payload ) + tag (16)
// with version and session id authenticated as additional data. Each direction
// has its own key, so a frame reflected back to its sender does not open. There
// is no timestamp: a recording of an earlier session fails because its keys are
// gone, and replays within a session are caught by remembering nonces.

import { NONCE_BYTES, SEALABLE, TAG_BYTES, hex, subtle } from './encryption.ts';
import { FrameType, type Frame } from './types.ts';

export const HANDSHAKE_VERSION = 1;
export const SESSION_VERSION = 2;
export const PUBLIC_KEY_BYTES = 32;
export const HELLO_REF_BYTES = 8;
export const CONFIRM_BYTES = 16;
export const SESSION_ID_BYTES = 4;
const HELLO_KIND = 1;
const REPLY_KIND = 2;
export const HELLO_BYTES = 2 + PUBLIC_KEY_BYTES;
export const REPLY_BYTES = 2 + HELLO_REF_BYTES + PUBLIC_KEY_BYTES + CONFIRM_BYTES;
const SESSION_HEADER = 1 + SESSION_ID_BYTES + NONCE_BYTES;
/** Bytes a session frame adds to its payload: the same as a version 1 frame. */
export const SESSION_OVERHEAD = SESSION_HEADER + 1 + TAG_BYTES;

const LABEL = new TextEncoder().encode('chirp/dh/v1');
const INFO_I2R = new TextEncoder().encode('chirp/dh/v1 i2r');
const INFO_R2I = new TextEncoder().encode('chirp/dh/v1 r2i');
const INFO_CONFIRM = new TextEncoder().encode('chirp/dh/v1 confirm');
const INFO_ID = new TextEncoder().encode('chirp/dh/v1 id');

export type Role = 'initiator' | 'responder';

export interface Ephemeral {
  /** Non-extractable: it never leaves WebCrypto, and is dropped after one handshake. */
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

export type Handshake =
  | { kind: 'hello'; publicKey: Uint8Array }
  | { kind: 'reply'; helloRef: Uint8Array; publicKey: Uint8Array; confirm: Uint8Array };

export interface SessionKeys {
  id: Uint8Array;
  /** Hex of the id: how frames name their session, and the code both screens show. */
  idHex: string;
  send: CryptoKey;
  receive: CryptoKey;
  confirm: Uint8Array;
}

export type SessionOpenResult =
  | { ok: true; frame: Frame; nonce: string }
  | { ok: false; reason: 'format' }
  | { ok: false; reason: 'key' };

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Byte-wise comparison: negative if `a` sorts first. Breaks ties when two devices start a handshake at once. */
export const compareKeys = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && compareKeys(a, b) === 0;

export const helloRefOf = (publicKey: Uint8Array) => publicKey.slice(0, HELLO_REF_BYTES);

export async function createEphemeral(): Promise<Ephemeral> {
  const pair = (await subtle().generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)) };
}

export const helloFrame = (publicKey: Uint8Array): Frame => ({
  type: FrameType.Handshake,
  payload: concat(Uint8Array.of(HANDSHAKE_VERSION, HELLO_KIND), publicKey),
});

export const replyFrame = (helloKey: Uint8Array, publicKey: Uint8Array, confirm: Uint8Array): Frame => ({
  type: FrameType.Handshake,
  payload: concat(Uint8Array.of(HANDSHAKE_VERSION, REPLY_KIND), helloRefOf(helloKey), publicKey, confirm),
});

export function parseHandshake(payload: Uint8Array): Handshake | null {
  if (payload[0] !== HANDSHAKE_VERSION) return null;
  if (payload[1] === HELLO_KIND && payload.length === HELLO_BYTES) return { kind: 'hello', publicKey: payload.slice(2) };
  if (payload[1] === REPLY_KIND && payload.length === REPLY_BYTES) {
    const at = 2 + HELLO_REF_BYTES;
    return {
      kind: 'reply',
      helloRef: payload.slice(2, at),
      publicKey: payload.slice(at, at + PUBLIC_KEY_BYTES),
      confirm: payload.slice(at + PUBLIC_KEY_BYTES),
    };
  }
  return null;
}

/** The session code: a hash of both public keys only, so it is no use for guessing the PSK. */
async function sessionId(helloKey: Uint8Array, replyKey: Uint8Array) {
  const digest = new Uint8Array(await subtle().digest('SHA-256', concat(INFO_ID, helloKey, replyKey)));
  return digest.slice(0, SESSION_ID_BYTES);
}

/**
 * Session keys for one handshake, from either side. Rejects a peer key that
 * gives an all-zero secret (a low-order point), which WebCrypto refuses.
 */
export async function deriveSession(
  mix: CryptoKey,
  own: Ephemeral,
  role: Role,
  helloKey: Uint8Array,
  replyKey: Uint8Array,
): Promise<SessionKeys> {
  const s = subtle();
  const peer = await s.importKey('raw', role === 'initiator' ? replyKey : helloKey, { name: 'X25519' }, true, []);
  const dh = new Uint8Array(await s.deriveBits({ name: 'X25519', public: peer }, own.privateKey, 256));
  const prk = new Uint8Array(await s.sign('HMAC', mix, dh));
  dh.fill(0);
  try {
    const root = await s.importKey('raw', prk, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const transcript = concat(LABEL, helloKey, replyKey);
    const hkdf = (info: Uint8Array) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: concat(info, transcript) });
    const aes = (info: Uint8Array) => s.deriveKey(hkdf(info), root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const [i2r, r2i, confirm, id] = await Promise.all([
      aes(INFO_I2R),
      aes(INFO_R2I),
      s.deriveBits(hkdf(INFO_CONFIRM), root, CONFIRM_BYTES * 8),
      sessionId(helloKey, replyKey),
    ]);
    return {
      id,
      idHex: hex(id),
      send: role === 'initiator' ? i2r : r2i,
      receive: role === 'initiator' ? r2i : i2r,
      confirm: new Uint8Array(confirm),
    };
  } finally {
    prk.fill(0);
  }
}

export async function sealInSession(
  session: Pick<SessionKeys, 'id' | 'send'>,
  frame: Frame,
  options: { nonce?: Uint8Array } = {},
): Promise<Frame> {
  if (!SEALABLE.has(frame.type)) throw new Error(`frame type ${frame.type} cannot be encrypted`);
  const nonce = options.nonce ?? crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  if (nonce.length !== NONCE_BYTES) throw new Error('nonce must be 12 bytes');
  const header = concat(Uint8Array.of(SESSION_VERSION), session.id);
  const inner = concat(Uint8Array.of(frame.type), frame.payload);
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: header }, session.send, inner));
  return { type: FrameType.Encrypted, payload: concat(header, nonce, sealed) };
}

/** The session a version 2 frame names, or null for any other payload. */
export const sessionIdOf = (payload: Uint8Array): string | null =>
  payload[0] === SESSION_VERSION && payload.length >= SESSION_OVERHEAD ? hex(payload.subarray(1, 1 + SESSION_ID_BYTES)) : null;

export async function openInSession(receive: CryptoKey, payload: Uint8Array): Promise<SessionOpenResult> {
  if (sessionIdOf(payload) === null) return { ok: false, reason: 'format' };
  const header = payload.subarray(0, 1 + SESSION_ID_BYTES);
  const nonce = payload.subarray(header.length, SESSION_HEADER);
  let inner: Uint8Array;
  try {
    inner = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: header }, receive, payload.subarray(SESSION_HEADER)));
  } catch (err) {
    if (err instanceof Error && err.name === 'OperationError') return { ok: false, reason: 'key' };
    throw err;
  }
  if (!SEALABLE.has(inner[0])) return { ok: false, reason: 'format' };
  return { ok: true, frame: { type: inner[0], payload: inner.slice(1) }, nonce: hex(nonce) };
}
