import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getModem } from '../modem/profiles';
import { V1 } from './dsp';
import {
  DemoButton,
  DemoNote,
  EchoFigure,
  FecFigure,
  FftFigure,
  FilesFigure,
  FrameFigure,
  ModesFigure,
  NibbleFigure,
  PitchFigure,
  SyncFigure,
  ToneFigure,
  V1Figure,
  V1TableFigure,
} from './figures';
import Presentation, { type Slide } from './Presentation';
import { playV1, playV2, stopSound } from './sound';
import './Explainer.css';

const v1Seconds = (chars: number) =>
  V1.leadSeconds + 2 * V1.markerSeconds + V1.gapSeconds + chars * (V1.toneSeconds + V1.gapSeconds) + V1.endPauseSeconds;
const v2Seconds = (bytes: number) => getModem('fast').airtime(bytes);

function Fix({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section className="ex-fix" id={id}>
      <h4>
        <span aria-hidden="true">+ </span>
        {title}
      </h4>
      {children}
    </section>
  );
}

/**
 * One slide-sized piece of the article: a numbered section, or a part of one
 * (a version 2 fix, or a closer look). The article shows them in order;
 * presentation mode one at a time.
 */
interface Block {
  id: string;
  title: string;
  kind?: 'fix' | 'detail';
  /** The numbered section a part belongs to, shown above it on its slide. */
  kicker?: string;
  body: React.ReactNode;
}

const FIXES_HEADING = '5 · Version 2, one fix at a time';

