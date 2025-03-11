
---

# Ultrasonic Middleware for Chirp

This section introduces the new ultrasonic communication stack integrated into Chirp. The key changes and goals are:

- **Dynamic Parameter Negotiation:**  
  Implements a full handshake process—exchanging baud rate, compression, frequency, and error correction settings (inspired by fax modems)—to determine the optimal transmission parameters.

- **Enhanced Data Transmission:**  
  Uses zlib compression, Hamming(7,4) error correction, two‑channel multiplexing, and QPSK modulation in the ultrasonic frequency range (approximately 18–19 kHz) to achieve robust, high-throughput communication.

- **Legacy-Compatible API:**  
  Provides a middleware layer (via `audioCodec.ts`) that replicates the original audio layer API (e.g., `encodeText`, `decodeAudio`, `resetDecoder`, etc.), so the top‑level Chirp app can continue to interface with the audio functions without any changes.

This update ensures that Chirp can seamlessly leverage adaptive ultrasonic data exchange using standard hardware.

---