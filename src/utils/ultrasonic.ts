// src/utils/ultrasonic.ts
//
// High-level wrapper for ultrasonic communication.
// Exposes start(), send(), and stop() endpoints, and emits a "message" event when a new message is received.

import EventEmitter from "eventemitter3";
import { sendMessage } from "./transmitter";
import { startReceiver, stopReceiver, setParameters } from "./receiver";
import { negotiateParameters } from "./handshake";

// Candidate parameter sets (each is a candidate object).
// You can extend these objects to include additional parameters if needed.
export const candidateList = [
  { bitDuration: 0.05, compression: "zlib", frequency: { ch1: 18000, ch2: 18500 }, errorCorrection: "hamming" },
  { bitDuration: 0.06, compression: "zlib", frequency: { ch1: 18000, ch2: 18500 }, errorCorrection: "hamming" },
  { bitDuration: 0.08, compression: "zlib", frequency: { ch1: 18000, ch2: 18500 }, errorCorrection: "hamming" },
  { bitDuration: 0.1, compression: "zlib", frequency: { ch1: 18000, ch2: 18500 }, errorCorrection: "hamming" },
];

class UltrasonicService extends EventEmitter {
  currentCandidate: { bitDuration: number; compression: string; frequency: { ch1: number; ch2: number; }; errorCorrection: string; };
  receiverRunning: boolean;
  constructor() {
    super();
    // Default to the slowest candidate initially.
    this.currentCandidate = candidateList[candidateList.length - 1];
    this.receiverRunning = false;
  }

  /**
   * start():
   * Starts the receiver pipeline. Any incoming non‑handshake messages are re‑emitted as "message" events.
   */
  start() {
    if (this.receiverRunning) {
      console.warn("Ultrasonic service already started.");
      return;
    }
    startReceiver((msg: string) => {
      // When a message is received (and it isn’t handled as a handshake),
      // re-emit it for any listeners.
      this.emit("message", msg);
    });
    this.receiverRunning = true;
    console.log("Ultrasonic service started (receiver active).");
  }

  /**
   * send(message):
   * Performs full handshake negotiation to agree on parameters (bitDuration, frequency, etc.)
   * and then sends the provided message using those parameters.
   *
   * @param {string} message - The message to send.
   */
  async send(message: string) {
    // For handshake negotiation, define a simple send function that uses the first candidate.
    const sendFunction = (msg: string) => {
      sendMessage(msg, candidateList[0]);
    };

    // Negotiate full candidate parameters with the peer.
    this.currentCandidate = await negotiateParameters(sendFunction, candidateList, 2000, 3);
    console.log("Negotiated candidate parameters:", this.currentCandidate);
    // Update receiver demodulation parameters with the negotiated settings.
    setParameters(this.currentCandidate);
    // Optionally, you could send a READY message here:
    // sendMessage(JSON.stringify({ type: "HANDSHAKE", subtype: "READY" }), this.currentCandidate);
    // Finally, send the actual data message.
    sendMessage(message, this.currentCandidate);
  }

  /**
   * stop():
   * Stops the receiver pipeline.
   */
  stop() {
    stopReceiver();
    this.receiverRunning = false;
    console.log("Ultrasonic service stopped.");
  }
}

export default new UltrasonicService();