export default function Explainer() {
  const [demo, setDemo] = useState('Hi ✓');
  const [presenting, setPresenting] = useState(false);
  const [slide, setSlide] = useState(0);
  const presentRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => stopSound(), []);

  const blocks: Block[] = [
    {
      id: 'top',
      title: 'How chirp works',
      body: (
        <>
          <header className="ex-head">
            <h1 id="explainer-title">HOW CHIRP WORKS</h1>
          </header>
          <p className="ex-dek">
            Two devices, a speaker and a microphone, no network. This is how text turns into sound and back, starting with the
            simplest version that works.
          </p>
        </>
      ),
    },
    {
      id: 'sound',
      title: '1 · Sound is a list of numbers',
      body: (
        <>
          <p>
            A speaker pushes air back and forth; a microphone measures that push thousands of times a second. The simplest sound
            is a pure tone: a smooth wave repeating at one <em>frequency</em>, counted in hertz (Hz, cycles per second). More
            cycles per second sounds higher.
          </p>
          <ToneFigure />
        </>
      ),
    },
    {
      id: 'version-1',
      title: '2 · Version 1: one pitch per character',
      body: (
        <>
          <p>
            So give every character its own pitch. The first chirp did exactly that: A was 5,700 Hz, B 5,800 Hz and so on, 100
            Hz apart. A message was a start tone, one short tone per character, then an end tone. Each character also sounded a
            quieter second tone {V1.partnerOffset} Hz above its pitch, close enough that the receiver counted both as the same
            character.
          </p>
          <V1TableFigure />
          <V1Figure />
        </>
      ),
    },
    {
      id: 'fft',
      title: '3 · Hearing it: the FFT',
      body: (
        <>
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
        </>
      ),
    },
    {
      id: 'limits',
      title: '4 · Where version 1 broke down',
      body: (
        <>
          <ul className="ex-list">
            <li>It could only send capitals, digits and some symbols: no lowercase, emoji or files.</li>
            <li>Two equal letters in a row sounded like one long letter, so doubles often lost a letter.</li>
            <li>Rooms echo: each tone kept ringing into the next one.</li>
            <li>It checked for tones on every screen refresh, which slows or stops when the tab is in the background.</li>
            <li>A misheard letter looked exactly like a correct one.</li>
            <li>One character at a time is slow: about 10 characters a second.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'version-2',
      title: FIXES_HEADING,
      body: (
        <>
          <p>Today's modem keeps the core idea, tones a microphone can pick out, and fixes each of those problems.</p>
        </>
      ),
    },
    {
      id: 'fix-bytes',
      title: 'Bytes instead of characters',
      kind: 'fix',
      kicker: FIXES_HEADING,
      body: (
        <>
          <p>
            Everything a computer stores is bytes, so send bytes. Each byte splits into two 4-bit halves called{' '}
            <em>nibbles</em>. A nibble has only 16 possible values, so 16 tones can carry anything. Type here; the next figure
            uses it too.
          </p>
          <NibbleFigure value={demo} onChange={setDemo} />
        </>
      ),
    },
    {
      id: 'fix-slots',
      title: 'Fixed time slots, four tones at once',
      kind: 'fix',
      kicker: FIXES_HEADING,
      body: (
        <>
          <p>
            Sound is cut into fixed slots: 30 ms each in FAST. Each slot holds its tones steady for 20 ms, the stretch the
            receiver measures, with 5 ms fades at either end so one slot blends into the next without clicks. Two equal values
            are simply two slots, so doubles survive. Each slot sounds four tones at once, one from each of four sets of 16, so
            it carries four nibbles, two bytes. Tones sit exactly 50 Hz apart (1 ÷ 20 ms), which keeps them from bleeding into
            each other over that 20 ms. That lets the receiver measure exactly those frequencies at exactly those moments,
            instead of scanning the whole spectrum.
          </p>
          <FrameFigure value={demo} />
        </>
      ),
    },
    {
      id: 'pitches',
      title: 'Which pitch means which bits',
      kind: 'detail',
      kicker: FIXES_HEADING,
      body: (
        <>
          <p>
            Each tone is 4 bits, so it has 16 possible pitches, one for every value from 0000 to 1111. But the four tones in a
            slot don't share one set of 16: each has its own. Tone 1's pitches start at 1,500 Hz and climb 400 Hz per value;
            tone 2's sit 100 Hz above them, tone 3's 200 Hz, tone 4's 300 Hz. The four sets interleave, so two tones in a slot
            can never land on the same pitch, even when they carry the same bits, and the receiver reads each one as if it
            were alone. Four tones of 4 bits make 2 bytes every 30 ms slot.
          </p>
          <PitchFigure value={demo} />
        </>
      ),
    },
    {
      id: 'fix-echoes',
      title: 'Dodging echoes',
      kind: 'fix',
      kicker: FIXES_HEADING,
      body: (
        <>
          <p>
            Even and odd slots use two different sets of tones, offset by one step. When a tone echoes into the next slot, it
            rings on a frequency the receiver isn't reading.
          </p>
          <EchoFigure />
        </>
      ),
    },
    {
      id: 'fix-sync',
      title: 'Finding the start, and keeping time',
      kind: 'fix',
      kicker: FIXES_HEADING,
      body: (
        <>
          <p>
            Every message begins with 8 slots of a known pattern. The receiver slides that pattern along everything it hears and
            locks on where it matches. No two devices' clocks agree exactly, so it also checks each slot slightly early and
            slightly late and nudges its timing toward the stronger reading.
          </p>
          <SyncFigure />
        </>
      ),
    },
    {
      id: 'fix-fec',
      title: 'Fixing mistakes',
      kind: 'fix',
      kicker: FIXES_HEADING,
      body: (
        <>
          <p>
            Some tones will still be misheard. <em>Reed–Solomon</em> error correction adds repair bytes: in FAST, each block of
            up to 96 data bytes gets 16, enough to rebuild any 8 wrong bytes in it (more when the receiver can tell which
            readings were doubtful). A short message is a single, smaller block, so its repair bytes are a larger share. Longer
            messages are split into blocks whose bytes are interleaved, so a burst of noise like a cough or a door hurts each
            block only a little. A final <em>CRC-32</em> checksum confirms the result; a message that fails it is marked
            corrupted instead of passed off as correct.
          </p>
          <FecFigure />
        </>
      ),
    },
    {
      id: 'fix-files',
      title: 'Files',
      kind: 'fix',
      kicker: FIXES_HEADING,
      body: (
        <>
          <p>
            A file is compressed when that makes it smaller, cut into numbered chunks, and announced by a manifest sent both
            first and last. Chunks can arrive in any order. RESEND plays the whole file again, and the receiver keeps what it
            already has and fills in what it missed.
          </p>
          <FilesFigure />
        </>
      ),
    },
    {
      id: 'fix-modes',
      title: 'Three modes',
      kind: 'fix',
      kicker: FIXES_HEADING,
      body: (
        <>
          <p>
            FAST uses the most tones. ROBUST uses fewer tones and longer slots for noisy, echoey rooms. INAUDIBLE sits at 18–19
            kHz, above what most adults hear, with one tone at a time, because two high tones together can produce an audible
            buzz in small speakers. The receiver listens for all three at once.
          </p>
          <ModesFigure />
        </>
      ),
    },
    {
      id: 'result',
      title: '6 · The result',
      body: (
        <>
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
                <th scope="row">100 ASCII characters</th>
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
            <DemoButton id="v1" label="HELLO, VERSION 1" play={(id) => playV1(id, 'HELLO')} />
            <DemoButton id="v2" label="HELLO, VERSION 2" play={(id) => playV2(id, 'HELLO')} />
            <DemoNote ids={['v1', 'v2']} />
          </div>
          <p className="dim">
            Version 2's HELLO is a real transmission: another device running chirp within earshot will receive it.
          </p>
        </>
      ),
    },
  ];

  /** A block as the article shows it; slides reuse the same markup. */
  const render = (b: Block, id?: string) =>
    b.id === 'top' ? (
      b.body
    ) : b.kind === 'fix' ? (
      <Fix id={id} title={b.title}>
        {b.body}
      </Fix>
    ) : b.kind === 'detail' ? (
      <section className="ex-fix ex-detail" id={id}>
        <h4>{b.title}</h4>
        {b.body}
      </section>
    ) : (
      <section id={id}>
        <h3>{b.title}</h3>
        {b.body}
      </section>
    );

  const slides: Slide[] = blocks.map((b) => ({
    id: b.id,
    title: b.title,
    content: b.kicker ? (
      <>
        <p className="ex-kicker">{b.kicker}</p>
        {render(b)}
      </>
    ) : (
      render(b)
    ),
  }));

  // Presentation starts at the title slide, and on exit returns to the section of the slide it ended on.
  const present = () => {
    setSlide(0);
    setPresenting(true);
    // Not everywhere (iPhone Safari); the slides fill the window either way.
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };
  const returnTo = useRef<string | null>(null);
  const exit = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    returnTo.current = blocks[slide].id;
    setPresenting(false);
  };
  useLayoutEffect(() => {
    const id = returnTo.current;
    if (presenting || id === null) return;
    returnTo.current = null;
    if (id === 'top') window.scrollTo(0, 0);
    else document.getElementById(id)?.scrollIntoView({ block: 'start' });
    presentRef.current?.focus({ preventScroll: true });
  }, [presenting]);

  return (
    <>
      <nav className="ex-banner" aria-label="Page">
        <a href="/">[ ← GO BACK TO APP ]</a>
        <button ref={presentRef} className="btn" onClick={present}>
          [ ▶ PRESENTATION MODE ]
        </button>
      </nav>
      {presenting ? (
        <Presentation slides={slides} index={slide} onIndex={setSlide} onExit={exit} />
      ) : (
        <main>
          <article className="explainer" aria-labelledby="explainer-title">
            {blocks.map((b) => (
              <Fragment key={b.id}>{render(b, b.id)}</Fragment>
            ))}
          </article>
        </main>
      )}
    </>
  );
}
