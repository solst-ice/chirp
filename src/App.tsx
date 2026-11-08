import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Spectrum from './components/Spectrum';
import { play, startCapture, type Capture } from './audio/audioIO';
import {
  FileAssembler,
  MAX_FILE_BYTES,
  buildFileFrames,
  chunkSizeFor,
  decompress,
  maybeCompress,
  newFileId,
  type FileProgress,
} from './modem/fileTransfer';
import {
  ENCRYPTION_OVERHEAD,
  MIN_KEY_CHARS,
  ReplayGuard,
  decryptFrame,
  deriveKey,
  encryptFrame,
  normalizeKey,
  type OpenResult,
} from './modem/encryption';
import { MODEMS, getModem } from './modem/profiles';
import { FrameType, type DemodEvent, type Demodulator, type Frame, type Modem } from './modem/types';
import { Transmitter, airtimeOf, type SendingState, type TxState } from './transfer/transmitter';

// Audio signal favicon SVG data - base64 encoded for direct use
const AUDIO_FAVICON = `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0Ij4KICA8cmVjdCB4PSIwIiB5PSIwIiB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIGZpbGw9IiMxMzEzMTMiLz4KICA8IS0tIFRocmVlIHNpZ25hbCBiYXJzIHdpdGggc29saWQgY29sb3JzIC0tPgogIDxyZWN0IHg9IjEyIiB5PSI0MiIgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiByeD0iMiIgZmlsbD0iI2ZmNDFiNCIvPiA8IS0tIFBpbmsgLS0+CiAgPHJlY3QgeD0iMjciIHk9IjMwIiB3aWR0aD0iMTAiIGhlaWdodD0iMjIiIHJ4PSIyIiBmaWxsPSIjMDBmZmFhIi8+IDwhLS0gR3JlZW4gLS0+CiAgPHJlY3QgeD0iNDIiIHk9IjE4IiB3aWR0aD0iMTAiIGhlaWdodD0iMzQiIHJ4PSIyIiBmaWxsPSIjMzE4NWZmIi8+IDwhLS0gQmx1ZSAtLT4KPC9zdmc+`;

// After transmitting, ignore the microphone briefly so our own echo is not decoded.
const ECHO_SETTLE_MS = 150;
// How long a loopback self-test keeps listening after its frame finishes playing.
const SELF_TEST_GRACE_MS = 1500;
// Longest transmission we start; beyond this a transfer is impractical over sound.
const MAX_AIRTIME_S = 15 * 60;
const CONFIRM_AIRTIME_S = 60;
// A file that has not progressed for this long is shown as incomplete.
const FILE_STALE_MS = 20_000;
const MAX_LOG_LINES = 400;
const UI_UPDATE_MS = 100;
const MODE_KEY = 'chirp-mode';
const PROGRESS_WIDTH = 16;
// Longest name shown in the status bar; the log row carries the full name.
const STATUS_NAME_CHARS = 28;
// Phones and short windows start with the spectrum collapsed so the composer is on screen.
// Undecryptable frames arriving within this long of each other share one log row.
const LOCKED_GROUP_MS = 30_000;
// Derive the key once typing pauses, so sending does not wait on PBKDF2.
const KEY_WARMUP_MS = 600;

// Typing STARTDEMO on one device sets off a short exchange between two.
const DEMO_REPLIES: Record<string, string> = {
  STARTDEMO: 'HELLO! BOSS!',
  'HELLO! BOSS!': 'WHOAMI',
  WHOAMI: 'SOLST/ICE',
};

/**
 * What the MODE selector picks: a modem to carry the frames and whether they
 * are encrypted first. The receiver listens on every modem and recognises
 * encrypted frames by their type, whichever mode is selected.
 */
interface TxMode {
  id: string;
  label: string;
  description: string;
  modem: Modem;
  encrypted: boolean;
  /** Largest message, after any encryption overhead. */
  maxPayload: number;
}

const ENCRYPTED_LABEL = 'ENCRYPTED';
const ENCRYPTED_CARRIER = getModem('fast');

const MODES: TxMode[] = [
  ...MODEMS.map((m) => ({ id: m.id, label: m.label, description: m.description, modem: m, encrypted: false, maxPayload: m.maxPayload })),
  {
    id: 'encrypted',
    label: ENCRYPTED_LABEL,
    description: `${ENCRYPTED_CARRIER.label} tones, sealed with a pre-shared key (AES-256-GCM): only a device with the same key can read it or send it`,
    // The carrier, labelled as this mode so the status bar and spectrum say ENCRYPTED.
    modem: { ...ENCRYPTED_CARRIER, label: ENCRYPTED_LABEL },
    encrypted: true,
    maxPayload: ENCRYPTED_CARRIER.maxPayload - ENCRYPTION_OVERHEAD,
  },
];

const getMode = (id: string) => MODES.find((m) => m.id === id) ?? MODES[0];

type Tag = 'rx' | 'tx' | 'err' | 'warn' | 'sys';

interface LogLine {
  id: number;
  time: string;
  tag: Tag;
  mode?: string;
  text: string;
  /** Dim trailing status, e.g. "sent" or "checksum ok". */
  note?: string;
  /** 0..1 while a transfer is in flight. */
  progress?: number;
  file?: { name: string; url: string; size: number };
  /** Makes "RETRY MIC" in the note a button while the microphone is not live. */
  action?: 'retry-mic';
}

type MicState = 'off' | 'requesting' | 'live' | 'denied' | 'ended';

interface ModemStats {
  syncs: number;
  frames: number;
  errors: number;
  corrected: number;
}

interface Reception {
  type: number;
  lineId?: number;
  lastUi: number;
}

interface FileLine {
  lineId: number;
  name: string;
  received: number;
  total?: number;
  lastSeen: number;
  stale: boolean;
}

interface LockedLine {
  lineId: number;
  note: string;
  count: number;
  lastSeen: number;
}

interface SelfTest {
  nonce: Uint8Array;
  heard?: { marginDb: number };
  done: Promise<void>;
  resolve: () => void;
}

const timestamp = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => n.toString().padStart(2, '0')).join(':');
};

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

