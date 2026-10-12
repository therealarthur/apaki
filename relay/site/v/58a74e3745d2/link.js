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
 * pairing, sas, handshake, open, offline (retrying), unknown (the PC said it
 * does not know this phone; retrying slowly), phone-wait (the PC is asking
 * its person whether this phone may connect), phone-timeout (nobody did, in
 * time), failed (needs the person: a new QR, or this phone was removed, was
 * blocked or its pairing expired).
 *
 * Staying paired (2026-10-10): only the PC's encrypted close ends a pairing
 * for sure (removed, or expired: the lifetime chosen at Allow ran out). Its
 * "unknown device" alert is plaintext, so anyone on the path could fake it,
 * and a PC can say it for a while for other reasons; the saved pairing is
 * kept, the page says what happened, and the link tries again every few
 * minutes and whenever the page comes back to the front. It is final only
 * when this phone's own expiry (hello's expiresAt) has passed.
 *
 * Relay closes (2026-10-10, relay budget fairness): NO_PC (4404, this
 * room's PC is not connected; the relay drops the phone after 60 s) is the
 * quiet "waiting for your PC" state, tried again after about a minute or at
 * once when the page comes back to the front; BUDGET (4503), IP_SHARE (4504)
 * and ROOM_SHARE (4505) wait about 30 minutes with a reason the page shows
 * (info.budget).
 *
 * From the PC since 2026-10-10 (apaki/SECURITY.md 4.4): hello carries mode
 * ('private' or 'connected') and cap (what this phone may make Claude do);
 * { t: 'mode' } and { t: 'cap' } follow a change (on.mode, on.cap). A held
 * account-link answers { t: 'pending', reqId, timeoutMs } first: request()
 * then waits that long and tells its onPending.
 *
 * Phone keys (2026-10-11, apaki/remote/ENROLL.md, version 2): on an account
 * connection to a PC whose hello lists 'phone-key', the page answers hello
 * with { t: 'via', name, pub, sig }, signed with this phone's key (phonekey.js
 * signVia) over the hello's nonce. The PC holds such a connection until it
 * has decided about this phone, so Link holds its 'open' state too: it stays
 * in 'handshake' until { t: 'phone-ok' }, which is when on.open fires and the
 * app starts. { t: 'phone-wait', timeoutMs } (a PC in Private mode asking its
 * person) is the state 'phone-wait' until phone-ok or a close. A close whose
 * reason starts "This phone was blocked on" ends this Link for good (fatal
 * 'phone-blocked': no reconnecting through the account); "Nobody allowed this
 * phone on ..." is the state 'phone-timeout' (retryNow asks again). A PC
 * without 'phone-key' gets the older { t: 'via', name } and nothing is held.
 * on.phone({ kind: 'wait' | 'ok' | 'timeout' }) tells the page each step.
 * The PC's close frame is followed at once by the relay's bye (its kick) and the socket's close; both wait for
 * the frames before them to be read (afterFrames), or the reason above would be lost.
 */

import { PhoneSession, ProtocolError, RELAY_CLOSE, b64urlDecode, parseRelayControl, relaySubprotocols, roomUrl } from './protocol.js';
import { isBlockedClose, isNotAllowedClose, signVia } from './phonekey.js';
import { Inbox, Outbox } from './wire.js';

const PING_MS = 25_000;
const HANDSHAKE_MS = 20_000;
const BACKOFF_MS = [800, 2_000, 5_000, 10_000, 20_000, 30_000];
/** After "unknown device": the next tries (slow; the page coming back to the front tries at once). */
const UNKNOWN_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
/** The relay dropped this phone because its PC is not connected (NO_PC): look again after about this long. */
const NO_PC_RETRY_MS = 60_000;
/** The relay's day is spent, for everyone or for this address or room: look again after about this long. */
const BUDGET_RETRY_MS = 30 * 60_000;
/** A held request (account-link) may wait at most this long for the PC's person, whatever the PC says. */
const MAX_PENDING_MS = 10 * 60_000;
/** After this phone's signed via, the PC answers phone-ok or phone-wait at once; if neither comes in this long, connect again. */
const PHONE_CHECK_MS = 20_000;

/** Why the relay closed for the rest of the day, by close code (null for any other code). */
export function budgetReason(code) {
  if (code === RELAY_CLOSE.BUDGET) return 'The Apaki relay has used today\'s budget. It takes connections again after 00:00 UTC.';
  if (code === RELAY_CLOSE.IP_SHARE) return 'This phone\'s internet address has used its share of the Apaki relay for today. It works again after 00:00 UTC, or on another network.';
  if (code === RELAY_CLOSE.ROOM_SHARE) return 'This PC\'s connections have used their share of the Apaki relay for today. They work again after 00:00 UTC.';
  return null;
}

