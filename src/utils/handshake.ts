// src/utils/handshake.js

import EventEmitter from "eventemitter3";
const handshakeEmitter = new EventEmitter();

/**
 * sendHandshakeMessage:
 * Sends a handshake message with a given subtype ("PRE", "ACK", or "READY")
 * and a candidate object that includes parameters like bitDuration, compression, frequency, etc.
 */
export function sendHandshakeMessage(sendFunction: (arg0: string) => void, subtype: string, candidate: {} | undefined, handshakeId: string) {
  const messageObj = {
    type: "HANDSHAKE",
    subtype: subtype,
    candidate, // full candidate object
    id: handshakeId,
  };
  const messageStr = JSON.stringify(messageObj);
  sendFunction(messageStr);
}

/**
 * handleIncomingHandshake:
 * Processes an incoming handshake message. For "PRE" messages, it immediately replies with an "ACK".
 * For "ACK" messages, it emits the candidate via an event.
 */
export function handleIncomingHandshake(messageStr: string, sendFunction: (arg0: string) => void) {
  try {
    let msg = JSON.parse(messageStr);
    if (msg.type === "HANDSHAKE") {
      if (msg.subtype === "PRE") {
        console.log(`Received handshake PRE: candidate=${JSON.stringify(msg.candidate)}, id=${msg.id}`);
        // Respond with ACK using the same candidate.
        sendHandshakeMessage(sendFunction, "ACK", msg.candidate, msg.id);
      } else if (msg.subtype === "ACK") {
        console.log(`Received handshake ACK: candidate=${JSON.stringify(msg.candidate)}, id=${msg.id}`);
        handshakeEmitter.emit(msg.id, msg.candidate);
      } else if (msg.subtype === "READY") {
        console.log(`Received READY signal from peer.`);
        handshakeEmitter.emit("READY", msg.candidate);
      }
    }
  } catch (e) {
    console.error("Failed to parse handshake message:", e);
  }
}

/**
 * negotiateParameters:
 * For the transmitter, iterates over a list of candidate parameter sets (objects) with retries and timeouts.
 * Returns the candidate object that was agreed upon.
 */
export async function negotiateParameters(sendFunction: { (arg0: string): void; (arg0: string): void; }, candidateList: string | any[], waitTime = 2000, retries = 3) {
  for (let candidate of candidateList) {
    for (let attempt = 0; attempt < retries; attempt++) {
      const handshakeId = Date.now() + "-" + Math.random();
      console.log(`Attempting handshake with candidate=${JSON.stringify(candidate)} (attempt ${attempt + 1})`);
      sendHandshakeMessage(sendFunction, "PRE", candidate, handshakeId);
      let agreedCandidate = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          handshakeEmitter.removeAllListeners(handshakeId);
          resolve(null);
        }, waitTime);
        handshakeEmitter.once(handshakeId, (cand) => {
          clearTimeout(timeout);
          resolve(cand);
        });
      });
      if (agreedCandidate !== null) {
        console.log(`Handshake succeeded with candidate=${JSON.stringify(agreedCandidate)}`);
        // Optionally, send a READY message after a successful handshake.
        sendHandshakeMessage(sendFunction, "READY", agreedCandidate, handshakeId);
        return agreedCandidate;
      } else {
        console.log(`No ACK received for candidate=${JSON.stringify(candidate)} on attempt ${attempt + 1}`);
      }
    }
  }
  console.log("Handshake negotiation failed for all candidates. Using default candidate.");
  return candidateList[candidateList.length - 1];
}
