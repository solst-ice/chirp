// src/utils/modulation.js

// QPSK modulation mapping: convert 2 bits into a phase.
// Mapping: 00 -> π/4, 01 -> 3π/4, 11 -> 5π/4, 10 -> 7π/4.
export function bitsToPhase(b1: number, b2: number) {
  const symbol = (b1 << 1) | b2;
  switch (symbol) {
    case 0:
      return Math.PI / 4; // 00
    case 1:
      return (3 * Math.PI) / 4; // 01
    case 3:
      return (5 * Math.PI) / 4; // 11
    case 2:
      return (7 * Math.PI) / 4; // 10
    default:
      return Math.PI / 4;
  }
}

// QPSK modulation for one channel.
export function modulateQPSKChannel(bits: string | any[], carrierFreq: number, sampleRate: number, symbolDuration: number) {
  const samplesPerSymbol = Math.floor(sampleRate * symbolDuration);
  let numSymbols = Math.ceil(bits.length / 2);
  let samples = new Float32Array(numSymbols * samplesPerSymbol);
  const amplitude = 0.5;
  // Process bits in pairs.
  for (let i = 0; i < numSymbols; i++) {
    let b1 = bits[i * 2] !== undefined ? bits[i * 2] : 0;
    let b2 = bits[i * 2 + 1] !== undefined ? bits[i * 2 + 1] : 0;
    let phase = bitsToPhase(b1, b2);
    for (let n = 0; n < samplesPerSymbol; n++) {
      let t = n / sampleRate;
      samples[i * samplesPerSymbol + n] = amplitude * Math.cos(2 * Math.PI * carrierFreq * t + phase);
    }
  }
  return samples;
}

// QPSK demodulation for one channel.
export function demodulateQPSKChannel(pcmBuffer: Buffer<ArrayBuffer>, carrierFreq: number, sampleRate: number, symbolDuration: number) {
  const samplesPerSymbol = Math.floor(sampleRate * symbolDuration);
  const totalSamples = pcmBuffer.length / 2;
  let numSymbols = Math.floor(totalSamples / samplesPerSymbol);
  let samples = new Float32Array(totalSamples);
  // Convert PCM buffer to float samples (16-bit little endian)
  for (let i = 0; i < totalSamples; i++) {
    samples[i] = pcmBuffer.readInt16LE(i * 2) / 32767;
  }
  let bits = [];
  for (let i = 0; i < numSymbols; i++) {
    let I = 0,
      Q = 0;
    for (let n = 0; n < samplesPerSymbol; n++) {
      let t = n / sampleRate;
      let sample = samples[i * samplesPerSymbol + n];
      I += sample * Math.cos(2 * Math.PI * carrierFreq * t);
      Q += sample * Math.sin(2 * Math.PI * carrierFreq * t);
    }
    let estimatedPhase = Math.atan2(Q, I);
    if (estimatedPhase < 0) {
      estimatedPhase += 2 * Math.PI;
    }
    // Determine closest constellation point.
    let constellation = [
      { phase: Math.PI / 4, bits: [0, 0] },
      { phase: (3 * Math.PI) / 4, bits: [0, 1] },
      { phase: (5 * Math.PI) / 4, bits: [1, 1] },
      { phase: (7 * Math.PI) / 4, bits: [1, 0] },
    ];
    let minDiff = Infinity;
    let chosenBits = [0, 0];
    for (let point of constellation) {
      let diff = Math.abs(estimatedPhase - point.phase);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < minDiff) {
        minDiff = diff;
        chosenBits = point.bits;
      }
    }
    bits.push(chosenBits[0], chosenBits[1]);
  }
  return bits;
}

// Multiplexing: interleave bytes into two channels.
export function multiplexEncode(buffer: string | any[]) {
  let ch1 = [];
  let ch2 = [];
  for (let i = 0; i < buffer.length; i++) {
    if (i % 2 === 0) ch1.push(buffer[i]);
    else ch2.push(buffer[i]);
  }
  return { channel1: Buffer.from(ch1), channel2: Buffer.from(ch2) };
}

export function multiplexDecode(ch1: string | any[], ch2: string | any[]) {
  let totalLength = ch1.length + ch2.length;
  let out = [];
  let i1 = 0,
    i2 = 0;
  for (let i = 0; i < totalLength; i++) {
    if (i % 2 === 0) {
      if (i1 < ch1.length) out.push(ch1[i1++]);
    } else {
      if (i2 < ch2.length) out.push(ch2[i2++]);
    }
  }
  return Buffer.from(out);
}

module.exports = {
  modulateQPSKChannel,
  demodulateQPSKChannel,
  multiplexEncode,
  multiplexDecode,
};
