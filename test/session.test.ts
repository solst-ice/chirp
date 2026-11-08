import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ENCRYPTION_OVERHEAD, deriveKeys, type PskKeys } from '../src/modem/encryption.ts';
import {
  SESSION_OVERHEAD,
  createEphemeral,
  deriveSession,
  helloFrame,
  openInSession,
  parseHandshake,
  replyFrame,
} from '../src/modem/session.ts';
import { getModem } from '../src/modem/profiles.ts';
import { FrameType, type Frame } from '../src/modem/types.ts';
import { roundTrip } from './channel.ts';
import { SESSION_REUSE_MS, SESSION_TTL_MS, SessionManager, type Notice } from '../src/transfer/sessions.ts';

const text = (s: string): Frame => ({ type: FrameType.Text, payload: new TextEncoder().encode(s) });
const PASSPHRASE = 'otter velvet canyon lamp orbit';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Devices sharing one simulated room. Every frame anyone plays reaches every
 * other device (and the recorder), a few milliseconds later, unless `drop` says so.
 */
function room(opts: { drop?: (from: string, frame: Frame) => boolean; now?: () => number } = {}) {
  const devices = new Map<string, { manager: SessionManager; notices: Notice[]; keys: () => Promise<PskKeys> }>();
  const recording: { from: string; frame: Frame }[] = [];
  const broadcast = (from: string, frame: Frame) => {
    recording.push({ from, frame });
    if (opts.drop?.(from, frame)) return;
    for (const [name, d] of devices) {
      if (name === from) continue;
      if (frame.type === FrameType.Handshake) {
        // Synchronously, as the app does from its frame event.
        void d.manager.onHandshake(frame.payload).then((n) => n && d.notices.push(n));
      }
    }
  };
  const add = (name: string, passphrase = PASSPHRASE, extra: { answer?: () => boolean } = {}) => {
    const notices: Notice[] = [];
    const keys = () => deriveKeys(passphrase);
    const manager = new SessionManager({
      keys,
      now: opts.now,
      replyTimeoutMs: 300,
      answer: (frame) => {
        if (extra.answer && !extra.answer()) return false;
        setTimeout(() => broadcast(name, frame), 5);
        return true;
      },
    });
    manager.setEnabled(true);
    devices.set(name, { manager, notices, keys });
    return { manager, notices };
  };
  const say = (from: string) => async (frame: Frame, signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    await delay(5);
    broadcast(from, frame);
  };
  return { add, say, recording };
}

const job = () => new AbortController().signal;

