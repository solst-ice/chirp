// src/utils/receiver.js

const mic = require("mic");
const zlib = require("zlib");
const { hammingDecodeBuffer } = require("./errorCorrection");
import { multiplexDecode, demodulateQPSKChannel } from "./modulation";
const { bitsToBuffer } = require("./util");
const { handleIncomingHandshake } = require("./handshake");
const { sendMessage } = require("./transmitter");

const sampleRate = 44100;
const channels = 1;
const bitDepth = 16;

// Global parameters for demodulation (default candidate)
let currentParams = {
  bitDuration: 0.1,
  frequency: { ch1: 18000, ch2: 18500 },
  compression: "zlib",
  errorCorrection: "hamming",
};

let micInstance: { getAudioStream: () => any; start: () => void; stop: () => void } | null = null;

/**
 * startReceiver:
 * Starts the microphone capture, processes one‑second audio chunks, and handles messages.
 * The callback (if provided) is called when a non‑handshake message is received.
 */
function startReceiver(messageCallback: (arg0: any) => void) {
  console.log("=== RECEIVER PIPELINE ===");
  micInstance = mic({
    rate: String(sampleRate),
    channels: String(channels),
    bitwidth: String(bitDepth),
    encoding: "signed-integer",
    endian: "little",
    device: "default",
  });
  if (!micInstance) {
    throw new Error("micInstance is null; ensure it is properly initialized.");
  }
  const micInputStream = micInstance.getAudioStream();

  let audioBuffer = Buffer.alloc(0);
  const bytesPerSecond = sampleRate * channels * (bitDepth / 8);

  micInputStream.on("data", (data: Uint8Array<ArrayBufferLike>) => {
    audioBuffer = Buffer.concat([audioBuffer, data]);
    // Process one‑second chunks.
    while (audioBuffer.length >= bytesPerSecond) {
      const chunk = audioBuffer.slice(0, bytesPerSecond);
      audioBuffer = audioBuffer.slice(bytesPerSecond);
      // Demodulate each channel using QPSK with currentParams.
      const symbolDuration = currentParams.bitDuration;
      const carrierFreq1 = currentParams.frequency.ch1;
      const carrierFreq2 = currentParams.frequency.ch2;
      const bitsCh1 = demodulateQPSKChannel(chunk, carrierFreq1, sampleRate, symbolDuration);
      const bitsCh2 = demodulateQPSKChannel(chunk, carrierFreq2, sampleRate, symbolDuration);
      const ch1Buffer = bitsToBuffer(bitsCh1);
      const ch2Buffer = bitsToBuffer(bitsCh2);
      const eccEncoded = multiplexDecode(ch1Buffer, ch2Buffer);
      try {
        const decodedBuffer = hammingDecodeBuffer(eccEncoded);
        // Decompress the payload.
        const message = zlib.inflateSync(decodedBuffer).toString();
        // If the message is a handshake message, process it.
        try {
          let parsed = JSON.parse(message);
          if (parsed && parsed.type === "HANDSHAKE") {
            // Pass handshake messages to the handshake module.
            handleIncomingHandshake(message, sendFunctionPlaceholder);
            continue;
          }
        } catch (e) {
          // Not a handshake message.
        }
        console.log("Received message:", message);
        if (messageCallback) {
          messageCallback(message);
        }
      } catch (e) {
        console.error("Error during decoding/decompression:", e);
      }
    }
  });

  micInputStream.on("error", (err: string) => {
    console.error("Microphone error:", err);
  });

  if (!micInstance) {
    throw new Error("micInstance is null; ensure it is properly initialized.");
  }
  micInstance.start();
  console.log("Receiver started... listening for ultrasonic messages.");
}

/**
 * stopReceiver:
 * Stops the microphone capture.
 */
function stopReceiver() {
  if (micInstance) {
    micInstance.stop();
    console.log("Receiver stopped.");
  }
}

/**
 * sendFunctionPlaceholder:
 * Used by the receiver to reply with handshake ACKs. It calls the transmitter's sendMessage
 * using the currentParams.
 */
function sendFunctionPlaceholder(messageStr: string) {
  console.log("Receiver sending handshake response:", messageStr);
  sendMessage(messageStr, currentParams);
}

/**
 * setParameters:
 * Updates the global demodulation parameters.
 */
function setParameters(newParams: { bitDuration: number; frequency: { ch1: number; ch2: number }; compression: string; errorCorrection: string }) {
  currentParams = newParams;
  console.log("Receiver parameters updated to:", currentParams);
}

module.exports = {
  startReceiver,
  stopReceiver,
  setParameters,
};
