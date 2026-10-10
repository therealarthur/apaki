/**
 * remote.js: phone access for the Myrlin Apaki engine (Track B part 2,
 * 2026-10-09; Arthur: "scan this QR code" connects a phone to the Apaki on
 * your PC, the PC does all the work with its own logins, our servers never
 * see credentials or content).
 *
 * When phone access is on, the engine keeps ONE outbound WebSocket to the
 * Apaki relay (relay/ in this repo) and reconnects with backoff. Nothing
 * listens on the PC and no port is opened. Each phone connection the relay
 * announces gets its own PcSession (apaki/remote/protocol.js): pairing with a
 * QR code and a 6-digit code the PC user approves, or a reconnect of a paired
 * phone. Inside the encrypted channel (apaki/remote/wire.js) the phone sends
 * engine commands and gets engine events, so the web client runs Apaki's own
 * UI; remote-policy.js decides which commands it may send and which events
 * it gets.
 *
 * Desktop ops (engine.js forwards them here): remoteStatus, remoteEnable,
 * remoteDisable, remotePairStart, remotePairCancel, remotePairDecision
 * { approve }, remoteDevices, remoteRevoke { deviceId }. Each answers with
 * ev 'remote' (see statusInfo), which is also sent whenever something
 * changes: the relay connection, a phone connecting or leaving, a pairing
 * request with its code and the phone's name.
 *
 * Relay and web client addresses: apaki.myrlin.io for both since
 * 2026-10-10 (one Worker serves the relay and the phone page), or
 * APAKI_RELAY_URL and APAKI_WEB_URL for a copy you run yourself. Before a
 * pairing code is shown, remote-page.js checks that the site serves exactly
 * the phone page this Apaki builds from its own code; the code then opens
 * that version's own address (<web>/v/<version>/).
 *
 * Apaki accounts (2026-10-10, ../remote/ACCOUNTS.md): a paired phone can link
 * its passkey account to this PC ({ t: 'account-link' } inside the channel).
 * The account's device key becomes one more paired device (kind 'account'),
 * so any phone signed in to that account reconnects as it; { t: 'via' } says
 * which phone that is. The server never holds a key that opens any of it.
 *
 * Idle cost: one "ping" text every 25 s while on; nothing while off.
 */

import os from 'node:os';
import {
  LIMITS, PcSession, RELAY_CLOSE, checkRelayUrl, createPairingOffer, createPcIdentity, createRoom, decodePcFrame,
  encodePcFrame, exportIdentity, frameType, importIdentity, parseRelayControl, relaySubprotocols, roomIdForToken, roomUrl,
  b64urlDecode, b64urlEncode, deviceIdFor, randomBytes,
} from '../remote/protocol.js';
import { Inbox, Outbox, WIRE_VERSION } from '../remote/wire.js';
import { BROADCAST_EVENTS, PHONE_OPS, checkPhoneCommand, hashText, parsePhoneId, phoneView, routeEvent } from './remote-policy.js';
import * as store from './remote-store.js';
import { checkPage, pageText } from './remote-page.js';

/** Placeholders on the reserved .invalid domain (never resolves): what tests and "not set up" use. */
export const RELAY_PLACEHOLDER = 'wss://relay.apaki.invalid';
export const WEB_PLACEHOLDER = 'https://apaki.invalid/';
/** The hosted relay and phone page (one Cloudflare Worker, relay/), live since 2026-10-10. */
export const RELAY_DEFAULT = 'wss://apaki.myrlin.io';
export const WEB_DEFAULT = 'https://apaki.myrlin.io/';
export const relayUrl = (env = process.env) => env.APAKI_RELAY_URL || RELAY_DEFAULT;
export const webUrl = (env = process.env) => env.APAKI_WEB_URL || WEB_DEFAULT;
/** A page check this recent is reused for the next pairing code. */
const PAGE_CHECK_MS = 10 * 60_000;
/** At most this many Apaki accounts linked to one PC (ACCOUNTS.md). */
const MAX_ACCOUNT_DEVICES = 8;

/** True for an address that is a placeholder (or not an address at all). */
export function isPlaceholder(url) {
  try { return new URL(url).hostname.endsWith('.invalid'); } catch { return true; }
}