describe('two-way sessions', () => {
  test('a handshake gives both sides the same session, usable in both directions', async () => {
    const r = room();
    const a = r.add('a');
    const b = r.add('b');
    const statuses: string[] = [];
    const session = await a.manager.establish(r.say('a'), job(), (s) => statuses.push(s));
    assert.equal(session.role, 'initiator');
    assert.ok(statuses.some((s) => s.includes('waiting')));

    const sealed = await a.manager.seal(session, text('over the fence'));
    assert.equal(sealed.payload.length, text('over the fence').payload.length + SESSION_OVERHEAD);
    assert.equal(SESSION_OVERHEAD, ENCRYPTION_OVERHEAD);
    // The responder does not send in a session until the initiator has used it.
    assert.equal(b.manager.current(), null);
    const opened = await b.manager.open(sealed.payload);
    assert.ok(opened.ok);
    assert.deepEqual(opened.frame, text('over the fence'));
    assert.equal(b.manager.current()?.id, session.id);
    assert.equal(a.manager.current()?.id, session.id);

    // Now B answers in the same session, with no second handshake.
    const back = await b.manager.establish(r.say('b'), job());
    assert.equal(back.id, session.id);
    const reply = await a.manager.open((await b.manager.seal(back, text('heard you'))).payload);
    assert.ok(reply.ok);
    assert.deepEqual(reply.frame, text('heard you'));
    assert.equal(r.recording.filter((x) => x.frame.type === FrameType.Handshake).length, 2);
  });

  test('a listener who recorded everything and knows the key still cannot open the session', async () => {
    const r = room();
    const a = r.add('a');
    r.add('b');
    const session = await a.manager.establish(r.say('a'), job());
    const sealed = await a.manager.seal(session, text('secret'));

    // The eavesdropper holds the same PSK and every handshake frame, but not
    // either ephemeral private key. The best it can do is pair the recorded
    // public keys with a key pair of its own.
    const { mix } = await deriveKeys(PASSPHRASE);
    const frames = r.recording.map((x) => parseHandshake(x.frame.payload)!);
    const hello = frames.find((h) => h.kind === 'hello')!;
    const reply = frames.find((h) => h.kind === 'reply')!;
    const mine = await createEphemeral();
    for (const role of ['initiator', 'responder'] as const) {
      const guess = await deriveSession(mix, mine, role, hello.publicKey, reply.publicKey);
      // The session code is public, but the keys are not.
      assert.equal(guess.idHex, session.id);
      assert.notDeepEqual(guess.confirm, reply.kind === 'reply' ? reply.confirm : null);
      for (const key of [guess.send, guess.receive]) assert.deepEqual(await openInSession(key, sealed.payload), { ok: false, reason: 'key' });
    }
    // And a third device with the key, which only listened, has no session at all.
    const c = new SessionManager({ keys: () => deriveKeys(PASSPHRASE), answer: () => true });
    c.setEnabled(true);
    assert.deepEqual(await c.open(sealed.payload), { ok: false, reason: 'session' });
  });

  test('a responder with a different key is refused, and nothing falls back to sending without a session', async () => {
    const r = room();
    const a = r.add('a');
    r.add('b', 'some other passphrase entirely');
    await assert.rejects(a.manager.establish(r.say('a'), job()), /no answer/);
    assert.ok(a.notices.some((n) => n.text === 'handshake answer refused' && /different key/.test(n.note!)));
    assert.equal(a.manager.current(), null);
  });

  test('a lost hello is asked again; a lost reply is answered again with the same reply', async () => {
    // A's first hello and B's first reply are lost.
    const lost = new Set<string>();
    const r = room({ drop: (from) => !lost.has(from) && !!lost.add(from) });
    const a = r.add('a');
    r.add('b');
    const session = await a.manager.establish(r.say('a'), job());
    assert.ok(session);
    const replies = r.recording.filter((x) => x.from === 'b').map((x) => Buffer.from(x.frame.payload).toString('hex'));
    assert.equal(replies.length, 2);
    assert.equal(replies[0], replies[1]);
    assert.equal(r.recording.filter((x) => x.from === 'a').length, 3);
  });

  test('two devices calling at once settle on sessions both can use', async () => {
    const r = room();
    const a = r.add('a');
    const b = r.add('b');
    const [sa, sb] = await Promise.all([a.manager.establish(r.say('a'), job()), b.manager.establish(r.say('b'), job())]);
    const ab = await b.manager.open((await a.manager.seal(sa, text('from a'))).payload);
    const ba = await a.manager.open((await b.manager.seal(sb, text('from b'))).payload);
    assert.ok(ab.ok && ba.ok);
  });

  test('replays within a session and frames reflected back to their sender are refused', async () => {
    const r = room();
    const a = r.add('a');
    const b = r.add('b');
    const session = await a.manager.establish(r.say('a'), job());
    const sealed = await a.manager.seal(session, text('once'));
    assert.ok((await b.manager.open(sealed.payload)).ok);
    assert.deepEqual(await b.manager.open(sealed.payload), { ok: false, reason: 'replay' });
    assert.deepEqual(await a.manager.open(sealed.payload), { ok: false, reason: 'key' });
    const altered = sealed.payload.slice();
    altered[altered.length - 1] ^= 1;
    assert.deepEqual(await b.manager.open(altered), { ok: false, reason: 'key' });
  });

  test('a stray hello does not become the session a responder sends in', async () => {
    const r = room();
    const b = r.add('b');
    const stranger = await createEphemeral();
    await b.manager.onHandshake(helloFrame(stranger.publicKey).payload);
    assert.equal(b.manager.current(), null);
  });

  test('a second answer to a finished handshake is reported', async () => {
    const r = room();
    const a = r.add('a');
    r.add('b');
    await a.manager.establish(r.say('a'), job());
    const hello = parseHandshake(r.recording.find((x) => x.from === 'a')!.frame.payload)!;
    const other = await createEphemeral();
    const notice = await a.manager.onHandshake(replyFrame(hello.publicKey, other.publicKey, new Uint8Array(16)).payload);
    assert.equal(notice?.text, 'a second device answered our handshake');
  });

  test('sessions end with the key, with two-way off, and with age', async () => {
    let now = Date.UTC(2026, 10, 8, 12);
    const r = room({ now: () => now });
    const a = r.add('a');
    const b = r.add('b');
    const session = await a.manager.establish(r.say('a'), job());
    const sealed = await a.manager.seal(session, text('hi'));

    // Old enough that no new transfer starts in it, but frames still open.
    now += SESSION_REUSE_MS;
    assert.equal(a.manager.current(), null);
    assert.ok((await b.manager.open(sealed.payload)).ok);
    now += SESSION_TTL_MS - SESSION_REUSE_MS;
    assert.deepEqual(await b.manager.open(sealed.payload), { ok: false, reason: 'session' });

    now = Date.UTC(2026, 10, 8, 12);
    const fresh = await a.manager.establish(r.say('a'), job());
    const sealed2 = await a.manager.seal(fresh, text('hi'));
    b.manager.setEnabled(true);
    assert.deepEqual(await b.manager.open(sealed2.payload), { ok: false, reason: 'session' });
    a.manager.reset();
    await assert.rejects(a.manager.seal(fresh, text('late')), /session ended/);
  });

  test('a cancelled job stops waiting for an answer', async () => {
    const r = room();
    const a = r.add('a');
    const controller = new AbortController();
    const pending = a.manager.establish(r.say('a'), controller.signal);
    await delay(50);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });

  test('with two-way off a hello is not answered, and the notice is not repeated for retries', async () => {
    const b = new SessionManager({ keys: () => deriveKeys(PASSPHRASE), answer: () => assert.fail('must not answer') });
    const hello = helloFrame((await createEphemeral()).publicKey).payload;
    assert.match((await b.onHandshake(hello))!.note!, /TWO-WAY/);
    assert.equal(await b.onHandshake(hello), null);
  });

  test('an all-zero public key is refused', async () => {
    const { mix } = await deriveKeys(PASSPHRASE);
    await assert.rejects(deriveSession(mix, await createEphemeral(), 'responder', new Uint8Array(32), new Uint8Array(32)));
  });
  test('handshake frames survive the FAST modem through a noisy, echoey room', async () => {
    const own = await createEphemeral();
    const other = await createEphemeral();
    const modem = getModem('fast');
    for (const frame of [helloFrame(own.publicKey), replyFrame(own.publicKey, other.publicKey, new Uint8Array(16).fill(7))]) {
      const { frames } = roundTrip(modem, frame, 48000, { snrDb: 15, echoes: [{ delay: 0.012, gain: 0.4 }] });
      assert.equal(frames.length, 1);
      assert.deepEqual(frames[0].frame, frame);
      assert.ok(parseHandshake(frames[0].frame.payload));
    }
  });
  test('after the receiver loses its session, NEW SESSION on the sender recovers without a loop', async () => {
    const r = room();
    const a = r.add('a');
    const b = r.add('b');
    const first = await a.manager.establish(r.say('a'), job());
    assert.ok((await b.manager.open((await a.manager.seal(first, text('one'))).payload)).ok);
    // B reloads (or turns two-way off and on): its sessions are gone.
    b.manager.setEnabled(true);
    const stale = await a.manager.establish(r.say('a'), job());
    assert.equal(stale.id, first.id, 'the sender cannot know, so it reuses the session');
    assert.deepEqual(await b.manager.open((await a.manager.seal(stale, text('two'))).payload), { ok: false, reason: 'session' });

    a.manager.renew();
    assert.equal(a.manager.current(), null);
    const fresh = await a.manager.establish(r.say('a'), job());
    assert.notEqual(fresh.id, first.id);
    assert.ok((await b.manager.open((await a.manager.seal(fresh, text('three'))).payload)).ok);
    // Frames still in flight in the old session open on a device that has it.
    const late = await a.manager.seal(first, text('late')).catch(() => null);
    assert.ok(late, 'a retired session can still seal what was already prepared');
  });
  test('NEW SESSION can be pressed again and again: every new session works', async () => {
    const r = room();
    const a = r.add('a');
    const b = r.add('b');
    for (let i = 0; i < 12; i++) {
      a.manager.renew();
      const session = await a.manager.establish(r.say('a'), job());
      const opened = await b.manager.open((await a.manager.seal(session, text(`round ${i}`))).payload);
      assert.ok(opened.ok, `round ${i}: ${JSON.stringify(opened)}`);
      // And the answering side sends in the newest one.
      assert.equal(b.manager.current()?.id, session.id);
    }
  });

  test('a flood of stray hellos cannot push out an established session', async () => {
    const r = room();
    const a = r.add('a');
    const b = r.add('b');
    const session = await a.manager.establish(r.say('a'), job());
    assert.ok((await b.manager.open((await a.manager.seal(session, text('before'))).payload)).ok);
    for (let i = 0; i < 30; i++) await b.manager.onHandshake(helloFrame((await createEphemeral()).publicKey).payload);
    assert.equal(b.manager.current()?.id, session.id);
    assert.ok((await b.manager.open((await a.manager.seal(session, text('after'))).payload)).ok);
  });

  test('retired sessions stop opening frames once nothing sent in them can still arrive', async () => {
    let now = Date.UTC(2026, 10, 8, 12);
    const r = room({ now: () => now });
    const a = r.add('a');
    const b = r.add('b');
    const session = await a.manager.establish(r.say('a'), job());
    const late = await a.manager.seal(session, text('late'));
    assert.ok((await b.manager.open((await a.manager.seal(session, text('confirm'))).payload)).ok);
    b.manager.renew();
    now += 19 * 60_000;
    assert.ok((await b.manager.open(late.payload)).ok);
    now += 2 * 60_000;
    assert.deepEqual(await b.manager.open((await a.manager.seal(session, text('later'))).payload), { ok: false, reason: 'session' });
  });
});
