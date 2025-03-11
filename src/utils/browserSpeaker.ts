// src/utils/browserSpeaker.ts
export default class BrowserSpeaker {
  private audioContext: AudioContext;

  constructor(options?: { sampleRate?: number }) {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: options?.sampleRate || 44100,
    });
  }

  /**
   * Write a PCM buffer (assumed 16-bit little-endian, mono) to the output.
   * This is a basic implementation using the Web Audio API.
   */
  write(buffer: Buffer | ArrayBuffer, callback?: () => void): void {
    let arrayBuffer: ArrayBuffer;
    if (buffer instanceof Buffer) {
      // Convert Node Buffer to ArrayBuffer if needed
      arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } else {
      arrayBuffer = buffer;
    }

    // Assuming 16-bit PCM, mono, sampleRate from audioContext
    const sampleRate = this.audioContext.sampleRate;
    const samples = new Int16Array(arrayBuffer);
    const floatData = new Float32Array(samples.length);

    // Convert 16-bit PCM to Float32
    for (let i = 0; i < samples.length; i++) {
      floatData[i] = samples[i] / 32768;
    }

    // Create an AudioBuffer and copy the data
    const audioBuffer = this.audioContext.createBuffer(1, floatData.length, sampleRate);
    audioBuffer.copyToChannel(floatData, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);
    source.start();

    if (callback) {
      source.onended = callback;
    }
  }
}
