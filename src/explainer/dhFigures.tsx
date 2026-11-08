// Figures for section 8, two-way sessions: Diffie–Hellman for readers who have
// never met it. An analogy with paint, how the passphrase and the shared secret
// combine, chirp's real handshake run by the app's own code, and what a
// recording opens once the passphrase leaks.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { deriveKeys, generateKey } from '../modem/encryption';
import { HELLO_BYTES, REPLY_BYTES, createEphemeral, deriveSession, openInSession, sealInSession } from '../modem/session';
import { FrameType } from '../modem/types';
import { SteadyText } from './figures';
import { useReducedMotion, useTicker, useVisible } from './hooks';

/**
 * Steps on its own while on screen, until the reader takes over with BACK or
 * NEXT. With reduced motion it stands still on `restAt`: by default the last
 * step, which for a figure that builds up shows everything at once.
 */
function useStepper(count: number, ms: number, restAt = count - 1) {
  const ref = useRef<HTMLElement>(null);
  const visible = useVisible(ref);
  const reduced = useReducedMotion();
  const [manual, setManual] = useState<number | null>(null);
  const tick = useTicker(ms, visible && !reduced && manual === null);
  const step = manual ?? (reduced ? restAt : tick % count);
  const go = (n: number) => setManual(((n % count) + count) % count);
  return { ref, step, manual: manual !== null, go };
}

function StepControls({ step, go }: { step: number; go: (n: number) => void }) {
  return (
    <div className="ex-controls">
      <button className="btn" onClick={() => go(step - 1)}>
        [ ◀ BACK ]
      </button>
      <button className="btn" onClick={() => go(step + 1)}>
        [ NEXT ▶ ]
      </button>
    </div>
  );
}

/* ── 8a · mixing paint ───────────────────────────────── */

type Pigment = 'common' | 'a' | 'b';
const PIGMENT: Record<Pigment, [number, number, number]> = {
  common: [240, 205, 60],
  a: [255, 43, 109],
  b: [41, 216, 255],
};

/** Paint mixed from equal parts: what matters is which parts, not the order they went in. */
const mix = (parts: Pigment[]) => {
  const sum = parts.reduce((s, p) => s.map((v, i) => v + PIGMENT[p][i]), [0, 0, 0]);
  return `rgb(${sum.map((v) => Math.round(v / parts.length)).join(' ')})`;
};

function Pot({ parts, label, show, from, tone }: { parts: Pigment[]; label: string; show: boolean; from?: 'left' | 'right'; tone?: 'ok' | 'err' }) {
  return (
    <div className={`ex-swatch${show ? '' : ' ex-unshown'}${show && from ? ` ex-from-${from}` : ''}`} aria-hidden={!show}>
      <span className="ex-pot" style={{ background: mix(parts) }} />
      {/* What went in: the difference the listener can't see past. */}
      <span className="ex-chips" aria-hidden="true">
        {parts.map((p, i) => (
          <span key={i} style={{ background: mix([p]) }} />
        ))}
      </span>
      <span className={`ex-swatch-label${tone ? ` ${tone}` : ''}`}>{label}</span>
    </div>
  );
}

const PAINT_STEPS = [
  'A and B start from the same colour, out in the open',
  'each picks a secret colour, and never shows it to anyone',
  'each stirs its secret into the common colour',
  'they swap their mixes out loud: the listener hears both',
  "each adds its own secret to the other's mix: the same colour on both sides",
  "the listener can't take the common colour back out of a mix. Mixing the two it heard puts it in twice: the wrong colour",
];

