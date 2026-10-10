/**
 * link.js: the Apaki phone client's connection to its PC (Track B part 2,
 * 2026-10-09).
 *
 * One WebSocket to the relay's phone side of the PC's room, a PhoneSession
 * (protocol.js) over it, and wire.js messages inside: engine commands out,
 * engine events in. It pairs with a scanned QR (and remembers the result) or
 * reconnects with a saved pairing, and it keeps reconnecting on its own:
 * after a network change, a locked screen, the PC restarting or the PC going
 * offline, with backoff, and at once when the page becomes visible again.
 *
 * States (on.state): connecting, waiting (the relay is up, the PC is not),
 * pairing, sas, handshake, open, offline (retrying), failed (needs the
 * person: a new QR, or this phone was removed).
 */

import { PhoneSession, ProtocolError, RELAY_CLOSE, parseRelayControl, relaySubprotocols, roomUrl } from './protocol.js';
import { Inbox, Outbox } from './wire.js';

const PING_MS = 25_000;
const HANDSHAKE_MS = 20_000;
const BACKOFF_MS = [800, 2_000, 5_000, 10_000, 20_000, 30_000];

/** Alerts that end a pairing for good: the QR has to be shown again. */
const PAIR_FATAL = new Set(['expired', 'used', 'no-offer', 'bad-mac', 'rejected', 'timeout', 'bad-signature', 'bad-commit', 'version']);

