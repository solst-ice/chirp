import { useEffect, useRef, useState } from 'react';
import { getModem } from '../modem/profiles';
import { V1 } from './dsp';
import { EchoFigure, FecFigure, FftFigure, FilesFigure, FrameFigure, ModesFigure, NibbleFigure, SyncFigure, ToneFigure, V1Figure } from './figures';
import { playV1, playV2, stopSound } from './sound';
import './Explainer.css';

const v1Seconds = (chars: number) => 2 * V1.markerSeconds + V1.gapSeconds + chars * (V1.toneSeconds + V1.gapSeconds);
const v2Seconds = (bytes: number) => getModem('fast').airtime(bytes);

function Fix({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ex-fix">
      <h4>
        <span aria-hidden="true">+ </span>
        {title}
      </h4>
      {children}
    </section>
  );
}

/** "How it works" article, for someone meeting data-over-sound for the first time. */
export default function Explainer({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  const [demo, setDemo] = useState('Hi ✓');
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    ref.current?.focus({ preventScroll: true });
    return () => stopSound();
  }, []);

  return (
    <article className="explainer" ref={ref} tabIndex={-1} aria-labelledby="explainer-title">
      <header className="ex-head">
        <h2 id="explainer-title">HOW CHIRP WORKS</h2>
        <button className="btn" onClick={onClose}>
          [ CLOSE ]
        </button>
      </header>
      <p className="ex-dek">
        Two devices, a speaker and a microphone, no network. This is how text turns into sound and back, starting with the
        simplest version that works.
      </p>

      <section>
        <h3>1 · Sound is a list of numbers</h3>
        <p>
          A speaker pushes air back and forth; a microphone measures that push thousands of times a second. The simplest sound
          is a pure tone: a smooth wave repeating at one <em>frequency</em>, counted in hertz (Hz, cycles per second). More
          cycles per second sounds higher.
        </p>
        <ToneFigure busy={busy} />
      </section>

      <section>
        <h3>2 · Version 1: one pitch per character</h3>
        <p>
          So give every character its own pitch. The first chirp did exactly that: A was 5,700 Hz, B 5,800 Hz and so on, 100
          Hz apart. A message was a start tone, one short tone per character, then an end tone.
        </p>
        <V1Figure busy={busy} />
      </section>

      <section>
        <h3>3 · Hearing it: the FFT</h3>
        <p>
          The receiver doesn't get pitches, only that stream of numbers. A <em>Fast Fourier Transform</em> (FFT) takes a short
          slice of them (2,048 samples, about 43 ms) and measures how much of every frequency it contains, like a prism
          splitting light into colours. Version 1 took the loudest frequency and looked up the nearest character.
        </p>
        <FftFigure />
        <p>
          Push the hiss up: the FFT still finds a tone quieter than the noise around it, but past a point a random spike wins
          and the wrong letter comes out, with nothing to say it's wrong.
        </p>
      </section>

      <section>
        <h3>4 · Where version 1 broke down</h3>
        <ul className="ex-list">
          <li>It could only send capitals, digits and some symbols: no lowercase, emoji or files.</li>
          <li>Two equal letters in a row sounded like one long letter, so doubles often lost a letter.</li>
          <li>Rooms echo: each tone kept ringing into the next one.</li>
          <li>It checked for tones on every screen refresh, which slows or stops when the tab is in the background.</li>
          <li>A misheard letter looked exactly like a correct one.</li>
          <li>One tone at a time is slow: about 10 characters a second.</li>
        </ul>
      </section>

      <section>
        <h3>5 · Version 2, one fix at a time</h3>
        <p>Today's modem keeps the core idea, tones a microphone can pick out, and fixes each of those problems.</p>

        <Fix title="Bytes instead of characters">
          <p>
            Everything a computer stores is bytes, so send bytes. Each byte splits into two 4-bit halves called{' '}
            <em>nibbles</em>. A nibble has only 16 possible values, so 16 tones can carry anything. Type here; the next figure
            uses it too.
          </p>
          <NibbleFigure value={demo} onChange={setDemo} />
        </Fix>

        <Fix title="Fixed time slots, four tones at once">
          <p>
            Sound is cut into 30 ms slots: 20 ms of tone, then 10 ms to let the room settle. Two equal values are simply two
            slots, so doubles survive. Each slot sounds four tones at once, one from each of four sets of 16, so it carries four
            nibbles, two bytes. Tones sit exactly 50 Hz apart (1 ÷ 20 ms), which keeps them from bleeding into each other. That
            lets the receiver measure exactly those frequencies at exactly those moments, instead of scanning the whole spectrum.
          </p>
          <FrameFigure value={demo} />
        </Fix>

        <Fix title="Dodging echoes">
          <p>
            Even and odd slots use two different sets of tones, offset by one step. When a tone echoes into the next slot, it
            rings on a frequency the receiver isn't reading.
          </p>
          <EchoFigure />
        </Fix>

        <Fix title="Finding the start, and keeping time">
          <p>
            Every message begins with 8 slots of a known pattern. The receiver slides that pattern along everything it hears and
            locks on where it matches. No two devices' clocks agree exactly, so it also checks each slot slightly early and
            slightly late and nudges its timing toward the stronger reading.
          </p>
          <SyncFigure />
        </Fix>

        <Fix title="Fixing mistakes">
          <p>
            Some tones will still be misheard. <em>Reed–Solomon</em> error correction adds repair bytes (16 per 96 bytes in
            FAST) that let the receiver rebuild the bytes it got wrong. The bytes of different blocks are interleaved, so a burst
            of noise like a cough or a door hurts each block only a little. A final <em>CRC-32</em> checksum confirms the result;
            a message that fails it is marked corrupted instead of passed off as correct.
          </p>
          <FecFigure />
        </Fix>

        <Fix title="Files">
          <p>
            A file is compressed, cut into numbered chunks, and announced by a manifest sent both first and last. Chunks can
            arrive in any order, and pressing RESEND lets the receiver fill in whatever it missed.
          </p>
          <FilesFigure />
        </Fix>

        <Fix title="Three modes">
          <p>
            FAST uses the most tones. ROBUST uses fewer tones and longer slots for noisy, echoey rooms. INAUDIBLE sits at 18–19
            kHz, above what most adults hear, with one tone at a time, because two high tones together can produce an audible
            buzz in small speakers. The receiver listens for all three at once.
          </p>
          <ModesFigure />
        </Fix>
      </section>

      <section>
        <h3>6 · The result</h3>
        <table className="ex-compare">
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">version 1</th>
              <th scope="col">version 2 (FAST)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">sends</th>
              <td>A–Z, 0–9, some symbols</td>
              <td>any bytes: text, emoji, files</td>
            </tr>
            <tr>
              <th scope="row">"HELLO"</th>
              <td>{v1Seconds(5).toFixed(2)} s</td>
              <td>{v2Seconds(5).toFixed(2)} s, including repair bytes</td>
            </tr>
            <tr>
              <th scope="row">100 characters</th>
              <td>{v1Seconds(100).toFixed(1)} s</td>
              <td>{v2Seconds(100).toFixed(1)} s</td>
            </tr>
            <tr>
              <th scope="row">mistakes</th>
              <td>shown as if correct</td>
              <td>repaired, or flagged as corrupted</td>
            </tr>
          </tbody>
        </table>
        <div className="ex-controls">
          <button className="btn" disabled={busy} onClick={() => void playV1('HELLO')}>
            [ ▶ HELLO, VERSION 1 ]
          </button>
          <button className="btn" disabled={busy} onClick={() => void playV2('HELLO')}>
            [ ▶ HELLO, VERSION 2 ]
          </button>
        </div>
        <p className="dim">
          Version 2's HELLO is a real transmission: if this device is listening, its own log will show it arriving.
        </p>
      </section>
    </article>
  );
}