const formatSeconds = (s: number) => {
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60).toString().padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60).toString().padStart(2, '0')}m`;
};

/** Shorten long names in the middle, keeping the extension visible. */
const shorten = (s: string, max: number) => {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const tail = Math.floor((max - 1) / 3);
  return `${chars.slice(0, max - 1 - tail).join('')}…${chars.slice(-tail).join('')}`;
};

const formatBand = ([lo, hi]: [number, number]) => `${(lo / 1000).toFixed(1)}–${(hi / 1000).toFixed(1)}k`;

const progressBar = (fraction: number) => {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * PROGRESS_WIDTH);
  return `[${'█'.repeat(filled)}${'░'.repeat(PROGRESS_WIDTH - filled)}] ${Math.round(fraction * 100)
    .toString()
    .padStart(3)}%`;
};

// Keep newlines and tabs; drop other control characters from received text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const cleanText = (s: string) => s.replace(CONTROL_CHARS, '');

const decodeText = (bytes: Uint8Array) => cleanText(new TextDecoder().decode(bytes));

const goodput = (mode: TxMode) => Math.round((100 * 8) / mode.modem.airtime(100 + (mode.encrypted ? ENCRYPTION_OVERHEAD : 0)));

/** Airtime of a message of this many bytes once it is framed (and sealed) for a mode. */
const messageAirtime = (mode: TxMode, bytes: number) => mode.modem.airtime(bytes + (mode.encrypted ? ENCRYPTION_OVERHEAD : 0));

const sealAll = async (passphrase: string, frames: Frame[]) => {
  const key = await deriveKey(passphrase);
  return Promise.all(frames.map((f) => encryptFrame(key, f)));
};

const unopenedNote = (result: Exclude<OpenResult, { ok: true }>) => {
  if (result.reason === 'key') return 'wrong pre-shared key, or the frame was altered';
  if (result.reason === 'format') return 'unsupported encryption version';
  const off = formatSeconds(Math.abs(result.skew));
  return `sent ${off} ${result.skew < 0 ? 'ago' : 'in the future'} · a replayed recording, or the two clocks disagree`;
};

const readStoredMode = () => {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored && MODES.some((m) => m.id === stored)) return stored;
  } catch {
    // Storage can be unavailable (private mode); fall back to the default.
  }
  return MODES[0].id;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const AudioContextClass: typeof AudioContext =
  window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

function Panel({
  title,
  right,
  className,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`panel ${className ?? ''}`} aria-label={title}>
      <header className="panel-title">
        <span>
          <span aria-hidden="true">┤ </span>
          <h2 className="panel-name">{title}</h2>
          <span aria-hidden="true"> ├</span>
        </span>
        {right !== undefined && <span className="panel-right">{right}</span>}
      </header>
      {children}
    </section>
  );
}

const TAG_TEXT: Record<Tag, string> = { rx: 'RX', tx: 'TX', err: '!!', warn: '??', sys: '--' };

/** The note, with "RETRY MIC" as a button when the row offers it and it would do something. */
function LogNote({ line, retryMic }: { line: LogLine; retryMic?: () => void }) {
  const [before, after] = line.note!.split('RETRY MIC');
  return (
    <span className="log-note">
      {' · '}
      {line.action === 'retry-mic' && retryMic && after !== undefined ? (
        <>
          {before}
          <button className="log-action" onClick={retryMic}>
            RETRY MIC
          </button>
          {after}
        </>
      ) : (
        line.note
      )}
    </span>
  );
}

function LogRow({ line, retryMic }: { line: LogLine; retryMic?: () => void }) {
  const busy = line.progress !== undefined;
  const pct = Math.round((line.progress ?? 0) * 100);
  return (
    <div className={`log-row tag-${line.tag}${busy ? ' busy' : ''}`}>
      <span className="log-time">{line.time}</span>
      <span className="log-tag">{TAG_TEXT[line.tag]}</span>
      <span className="log-mode">{line.mode ?? ''}</span>
      <span className="log-text">
        {busy && (
          <span
            className="log-bar"
            role="progressbar"
            aria-label="Transfer progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            {progressBar(line.progress!)}{' '}
          </span>
        )}
        {line.file ? (
          <>
            <a className="file-link" href={line.file.url} download={line.file.name}>
              {line.file.name}
            </a>{' '}
            <span className="dim">{formatBytes(line.file.size)} ↓</span>
          </>
        ) : (
          line.text
        )}
        {line.note && <LogNote line={line} retryMic={retryMic} />}
        {busy && (
          <span className="cursor" aria-hidden="true">
            █
          </span>
        )}
      </span>
    </div>
  );
}

function App() {
  const [log, setLog] = useState<LogLine[]>([]);
  const [inputText, setInputText] = useState('');
  const [modeId, setModeId] = useState(readStoredMode);
  const [audioState, setAudioState] = useState<string>('none');
  const [mic, setMic] = useState<MicState>('off');
  const [txState, setTxState] = useState<TxState>({ kind: 'idle' });
  const [rxState, setRxState] = useState<{ mode: string; progress: number } | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [sampleRate, setSampleRate] = useState(48000);
  const [captureMethod, setCaptureMethod] = useState('none');
  const [stats, setStats] = useState<Record<string, ModemStats>>({});
  const [lastTx, setLastTx] = useState<{ mode: string; bytes: number; duration: number } | null>(null);
  const [lastRx, setLastRx] = useState<{ mode: string; marginDb: number; corrected: number } | null>(null);
  const [lastFile, setLastFile] = useState<{ file: File; fileId: number; modemId: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // Open where there's room; on phones and short windows the composer below the spectrum comes first.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(() => window.matchMedia('(min-width: 901px) and (min-height: 800px)').matches);
  const [spectrumOpen, setSpectrumOpen] = useState(true);
  // Kept in memory only: never stored, so closing the tab forgets it.
  const [psk, setPsk] = useState('');

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const demodsRef = useRef<Map<string, Demodulator>>(new Map());
  const micRef = useRef<MicState>('off');
  const mutedRef = useRef(false);
  const modeRef = useRef(modeId);
  const nextIdRef = useRef(1);
  const receptionsRef = useRef<Map<string, Reception>>(new Map());
  const assemblerRef = useRef(new FileAssembler());
  const fileLinesRef = useRef<Map<number, FileLine>>(new Map());
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const selfTestRef = useRef<SelfTest | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pskRef = useRef('');
  const replayGuardRef = useRef(new ReplayGuard());
  const lockedLineRef = useRef<LockedLine | null>(null);

  modeRef.current = modeId;
  micRef.current = mic;
  pskRef.current = normalizeKey(psk);
  const mode = getMode(modeId);
  const modem = mode.modem;
  const txBusy = txState.kind !== 'idle';

  const addLine = (line: Omit<LogLine, 'id' | 'time'>) => {
    const id = nextIdRef.current++;
    setLog((prev) => {
      const next = [...prev, { ...line, id, time: timestamp() }];
      if (next.length <= MAX_LOG_LINES) return next;
      const trimmed = new Set<number>();
      for (const old of next.splice(0, next.length - MAX_LOG_LINES)) {
        trimmed.add(old.id);
        if (old.file && blobUrlsRef.current.delete(old.file.url)) URL.revokeObjectURL(old.file.url);
      }
      // A transfer whose row scrolled out of the log starts a new row if it continues.
      for (const [fileId, entry] of fileLinesRef.current) if (trimmed.has(entry.lineId)) fileLinesRef.current.delete(fileId);
      return next;
    });
    return id;
  };

  const updateLine = (id: number, patch: Partial<LogLine>) =>
    setLog((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const announce = (message: string) => setAnnouncement(message);

  const bumpStats = (modemId: string, patch: (s: ModemStats) => Partial<ModemStats>) =>
    setStats((prev) => {
      const s = prev[modemId] ?? { syncs: 0, frames: 0, errors: 0, corrected: 0 };
      return { ...prev, [modemId]: { ...s, ...patch(s) } };
    });

  /** Create the AudioContext on first use. Never waits on resume(), which can stay pending without a gesture. */
  const ensureContext = () => {
    if (!audioContextRef.current) {
      const ctx = new AudioContextClass();
      ctx.addEventListener('statechange', () => audioStateChangeRef.current(ctx.state));
      audioContextRef.current = ctx;
      setSampleRate(ctx.sampleRate);
      setAudioState(ctx.state);
    }
    return audioContextRef.current;
  };

  /** Resume audio; must be called synchronously from a user gesture to satisfy autoplay rules. */
  const startAudio = () => {
    const ctx = ensureContext();
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  };

  /** For transmissions: the context must actually be running or playback is silent. */
  const audioForPlayback = async () => {
    const ctx = ensureContext();
    if (ctx.state === 'running') return ctx;
    await Promise.race([ctx.resume().catch(() => undefined), sleep(1000)]);
    if ((ctx.state as string) !== 'running') throw new Error('audio is paused · press START AUDIO first');
    return ctx;
  };

  const abortReceptions = (reason: string) => {
    for (const r of receptionsRef.current.values()) {
      if (r.lineId !== undefined) updateLine(r.lineId, { tag: 'err', progress: undefined, note: reason });
    }
    receptionsRef.current.clear();
    setRxState(null);
  };

  const transmitterRef = useRef<Transmitter | null>(null);
  if (!transmitterRef.current) {
    transmitterRef.current = new Transmitter({
      sampleRate: () => audioContextRef.current?.sampleRate ?? 48000,
      clock: () => audioContextRef.current?.currentTime ?? performance.now() / 1000,
      play: (samples) => play(audioContextRef.current!, samples),
      channelBusy: () => receptionsRef.current.size > 0,
      beforeAudio: (monitor) => {
        mutedRef.current = !monitor;
        if (!monitor) abortReceptions('interrupted by our transmission');
      },
      afterAudio: async (monitor) => {
        if (monitor && selfTestRef.current) await Promise.race([selfTestRef.current.done, sleep(SELF_TEST_GRACE_MS)]);
        else await sleep(ECHO_SETTLE_MS);
        for (const d of demodsRef.current.values()) d.reset();
        receptionsRef.current.clear();
        setRxState(null);
        mutedRef.current = false;
      },
      onState: setTxState,
    });
  }
  const transmitter = transmitterRef.current;

  // The OS or browser can suspend audio at any time (calls, screen lock, tab
  // switches on mobile). Whatever was in flight cannot resume mid-frame, so end
  // it visibly and let the status bar offer START AUDIO.
  const audioStateChangeRef = useRef<(state: AudioContextState) => void>(() => {});
  audioStateChangeRef.current = (next: AudioContextState) => {
    setAudioState(next);
    if (next === 'running') return;
    transmitter.cancel('interrupted');
    if (receptionsRef.current.size > 0) announce('Audio paused; reception interrupted');
    abortReceptions('interrupted · audio paused');
    for (const d of demodsRef.current.values()) d.reset();
  };

  /** Close the log row of a transfer the assembler no longer holds. */
  const dropFileLine = (fileId: number, reason: string) => {
    const entry = fileLinesRef.current.get(fileId);
    if (!entry) return;
    fileLinesRef.current.delete(fileId);
    updateLine(entry.lineId, {
      tag: 'warn',
      progress: undefined,
      note: `incomplete · ${entry.received}/${entry.total ?? '?'} chunks · ${reason} · ask the sender to RESEND`,
    });
  };

  const handleFileProgress = async (p: FileProgress, mode: string) => {
    for (const id of p.evicted ?? []) dropFileLine(id, 'dropped to make room');
    if (p.alreadyDelivered) return;
    const name = p.manifest?.name ?? `file #${p.fileId.toString(16)}`;
    let entry = fileLinesRef.current.get(p.fileId);
    if (!entry) {
      entry = { lineId: addLine({ tag: 'rx', mode, text: name, progress: 0 }), name, received: 0, lastSeen: 0, stale: false };
      fileLinesRef.current.set(p.fileId, entry);
    }
    Object.assign(entry, { name, received: p.received, total: p.total, lastSeen: Date.now(), stale: false });

    if (p.error) {
      fileLinesRef.current.delete(p.fileId);
      updateLine(entry.lineId, { tag: 'err', progress: undefined, text: name, note: p.error });
      announce(`File ${name} failed: ${p.error}`);
      return;
    }
    if (!p.data) {
      updateLine(entry.lineId, {
        tag: 'rx',
        text: name,
        progress: p.total ? p.received / p.total : 0,
        note: `${p.received}/${p.total ?? '?'} chunks`,
      });
      return;
    }
    fileLinesRef.current.delete(p.fileId);
    try {
      const m = p.manifest!;
      const data = m.compressed ? await decompress(p.data, m.size) : p.data;
      // Served as a download, never as a page in our origin.
      const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
      blobUrlsRef.current.add(url);
      updateLine(entry.lineId, { tag: 'rx', progress: undefined, text: name, file: { name, url, size: data.length }, note: 'checksum ok' });
      announce(`Received file ${name}, ${formatBytes(data.length)}`);
    } catch (err) {
      updateLine(entry.lineId, { tag: 'err', progress: undefined, text: name, note: errorText(err) });
      announce(`File ${name} failed`);
    }
  };

  const deliverFrame = (frame: Frame, label: string, lineId?: number, note?: string) => {
    if (frame.type === FrameType.Text) {
      const text = decodeText(frame.payload);
      if (lineId !== undefined) updateLine(lineId, { progress: undefined, text, note });
      else addLine({ tag: 'rx', mode: label, text, note });
      announce(`Received: ${text}`);
      const reply = DEMO_REPLIES[text.trim().toUpperCase()];
      if (reply) setTimeout(() => sendTextRef.current(reply, false), 1300);
    } else {
      const progress = assemblerRef.current.accept(frame);
      if (progress) void handleFileProgress(progress, label);
    }
  };

  /** One row for a run of frames that could not be opened, rather than one per file chunk. */
  const noteLocked = (note: string) => {
    const now = Date.now();
    const prev = lockedLineRef.current;
    if (prev && prev.note === note && now - prev.lastSeen < LOCKED_GROUP_MS) {
      prev.count++;
      prev.lastSeen = now;
      updateLine(prev.lineId, { text: `${prev.count} encrypted frames` });
      return;
    }
    const lineId = addLine({ tag: 'warn', mode: ENCRYPTED_LABEL, text: 'encrypted frame', note });
    lockedLineRef.current = { lineId, note, count: 1, lastSeen: now };
    announce(`Received an encrypted frame that could not be read: ${note}`);
  };

  const openFrame = async (payload: Uint8Array) => {
    const passphrase = pskRef.current;
    if (!passphrase) {
      noteLocked(`select ${ENCRYPTED_LABEL} and enter the pre-shared key to read these`);
      return;
    }
    let result: OpenResult;
    try {
      result = await decryptFrame(await deriveKey(passphrase), payload);
    } catch (err) {
      noteLocked(errorText(err));
      return;
    }
    if (!result.ok) {
      noteLocked(unopenedNote(result));
      return;
    }
    if (replayGuardRef.current.replayed(result.nonce)) {
      // Repeated file frames are harmless (the assembler ignores them); a repeated message is worth a mention.
      if (result.frame.type === FrameType.Text) addLine({ tag: 'warn', mode: ENCRYPTED_LABEL, text: 'replayed encrypted message ignored' });
      return;
    }
    deliverFrame(result.frame, ENCRYPTED_LABEL, undefined, 'decrypted');
  };

  // Reassigned every render so callbacks from the capture node always see current state.
  const handleEventRef = useRef<(e: DemodEvent) => void>(() => {});
  handleEventRef.current = (e: DemodEvent) => {
    const label = getModem(e.modemId).label;
    const reception = receptionsRef.current.get(e.modemId);
    const now = performance.now();

    switch (e.kind) {
      case 'sync':
        bumpStats(e.modemId, (s) => ({ syncs: s.syncs + 1 }));
        break;

      case 'header': {
        const r: Reception = { type: e.type, lastUi: now };
        // Encrypted frames get no row until they open: text cannot be previewed, and most are file chunks.
        if (e.type !== FrameType.SelfTest) setRxState({ mode: e.type === FrameType.Encrypted ? ENCRYPTED_LABEL : label, progress: 0 });
        if (e.type === FrameType.Text) r.lineId = addLine({ tag: 'rx', mode: label, text: '', progress: 0 });
        receptionsRef.current.set(e.modemId, r);
        break;
      }

      case 'progress': {
        if (!reception || reception.type === FrameType.SelfTest || now - reception.lastUi < UI_UPDATE_MS) break;
        reception.lastUi = now;
        const fraction = e.symbols / e.totalSymbols;
        setRxState({ mode: reception.type === FrameType.Encrypted ? ENCRYPTED_LABEL : label, progress: fraction });
        if (reception.lineId !== undefined) {
          updateLine(reception.lineId, { progress: fraction, text: e.preview ? decodeText(e.preview) : '' });
        }
        break;
      }

      case 'frame': {
        receptionsRef.current.delete(e.modemId);
        setRxState(null);
        bumpStats(e.modemId, (s) => ({ frames: s.frames + 1, corrected: s.corrected + e.stats.correctedBytes }));
        const { frame } = e;
        if (frame.type === FrameType.SelfTest) {
          const test = selfTestRef.current;
          if (test && sameBytes(frame.payload, test.nonce)) {
            test.heard = { marginDb: e.stats.marginDb };
            test.resolve();
          }
          break;
        }
        setLastRx({ mode: label, marginDb: e.stats.marginDb, corrected: e.stats.correctedBytes });
        if (frame.type === FrameType.Encrypted) void openFrame(frame.payload);
        else deliverFrame(frame, label, reception?.lineId);
        break;
      }

      case 'error':
        receptionsRef.current.delete(e.modemId);
        setRxState(null);
        bumpStats(e.modemId, (s) => ({ errors: s.errors + 1 }));
        if (reception?.lineId !== undefined) {
          updateLine(reception.lineId, { tag: 'err', progress: undefined, note: `corrupted: ${e.reason}` });
          announce('A received message was corrupted');
        } else if (reception && reception.type !== FrameType.SelfTest) {
          const encrypted = reception.type === FrameType.Encrypted;
          addLine({
            tag: 'err',
            mode: encrypted ? ENCRYPTED_LABEL : label,
            text: encrypted ? 'encrypted frame lost' : 'file chunk lost',
            note: 'ask the sender to resend',
          });
        }
        break;
    }
  };

  const onSamples = (samples: Float32Array) => {
    if (mutedRef.current) return;
    for (const demod of demodsRef.current.values()) {
      for (const event of demod.process(samples)) handleEventRef.current(event);
    }
  };

  const stopCapture = () => {
    captureRef.current?.stop();
    captureRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    demodsRef.current = new Map();
    abortReceptions('stopped listening');
    setAnalyser(null);
  };

  const startListening = async () => {
    if (micRef.current === 'live' || micRef.current === 'requesting') return;
    micRef.current = 'requesting';
    setMic('requesting');
    try {
      const ctx = ensureContext();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      streamRef.current = stream;
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        stopCapture();
        setMic('ended');
        addLine({ tag: 'err', text: 'microphone disconnected', note: 'press RETRY MIC to listen again', action: 'retry-mic' });
      });
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createAnalyser();
      node.fftSize = 2048;
      node.smoothingTimeConstant = 0.55;
      node.minDecibels = -100;
      node.maxDecibels = -25;
      source.connect(node);

      const supported = MODEMS.filter((m) => m.supports(ctx.sampleRate));
      demodsRef.current = new Map(supported.map((m) => [m.id, m.createDemodulator(ctx.sampleRate)]));
      captureRef.current = await startCapture(ctx, source, onSamples);
      setCaptureMethod(captureRef.current.method);
      setAnalyser(node);
      setMic('live');
      addLine({ tag: 'sys', text: `listening · ${ctx.sampleRate} Hz · ${supported.map((m) => m.label).join(' ')}` });
    } catch (err) {
      console.error('Failed to start listening', err);
      stopCapture();
      setMic('denied');
      addLine({
        tag: 'err',
        text: `microphone unavailable: ${errorText(err)}`,
        note: 'you can still send · RETRY MIC to try again',
        action: 'retry-mic',
      });
    }
  };

  const stopListening = () => {
    stopCapture();
    setMic('off');
    addLine({ tag: 'sys', text: 'stopped listening' });
  };

  const sendText = async (text: string, fromComposer: boolean): Promise<void> => {
    if (!text) return;
    if (transmitter.busy) {
      // Automatic replies wait their turn; typed messages say why nothing happened.
      if (!fromComposer) setTimeout(() => sendTextRef.current(text, false), 500);
      else addLine({ tag: 'warn', text: 'already transmitting', note: 'wait or press ESC to cancel' });
      return;
    }
    const mode = getMode(modeRef.current);
    const m = mode.modem;
    const passphrase = pskRef.current;
    const payload = new TextEncoder().encode(text);
    if (payload.length > mode.maxPayload) {
      addLine({ tag: 'err', mode: m.label, text: `message too long (${payload.length}/${mode.maxPayload} bytes)` });
      return;
    }
    if (mode.encrypted && !passphrase) {
      addLine({ tag: 'err', mode: m.label, text: 'not sent · enter a pre-shared key first' });
      return;
    }
    const lineId = addLine({ tag: 'tx', mode: m.label, text, progress: 0 });
    if (fromComposer) setInputText('');

    const outcome = await transmitter.run(
      `message (${m.label})`,
      async () => {
        await audioForPlayback();
        const frames = [{ type: FrameType.Text, payload }];
        return { modem: m, frames: mode.encrypted ? await sealAll(passphrase, frames) : frames };
      },
      (s) => updateLine(lineId, { progress: s.progress }),
    );
    const restoreDraft = () => fromComposer && setInputText((draft) => draft || text);
    switch (outcome.status) {
      case 'sent':
        setLastTx({ mode: m.label, bytes: payload.length, duration: outcome.duration });
        updateLine(lineId, { progress: undefined, note: 'sent' });
        announce(`Sent: ${text}`);
        break;
      case 'cancelled':
        updateLine(lineId, { tag: 'warn', progress: undefined, note: outcome.reason === 'interrupted' ? 'interrupted · audio paused · not sent' : 'cancelled' });
        restoreDraft();
        break;
      case 'failed':
        updateLine(lineId, { tag: 'err', progress: undefined, note: outcome.error.message });
        restoreDraft();
        break;
      case 'busy':
        updateLine(lineId, { tag: 'warn', progress: undefined, note: 'not sent · already transmitting' });
        restoreDraft();
        break;
    }
  };
  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;

  const sendFile = async (file: File, reuse?: { fileId: number; modemId: string }) => {
    if (transmitter.busy) {
      addLine({ tag: 'warn', text: 'already transmitting', note: 'wait or press ESC to cancel' });
      return;
    }
    const mode = getMode(modeRef.current);
    const m = mode.modem;
    const passphrase = pskRef.current;
    if (mode.encrypted && !passphrase) {
      addLine({ tag: 'err', mode: m.label, text: file.name, note: 'not sent · enter a pre-shared key first' });
      return;
    }
    let lineId: number | undefined;
    let size = '';

    const outcome = await transmitter.run(
      `file ${file.name}`,
      async (signal) => {
        await audioForPlayback();
        if (file.size > MAX_FILE_BYTES) {
          throw new Error(`${formatBytes(file.size)} is over the ${formatBytes(MAX_FILE_BYTES)} limit`);
        }
        const raw = new Uint8Array(await file.arrayBuffer());
        const { data, compressed } = await maybeCompress(raw);
        if (signal.aborted) return null;
        const fileId = reuse && reuse.modemId === mode.id ? reuse.fileId : newFileId();
        const build = (target: { rawBitRate: number; maxPayload: number }) =>
          buildFileFrames({
            fileId,
            name: file.name,
            mime: file.type || 'application/octet-stream',
            size: raw.length,
            data,
            compressed,
            chunkSize: chunkSizeFor(target),
          }).frames;
        // Every frame is sealed on its own, so a receiver can open chunks in any order and RESEND still fills gaps.
        const frames = mode.encrypted ? await sealAll(passphrase, build({ rawBitRate: m.rawBitRate, maxPayload: mode.maxPayload })) : build(m);
        if (signal.aborted) return null;
        const eta = airtimeOf(m, frames);
        if (eta > MAX_AIRTIME_S) {
          const fast = MODEMS[0];
          const fastEta = airtimeOf(fast, build(fast));
          const hint =
            !mode.encrypted && m.id !== fast.id && fastEta <= MAX_AIRTIME_S
              ? `try ${fast.label} (~${formatSeconds(fastEta)})`
              : 'send a smaller or more compressible file';
          throw new Error(`would take ~${formatSeconds(eta)} in ${m.label}; the limit is ${formatSeconds(MAX_AIRTIME_S)} · ${hint}`);
        }
        if (
          eta > CONFIRM_AIRTIME_S &&
          !window.confirm(`Sending ${file.name} in ${m.label} mode will take about ${formatSeconds(eta)}. You can cancel at any time. Continue?`)
        ) {
          return null;
        }
        size = `${formatBytes(raw.length)}${compressed ? ` → ${formatBytes(data.length)} deflated` : ''}`;
        setLastFile({ file, fileId, modemId: mode.id });
        lineId = addLine({ tag: 'tx', mode: m.label, text: file.name, note: size, progress: 0 });
        return { modem: m, frames };
      },
      (s: SendingState) =>
        lineId !== undefined &&
        updateLine(lineId, {
          progress: s.progress,
          note: `${size} · frame ${s.framesSent}/${s.frames} · ${formatSeconds(s.remaining)} left`,
        }),
    );

    switch (outcome.status) {
      case 'sent':
        setLastTx({ mode: m.label, bytes: file.size, duration: outcome.duration });
        if (lineId !== undefined) updateLine(lineId, { progress: undefined, note: `${size} · sent` });
        announce(`Sent file ${file.name}`);
        break;
      case 'cancelled':
        if (lineId !== undefined) {
          const why = outcome.reason === 'interrupted' ? 'interrupted · audio paused' : 'cancelled';
          updateLine(lineId, { tag: 'warn', progress: undefined, note: `${size} · ${why} · RESEND to finish` });
        }
        break;
      case 'failed':
        if (lineId !== undefined) updateLine(lineId, { tag: 'err', progress: undefined, note: outcome.error.message });
        else addLine({ tag: 'err', mode: m.label, text: file.name, note: outcome.error.message });
        break;
      case 'busy':
        addLine({ tag: 'warn', text: 'already transmitting', note: 'wait or press ESC to cancel' });
        break;
    }
  };

  const resendLastFile = () => {
    // Chunk boundaries depend on the mode, so the id (which lets the receiver
    // merge chunks) is only reused when the mode, encrypted or not, is unchanged.
    if (lastFile) void sendFile(lastFile.file, lastFile);
  };

  const runSelfTest = async () => {
    if (micRef.current !== 'live') {
      addLine({ tag: 'warn', text: 'loopback test needs the microphone', note: 'press RETRY MIC or LISTEN first', action: 'retry-mic' });
      return;
    }
    if (transmitter.busy) return;
    // Tests the carrier only; the test frame is never encrypted.
    const m = getMode(modeRef.current).modem;
    const nonce = crypto.getRandomValues(new Uint8Array(8));
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const test: SelfTest = { nonce, done, resolve };
    selfTestRef.current = test;
    const lineId = addLine({ tag: 'sys', mode: m.label, text: 'loopback test', note: 'playing a test frame and listening for it', progress: 0 });

    const outcome = await transmitter.run(
      `loopback test (${m.label})`,
      async () => {
        await audioForPlayback();
        return { modem: m, frames: [{ type: FrameType.SelfTest, payload: nonce }], monitor: true };
      },
      (s) => updateLine(lineId, { progress: s.progress }),
    );
    selfTestRef.current = null;

    if (outcome.status !== 'sent') {
      const note =
        outcome.status === 'failed'
          ? outcome.error.message
          : outcome.status === 'busy'
            ? 'already transmitting'
            : outcome.reason === 'interrupted'
              ? 'interrupted · audio paused'
              : 'cancelled';
      updateLine(lineId, { tag: 'warn', progress: undefined, note });
    } else if (test.heard) {
      updateLine(lineId, { tag: 'rx', progress: undefined, note: `passed · this device hears its own ${m.label} signal · margin ${test.heard.marginDb.toFixed(1)} dB` });
      announce(`Loopback test passed for ${m.label}`);
    } else {
      updateLine(lineId, {
        tag: 'warn',
        progress: undefined,
        note: `failed · this device did not hear its own ${m.label} signal · raise the volume, avoid Bluetooth, or try another mode`,
      });
      announce(`Loopback test failed for ${m.label}`);
    }
  };

  const selectMode = (id: string) => {
    if (transmitter.busy || !getMode(id).modem.supports(sampleRate)) return;
    setModeId(id);
    try {
      localStorage.setItem(MODE_KEY, id);
    } catch {
      // Not persisting the choice is fine.
    }
  };

  // Hotkeys: alt+1..3 mode, alt+f file, alt+r resend, alt+t test, esc cancel, / focus the prompt.
  const hotkeysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  hotkeysRef.current = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && transmitter.busy) {
      e.preventDefault();
      transmitter.cancel();
    } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit && MODES[Number(digit[1]) - 1]) {
        e.preventDefault();
        selectMode(MODES[Number(digit[1]) - 1].id);
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        if (!transmitter.busy) fileInputRef.current?.click();
      } else if (e.code === 'KeyR') {
        e.preventDefault();
        resendLastFile();
      } else if (e.code === 'KeyT') {
        e.preventDefault();
        void runSelfTest();
      }
    } else if (e.key === '/' && !e.isComposing && !(e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')) {
      e.preventDefault();
      inputRef.current?.focus();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => hotkeysRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Startup: create the context (it may stay suspended until a gesture) and ask
  // for the microphone straight away; neither waits on the other.
  const startupRef = useRef(() => {
    startAudio();
    addLine({
      tag: 'sys',
      text: 'ready · one-way send · auto-receive',
    });
    void startListening();
    // With a keyboard, start in the composer. Not on touch screens, where focus opens the keyboard.
    if (window.matchMedia('(pointer: fine)').matches && !document.activeElement?.closest('input, textarea, select')) {
      inputRef.current?.focus();
    }
  });
  useEffect(() => {
    const t = setTimeout(() => startupRef.current(), 300);
    return () => clearTimeout(t);
  }, []);

  // Mark files that stopped arriving as incomplete rather than leaving them
  // "receiving", and close rows of transfers the assembler has given up on.
  const fileTickRef = useRef<() => void>(() => {});
  fileTickRef.current = () => {
    const now = Date.now();
    for (const id of assemblerRef.current.expire(now)) dropFileLine(id, 'expired');
    for (const entry of fileLinesRef.current.values()) {
      if (entry.stale || now - entry.lastSeen < FILE_STALE_MS) continue;
      entry.stale = true;
      updateLine(entry.lineId, {
        tag: 'warn',
        progress: undefined,
        note: `incomplete · ${entry.received}/${entry.total ?? '?'} chunks · ask the sender to RESEND`,
      });
    }
  };
  useEffect(() => {
    const t = setInterval(() => fileTickRef.current(), 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const urls = blobUrlsRef.current;
    return () => {
      captureRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    if (!normalizeKey(psk)) return;
    const t = setTimeout(() => void deriveKey(psk).catch(() => undefined), KEY_WARMUP_MS);
    return () => clearTimeout(t);
  }, [psk]);

  useEffect(() => {
    for (const rel of ['icon', 'apple-touch-icon']) {
      let link = document.querySelector(`link[rel~='${rel}']`) as HTMLLinkElement | null;
      if (!link) {
        link = document.createElement('link');
        link.rel = rel;
        document.head.appendChild(link);
      }
      link.href = AUDIO_FAVICON;
    }
  }, []);

  // Keep the log pinned to the newest line unless the user has scrolled up.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  // Browsers keep the AudioContext suspended until a user gesture; any click counts.
  const handleUserInteraction = () => {
    if (audioContextRef.current?.state !== 'running') startAudio();
  };

  const payloadBytes = new TextEncoder().encode(inputText).length;
  const overLimit = payloadBytes > mode.maxPayload;
  const keyChars = Array.from(normalizeKey(psk)).length;
  const keyMissing = mode.encrypted && keyChars === 0;
  const maxFrequency = Math.min(20000, sampleRate / 2);
  const audioRunning = audioState === 'running';

  type Action = { label: React.ReactNode; run: () => void; primary?: boolean };
  const cancelAction: Action = {
    label: (
      <>
        <span className="key-hint">ESC </span>CANCEL
      </>
    ),
    run: () => transmitter.cancel(),
  };
  const listenAction: Action = { label: 'STOP', run: stopListening };
  let state: { text: string; className: string; actions: Action[] };
  // Paused audio comes first: while it lasts nothing can be sent or heard,
  // whatever was in progress.
  if (audioState !== 'none' && !audioRunning)
    state = {
      text: '○ AUDIO PAUSED',
      className: 'warn',
      actions: [{ label: 'START AUDIO', run: startAudio, primary: true }, ...(txBusy ? [cancelAction] : [])],
    };
  else if (txState.kind === 'preparing')
    state = { text: `… PREPARING ${shorten(txState.label, STATUS_NAME_CHARS)}`, className: 'warn', actions: [cancelAction] };
  else if (txState.kind === 'waiting') state = { text: '◌ WAITING FOR CLEAR CHANNEL', className: 'warn', actions: [cancelAction] };
  else if (txState.kind === 'sending')
    state = {
      text: `▲ TRANSMITTING ${txState.modem} ${Math.round(txState.progress * 100)}% · ${formatSeconds(txState.remaining)} left`,
      className: 'tx',
      actions: [cancelAction],
    };
  else if (rxState) state = { text: `◆ RECEIVING ${rxState.mode} ${Math.round(rxState.progress * 100)}%`, className: 'rx', actions: [listenAction] };
  else if (audioState === 'none') state = { text: '… STARTING', className: 'dim', actions: [] };
  else if (mic === 'requesting') state = { text: '… WAITING FOR MICROPHONE PERMISSION', className: 'warn', actions: [] };
  else if (mic === 'denied')
    state = { text: '✕ NO MICROPHONE · SEND ONLY', className: 'err', actions: [{ label: 'RETRY MIC', run: () => void startListening() }] };
  else if (mic === 'ended')
    state = { text: '✕ MICROPHONE DISCONNECTED', className: 'err', actions: [{ label: 'RETRY MIC', run: () => void startListening() }] };
  else if (mic === 'off') state = { text: '○ NOT LISTENING', className: 'warn', actions: [{ label: 'LISTEN', run: () => void startListening() }] };
  else state = { text: '● LISTENING', className: 'ok', actions: [listenAction] };
  const firstUse = !log.some((l) => l.tag === 'rx' || l.tag === 'tx');
  // Offered in log rows only while it would do something.
  const retryMic = mic === 'live' || mic === 'requesting' ? undefined : () => void startListening();

  return (
    <div className="app" onClick={handleUserInteraction}>
      <header className="topbar">
        <span className="brand">▚▞ CHIRP</span>
        <span className="dim topbar-sub">acoustic modem</span>
        <span className="spacer" />
        <span className={`state ${state.className}`}>{state.text}</span>
        {state.actions.map((action, i) => (
          <button
            key={i}
            className={`btn${action.primary ? ' btn-primary' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              action.run();
            }}
          >
            [ {action.label} ]
          </button>
        ))}
        <span className="dim topbar-sub">
          {(sampleRate / 1000).toFixed(1)}kHz · {captureMethod}
        </span>
      </header>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <main className="screen">
        <Panel title="SPECTRUM" right={`mic input · 0–${maxFrequency / 1000}kHz`} className="p-spectrum">
          <details open={spectrumOpen} onToggle={(e) => setSpectrumOpen(e.currentTarget.open)}>
            <summary className="dim">{spectrumOpen ? 'hide' : 'show'}</summary>
            {/* Unmounted while collapsed, which also stops its animation loop. */}
            {spectrumOpen && (
              <Spectrum
                analyser={analyser}
                sampleRate={sampleRate}
                maxFrequency={maxFrequency}
                band={modem.band}
                bandLabel={`TX:${modem.label}`}
                transmitting={txState.kind === 'sending'}
              />
            )}
          </details>
          <details className="diagnostics" open={diagnosticsOpen} onToggle={(e) => setDiagnosticsOpen(e.currentTarget.open)}>
            <summary className="dim">diagnostics</summary>
            <div className="diag">
              <div className="kv">
                <span className="dim">audio</span>
                <span>
                  {sampleRate} Hz · {captureMethod} · {audioState} · mic {mic}
                </span>
                <span className="dim">last tx</span>
                <span>
                  {lastTx
                    ? `${lastTx.mode} · ${lastTx.bytes} B · ${lastTx.duration.toFixed(2)}s · ${Math.round(
                        (lastTx.bytes * 8) / lastTx.duration,
                      )} b/s`
                    : '—'}
                </span>
                <span className="dim">last rx</span>
                <span>
                  {lastRx ? `${lastRx.mode} · margin ${lastRx.marginDb.toFixed(1)} dB · ${lastRx.corrected} B fixed` : '—'}
                </span>
              </div>
              <table className="stats">
                <caption className="sr-only">Frames received per mode</caption>
                <thead>
                  <tr>
                    <th scope="col">MODE</th>
                    <th scope="col">SYNC</th>
                    <th scope="col">OK</th>
                    <th scope="col">ERR</th>
                    <th scope="col" className="col-fixed">
                      FIXED
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {MODEMS.map((m) => {
                    const s = stats[m.id];
                    return (
                      <tr key={m.id}>
                        <th scope="row">{m.label}</th>
                        <td>{s?.syncs ?? 0}</td>
                        <td className="ok">{s?.frames ?? 0}</td>
                        <td className={s?.errors ? 'err' : undefined}>{s?.errors ?? 0}</td>
                        <td className="col-fixed">{s?.corrected ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </Panel>

        <Panel title="TRANSMIT" right={<span className="hotkey-hint">alt+1–{MODES.length} mode</span>} className="p-tx">
          <fieldset className="modes" disabled={txBusy}>
            <legend className="field-label">MODE</legend>
            {MODES.map((m, i) => {
              const supported = m.modem.supports(sampleRate);
              const active = m.id === modeId;
              return (
                <label
                  key={m.id}
                  className={`mode-row${active ? ' active' : ''}${supported ? '' : ' disabled'}`}
                  title={supported ? m.description : `needs a higher sample rate than ${sampleRate} Hz`}
                >
                  <input
                    type="radio"
                    name="mode"
                    value={m.id}
                    checked={active}
                    disabled={!supported}
                    onChange={() => selectMode(m.id)}
                  />
                  <span className="mode-radio" aria-hidden="true">
                    {active ? '(•)' : '( )'}
                  </span>
                  <span className="mode-name">{m.label}</span>
                  <span className="mode-band">{formatBand(m.modem.band)}</span>
                  <span className="mode-rate">~{goodput(m)} b/s</span>
                  <span className="mode-key" aria-hidden="true">
                    {i + 1}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div className="mode-hint">
            <span className="mode-hint-specs">
              ~{goodput(mode)} b/s · {formatBand(modem.band)} ·{' '}
            </span>
            {mode.description}
          </div>

          {mode.encrypted && (
            <>
              <label className="field-label" htmlFor="psk">
                PRE-SHARED KEY
              </label>
              <div className="prompt">
                <span className="prompt-sign" aria-hidden="true">
                  #
                </span>
                {/* A textarea so a long key wraps and stays readable; the key itself is one line. */}
                <textarea
                  id="psk"
                  value={psk}
                  rows={2}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  aria-describedby="psk-meta"
                  onChange={(e) => setPsk(e.target.value.replace(/[\r\n]+/g, ' '))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      inputRef.current?.focus();
                    }
                  }}
                  placeholder="type a 20+ character key, same on both devices"
                />
              </div>
              <div id="psk-meta" className={`tx-meta${keyChars > 0 && keyChars < MIN_KEY_CHARS ? ' warn' : ''}`}>
                {keyChars === 0
                  ? 'needed to send · also opens encrypted messages you receive · kept in memory only'
                  : keyChars < MIN_KEY_CHARS
                    ? `${keyChars} chars · short keys can be guessed from a recording: use 5+ random words`
                    : `${keyChars} chars · case-sensitive · kept in memory only`}
              </div>
            </>
          )}

          <label className="field-label" htmlFor="composer">
            MESSAGE
          </label>
          <div className="prompt">
            <span className="prompt-sign" aria-hidden="true">
              &gt;
            </span>
            <textarea
              id="composer"
              ref={inputRef}
              value={inputText}
              rows={3}
              spellCheck={false}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                // Enter that confirms an IME composition must not send.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (inputText.trim() && !overLimit && !keyMissing) void sendText(inputText, true);
                } else if (e.key === 'Escape' && !transmitter.busy) {
                  e.currentTarget.blur();
                }
              }}
              placeholder="type a message…"
            />
          </div>
          {firstUse && (
            <div className="tx-hint">open chirp on a second device and allow its microphone, then send</div>
          )}
          <div className={`tx-meta${overLimit ? ' err' : ''}`}>
            {payloadBytes}/{mode.maxPayload} B
            {payloadBytes > 0 && ` · ~${formatSeconds(messageAirtime(mode, payloadBytes))} airtime`}
          </div>

          <div className="actions">
            {txBusy ? (
              <button className="btn btn-primary" onClick={() => transmitter.cancel()}>
                [ <span className="key-hint">ESC </span>CANCEL ]
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void sendText(inputText, true)} disabled={!inputText || overLimit || keyMissing}>
                [ ⏎ SEND ]
              </button>
            )}
            <button className="btn" onClick={() => fileInputRef.current?.click()} disabled={txBusy || keyMissing}>
              [ <span className="key">F</span>ILE ]
            </button>
            {lastFile && (
              <button className="btn" onClick={resendLastFile} disabled={txBusy || keyMissing} title={`Resend ${lastFile.file.name}`}>
                [ <span className="key">R</span>ESEND {lastFile.file.name} ]
              </button>
            )}
            <button
              className="btn"
              onClick={() => void runSelfTest()}
              disabled={txBusy || mic !== 'live'}
              title="Play a test frame and check that this device can hear it"
            >
              [ <span className="key">T</span>EST ]
            </button>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void sendFile(file);
              }}
            />
          </div>
        </Panel>

        <Panel title="LOG" right={`${log.length} lines`} className="p-log">
          <div
            className="log"
            ref={logRef}
            tabIndex={0}
            aria-label="Transfer log"
            onScroll={(e) => {
              const el = e.currentTarget;
              stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {log.map((line) => (
              <LogRow key={line.id} line={line} retryMic={retryMic} />
            ))}
          </div>
        </Panel>
      </main>

      <footer className="keybar">
        <span className="hotkeys">
          <span className="key">⏎</span> send <span className="key">esc</span> cancel <span className="key">/</span> focus{' '}
          <span className="key">alt+1–{MODES.length}</span> mode <span className="key">alt+f</span> file{' '}
          <span className="key">alt+r</span> resend <span className="key">alt+t</span> test
        </span>
        <span className="spacer" />
        {/* A page of its own, so its sound demos can never play over this app's transfers. */}
        <a className="btn explain-toggle" href="/explain/">
          [ ? EXPLAIN THIS ]
        </a>
        <span className="credits">
          built by{' '}
          <a href="https://x.com/icesolst" target="_blank" rel="noopener noreferrer">
            solst/ICE
          </a>{' '}
          ·{' '}
          <a href="https://github.com/solst-ice/chirp" target="_blank" rel="noopener noreferrer">
            code
          </a>
        </span>
      </footer>
    </div>
  );
}

export default App;
