// File transfer over any Modem: a manifest frame describing the file, then
// numbered chunk frames, then the manifest again so a receiver that missed the
// start still learns what it is assembling. Sending the same file again reuses
// its id, letting the receiver fill in chunks it missed.
//
// Everything a receiver gets is untrusted: manifests are validated against
// hard limits before any buffer is allocated, chunks must have exactly the
// length the manifest implies, and decompression is capped at the declared size.

import { crc32 } from './crc32.ts';
import { FrameType, type Frame } from './types.ts';

export interface FileManifest {
  /** Random 32-bit transfer id; reused only by an intentional resend. */
  fileId: number;
  name: string;
  mime: string;
  /** Size of the original file. */
  size: number;
  /** Size of the transmitted (possibly compressed) data. */
  dataSize: number;
  compressed: boolean;
  chunkSize: number;
  chunkCount: number;
  crc: number;
}

export interface FileProgress {
  fileId: number;
  manifest?: FileManifest;
  received: number;
  /** Known once the manifest arrives. */
  total?: number;
  /** Set when every chunk has arrived and the checksum matches. */
  data?: Uint8Array;
  /** The file was already delivered by an earlier frame (e.g. a repeated manifest or a resend). */
  alreadyDelivered?: boolean;
  error?: string;
}

export interface FileLimits {
  /** Largest original and transmitted size accepted. */
  maxBytes: number;
  /** Largest chunk payload accepted (excluding the chunk header). */
  maxChunkSize: number;
  /** Incomplete transfers kept at once; the oldest is dropped beyond this. */
  maxPending: number;
}

export const MAX_FILE_BYTES = 256 * 1024;
export const CHUNK_HEADER = 6;

export const DEFAULT_LIMITS: FileLimits = {
  maxBytes: MAX_FILE_BYTES,
  maxChunkSize: 1024 - CHUNK_HEADER,
  maxPending: 8,
};

const MANIFEST_VERSION = 2;
const MANIFEST_FIXED = 22;
const MAX_TEXT_FIELD = 100;
const FLAG_COMPRESSED = 1;
const KNOWN_FLAGS = FLAG_COMPRESSED;
const MAX_DELIVERED_REMEMBERED = 64;

/** A random non-zero 32-bit id. */
export function newFileId(): number {
  const id = new Uint32Array(1);
  crypto.getRandomValues(id);
  return id[0] || 1;
}

function truncateUtf8(s: string, max: number): Uint8Array {
  const enc = new TextEncoder();
  let bytes = enc.encode(s);
  let chars = Array.from(s);
  while (bytes.length > max) {
    chars = chars.slice(0, -1);
    bytes = enc.encode(chars.join(''));
  }
  return bytes;
}

export function encodeManifest(m: FileManifest): Uint8Array {
  const name = truncateUtf8(m.name, MAX_TEXT_FIELD);
  const mime = truncateUtf8(m.mime, MAX_TEXT_FIELD);
  const out = new Uint8Array(MANIFEST_FIXED + 2 + name.length + mime.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, MANIFEST_VERSION);
  v.setUint32(1, m.fileId);
  v.setUint16(5, m.chunkCount);
  v.setUint16(7, m.chunkSize);
  v.setUint32(9, m.dataSize);
  v.setUint32(13, m.crc);
  v.setUint8(17, m.compressed ? FLAG_COMPRESSED : 0);
  v.setUint32(18, m.size);
  out[MANIFEST_FIXED] = name.length;
  out.set(name, MANIFEST_FIXED + 1);
  out[MANIFEST_FIXED + 1 + name.length] = mime.length;
  out.set(mime, MANIFEST_FIXED + 2 + name.length);
  return out;
}

