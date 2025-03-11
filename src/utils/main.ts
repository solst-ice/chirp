// src/utils/main.js

const { negotiateBitDuration } = require("./handshake");
import { sendMessage } from "./transmitter";
const { startReceiver, setSymbolDuration } = require("./receiver");
import { candidateList } from "./ultrasonic";

// Mode: "tx", "rx", or "both" (default is "rx").
const mode = process.argv[2] || "rx";

if (mode === "rx" || mode === "both") {
  startReceiver();
}

if (mode === "tx" || mode === "both") {
  // Define a simple sendFunction for handshake negotiation.
  const sendFunction = (msg: string) => {
    sendMessage(msg, candidateList[0]); // initial candidate used for handshake PRE
  };

  (async () => {
    const negotiatedBitDuration = await negotiateBitDuration(sendFunction, candidateList, 2000, 3);
    console.log("Negotiated bit duration:", negotiatedBitDuration);
    // Update the receiver (if running in 'both' mode) with the negotiated duration.
    setSymbolDuration(negotiatedBitDuration);
    // Delay briefly to allow the handshake to settle.
    setTimeout(() => {
      sendMessage("Hello, robust ultrasonic world!", negotiatedBitDuration);
    }, 3000);
  })();
}