const PING_MS = 25_000;
const PONG_TIMEOUT_MS = 70_000;
const HANDSHAKE_MS = 30_000;
const APPROVAL_MS = LIMITS.PAIR_APPROVE_MS + 5_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const REPLACED_RETRY_MS = 5 * 60_000;
const BUDGET_RETRY_MS = 30 * 60_000;
const STABLE_MS = 30_000;
/** A phone that went away keeps its conversations this long, so a network change or a locked screen does not stop them. */
const PANE_GRACE_MS = 15 * 60_000;
const MEANING_EVERY_MS = 2_000;
const MAX_PHONE_MESSAGE = 16 * 1024 * 1024;

/** Friendlier refusals for ops the desktop UI sends that a phone may not. */
const REFUSED = {
  billing: 'Billing is chosen on the PC.',
  billingOptions: 'Billing is chosen on the PC.',
  folder: 'Folders are arranged on the PC.',
  transcribe: 'Dictation here uses your phone keyboard\'s microphone.',
  askSearch: 'Ask Claude runs from the PC.',
  digPrompt: 'Dig deeper runs from the PC.',
};

const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url || ''); } };
const unref = (t) => { t?.unref?.(); return t; };

export function createRemote(o) {
  return new RemoteBridge(o);
}

export class RemoteBridge {
  /**
   * @param {object} o
   * @param {(ev: object) => void} o.emit  sends an event to the desktop window
   * @param {(cmd: object) => any} o.dispatch  runs an engine command (already checked and rewritten)
   * @param {() => object} o.readyEvent  the engine's 'ready' event, sent to a phone when it connects
   * @param {object} [o.engine]  what the policy needs to know about panes:
   *   paneExists(id), paneCount(deviceId), phonePanes(deviceId) -> ids, paneInfo(id) -> { sessionId, running, busy },
   *   askPane(askId), knownCwd(cwd), phoneSessions(deviceId), hasOp(op)
   * @param {string} [o.dir]  where state.json and secret.json live
   * @param {Function} [o.WebSocket]  WebSocket class (tests pass a fake)
   * @param {string} [o.relay] @param {string} [o.web] @param {string} [o.pcName]
   * @param {(line: string) => void} [o.log]
   */
  constructor(o) {
    this.emit = o.emit;
    this.dispatch = o.dispatch;
    this.readyEvent = o.readyEvent || (() => ({ ev: 'ready' }));
    this.engine = o.engine || {};
    this.dir = o.dir || store.remoteDir();
    this.WS = o.WebSocket || globalThis.WebSocket;
    this.relay = o.relay || relayUrl();
    this.web = o.web || webUrl();
    this.pcName = String(o.pcName || os.hostname() || 'PC').slice(0, 60);
    // The phone page check (remote-page.js); tests pass false (no check, the code opens <web>) or their own.
    this.pageCheck = o.pageCheck === false ? null : (o.pageCheck || ((a) => checkPage(a)));
    this.page = null;
    this.log = o.log || ((line) => process.stderr.write(`apaki remote: ${line}\n`));
    // Timings (tests shorten them).
    this.handshakeMs = o.handshakeMs ?? HANDSHAKE_MS;
    this.graceMs = o.graceMs ?? PANE_GRACE_MS;

    this.state = store.loadState(this.dir);
    this.secret = null;
    this.identity = null;
    this.scheme = null;
    this.ws = null;
    this.status = 'off';
    this.error = null;
    this.retryAt = null;
    this.attempt = 0;
    this.byeCode = null;
    this.conns = new Map();
    this.offer = null;
    this.offerTimer = null;
    this.request = null;
    this.cache = new Map();
    this.graceTimers = new Map();
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.ready = this.init();
  }

  async init() {
    if (!this.state.enabled) return;
    try {
      await this.loadKeys({ create: false });
      this.connect();
    } catch (e) {
      this.fail(e);
    }
  }

  /* ---------- keys and saved state ---------- */

  /** Loads this PC's identity and room (creating them when asked). */
  async loadKeys({ create }) {
    if (this.identity) return true;
    let secret = await store.loadSecret(this.dir);
    if (secret && (!this.state.roomId || (await roomIdForToken(secret.token).catch(() => null)) !== this.state.roomId)) secret = null;
    if (!secret) {
      if (!create) throw new Error('Phone access has no keys yet; turn it on again to make them.');
      const identity = await createPcIdentity();
      const room = await createRoom();
      secret = { identity: await exportIdentity(identity), token: room.token, psks: {} };
      this.state = { ...this.state, roomId: room.roomId, pcPub: secret.identity.pub, createdAt: new Date().toISOString(), devices: [] };
      this.scheme = await store.saveSecret(secret, this.dir);
      store.saveState(this.state, this.dir);
    } else {
      this.scheme = secret.scheme;
    }
    this.secret = secret;
    this.identity = await importIdentity(secret.identity);
    return true;
  }