export function PaintFigure() {
  const { ref, step, manual, go } = useStepper(PAINT_STEPS.length, 2600);
  const final: Pigment[] = ['common', 'a', 'b'];
  return (
    <figure className="ex-figure" ref={ref}>
      <div className="ex-paint">
        <span />
        <span className="ex-paint-head">device A</span>
        <span className="ex-paint-head warn">on air · everyone hears</span>
        <span className="ex-paint-head">device B</span>

        <span className="ex-paint-row dim">public</span>
        <Pot parts={['common']} label="common" show />
        <Pot parts={['common']} label="common" show />
        <Pot parts={['common']} label="common" show />

        <span className="ex-paint-row dim">secret</span>
        <Pot parts={['a']} label="A's secret" show={step >= 1} />
        <span className="ex-paint-none dim">{step >= 1 ? 'never sent' : ''}</span>
        <Pot parts={['b']} label="B's secret" show={step >= 1} />

        <span className="ex-paint-row dim">mixed</span>
        <Pot parts={['common', 'a']} label="A's mix" show={step >= 2} />
        <div className="ex-paint-pair">
          <Pot parts={['common', 'a']} label="A's mix →" show={step >= 3} from="left" />
          <Pot parts={['common', 'b']} label="← B's mix" show={step >= 3} from="right" />
        </div>
        <Pot parts={['common', 'b']} label="B's mix" show={step >= 2} />

        <span className="ex-paint-row dim">result</span>
        <Pot parts={['common', 'b', 'a']} label="B's mix + A's secret ✓" show={step >= 4} tone="ok" />
        <Pot parts={['common', 'a', 'common', 'b']} label="listener ✗" show={step >= 5} tone="err" />
        <Pot parts={final} label="A's mix + B's secret ✓" show={step >= 4} tone="ok" />
      </div>
      <SteadyText className="ex-verdict" texts={PAINT_STEPS.map((s, i) => `${i + 1}/${PAINT_STEPS.length} · ${s}`)} index={step} live={manual} />
      <StepControls step={step} go={go} />
      <figcaption>
        An analogy, not the real thing: paint stands in for numbers. The small squares under each pot show what went into it.
        Both results hold the same three colours, so they match; the listener's has the common colour twice.
      </figcaption>
    </figure>
  );
}

/* ── 8b · where the passphrase comes in ────────────────── */

/** Who might try to make the session keys, and which of the two ingredients each one has. */
const MIX_SCENARIOS: { label: string; passphrase: boolean; secret: boolean; keys: 'same' | 'different' | 'none'; tone: 'ok' | 'err' | 'warn'; outcome: string }[] = [
  {
    label: 'DEVICE B',
    passphrase: true,
    secret: true,
    keys: 'same',
    tone: 'ok',
    outcome: "✓ has both: the same keys as A, and a proof that checks out",
  },
  {
    label: 'A LISTENER',
    passphrase: false,
    secret: false,
    keys: 'none',
    tone: 'err',
    outcome: "✗ heard both public halves, but has neither ingredient",
  },
  {
    label: 'A STRANGER WHO ANSWERS',
    passphrase: false,
    secret: true,
    keys: 'different',
    tone: 'err',
    outcome: "✗ shares a secret with A by answering its hello, but without the passphrase its keys differ: the proof fails, and A sends nothing",
  },
  {
    label: 'THE PASSPHRASE, LATER',
    passphrase: true,
    secret: false,
    keys: 'none',
    tone: 'err',
    outcome: '✗ has the passphrase now, but the secrets were deleted after the session: the recording stays sealed',
  },
  {
    label: 'A KEY HOLDER IN THE MIDDLE',
    passphrase: true,
    secret: true,
    keys: 'same',
    tone: 'warn',
    outcome: '! the limit: knowing the passphrase, and running its own handshake with each device while they talk, it has both',
  },
];

function Ingredient({ has, children }: { has: boolean | 'public'; children: ReactNode }) {
  const state = has === 'public' ? 'public' : has ? 'have' : 'lack';
  return (
    <span className={`ex-ingredient ${state}`}>
      {children}
      <span className="sr-only">{state === 'have' ? ' (has it)' : state === 'lack' ? ' (lacks it)' : ' (heard by everyone)'}</span>
    </span>
  );
}

export function MixFigure() {
  const { ref, step, manual, go } = useStepper(MIX_SCENARIOS.length, 3200, 0);
  const sc = MIX_SCENARIOS[step];
  const out = sc.keys === 'same';
  return (
    <figure className="ex-figure" ref={ref}>
      <div className="ex-controls ex-scenarios">
        {MIX_SCENARIOS.map((m, i) => (
          <button key={m.label} className={`btn${i === step ? ' btn-primary' : ''}`} aria-pressed={i === step} onClick={() => go(i)}>
            [ {m.label} ]
          </button>
        ))}
      </div>
      <div className="ex-mix">
        <div className="ex-mix-row">
          <Ingredient has={sc.passphrase}>passphrase</Ingredient>
          <span className="ex-mix-op">→ PBKDF2 →</span>
          <Ingredient has={sc.passphrase}>passphrase key</Ingredient>
        </div>
        <div className="ex-mix-row">
          <Ingredient has={sc.secret}>own secret</Ingredient>
          <span className="ex-mix-op">+</span>
          <Ingredient has="public">other's public half</Ingredient>
          <span className="ex-mix-op">→ X25519 →</span>
          <Ingredient has={sc.secret}>shared secret</Ingredient>
        </div>
        <p className="ex-mix-op ex-mix-join">↓ both together, through HMAC and HKDF ↓</p>
        <div className={`ex-mix-row ex-mix-out keys-${sc.keys}`}>
          {['A→B key', 'B→A key', 'proof'].map((k) => (
            <Ingredient key={k} has={out}>
              {sc.keys === 'different' ? `other ${k}` : k}
            </Ingredient>
          ))}
        </div>
      </div>
      <SteadyText className={`ex-verdict ${sc.tone}`} texts={MIX_SCENARIOS.map((m) => m.outcome)} index={step} live={manual} />
      <figcaption>
        Green: has it. Red: lacks it. Blue: heard by everyone. Only someone with both ingredients makes the session keys, and
        the only way to have both is to know the passphrase and take part in the handshake as it happens.
      </figcaption>
    </figure>
  );
}

