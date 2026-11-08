// Two-way (PSK + Diffie–Hellman) sessions: who we have keys with, and the
// handshake that makes new ones. The crypto is in modem/session.ts.
//
// Sending: `establish` returns a confirmed session, or runs a handshake inside
// the caller's transmitter job: play a hello, listen for a reply, ask again a
// couple of times, then give up. It never falls back to the plain pre-shared
// key: a send that asked for forward secrecy fails instead.
//
// Receiving: every hello is answered (when two-way is on and a key is set), and
// the session it creates is kept for opening frames. It is only used for
// sending once a frame from the initiator has opened in it, so a stray or
// hostile hello cannot make us send in a session nobody else holds.
//
// Two devices that start at once: whichever hello has the lower public key
// wins. The other device answers it and then starts over with a fresh hello.
//
// Everything is in memory. A reload, a key change or turning two-way off ends
// every session, and with it the only way to open its frames.

import { hex, type PskKeys } from '../modem/encryption.ts';
import {
  compareKeys,
  createEphemeral,
  deriveSession,
  helloFrame,
  helloRefOf,
  openInSession,
  parseHandshake,
  replyFrame,
  sameBytes,
  sealInSession,
  sessionIdOf,
  type Ephemeral,
  type Role,
} from '../modem/session.ts';
import type { Frame } from '../modem/types.ts';

/** A session ends this long after its handshake. */
export const SESSION_TTL_MS = 60 * 60_000;
/** No new transfer starts in a session older than this, so the longest transfer (15 min + 2 min wait) still ends inside it. */
export const SESSION_REUSE_MS = 40 * 60_000;
/** Hellos played before giving up. */
export const HELLO_ATTEMPTS = 3;
/** Handshakes started over after losing a tie before giving up. */
const MAX_ROUNDS = 3;
/**
 * Kept apart, so neither crowds out the other: confirmed sessions (one per
 * device we talk to, plus a few renewed ones), and unconfirmed ones, which
 * anyone can create with a hello and so may only ever displace each other.
 */
const MAX_CONFIRMED = 8;
const MAX_UNCONFIRMED = 8;
/** A retired session opens frames this long after renew(): the longest transfer (15 min) and its channel wait (2 min), with room. */
const RETIRED_TTL_MS = 20 * 60_000;
/** A repeated hello within this long gets the same reply again. */
const ANSWER_CACHE_MS = 2 * 60_000;
/** How long a finished handshake is remembered, to notice a second device answering it. */
const COMPLETED_MS = 5 * 60_000;
const NOTICE_MEMORY = 64;

export interface Session {
  id: string;
  idBytes: Uint8Array;
  role: Role;
  send: CryptoKey;
  receive: CryptoKey;
  createdAt: number;
  /** When a frame from the other side first opened (responder), or the reply checked out (initiator). */
  confirmedAt?: number;
  /** Nonces already opened, so a replay within the session is noticed. */
  seen: Set<string>;
  /** When renew() retired it: it still opens frames for a while, but is no longer sent in. */
  retiredAt?: number;
}

export interface SessionInfo {
  id: string;
  role: Role;
  /** After this, sends start a new handshake; frames already sent still open until the session ends. */
  renewsAt: number;
}

export interface Notice {
  tag: 'sys' | 'warn';
  text: string;
  note?: string;
}

export type SessionOpen =
  | { ok: true; frame: Frame; session: string }
  | { ok: false; reason: 'session' | 'key' | 'format' | 'replay' };

export type Say = (frame: Frame, signal?: AbortSignal) => Promise<void>;

export interface SessionDeps {
  /** Keys for the current pre-shared key; rejects if there is none. */
  keys(): Promise<PskKeys>;
  /** Play a handshake reply when the speaker is free; false if it cannot go out now. */
  answer(frame: Frame): boolean;
  /** Called whenever the session used for sending changes. */
  onChange?(info: SessionInfo | null): void;
  now?(): number;
  /** How long to listen for a reply after each hello. */
  replyTimeoutMs?: number;
  /**
   * After losing a tie and answering, how long to listen before calling
   * again, so the winner's data starts first and listen-before-talk then
   * holds our hello back instead of colliding with it.
   */
  yieldBackoffMs?: number;
  /**
   * Up to this long, at random, before each repeated hello, so two devices
   * whose hellos collided do not collide again on every retry.
   */
  retryJitterMs?: number;
}

type Outcome = { kind: 'session'; session: Session } | { kind: 'yield'; reply: Promise<Frame> };