  /** A paired device as PcSession wants it, or null (unknown or removed). */
  getDevice(id) {
    const d = this.state.devices.find((x) => x.id === id);
    const psk = this.secret?.psks?.[id];
    return d && psk ? { id: d.id, pub: d.pub, psk, name: d.name, pairedAt: d.pairedAt } : null;
  }

  async addDevice(device) {
    const rec = { id: device.id, pub: device.pub, name: String(device.name || 'Phone').slice(0, 64), pairedAt: device.pairedAt, lastSeen: new Date().toISOString() };
    // An Apaki account's device (ACCOUNTS.md): which phone linked it, and the account's name.
    if (device.kind === 'account') Object.assign(rec, { kind: 'account', account: String(device.account || '').slice(0, 48), by: String(device.by || '').slice(0, 64) });
    this.state.devices = [...this.state.devices.filter((d) => d.id !== rec.id), rec];
    this.secret.psks = { ...this.secret.psks, [rec.id]: device.psk };
    this.scheme = await store.saveSecret(this.secret, this.dir);
    store.saveState(this.state, this.dir);
    return rec;
  }

  touchDevice(id) {
    const d = this.state.devices.find((x) => x.id === id);
    if (!d) return;
    d.lastSeen = new Date().toISOString();
    try { store.saveState(this.state, this.dir); } catch (e) { this.log(`saving state: ${e.message}`); }
  }

  /* ---------- the relay connection ---------- */

