/**
 * wire.js: the messages that travel inside the encrypted channel between the
 * Apaki engine on a PC (apaki/engine/remote.js) and the Apaki web client on a
 * phone (apaki/web). protocol.js seals and opens them; this file only says
 * what they are and moves them efficiently.
 *
 * Track B part 2 (2026-10-09, Arthur: use Apaki from the phone through the
 * relay, the PC doing all the work). The phone speaks the same engine
 * commands the desktop window does, so the web client can run Apaki's own UI.
 *
 *   phone -> PC   { t: 'cmd', cmd }                one engine command (engine.js op)
 *   PC -> phone   { t: 'hello', v, pcName, ops }   right after the channel opens
 *                 { t: 'evs', list }               engine events, batched
 *   either way    { t: 'big', stream, bytes }      then binary chunks of that stream:
 *                                                  one message too large for a
 *                                                  record (a long history, a photo)
 *
 * Batching: a turn streams many small events (text deltas). The Outbox
 * gathers them for FLUSH_MS into one record, so a phone gets tens of frames a
 * second, well inside the relay's per-socket frame limit, instead of hundreds.
 *
 * Isomorphic ESM like protocol.js (Node 20+ and mobile browsers), no
 * dependencies.
 */

import { MAX_CHUNK_BYTES, MAX_JSON_BYTES } from './protocol.js';

export const WIRE_VERSION = 1;
/** How long events gather into one batch. */
export const FLUSH_MS = 25;
/** A batch is sent at once when it reaches this many bytes. */
export const BATCH_BYTES = 64 * 1024;
/** Largest message (after reassembly) an Inbox accepts by default. */
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

/** A message that breaks the rules above (the side that sees it closes the channel). */
export class WireError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WireError';
  }
}

/** UTF-8 length of a string. */
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * The sending side of one open session.
 *
 * push(ev) queues an engine event for the next batch; send(value) sends one
 * message after anything already queued. Frames reach `write` in the order
 * the messages were queued. A failure (the session closed) goes to onError
 * once per message and never throws out of push or send.
 */
export class Outbox {
  /**
   * @param {object} o
   * @param {{sendJsonText: Function, sendChunk: Function}} o.session  an open protocol.js session
   * @param {(frame: Uint8Array) => void} o.write  puts one sealed frame on the wire
   * @param {number} [o.flushMs]
   * @param {number} [o.batchBytes]
   * @param {(e: Error) => void} [o.onError]
   */
  constructor({ session, write, flushMs = FLUSH_MS, batchBytes = BATCH_BYTES, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.session = session;
    this.write = write;
    this.flushMs = flushMs;
    this.batchBytes = Math.min(batchBytes, MAX_JSON_BYTES - 64);
    this.onError = onError;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.items = [];
    this.size = 0;
    this.timer = null;
    this.chain = Promise.resolve();
    this.nextStream = 1;
    this.closed = false;
  }

  /** Queues one event for the next { t: 'evs' } batch. */
  push(ev) {
    if (this.closed) return;
    const json = JSON.stringify(ev);
    if (json === undefined) return;
    const n = utf8Length(json) + 1;
    if (this.items.length && this.size + n > this.batchBytes) this.flush();
    this.items.push(json);
    this.size += n;
    if (this.size >= this.batchBytes) { this.flush(); return; }
    if (!this.timer) this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, this.flushMs);
  }

  /** Sends what is queued now. Resolves once its frames are written. */
  flush() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (!this.items.length) return this.chain;
    const text = `{"t":"evs","list":[${this.items.join(',')}]}`;
    this.items = [];
    this.size = 0;
    return this.sendText(text);
  }

  /** Sends one message (any JSON value) after everything queued before it. */
  send(value) {
    this.flush();
    return this.sendText(JSON.stringify(value));
  }

  /** Stops sending: later pushes are dropped, queued ones too. */
  close() {
    this.closed = true;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    this.items = [];
  }

  sendText(text) {
    if (this.closed) return this.chain;
    const bytes = te.encode(text);
    const frames = [];
    if (bytes.length <= MAX_JSON_BYTES) {
      frames.push(this.session.sendJsonText(text));
    } else {
      // Too big for one record: announce it, then send its bytes as chunks of one stream.
      const stream = this.nextStream;
      this.nextStream = (this.nextStream % 0xffffffff) + 1;
      frames.push(this.session.sendJsonText(`{"t":"big","stream":${stream},"bytes":${bytes.length}}`));
      for (let o = 0, seq = 0; o < bytes.length; o += MAX_CHUNK_BYTES, seq++) {
        frames.push(this.session.sendChunk({ stream, seq, last: o + MAX_CHUNK_BYTES >= bytes.length, data: bytes.subarray(o, o + MAX_CHUNK_BYTES) }));
      }
    }
    // The session seals in call order; write in the same order.
    for (const f of frames) f.catch(() => {});
    const run = this.chain.then(async () => {
      for (const f of frames) this.write(await f);
    });
    this.chain = run.catch((e) => { this.onError(e); });
    return this.chain;
  }
}

/**
 * The receiving side of one open session: turns the session's 'json' and
 * 'chunk' events back into messages. json(value) and chunk(ev) return the
 * whole message, or null while a big one is still arriving; they throw
 * WireError on anything out of line (the caller closes the channel).
 */
export class Inbox {
  constructor({ maxBytes = MAX_MESSAGE_BYTES, maxStreams = 4 } = {}) {
    this.maxBytes = maxBytes;
    this.maxStreams = maxStreams;
    this.streams = new Map();
  }

  json(value) {
    if (!value || typeof value !== 'object' || value.t !== 'big') return value;
    const { stream, bytes } = value;
    if (!Number.isInteger(stream) || stream < 1 || stream > 0xffffffff) throw new WireError('bad stream id');
    if (!Number.isInteger(bytes) || bytes < 1) throw new WireError('bad message size');
    if (bytes > this.maxBytes) throw new WireError(`message of ${bytes} bytes is over the ${this.maxBytes} byte limit`);
    if (this.streams.has(stream)) throw new WireError('stream id in use');
    if (this.streams.size >= this.maxStreams) throw new WireError('too many messages arriving at once');
    this.streams.set(stream, { bytes, got: 0, seq: 0, parts: [] });
    return null;
  }

  chunk({ stream, seq, last, data }) {
    const s = this.streams.get(stream);
    if (!s) throw new WireError('chunk for a stream that was not announced');
    if (seq !== s.seq) throw new WireError('chunk out of order');
    s.seq += 1;
    s.got += data.length;
    if (s.got > s.bytes) throw new WireError('message longer than announced');
    s.parts.push(data);
    if (!last) return null;
    this.streams.delete(stream);
    if (s.got !== s.bytes) throw new WireError('message shorter than announced');
    const all = new Uint8Array(s.bytes);
    let o = 0;
    for (const p of s.parts) { all.set(p, o); o += p.length; }
    try {
      return JSON.parse(td.decode(all));
    } catch {
      throw new WireError('message does not parse');
    }
  }
}
