// Browser audio plumbing: raw microphone samples in, rendered frames out.

const CHUNK = 2048;

// Batches render quanta (128 frames) into larger chunks before posting to the
// main thread. Inlined so it needs no separate bundler entry.
const WORKLET_SOURCE = `
class ChirpCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${CHUNK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(${CHUNK});
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('chirp-capture', ChirpCapture);
`;

export interface Capture {
  method: 'audio-worklet' | 'script-processor';
  stop(): void;
}

/**
 * Stream mono microphone samples from `source` to `onSamples`. Uses an
 * AudioWorklet where available (runs off the main thread and keeps going in
 * background tabs), falling back to ScriptProcessorNode.
 */
export async function startCapture(
  ctx: AudioContext,
  source: AudioNode,
  onSamples: (samples: Float32Array) => void,
): Promise<Capture> {
  // Processing nodes only run when connected to the destination; route through silence.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);

  if (ctx.audioWorklet) {
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'chirp-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(e.data);
      source.connect(node);
      node.connect(sink);
      return {
        method: 'audio-worklet',
        stop() {
          node.port.onmessage = null;
          source.disconnect(node);
          node.disconnect();
          sink.disconnect();
        },
      };
    } catch (err) {
      console.warn('AudioWorklet unavailable, falling back to ScriptProcessor', err);
    }
  }

  const node = ctx.createScriptProcessor(CHUNK, 1, 1);
  node.onaudioprocess = (e) => onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(node);
  node.connect(sink);
  return {
    method: 'script-processor',
    stop() {
      node.onaudioprocess = null;
      source.disconnect(node);
      node.disconnect();
      sink.disconnect();
    },
  };
}

/** Play rendered samples; `done` resolves when playback finishes or is stopped. */
export function play(ctx: AudioContext, samples: Float32Array): { done: Promise<void>; stop(): void } {
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.copyToChannel(samples, 0);
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  const done = new Promise<void>((resolve) => {
    node.onended = () => {
      node.disconnect();
      resolve();
    };
  });
  node.start();
  return {
    done,
    stop() {
      try {
        node.stop();
      } catch {
        // Already stopped.
      }
    },
  };
}