/** Parse a manifest; returns null for anything malformed or outside `limits`. */
export function decodeManifest(b: Uint8Array, limits: FileLimits = DEFAULT_LIMITS): FileManifest | null {
  if (b.length < MANIFEST_FIXED + 2 || b[0] !== MANIFEST_VERSION) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flags = b[17];
  const nameLength = b[MANIFEST_FIXED];
  if (MANIFEST_FIXED + 2 + nameLength > b.length) return null;
  const mimeLength = b[MANIFEST_FIXED + 1 + nameLength];
  if (MANIFEST_FIXED + 2 + nameLength + mimeLength !== b.length) return null;
  const dec = new TextDecoder();
  const m: FileManifest = {
    fileId: v.getUint32(1),
    chunkCount: v.getUint16(5),
    chunkSize: v.getUint16(7),
    dataSize: v.getUint32(9),
    crc: v.getUint32(13),
    compressed: (flags & FLAG_COMPRESSED) !== 0,
    size: v.getUint32(18),
    name: dec.decode(b.subarray(MANIFEST_FIXED + 1, MANIFEST_FIXED + 1 + nameLength)),
    mime: dec.decode(b.subarray(MANIFEST_FIXED + 2 + nameLength, b.length)),
  };

  if (flags & ~KNOWN_FLAGS) return null;
  if (m.fileId === 0) return null;
  if (m.size > limits.maxBytes || m.dataSize > limits.maxBytes) return null;
  if (m.chunkSize < 1 || m.chunkSize > limits.maxChunkSize) return null;
  if (m.chunkCount !== Math.max(1, Math.ceil(m.dataSize / m.chunkSize))) return null;
  if (!m.compressed && m.size !== m.dataSize) return null;
  return m;
}

/** Exact payload length of chunk `index` under a manifest. */
const expectedChunkLength = (m: FileManifest, index: number) =>
  index < m.chunkCount - 1 ? m.chunkSize : m.dataSize - m.chunkSize * (m.chunkCount - 1);

export interface FileFramesOptions {
  fileId: number;
  name: string;
  mime: string;
  size: number;
  data: Uint8Array;
  compressed: boolean;
  chunkSize: number;
}

export function buildFileFrames(o: FileFramesOptions): { manifest: FileManifest; frames: Frame[] } {
  const chunkCount = Math.max(1, Math.ceil(o.data.length / o.chunkSize));
  if (chunkCount > 0xffff) throw new Error('File too large');
  const manifest: FileManifest = {
    fileId: o.fileId,
    name: o.name,
    mime: o.mime,
    size: o.size,
    dataSize: o.data.length,
    compressed: o.compressed,
    chunkSize: o.chunkSize,
    chunkCount,
    crc: crc32(o.data),
  };
  const manifestFrame: Frame = { type: FrameType.FileManifest, payload: encodeManifest(manifest) };
  const frames: Frame[] = [manifestFrame];
  for (let i = 0; i < chunkCount; i++) {
    const part = o.data.subarray(i * o.chunkSize, (i + 1) * o.chunkSize);
    const payload = new Uint8Array(CHUNK_HEADER + part.length);
    const v = new DataView(payload.buffer);
    v.setUint32(0, o.fileId);
    v.setUint16(4, i);
    payload.set(part, CHUNK_HEADER);
    frames.push({ type: FrameType.FileChunk, payload });
  }
  // Always repeat the manifest so a receiver that missed the first one can finish.
  frames.push(manifestFrame);
  return { manifest, frames };
}

interface Pending {
  manifest?: FileManifest;
  chunks: Map<number, Uint8Array>;
}

const sameTransfer = (a: FileManifest, b: FileManifest) =>
  a.crc === b.crc && a.dataSize === b.dataSize && a.chunkSize === b.chunkSize && a.chunkCount === b.chunkCount;

/** Collects manifest and chunk frames, possibly out of order or repeated. */
export class FileAssembler {
  private readonly limits: FileLimits;
  private pending = new Map<number, Pending>();
  /** Delivered transfers: id → manifest, kept so repeats are recognised. */
  private delivered = new Map<number, FileManifest>();