/* ── 8c · chirp's handshake, run by the app's own code ── */

const MESSAGE = 'meet at the north gate';

interface Run {
  aPub: Uint8Array;
  bPub: Uint8Array;
  code: string;
  sealedBytes: number;
  opened: string;
  /** What a listener with the passphrase gets from the sealed message, pairing the recorded keys with a key pair of its own. */
  listener: string;
}

const short = (b: Uint8Array) => `${Array.from(b.subarray(0, 6), (v) => v.toString(16).padStart(2, '0')).join('')}…`;

async function runHandshake(): Promise<Run> {
  const { mix } = await deriveKeys(generateKey());
  const a = await createEphemeral();
  const b = await createEphemeral();
  const kA = await deriveSession(mix, a, 'initiator', a.publicKey, b.publicKey);
  const kB = await deriveSession(mix, b, 'responder', a.publicKey, b.publicKey);
  const sealed = await sealInSession(kA, { type: FrameType.Text, payload: new TextEncoder().encode(MESSAGE) });
  const opened = await openInSession(kB.receive, sealed.payload);
  if (!opened.ok) throw new Error('the handshake did not agree');
  const own = await createEphemeral();
  let listenerOpened = false;
  for (const role of ['initiator', 'responder'] as const) {
    const guess = await deriveSession(mix, own, role, a.publicKey, b.publicKey);
    for (const key of [guess.send, guess.receive]) listenerOpened ||= (await openInSession(key, sealed.payload)).ok;
  }
  return {
    aPub: a.publicKey,
    bPub: b.publicKey,
    code: `${kA.idHex.slice(0, 4)}-${kA.idHex.slice(4)}`,
    sealedBytes: sealed.payload.length,
    opened: new TextDecoder().decode(opened.frame.payload),
    listener: listenerOpened ? 'it opened (this should never happen)' : "✗ its keys don't match, so the message stays sealed",
  };
}

type Side = 'a' | 'b' | 'right' | 'left' | 'both' | 'listener';

const Secret = ({ gone = false }: { gone?: boolean }) => <span className={`ex-secret${gone ? ' ex-gone' : ''}`}>■ secret</span>;
const Public = ({ bytes }: { bytes?: Uint8Array }) => <span className="ex-public">{bytes ? short(bytes) : '…'}</span>;