  connect() {
    if (!this.state.enabled || this.ws || !this.identity) return;
    if (isPlaceholder(this.relay)) { this.setStatus('unconfigured'); return; }
    let url;
    try { url = roomUrl(this.relay, this.state.roomId, 'pc'); } catch (e) { this.setStatus('error', `The relay address is not usable: ${e.message}`); return; }
    let ws;
    try {
      ws = new this.WS(url, relaySubprotocols('pc', this.secret.token));
    } catch (e) {
      this.scheduleReconnect(e.message);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.lastPong = Date.now();
    this.setStatus('connecting');
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      // The relay needs a message on every socket (see relay/src/index.js closeWith).
      this.sendText('ping');
      clearInterval(this.pingTimer);
      this.pingTimer = unref(setInterval(() => this.ping(ws), PING_MS));
    });
    ws.addEventListener('message', (e) => { if (this.ws === ws) this.onRelay(e.data); });
    ws.addEventListener('close', (e) => this.socketGone(ws, e.code));
    ws.addEventListener('error', () => { /* a close follows */ });
  }

  ping(ws) {
    if (this.ws !== ws) return;
    if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) {
      // Half-dead connection (sleep, network change): start over.
      try { ws.close(); } catch { /* gone */ }
      this.socketGone(ws, 1006);
      return;
    }
    this.sendText('ping');
  }

  sendText(text) {
    try { if (this.ws?.readyState === 1) this.ws.send(text); } catch { /* closing */ }
  }

  toRelay(conn, frame) {
    try { if (this.ws?.readyState === 1) this.ws.send(encodePcFrame(conn, frame)); } catch { /* closing */ }
  }

  kick(conn) {
    this.sendText(JSON.stringify({ t: 'kick', conn }));
  }

  onRelay(data) {
    if (typeof data === 'string') {
      const m = parseRelayControl(data);
      if (!m) return;
      if (m.t === 'pong') { this.lastPong = Date.now(); return; }
      this.lastPong = Date.now();
      if (m.t === 'ready') {
        this.connectedAt = Date.now();
        this.setStatus('online');
        for (const conn of Array.isArray(m.phones) ? m.phones : []) if (Number.isInteger(conn)) this.newConn(conn);
      } else if (m.t === 'join' && Number.isInteger(m.conn)) {
        this.dropConn(m.conn);
        this.newConn(m.conn);
      } else if (m.t === 'leave' && Number.isInteger(m.conn)) {
        this.dropConn(m.conn);
      } else if (m.t === 'bye') {
        this.byeCode = m.code;
        const ws = this.ws;
        try { ws?.close(); } catch { /* gone */ }
        this.socketGone(ws, m.code);
      }
      return;
    }
    let f;
    try { f = decodePcFrame(data); } catch { return; }
    this.lastPong = Date.now();
    const c = this.conns.get(f.connId) || this.newConn(f.connId);
    c.chain = c.chain.then(() => this.onFrame(c, f.payload)).catch((e) => this.log(`frame from ${c.id}: ${e.message}`));
  }

  /** The relay socket closed (or was given up): every phone connection on it is gone. */
  socketGone(ws, code) {
    if (!ws || this.ws !== ws) return;
    this.ws = null;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    const devices = new Set();
    for (const c of this.conns.values()) {
      clearTimeout(c.timer);
      c.outbox?.close();
      if (c.open && c.device) devices.add(c.device.id);
    }
    this.conns.clear();
    this.request = null;
    for (const id of devices) this.afterLeave(id);
    if (!this.state.enabled) { this.setStatus('off'); return; }
    const replaced = this.byeCode === RELAY_CLOSE.REPLACED || code === RELAY_CLOSE.REPLACED;
    const budget = this.byeCode === RELAY_CLOSE.BUDGET || code === RELAY_CLOSE.BUDGET;
    this.byeCode = null;
    if (this.connectedAt && Date.now() - this.connectedAt > STABLE_MS) this.attempt = 0;
    this.connectedAt = null;
    if (replaced) this.scheduleReconnect('Another Apaki took this PC\'s relay connection; trying again in a few minutes.', REPLACED_RETRY_MS, 'replaced');
    // The hosted relay spent its daily budget: wait instead of knocking every minute.
    else if (budget) this.scheduleReconnect('The Apaki relay has used today\'s budget; it takes connections again after 00:00 UTC. Trying again every 30 minutes.', BUDGET_RETRY_MS);
    else this.scheduleReconnect(null);
  }

  scheduleReconnect(error, delay = null, status = 'offline') {
    if (this.reconnectTimer || !this.state.enabled) return;
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    const ms = delay ?? Math.round(base * (0.8 + Math.random() * 0.4));
    this.retryAt = Date.now() + ms;
    this.reconnectTimer = unref(setTimeout(() => {
      this.reconnectTimer = null;
      this.retryAt = null;
      this.connect();
    }, ms));
    this.setStatus(status, error);
  }

  closeSocket() {
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.retryAt = null;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000, 'phone access off'); } catch { /* gone */ }
  }

  /* ---------- phone connections ---------- */

  newConn(id) {
    const c = { id, session: null, device: null, open: false, inbox: null, outbox: null, chain: Promise.resolve(), timer: null, sessionsHash: null, lastMeaning: 0 };
    c.session = this.newSession();
    c.timer = unref(setTimeout(() => this.handshakeTimeout(c), this.handshakeMs));
    this.conns.set(id, c);
    return c;
  }

  newSession() {
    return new PcSession({ identity: this.identity, roomId: this.state.roomId, getOffer: () => this.offer, getDevice: (id) => this.getDevice(id) });
  }

  /** A phone that connects but never completes a handshake is dropped. */
  handshakeTimeout(c) {
    if (this.conns.get(c.id) !== c || c.open) return;
    this.kick(c.id);
    this.dropConn(c.id);
  }

  dropConn(id) {
    const c = this.conns.get(id);
    if (!c) return;
    this.conns.delete(id);
    clearTimeout(c.timer);
    c.outbox?.close();
    let changed = false;
    if (this.request?.conn === id) { this.request = null; changed = true; }
    if (c.open && c.device) { this.afterLeave(c.device.id); changed = true; }
    if (changed) this.pushStatus();
  }

  async onFrame(c, payload) {
    if (this.conns.get(c.id) !== c) return;
    if (c.session.state === 'closed') {
      // A phone may start over on the same connection (after { t: 'pc', up }).
      const t = frameType(payload);
      if (t !== 'pair1' && t !== 'hello1') return;
      c.session = this.newSession();
      c.open = false;
      c.outbox?.close();
      c.outbox = null;
      c.sessionsHash = null;
      clearTimeout(c.timer);
      c.timer = unref(setTimeout(() => this.handshakeTimeout(c), this.handshakeMs));
    }
    const step = await c.session.receive(payload);
    for (const f of step.send) this.toRelay(c.id, f);
    for (const ev of step.events) {
      if (ev.type === 'pair-request') this.pairRequest(c, ev);
      else if (ev.type === 'open') this.opened(c, ev.device);
      else if (ev.type === 'json') this.onMessage(c, () => c.inbox.json(ev.value));
      else if (ev.type === 'chunk') this.onMessage(c, () => c.inbox.chunk(ev));
      else if (ev.type === 'close' || ev.type === 'alert' || ev.type === 'error') this.ended(c, ev);
    }
  }

  pairRequest(c, ev) {
    // The QR is spent once a phone proved it holds it; only that phone can be approved.
    this.clearOffer({ quiet: true });
    this.request = { conn: c.id, sas: ev.sas, device: { id: ev.device.id, name: ev.device.name } };
    clearTimeout(c.timer);
    c.timer = unref(setTimeout(() => this.handshakeTimeout(c), APPROVAL_MS));
    this.pushStatus({ requested: true });
  }

  /** The channel to a phone is open (a reconnect, or a pairing just approved). */
  opened(c, device) {
    clearTimeout(c.timer);
    c.timer = null;
    c.device = { id: device.id, name: device.name };
    c.open = true;
    c.inbox = new Inbox({ maxBytes: MAX_PHONE_MESSAGE });
    c.outbox = new Outbox({ session: c.session, write: (f) => this.toRelay(c.id, f), onError: (e) => this.log(`to ${c.id}: ${e.message}`) });
    this.cancelGrace(device.id);
    this.touchDevice(device.id);
    // features: what this PC understands beyond commands (an older Apaki sends none).
    const self = this.state.devices.find((d) => d.id === device.id);
    c.outbox.send({ t: 'hello', v: WIRE_VERSION, pcName: this.pcName, ops: this.phoneOps(), features: ['account'], ...(self?.kind === 'account' ? { asAccount: true } : {}) });
    c.outbox.push(phoneView(this.readyEvent()));
    for (const ev of this.cache.values()) c.outbox.push(phoneView(ev));
    this.pushStatus();
  }

  ended(c, ev) {
    const was = c.open;
    c.open = false;
    c.outbox?.close();
    if (ev.type === 'error') this.log(`phone connection ${c.id}: ${ev.code} (${ev.message})`);
    let changed = false;
    if (this.request?.conn === c.id) { this.request = null; changed = true; }
    if (was && c.device) { this.afterLeave(c.device.id); changed = true; }
    if (changed) this.pushStatus();
  }

  onMessage(c, read) {
    if (!c.open) return;
    let msg;
    try {
      msg = read();
    } catch (e) {
      this.log(`phone ${c.id} sent a bad message: ${e.message}`);
      this.closeConn(c, 'bad message');
      return;
    }
    if (msg && msg.t === 'cmd') this.command(c, msg.cmd);
    else if (msg && msg.t === 'account-link') this.accountLink(c, msg).catch((e) => this.log(`account link: ${e.message}`));
    else if (msg && msg.t === 'account-unlink') this.accountUnlink(c, msg).catch((e) => this.log(`account unlink: ${e.message}`));
    else if (msg && msg.t === 'via') {
      // Which phone is behind an account device's connection, for the Phone sheet.
      c.via = String(msg.name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 64);
      this.pushStatus();
    }
  }

  /* ---------- Apaki accounts (apaki/remote/ACCOUNTS.md) ---------- */

  /**
   * A paired phone links its Apaki account to this PC: the account's device
   * key becomes one more paired device (kind 'account') with a fresh psk,
   * which the phone puts in the account's encrypted vault. Any phone signed
   * in to that account can then reconnect as it. The phone is already
   * trusted (it holds a paired device key), so this needs no new approval;
   * the Phone sheet shows the account and who linked it, and Remove cuts
   * every account phone off at once.
   */
  async accountLink(c, msg) {
    const reqId = String(msg.reqId || '').slice(0, 40);
    const answer = (v) => c.outbox?.send({ t: 'account-linked', reqId, ...v });
    try {
      const raw = b64urlDecode(String(msg.pub || ''));
      if (raw.length !== 65 || raw[0] !== 4) throw new Error('that is not an account key');
      await globalThis.crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const id = await deviceIdFor(raw);
      if (id === c.device.id) throw new Error('a device cannot link itself');
      const others = this.state.devices.filter((d) => d.kind === 'account' && d.id !== id);
      if (others.length >= MAX_ACCOUNT_DEVICES) throw new Error(`this PC already has ${MAX_ACCOUNT_DEVICES} Apaki accounts linked; remove one in its Phone sheet first`);
      const account = String(msg.name || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Apaki account';
      const psk = b64urlEncode(randomBytes(32));
      const by = this.state.devices.find((d) => d.id === c.device.id)?.name || c.device.name || 'a phone';
      await this.addDevice({ id, pub: b64urlEncode(raw), name: `Apaki account (${account})`, kind: 'account', account, by, psk, pairedAt: new Date().toISOString() });
      answer({ deviceId: id, psk, pcName: this.pcName });
      this.log(`${by} linked the Apaki account "${account}"`);
      this.pushStatus();
    } catch (e) {
      answer({ error: e.message || String(e) });
    }
  }

  /** A phone takes this PC out of its account: only an account device can be removed this way. */
  async accountUnlink(c, msg) {
    const reqId = String(msg.reqId || '').slice(0, 40);
    const id = String(msg.deviceId || '');
    const d = this.state.devices.find((x) => x.id === id);
    if (!d || d.kind !== 'account') { c.outbox?.send({ t: 'account-unlinked', reqId, error: 'that is not an account linked to this PC' }); return; }
    c.outbox?.send({ t: 'account-unlinked', reqId, ok: true });
    await this.revoke(id);
    this.pushStatus();
  }

  async closeConn(c, reason) {
    const f = await c.session.close(reason).catch(() => null);
    if (f) this.toRelay(c.id, f);
    this.kick(c.id);
    this.dropConn(c.id);
  }

  phoneOps() {
    return PHONE_OPS.filter((op) => op !== 'artifactGet' || this.engine.hasOp?.(op));
  }

  /** One command from a phone: checked, rewritten into the phone's namespace, run. */
  command(c, cmd) {
    const deviceId = c.device.id;
    const e = this.engine;
    const r = checkPhoneCommand(cmd, {
      deviceId,
      hasOp: e.hasOp,
      paneExists: e.paneExists,
      paneCount: e.paneCount,
      askPane: e.askPane,
      knownCwd: e.knownCwd,
      phoneSessions: e.phoneSessions,
    });
    if (!r.ok) {
      const message = typeof cmd?.op === 'string' && Object.hasOwn(REFUSED, cmd.op) ? REFUSED[cmd.op] : r.error;
      c.outbox.push({ ev: 'error', reqId: r.reqId, paneId: r.paneId, message, refused: true });
      return;
    }
    let out = r.cmd;
    // The phone's page restores its panes with open (warm: false) after a
    // reload; a pane still open in the engine re-attaches instead, so a turn
    // that is running keeps running.
    if (out.op === 'open' && out.warm === false && !out.force && out.sessionId) {
      const info = e.paneInfo?.(out.paneId);
      if (info?.running && info.sessionId === out.sessionId) out = { op: 'attach', reqId: out.reqId, paneId: out.paneId, sessionId: out.sessionId, cwd: out.cwd };
    }
    this.dispatch(out);
  }

  /* ---------- events to phones ---------- */

  /**
   * Called by engine.emit for every event. Returns true when the event
   * belongs to a phone (it went there and the desktop must not get it).
   */
  route(ev) {
    const r = routeEvent(ev);
    if (r) {
      this.toDevice(r.deviceId, phoneView(r.ev));
      // The desktop's Phone sheet counts each phone's open conversations.
      if (ev.ev === 'opened' || ev.ev === 'closed') this.panesChanged();
      return true;
    }
    if (ev && BROADCAST_EVENTS.has(ev.ev)) {
      this.cache.set(ev.ev, ev);
      this.broadcast(ev);
    }
    return false;
  }

  toDevice(deviceId, ev) {
    for (const c of this.conns.values()) {
      if (!c.open || c.device?.id !== deviceId) continue;
      if (ev.ev === 'sessions') {
        // The window asks for the list every 15 s; send it only when it changed.
        const h = hashText(JSON.stringify([ev.items, ev.folders, ev.billing]));
        if (h === c.sessionsHash) continue;
        c.sessionsHash = h;
      }
      c.outbox.push(ev);
    }
  }

  broadcast(ev) {
    const now = Date.now();
    for (const c of this.conns.values()) {
      if (!c.open) continue;
      if (ev.ev === 'meaning' && ev.stage === 'embedding') {
        if (now - c.lastMeaning < MEANING_EVERY_MS) continue;
        c.lastMeaning = now;
      }
      c.outbox.push(phoneView(ev));
    }
  }

  /** A phone opened or closed a pane: tell the desktop once things settle. */
  panesChanged() {
    clearTimeout(this.panesTimer);
    this.panesTimer = unref(setTimeout(() => { this.panesTimer = null; this.pushStatus(); }, 300));
  }

  /** The name of the phone a pane belongs to, or null for a desktop pane. */
  windowName(paneId) {
    const p = parsePhoneId(paneId);
    if (!p) return null;
    return this.state.devices.find((d) => d.id === p.deviceId)?.name || 'Phone';
  }

  /* ---------- a phone's conversations when it goes away ---------- */

  afterLeave(deviceId) {
    for (const c of this.conns.values()) if (c.open && c.device?.id === deviceId) return;
    if (this.graceTimers.has(deviceId)) return;
    this.graceTimers.set(deviceId, unref(setTimeout(() => {
      this.graceTimers.delete(deviceId);
      // Conversations still working finish first; check again later.
      if (this.closePhonePanes(deviceId, { idleOnly: true })) this.afterLeave(deviceId);
    }, this.graceMs)));
  }

  cancelGrace(deviceId) {
    clearTimeout(this.graceTimers.get(deviceId));
    this.graceTimers.delete(deviceId);
  }

  /** Closes a phone's panes (their Claude Code processes stop, locks are freed). Returns how many were left running. */
  closePhonePanes(deviceId, { idleOnly = false } = {}) {
    let left = 0;
    for (const paneId of this.engine.phonePanes?.(deviceId) || []) {
      const busy = Boolean(this.engine.paneInfo?.(paneId)?.busy);
      if (busy && idleOnly) { left += 1; continue; }
      if (busy) this.dispatch({ op: 'interrupt', paneId });
      this.dispatch({ op: 'close', paneId });
    }
    return left;
  }

  /* ---------- desktop ops ---------- */

  async op(c) {
    let error = null;
    try {
      switch (c.op) {
        case 'remoteEnable': await this.enable(); break;
        case 'remoteDisable': await this.disable(); break;
        case 'remotePairStart': await this.pairStart(); break;
        case 'remotePairCancel': this.clearOffer({ quiet: true }); break;
        case 'remotePairDecision': await this.decide(c.approve === true); break;
        case 'remoteRevoke': await this.revoke(String(c.deviceId || '')); break;
        default: break; // remoteStatus, remoteDevices: the status below
      }
    } catch (e) {
      error = e.message || String(e);
      this.log(`${c.op}: ${error}`);
    }
    this.pushStatus({ reqId: c.reqId, ...(error ? { opError: error } : {}) });
  }

  async enable() {
    await this.loadKeys({ create: true });
    if (!this.state.enabled) {
      this.state.enabled = true;
      store.saveState(this.state, this.dir);
    }
    this.error = null;
    this.connect();
    if (isPlaceholder(this.relay)) this.setStatus('unconfigured');
  }

  async disable() {
    this.state.enabled = false;
    store.saveState(this.state, this.dir);
    this.clearOffer({ quiet: true });
    this.request = null;
    for (const c of [...this.conns.values()]) {
      if (!c.open) continue;
      const f = await c.session.close('Phone access was turned off on the PC.').catch(() => null);
      if (f) this.toRelay(c.id, f);
    }
    for (const c of this.conns.values()) { clearTimeout(c.timer); c.outbox?.close(); }
    this.conns.clear();
    this.closeSocket();
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const d of this.state.devices) this.closePhonePanes(d.id);
    this.setStatus('off');
  }

  async pairStart() {
    if (isPlaceholder(this.relay)) throw new Error('The Apaki relay is not set up yet, so a phone could not reach this PC.');
    if (!this.state.enabled) await this.enable();
    if (this.request) throw new Error('A phone is waiting for your answer; allow or deny it first.');
    let web = this.web;
    if (this.pageCheck) {
      const page = await this.checkedPage();
      if (page.state === 'differs' || page.state === 'missing') { this.pushStatus(); throw new Error(pageText(page)); }
      // Unreachable from here: a phone may still reach it, and the code opens the version this Apaki checks.
      if (page.url) web = page.url;
    }
    this.offer = createPairingOffer({ identity: this.identity, relay: checkRelayUrl(this.relay), roomId: this.state.roomId, name: this.pcName, web });
    clearTimeout(this.offerTimer);
    const offer = this.offer;
    this.offerTimer = unref(setTimeout(() => {
      this.offerTimer = null;
      if (this.offer === offer) { this.offer = null; this.pushStatus(); }
    }, Math.max(1000, offer.exp * 1000 - Date.now() + 500)));
  }

  /** The last phone page check, run again when it is old or was not a match. */
  async checkedPage() {
    const p = this.page;
    if (p && p.state === 'ok' && Date.now() - p.at < PAGE_CHECK_MS) return p;
    this.page = { state: 'checking', at: Date.now() };
    this.pushStatus();
    try { this.page = await this.pageCheck({ web: this.web, relay: this.relay }); } catch (e) { this.page = { state: 'unreachable', error: e.message, at: Date.now() }; }
    this.pushStatus();
    return this.page;
  }

  clearOffer({ quiet = false } = {}) {
    clearTimeout(this.offerTimer);
    this.offerTimer = null;
    const had = Boolean(this.offer);
    this.offer = null;
    if (had && !quiet) this.pushStatus();
  }

  async decide(approve) {
    const r = this.request;
    if (!r) return;
    this.request = null;
    const c = this.conns.get(r.conn);
    if (!c || c.session.state !== 'pair-approval') return;
    const step = approve ? await c.session.approve() : await c.session.reject();
    for (const f of step.send) this.toRelay(c.id, f);
    if (approve && step.device) {
      const rec = await this.addDevice(step.device);
      this.opened(c, rec);
      this.pushStatus({ paired: { id: rec.id, name: rec.name } });
      return;
    }
    // Rejected, or approved too late: the phone was told; free its relay slot.
    unref(setTimeout(() => { this.kick(c.id); this.dropConn(c.id); }, 1500));
    if (approve) throw new Error('That phone waited too long; show a new code and pair again.');
  }

  /** Removes a phone: its record and secret go, it is disconnected now and can never reconnect. */
  async revoke(deviceId) {
    const had = this.state.devices.some((d) => d.id === deviceId);
    if (!had) return;
    this.state.devices = this.state.devices.filter((d) => d.id !== deviceId);
    if (this.secret) {
      const { [deviceId]: _gone, ...psks } = this.secret.psks || {};
      this.secret.psks = psks;
      this.scheme = await store.saveSecret(this.secret, this.dir);
    }
    store.saveState(this.state, this.dir);
    for (const c of [...this.conns.values()]) {
      if (c.device?.id !== deviceId) continue;
      if (c.open) {
        const f = await c.session.close('This phone was removed on the PC.').catch(() => null);
        if (f) this.toRelay(c.id, f);
      }
      this.kick(c.id);
      this.dropConn(c.id);
    }
    this.cancelGrace(deviceId);
    this.closePhonePanes(deviceId);
  }

  /* ---------- status ---------- */

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.pushStatus();
  }

  fail(e) {
    this.setStatus('error', `Phone access could not start: ${e.message || e}`);
  }

  statusInfo() {
    const connected = new Set();
    const via = new Map(); // account device id -> the phones connected through it now
    for (const c of this.conns.values()) {
      if (!c.open || !c.device) continue;
      connected.add(c.device.id);
      if (c.via) via.set(c.device.id, [...(via.get(c.device.id) || []), c.via]);
    }
    return {
      ev: 'remote',
      enabled: this.state.enabled,
      state: this.status,
      error: this.error,
      retryInMs: this.retryAt ? Math.max(0, this.retryAt - Date.now()) : null,
      relay: hostOf(this.relay),
      relayConfigured: !isPlaceholder(this.relay),
      web: this.web,
      // The phone page check, for the Phone sheet (state, version, what it says).
      page: this.page ? { state: this.page.state, version: this.page.version || null, url: this.page.url || null, at: this.page.at, text: this.page.state === 'checking' ? 'Checking the phone page…' : pageText(this.page) } : null,
      pcName: this.pcName,
      protection: this.scheme === 'dpapi-user' ? 'dpapi' : this.scheme ? 'file' : null,
      devices: this.state.devices.map((d) => ({
        id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen, connected: connected.has(d.id), panes: (this.engine.phonePanes?.(d.id) || []).length,
        ...(d.kind === 'account' ? { kind: 'account', account: d.account || '', by: d.by || '', via: via.get(d.id) || [] } : {}),
      })),
      // The QR address holds the one-time secret: it goes to the desktop window only.
      pairing: this.offer && !this.offer.used ? { url: this.offer.url, exp: this.offer.exp } : null,
      request: this.request ? { sas: this.request.sas, name: this.request.device.name, id: this.request.device.id } : null,
    };
  }

  pushStatus(extra = {}) {
    this.emit({ ...this.statusInfo(), ...extra });
  }

  /** Stops everything (the engine is exiting). */
  stop() {
    this.closeSocket();
    clearTimeout(this.offerTimer);
    clearTimeout(this.panesTimer);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    for (const c of this.conns.values()) clearTimeout(c.timer);
  }
}
