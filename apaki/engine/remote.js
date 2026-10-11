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
 * { approve, lifetime? }, remoteDevices, remoteRevoke { deviceId },
 * remoteDeviceLifetime { deviceId, lifetime } and remoteReset (2026-10-10,
 * see below). Each answers with
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
 *
 * A paired phone stays paired (2026-10-10, Arthur: "the paired phone should
 * be good to go foreeever"). Nothing but Remove, or a lifetime the user
 * chose, ends a pairing:
 *   - loadKeys never makes new keys while a secret.json exists. One that
 *     cannot be opened is an error (Start over in the Phone sheet sets the
 *     files aside, renamed, when the user wants new keys); a state.json that
 *     does not match the keys (missing, damaged, another room) is rebuilt
 *     from secret.json, which keeps the room and the list of paired phones,
 *     after a dated copy of the old files is made (remote-store.js).
 *   - Two engines sharing the folder (a second window, a dev build) merge
 *     what the other wrote before each write (syncFromDisk), so neither drops
 *     a phone the other paired nor brings back one the other removed.
 *   - A lifetime (remotePairDecision { approve, lifetime }, remoteDeviceLifetime
 *     { deviceId, lifetime }): forever by default, or 1, 7 or 30 days. When it
 *     runs out the phone is removed like Remove, with an encrypted close that
 *     says the pairing expired; the phone learns its expiry from hello
 *     ({ expiresAt }) and from { t: 'lifetime', expiresAt } when it changes.
 *
 * Private and Connected, per-phone access, a page check that fails closed
 * (2026-10-10, apaki/SECURITY.md 4.4 and 5; Arthur: "its ok if we have one
 * service that is incredibly secure and private, adn then another one that
 * might be more feature rich and QoL easy - its important that we have that
 * secure and private option"):
 *   - remoteMode { mode, removeAccounts? }: 'connected' (the default, Arthur
 *     2026-10-10: "make sure users can login on apaki to see their connected
 *     machines!") or 'private' (opt-in: only phones paired with this PC's
 *     code; account-link is refused, and an account device already linked
 *     is kept but cannot connect, or is removed with removeAccounts). hello
 *     carries mode, and connected phones get { t: 'mode', mode } when it
 *     changes.
 *   - account-link is never added silently: in Connected the PC holds it,
 *     answers { t: 'pending', reqId, timeoutMs } and asks its user
 *     (status linkRequest: who asks, the account, the access it would get);
 *     remoteLinkDecision { approve, cap?, lifetime? } answers it, and it is
 *     refused after LINK_APPROVAL_MS. A page that cannot wait for that
 *     (no wait: true, from before this) is refused with why.
 *   - each device has a capability (remote-policy.js CAPS: full, noshell,
 *     chat), chosen at Allow (remotePairDecision { cap }, remoteLinkDecision
 *     { cap }) and changed with remoteDeviceCap { deviceId, cap }. The
 *     policy and engine.js enforce it; hello carries cap and { t: 'cap' }
 *     follows a change.
 *   - remotePairStart refuses a code when the page check is anything but
 *     'ok'; remotePairStart { unchecked: true } (the Phone sheet's "Pair
 *     without checking the page") shows one when the site is only
 *     unreachable, never when it serves other files.
 *   - every hour while phone access is on, recheckPages fetches the page
 *     versions this PC verified (pages.json) and the one it builds, the way
 *     a phone browser asks; a file that differs turns phone access off and
 *     keeps the reason (state.json pageAlarm) for the Phone sheet.
 */

import os from 'node:os';
import {
  LIMITS, PcSession, RELAY_CLOSE, checkRelayUrl, createPairingOffer, createPcIdentity, createRoom, decodePcFrame,
  encodePcFrame, exportIdentity, frameType, importIdentity, parseRelayControl, relaySubprotocols, roomIdForToken, roomUrl,
  b64urlDecode, b64urlEncode, deviceIdFor, randomBytes,
} from '../remote/protocol.js';
import { Inbox, Outbox, WIRE_VERSION } from '../remote/wire.js';
import { BROADCAST_EVENTS, PHONE_OPS, checkPhoneCommand, hashText, parsePhoneId, phoneView, routeEvent } from './remote-policy.js';
import { CAPS, CAP_LABEL, capDefaultMode, capNote, capOf, phonePaneId } from './remote-policy.js';
import * as store from './remote-store.js';
import { checkPage, pageText } from './remote-page.js';
import { PHONE_AGENTS, browserHeaders } from './remote-page.js';

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
/** The pairing lifetimes the Phone sheet offers besides forever (days). */
export const LIFETIME_DAYS = Object.freeze([30, 7, 1]);
const DAY_MS = 24 * 60 * 60_000;
/** Expiry is checked at least this often (a timer to the next expiry, capped: sleep and clock changes). */
const EXPIRY_CHECK_MAX_MS = 60 * 60_000;
/** When the saved keys could not be unsealed at start (DPAPI busy, PowerShell slow): try again after these waits. */
const INIT_RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
/** The encrypted close a removed phone gets; the expired one still says "removed" for phone pages from before expiry existed. */
const REMOVED_REASON = 'This phone was removed on the PC.';
const EXPIRED_REASON = 'This phone\'s pairing expired, so it was removed on the PC.';
/** How long an account-link waits for the person at the PC (the same as a pairing). */
const LINK_APPROVAL_MS = LIMITS.PAIR_APPROVE_MS;
/** The phone page re-check: the first one this long after phone access starts, then every hour. */
const RECHECK_FIRST_MS = 2 * 60_000;
const RECHECK_MS = 60 * 60_000;
/** What a phone hears when it asks to link an account to a PC in Private mode (SECURITY.md 4.4). */
const PRIVATE_LINK_ERROR = 'This PC only accepts phones paired with its code.';
/** The encrypted close an account connection gets when the PC switches to Private (it says neither "removed" nor "expired", so the phone keeps the PC). */
const PRIVATE_CLOSE = 'This PC switched to Private mode: it only accepts phones paired with its code.';
/** A phone page from before 2026-10-10 gives up on account-link after 10 s, long before a person can answer on the PC. */
const OLD_PAGE_LINK_ERROR = 'This PC now asks you on the PC before it adds an Apaki account, and this phone page cannot wait for that answer. Pair this phone again with a new code from the PC to get the current page.';

/**
 * Why the relay closed this PC's socket for the rest of the day, for the
 * fair-share codes (relay budget fairness, 2026-10-10): IP_SHARE (this
 * address used its share) or ROOM_SHARE (this room did). null for any other
 * code. Both are waited out like BUDGET.
 */
export function budgetShareText(code) {
  if (code === RELAY_CLOSE.IP_SHARE) return 'This PC\'s internet address has used its share of the Apaki relay for today; it can connect again after 00:00 UTC. Trying again every 30 minutes.';
  if (code === RELAY_CLOSE.ROOM_SHARE) return 'This PC\'s phone connections have used their share of the Apaki relay for today; they work again after 00:00 UTC. Trying again every 30 minutes.';
  return null;
}

/**
 * The capability chosen at Allow: none means 'full' (a window from before
 * capabilities sends none, and it says the phone gets full use); a value
 * that is not one throws, so a phone never gets more than asked.
 */
export function capChoice(cap) {
  if (cap === undefined || cap === null || cap === '') return 'full';
  if (!CAPS.includes(cap)) throw new Error(`A phone can be set to ${CAPS.map((c) => CAP_LABEL[c]).join(', ')}, not "${String(cap).slice(0, 20)}".`);
  return cap;
}

/**
 * The expiry for a lifetime choice: null (forever) for nothing, 'forever' or
 * 0; otherwise a whole number of days from LIFETIME_DAYS, counted from `now`.
 * Anything else throws, so a phone is never allowed longer than asked.
 */
export function expiryFor(lifetime, now = Date.now()) {
  if (lifetime == null || lifetime === '' || lifetime === 'forever' || lifetime === 0 || lifetime === '0') return null;
  const days = Number(lifetime);
  if (!LIFETIME_DAYS.includes(days)) throw new Error(`A phone can stay paired forever or for ${[...LIFETIME_DAYS].reverse().join(', ')} days, not "${String(lifetime).slice(0, 20)}".`);
  return new Date(now + days * DAY_MS).toISOString();
}

const later = (a, b) => (String(a || '') > String(b || '') ? a : b) || null;

/**
 * Merges this engine's state with the state.json another engine wrote (same
 * room). Every mutation here reads the file first and writes right after, so
 * the file is the newest view of every field except the phones: a phone
 * either side knows stays unless either side removed it (removed: { id, at },
 * which wins over a pairing older than the removal), and lastSeen is the
 * later of the two. Exported for the tests.
 */
export function mergeState(mine, disk) {
  const removed = new Map();
  for (const r of [...(disk.removed || []), ...(mine.removed || [])]) {
    if (!r?.id) continue;
    const prev = removed.get(r.id);
    if (!prev || String(r.at || '') > String(prev.at || '')) removed.set(r.id, r);
  }
  const byId = new Map();
  for (const d of mine.devices || []) byId.set(d.id, { ...d });
  for (const d of disk.devices || []) {
    const prev = byId.get(d.id);
    byId.set(d.id, prev ? { ...prev, ...d, lastSeen: later(prev.lastSeen, d.lastSeen) } : { ...d });
  }
  const devices = [...byId.values()].filter((d) => {
    const r = removed.get(d.id);
    return !r || String(d.pairedAt || '') > String(r.at || '');
  });
  return { ...mine, ...disk, devices, removed: [...removed.values()] };
}
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
    // A version verified before is checked against its own hashes (a.files), not this Apaki's build.
    this.pageCheck = o.pageCheck === false ? null : (o.pageCheck || ((a) => checkPage(a.files ? { ...a, build: () => ({ version: a.version, files: a.files }) } : a)));
    this.page = null;
    // The hourly re-check (recheckPages): timings, and the phone browsers it takes turns looking like.
    this.recheckMs = o.recheckMs ?? RECHECK_MS;
    this.recheckFirstMs = o.recheckFirstMs ?? RECHECK_FIRST_MS;
    this.pageAgents = o.pageAgents || PHONE_AGENTS;
    this.recheckTimer = null;
    this.rechecking = null;
    this.recheckRuns = 0;
    this.lastRecheck = null;
    // An account-link waiting for the person at the PC (accountLink), and how long it waits.
    this.linkRequest = null;
    this.linkTimer = null;
    this.linkApprovalMs = o.linkApprovalMs ?? LINK_APPROVAL_MS;
    // Capability notes for phone panes that opened a session: sent after its history, which redraws the pane (route).
    this.capNotes = new Map();
    this.log = o.log || ((line) => process.stderr.write(`apaki remote: ${line}\n`));
    // Timings (tests shorten them).
    this.handshakeMs = o.handshakeMs ?? HANDSHAKE_MS;
    this.graceMs = o.graceMs ?? PANE_GRACE_MS;
    // The clock for pairing lifetimes (tests move it forward).
    this.now = o.now || (() => Date.now());
    this.initRetryMs = o.initRetryMs || INIT_RETRY_MS;

    // Where the state came from ('ok', 'backup', 'missing', 'corrupt'; remote-store.js readState) and
    // the files' stamps as this engine last read or wrote them (syncFromDisk notices another engine's write).
    this.stateStamp = store.stateStamp(this.dir);
    const read = store.readState(this.dir);
    this.state = read.state;
    this.stateStatus = read.status;
    this.secretStamp = null;
    /** Set while the saved keys cannot be opened: 'locked' (DPAPI would not unseal them) or 'unreadable'. */
    this.keysProblem = null;
    /** The last rebuild of state.json from secret.json, for the Phone sheet: { at, devices, lost }. */
    this.recovered = null;
    this.expiryTimer = null;
    this.expiring = null;
    this.initTimer = null;
    this.initAttempt = 0;
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
    // state.json missing or unreadable while the keys are still there: phone access was set up on this
    // PC, so it is rebuilt from the keys and stays on, instead of looking "off" with every phone shut out.
    const recover = (this.stateStatus === 'missing' || this.stateStatus === 'corrupt') && store.hasSecretFile(this.dir);
    if (!this.state.enabled && !recover) return;
    try {
      await this.loadKeys({ create: false });
      if (this.stateStatus === 'backup') { this.log('state.json could not be read; restored it from state.json.bak'); this.saveStateNow(); }
      if (!this.state.enabled) { this.state.enabled = true; this.saveStateNow(); }
      this.stateStatus = 'ok';
      this.initAttempt = 0;
      await this.expireDue();
      this.connect();
      this.startRecheck();
    } catch (e) {
      this.fail(e);
      // DPAPI can be slow or busy right after sign-in: try again by itself.
      if (this.keysProblem === 'locked') this.retryInit();
    }
  }

  retryInit() {
    if (this.initTimer) return;
    const ms = this.initRetryMs[Math.min(this.initAttempt, this.initRetryMs.length - 1)];
    this.initAttempt += 1;
    this.initTimer = unref(setTimeout(() => {
      this.initTimer = null;
      if (!this.identity) this.init();
    }, ms));
  }

  /* ---------- keys and saved state ---------- */

  /**
   * Loads this PC's identity and room (creating them when asked, and only
   * when there is no secret.json at all). A secret.json that cannot be
   * opened throws (keysProblem says why): new keys over it would unpair
   * every phone. A state.json that does not match the keys is rebuilt from
   * them (recoverState).
   */
  async loadKeys({ create }) {
    if (this.identity) return true;
    this.syncFromDisk();
    const stampBefore = store.secretStamp(this.dir);
    let secret;
    try {
      secret = await store.loadSecret(this.dir);
    } catch (e) {
      this.keysProblem = e.code === 'locked' ? 'locked' : 'unreadable';
      throw new Error(this.keysProblem === 'locked'
        ? `Phone access could not unseal its saved keys (${e.message}). Your paired phones are kept; Apaki tries again by itself.`
        : `Phone access could not read its saved keys (${e.message}), nor their backup. Your paired phones are kept; nothing was replaced. To pair everything again with new keys, choose Start over.`);
    }
    if (secret) {
      const roomId = await roomIdForToken(secret.token).catch(() => null);
      if (!roomId || !secret.identity?.pub) {
        this.keysProblem = 'unreadable';
        throw new Error('Phone access found its saved keys incomplete. Your paired phones are kept; nothing was replaced. To pair everything again with new keys, choose Start over.');
      }
      if (secret.fromBackup) this.log('secret.json could not be opened; using secret.json.bak');
      this.keysProblem = null;
      this.secret = secret;
      this.secretStamp = stampBefore;
      this.scheme = secret.scheme;
      if (this.state.roomId !== roomId || this.state.pcPub !== secret.identity.pub) this.recoverState(secret, roomId);
      else this.restoreDevices(secret);
      this.identity = await importIdentity(secret.identity);
      // Repair secret.json from its backup, and give an older secret.json the list of phones (so state.json can be rebuilt from it),
      // and the mode (2026-10-10; it may also have changed while the keys were not loaded).
      if (secret.fromBackup || (!secret.devices?.length && this.state.devices.length) || (secret.mode || null) !== this.mode()) {
        await this.saveSecretNow({ backup: !secret.fromBackup }).catch((e) => this.log(`updating secret.json: ${e.message}`));
      }
      return true;
    }
    if (!create) throw new Error('Phone access has no keys yet; turn it on again to make them.');
    // No secret.json at all (first use, or the files were deleted on purpose): new keys, a dated copy of any old state first.
    if (this.state.roomId || this.state.devices.length) {
      const copies = store.backupNow(this.dir, 'before-new-keys');
      this.log(`no saved keys; making new ones (copies kept: ${copies.join(', ') || 'none'})`);
    }
    const identity = await createPcIdentity();
    const room = await createRoom();
    secret = { identity: await exportIdentity(identity), token: room.token, psks: {} };
    this.state = { ...this.state, roomId: room.roomId, pcPub: secret.identity.pub, createdAt: new Date().toISOString(), devices: [], removed: [] };
    this.secret = secret;
    this.keysProblem = null;
    await this.saveSecretNow();
    this.saveStateNow();
    this.identity = await importIdentity(secret.identity);
    return true;
  }

  /**
   * state.json does not match the keys in secret.json (it is missing,
   * damaged, or from another room): rebuild it from secret.json, which holds
   * the room and the paired phones, keeping what the old file knew (last
   * seen, on or off). A dated copy of both files is made first.
   */
  recoverState(secret, roomId) {
    const old = this.state;
    const copies = old.roomId || old.devices.length ? store.backupNow(this.dir, 'before-recovery') : [];
    const known = new Map(old.devices.map((d) => [d.id, d]));
    const psks = secret.psks || {};
    const devices = [];
    for (const m of secret.devices || []) if (psks[m.id]) devices.push({ ...m, lastSeen: known.get(m.id)?.lastSeen ?? m.lastSeen ?? null });
    // An older secret.json has no list: the old state's records whose secrets are here still work.
    for (const d of old.devices) if (psks[d.id] && !devices.some((x) => x.id === d.id)) devices.push({ ...d });
    // A phone with a secret here but no public key anywhere cannot be rebuilt (an older secret.json and no state.json).
    const lost = Object.keys(psks).filter((id) => !devices.some((d) => d.id === id)).length;
    this.state = {
      v: 1,
      enabled: this.stateStatus === 'ok' ? old.enabled : true,
      // Private or Connected: secret.json's copy first (it outlives state.json, so a rebuild never opens a Private PC
      // up), then the old state's when it was this room's, then the default (Connected).
      mode: store.PHONE_MODES.includes(secret.mode) ? secret.mode : (old.roomId === roomId ? store.modeOf(old) : store.DEFAULT_MODE),
      pageAlarm: old.roomId === roomId ? old.pageAlarm || null : null,
      roomId,
      pcPub: secret.identity.pub,
      createdAt: (old.roomId === roomId && old.createdAt) || secret.createdAt || old.createdAt || null,
      devices,
      removed: old.removed || [],
    };
    this.saveStateNow();
    this.recovered = { at: new Date().toISOString(), devices: devices.length, lost };
    this.log(`state.json did not match the saved keys; rebuilt it from secret.json with ${devices.length} phone(s)${lost ? `, ${lost} could not be rebuilt` : ''} (copies kept: ${copies.join(', ') || 'none'})`);
  }

  /** Phones secret.json lists (with their secrets) that state.json lost, for example to an older copy: put back. */
  restoreDevices(secret) {
    const removed = new Set((this.state.removed || []).map((r) => r.id));
    const back = (secret.devices || []).filter((m) => secret.psks?.[m.id] && !removed.has(m.id) && !this.state.devices.some((d) => d.id === m.id));
    if (!back.length) return;
    this.state.devices = [...this.state.devices, ...back.map((m) => ({ ...m, lastSeen: m.lastSeen ?? null }))];
    this.saveStateNow();
    this.log(`put back ${back.length} paired phone(s) state.json had lost`);
  }

  /** Writes state.json and remembers its stamp (so this engine's own write is not taken for another's). */
  saveStateNow() {
    store.saveState(this.state, this.dir);
    this.stateStamp = store.stateStamp(this.dir);
  }

  /** Writes secret.json with the paired phones' public records (and Private or Connected) beside the secrets. */
  async saveSecretNow({ backup = true } = {}) {
    this.scheme = await store.saveSecret({ ...this.secret, devices: this.state.devices, createdAt: this.state.createdAt, mode: this.mode() }, this.dir, { backup });
    this.secret.mode = this.mode();
    this.secretStamp = store.secretStamp(this.dir);
  }

  /** 'private' or 'connected' (remote-store.js modeOf: none chosen yet is the default, Connected). */
  mode() {
    return store.modeOf(this.state);
  }

  /**
   * A paired phone's capability (remote-policy.js capOf: none is 'full',
   * anything unknown or a phone no longer paired is 'chat'). A pane id
   * works too. Read on every command and every tool call of its panes, so
   * a change on the PC applies at once; another engine's change to the
   * folder is taken in first.
   */
  capFor(id) {
    const p = parsePhoneId(id);
    const deviceId = p ? p.deviceId : String(id || '');
    try { this.syncFromDisk(); } catch { /* the view in memory stands */ }
    return capOf(this.state.devices.find((d) => d.id === deviceId));
  }

  /**
   * Takes in state.json when another engine wrote it since this one last
   * read or wrote it (same room only), merging the two views (mergeState).
   * Returns true when it changed anything.
   */
  syncFromDisk() {
    const now = store.stateStamp(this.dir);
    if (!now || now === this.stateStamp) return false;
    const { state: disk, status } = store.readState(this.dir);
    this.stateStamp = now;
    if ((status !== 'ok' && status !== 'backup') || !disk.roomId || disk.roomId !== this.state.roomId) return false;
    this.state = mergeState(this.state, disk);
    return true;
  }

  /** The same for secret.json: secrets of phones another engine paired come in; removed ones go. */
  async reloadSecretIfChanged() {
    if (!this.secret) return;
    const now = store.secretStamp(this.dir);
    if (!now || now === this.secretStamp) return;
    let disk = null;
    try { disk = await store.loadSecret(this.dir); } catch (e) { this.log(`reading secret.json again: ${e.message}`); return; }
    this.secretStamp = now;
    if (!disk || disk.token !== this.secret.token) return; // another room's keys: this engine's stand
    const keep = new Set(this.state.devices.map((d) => d.id));
    const psks = {};
    for (const [id, psk] of Object.entries({ ...disk.psks, ...this.secret.psks })) if (keep.has(id)) psks[id] = psk;
    this.secret.psks = psks;
  }

  /** Before this engine writes: what another engine wrote meanwhile comes in first. */
  async syncBeforeWrite() {
    this.syncFromDisk();
    await this.reloadSecretIfChanged();
  }

  /** A paired device as PcSession wants it, or null (unknown, removed, or its lifetime ran out). */
  getDevice(id) {
    const d = this.state.devices.find((x) => x.id === id);
    const psk = this.secret?.psks?.[id];
    if (!d || !psk) return null;
    if (this.isExpired(d)) { this.expireSoon(); return null; }
    // Private mode: an Apaki account's device is kept (switching back to Connected lets it in again) but no
    // phone connects as it; the handshake answers it like an unknown device (SECURITY.md 4.1).
    if (d.kind === 'account' && this.mode() !== 'connected') return null;
    return { id: d.id, pub: d.pub, psk, name: d.name, pairedAt: d.pairedAt };
  }

  /** getDevice, after taking in another engine's writes when the files changed (a phone paired in another Apaki window). */
  async findDevice(id) {
    const d = this.getDevice(id);
    if (d) return d;
    if (store.stateStamp(this.dir) === this.stateStamp && store.secretStamp(this.dir) === this.secretStamp) return null;
    await this.syncBeforeWrite();
    return this.getDevice(id);
  }

  async addDevice(device) {
    await this.syncBeforeWrite();
    const rec = { id: device.id, pub: device.pub, name: String(device.name || 'Phone').slice(0, 64), pairedAt: device.pairedAt, lastSeen: new Date().toISOString() };
    // An Apaki account's device (ACCOUNTS.md): which phone linked it, and the account's name.
    if (device.kind === 'account') Object.assign(rec, { kind: 'account', account: String(device.account || '').slice(0, 48), by: String(device.by || '').slice(0, 64) });
    // A lifetime the user chose at Allow (null: forever).
    if (device.expiresAt) rec.expiresAt = device.expiresAt;
    // What it may make Claude do, chosen at Allow (remote-policy.js CAPS); kept explicitly, 'full' included.
    if (device.cap) rec.cap = capOf(device);
    this.state.devices = [...this.state.devices.filter((d) => d.id !== rec.id), rec];
    // The same key paired again (an account linked again after it was removed): no longer removed.
    this.state.removed = (this.state.removed || []).filter((r) => r.id !== rec.id);
    this.secret.psks = { ...this.secret.psks, [rec.id]: device.psk };
    await this.saveSecretNow();
    this.saveStateNow();
    this.scheduleExpiry();
    return rec;
  }

  touchDevice(id) {
    try { this.syncFromDisk(); } catch (e) { this.log(`reading state: ${e.message}`); }
    const d = this.state.devices.find((x) => x.id === id);
    if (!d) return;
    d.lastSeen = new Date().toISOString();
    try { this.saveStateNow(); } catch (e) { this.log(`saving state: ${e.message}`); }
  }

  /* ---------- pairing lifetimes ---------- */

  isExpired(d) {
    const t = Date.parse(d?.expiresAt || '');
    return Number.isFinite(t) && t <= this.now();
  }

  /** Runs expireDue soon, once (getDevice found an expired phone, or the timer fired). */
  expireSoon() {
    if (this.expiring) return this.expiring;
    this.expiring = Promise.resolve().then(() => this.expireDue()).catch((e) => this.log(`expiring pairings: ${e.message}`)).finally(() => { this.expiring = null; });
    return this.expiring;
  }

  /** Removes every phone whose lifetime ran out (like Remove, with the expired close), then waits for the next one. */
  async expireDue() {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const due = this.state.devices.filter((d) => this.isExpired(d));
    for (const d of due) {
      this.log(`the pairing of ${d.name || 'a phone'} expired; removing it`);
      await this.revoke(d.id, { expired: true });
    }
    if (due.length) this.pushStatus({ expired: due.map((d) => ({ id: d.id, name: d.name })) });
    this.scheduleExpiry();
  }

  scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const times = this.state.devices.map((d) => Date.parse(d.expiresAt || '')).filter(Number.isFinite);
    if (!times.length) return;
    const wait = Math.min(Math.max(1000, Math.min(...times) - this.now() + 100), EXPIRY_CHECK_MAX_MS);
    this.expiryTimer = unref(setTimeout(() => { this.expiryTimer = null; this.expireSoon(); }, wait));
  }

  /** A new lifetime for a paired phone, counted from now (null or 'forever': no limit). Its open connections hear it. */
  async setLifetime(deviceId, lifetime) {
    const expiresAt = expiryFor(lifetime, this.now());
    await this.syncBeforeWrite();
    const d = this.state.devices.find((x) => x.id === deviceId);
    if (!d) throw new Error('That phone is not paired with this PC any more.');
    if (expiresAt) d.expiresAt = expiresAt; else delete d.expiresAt;
    if (this.secret) await this.saveSecretNow();
    this.saveStateNow();
    for (const c of this.conns.values()) if (c.open && c.device?.id === deviceId) c.outbox?.send({ t: 'lifetime', expiresAt: expiresAt || null }).catch(() => {});
    this.scheduleExpiry();
  }

  /* ---------- what a phone may do, Private or Connected (2026-10-10) ---------- */

  /**
   * A paired phone's capability (remote-policy.js CAPS), changed on the PC.
   * Kept in both files (secret.json's list too, so a rebuilt state.json
   * never widens it). Its open connections hear it ({ t: 'cap' }), and the
   * engine applies it to the phone's panes now (engine.capChanged).
   */
  async setCap(deviceId, cap) {
    // Here a choice is required (no "none means full" as at Allow from an older window).
    if (cap === undefined || cap === null || cap === '') throw new Error('Choose Full, No shell or Chat only for this phone.');
    const next = capChoice(cap);
    await this.syncBeforeWrite();
    const d = this.state.devices.find((x) => x.id === deviceId);
    if (!d) throw new Error('That phone is not paired with this PC any more.');
    d.cap = next;
    if (this.secret) await this.saveSecretNow();
    this.saveStateNow();
    for (const c of this.conns.values()) if (c.open && c.device?.id === deviceId) c.outbox?.send({ t: 'cap', cap: next }).catch(() => {});
    this.log(`${d.name || 'a phone'} is now set to ${CAP_LABEL[next]}`);
    try { this.engine.capChanged?.(deviceId, next); } catch (e) { this.log(`applying ${CAP_LABEL[next]} to its panes: ${e.message}`); }
  }

  /**
   * Private or Connected (SECURITY.md 4.4). Private refuses account links,
   * drops a pending one, and closes every account connection: the account
   * devices are removed (removeAccounts) or kept but cannot connect until
   * Connected again (getDevice). Every connected phone hears the new mode.
   */
  async setMode(mode, { removeAccounts = false } = {}) {
    if (!store.PHONE_MODES.includes(mode)) throw new Error(`Phone access is Private or Connected, not "${String(mode).slice(0, 20)}".`);
    await this.syncBeforeWrite();
    const was = this.mode();
    this.state.mode = mode;
    if (this.secret) await this.saveSecretNow();
    this.saveStateNow();
    if (mode === 'private') {
      if (this.linkRequest) this.clearLinkRequest(PRIVATE_LINK_ERROR);
      for (const d of this.state.devices.filter((x) => x.kind === 'account')) {
        if (removeAccounts) await this.revoke(d.id);
        else await this.disconnectDevice(d.id, PRIVATE_CLOSE);
      }
    }
    for (const c of this.conns.values()) if (c.open) c.outbox?.send({ t: 'mode', mode, features: this.helloFeatures() }).catch(() => {});
    if (was !== mode) this.log(`phone access is now ${mode}${mode === 'private' && removeAccounts ? ' (account devices removed)' : ''}`);
  }

  /** Closes a device's connections (encrypted close with `reason`) and its panes; its pairing stays. */
  async disconnectDevice(deviceId, reason) {
    for (const c of [...this.conns.values()]) {
      if (c.device?.id !== deviceId) continue;
      if (c.open) {
        const f = await c.session.close(reason).catch(() => null);
        if (f) this.toRelay(c.id, f);
      }
      this.kick(c.id);
      this.dropConn(c.id);
    }
    this.cancelGrace(deviceId);
    this.closePhonePanes(deviceId);
  }

  /** What this PC tells a phone it understands, beyond commands (hello and { t: 'mode' }). */
  helloFeatures() {
    // 'account-ask': account-link is held until the person at the PC answers (a page must send wait: true).
    // The 'account' of before 2026-10-10 (links added at once) is no longer offered, so an older page does not try.
    return ['mode', 'cap', ...(this.mode() === 'connected' ? ['account-ask'] : [])];
  }

  /**
   * Start over when the saved keys cannot be opened at all: the files are
   * set aside (renamed with the time, never deleted) and phone access is
   * off; turning it on makes new keys, and every phone pairs again.
   */
  async reset() {
    if (!this.keysProblem) throw new Error('Phone access can open its keys, so there is nothing to start over; remove phones one by one below.');
    clearTimeout(this.initTimer);
    this.initTimer = null;
    this.stopRecheck();
    this.closeSocket();
    const moved = store.setAside(this.dir);
    this.log(`phone access started over; set aside: ${moved.join(', ') || 'nothing'}`);
    const read = store.readState(this.dir);
    this.state = read.state;
    this.stateStatus = read.status;
    this.stateStamp = null;
    this.secretStamp = null;
    this.secret = null;
    this.identity = null;
    this.scheme = null;
    this.keysProblem = null;
    this.recovered = null;
    this.setStatus('off');
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
    // The phone that asked to link an account is gone with the socket: nothing to answer, nothing added.
    this.linkRequest = null;
    clearTimeout(this.linkTimer);
    this.linkTimer = null;
    for (const id of devices) this.afterLeave(id);
    if (!this.state.enabled) { this.setStatus('off'); return; }
    const replaced = this.byeCode === RELAY_CLOSE.REPLACED || code === RELAY_CLOSE.REPLACED;
    const budget = this.byeCode === RELAY_CLOSE.BUDGET || code === RELAY_CLOSE.BUDGET;
    // The relay's fair shares (2026-10-10, relay budget fairness): this address, or this room, used its part of the day.
    const share = budgetShareText(this.byeCode) || budgetShareText(code);
    this.byeCode = null;
    if (this.connectedAt && Date.now() - this.connectedAt > STABLE_MS) this.attempt = 0;
    this.connectedAt = null;
    if (replaced) this.scheduleReconnect('Another Apaki took this PC\'s relay connection; trying again in a few minutes.', REPLACED_RETRY_MS, 'replaced');
    // The hosted relay spent its daily budget: wait instead of knocking every minute.
    else if (budget) this.scheduleReconnect('The Apaki relay has used today\'s budget; it takes connections again after 00:00 UTC. Trying again every 30 minutes.', BUDGET_RETRY_MS);
    // Its share of the day for this address or room: the same wait, with its own reason.
    else if (share) this.scheduleReconnect(share, BUDGET_RETRY_MS);
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
    return new PcSession({ identity: this.identity, roomId: this.state.roomId, getOffer: () => this.offer, getDevice: (id) => this.findDevice(id) });
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
    if (this.linkRequest?.conn === id) { this.dropLinkRequest(); changed = true; }
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
    // features: what this PC understands beyond commands (an older Apaki sends none; helloFeatures).
    const self = this.state.devices.find((d) => d.id === device.id);
    const cap = capOf(self);
    // expiresAt: when this phone's pairing runs out (null: never), so the phone can show it and explain an expiry.
    // mode (Private or Connected) and cap (what this phone may make Claude do), since 2026-10-10.
    c.outbox.send({ t: 'hello', v: WIRE_VERSION, pcName: this.pcName, ops: this.phoneOps(), features: this.helloFeatures(), expiresAt: self?.expiresAt || null, mode: this.mode(), cap, ...(self?.kind === 'account' ? { asAccount: true } : {}) });
    // The ready event a phone gets names the mode its panes start in, never the desktop's default (SECURITY.md 5 item 4).
    c.outbox.push({ ...phoneView(this.readyEvent()), mode: capDefaultMode(cap) });
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
    if (this.linkRequest?.conn === c.id) { this.dropLinkRequest(); changed = true; }
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
   * A paired phone asks to link its Apaki account to this PC: the account's
   * device key would become one more paired device (kind 'account') with a
   * fresh psk, which the phone puts in the account's encrypted vault, so
   * any phone signed in to that account could then reconnect as it.
   *
   * Since 2026-10-10 (SECURITY.md 1.3 item 4, 1.4, 4.4) that is never
   * silent. In Private mode it is refused. In Connected mode it is held:
   * the phone hears { t: 'pending' } and the person at the PC sees who asks,
   * the account's name and the access it would get, and allows or denies
   * it (decideLink) within LINK_APPROVAL_MS. Neither our servers nor code
   * they serve to a phone can add a device to this PC. The Phone sheet then
   * shows the account and who linked it, and Remove cuts every account
   * phone off at once.
   */
  async accountLink(c, msg) {
    const reqId = String(msg.reqId || '').slice(0, 40);
    const answer = (v) => c.outbox?.send({ t: 'account-linked', reqId, ...v }).catch(() => {});
    try {
      if (this.mode() !== 'connected') { answer({ error: PRIVATE_LINK_ERROR, code: 'private' }); return; }
      // An older page gives up after 10 s; holding its request would leave an account device whose secret nobody has.
      if (msg.wait !== true) { answer({ error: OLD_PAGE_LINK_ERROR, code: 'old-page' }); return; }
      const raw = b64urlDecode(String(msg.pub || ''));
      if (raw.length !== 65 || raw[0] !== 4) throw new Error('that is not an account key');
      await globalThis.crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const id = await deviceIdFor(raw);
      if (id === c.device.id) throw new Error('a device cannot link itself');
      const others = this.state.devices.filter((d) => d.kind === 'account' && d.id !== id);
      if (others.length >= MAX_ACCOUNT_DEVICES) throw new Error(`this PC already has ${MAX_ACCOUNT_DEVICES} Apaki accounts linked; remove one in its Phone sheet first`);
      if (this.linkRequest) throw new Error('this PC is already asking about another Apaki account; answer that one on the PC first');
      const account = String(msg.name || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Apaki account';
      const self = this.state.devices.find((d) => d.id === c.device.id);
      const by = self?.name || c.device.name || 'a phone';
      // The access offered first is the asking phone's own (the person may pick another).
      this.linkRequest = { conn: c.id, deviceId: c.device.id, reqId, id, pub: b64urlEncode(raw), account, by, via: c.via || null, cap: capOf(self), exp: Date.now() + this.linkApprovalMs };
      clearTimeout(this.linkTimer);
      this.linkTimer = unref(setTimeout(() => { this.log(`nobody answered the Apaki account "${account}" in time`); this.clearLinkRequest('Nobody allowed it on the PC in time.'); }, this.linkApprovalMs));
      c.outbox?.send({ t: 'pending', reqId, timeoutMs: this.linkApprovalMs }).catch(() => {});
      this.log(`${by} asks to link the Apaki account "${account}"; waiting for an answer on the PC`);
      this.pushStatus({ linkRequested: true });
    } catch (e) {
      answer({ error: e.message || String(e) });
    }
  }

  /**
   * The answer on the PC to a held account-link. Allow adds the account
   * device with the access (cap) and lifetime chosen there; the phone gets
   * its psk. Deny, a phone that went away, or a switch to Private add
   * nothing. An access or lifetime Apaki does not offer throws and leaves
   * the request waiting.
   */
  async decideLink(approve, { cap, lifetime } = {}) {
    const r = this.linkRequest;
    if (!r) return;
    const capChosen = approve ? capChoice(cap ?? r.cap) : null;
    const expiresAt = approve ? expiryFor(lifetime, this.now()) : null;
    if (!approve) {
      this.log(`denied the Apaki account "${r.account}"`);
      this.clearLinkRequest('Denied on the PC.');
      return;
    }
    this.dropLinkRequest();
    const c = this.conns.get(r.conn);
    const answer = (v) => c?.outbox?.send({ t: 'account-linked', reqId: r.reqId, ...v }).catch(() => {});
    if (!c || !c.open || c.device?.id !== r.deviceId) throw new Error('That phone went away before you answered, so nothing was added.');
    if (this.mode() !== 'connected') { answer({ error: PRIVATE_LINK_ERROR, code: 'private' }); throw new Error('This PC is in Private mode now, so the account was not added.'); }
    if (this.state.devices.filter((d) => d.kind === 'account' && d.id !== r.id).length >= MAX_ACCOUNT_DEVICES) {
      answer({ error: `this PC already has ${MAX_ACCOUNT_DEVICES} Apaki accounts linked` });
      throw new Error(`This PC already has ${MAX_ACCOUNT_DEVICES} Apaki accounts linked; remove one first.`);
    }
    const psk = b64urlEncode(randomBytes(32));
    const rec = await this.addDevice({ id: r.id, pub: r.pub, name: `Apaki account (${r.account})`, kind: 'account', account: r.account, by: r.by, psk, pairedAt: new Date().toISOString(), cap: capChosen, expiresAt });
    answer({ deviceId: r.id, psk, pcName: this.pcName });
    this.log(`${r.by} linked the Apaki account "${r.account}" (allowed on the PC, ${CAP_LABEL[capChosen]})`);
    this.pushStatus({ linked: { id: rec.id, name: rec.name } });
  }

  /** Ends a held account-link: the phone hears `error` (when it is still there) and the Phone sheet drops the card. */
  clearLinkRequest(error) {
    const r = this.linkRequest;
    if (!r) return;
    this.dropLinkRequest();
    const c = this.conns.get(r.conn);
    if (error && c?.open) c.outbox?.send({ t: 'account-linked', reqId: r.reqId, error }).catch(() => {});
    this.pushStatus();
  }

  /** Forgets a held account-link without a word (its connection is gone). */
  dropLinkRequest() {
    this.linkRequest = null;
    clearTimeout(this.linkTimer);
    this.linkTimer = null;
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
      // What this phone may make Claude do (2026-10-10), read now so a change on the PC applies to the next command.
      cap: this.capFor(deviceId),
    });
    if (!r.ok) {
      const message = typeof cmd?.op === 'string' && Object.hasOwn(REFUSED, cmd.op) ? REFUSED[cmd.op] : r.error;
      c.outbox.push({ ev: 'error', reqId: r.reqId, paneId: r.paneId, message, refused: true });
      // A refused mode change: the phone already shows the mode it asked for, so it hears the one the pane really has.
      if (cmd?.op === 'mode' && r.paneId) {
        const info = e.paneInfo?.(phonePaneId(deviceId, r.paneId));
        if (info?.mode) c.outbox.push({ ev: 'settings', paneId: r.paneId, model: info.model, effort: info.effort, mode: info.mode });
      }
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
      if (ev.ev === 'opened') this.afterOpened(r.deviceId, ev, r.ev);
      else if (ev.ev === 'history') this.flushCapNote(r.deviceId, ev.paneId);
      else if (ev.ev === 'closed') this.capNotes.delete(ev.paneId);
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

  /**
   * A phone pane opened (or re-attached): the phone's window learns the
   * mode the pane really runs in (its page may have asked for another; the
   * capability decides, SECURITY.md 5 item 4), and a restricted phone says
   * what it may do. That note goes after the session's history, which
   * redraws the pane, or at once for a new conversation.
   */
  afterOpened(deviceId, ev, phoneEv) {
    if (!phoneEv.paneId) return;
    this.toDevice(deviceId, { ev: 'settings', paneId: phoneEv.paneId, model: ev.model, effort: ev.effort, mode: ev.mode });
    const text = capNote(this.capFor(deviceId));
    if (!text) { this.capNotes.delete(ev.paneId); return; }
    const note = { ev: 'note', paneId: phoneEv.paneId, tone: '', text };
    if (ev.sessionId) this.capNotes.set(ev.paneId, note);
    else this.toDevice(deviceId, note);
  }

  /** The capability note a pane's history was waiting for. */
  flushCapNote(deviceId, paneId) {
    const note = this.capNotes.get(paneId);
    if (!note) return;
    this.capNotes.delete(paneId);
    this.toDevice(deviceId, note);
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
        // unchecked: the person chose "Pair without checking the page" (only an unreachable site; never one that differs).
        case 'remotePairStart': await this.pairStart({ unchecked: c.unchecked === true }); break;
        case 'remotePairCancel': this.clearOffer({ quiet: true }); break;
        // lifetime: days from LIFETIME_DAYS, or none for forever (older windows send none).
        // cap: what the phone may make Claude do (CAPS); none for 'full' (older windows send none).
        case 'remotePairDecision': await this.decide(c.approve === true, c.lifetime, c.cap); break;
        case 'remoteRevoke': await this.revoke(String(c.deviceId || '')); break;
        case 'remoteDeviceLifetime': await this.setLifetime(String(c.deviceId || ''), c.lifetime); break;
        case 'remoteReset': await this.reset(); break;
        // 2026-10-10: Private or Connected, a phone's access, and the answer to a held account-link.
        case 'remoteMode': await this.setMode(String(c.mode || ''), { removeAccounts: c.removeAccounts === true }); break;
        case 'remoteDeviceCap': await this.setCap(String(c.deviceId || ''), c.cap); break;
        case 'remoteLinkDecision': await this.decideLink(c.approve === true, { cap: c.cap, lifetime: c.lifetime }); break;
        default: break; // remoteStatus, remoteDevices: the status below
      }
    } catch (e) {
      error = e.message || String(e);
      this.log(`${c.op}: ${error}`);
    }
    this.pushStatus({ reqId: c.reqId, ...(error ? { opError: error } : {}) });
  }

  async enable() {
    clearTimeout(this.initTimer);
    this.initTimer = null;
    try {
      await this.loadKeys({ create: true });
    } catch (e) {
      // DPAPI busy: keep trying by itself (only while phone access is meant to be on).
      if (this.keysProblem === 'locked' && this.state.enabled) this.retryInit();
      throw e;
    }
    // Turned on again after the page re-check turned it off: the person has seen why; the page is checked again soon.
    const hadAlarm = Boolean(this.state.pageAlarm);
    if (!this.state.enabled || hadAlarm) {
      this.state.enabled = true;
      this.state.pageAlarm = null;
      this.saveStateNow();
    }
    this.stateStatus = 'ok';
    this.error = null;
    await this.expireDue();
    this.connect();
    this.startRecheck(hadAlarm ? Math.min(5_000, this.recheckFirstMs) : this.recheckFirstMs);
    if (isPlaceholder(this.relay)) this.setStatus('unconfigured');
  }

  /** Turns phone access off. reason: the encrypted close connected phones get (it must not say "removed" or "expired": they keep the PC). */
  async disable({ reason = 'Phone access was turned off on the PC.' } = {}) {
    this.syncFromDisk();
    this.state.enabled = false;
    this.saveStateNow();
    this.stopRecheck();
    this.clearOffer({ quiet: true });
    this.request = null;
    this.clearLinkRequest('Phone access was turned off on the PC.');
    for (const c of [...this.conns.values()]) {
      if (!c.open) continue;
      const f = await c.session.close(reason).catch(() => null);
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

  /**
   * Shows a pairing code. Only after the phone page checks out (fails closed
   * since 2026-10-10, SECURITY.md 5 item 1): a page that differs or is not
   * published gets no code, and neither does a site the PC cannot check
   * (unreachable, or it answered with an error), unless the person chose
   * "Pair without checking the page" (unchecked), which the status marks on
   * the code. unchecked never overrides a page that differs.
   */
  async pairStart({ unchecked = false } = {}) {
    if (isPlaceholder(this.relay)) throw new Error('The Apaki relay is not set up yet, so a phone could not reach this PC.');
    if (!this.state.enabled) await this.enable();
    if (this.request) throw new Error('A phone is waiting for your answer; allow or deny it first.');
    let web = this.web;
    let skipped = false;
    if (this.pageCheck) {
      // Asked to skip right after a check that could not reach the site: no second 15 s wait for the same answer.
      const recent = this.page && this.page.state === 'unreachable' && Date.now() - (this.page.at || 0) < PAGE_CHECK_MS ? this.page : null;
      const page = unchecked && recent ? recent : await this.checkedPage();
      if (page.state === 'ok') {
        if (page.url) web = page.url;
      } else if (page.state === 'unreachable' && unchecked) {
        // The person's explicit choice: the code still opens the version this Apaki builds, unverified.
        if (page.url) web = page.url;
        skipped = true;
        this.log('showing a pairing code without a page check (the person chose Pair without checking the page)');
      } else {
        this.pushStatus();
        throw new Error(pageText(page));
      }
    }
    this.offer = createPairingOffer({ identity: this.identity, relay: checkRelayUrl(this.relay), roomId: this.state.roomId, name: this.pcName, web });
    this.offer.unchecked = skipped;
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
    if (!this.page || typeof this.page.state !== 'string') this.page = { state: 'unreachable', error: 'the check gave no answer', at: Date.now() };
    // A verified version is checked again every hour from now on (recheckPages), with the hashes it was verified against.
    if (this.page.state === 'ok' && this.page.hashes) {
      try { store.rememberPage({ version: this.page.version, web: this.web, url: this.page.url, files: this.page.hashes, verifiedAt: new Date().toISOString() }, this.dir); } catch (e) { this.log(`remembering the checked page: ${e.message}`); }
    }
    this.pushStatus();
    return this.page;
  }

  /* ---------- the hourly re-check of the phone page (2026-10-10) ---------- */

  /** Starts (or restarts) the hourly re-check while phone access is on. */
  startRecheck(firstMs = this.recheckFirstMs) {
    this.stopRecheck();
    if (!this.pageCheck || !this.state.enabled) return;
    const run = () => {
      this.recheckTimer = null;
      this.recheckPages().catch((e) => this.log(`page re-check: ${e.message}`)).finally(() => {
        if (this.state.enabled && !this.recheckTimer) this.recheckTimer = unref(setTimeout(run, this.recheckMs));
      });
    };
    this.recheckTimer = unref(setTimeout(run, firstMs));
  }

  stopRecheck() {
    clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
  }

  /**
   * Fetches the phone page again the way a phone browser asks for it
   * (SECURITY.md 5 item 7): the version this Apaki builds (when published)
   * and every version this PC verified before (pages.json, which is what
   * paired phones keep opening). The User-Agent and headers take turns
   * between an iPhone and an Android phone. A file that differs, twice in a
   * row, turns phone access off and keeps the reason (pageChanged).
   * Unreachable or not published changes nothing; it is tried next hour.
   * What it cannot do: look like a phone's network or TLS handshake.
   */
  async recheckPages() {
    if (!this.pageCheck || !this.state.enabled) return null;
    if (this.rechecking) return this.rechecking;
    this.rechecking = (async () => {
      const agent = this.pageAgents[this.recheckRuns % this.pageAgents.length];
      this.recheckRuns += 1;
      const headers = browserHeaders(agent);
      const results = [];
      const seen = new Set();
      const targets = [{ web: this.web, relay: this.relay }, ...store.loadPages(this.dir).map((p) => ({ web: p.web || this.web, relay: this.relay, version: p.version, files: p.files }))];
      for (const t of targets) {
        if (!this.state.enabled) break;
        if (t.version && seen.has(t.version)) continue;
        const check = () => Promise.resolve().then(() => this.pageCheck({ ...t, headers, recheck: true, agent: agent.name })).catch((e) => ({ state: 'unreachable', error: e.message, at: Date.now() }));
        let r = await check();
        if (r?.state === 'differs') {
          // Once more before acting: one odd answer is not a changed site.
          const again = await check();
          if (again?.state === 'differs') {
            results.push(again);
            await this.pageChanged(again, agent);
            break;
          }
          r = again;
        }
        if (r?.version) seen.add(r.version);
        results.push(r);
      }
      this.lastRecheck = { at: Date.now(), agent: agent.name, results: results.map((r) => ({ version: r?.version || null, state: r?.state || 'unreachable' })) };
      this.pushStatus();
      return results;
    })().finally(() => { this.rechecking = null; });
    return this.rechecking;
  }

  /** The re-check found a changed page: phone access goes off, and the reason stays (state.json pageAlarm) for the Phone sheet. */
  async pageChanged(r, agent) {
    const host = hostOf(r.url);
    const bad = [...(r.differs || []), ...(r.missing || [])];
    const text = `Phone access was turned off: the phone page at ${host} (version ${r.version}) is not what this PC checked before (${bad.length} of ${r.files} files differ when fetched the way ${agent.name} asks for them). Someone may have changed that site. Turn phone access on again only once you know why.`;
    this.log(`the phone page at ${r.url} changed (${bad.slice(0, 5).join(', ')}); turning phone access off`);
    this.page = r;
    this.syncFromDisk();
    this.state.pageAlarm = { at: new Date().toISOString(), version: r.version || null, url: r.url || null, files: bad.slice(0, 50), of: r.files || 0, text };
    this.saveStateNow();
    await this.disable({ reason: 'Phone access was turned off on the PC: its check of the phone page found a change.' });
    this.pushStatus({ pageChanged: true });
  }

  clearOffer({ quiet = false } = {}) {
    clearTimeout(this.offerTimer);
    this.offerTimer = null;
    const had = Boolean(this.offer);
    this.offer = null;
    if (had && !quiet) this.pushStatus();
  }

  async decide(approve, lifetime = null, cap = null) {
    const r = this.request;
    if (!r) return;
    // Checked before anything changes: a lifetime or access Apaki does not offer leaves the request waiting.
    const expiresAt = approve ? expiryFor(lifetime, this.now()) : null;
    const capChosen = approve ? capChoice(cap) : null;
    this.request = null;
    const c = this.conns.get(r.conn);
    if (!c || c.session.state !== 'pair-approval') return;
    const step = approve ? await c.session.approve() : await c.session.reject();
    for (const f of step.send) this.toRelay(c.id, f);
    if (approve && step.device) {
      const rec = await this.addDevice({ ...step.device, expiresAt, cap: capChosen });
      this.opened(c, rec);
      this.pushStatus({ paired: { id: rec.id, name: rec.name } });
      return;
    }
    // Rejected, or approved too late: the phone was told; free its relay slot.
    unref(setTimeout(() => { this.kick(c.id); this.dropConn(c.id); }, 1500));
    if (approve) throw new Error('That phone waited too long; show a new code and pair again.');
  }

  /**
   * Removes a phone: its record and secret go, it is disconnected now and can
   * never reconnect. expired: its lifetime ran out (the phone is told so).
   * The id is remembered as removed, so another engine's older view of the
   * folder cannot bring it back (mergeState).
   */
  async revoke(deviceId, { expired = false } = {}) {
    await this.syncBeforeWrite();
    const had = this.state.devices.some((d) => d.id === deviceId);
    if (!had) return;
    this.state.devices = this.state.devices.filter((d) => d.id !== deviceId);
    this.state.removed = [...(this.state.removed || []).filter((r) => r.id !== deviceId), { id: deviceId, at: new Date().toISOString() }];
    if (this.secret) {
      const { [deviceId]: _gone, ...psks } = this.secret.psks || {};
      this.secret.psks = psks;
      await this.saveSecretNow();
    }
    this.saveStateNow();
    for (const c of [...this.conns.values()]) {
      if (c.device?.id !== deviceId) continue;
      if (c.open) {
        const f = await c.session.close(expired ? EXPIRED_REASON : REMOVED_REASON).catch(() => null);
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
    const m = e.message || String(e);
    this.setStatus('error', /^Phone access/.test(m) ? m : `Phone access could not start: ${m}`);
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
      // canSkip: the site could not be checked (not a page that differs), so the sheet may offer Pair without checking the page.
      page: this.page ? { state: this.page.state, version: this.page.version || null, url: this.page.url || null, at: this.page.at, text: this.page.state === 'checking' ? 'Checking the phone page…' : pageText(this.page), canSkip: this.page.state === 'unreachable' } : null,
      pcName: this.pcName,
      protection: this.scheme === 'dpapi-user' ? 'dpapi' : this.scheme ? 'file' : null,
      // The saved keys cannot be opened ('locked' or 'unreadable'): the sheet offers Start over (remoteReset).
      keysProblem: this.keysProblem || null,
      recovered: this.recovered,
      // What the sheet may offer at Allow and on each phone, besides forever.
      lifetimes: [...LIFETIME_DAYS],
      // Private or Connected, and the access a phone may be given (2026-10-10).
      mode: this.mode(),
      caps: [...CAPS],
      // Set when the hourly page re-check turned phone access off: { at, version, url, files, of, text }.
      pageAlarm: this.state.pageAlarm || null,
      lastRecheck: this.lastRecheck,
      devices: this.state.devices.map((d) => ({
        id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen, expiresAt: d.expiresAt || null, connected: connected.has(d.id), panes: (this.engine.phonePanes?.(d.id) || []).length,
        cap: capOf(d),
        ...(d.kind === 'account' ? { kind: 'account', account: d.account || '', by: d.by || '', via: via.get(d.id) || [], paused: this.mode() !== 'connected' } : {}),
      })),
      // The QR address holds the one-time secret: it goes to the desktop window only. unchecked: shown without a page check.
      pairing: this.offer && !this.offer.used ? { url: this.offer.url, exp: this.offer.exp, unchecked: Boolean(this.offer.unchecked) } : null,
      request: this.request ? { sas: this.request.sas, name: this.request.device.name, id: this.request.device.id } : null,
      // An account-link waiting for the person at the PC: who asks, the account's name, the access offered first.
      linkRequest: this.linkRequest ? { id: this.linkRequest.id, account: this.linkRequest.account, by: this.linkRequest.by, via: this.linkRequest.via, cap: this.linkRequest.cap, exp: this.linkRequest.exp } : null,
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
    clearTimeout(this.expiryTimer);
    clearTimeout(this.initTimer);
    clearTimeout(this.linkTimer);
    this.stopRecheck();
    for (const t of this.graceTimers.values()) clearTimeout(t);
    for (const c of this.conns.values()) clearTimeout(c.timer);
  }
}