  constructor(limits: FileLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  accept(frame: Frame): FileProgress | null {
    if (frame.type === FrameType.FileManifest) return this.acceptManifest(frame.payload);
    if (frame.type === FrameType.FileChunk) return this.acceptChunk(frame.payload);
    return null;
  }

  private acceptManifest(payload: Uint8Array): FileProgress | null {
    const manifest = decodeManifest(payload, this.limits);
    if (!manifest) {
      const id = payload.length >= 5 ? new DataView(payload.buffer, payload.byteOffset).getUint32(1) : 0;
      return { fileId: id, received: 0, error: 'invalid file manifest' };
    }
    const { fileId } = manifest;
    const done = this.delivered.get(fileId);
    if (done) {
      if (sameTransfer(done, manifest)) return { fileId, manifest, received: done.chunkCount, total: done.chunkCount, alreadyDelivered: true };
      this.delivered.delete(fileId); // A different file under a reused id: start over.
    }
    const f = this.entry(fileId);
    if (f.manifest && !sameTransfer(f.manifest, manifest)) f.chunks.clear();
    f.manifest = manifest;
    // Drop chunks that arrived before the manifest but do not fit it.
    for (const [i, chunk] of f.chunks) {
      if (i >= manifest.chunkCount || chunk.length !== expectedChunkLength(manifest, i)) f.chunks.delete(i);
    }
    return this.progress(fileId, f);
  }

  private acceptChunk(payload: Uint8Array): FileProgress | null {
    if (payload.length < CHUNK_HEADER || payload.length - CHUNK_HEADER > this.limits.maxChunkSize) return null;
    const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const fileId = v.getUint32(0);
    const index = v.getUint16(4);
    const done = this.delivered.get(fileId);
    if (done) return { fileId, manifest: done, received: done.chunkCount, total: done.chunkCount, alreadyDelivered: true };
    const f = this.entry(fileId);
    const chunk = payload.slice(CHUNK_HEADER);
    if (f.manifest && (index >= f.manifest.chunkCount || chunk.length !== expectedChunkLength(f.manifest, index))) {
      return this.status(fileId, f); // Does not fit the announced file; ignore it.
    }
    f.chunks.set(index, chunk);
    return this.progress(fileId, f);
  }

  private entry(fileId: number): Pending {
    let f = this.pending.get(fileId);
    if (!f) {
      f = { chunks: new Map() };
      this.pending.set(fileId, f);
      while (this.pending.size > this.limits.maxPending) {
        this.pending.delete(this.pending.keys().next().value!);
      }
    }
    return f;
  }

  private status(fileId: number, f: Pending): FileProgress {
    const m = f.manifest;
    return { fileId, manifest: m, received: f.chunks.size, total: m?.chunkCount };
  }

  private progress(fileId: number, f: Pending): FileProgress {
    const status = this.status(fileId, f);
    const m = f.manifest;
    if (!m || f.chunks.size < m.chunkCount) return status;

    // Lengths were checked per chunk, so the total is exactly dataSize.
    const data = new Uint8Array(m.dataSize);
    for (let i = 0; i < m.chunkCount; i++) data.set(f.chunks.get(i)!, i * m.chunkSize);
    this.pending.delete(fileId);
    if (crc32(data) !== m.crc) return { ...status, error: 'file checksum mismatch' };

    this.delivered.set(fileId, m);
    while (this.delivered.size > MAX_DELIVERED_REMEMBERED) this.delivered.delete(this.delivered.keys().next().value!);
    return { ...status, data };
  }
}

const hasCompression = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Deflate when the browser supports it and it actually saves space. */
export async function maybeCompress(data: Uint8Array): Promise<{ data: Uint8Array; compressed: boolean }> {
  if (!hasCompression()) return { data, compressed: false };
  try {
    const packed = await pipe(data, new CompressionStream('deflate-raw'));
    return packed.length < data.length ? { data: packed, compressed: true } : { data, compressed: false };
  } catch {
    return { data, compressed: false };
  }
}

/** Inflate, refusing to produce more than `expectedSize` bytes and requiring exactly that many. */
export async function decompress(data: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  if (!hasCompression()) throw new Error('this browser cannot decompress files');
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const out = new Uint8Array(expectedSize);
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.length > expectedSize) {
      await reader.cancel();
      throw new Error('decompressed data is larger than declared');
    }
    out.set(value, length);
    length += value.length;
  }
  if (length !== expectedSize) throw new Error('decompressed data is smaller than declared');
  return out;
}

/** Chunk size giving roughly four-second frames on the given modem. */
export function chunkSizeFor(modem: { rawBitRate: number; maxPayload: number }): number {
  return Math.max(16, Math.min(modem.maxPayload - CHUNK_HEADER, Math.floor((modem.rawBitRate * 4 * 0.75) / 8)));
}
