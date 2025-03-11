// src/utils/transmitter.ts

import Zlib from "zlib";
import Speaker from "speaker";
import { hammingEncodeBuffer } from "./errorCorrection";
import { multiplexEncode, modulateQPSKChannel } from "./modulation";
import { bufferToBits } from "./util";

const sampleRate = 44100;
const channels = 1;
const bitDepth = 16;

/**
 * floatToPCM16Buffer: Converts a Float32Array of samples to a 16-bit PCM Buffer.
 */
function floatToPCM16Buffer(floatArray: string | any[] | Float32Array<ArrayBuffer>) {
  let buffer = Buffer.alloc(floatArray.length * 2);
  for (let i = 0; i < floatArray.length; i++) {
    let sample = Math.max(-1, Math.min(1, floatArray[i]));
    let intSample = Math.floor(sample * 32767);
    buffer.writeInt16LE(intSample, i * 2);
  }
  return buffer;
}

/**
 * sendMessage:
 * Pipeline: compress (zlib) → Hamming encode → multiplex → QPSK modulation on two channels → combine and output audio.
 * The candidate parameter is an object carrying bitDuration and frequency details.
 */
export function sendMessage(message: string, candidate: { bitDuration: number; frequency: { ch1: number; ch2: number } }) {
  console.log("=== TRANSMITTER PIPELINE ===");
  // 1. Compress the message using the candidate's compression type (only 'zlib' supported for now).
  const compressed = Zlib.deflateSync(message);
  console.log("Compressed length:", compressed.length);
  // 2. Error correction: Hamming encode.
  const eccEncoded = hammingEncodeBuffer(compressed);
  // 3. Multiplex: split into two channels.
  const { channel1, channel2 } = multiplexEncode(eccEncoded);
  console.log("Channel lengths:", channel1.length, channel2.length);
  // 4. Convert each channel to a bit array.
  const bitsCh1 = bufferToBits(channel1);
  const bitsCh2 = bufferToBits(channel2);
  // 5. Modulate each channel using QPSK with parameters from the candidate.
  const symbolDuration = candidate.bitDuration;
  const carrierFreq1 = candidate.frequency.ch1;
  const carrierFreq2 = candidate.frequency.ch2;
  const signal1 = modulateQPSKChannel(bitsCh1, carrierFreq1, sampleRate, symbolDuration);
  const signal2 = modulateQPSKChannel(bitsCh2, carrierFreq2, sampleRate, symbolDuration);
  // 6. Combine signals (sample‑wise average).
  let totalSamples = Math.min(signal1.length, signal2.length);
  let combined = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    combined[i] = (signal1[i] + signal2[i]) / 2;
  }
  // 7. Convert to 16‑bit PCM Buffer.
  const pcmBuffer = floatToPCM16Buffer(combined);
  // 8. Output via speakers.
  const speaker = new Speaker({ sampleRate: 44100, channels: 1, bitDepth: 16 });
  speaker.write(pcmBuffer, () => {
    console.log("Transmission complete.");
  });
}