export function HandshakeFigure() {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      setRun(await runHandshake());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => void startRef.current(), []);

  const code = run?.code ?? '…';
  const rows: { side: Side; body: ReactNode; caption: string }[] = [
    {
      side: 'a',
      body: (
        <>
          A makes a fresh <Secret /> and its public half <Public bytes={run?.aPub} />
        </>
      ),
      caption: 'A makes a fresh secret, and the public half that goes with it',
    },
    {
      side: 'right',
      body: <>hello · A's public half · {HELLO_BYTES} bytes</>,
      caption: 'A plays a hello: just its public half',
    },
    {
      side: 'b',
      body: (
        <>
          B makes its own <Secret /> and public half <Public bytes={run?.bPub} />, works out the shared secret, and mixes in the
          passphrase: session <span className="ex-readout">{code}</span>
        </>
      ),
      caption: "B makes its own pair, combines its secret with A's public half, and mixes in the passphrase",
    },
    {
      side: 'left',
      body: <>reply · B's public half + a 16-byte proof · {REPLY_BYTES} bytes</>,
      caption: 'B replies with its public half, and a proof that it knows the passphrase',
    },
    {
      side: 'a',
      body: (
        <>
          A works out the same: session <span className="ex-readout">{code}</span> · the proof checks out ✓
        </>
      ),
      caption: "A combines its secret with B's public half: the same keys, so the proof checks out",
    },
    {
      side: 'right',
      body: (
        <>
          "{MESSAGE}", sealed with the session key · {run?.sealedBytes ?? '…'} bytes
        </>
      ),
      caption: 'the message follows, sealed with the session key',
    },
    {
      side: 'b',
      body: <>B opens it ✓ "{run?.opened ?? '…'}"</>,
      caption: 'B opens it',
    },
    {
      side: 'both',
      body: (
        <>
          both forget their <Secret gone />
        </>
      ),
      caption: 'both forget their secrets. The session keys go too, within the hour',
    },
    {
      side: 'listener',
      body: <>listener: recorded every byte, and knows the passphrase · {run?.listener ?? '…'}</>,
      caption: 'a listener with the passphrase and the whole recording still lacks a secret',
    },
  ];
  const { ref, step, manual, go } = useStepper(rows.length, 2200);

  return (
    <figure className="ex-figure" ref={ref}>
      <div className="ex-seq-head">
        <span>device A</span>
        <span className="warn">on air</span>
        <span>device B</span>
      </div>
      <ol className="ex-seq">
        {rows.map((row, i) => (
          <li
            key={i}
            className={`ex-seq-row side-${row.side}${i === step ? ' current' : ''}${i > step ? ' ex-unshown' : ''}`}
            aria-hidden={i > step}
          >
            {(row.side === 'right' || row.side === 'left') && (
              <span className={`ex-wire to-${row.side}${i === step ? ' moving' : ''}`} aria-hidden="true" />
            )}
            <span className="ex-seq-text">
              {row.side === 'right' ? '→ ' : row.side === 'left' ? '← ' : ''}
              {row.body}
            </span>
          </li>
        ))}
      </ol>
      <SteadyText className="ex-verdict" texts={rows.map((r, i) => `${i + 1}/${rows.length} · ${r.caption}`)} index={step} live={manual} />
      <div className="ex-controls">
        <button className="btn" onClick={() => go(step - 1)}>
          [ ◀ BACK ]
        </button>
        <button className="btn" onClick={() => go(step + 1)}>
          [ NEXT ▶ ]
        </button>
        <button className="btn" disabled={busy} onClick={() => void start()}>
          [ {busy ? 'RUNNING…' : '↻ NEW HANDSHAKE'} ]
        </button>
      </div>
      {error && (
        <p className="ex-verdict err" role="status">
          {error}
        </p>
      )}
      <figcaption>
        Computed in your browser by the app's own code, with a random passphrase: real X25519 key pairs, the real session code,
        and a real attempt by a listener that knows the passphrase but has only a key pair of its own. Every NEW HANDSHAKE
        gives new keys and a new code.
      </figcaption>
    </figure>
  );
}

/* ── 8d · what a recording opens later ───────────────── */

const LEAK_STEPS = ['today: a message goes out, and someone records it', 'a month later, the passphrase leaks', 'they play the recording back'];

export function LeakFigure() {
  const { ref, step, manual, go } = useStepper(LEAK_STEPS.length, 2400);
  const row = (i: number, psk: ReactNode, twoWay: ReactNode, pskTone = '', twoWayTone = '') => (
    <tr className={i > step ? 'ex-unshown' : undefined} aria-hidden={i > step}>
      <th scope="row">{LEAK_STEPS[i]}</th>
      <td className={pskTone}>{psk}</td>
      <td className={twoWayTone}>{twoWay}</td>
    </tr>
  );
  return (
    <figure className="ex-figure" ref={ref}>
      <table className="ex-compare ex-leak">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">PSK only</th>
            <th scope="col">two-way</th>
          </tr>
        </thead>
        <tbody>
          {row(0, 'sealed with the passphrase key', 'sealed with a session key')}
          {row(1, 'the key can be rebuilt from it', 'the secrets it also needs were deleted')}
          {row(2, `✓ opens: "${MESSAGE}"`, '✗ stays sealed', 'err', 'ok')}
        </tbody>
      </table>
      <SteadyText className="ex-verdict" texts={LEAK_STEPS.map((s, i) => `${i + 1}/${LEAK_STEPS.length} · ${s}`)} index={step} live={manual} />
      <StepControls step={step} go={go} />
      <figcaption>This is forward secrecy: a key that leaks tomorrow doesn't open what was said today.</figcaption>
    </figure>
  );
}
