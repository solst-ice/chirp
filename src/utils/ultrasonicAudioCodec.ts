// src/utils/audioCodec.ts
//
// This middleware replicates the original audioCodec.ts API for the top‑level app,
// but under the hood it now uses our new ultrasonic communication implementation.
// The exported constants have been updated to reflect the ultrasonic frequency range.

import ultrasonic from "./ultrasonic"; // our high-level ultrasonic service wrapper

// Updated constants for the ultrasonic implementation.
export const START_FREQUENCY = 18000; // Hz - default carrier frequency for channel 1
export const END_FREQUENCY = 18500; // Hz - default carrier frequency for channel 2
export const MINIMUM_VALID_FREQUENCY = 17000; // Hz - ignore any frequencies below the ultrasonic band
export const MAXIMUM_VALID_FREQUENCY = 19000; // Hz - ignore any frequencies above the ultrasonic band

// Internal state variables to mimic original audio codec state (if needed).
let isReceivingMessage = false;
let messageBuffer = "";
let startMarkerDetectionCount = 0;
let endMarkerDetectionCount = 0;
let lastDetectedFrequency = 0;
let lastDetectedTime = 0;
let lastDetectedChar = "";
let transmissionStartTime = 0;
let recentCharacters: string[] = [];
const charFrequencyCounts = new Map<string, number>();

/**
 * resetDecoder
 * Resets internal state of the decoder. This replicates the original export,
 * allowing the top‑level code to call resetDecoder() exactly as before.
 */
export const resetDecoder = (): void => {
  console.log("Decoder reset");
  isReceivingMessage = false;
  messageBuffer = "";
  startMarkerDetectionCount = 0;
  endMarkerDetectionCount = 0;
  lastDetectedFrequency = 0;
  lastDetectedTime = 0;
  lastDetectedChar = "";
  transmissionStartTime = 0;
  recentCharacters = [];
  charFrequencyCounts.clear();
};

/**
 * encodeText
 * Encodes and transmits a text message over the ultrasonic link.
 * Internally, it delegates the transmission to our ultrasonic service.
 *
 * @param text - The text message to send.
 */
export const encodeText = (text: string): void => {
  console.log("encodeText called:", text);
  ultrasonic.send(text);
};

/**
 * decodeAudio
 * Sets up a callback to be invoked when a new ultrasonic message is received.
 *
 * @param callback - Function that receives the decoded message.
 */
export const decodeAudio = (callback: (msg: string) => void): void => {
  console.log("Setting up decoder callback");
  ultrasonic.on("message", callback);
};

/**
 * startAudioLayer
 * Starts the ultrasonic service (receiver) so that the device begins listening.
 */
export const startAudioLayer = (): void => {
  console.log("Starting audio layer (ultrasonic service)...");
  ultrasonic.start();
};

/**
 * stopAudioLayer
 * Stops the ultrasonic service.
 */
export const stopAudioLayer = (): void => {
  console.log("Stopping audio layer (ultrasonic service)...");
  ultrasonic.stop();
};
