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
} from './figures';
import { HandshakeFigure, LeakFigure, MixFigure, PaintFigure } from './dhFigures';
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

/** Optional detail in the article, closed until asked for; slides leave it out. */
function More({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="ex-more">
      <summary>{summary}</summary>
      {children}
    </details>
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
  /** The block's point in a line, shown only on its slide, in place of the prose (marked ex-prose). */
  takeaway?: React.ReactNode;
  body: React.ReactNode;
}

const FIXES_HEADING = '5 · Version 2, one fix at a time';
const ENCRYPTION_HEADING = '7 · Encryption';
const TWO_WAY_HEADING = '8 · Two-way: protecting old recordings';

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
            Two devices, a speaker and a microphone, no network. This is how it works, starting with the simplest version that
            does:
          </p>
          <p className="ex-path">text → bytes → tones → air → bytes → text</p>
        </>
      ),
    },
    {
      id: 'sound',
      title: '1 · Sound is a list of numbers',
      takeaway: 'A tone is a wave at one frequency. More cycles per second means a higher pitch.',
      body: (
        <>
          <p className="ex-prose">
            A speaker pushes air back and forth; a microphone measures that push thousands of times a second. The simplest sound
            is a pure tone: a smooth wave repeating at one <em>frequency</em>, counted in hertz (Hz, cycles per second). More
            cycles per second means a higher pitch.
          </p>
          <ToneFigure />
        </>
      ),
    },
    {
      id: 'version-1',
      title: '2 · Version 1: one pitch per character',
      takeaway: 'Every character gets its own pitch, 100 Hz apart.',
      body: (
        <>
          <p className="ex-prose">
            So give every character its own pitch. The first chirp did exactly that: A was 5,700 Hz, B 5,800 Hz and so on, 100
            Hz apart. A message was a start tone, one short tone per character, then an end tone.
          </p>
          <V1Figure />
        </>
      ),
    },
    {
      id: 'fft',
      title: '3 · Hearing it: the FFT',
      takeaway: 'The FFT splits sound into frequencies. Too much noise, and the wrong letter wins.',
      body: (
        <>
          <p className="ex-prose">
            The receiver doesn't get pitches, only that stream of numbers. A <em>Fast Fourier Transform</em> (FFT) takes a short
            slice of them (2,048 samples, about 43 ms) and measures how much of every frequency it contains, like a prism
            splitting light into colours. Version 1 took the loudest frequency and looked up the nearest character.
          </p>
          <FftFigure />
          <p className="ex-prose">
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
            <li>Doubles often lost a letter: the receiver ignored a repeat that came too soon.</li>
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
          <p>Today's modem still uses tones, and fixes each of those problems.</p>
        </>
      ),
    },
    {
      id: 'fix-bytes',
      title: 'Bytes instead of characters',
      kind: 'fix',
      kicker: FIXES_HEADING,
      takeaway: 'Send bytes. Each byte is two 4-bit nibbles, and each nibble is one of 16 pitches.',
      body: (
        <>
          <p className="ex-prose">
            Everything a computer stores is bytes, so send bytes. A byte is 8 bits, split into two 4-bit halves called{' '}
            <em>nibbles</em>. A nibble has 16 possible values, so each one needs one of 16 pitches. Type here; the figures below
            use your text.
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
      takeaway: 'Fixed 30 ms slots with four tones each: two bytes per slot.',
      body: (
        <>
          <p className="ex-prose">
            Sound is cut into fixed slots, 30 ms each in FAST. The receiver measures the middle 20 ms; 5 ms fades at each end
            avoid clicks. Two equal values are simply two slots, so doubles survive. Four tones carry four nibbles: two bytes per
            slot. The receiver knows when each slot starts and which pitches it can hold, so it measures just those. All the
            slots of one message, from the start pattern to the last repair byte, make up a <em>frame</em>.
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
      takeaway: 'Each tone has its own 16 pitches, so the four never collide.',
      body: (
        <>
          <p className="ex-prose">
            Each tone has its own 16 pitches, one per value from 0000 to 1111, and the four tones never share a pitch, so the
            receiver can measure them separately.
          </p>
          <PitchFigure value={demo} />
          <More summary="why these pitches?">
            <ul className="ex-list ex-points">
              <li>
                <em>50 Hz, the grid.</em> Over the receiver's 20 ms window, a tone one 50 Hz step higher fits exactly one more
                cycle, so measuring one step ideally picks up nothing from its neighbours.
              </li>
              <li>
                <em>100 Hz, within a slot.</em> A slot uses every other step: tone set 1, or set 2 one step up. The four tones
                take turns: tone 1 at 1,500 Hz, tone 2 at 1,600, tone 3 at 1,700, tone 4 at 1,800, then tone 1 again at 1,900.
              </li>
              <li>
                <em>400 Hz, between values.</em> So each tone's own pitches are 400 Hz apart: tone 1 plays 1,500 Hz for 0000,
                1,900 Hz for 0001, and so on up to 7,500 Hz for 1111.
              </li>
            </ul>
          </More>
        </>
      ),
    },
    {
      id: 'fix-echoes',
      title: 'Dodging echoes',
      kind: 'fix',
      kicker: FIXES_HEADING,
      takeaway: "Slots alternate between two sets of pitches, so an echo lands where the next slot isn't listening.",
      body: (
        <>
          <p className="ex-prose">
            Slots alternate between two tone sets, interleaved 50 Hz apart. An echo from one slot rings on pitches the next slot
            doesn't read, which reduces interference. A long echo can still reach a later slot.
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
      takeaway: 'A known start pattern to lock on to, and timing taken from the audio itself.',
      body: (
        <>
          <p className="ex-prose">
            Every message begins with 8 slots of a known pattern. The receiver slides that pattern along everything it hears and
            locks on where it matches. Device clocks drift, so it also checks each slot slightly early and late, then adjusts
            its timing. And it times everything by audio samples, not screen refreshes.
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
      takeaway: 'Repair bytes fix misheard tones; interleaving spreads a burst of noise thin.',
      body: (
        <>
          <p className="ex-prose">
            Some tones will still be misheard. <em>Reed–Solomon</em> error correction adds repair bytes: in FAST, 16 for each
            block of up to 96 data bytes, enough to fix any 8 wrong bytes. Longer messages are split into blocks whose bytes are
            interleaved, so a burst of noise, like a cough, hurts each block only a little. A final <em>CRC-32</em> checksum
            checks for remaining errors; a message that fails it is marked corrupted.
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
      takeaway: 'Numbered chunks and a manifest. A resend fills in the gaps.',
      body: (
        <>
          <p className="ex-prose">
            chirp compresses a file if that saves space, then splits it into numbered chunks. A manifest describing the file is
            sent first and last. Chunks can arrive in any order. RESEND plays the whole file again; the receiver keeps what it
            has and fills in what it missed.
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
      takeaway: "FAST for speed, ROBUST for noisy rooms, INAUDIBLE above most adults' hearing.",
      body: (
        <>
          <p className="ex-prose">
            FAST uses the most tones. ROBUST uses fewer tones and longer slots for noisy, echoey rooms. INAUDIBLE sits at 18–19
            kHz, above what most adults hear, with one tone at a time, because two high tones together can buzz audibly in small
            speakers. The receiver listens for all three at once. ENCRYPTED (section 7) uses FAST's tones.
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
                <td>{v2Seconds(5).toFixed(2)} s</td>
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
          <p>Short messages pay for the start pattern and repair bytes; longer ones show the speed-up.</p>
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
      takeaway: 'Sound is a broadcast. ENCRYPTED seals each frame, so only a device with the key can read it.',
      body: (
        <p className="ex-prose">
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
      takeaway: 'Anyone with a recording can guess offline. A generated key makes that hopeless.',
      body: (
        <>
          <p className="ex-prose">
            Both devices type the same passphrase. <em>PBKDF2</em> turns it into a 256-bit key with{' '}
            {PBKDF2_ITERATIONS.toLocaleString('en-US')} rounds of hashing; the key itself never goes on air. A recording lets
            anyone test passphrases offline, and those rounds make each guess slow. Security still depends on how hard the
            passphrase is to guess.
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
      takeaway: 'A random nonce, the scrambled data, and a tag that catches a wrong key or any change.',
      body: (
        <>
          <p className="ex-prose">
            Each frame is sealed on its own with <em>AES-256-GCM</em>, so file chunks can still arrive in any order. The inside
            holds the frame's real type, the time it was sent, and the data. Around it go:
          </p>
          <ul className="ex-list ex-points ex-prose">
            <li>
              <em>a nonce:</em> 12 random bytes, new for every frame, so repeated messages encrypt differently;
            </li>
            <li>
              <em>the ciphertext:</em> the inside, scrambled with the key and the nonce, byte for byte the same length;
            </li>
            <li>
              <em>a tag:</em> 16 bytes that let the receiver detect a wrong key or any change to the frame.
            </li>
          </ul>
          <p className="ex-prose">
            {ENCRYPTION_OVERHEAD} extra bytes per frame: about{' '}
            {(v2Seconds(100 + ENCRYPTION_OVERHEAD) - v2Seconds(100)).toFixed(1)} s more sound for a 100-byte message in FAST.
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
      takeaway: 'Four checks, in order. A frame is shown only if it passes all four.',
      body: (
        <>
          <p className="ex-prose">The receiver runs four checks in order, and shows a frame only if it passes all of them.</p>
          <GatesFigure />
          <p className="ex-prose">
            What it can't hide: that something was sent, when, for how long, and in which mode. Anyone with the passphrase can
            read every message and send ones that look genuine. And a passphrase that leaks later opens old recordings too.
          </p>
        </>
      ),
    },
    {
      id: 'two-way',
      title: TWO_WAY_HEADING,
      takeaway: 'A leaked passphrase opens old recordings. TWO-WAY adds a fresh secret for each session.',
      body: (
        <>
          <p className="ex-prose">
            With passphrase-only encryption, anyone can keep a recording, and a passphrase that leaks later opens it. TWO-WAY adds
            a fresh shared secret for each session, so learning the passphrase later is no longer enough. This is called{' '}
            <em>forward secrecy</em>.
          </p>
          <LeakFigure />
          <p className="ex-prose">
            The two devices agree on that secret out loud, in a way a listener can't work out: <em>Diffie–Hellman key
            exchange</em>. chirp combines it with the passphrase to make the session keys. Both devices need TWO-WAY on, the same
            passphrase, and a working speaker and microphone.
          </p>
        </>
      ),
    },
    {
      id: 'paint',
      title: 'Mixing paint',
      kind: 'detail',
      kicker: TWO_WAY_HEADING,
      takeaway: 'Both sides end up with the same colour. The listener, who heard only the mixes, cannot.',
      body: (
        <>
          <p className="ex-prose">
            The usual picture uses paint. Two things make it work: mixing in either order gives the same colour, and a mix
            doesn't reveal what went into it.
          </p>
          <PaintFigure />
          <p className="ex-prose">
            Real Diffie–Hellman mixes numbers. A secret colour is a <em>private key</em>, kept on the device; a mix is a{' '}
            <em>public key</em>, sent over the air. chirp uses <em>X25519</em>: both devices compute the shared secret in a
            moment, but working it out from the public keys alone is impractical.
          </p>
        </>
      ),
    },
    {
      id: 'passphrase',
      title: 'Where the passphrase comes in',
      kind: 'detail',
      kicker: TWO_WAY_HEADING,
      takeaway: 'The session keys need both the passphrase and the exchange.',
      body: (
        <>
          <p className="ex-prose">
            PBKDF2 still turns the passphrase into a key, as in section 7. With TWO-WAY, that key no longer seals frames itself:
            each device combines it with the shared secret to make the session keys.
          </p>
          <MixFigure />
          <p className="ex-prose">
            Each input stops someone different. The shared secret stops a listener, even one who learns the passphrase later.
            The passphrase stops a stranger who answers A's hello: without it, the stranger's keys differ, its proof fails, and
            A sends nothing.
          </p>
        </>
      ),
    },
    {
      id: 'handshake',
      title: 'How chirp does it',
      kind: 'detail',
      kicker: TWO_WAY_HEADING,
      takeaway: 'Hello, then a reply with a proof, and only then the sealed message.',
      body: (
        <>
          <p className="ex-prose">
            With TWO-WAY on, the first send starts with a <em>handshake</em>. A is the device sending; B answers.
          </p>
          <HandshakeFigure />
          <p className="ex-prose">
            Each device pauses before replying, giving the other's microphone time to listen again. With no valid reply, the
            send fails; it never falls back to passphrase-only encryption. The session is reused for 40 minutes; after that,
            the next send starts a new one.
          </p>
        </>
      ),
    },
    {
      id: 'limits-two-way',
      title: "What two-way doesn't fix",
      kind: 'detail',
      kicker: TWO_WAY_HEADING,
      body: (
        <ul className="ex-list">
          <li>
            Someone with the passphrase who gets between the devices while they talk, by being louder than one or jamming it,
            can run a separate handshake with each and read everything.
          </li>
          <li>
            Someone who sends their own hello and gets a reply can test passphrase guesses offline. A generated key still
            matters.
          </li>
          <li>
            It isn't post-quantum: a large enough quantum computer, plus a recording and the passphrase, could open it.
          </li>
          <li>As before, that something was sent, when, and for how long, is plain to hear.</li>
        </ul>
      ),
    },
    {
      id: 'using',
      title: '9 · Using it',
      takeaway: (
        <ul className="ex-list ex-points">
          <li>Start with FAST.</li>
          <li>Check the receiver: "sent" only means the sound played.</li>
          <li>For privacy: ENCRYPTED with a generated key, and TWO-WAY to protect old recordings.</li>
        </ul>
      ),
      body: (
        <ul className="ex-list ex-points ex-prose">
          <li>
            Start with FAST. If an unencrypted message arrives corrupted, or not at all, send it again in ROBUST: slower, but
            steadier in noisy or echoey rooms. The receiver listens for every mode at once, so only the sender has to switch.
          </li>
          <li>
            Keep chirp in front on the receiving device, with the screen on. Browsers may pause the microphone in a background
            tab or when the screen locks.
          </li>
          <li>
            Check the receiving device. There's no delivery receipt, even with TWO-WAY: "sent" means the sound played, not that
            anything heard it. A message has arrived once the receiver's log shows it complete.
          </li>
          <li>
            Before relying on INAUDIBLE, press TEST on each device: many speakers and microphones barely reproduce 18–19 kHz,
            and Bluetooth audio often filters it out. And it is inaudible only to most adults. Children, teenagers and pets such
            as dogs and cats can hear it, and it may bother them.
          </li>
          <li>
            Treat every message as public unless it was sent in ENCRYPTED. Anyone within earshot running chirp receives it, and
            the checksum catches damage, not who sent it.
          </li>
          <li>
            For private messages, pick ENCRYPTED, press GENERATE, and share the key privately, in person, never over chirp.
            Enter it on both devices before sending: frames heard without the key are lost, and have to be sent again.
          </li>
          <li>
            To keep messages private even if the key leaks later, turn on TWO-WAY on both devices. It works between a pair of
            devices, not a group. Both need a working speaker and microphone, and the first send waits for the other to answer.
          </li>
        </ul>
      ),
    },
  ];

  /**
   * A block as the article shows it. Slides reuse the same markup, adding the
   * takeaway under the heading; their CSS hides the prose it stands in for.
   */
  const render = (b: Block, id?: string, slide = false) => {
    if (b.id === 'top') return b.body;
    const body = (
      <>
        {slide && b.takeaway && (typeof b.takeaway === 'string' ? <p className="ex-takeaway">{b.takeaway}</p> : <div className="ex-takeaway">{b.takeaway}</div>)}
        {b.body}
      </>
    );
    return b.kind === 'fix' ? (
      <Fix id={id} title={b.title}>
        {body}
      </Fix>
    ) : b.kind === 'detail' ? (
      <section className="ex-fix ex-detail" id={id}>
        <h4>{b.title}</h4>
        {body}
      </section>
    ) : (
      <section id={id}>
        <h3>{b.title}</h3>
        {body}
      </section>
    );
  };

  const slides: Slide[] = blocks.map((b) => ({
    id: b.id,
    title: b.title,
    content: b.kicker ? (
      <>
        <p className="ex-kicker">{b.kicker}</p>
        {render(b, undefined, true)}
      </>
    ) : (
      render(b, undefined, true)
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
