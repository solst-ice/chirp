// src/utils/errorCorrection.js

import { bufferToBits, bitsToBuffer } from "./util";

function hammingEncodeBuffer(buffer: any) {
  let bits = bufferToBits(buffer);
  let encodedBits = [];
  // Process bits in groups of 4
  for (let i = 0; i < bits.length; i += 4) {
    let d = [];
    for (let j = 0; j < 4; j++) {
      if (i + j < bits.length) {
        d.push(bits[i + j]);
      } else {
        d.push(0); // pad with zero if needed
      }
    }
    // Compute parity bits:
    // p1 = d1 ⊕ d2 ⊕ d4, p2 = d1 ⊕ d3 ⊕ d4, p3 = d2 ⊕ d3 ⊕ d4
    let p1 = d[0] ^ d[1] ^ d[3];
    let p2 = d[0] ^ d[2] ^ d[3];
    let p3 = d[1] ^ d[2] ^ d[3];
    // Encoded group: [p1, p2, d1, p3, d2, d3, d4]
    encodedBits.push(p1, p2, d[0], p3, d[1], d[2], d[3]);
  }
  return bitsToBuffer(encodedBits);
}

function hammingDecodeBuffer(buffer: any) {
  let bits = bufferToBits(buffer);
  let decodedBits = [];
  // Process bits in groups of 7
  for (let i = 0; i < bits.length; i += 7) {
    if (i + 7 > bits.length) break; // incomplete group
    let group = bits.slice(i, i + 7);
    // group indices: 0:p1, 1:p2, 2:d1, 3:p3, 4:d2, 5:d3, 6:d4
    let s1 = group[0] ^ group[2] ^ group[4] ^ group[6]; // parity check for positions 1,3,5,7
    let s2 = group[1] ^ group[2] ^ group[5] ^ group[6]; // parity check for positions 2,3,6,7
    let s3 = group[3] ^ group[4] ^ group[5] ^ group[6]; // parity check for positions 4,5,6,7
    let syndrome = s3 * 4 + s2 * 2 + s1; // syndrome value (1-indexed position of error)
    if (syndrome !== 0 && syndrome <= 7) {
      // Correct the error: flip the bit at (syndrome - 1)
      group[syndrome - 1] = group[syndrome - 1] ^ 1;
    }
    // Extract data bits: indices 2,4,5,6
    decodedBits.push(group[2], group[4], group[5], group[6]);
  }
  return bitsToBuffer(decodedBits);
}

module.exports = {
  hammingEncodeBuffer,
  hammingDecodeBuffer,
};
