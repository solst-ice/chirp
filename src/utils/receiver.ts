// src/utils/receiver.ts

import mic from "mic";
import * as zlib from "zlib";
import { hammingDecodeBuffer } from "./errorCorrection";
import { multiplexDecode, demodulateQPSKChannel } from "./modulation";
import { bitsToBuffer } from "./util";
import { handleIncomingHandshake } from "./handshake";
import { sendMessage } from "./transmitter";

const sampleRate = 44100;
const channels = 1;
const bitDepth = 16;

interface Params {
  bitDuration: number;
  frequency: { ch1: number; ch2: number };
  compression: string;
  errorCorrection: string;
}

// Global parameters for demodulation (default candidate)
let currentParams: Params = {
  bitDuration: 0.1,
  frequency: { ch1: 18000, ch2: 18500 },
  compression: "zlib",
  errorCorrection: "hamming",
};

let micInstance: { getAudioStream: () => Buffer; start: () => void; stop: () => void } | null = null;

/**
 * startReceiver:
 * Starts the microphone capture, processes one‑second audio chunks, and handles messages.
 * The callback (if provided) is called when a non‑handshake message is received.
 */
// Example replacement for using "mic" in the browser
export async function startReceiver(messageCallback: (msg: any) => void = () => {}): Promise<void> {
  console.log("=== RECEIVER PIPELINE (Browser) ===");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const audioContext = new AudioContext({ sampleRate });
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    // Create a processing loop (e.g., using requestAnimationFrame)
    let audioBuffer = new Uint8Array(analyser.frequencyBinCount);
    const processAudio = () => {
      analyser.getByteFrequencyData(audioBuffer);
      // Process audioBuffer here (e.g., your demodulation, decoding logic, etc.)
      // For now, you can call the callback if you decode a message:
      // messageCallback(decodedMessage);
      requestAnimationFrame(processAudio);
    };
    processAudio();
    console.log("Receiver started (using Web Audio API).");
  } catch (err) {
    console.error("Error accessing microphone:", err);
  }
}

/**
 * stopReceiver:
 * Stops the microphone capture.
 */
export function stopReceiver(): void {
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
export function sendFunctionPlaceholder(messageStr: string): void {
  console.log("Receiver sending handshake response:", messageStr);
  sendMessage(messageStr, currentParams);
}

/**
 * setParameters:
 * Updates the global demodulation parameters.
 */
export function setParameters(newParams: Params): void {
  currentParams = newParams;
  console.log("Receiver parameters updated to:", currentParams);
}