/** Alerts that end a pairing for good: the QR has to be shown again. */
const PAIR_FATAL = new Set(['expired', 'used', 'no-offer', 'bad-mac', 'rejected', 'timeout', 'bad-signature', 'bad-commit', 'version']);

export class Link {
  /**
   * @param {object} o
   * @param {{privateKey: CryptoKey, pub: Uint8Array}} o.device  this phone's identity for this PC
   * @param {object} [o.offer]  a scanned QR (to pair)
   * @param {object} [o.pairing]  a saved pairing (to reconnect)
   * @param {string} [o.name]  this phone's name, shown on the PC while pairing
   * @param {string|null} [o.expiresAt]  when the PC said this pairing runs out (saved from an earlier hello)
   * @param {{pub: Uint8Array, sign: Function}|null} [o.phone]  this phone's key (store.getPhoneKey): signs the via and the enroll proof; none: the older via
   * @param {boolean} [o.viaAccount]  this PC came from the account: hold 'open' until the PC has decided about this phone (needs `phone`)
   * @param {object} o.on  callbacks: state(state, info), sas(code), paired(pairing) (may be async),
   *                       open(first), hello(msg), fatal(code, message), unknown({ retryInMs }),
   *                       lifetime(expiresAt) (the PC told this phone its expiry, or a new one),
   *                       phone({ kind: 'wait' | 'ok' | 'timeout', ... }) (the PC deciding about this phone, 2026-10-11)
   */
  constructor({ device, offer = null, pairing = null, name = '', expiresAt = null, phone = null, viaAccount = false, on = {} }) {
    this.device = device;
    this.phone = phone;
    // Held open only with a phone key to sign with; without one the PC (older, or this page's storage failed) is not waited for.
    this.viaAccount = Boolean(viaAccount && phone);
    /** null, 'check' (via sent or about to be) or 'wait' (the PC is asking its person): 'open' is not announced yet. */
    this.phoneGate = null;
    this.offer = offer;
    this.pairing = pairing;
    this.name = name;
    this.expiresAt = expiresAt || null;
    this.unknownAttempt = 0;
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
    ws.onclose = (e) => this.afterFrames(() => this.gone(ws, e.code));
    ws.onerror = () => { /* a close follows */ };
  }

  /**
   * Runs fn once the frames that arrived before it have been read. 2026-10-11 (found by test/apaki-e2e-phone.test.js):
   * the PC sends its encrypted close (BLOCKED, removed, expired, switched to Private) and then asks the relay to kick
   * the phone, so the relay's bye and the socket's close arrive right behind that frame, while it is still being
   * decrypted. gone() drops the session, which threw the PC's reason away and made a blocked phone dial again.
   */
  afterFrames(fn) {
    this.chain = this.chain.then(fn).catch((e) => console.warn('apaki link:', e));
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
        this.afterFrames(() => this.gone(ws, m.code));
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
    this.unknownAttempt = 0;
    // An account connection to a PC with phone keys is held by the PC until it has decided about this phone: wait for phone-ok.
    if (this.viaAccount) { this.holdForPhone(session); return; }
    this.announceOpen();
  }

  /** The channel is usable: state 'open', the page's open handler, and a re-attach of what was open after a reconnect. */
  announceOpen() {
    clearTimeout(this.timers.gate);
    this.phoneGate = null;
    const first = !this.everOpen;
    this.everOpen = true;
    this.setState('open');
    this.on.open?.(first);
    if (!first) this.onReopen?.();
  }