export class Link {
  /**
   * @param {object} o
   * @param {{privateKey: CryptoKey, pub: Uint8Array}} o.device  this phone's identity for this PC
   * @param {object} [o.offer]  a scanned QR (to pair)
   * @param {object} [o.pairing]  a saved pairing (to reconnect)
   * @param {string} [o.name]  this phone's name, shown on the PC while pairing
   * @param {object} o.on  callbacks: state(state, info), sas(code), paired(pairing) (may be async),
   *                       open(first), hello(msg), fatal(code, message)
   */
  constructor({ device, offer = null, pairing = null, name = '', on = {} }) {
    this.device = device;
    this.offer = offer;
    this.pairing = pairing;
    this.name = name;
    this.on = on;
    const ref = pairing || offer;
    this.relay = ref.relay;
    this.roomId = ref.roomId;
    this.state = 'idle';
    this.ws = null;
    this.session = null;
    this.outbox = null;
    this.inbox = null;
    this.chain = Promise.resolve();
    this.attempt = 0;
    this.timers = {};
    this.everOpen = false;
    this.pairSent = false;
    this.stopped = false;
    this.hello = null;
    /** Set by the shim: every engine event, and what to do after a reconnect. */
    this.onEvent = null;
    this.onReopen = null;
    this.wake = this.wake.bind(this);
    this.onVisible = () => { if (document.visibilityState === 'visible') this.wake(); };
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.wake);
  }

  get pcName() {
    return this.hello?.pcName || this.pairing?.pcName || this.offer?.name || 'your PC';
  }

  get relayHost() {
    try { return new URL(this.relay).host; } catch { return String(this.relay); }
  }

  setState(state, info = {}) {
    this.state = state;
    this.on.state?.(state, info);
  }

  start() {
    this.dial();
  }

  /** Back to the foreground or online again: reconnect now instead of waiting out the backoff. */
  wake() {
    if (this.stopped) return;
    if (!this.ws) {
      clearTimeout(this.timers.retry);
      this.dial();
    } else {
      this.sendText('ping');
    }
  }

  dial() {
    if (this.stopped || this.ws) return;
    let ws;
    try {
      ws = new WebSocket(roomUrl(this.relay, this.roomId, 'phone'), relaySubprotocols('phone'));
    } catch (e) {
      // The page's Content-Security-Policy allows one relay only.
      this.fatal('blocked', `This page may not connect to ${this.relayHost} (${e.message}).`);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.setState('connecting');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      // The relay wants a message on every socket right away (relay/src/index.js closeWith).
      ws.send('ping');
      clearInterval(this.timers.ping);
      this.timers.ping = setInterval(() => this.sendText('ping'), PING_MS);
    };
    ws.onmessage = (e) => { if (this.ws === ws) this.onFrame(e.data); };
    ws.onclose = (e) => this.gone(ws, e.code);
    ws.onerror = () => { /* a close follows */ };
  }

  sendText(text) {
    try { if (this.ws?.readyState === 1) this.ws.send(text); } catch { /* closing */ }
  }

  sendBinary(frame) {
    try { if (this.ws?.readyState === 1) this.ws.send(frame); } catch { /* closing */ }
  }

  onFrame(data) {
    if (typeof data === 'string') {
      const m = parseRelayControl(data);
      if (!m) return;
      if (m.t === 'ready') {
        if (m.pc) this.handshake();
        else this.setState('waiting');
      } else if (m.t === 'pc') {
        if (m.up) this.handshake();
        else { this.dropSession(); this.setState('waiting'); }
      } else if (m.t === 'bye') {
        const ws = this.ws;
        try { ws?.close(); } catch { /* gone */ }
        this.gone(ws, m.code);
      }
      return;
    }
    const session = this.session;
    if (!session) return;
    const bytes = new Uint8Array(data);
    this.chain = this.chain.then(() => this.receive(session, bytes)).catch((e) => console.warn('apaki link:', e));
  }

  async handshake() {
    if (!this.pairing && this.pairSent) {
      // A QR pairs once: if the PC restarted halfway, the code is spent.
      this.fatal('interrupted');
      return;
    }
    this.dropSession();
    const session = this.pairing
      ? new PhoneSession({ device: this.device, pairing: this.pairing })
      : new PhoneSession({ device: this.device, offer: this.offer, name: this.name });
    this.session = session;
    this.chain = Promise.resolve();
    let first;
    try {
      first = await session.start();
    } catch (e) {
      this.fatal(e instanceof ProtocolError ? e.code : 'internal', e.message);
      return;
    }
    if (this.session !== session) return;
    this.sendBinary(first);
    if (!this.pairing) this.pairSent = true;
    this.setState(this.pairing ? 'handshake' : 'pairing');
    clearTimeout(this.timers.hs);
    this.timers.hs = setTimeout(() => {
      // Waiting for the PC user to compare codes is not a stuck handshake.
      if (this.session === session && !session.isOpen && session.state !== 'pair-approval') this.restart();
    }, HANDSHAKE_MS);
  }

  async receive(session, bytes) {
    if (this.session !== session) return;
    const step = await session.receive(bytes);
    for (const f of step.send) this.sendBinary(f);
    for (const ev of step.events) {
      if (this.session !== session) return;
      if (ev.type === 'sas') { this.setState('sas'); this.on.sas?.(ev.sas); }
      else if (ev.type === 'paired') { this.pairing = ev.pairing; await this.on.paired?.(ev.pairing); this.opened(session); }
      else if (ev.type === 'open') this.opened(session);
      else if (ev.type === 'json') this.message(() => this.inbox.json(ev.value));
      else if (ev.type === 'chunk') this.message(() => this.inbox.chunk(ev));
      else if (ev.type === 'close') this.closedByPc(ev.reason);
      else if (ev.type === 'alert') this.alert(ev.code);
      else if (ev.type === 'error') this.protocolError(ev);
    }
  }

  opened(session) {
    clearTimeout(this.timers.hs);
    this.inbox = new Inbox();
    this.outbox = new Outbox({ session, write: (f) => this.sendBinary(f), onError: (e) => console.warn('apaki link:', e) });
    this.attempt = 0;
    const first = !this.everOpen;
    this.everOpen = true;
    this.setState('open');
    this.on.open?.(first);
    if (!first) this.onReopen?.();
  }

  message(read) {
    let m;
    try {
      m = read();
    } catch {
      this.restart();
      return;
    }
    if (!m) return;
    if (m.t === 'hello') { this.hello = m; this.on.hello?.(m); return; }
    if (m.t === 'evs' && Array.isArray(m.list)) for (const ev of m.list) this.onEvent?.(ev);
  }

  /** The PC closed the channel (authenticated): removed, or phone access turned off. */
  closedByPc(reason) {
    this.dropSession();
    if (/removed/i.test(reason || '')) this.fatal('removed', reason);
    else this.setState('waiting', { reason });
  }

  alert(code) {
    this.dropSession();
    if (code === 'unknown-device') { this.fatal('removed'); return; }
    if (!this.pairing && PAIR_FATAL.has(code)) { this.fatal(code); return; }
    this.restart();
  }

  protocolError(ev) {
    this.dropSession();
    if (ev.code === 'bad-signature') { this.fatal('bad-pc', ev.message); return; }
    if (!this.pairing) { this.fatal(ev.code, ev.message); return; }
    this.restart();
  }

  /** Sends one engine command. Rejects while the PC is not connected. */
  send(cmd) {
    if (this.state !== 'open' || !this.outbox) return Promise.reject(new Error(`Not connected to ${this.pcName} right now. This page reconnects by itself.`));
    return this.outbox.send({ t: 'cmd', cmd });
  }

  restart() {
    const ws = this.ws;
    if (ws) {
      try { ws.close(); } catch { /* gone */ }
      this.gone(ws, 1000);
    } else {
      this.retry();
    }
  }

  gone(ws, code) {
    if (!ws || this.ws !== ws) return;
    this.ws = null;
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.hs);
    this.dropSession();
    if (this.stopped) return;
    if (!this.pairing && this.pairSent) { this.fatal('interrupted'); return; }
    this.retry(code);
  }

  retry(code = null) {
    if (this.stopped) return;
    clearTimeout(this.timers.retry);
    const ms = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.setState('offline', { retryInMs: ms, code, full: code === RELAY_CLOSE.ROOM_FULL });
    this.timers.retry = setTimeout(() => this.dial(), ms);
  }

  dropSession() {
    this.session = null;
    this.outbox?.close();
    this.outbox = null;
    this.inbox = null;
  }

  fatal(code, message = '') {
    this.stopped = true;
    for (const t of Object.values(this.timers)) { clearTimeout(t); clearInterval(t); }
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* gone */ }
    this.dropSession();
    this.setState('failed', { code, message });
    this.on.fatal?.(code, message);
  }

  /** Stops for good (switching PCs, forgetting this one). */
  stop() {
    this.stopped = true;
    for (const t of Object.values(this.timers)) { clearTimeout(t); clearInterval(t); }
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* gone */ }
    this.dropSession();
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.wake);
  }
}
