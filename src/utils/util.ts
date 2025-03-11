// src/utils/util.ts
// Utility functions for converting between buffers and bit arrays

export function bufferToBits(buffer: any) {
  let bits = [];
  for (let byte of buffer) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1);
    }
  }
  return bits;
}

export function bitsToBuffer(bits: string | any[]) {
  let bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8 && i + j < bits.length; j++) {
      byte = (byte << 1) | bits[i + j];
    }
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}