  /** Keeps 'open' back until phone-ok (see the header); connects again if the PC says nothing for PHONE_CHECK_MS. */
  holdForPhone(session = this.session) {
    this.phoneGate = 'check';
    clearTimeout(this.timers.gate);
    this.timers.gate = setTimeout(() => { if (this.phoneGate === 'check' && this.session === session) this.restart(); }, PHONE_CHECK_MS);
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
    if (m.t === 'hello') {
      this.hello = m;
      // When this pairing runs out (null: never); an older PC does not say, and then nothing changes.
      if (Object.hasOwn(m, 'expiresAt')) this.setExpiry(m.expiresAt);
      // Connected as an Apaki account's device: tell the PC which phone this is (ACCOUNTS.md; signed with the phone key, ENROLL.md).
      if (m.asAccount) this.sendVia(m);
      else if (this.phoneGate) this.announceOpen();
      this.on.hello?.(m);
      return;
    }
    // The PC decided about this phone (an account connection, ENROLL.md): in, or asking its person first.
    if (m.t === 'phone-ok') {
      if (this.phoneGate) this.announceOpen();
      this.on.phone?.({ kind: 'ok' });
      return;
    }
    if (m.t === 'phone-wait') {
      const ms = Math.min(MAX_PENDING_MS, Math.max(10_000, Number(m.timeoutMs) || 0));
      const session = this.session;
      this.phoneGate = 'wait';
      clearTimeout(this.timers.gate);
      // The PC closes by itself when nobody answers; this only covers a PC that went quiet.
      this.timers.gate = setTimeout(() => { if (this.phoneGate === 'wait' && this.session === session) this.restart(); }, ms + 15_000);
      this.setState('phone-wait', { timeoutMs: ms });
      this.on.phone?.({ kind: 'wait', timeoutMs: ms });
      return;
    }
    // The PC user changed how long this phone stays paired.
    if (m.t === 'lifetime') { this.setExpiry(m.expiresAt); return; }
    // The PC switched between Private and Connected, or changed what this phone may do (2026-10-10).
    if (m.t === 'mode') {
      if (m.mode !== 'private' && m.mode !== 'connected') return;
      this.hello = { ...(this.hello || {}), mode: m.mode, ...(Array.isArray(m.features) ? { features: m.features } : {}) };
      this.on.mode?.(m.mode);
      return;
    }
    if (m.t === 'cap') {
      if (typeof m.cap !== 'string') return;
      this.hello = { ...(this.hello || {}), cap: m.cap };
      this.on.cap?.(m.cap);
      return;
    }
    if (m.t === 'evs' && Array.isArray(m.list)) for (const ev of m.list) this.onEvent?.(ev);
    if (typeof m.reqId === 'string' && this.replies?.has(m.reqId)) {
      const r = this.replies.get(m.reqId);
      if (r.type === m.t) { this.replies.delete(m.reqId); clearTimeout(r.timer); r.resolve(m); return; }
      // The PC holds this request until its person answers (account-link): wait as long as it says, and say so.
      if (m.t === 'pending') {
        clearTimeout(r.timer);
        const ms = Math.min(MAX_PENDING_MS, Math.max(10_000, Number(m.timeoutMs) || 0)) + 15_000;
        r.timer = setTimeout(() => { this.replies.delete(m.reqId); r.reject(new Error(`Nobody answered on ${this.pcName}.`)); }, ms);
        try { r.onPending?.(m); } catch { /* the page's note only */ }
      }
    }
  }

  /**
   * True when the PC said it understands `feature` (an older Apaki lists none). "op:<name>" asks about a command
   * instead (2026-10-12): the ops the PC accepts from a phone are in its hello (remote-policy.js PHONE_OPS), so the
   * page offers Rename, Ask Claude and the PC browser view only to a PC that has them.
   */
  supports(feature) {
    if (typeof feature === 'string' && feature.startsWith('op:')) return Array.isArray(this.hello?.ops) && this.hello.ops.includes(feature.slice(3));
    return Array.isArray(this.hello?.features) && this.hello.features.includes(feature);
  }

  /**
   * Tells the PC which phone is behind an account connection. With a phone key
   * and a PC that lists 'phone-key' (and a nonce in its hello) it is version 2,
   * { t: 'via', name, pub, sig }, and the connection is held until phone-ok;
   * anything else (an older PC, no key, a key that cannot sign) is the version 1
   * { t: 'via', name } as before, and nothing is held.
   */
  sendVia(hello) {
    const outbox = this.outbox;
    const session = this.session;
    const name = this.name || '';
    const v1 = () => {
      if (name) outbox?.send({ t: 'via', name }).catch(() => {});
      if (this.phoneGate && this.session === session) this.announceOpen();
    };
    if (!(this.phone && this.supports('phone-key') && typeof hello.nonce === 'string')) { v1(); return; }
    if (!this.phoneGate) {
      this.holdForPhone(session);
      // Already announced open (a Link made without viaAccount): hold it again until the PC decides.
      if (this.state === 'open') this.setState('handshake');
    }
    (async () => {
      let via;
      try {
        via = await signVia(this.phone, b64urlDecode(hello.nonce), name || 'Phone');
      } catch (e) {
        console.warn('apaki link: the phone key could not sign, sending the older via:', e?.message || e);
        v1();
        return;
      }
      if (this.session !== session || this.outbox !== outbox) return;
      await outbox.send({ t: 'via', name: via.name, pub: via.pub, sig: via.sig });
    })().catch((e) => console.warn('apaki link:', e));
  }