interface Pending {
  own: Ephemeral;
  ref: string;
  /** Aborted once the round is decided, to stop a hello that has not played yet. */
  decided: AbortController;
  outcome?: Outcome;
  /** Decide the round; the first outcome wins. */
  settle(outcome: Outcome): void;
}

const infoOf = (s: Session): SessionInfo => ({ id: s.id, role: s.role, renewsAt: s.createdAt + SESSION_REUSE_MS });

const abortError = () => new DOMException('cancelled', 'AbortError');

/** Sleep, or reject if the job is cancelled first. */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    if (ms <= 0) return resolve();
    const onAbort = () => (clearTimeout(timer), reject(abortError()));
    const timer = setTimeout(() => (signal.removeEventListener('abort', onAbort), resolve()), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

export class SessionManager {
  private readonly deps: SessionDeps;
  private enabled = false;
  /** Goes up on every reset; async work from before a reset is discarded. */
  private generation = 0;
  private sessions = new Map<string, Session>();
  private pending: Pending | null = null;
  /** Hello key (hex) → our reply and when we made it. */
  private answered = new Map<string, { reply: Frame; at: number }>();
  /** Our finished hellos: ref → the responder key we accepted. */
  private completed = new Map<string, { peer: string; at: number; warned: boolean }>();
  /** Hellos we already reported, so retries do not repeat the notice. */
  private noticed = new Set<string>();
  private lastInfo: string | null = null;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  get isEnabled() {
    return this.enabled;
  }

  /** Turn two-way on or off. Either way, every session and handshake ends. */
  setEnabled(on: boolean) {
    this.enabled = on;
    this.reset();
  }

  /** End every session (the key changed, two-way was turned off, or the user asked). */
  reset() {
    this.generation++;
    this.sessions.clear();
    this.answered.clear();
    this.completed.clear();
    this.noticed.clear();
    // An establish() waiting on this handshake gives up.
    this.pending?.decided.abort();
    this.pending = null;
    this.changed();
  }

  /**
   * Stop sending in the current sessions, so the next send starts a new one:
   * the way out when the other device no longer has ours (it reloaded, or
   * turned two-way off and on). Frames still arriving in them open.
   */
  renew() {
    const now = this.now();
    for (const s of this.sessions.values()) s.retiredAt ??= now;
    this.changed();
  }

  /** The session sends would use now, if any. */
  current(): SessionInfo | null {
    this.expire();
    const s = this.sendable();
    return s ? infoOf(s) : null;
  }

  /** Drop sessions past their lifetime. */
  expire() {
    const now = this.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt >= SESSION_TTL_MS || (s.retiredAt !== undefined && now - s.retiredAt >= RETIRED_TTL_MS)) this.sessions.delete(id);
    }
    for (const [k, a] of this.answered) if (now - a.at >= ANSWER_CACHE_MS) this.answered.delete(k);
    for (const [k, c] of this.completed) if (now - c.at >= COMPLETED_MS) this.completed.delete(k);
    this.changed();
  }

  private sendable(): Session | null {
    const now = this.now();
    let best: Session | null = null;
    for (const s of this.sessions.values()) {
      if (s.confirmedAt === undefined || s.retiredAt !== undefined || now - s.createdAt >= SESSION_REUSE_MS) continue;
      if (!best || s.confirmedAt > best.confirmedAt!) best = s;
    }
    return best;
  }

  private changed() {
    const info = this.sendable();
    const key = info ? `${info.id}:${info.createdAt}` : null;
    if (key === this.lastInfo) return;
    this.lastInfo = key;
    this.deps.onChange?.(info ? infoOf(info) : null);
  }

  private add(session: Session) {
    this.sessions.set(session.id, session);
    this.trim();
    this.changed();
  }

  /**
   * Enforce the two limits. A new unconfirmed session only ever pushes out
   * the oldest unconfirmed one, so hellos cannot evict an established session;
   * once a session is confirmed, it pushes out the oldest confirmed one,
   * retired sessions first.
   */
  private trim() {
    const all = [...this.sessions.values()];
    const unconfirmed = all.filter((s) => s.confirmedAt === undefined).sort((a, b) => a.createdAt - b.createdAt);
    for (const s of unconfirmed.slice(0, Math.max(0, unconfirmed.length - MAX_UNCONFIRMED))) this.sessions.delete(s.id);
    const confirmed = all
      .filter((s) => s.confirmedAt !== undefined)
      .sort((a, b) => Number(b.retiredAt !== undefined) - Number(a.retiredAt !== undefined) || a.confirmedAt! - b.confirmedAt!);
    for (const s of confirmed.slice(0, Math.max(0, confirmed.length - MAX_CONFIRMED))) this.sessions.delete(s.id);
  }

  private check(generation: number) {
    if (generation !== this.generation) throw new Error('the key or two-way setting changed · send again');
  }

  /**
   * A confirmed session for sending, running a handshake first if there is
   * none. `say` plays frames inside the caller's transmitter job; `status`
   * reports what we are waiting for.
   */
  async establish(say: Say, signal: AbortSignal, status: (text: string) => void = () => {}): Promise<Session> {
    if (!this.enabled) throw new Error('two-way is off');
    this.expire();
    const ready = this.sendable();
    if (ready) return ready;
    const generation = this.generation;
    // Fails early, before any sound, if there is no key.
    await this.deps.keys();
    this.check(generation);

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const own = await createEphemeral();
      this.check(generation);
      if (signal.aborted) throw abortError();
      const pending: Pending = {
        own,
        ref: hex(helloRefOf(own.publicKey)),
        decided: new AbortController(),
        settle(o) {
          if (pending.outcome) return;
          pending.outcome = o;
          pending.decided.abort();
        },
      };
      this.pending = pending;
      let outcome: Outcome;
      try {
        outcome = await this.round(pending, say, signal, status);
      } finally {
        if (this.pending === pending) this.pending = null;
      }
      this.check(generation);
      // The data that follows waits for the turnaround in the transmitter's listen before talk.
      if (outcome.kind === 'session') return outcome.session;
      // We lost a tie: answer the other device's hello, then start over with a fresh key.
      status('handshake · the other device called at the same time · answering it first');
      await say(await outcome.reply);
      status('handshake · letting the other device send first');
      await pause(this.deps.yieldBackoffMs ?? 0, signal);
      this.check(generation);
    }
    throw new Error('the other device kept starting handshakes at the same time · try again');
  }

  private async round(pending: Pending, say: Say, signal: AbortSignal, status: (text: string) => void): Promise<Outcome> {
    const generation = this.generation;
    const timeout = this.deps.replyTimeoutMs ?? 6000;
    const hello = helloFrame(pending.own.publicKey);
    for (let attempt = 0; attempt < HELLO_ATTEMPTS; attempt++) {
      status(attempt === 0 ? 'handshake · calling the other device' : `handshake · no answer · calling again (${attempt + 1}/${HELLO_ATTEMPTS})`);
      try {
        if (attempt > 0) await pause(Math.random() * (this.deps.retryJitterMs ?? 0), AbortSignal.any([signal, pending.decided.signal]));
        await say(hello, pending.decided.signal);
      } catch (err) {
        if (pending.outcome) return pending.outcome;
        this.check(generation);
        throw err;
      }
      status('handshake · waiting for the other device to answer');
      const outcome = await this.wait(pending, timeout, signal);
      this.check(generation);
      if (outcome) return outcome;
    }
    throw new Error('no answer to the handshake · is the other device in ENCRYPTED with TWO-WAY on and the same key?');
  }

  /** The round's outcome, or null after `ms` without one. Rejects if the job is cancelled. */
  private wait(pending: Pending, ms: number, signal: AbortSignal): Promise<Outcome | null> {
    if (pending.outcome) return Promise.resolve(pending.outcome);
    return new Promise<Outcome | null>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        pending.decided.signal.removeEventListener('abort', onDecided);
      };
      const timer = setTimeout(() => (done(), resolve(null)), ms);
      const onAbort = () => (done(), reject(abortError()));
      // Also fires on reset(), which leaves no outcome: resolve null and let check() report it.
      const onDecided = () => (done(), resolve(pending.outcome ?? null));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.decided.signal.addEventListener('abort', onDecided, { once: true });
    });
  }

  /**
   * A handshake frame heard from the microphone. Call it synchronously from
   * the frame event: a tie with our own pending hello is decided before
   * anything else can play.
   */
  onHandshake(payload: Uint8Array): Promise<Notice | null> {
    const h = parseHandshake(payload);
    if (!h) return Promise.resolve({ tag: 'warn', text: 'handshake frame not understood', note: 'unsupported version' });
    if (h.kind === 'reply') return this.onReply(h.helloRef, h.publicKey, h.confirm);

    const key = hex(h.publicKey);
    if (!this.enabled) {
      if (!this.remember(key)) return Promise.resolve(null);
      return Promise.resolve({
        tag: 'warn',
        text: 'two-way handshake heard, not answered',
        note: 'select ENCRYPTED, turn on TWO-WAY and enter the same key, then the other device sends again',
      });
    }
    const pending = this.pending;
    if (pending && !pending.outcome) {
      // Our own hello, played back at us.
      if (sameBytes(h.publicKey, pending.own.publicKey)) return Promise.resolve(null);
      // A tie. The lower key wins; the other device will answer ours.
      if (compareKeys(pending.own.publicKey, h.publicKey) < 0) return Promise.resolve(null);
      const reply = this.answerHello(h.publicKey);
      pending.settle({ kind: 'yield', reply });
      return reply.then(
        () => null,
        (err) => ({ tag: 'warn' as const, text: 'could not answer a handshake', note: errorText(err) }),
      );
    }
    return this.answerHello(h.publicKey).then(
      (reply) => {
        if (this.deps.answer(reply)) return null;
        return { tag: 'warn' as const, text: 'two-way handshake not answered', note: 'busy transmitting · the other device will ask again' };
      },
      (err) => ({ tag: 'warn' as const, text: 'two-way handshake not answered', note: errorText(err) }),
    );
  }

  private remember(key: string) {
    if (this.noticed.has(key)) return false;
    this.noticed.add(key);
    if (this.noticed.size > NOTICE_MEMORY) this.noticed.delete(this.noticed.values().next().value!);
    return true;
  }

  /** Our reply to a hello, creating the (unconfirmed) responder session the first time. */
  private async answerHello(helloKey: Uint8Array): Promise<Frame> {
    const key = hex(helloKey);
    const cached = this.answered.get(key);
    if (cached && this.now() - cached.at < ANSWER_CACHE_MS) return cached.reply;
    const generation = this.generation;
    const { mix } = await this.deps.keys();
    const own = await createEphemeral();
    const keys = await deriveSession(mix, own, 'responder', helloKey, own.publicKey);
    this.check(generation);
    // Our ephemeral private key goes out of scope here: only the session keys remain.
    const reply = replyFrame(helloKey, own.publicKey, keys.confirm);
    this.answered.set(key, { reply, at: this.now() });
    this.add({ id: keys.idHex, idBytes: keys.id, role: 'responder', send: keys.send, receive: keys.receive, createdAt: this.now(), seen: new Set() });
    return reply;
  }

  private async onReply(ref: Uint8Array, replyKey: Uint8Array, confirm: Uint8Array): Promise<Notice | null> {
    const refHex = hex(ref);
    const pending = this.pending;
    if (pending && !pending.outcome && refHex === pending.ref) {
      const generation = this.generation;
      const { mix } = await this.deps.keys();
      let keys;
      try {
        keys = await deriveSession(mix, pending.own, 'initiator', pending.own.publicKey, replyKey);
      } catch {
        return { tag: 'warn', text: 'handshake answer refused', note: 'invalid public key' };
      }
      if (generation !== this.generation || pending.outcome) return null;
      if (!sameBytes(keys.confirm, confirm)) {
        return { tag: 'warn', text: 'handshake answer refused', note: 'the other device has a different key, or the answer was altered' };
      }
      const now = this.now();
      const session: Session = { id: keys.idHex, idBytes: keys.id, role: 'initiator', send: keys.send, receive: keys.receive, createdAt: now, confirmedAt: now, seen: new Set() };
      this.completed.set(refHex, { peer: hex(replyKey), at: now, warned: false });
      this.add(session);
      pending.settle({ kind: 'session', session });
      return null;
    }
    const done = this.completed.get(refHex);
    if (done && done.peer !== hex(replyKey) && !done.warned) {
      done.warned = true;
      return {
        tag: 'warn',
        text: 'a second device answered our handshake',
        note: 'two-way sessions are between two devices · if only two are here, someone else may be interfering',
      };
    }
    // An answer to someone else's hello, or a repeat of one we already have.
    return null;
  }

  async seal(session: Session, frame: Frame): Promise<Frame> {
    if (this.sessions.get(session.id) !== session) throw new Error('the session ended · send again');
    return sealInSession({ id: session.idBytes, send: session.send }, frame);
  }

  async open(payload: Uint8Array): Promise<SessionOpen> {
    const id = sessionIdOf(payload);
    if (id === null) return { ok: false, reason: 'format' };
    this.expire();
    const session = this.sessions.get(id);
    if (!session) return { ok: false, reason: 'session' };
    const result = await openInSession(session.receive, payload);
    // Ended while it was being opened.
    if (this.sessions.get(id) !== session) return { ok: false, reason: 'session' };
    if (!result.ok) return result;
    if (session.seen.has(result.nonce)) return { ok: false, reason: 'replay' };
    session.seen.add(result.nonce);
    if (session.confirmedAt === undefined) {
      session.confirmedAt = this.now();
      this.trim();
      this.changed();
    }
    return { ok: true, frame: result.frame, session: id };
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
