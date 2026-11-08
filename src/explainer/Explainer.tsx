import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ENCRYPTION_OVERHEAD, PBKDF2_ITERATIONS } from '../modem/encryption';
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
  GatesFigure,
  GuessFigure,
  ModesFigure,
  NibbleFigure,
  PitchFigure,
  SealFigure,
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
const ENCRYPTION_HEADING = '7 · Encryption';

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
            are simply two slots, so doubles survive. Each slot sounds four tones at once, each carrying one nibble, so a slot
            carries two bytes. The receiver knows when each slot starts and which pitches it can contain, so it measures just
            those, instead of scanning the whole spectrum.
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
            Each tone carries 4 bits, so it needs 16 pitches, one for every value from 0000 to 1111. Three spacings, from fine
            to coarse, decide where they go (these are FAST's numbers):
          </p>
          <ul className="ex-list ex-points">
            <li>
              <em>50 Hz, the grid.</em> Every pitch sits on a 50 Hz step. Over the receiver's 20 ms window, a tone one
              step higher fits exactly one more cycle (1 ÷ 20 ms = 50 Hz), so ideally measuring one step picks up nothing from
              its neighbours. In a real room, echoes and speakers blur that a little.
            </li>
            <li>
              <em>100 Hz, within a slot.</em> A slot uses only every other step: tone set A, or tone set B one step up
              (the next fix explains why). The four tones take its pitches in turn: tone 1 at 1,500 Hz, tone 2 at 1,600, tone 3
              at 1,700, tone 4 at 1,800, then tone 1 again at 1,900.
            </li>
            <li>
              <em>400 Hz, between values.</em> So each tone's own 16 pitches are 400 Hz apart: tone 1 plays 1,500 Hz
              for 0000, 1,900 Hz for 0001, and so on up to 7,500 Hz for 1111.
            </li>
          </ul>
          <p>
            Because the four tones never share a pitch, even when they carry the same bits, the receiver reads each one as if it
            were alone.
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
            Slots alternate between tone set A and tone set B, the two halves of the 50 Hz grid. When a tone echoes into the
            next slot, it rings on a pitch that slot doesn't use, so the receiver isn't reading it.
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
            buzz in small speakers. The receiver listens for all three at once. A fourth choice, ENCRYPTED, plays FAST's
            tones; section 7 explains it.
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
                <td>repaired, flagged, or sometimes not heard at all</td>
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
    {
      id: 'encryption',
      title: ENCRYPTION_HEADING,
      body: (
        <p>
          Sound is a broadcast: everyone in earshot hears every message, and anyone can send one. ENCRYPTED mode keeps FAST's
          tones but seals each frame first, so only a device with the same key, agreed in advance, can read it, or send a frame
          it will accept. The sync, header and repair bytes work as before: encryption sits on top of the modem, not inside it.
        </p>
      ),
    },
    {
      id: 'key',
      title: 'From a passphrase to a key',
      kind: 'detail',
      kicker: ENCRYPTION_HEADING,
      body: (
        <>
          <p>
            Both devices type the same passphrase. <em>PBKDF2</em> hashes it {PBKDF2_ITERATIONS.toLocaleString('en-US')} times
            into a 256-bit key; the key itself never goes on air. That takes a moment, once per passphrase. It matters because
            anyone who records a transmission can try passphrases offline for as long as they like, and every guess costs them
            the same {PBKDF2_ITERATIONS.toLocaleString('en-US')} rounds. What's left to protect you is how many passphrases
            they might have to try.
          </p>
          <GuessFigure />
        </>
      ),
    },
    {
      id: 'seal',
      title: 'Sealing a frame',
      kind: 'detail',
      kicker: ENCRYPTION_HEADING,
      body: (
        <>
          <p>
            Each frame is sealed on its own with <em>AES-256-GCM</em>, so file chunks can still arrive in any order. The inside
            holds the frame's real type, the time it was sent, and the data. Around it go:
          </p>
          <ul className="ex-list ex-points">
            <li>
              <em>a nonce:</em> 12 random bytes, new for every frame, so the same text never sounds the same twice;
            </li>
            <li>
              <em>the ciphertext:</em> the inside, scrambled with the key and the nonce, byte for byte the same length;
            </li>
            <li>
              <em>a tag:</em> 16 bytes computed from the key and every other byte. Change anything, or open it with another key,
              and it no longer matches.
            </li>
          </ul>
          <p>
            {ENCRYPTION_OVERHEAD} bytes in all, about {(v2Seconds(100 + ENCRYPTION_OVERHEAD) - v2Seconds(100)).toFixed(1)} s more
            sound for a 100-byte message in FAST. The text here is the same as in section 5.
          </p>
          <SealFigure value={demo} onChange={setDemo} />
        </>
      ),
    },
    {
      id: 'open',
      title: 'Opening it',
      kind: 'detail',
      kicker: ENCRYPTION_HEADING,
      body: (
        <>
          <p>The receiver runs four checks in order, and shows a frame only if it passes all of them.</p>
          <GatesFigure />
          <p>
            What it can't hide: that something was sent, when, for how long, and in which mode. Anyone with the passphrase can
            read every message and send ones that look genuine, and a passphrase that leaks later opens old recordings too.
          </p>
        </>
      ),
    },
    {
      id: 'using',
      title: '8 · Using it',
      body: (
        <ul className="ex-list ex-points">
          <li>
            Start with FAST. If a message arrives corrupted, or not at all, send it again in ROBUST: slower, but steadier in
            noisy or echoey rooms. The receiver listens for every mode at once, so only the sender has to switch.
          </li>
          <li>
            Keep chirp in front on the receiving device, with the screen on. Browsers may pause the microphone in a background
            tab or when the screen locks.
          </li>
          <li>
            Check the receiving device. Sending is one-way: nothing replies, so "sent" means the sound played, not that anything
            heard it. A message has arrived once the receiver's log shows it complete.
          </li>
          <li>
            Before relying on INAUDIBLE, press TEST on each device: many speakers and microphones barely reproduce 18–19 kHz,
            and Bluetooth audio doesn't carry it. And it is inaudible only to most adults. Children, teenagers and pets such as
            dogs and cats can hear it, and it may bother them.
          </li>
          <li>
            Treat every message as public unless it was sent in ENCRYPTED. Anyone within earshot running chirp receives it, and
            the checksum shows that the data arrived intact, not who sent it.
          </li>
          <li>
            For private messages, pick ENCRYPTED, press GENERATE, and read the key out to the other person face to face, never
            over chirp. Enter it on both devices before sending: frames heard without the key are lost, and have to be sent
            again.
          </li>
        </ul>
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
  };
  const returnTo = useRef<string | null>(null);
  const exit = () => {
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
      {/* Not rendered while presenting: the slides cover it, and keyboard focus must stay on them. */}
      {!presenting && (
        <nav className="ex-banner" aria-label="Page">
          <a href="/">[ ← GO BACK TO APP ]</a>
          <button ref={presentRef} className="btn" onClick={present}>
            [ ▶ PRESENTATION MODE ]
          </button>
        </nav>
      )}
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