  /**
   * Sends one message to the PC (not an engine command) and waits for its
   * answer of type `answer` with the same reqId, e.g. account-link ->
   * account-linked. Rejects when not connected or after `timeoutMs`; a
   * { t: 'pending' } from the PC extends the wait to what it says and calls
   * onPending (the PC is asking its person).
   */
  request(msg, answer, timeoutMs = 10_000, { onPending = null } = {}) {
    if (this.state !== 'open' || !this.outbox) return Promise.reject(new Error(`Not connected to ${this.pcName} right now.`));
    this.replies ||= new Map();
    this.reqSeq = (this.reqSeq || 0) + 1;
    const reqId = `q${this.reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.replies.delete(reqId); reject(new Error(`${this.pcName} did not answer. Its Apaki may need an update.`)); }, timeoutMs);
      this.replies.set(reqId, { type: answer, resolve, reject, timer, onPending });
      this.outbox.send({ ...msg, reqId }).catch((e) => { clearTimeout(this.replies.get(reqId)?.timer ?? timer); this.replies.delete(reqId); reject(e); });
    });
  }

  /** Keeps the expiry the PC sent (an ISO time, or null for never) and passes it on. */
  setExpiry(value) {
    const v = typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
    if (v === this.expiresAt) return;
    this.expiresAt = v;
    this.on.lifetime?.(v);
  }

  /** True once the expiry the PC gave this phone has passed. */
  get lapsed() {
    const t = Date.parse(this.expiresAt || '');
    return Number.isFinite(t) && t <= Date.now();
  }

  /** The PC closed the channel (authenticated): removed, its pairing expired, or phone access turned off. */
  closedByPc(reason) {
    this.dropSession();
    // Phone keys (ENROLL.md): blocked here, final for this Link; or nobody at the PC answered in time (the person can ask again).
    if (isBlockedClose(reason)) this.fatal('phone-blocked', reason);
    else if (isNotAllowedClose(reason)) { this.setState('phone-timeout', { reason }); this.on.phone?.({ kind: 'timeout', reason }); }
    else if (/expired/i.test(reason || '')) this.fatal('lapsed', reason);
    else if (/removed/i.test(reason || '')) this.fatal('removed', reason);
    else this.setState('waiting', { reason });
  }

  /**
   * "Unknown device" from the PC, which is a plaintext hint: it may have
   * been removed there, or the PC may not know this phone just now. The
   * pairing stays; try again slowly (and at once when the page is back in
   * front, see wake). The page shows why and offers Forget.
   */
  unknown() {
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.hs);
    clearTimeout(this.timers.retry);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* gone */ }
    this.dropSession();
    const ms = UNKNOWN_RETRY_MS[Math.min(this.unknownAttempt, UNKNOWN_RETRY_MS.length - 1)];
    this.unknownAttempt += 1;
    this.timers.retry = setTimeout(() => this.dial(), ms);
    this.setState('unknown', { retryInMs: ms });
    this.on.unknown?.({ retryInMs: ms });
  }

  alert(code) {
    this.dropSession();
    if (code === 'unknown-device' && this.pairing) {
      // Final only when this phone's own expiry (from the PC, authenticated, earlier) has passed.
      if (this.lapsed) this.fatal('lapsed');
      else this.unknown();
      return;
    }
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

  /** Asks again after phone-timeout (the person tapped Try again): connects anew, and the PC asks its person again. */
  retryNow() {
    if (this.stopped) return;
    this.restart();
  }

  gone(ws, code) {
    if (!ws || this.ws !== ws) return;
    this.ws = null;
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.hs);
    this.dropSession();
    if (this.stopped) return;
    if (!this.pairing && this.pairSent) { this.fatal('interrupted'); return; }
    // The PC is not there (the relay lets a phone wait 60 s): quietly wait for it, no "No connection".
    if (code === RELAY_CLOSE.NO_PC) { this.waitForPc(code); return; }
    // The relay's day is spent (for everyone, this address or this room): say why and wait long.
    if (budgetReason(code)) { this.budgetWait(code); return; }
    this.retry(code);
  }

  /** NO_PC: the "waiting for your PC" state; look again in about a minute (wake, on coming back to the front, at once). */
  waitForPc(code = RELAY_CLOSE.NO_PC) {
    if (this.stopped) return;
    clearTimeout(this.timers.retry);
    const ms = Math.round(NO_PC_RETRY_MS * (0.8 + Math.random() * 0.4));
    this.timers.retry = setTimeout(() => this.dial(), ms);
    this.setState('waiting', { retryInMs: ms, code, quiet: true });
  }

  /** BUDGET, IP_SHARE, ROOM_SHARE: offline with the reason (info.budget), tried again after about 30 minutes. */
  budgetWait(code) {
    if (this.stopped) return;
    clearTimeout(this.timers.retry);
    const ms = Math.round(BUDGET_RETRY_MS * (0.9 + Math.random() * 0.2));
    this.timers.retry = setTimeout(() => this.dial(), ms);
    this.setState('offline', { retryInMs: ms, code, budget: budgetReason(code) });
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
    this.phoneGate = null;
    clearTimeout(this.timers.gate);
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
