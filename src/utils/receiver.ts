// src/utils/receiver.ts

import { hammingDecodeBuffer } from "./errorCorrection";
import { multiplexDecode, demodulateQPSKChannel } from "./modulation";
import { bitsToBuffer } from "./util";
import { handleIncomingHandshake } from "./handshake";
import { sendMessage } from "./transmitter";
import { Buffer } from "buffer"; // if needed for browser Buffer support

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

let audioContext: AudioContext | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let mediaStream: MediaStream | null = null;

// We'll accumulate audio data here until we have one second worth.
let accumulatedBuffer = Buffer.alloc(0);
const bytesPerSecond = sampleRate * channels * (bitDepth / 8);

/**
 * startReceiver:
 * Uses the Web Audio API to capture microphone input and process audio data.
 * The provided callback is invoked when a non‑handshake message is decoded.
 */
export async function startReceiver(messageCallback: (msg: any) => void = () => {}): Promise<void> {
  console.log("=== RECEIVER PIPELINE (Web Audio API) ===");

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    console.error("Error accessing microphone:", err);
    return;
  }

  audioContext = new AudioContext({ sampleRate });
  const source = audioContext.createMediaStreamSource(mediaStream);

  // Create a ScriptProcessor node for audio processing.
  const bufferSize = 4096;
  scriptProcessor = audioContext.createScriptProcessor(bufferSize, channels, channels);
  source.connect(scriptProcessor);
  // Optionally, connect to destination if you want audio output:
  scriptProcessor.connect(audioContext.destination);

  scriptProcessor.onaudioprocess = (audioProcessingEvent: AudioProcessingEvent) => {
    const inputBuffer = audioProcessingEvent.inputBuffer;
    // Retrieve the time-domain PCM data from the first channel.
    const inputData = inputBuffer.getChannelData(0);
    // Convert Float32Array (-1 to 1) to 16-bit PCM.
    const pcmData = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      const sample = Math.max(-1, Math.min(1, inputData[i]));
      pcmData[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }
    // Convert the Int16Array to a Buffer.
    const chunkBuffer = Buffer.from(pcmData.buffer);
    // Accumulate data until we have one second worth.
    accumulatedBuffer = Buffer.concat([accumulatedBuffer, chunkBuffer]);
    while (accumulatedBuffer.length >= bytesPerSecond) {
      const chunk = accumulatedBuffer.slice(0, bytesPerSecond);
      accumulatedBuffer = accumulatedBuffer.slice(bytesPerSecond);
      // Process the chunk:
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
        try {
          const parsed = JSON.parse(message);
          if (parsed && parsed.type === "HANDSHAKE") {
            // Process handshake messages.
            handleIncomingHandshake(message, sendFunctionPlaceholder);
            continue;
          }
        } catch (e) {
          // Not a handshake message.
        }
        console.log("Received message:", message);
        messageCallback(message);
      } catch (e) {
        console.error("Error during decoding/decompression:", e);
      }
    }
  };

  console.log("Receiver started... listening for ultrasonic messages.");
}

/**
 * stopReceiver:
 * Stops the audio processing and microphone capture.
 */
export function stopReceiver(): void {
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor.onaudioprocess = null;
    scriptProcessor = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  console.log("Receiver stopped.");
}

/**
 * sendFunctionPlaceholder:
 * Used by the receiver to reply with handshake ACKs.
 * It delegates to sendMessage with the current parameters.
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
