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
 * see below), then remotePhoneDecision and remoteNoticeDismiss (2026-10-11,
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
 *     is kept but cannot connect, or is removed with removeAccounts; since
 *     2026-10-11 it can connect, each phone behind it asked on the PC, see
 *     the last note). hello carries mode, and connected phones get
 *     { t: 'mode', mode } when it changes.
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
 *
 * Phone keys, enrollment and Private as of version 2 (2026-10-11,
 * ../remote/ENROLL.md; Arthur: "when a user clicks sign in with phone it
 * should use the phones passkey to see what desktops are connected to that
 * phone ... scanning the desktop phone pairing code should add that phone
 * as a passkey as well", approved the same day with new phones following
 * each PC's mode). WHY each piece is here:
 *   - An account device is one key shared by every phone signed in to the
 *     account, so the PC could not tell phones apart, nor ask about a new
 *     one. Each phone now makes its own key (it never leaves the phone) and
 *     proves it on every account connection: hello carries a per-connection
 *     `nonce`, the phone answers { t: 'via', name, pub, sig } (ECDSA P-256
 *     over "apaki/v1 via" || nonce || pub || name), so a recorded via cannot
 *     be replayed on another connection and a server cannot swap the key.
 *   - An account connection is HELD after hello (no ready event, no cached
 *     events, no ops) until that proof is checked and the phone's record
 *     under the account device allows it (the table in ENROLL.md):
 *     blocked: encrypted close; enrolled or allowed: phone-ok; auto: ok in
 *     Connected, asked in Private; new: in Connected it is let in and the PC
 *     shows a notice with Block (nobody has to be at the PC), in Private it
 *     waits ({ t: 'phone-wait' }) for Allow or Block on the PC, and is
 *     closed when nobody answers in LINK_APPROVAL_MS. Private therefore no
 *     longer refuses account devices (getDevice): every phone behind one
 *     needs an in-person OK, and phones Connected let in by themselves
 *     (auto) are asked again after a switch to Private (setMode).
 *   - A page from before this sends no proof. After VIA_GRACE_MS Connected
 *     lets it in as before (shown as "older page"); Private closes it, since
 *     it cannot be told apart from any other phone of the account.
 *   - Enrollment: the link rides a pairing the person just approved in
 *     person (Allow on this PC), so the phone that scanned the code may add
 *     its Apaki account within ENROLL_WINDOW_MS with no second card
 *     ({ t: 'account-link', enroll: true, phone: { pub, sig } }, the sig over
 *     "apaki/v1 enroll" || nonce || phone pub || account pub). The channel is
 *     end to end, so our servers cannot inject such a message. The account
 *     device gets that phone's access and lifetime, and the phone's key is
 *     recorded under it as enrolled, so it is never asked in either mode.
 *   - Window ops remotePhoneDecision { accountDeviceId, phoneId, action:
 *     allow|block|forget } and remoteNoticeDismiss { id } (never in
 *     PHONE_OPS). Status adds, per account device, phones (+ online), and
 *     at the top phoneRequest (the Private card) and notices (the Connected
 *     "New phone connected" lines).
 *   - A forgotten phone leaves a tombstone (phonesForgot) and an explicit
 *     Allow is stamped (decidedAt), so two engines sharing the folder merge
 *     phones by id without bringing one back or undoing an Allow after a
 *     Block; otherwise a Block wins, then the newer lastSeen (mergeState).
 *
 * The shared view (2026-10-11, ../remote/PROTOCOL.md "Following a desktop pane";
 * Arthur: the phone must show the desktop's tabs and the panes in each, swiping
 * between them, WITHOUT taking a pane over): a phone's local pane can follow a
 * desktop conversation pane (op follow, remote-policy.js). WHY the registry is
 * here: this is the one place that sees every event the engine emits (route),
 * knows which phone connections are open and what each phone may do (capFor).
 *   - `following` maps a phone pane (phone:<deviceId>:<local>) to the desktop
 *     pane it shows. It lives only as long as the phone's connection: when the
 *     last connection of a device leaves, its followers are dropped, and a
 *     reconnecting phone sends follow again (nothing is kept on the PC).
 *   - route() sends every event of a followed desktop pane (FOLLOW_EVENTS) to
 *     each follower too, with the pane id swapped for the phone's own, the
 *     desktop's request id and queued messages left out (followerView).
 *     Nothing is taken over and no second Claude Code process starts: the
 *     engine's single runner for that pane stays the only one.
 *   - a follower's ops are checked in checkPhoneCommand (read-only unless the
 *     phone is 'full') and then run on the desktop pane; the engine's handlers
 *     emit the pane's own events, which are mirrored back by the rule above.
 *   - the desktop window hears { ev: 'followers', paneId, phones: [names] }
 *     whenever the phones watching a pane change, for its "Also on" line.
 *   - held account connections never get any of it (toDevice skips them), and
 *     cannot send follow (onMessage ignores everything but via while held).
 */

import os from 'node:os';
import {
  LIMITS, PcSession, RELAY_CLOSE, checkRelayUrl, createPairingOffer, createPcIdentity, createRoom, decodePcFrame,
  encodePcFrame, exportIdentity, frameType, importIdentity, parseRelayControl, relaySubprotocols, roomIdForToken, roomUrl,
  b64urlDecode, b64urlEncode, deviceIdFor, randomBytes,
} from '../remote/protocol.js';
import { Inbox, Outbox, WIRE_VERSION } from '../remote/wire.js';
import { MIN_PHONE_APP, parseVersion, phoneAppState } from '../remote/compat.js';
import { APP_VERSION } from './app-version.js';
import { BROADCAST_EVENTS, PHONE_OPS, checkPhoneCommand, hashText, parsePhoneId, phoneView, routeEvent } from './remote-policy.js';
import { CAPS, CAP_LABEL, AskGate, capDefaultMode, capFollowNote, capNote, capOf, followerView, phonePaneId } from './remote-policy.js';
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
/** An account connection waits this long after hello for a version 2 via; none means a page from before phone keys (ENROLL.md). */
const VIA_GRACE_MS = 8_000;
/** A phone paired through Allow on this PC this recently may add its Apaki account with no card (ENROLL.md). */
const ENROLL_WINDOW_MS = 15 * 60_000;
/** At most this many phone notices ("New phone connected") are kept, newest first. */
const MAX_NOTICES = 5;
/** What each signature is over (ENROLL.md): a label, the connection's nonce, then the keys (and the name for via). */
const VIA_LABEL = 'apaki/v1 via';
const ENROLL_LABEL = 'apaki/v1 enroll';
const utf8 = new TextEncoder();

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
/**
 * The encrypted close an account connection got when the PC switched to Private (it says neither "removed" nor "expired", so the phone keeps the PC).
 * Version 1; since 2026-10-11 Private lets account devices connect and asks per phone (PRIVATE_ASK_CLOSE below), so nothing sends this now.
 */
const PRIVATE_CLOSE = 'This PC switched to Private mode: it only accepts phones paired with its code.';
/** A phone page from before 2026-10-10 gives up on account-link after 10 s, long before a person can answer on the PC. */
const OLD_PAGE_LINK_ERROR = 'This PC now asks you on the PC before it adds an Apaki account, and this phone page cannot wait for that answer. Pair this phone again with a new code from the PC to get the current page.';
/**
 * What a phone behind an Apaki account hears when the PC closes it (ENROLL.md). None of these says "removed" or
 * "expired" (the phone would forget the PC); only BLOCKED says "blocked", which a page reads as "stop reconnecting".
 */
const blockedReason = (pc) => `This phone was blocked on ${pc}. Ask the person at the PC to allow it in its Phone sheet.`;
const askTimeoutReason = (pc) => `Nobody allowed this phone on ${pc} in time.`;
const OLD_PAGE_PRIVATE_CLOSE = 'Update the page: this PC asks about each phone.';
const BAD_VIA_CLOSE = 'This phone could not prove its key to the PC, so the connection was closed.';
const FORGOT_CLOSE = 'This PC forgot this phone. It is asked about again the next time it connects.';
const PRIVATE_ASK_CLOSE = 'This PC switched to Private mode: each phone needs an OK on this PC. Connect again to ask.';
const PHONES_FULL_CLOSE = 'This account already has 20 phones on this PC that cannot be dropped. Forget one in this PC\'s Phone sheet first.';

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

/** When a phone record was last decided or made: an explicit decision on the PC, else when it was first seen. */
const phoneStamp = (p) => String(p.decidedAt || p.firstSeen || '');

/**
 * One phone's two records (mine, then the disk's; ENROLL.md): a Block wins,
 * unless the other side has an explicit decision on the PC (an Allow, a scan
 * in person) made after it; two blocks, or no block, keep the one seen more
 * recently (a tie keeps the disk's). lastSeen is the later of the two.
 */
function pickPhone(a, b) {
  let win;
  if ((a.state === 'blocked') !== (b.state === 'blocked')) {
    const [blocked, other] = a.state === 'blocked' ? [a, b] : [b, a];
    win = other.decidedAt && String(other.decidedAt) > phoneStamp(blocked) ? other : blocked;
  } else {
    win = String(a.lastSeen || '') > String(b.lastSeen || '') ? a : b;
  }
  return { ...win, lastSeen: later(a.lastSeen, b.lastSeen) };
}

/**
 * The phone records of one account device from two views of the same folder
 * (mine, disk): by id, a record either side forgot (phonesForgot: { id, at })
 * is gone unless it was first seen after the forgetting, then pickPhone.
 * Returns { phones, phonesForgot }. Exported for the tests.
 */
export function mergePhoneLists(mine = {}, disk = {}) {
  const forgot = new Map();
  for (const r of [...(disk.phonesForgot || []), ...(mine.phonesForgot || [])]) {
    if (!r?.id) continue;
    const prev = forgot.get(r.id);
    if (!prev || String(r.at || '') > String(prev.at || '')) forgot.set(r.id, r);
  }
  // Each side is filtered before they meet, so an older copy of a forgotten phone cannot beat a new record of it.
  const alive = (list) => (list || []).filter((p) => p?.id && (!forgot.has(p.id) || String(p.firstSeen || '') > String(forgot.get(p.id).at || '')));
  const byId = new Map();
  for (const p of alive(mine.phones)) byId.set(p.id, { ...p });
  for (const p of alive(disk.phones)) {
    const prev = byId.get(p.id);
    byId.set(p.id, prev ? pickPhone(prev, p) : { ...p });
  }
  return { phones: [...byId.values()], phonesForgot: [...forgot.values()].slice(-50) };
}

/** Puts a merged { phones, phonesForgot } on a device record (each key only when it has something). */
function setPhoneLists(d, m) {
  delete d.phones;
  delete d.phonesForgot;
  if (m.phones.length) d.phones = m.phones;
  if (m.phonesForgot.length) d.phonesForgot = m.phonesForgot;
  return d;
}

/**
 * Merges this engine's state with the state.json another engine wrote (same
 * room). Every mutation here reads the file first and writes right after, so
 * the file is the newest view of every field except the phones: a phone
 * either side knows stays unless either side removed it (removed: { id, at },
 * which wins over a pairing older than the removal), and lastSeen is the
 * later of the two. The phone keys behind an account device merge by id
 * (mergePhoneLists). Exported for the tests.
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
    const merged = prev ? { ...prev, ...d, lastSeen: later(prev.lastSeen, d.lastSeen) } : { ...d };
    // The file's list would replace mine whole above: merge the phone keys behind an account device instead (2026-10-11).
    if (prev && (prev.phones || d.phones || prev.phonesForgot || d.phonesForgot)) {
      setPhoneLists(merged, mergePhoneLists(prev, d));
    }
    byId.set(d.id, merged);
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
  // folder: a phone may move a session into a folder and make one (2026-10-12); renaming and deleting stay on the PC.
  // askSearch is a phone op since 2026-10-12 (a refusal now says why itself: access, a question that is not text).
  transcribe: 'Dictation here uses your phone keyboard\'s microphone.',
  digPrompt: 'Dig deeper runs from the PC.',
  stopSession: 'Stop a conversation from its own pane on this phone.',
  revealFolder: 'Showing a folder happens on the PC.',
};

const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url || ''); } };
const unref = (t) => { t?.unref?.(); return t; };
/** The bytes a signature covers: the parts one after the other (ENROLL.md). */
function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
/** A phone's name as the PC shows it: no control characters, at most 64 characters. */
const cleanName = (name) => String(name ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 64);

/** Clears what a connection carries for phone keys (a new connection, or a phone starting over on the same one). */
function resetPhoneState(c) {
  clearTimeout(c.graceTimer);
  Object.assign(c, { nonce: null, held: false, phone: null, ask: null, legacy: false, via: null, graceTimer: null, viaChain: Promise.resolve(), viaBusy: false });
}

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
   *   askPane(askId), knownCwd(cwd), phoneSessions(deviceId), hasOp(op); desktopPane(id) -> 'conversation' | another kind
   *   ('viewer', 'browser', 'task') | null, which is what makes a desktop pane followable (2026-10-11)
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
    // Phone keys behind account devices (ENROLL.md): Private-mode questions waiting for the person at the PC (askPhone;
    // the first is shown as status phoneRequest), the "New phone connected" lines (newest first), and the timings
    // (tests shorten them): how long an account connection waits for a version 2 via, and the enrollment window.
    this.asks = [];
    this.notices = [];
    this.viaGraceMs = o.viaGraceMs ?? VIA_GRACE_MS;
    this.enrollWindowMs = o.enrollWindowMs ?? ENROLL_WINDOW_MS;
    // The page re-check's pause before its confirming fetch, and its retry for a version not fully published yet (2026-10-11).
    this.recheckPauseMs = o.recheckPauseMs ?? 20000;
    this.recheckRetryMs = o.recheckRetryMs ?? 60000;
    // Capability notes for phone panes that opened a session: sent after its history, which redraws the pane (route).
    this.capNotes = new Map();
    // One Ask Claude at a time per phone (remote-policy.js AskGate, 2026-10-12): a question costs about a cent.
    this.askGate = new AskGate(o.askMaxMs);
    // The shared view (2026-10-11): phone pane id (phone:<deviceId>:<local>) -> { deviceId, desktopPaneId }, and the follower
    // lists the desktop window was last told (desktop pane id -> JSON of the names), so it hears a change once.
    this.following = new Map();
    this.followerSeen = new Map();
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
    // Which phone app each connected phone runs (compat.js): device id, or `${account device id}:${phone key id}`. Memory only.
    this.clientApps = new Map();
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
    for (const m of secret.devices || []) {
      if (!psks[m.id]) continue;
      const d = { ...m, lastSeen: known.get(m.id)?.lastSeen ?? m.lastSeen ?? null };
      // The phone keys behind an account device (2026-10-11): what both files knew, so a rebuild never forgets a Block.
      const k = known.get(m.id);
      if (k && (k.phones || k.phonesForgot || m.phones || m.phonesForgot)) setPhoneLists(d, mergePhoneLists(k, m));
      devices.push(d);
    }
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
    // 2026-10-11: Private no longer shuts an account device out (version 1 did, SECURITY.md 4.1). It connects, is held
    // after hello, and each phone behind it needs an OK on this PC (applyPhone), so Private still means an in-person yes.
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
    // The phone keys behind an account device (ENROLL.md): the ones given, else the ones the replaced record had
    // (an account linked again keeps what the PC knows about its phones).
    const prev = this.state.devices.find((d) => d.id === rec.id);
    const phones = device.phones || prev?.phones;
    if (device.kind === 'account' && phones?.length) rec.phones = phones;
    const forgot = device.phonesForgot || prev?.phonesForgot;
    if (device.kind === 'account' && forgot?.length) rec.phonesForgot = forgot;
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
    // A phone changed to a restricted access keeps watching the desktop panes it follows, read only from now on (checkPhoneCommand
    // reads the live access on every command; this is the label the follower's events carry).
    this.noteCap(deviceId, next);
    if (this.secret) await this.saveSecretNow();
    this.saveStateNow();
    for (const c of this.conns.values()) if (c.open && c.device?.id === deviceId) c.outbox?.send({ t: 'cap', cap: next }).catch(() => {});
    this.log(`${d.name || 'a phone'} is now set to ${CAP_LABEL[next]}`);
    try { this.engine.capChanged?.(deviceId, next); } catch (e) { this.log(`applying ${CAP_LABEL[next]} to its panes: ${e.message}`); }
  }

  /**
   * Private or Connected (SECURITY.md 4.4). Private refuses account links
   * (except enrollment, which rides an in-person pairing), drops a pending
   * one, and handles the account devices: they are removed (removeAccounts),
   * or kept, and then every account connection whose phone Connected let in
   * by itself (auto), and every page that sends no phone key, is closed, so
   * those phones are asked on the PC when they connect again (2026-10-11;
   * before that every account connection was closed and none could connect).
   * Phones scanned in person (enrolled) or allowed stay. Every connected
   * phone hears the new mode.
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
        else await this.askAgain(d.id);
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
    // 'phone-key' and 'enroll' (2026-10-11, ENROLL.md), in Private and Connected both: this PC checks a phone key on
    // account connections (a version 2 via), and accepts account-link with enroll right after an in-person pairing.
    // 'follow' (2026-10-11, in both modes): follow and unfollow work, so the phone can show a desktop pane without taking it
    // over; a page feature-detects this and falls back to open (which takes the session over) on an older PC.
    return ['mode', 'cap', 'phone-key', 'enroll', 'follow', ...(this.mode() === 'connected' ? ['account-ask'] : [])];
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
    this.asks = [];
    this.notices = [];
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
      clearTimeout(c.graceTimer);
      c.outbox?.close();
      if (c.open && c.device && !c.held) devices.add(c.device.id);
    }
    this.conns.clear();
    this.request = null;
    // Phones waiting for an OK went with the socket: nobody to answer, nothing added (their records are dropped).
    this.clearAsks();
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
    // Phone keys behind an account device (ENROLL.md): nonce (new for each opened channel), held (an account connection
    // waits after hello), phone ({ id, pub, name } once a version 2 via checked out), ask (the Private question it waits
    // on), legacy (let in after VIA_GRACE_MS without a via: an older page), graceTimer, viaChain.
    resetPhoneState(c);
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
    clearTimeout(c.graceTimer);
    c.outbox?.close();
    let changed = false;
    if (this.request?.conn === id) { this.request = null; changed = true; }
    if (this.linkRequest?.conn === id) { this.dropLinkRequest(); changed = true; }
    // A phone waiting for an OK that goes away takes its question with it (when it was the last one asking).
    if (c.ask) { this.leaveAsk(c); changed = true; }
    // A connection still held at hello was never "in": it does not keep the account's panes alive.
    if (c.open && c.device && !c.held) { this.afterLeave(c.device.id); changed = true; }
    if (c.held) changed = true;
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
      this.leaveAsk(c);
      resetPhoneState(c);
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
    // features: what this PC understands beyond commands (an older Apaki sends none; helloFeatures).
    const self = this.state.devices.find((d) => d.id === device.id);
    const cap = capOf(self);
    // Each opened channel gets its own nonce (2026-10-11): a phone key's proof and an enrollment are signed over it,
    // so neither can be replayed on another connection (ENROLL.md).
    c.nonce = randomBytes(16);
    // An Apaki account's device is shared by every phone signed in to the account: the connection is HELD after hello
    // (no ready event, no cached events, no ops) until the phone behind it proves its own key and this PC's rule for
    // that phone lets it in (onVia, applyPhone). An older page sends no proof: viaGrace decides after VIA_GRACE_MS.
    c.held = self?.kind === 'account';
    if (!c.held) {
      this.cancelGrace(device.id);
      this.touchDevice(device.id);
    }
    // expiresAt: when this phone's pairing runs out (null: never), so the phone can show it and explain an expiry.
    // mode (Private or Connected) and cap (what this phone may make Claude do), since 2026-10-10.
    c.outbox.send({ t: 'hello', v: WIRE_VERSION, appVersion: APP_VERSION, minPhoneApp: MIN_PHONE_APP, pcName: this.pcName, ops: this.phoneOps(), features: this.helloFeatures(), expiresAt: self?.expiresAt || null, mode: this.mode(), cap, nonce: b64urlEncode(c.nonce), ...(self?.kind === 'account' ? { asAccount: true } : {}) });
    if (c.held) {
      c.graceTimer = unref(setTimeout(() => this.viaGrace(c).catch((e) => this.log(`phone key grace: ${e.message}`)), this.viaGraceMs));
    } else {
      this.sendReady(c);
    }
    this.pushStatus();
  }

  /** The ready event and the cached broadcasts: what a connection gets once it is in (not before, for a held one). */
  sendReady(c) {
    const cap = capOf(this.state.devices.find((d) => d.id === c.device?.id));
    // The ready event a phone gets names the mode its panes start in, never the desktop's default (SECURITY.md 5 item 4).
    c.outbox.push({ ...phoneView(this.readyEvent()), mode: capDefaultMode(cap) });
    for (const ev of this.cache.values()) c.outbox.push(phoneView(ev));
  }

  ended(c, ev) {
    const was = c.open;
    c.open = false;
    c.outbox?.close();
    if (ev.type === 'error') this.log(`phone connection ${c.id}: ${ev.code} (${ev.message})`);
    let changed = false;
    if (this.request?.conn === c.id) { this.request = null; changed = true; }
    if (this.linkRequest?.conn === c.id) { this.dropLinkRequest(); changed = true; }
    if (c.ask) { this.leaveAsk(c); changed = true; }
    clearTimeout(c.graceTimer);
    if (was && c.device && !c.held) { this.afterLeave(c.device.id); changed = true; }
    if (was && c.held) changed = true;
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
    // Held (an account connection that has not been let in yet): the only thing it may say is via (ENROLL.md).
    if (c.held && !(msg && msg.t === 'via')) return;
    if (msg && msg.t === 'cmd') this.command(c, msg.cmd);
    else if (msg && msg.t === 'client') this.clientInfo(c, msg);
    else if (msg && msg.t === 'account-link') this.accountLink(c, msg).catch((e) => this.log(`account link: ${e.message}`));
    else if (msg && msg.t === 'account-unlink') this.accountUnlink(c, msg).catch((e) => this.log(`account unlink: ${e.message}`));
    else if (msg && msg.t === 'via') {
      // Which phone is behind an account device's connection, for the Phone sheet; version 2 proves the phone's own key.
      // One connection's vias are handled in order (a second one must see what the first one decided).
      c.viaChain = c.viaChain.then(() => this.onVia(c, msg)).catch((e) => this.log(`via: ${e.message}`));
    }
  }

  /**
   * The phone app says which app it is ({ t: 'client', kind, version }, apaki/remote/compat.js), so the Phone sheet can say
   * when it is older than this PC wants (statusInfo, app). Only the native apps send it. Kept in memory while this engine
   * runs, per phone; nothing about it is saved. A message that does not make sense is ignored.
   */
  clientInfo(c, msg) {
    const kind = msg.kind === 'ios' || msg.kind === 'android' ? msg.kind : null;
    const version = typeof msg.version === 'string' ? msg.version.trim().slice(0, 32) : '';
    if (!kind || !parseVersion(version) || !c.device) return;
    const key = c.phone ? `${c.device.id}:${c.phone.id}` : c.device.id;
    const was = this.clientApps.get(key);
    this.clientApps.set(key, { kind, version });
    if (was?.kind !== kind || was?.version !== version) this.pushStatus();
  }

  /** A phone's app as the Phone sheet shows it: { kind, version, min, state: 'ok' | 'old' | 'unknown' }, or null when it never said. */
  appInfo(a) {
    return a ? { kind: a.kind, version: a.version, min: MIN_PHONE_APP, state: phoneAppState(a.version, MIN_PHONE_APP) } : null;
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
   *
   * Exception (2026-10-11, ENROLL.md): right after a pairing the person just
   * approved on this PC, the phone that paired may add its account with no
   * card, in Private too (enrollCheck, enrollAccount); everything else
   * is as above.
   */
  async accountLink(c, msg) {
    const reqId = String(msg.reqId || '').slice(0, 40);
    const answer = (v) => c.outbox?.send({ t: 'account-linked', reqId, ...v }).catch(() => {});
    try {
      // Enrollment (2026-10-11, ENROLL.md): a phone paired through Allow on this PC a moment ago adds its account with no
      // card, in Private too; anything else is the version 1 rule below (Connected asks, Private refuses).
      const enroll = await this.enrollCheck(c, msg);
      if (!enroll && this.mode() !== 'connected') { answer({ error: PRIVATE_LINK_ERROR, code: 'private' }); return; }
      // An older page gives up after 10 s; holding its request would leave an account device whose secret nobody has.
      if (!enroll && msg.wait !== true) { answer({ error: OLD_PAGE_LINK_ERROR, code: 'old-page' }); return; }
      const raw = b64urlDecode(String(msg.pub || ''));
      if (raw.length !== 65 || raw[0] !== 4) throw new Error('that is not an account key');
      await globalThis.crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const id = await deviceIdFor(raw);
      if (id === c.device.id) throw new Error('a device cannot link itself');
      const others = this.state.devices.filter((d) => d.kind === 'account' && d.id !== id);
      if (others.length >= MAX_ACCOUNT_DEVICES) throw new Error(`this PC already has ${MAX_ACCOUNT_DEVICES} Apaki accounts linked; remove one in its Phone sheet first`);
      if (enroll) { answer(await this.enrollAccount(c, msg, raw, id, enroll)); return; }
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

  /* ===== phone keys behind an account device (apaki/remote/ENROLL.md, 2026-10-11) ===== */

  /** An account device's record in the saved state, or null. */
  accountRec(id) {
    const d = this.state.devices.find((x) => x.id === id);
    return d && d.kind === 'account' ? d : null;
  }

  /** True while the connection is the one this bridge knows and its channel is open. */
  isLive(c) {
    return this.conns.get(c.id) === c && c.open;
  }

  /**
   * The phone's sign-in on an account connection: { t: 'via', name, pub, sig }
   * (version 2) proves the phone's own key; { t: 'via', name } (version 1, an
   * older page) only names it. A direct pairing may send a name too. A second
   * version 2 via with another key on the same connection closes it.
   */
  async onVia(c, msg) {
    if (!this.isLive(c)) return;
    const self = this.state.devices.find((d) => d.id === c.device.id);
    const name = cleanName(msg?.name);
    if (self?.kind !== 'account' || msg.pub === undefined) {
      if (c.phone) return; // its key is proven already: a version 1 via changes nothing
      c.via = name;
      this.pushStatus();
      return;
    }
    if (c.phone) {
      // The same key again is nothing new; another key on this connection is a phone trying to be two.
      let same = false;
      try { same = b64urlEncode(b64urlDecode(String(msg.pub))) === c.phone.pub; } catch { /* not even a key */ }
      if (!same) await this.closeConn(c, BAD_VIA_CLOSE);
      return;
    }
    // viaBusy: the grace timer must not decide while the proof is being checked.
    c.viaBusy = true;
    let proof;
    try {
      proof = await this.verifyVia(c, msg);
    } catch (e) {
      c.viaBusy = false;
      this.log(`phone key from ${c.device.name || 'an account phone'} refused: ${e.message}`);
      await this.closeConn(c, BAD_VIA_CLOSE);
      return;
    }
    const phoneId = await deviceIdFor(proof.pub);
    c.viaBusy = false;
    if (!this.isLive(c)) return;
    clearTimeout(c.graceTimer);
    c.graceTimer = null;
    c.phone = { id: phoneId, pub: b64urlEncode(proof.pub), name: name || 'Phone' };
    c.via = c.phone.name;
    await this.applyPhone(c);
  }

  /**
   * Checks a version 2 via against this connection's nonce: the phone key is a
   * P-256 point, and sig (64 bytes, r||s) is ECDSA / SHA-256 over
   * "apaki/v1 via" || nonce || pub || name as the phone sent it. Returns
   * { pub } (raw bytes) or throws.
   */
  async verifyVia(c, msg) {
    if (!c.nonce) throw new Error('no nonce on this connection');
    if (typeof msg.name !== 'string' || msg.name.length > 128) throw new Error('the name is not usable');
    const pub = b64urlDecode(String(msg.pub || ''));
    const sig = b64urlDecode(String(msg.sig || ''));
    if (pub.length !== 65 || pub[0] !== 4) throw new Error('that is not a phone key');
    if (sig.length !== 64) throw new Error('the signature is not 64 bytes');
    const subtle = globalThis.crypto.subtle;
    const key = await subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, concatBytes(utf8.encode(VIA_LABEL), c.nonce, pub, utf8.encode(msg.name)));
    if (!ok) throw new Error('the signature does not match');
    return { pub };
  }

  /**
   * No version 2 via arrived within VIA_GRACE_MS of hello: an older page.
   * Connected lets it in as before (no phone-ok: it would not know it; the
   * Phone sheet says "older page"); Private closes it, since it cannot be told
   * apart from any other phone of the account.
   */
  async viaGrace(c) {
    c.graceTimer = null;
    if (!this.isLive(c) || !c.held || c.phone || c.viaBusy) return;
    if (this.mode() === 'connected') {
      this.log(`${c.via || 'a phone'} behind ${c.device.name} sent no phone key; letting it in as an older page`);
      this.letIn(c, { legacy: true });
      return;
    }
    await this.closeConn(c, OLD_PAGE_PRIVATE_CLOSE);
  }

  /**
   * Applies this PC's rule to a phone whose key is proven (the table in
   * ENROLL.md): blocked is closed; enrolled or allowed is let in; auto is let
   * in in Connected and asked in Private; a new phone is let in with a notice
   * in Connected (recorded as auto) and asked in Private (recorded as pending).
   */
  async applyPhone(c) {
    await this.syncBeforeWrite();
    if (!this.isLive(c) || !c.phone) return;
    const acct = this.accountRec(c.device.id);
    if (!acct) { await this.closeConn(c, REMOVED_REASON); return; }
    const p = c.phone;
    const now = new Date().toISOString();
    let rec = acct.phones?.find((x) => x.id === p.id);
    if (rec?.state === 'blocked') { await this.closeConn(c, blockedReason(this.pcName)); return; }
    const connected = this.mode() === 'connected';
    if (rec && (rec.state === 'enrolled' || rec.state === 'allowed' || (rec.state === 'auto' && connected))) {
      rec.lastSeen = now;
      if (p.name) rec.name = p.name;
      this.saveStateQuietly();
      this.admit(c);
      return;
    }
    if (!rec && connected) {
      rec = this.newPhoneRecord(acct, p, 'auto', now);
      if (!this.putPhone(acct, rec)) { await this.closeConn(c, PHONES_FULL_CLOSE); return; }
      this.addNotice(acct, rec);
      this.saveStateQuietly();
      this.log(`${rec.name} connected through the Apaki account "${acct.account || acct.name}" for the first time`);
      this.admit(c);
      return;
    }
    // Private (an unknown phone, or one Connected let in by itself), or a question already open for this phone.
    // A connection let in already (an older page whose key proof came late) is closed instead: it asks cleanly when it connects again.
    if (!c.held) { await this.closeConn(c, PRIVATE_ASK_CLOSE); return; }
    this.askPhone(c, acct, rec);
  }

  /** Tells the phone it is in (phone-ok), and lets a held connection through: ready event and cached events follow. */
  admit(c) {
    c.outbox?.send({ t: 'phone-ok' }).catch(() => {});
    if (c.held) this.letIn(c);
    else { c.legacy = false; this.pushStatus(); }
  }

  /** A held connection becomes a live one: no ready event or cache went out before this. legacy: let in without a key (an older page). */
  letIn(c, { legacy = false } = {}) {
    if (!c.held) return;
    c.held = false;
    clearTimeout(c.graceTimer);
    c.graceTimer = null;
    if (legacy) c.legacy = true;
    this.cancelGrace(c.device.id);
    this.touchDevice(c.device.id);
    this.sendReady(c);
    this.pushStatus();
  }

  /** A new phone record under an account device; firstSeen is always after the phone's last forgetting (mergePhoneLists). */
  newPhoneRecord(acct, p, state, now) {
    const tomb = acct.phonesForgot?.find((r) => r.id === p.id);
    const first = tomb?.at && String(tomb.at) >= now ? new Date(Date.parse(tomb.at) + 1).toISOString() : now;
    return { id: p.id, pub: p.pub, name: p.name || 'Phone', state, firstSeen: first, lastSeen: now };
  }

  /**
   * Adds (or replaces) a phone record under an account device. At MAX_PHONES the
   * least recently seen record that is not blocked goes (its connections are
   * closed, it is asked about again as a new phone). False when every record is
   * blocked, so nothing could be dropped.
   */
  putPhone(acct, rec) {
    const list = acct.phones || (acct.phones = []);
    const i = list.findIndex((x) => x.id === rec.id);
    if (i >= 0) { list[i] = rec; return true; }
    if (list.length >= store.MAX_PHONES) {
      const seen = (x) => String(x.lastSeen || x.firstSeen || '');
      const oldest = list.filter((x) => x.state !== 'blocked').sort((a, b) => (seen(a) < seen(b) ? -1 : seen(a) > seen(b) ? 1 : 0))[0];
      if (!oldest) return false;
      this.removePhone(acct, oldest.id);
      this.closePhoneConns(acct.id, oldest.id, FORGOT_CLOSE).catch(() => {});
    }
    (acct.phones || (acct.phones = [])).push(rec);
    return true;
  }

  /** Drops a phone record and remembers that it was forgotten (phonesForgot), so another engine's older copy cannot bring it back. */
  removePhone(acct, phoneId) {
    acct.phones = (acct.phones || []).filter((x) => x.id !== phoneId);
    if (!acct.phones.length) delete acct.phones;
    acct.phonesForgot = [...(acct.phonesForgot || []).filter((r) => r.id !== phoneId), { id: phoneId, at: new Date().toISOString() }].slice(-50);
  }

  /** Closes (encrypted, with `reason`) every connection of one phone key behind an account device, held or live. */
  async closePhoneConns(accountId, phoneId, reason) {
    for (const c of [...this.conns.values()]) {
      if (c.device?.id === accountId && c.phone?.id === phoneId) await this.closeConn(c, reason);
    }
  }

  /** After a Block: when no phone is left connected through that account, its conversations stop now. */
  closeIdleAccountPanes(accountId) {
    for (const c of this.conns.values()) if (c.open && !c.held && c.device?.id === accountId) return;
    this.cancelGrace(accountId);
    this.closePhonePanes(accountId);
  }

  /** A state write that must not stop a connection (the in-memory record stands; the next write retries). */
  saveStateQuietly() {
    try { this.saveStateNow(); } catch (e) { this.log(`saving state: ${e.message}`); }
  }

  /** The "New phone connected" line for the Phone sheet (Connected: the phone is already in; Block is on the line). */
  addNotice(acct, rec) {
    const n = { id: b64urlEncode(randomBytes(8)), kind: 'new-phone', accountDeviceId: acct.id, phoneId: rec.id, name: rec.name, account: acct.account || '', at: new Date().toISOString() };
    this.notices = [n, ...this.notices.filter((x) => !(x.accountDeviceId === acct.id && x.phoneId === rec.id))].slice(0, MAX_NOTICES);
  }

  /** remoteNoticeDismiss: the line goes away; the phone stays as it is. */
  noticeDismiss(id) {
    this.notices = this.notices.filter((n) => n.id !== id);
  }

  /**
   * Private: a phone the PC has not been told to trust waits on its connection
   * ({ t: 'phone-wait', timeoutMs }) while the Phone sheet asks Allow or Block
   * (status phoneRequest). One question per phone key; more connections of the
   * same phone join it. Nobody answering in LINK_APPROVAL_MS closes them.
   */
  askPhone(c, acct, rec) {
    const p = c.phone;
    const now = new Date().toISOString();
    let ask = this.asks.find((a) => a.accountDeviceId === acct.id && a.phoneId === p.id);
    if (!ask) {
      if (rec) {
        // Kept to go back to when nobody answers (auto stays auto); pending itself is never saved.
        if (rec.state !== 'pending') rec.prev = rec.state;
        rec.state = 'pending';
        rec.lastSeen = now;
        if (p.name) rec.name = p.name;
      } else {
        rec = this.newPhoneRecord(acct, p, 'pending', now);
        if (!this.putPhone(acct, rec)) { this.closeConn(c, PHONES_FULL_CLOSE).catch(() => {}); return; }
      }
      ask = { accountDeviceId: acct.id, phoneId: p.id, name: rec.name, account: acct.account || '', exp: Date.now() + this.linkApprovalMs, conns: new Set(), timer: null };
      const mine = ask;
      ask.timer = unref(setTimeout(() => this.askTimeout(mine).catch((e) => this.log(`phone question: ${e.message}`)), this.linkApprovalMs));
      this.asks.push(ask);
      this.log(`${rec.name} asks to connect through the Apaki account "${acct.account || acct.name}"; waiting for an answer on the PC`);
    }
    ask.conns.add(c.id);
    c.ask = ask;
    c.outbox?.send({ t: 'phone-wait', timeoutMs: Math.max(1000, ask.exp - Date.now()) }).catch(() => {});
    this.pushStatus({ phoneRequested: true });
  }

  /** Ends a question without a word: its timer stops, and the connections that waited on it stop waiting. Returns them. */
  takeAsk(ask) {
    this.asks = this.asks.filter((a) => a !== ask);
    clearTimeout(ask.timer);
    ask.timer = null;
    const conns = [];
    for (const id of ask.conns) {
      const c = this.conns.get(id);
      if (c) { c.ask = null; conns.push(c); }
    }
    ask.conns.clear();
    return conns;
  }

  /** A waiting connection is gone: when it was the last one asking, the question and its pending record go. */
  leaveAsk(c) {
    const ask = c.ask;
    if (!ask) return;
    c.ask = null;
    ask.conns.delete(c.id);
    if (ask.conns.size) return;
    this.takeAsk(ask);
    this.revertPending(ask.accountDeviceId, ask.phoneId);
  }

  /** A pending record nobody answered: a phone that was auto goes back to auto, a new one is dropped (the next try asks again). */
  revertPending(accountId, phoneId) {
    const acct = this.accountRec(accountId);
    const rec = acct?.phones?.find((x) => x.id === phoneId);
    if (!rec || rec.state !== 'pending') return;
    if (rec.prev) {
      rec.state = rec.prev;
      delete rec.prev;
    } else {
      acct.phones = acct.phones.filter((x) => x.id !== phoneId);
      if (!acct.phones.length) delete acct.phones;
    }
    this.saveStateQuietly();
  }

  async askTimeout(ask) {
    if (!this.asks.includes(ask)) return;
    this.log(`nobody allowed ${ask.name} on ${this.pcName} in time`);
    const conns = this.takeAsk(ask);
    this.revertPending(ask.accountDeviceId, ask.phoneId);
    for (const c of conns) await this.closeConn(c, askTimeoutReason(this.pcName));
    this.pushStatus();
  }

  /** Every open question ends silently (the relay socket went, phone access was turned off, or started over). */
  clearAsks() {
    for (const ask of [...this.asks]) {
      this.takeAsk(ask);
      this.revertPending(ask.accountDeviceId, ask.phoneId);
    }
  }

  /**
   * The switch to Private with the account devices kept: connections whose
   * phone Connected let in by itself (auto), and pages that sent no phone key,
   * are closed so those phones are asked on the PC when they connect again.
   * Phones scanned in person or allowed stay connected; a connection that is
   * still being checked meets Private's rules when it gets its answer.
   */
  async askAgain(accountId) {
    const acct = this.accountRec(accountId);
    for (const c of [...this.conns.values()]) {
      if (!c.open || c.device?.id !== accountId || c.ask) continue;
      if (c.phone) {
        const rec = acct?.phones?.find((x) => x.id === c.phone.id);
        if (rec && (rec.state === 'enrolled' || rec.state === 'allowed')) continue;
        if (c.held) continue; // its answer is being worked out (applyPhone reads the mode then)
        await this.closeConn(c, PRIVATE_ASK_CLOSE);
      } else if (!c.held) {
        await this.closeConn(c, OLD_PAGE_PRIVATE_CLOSE);
      }
    }
  }

  /**
   * remotePhoneDecision from the Phone sheet. allow: the phone is trusted from
   * now on (state allowed; a phone waiting at the Private card is let in); block:
   * state blocked, its connections are closed with BLOCKED and its conversations
   * stop when no other phone of the account is connected; forget: the record is
   * dropped, its connections close, and it is a new phone next time.
   */
  async phoneDecision(accountDeviceId, phoneId, action) {
    if (!['allow', 'block', 'forget'].includes(action)) throw new Error('A phone can be allowed, blocked or forgotten.');
    await this.syncBeforeWrite();
    const acct = this.accountRec(accountDeviceId);
    if (!acct) throw new Error('That Apaki account is not linked to this PC any more.');
    const rec = acct.phones?.find((x) => x.id === phoneId);
    if (!rec) throw new Error('This PC does not know that phone any more.');
    const now = new Date().toISOString();
    const ask = this.asks.find((a) => a.accountDeviceId === accountDeviceId && a.phoneId === phoneId);
    const persist = async () => { if (this.secret) await this.saveSecretNow(); this.saveStateNow(); };
    this.notices = this.notices.filter((n) => !(n.accountDeviceId === accountDeviceId && n.phoneId === phoneId));
    if (action === 'allow') {
      delete rec.prev;
      if (rec.state !== 'enrolled') rec.state = 'allowed';
      rec.decidedAt = now;
      await persist();
      this.log(`${rec.name} was allowed through the Apaki account "${acct.account || acct.name}"`);
      if (ask) for (const c of this.takeAsk(ask)) { c.outbox?.send({ t: 'phone-ok' }).catch(() => {}); this.letIn(c); }
    } else if (action === 'block') {
      delete rec.prev;
      rec.state = 'blocked';
      rec.decidedAt = now;
      await persist();
      this.log(`${rec.name} was blocked through the Apaki account "${acct.account || acct.name}"`);
      if (ask) this.takeAsk(ask);
      await this.closePhoneConns(accountDeviceId, phoneId, blockedReason(this.pcName));
      this.closeIdleAccountPanes(accountDeviceId);
    } else {
      this.removePhone(acct, phoneId);
      await persist();
      this.log(`${rec.name} was forgotten for the Apaki account "${acct.account || acct.name}"`);
      if (ask) this.takeAsk(ask);
      await this.closePhoneConns(accountDeviceId, phoneId, FORGOT_CLOSE);
    }
  }

  /**
   * Enrollment (ENROLL.md): does this account-link ride an in-person pairing?
   * It must say enroll: true with a phone key whose signature covers this
   * connection's nonce, the phone key and the account key; come from a direct
   * pairing (not an account device); and that pairing must have been allowed on
   * this PC at most ENROLL_WINDOW_MS ago. Returns { phonePub, self } or null:
   * anything less is not enrollment, and account-link follows version 1 (so a
   * bad signature never adds anything silently).
   */
  async enrollCheck(c, msg) {
    if (msg.enroll !== true || !msg.phone || typeof msg.phone !== 'object' || !c.nonce) return null;
    const self = this.state.devices.find((d) => d.id === c.device.id);
    if (!self || self.kind === 'account') return null;
    const age = this.now() - Date.parse(self.pairedAt || '');
    if (!Number.isFinite(age) || age < 0 || age > this.enrollWindowMs) return null;
    try {
      const accountPub = b64urlDecode(String(msg.pub || ''));
      const phonePub = b64urlDecode(String(msg.phone.pub || ''));
      const sig = b64urlDecode(String(msg.phone.sig || ''));
      if (accountPub.length !== 65 || phonePub.length !== 65 || phonePub[0] !== 4 || sig.length !== 64) return null;
      const subtle = globalThis.crypto.subtle;
      const key = await subtle.importKey('raw', phonePub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, concatBytes(utf8.encode(ENROLL_LABEL), c.nonce, phonePub, accountPub));
      return ok ? { phonePub, self } : null;
    } catch {
      return null;
    }
  }

  /**
   * Adds the account device for an enrollment: the pairing phone's access and
   * lifetime, its phone key recorded as enrolled (so it is never asked, in
   * either mode). An account already linked keeps its secret and the phones
   * the PC knows (another phone scanned in person later adds itself the same
   * way); its access and lifetime follow this pairing. Returns the answer.
   */
  async enrollAccount(c, msg, raw, id, { phonePub, self }) {
    const account = String(msg.name || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Apaki account';
    await this.syncBeforeWrite();
    const now = new Date().toISOString();
    const existing = this.accountRec(id);
    const phoneId = await deviceIdFor(phonePub);
    // Built aside and handed to addDevice with the rest, so it is one write (DPAPI makes each write slow).
    const draft = { id, phones: (existing?.phones || []).map((x) => ({ ...x })), phonesForgot: existing?.phonesForgot ? [...existing.phonesForgot] : [] };
    const phone = { ...this.newPhoneRecord(draft, { id: phoneId, pub: b64urlEncode(phonePub), name: self.name }, 'enrolled', now), decidedAt: now };
    if (!this.putPhone(draft, phone)) throw new Error('this account already has 20 phones on this PC that cannot be dropped; forget one in its Phone sheet first');
    const psk = existing && this.secret?.psks?.[id] ? this.secret.psks[id] : b64urlEncode(randomBytes(32));
    const rec = await this.addDevice({
      id, pub: b64urlEncode(raw), name: `Apaki account (${account})`, kind: 'account', account, by: self.name || c.device.name || 'a phone', psk,
      pairedAt: existing?.pairedAt || now, cap: capOf(self), expiresAt: self.expiresAt || null, phones: draft.phones, phonesForgot: draft.phonesForgot,
    });
    this.log(`${self.name || 'a phone'} added the Apaki account "${account}" right after pairing (enrolled, ${CAP_LABEL[capOf(self)]})`);
    this.pushStatus({ linked: { id: rec.id, name: rec.name } });
    return { deviceId: id, psk, pcName: this.pcName };
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
    // What this phone may make Claude do (2026-10-10), read now so a change on the PC applies to the next command.
    const cap = this.capFor(deviceId);
    this.noteCap(deviceId, cap);
    const r = checkPhoneCommand(cmd, {
      deviceId,
      hasOp: e.hasOp,
      paneExists: e.paneExists,
      paneCount: e.paneCount,
      askPane: e.askPane,
      knownCwd: e.knownCwd,
      // The sessions of this phone's own panes, and of the desktop panes it follows (their history and artifacts are read only).
      phoneSessions: (dev) => [...(e.phoneSessions?.(dev) || []), ...this.followedSessions(dev)],
      // Whether a pane runs a Codex thread (2026-10-12): its model, effort, mode and files are checked as Codex's.
      paneKind: e.paneKind,
      cap,
      // The shared view (2026-10-11): without engine.desktopPane (an engine from before) nothing can be followed.
      followOf: (id) => this.following.get(id)?.desktopPaneId ?? null,
      followLocal: (dev, desktopPaneId) => this.followLocalPane(dev, desktopPaneId),
      followCount: (dev) => this.followCount(dev),
      followsDesktop: (dev, desktopPaneId) => Boolean(this.followLocalPane(dev, desktopPaneId)),
      desktopPane: e.desktopPane ? (id) => e.desktopPane(id) : undefined,
    });
    if (!r.ok) {
      const message = typeof cmd?.op === 'string' && Object.hasOwn(REFUSED, cmd.op) ? REFUSED[cmd.op] : r.error;
      c.outbox.push({ ev: 'error', reqId: r.reqId, paneId: r.paneId, message, refused: true, ...(r.readOnly ? { readOnly: true } : {}) });
      // A refused mode change: the phone already shows the mode it asked for, so it hears the one the pane really has.
      // A pane that follows a desktop pane hears the desktop pane's own settings (model, effort and mode are the desktop's).
      // A refused tune (Ultracode on a phone below Full access) is answered the same way: the toggle goes back to what the pane has.
      if ((cmd?.op === 'mode' || cmd?.op === 'model' || cmd?.op === 'effort' || cmd?.op === 'tune') && r.paneId) {
        const mine = phonePaneId(deviceId, r.paneId);
        const f = this.following.get(mine);
        const info = e.paneInfo?.(f ? f.desktopPaneId : mine);
        if (info?.mode && (f || cmd.op === 'mode' || cmd.op === 'tune')) c.outbox.push({ ev: 'settings', paneId: r.paneId, model: info.model, effort: info.effort, mode: info.mode, ...(info.tune ? { tune: info.tune } : {}) });
      }
      return;
    }
    let out = r.cmd;
    // Ask Claude costs about a cent a question (2026-10-12): one at a time per phone. The answer, or its error, frees it (route).
    if (out.op === 'askSearch') {
      const wait = this.askGate.begin(deviceId, this.now(), out.reqId || null);
      if (wait) {
        c.outbox.push({ ev: 'askSearch', reqId: typeof cmd.reqId === 'string' ? cmd.reqId.slice(0, 64) : null, query: out.query, error: wait });
        return;
      }
    }
    // The shared view (2026-10-11): follow and unfollow (and close of a follower) are the bridge's own; every other op of a
    // follower already names the desktop pane (checkPhoneCommand) and runs there, tagged with who sent it.
    if (out.op === 'follow') { this.startFollow(c, out); return; }
    if (out.op === 'unfollow' || (out.op === 'close' && this.following.has(out.paneId))) { this.endFollow(c, out); return; }
    // origin: this phone's own pane, so a message it sends is not echoed back to it (its page drew the message already).
    if (r.follower) out = { ...out, follower: this.followName(c), ...(r.follower.paneId ? { origin: r.follower.paneId } : {}) };
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
    const r = routeEvent(ev, (deviceId, desktopPaneId) => parsePhoneId(this.followLocalPane(deviceId, desktopPaneId))?.local ?? null);
    if (r) {
      this.toDevice(r.deviceId, phoneView(r.ev));
      // Its question has an answer (or failed): the phone may ask again.
      if (ev.ev === 'askSearch') this.askGate.end(r.deviceId);
      else if (ev.ev === 'error' && typeof ev.reqId === 'string') this.askGate.end(r.deviceId, ev.reqId);
      if (ev.ev === 'opened') this.afterOpened(r.deviceId, ev, r.ev);
      else if (ev.ev === 'history') this.flushCapNote(r.deviceId, ev.paneId);
      else if (ev.ev === 'closed') {
        this.capNotes.delete(ev.paneId);
        // The engine closed a follower pane (the desktop pane went away between the check and the follow).
        this.dropFollower(ev.paneId);
      }
      // The desktop's Phone sheet counts each phone's open conversations.
      if (ev.ev === 'opened' || ev.ev === 'closed') this.panesChanged();
      return true;
    }
    if (ev && BROADCAST_EVENTS.has(ev.ev)) {
      this.cache.set(ev.ev, ev);
      this.broadcast(ev);
    }
    // The shared view (2026-10-11): an event of a desktop pane some phone follows also goes to that phone. The desktop still
    // gets it (false), so nothing about the desktop changes.
    if (this.following.size && ev && typeof ev.paneId === 'string') this.mirror(ev);
    return false;
  }

  toDevice(deviceId, ev) {
    for (const c of this.conns.values()) {
      // A held account connection (not let in yet) hears nothing, not even events about the account's other phones.
      if (!c.open || c.held || c.device?.id !== deviceId) continue;
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
      if (!c.open || c.held) continue;
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
    this.toDevice(deviceId, { ev: 'settings', paneId: phoneEv.paneId, model: ev.model, effort: ev.effort, mode: ev.mode, ...(ev.tune ? { tune: ev.tune } : {}) });
    // A pane that follows a desktop pane runs with the desktop's tools, not this phone's: its note says what the phone may do there.
    const text = ev.follower ? capFollowNote(this.capFor(deviceId)) : capNote(this.capFor(deviceId));
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

  /* ---------- following a desktop pane (2026-10-11) ---------- */

  /** The phone pane (prefixed id) of this device that follows a desktop pane, or null. */
  followLocalPane(deviceId, desktopPaneId) {
    for (const [pane, f] of this.following) if (f.deviceId === deviceId && f.desktopPaneId === desktopPaneId) return pane;
    return null;
  }

  /** How many desktop panes this phone follows now. */
  followCount(deviceId) {
    let n = 0;
    for (const f of this.following.values()) if (f.deviceId === deviceId) n += 1;
    return n;
  }

  /** The sessions of the desktop panes this phone follows (read only: their history and artifacts). */
  followedSessions(deviceId) {
    const out = [];
    for (const f of this.following.values()) {
      if (f.deviceId !== deviceId) continue;
      const sid = this.engine.paneInfo?.(f.desktopPaneId)?.sessionId;
      if (sid) out.push(sid);
    }
    return out;
  }

  /** Keeps each follower's read-only flag in step with its phone's capability (the label on events; checkPhoneCommand reads the live one). */
  noteCap(deviceId, cap) {
    for (const f of this.following.values()) if (f.deviceId === deviceId) f.readOnly = cap !== 'full';
  }

  /** The names a phone shows for itself on the desktop pane it follows: its own name, or for an Apaki account the phones connected through it. */
  followLabels(deviceId) {
    const d = this.state.devices.find((x) => x.id === deviceId);
    const base = cleanName(d?.name) || 'Phone';
    if (d?.kind !== 'account') return [base];
    const live = [];
    for (const c of this.conns.values()) {
      if (!c.open || c.held || c.device?.id !== deviceId) continue;
      const n = cleanName(c.phone?.name || c.via || '').trim();
      if (n && !live.includes(n)) live.push(n);
    }
    return live.length ? live : [base];
  }

  /** The name of the phone behind one connection, for a message it sends into a desktop pane. */
  followName(c) {
    const d = this.state.devices.find((x) => x.id === c.device?.id);
    return cleanName(d?.kind === 'account' ? (c.phone?.name || c.via || d?.name) : d?.name).trim() || 'Phone';
  }

  /** The names of the phones that follow one desktop pane, each once. */
  followerNames(desktopPaneId) {
    const names = [];
    for (const f of this.following.values()) {
      if (f.desktopPaneId !== desktopPaneId) continue;
      for (const n of this.followLabels(f.deviceId)) if (!names.includes(n)) names.push(n);
    }
    return names;
  }

  /** Tells the desktop window who watches a pane, when that changed: { ev: 'followers', paneId, phones: [names] } (empty when nobody does). */
  followersChanged(desktopPaneId) {
    const names = this.followerNames(desktopPaneId);
    const key = JSON.stringify(names);
    if ((this.followerSeen.get(desktopPaneId) ?? '[]') === key) return;
    if (names.length) this.followerSeen.set(desktopPaneId, key); else this.followerSeen.delete(desktopPaneId);
    this.emit({ ev: 'followers', paneId: desktopPaneId, phones: names });
  }

  /** The window (re)attached to a pane: says again who watches it, when anyone does. */
  announceFollowers(desktopPaneId) {
    const names = this.followerNames(desktopPaneId);
    if (!names.length) return;
    this.followerSeen.set(desktopPaneId, JSON.stringify(names));
    this.emit({ ev: 'followers', paneId: desktopPaneId, phones: names });
  }

  /** The desktop panes some phone follows now, as the events a window that connects later needs. */
  followersSnapshot() {
    const panes = new Set([...this.following.values()].map((f) => f.desktopPaneId));
    return [...panes].map((paneId) => ({ ev: 'followers', paneId, phones: this.followerNames(paneId) }));
  }

  /** follow: the phone's pane shows a desktop pane from now on. Registered first, so no event between this and the pane's state is lost. */
  startFollow(c, out) {
    const deviceId = c.device.id;
    const prev = this.following.get(out.paneId);
    this.following.set(out.paneId, { deviceId, desktopPaneId: out.desktopPaneId, readOnly: this.capFor(deviceId) !== 'full' });
    if (prev && prev.desktopPaneId !== out.desktopPaneId) this.followersChanged(prev.desktopPaneId);
    this.followersChanged(out.desktopPaneId);
    // The engine sends the pane's state (opened, history, questions waiting, tasks) to this phone pane only.
    this.dispatch({ op: 'follow', reqId: out.reqId, paneId: out.paneId, desktopPaneId: out.desktopPaneId, readOnly: this.following.get(out.paneId).readOnly });
  }

  /** unfollow, or close of a follower pane: it stops, and says closed like a pane that was closed. */
  endFollow(c, out) {
    const f = this.following.get(out.paneId);
    this.following.delete(out.paneId);
    this.capNotes.delete(out.paneId);
    if (f) this.followersChanged(f.desktopPaneId);
    const mine = parsePhoneId(out.paneId);
    const req = out.reqId ? parsePhoneId(out.reqId) : null;
    if (mine) this.toDevice(c.device.id, { ev: 'closed', reqId: req?.local ?? null, paneId: mine.local });
  }

  /** A follower pane the engine closed (its desktop pane went away before the follow ran). */
  dropFollower(phonePaneId) {
    const f = this.following.get(phonePaneId);
    if (!f) return;
    this.following.delete(phonePaneId);
    this.followersChanged(f.desktopPaneId);
  }

  /** A phone's last connection left, or it was removed: its followers end (a phone that connects again sends follow again). */
  dropDeviceFollowers(deviceId) {
    const gone = new Set();
    for (const [pane, f] of [...this.following]) {
      if (f.deviceId !== deviceId) continue;
      this.following.delete(pane);
      this.capNotes.delete(pane);
      gone.add(f.desktopPaneId);
    }
    for (const desktopPaneId of gone) this.followersChanged(desktopPaneId);
  }

  /** Re-checks the names on every followed pane (a phone behind an account came or went). */
  refreshFollowers() {
    for (const desktopPaneId of new Set([...this.following.values()].map((f) => f.desktopPaneId))) this.followersChanged(desktopPaneId);
  }

  /**
   * An event of a desktop pane: every phone pane that follows it gets it too, with the phone's own pane id (followerView says
   * what is left out). The pane closing ends its followers, after they heard closed.
   */
  mirror(ev) {
    let any = false;
    for (const [pane, f] of [...this.following]) {
      if (f.desktopPaneId !== ev.paneId) continue;
      any = true;
      const view = followerView(ev, { pane, readOnly: f.readOnly });
      if (view) {
        this.toDevice(f.deviceId, phoneView(view));
        // The note a restricted follower reads goes after the history that redraws its pane (flushCapNote).
        if (ev.ev === 'opened') this.afterOpened(f.deviceId, { ...ev, paneId: pane, follower: true }, view);
        else if (ev.ev === 'history') this.flushCapNote(f.deviceId, pane);
      }
      if (ev.ev === 'closed') { this.following.delete(pane); this.capNotes.delete(pane); }
    }
    if (any && ev.ev === 'closed') this.followerSeen.delete(ev.paneId);
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
    for (const c of this.conns.values()) if (c.open && !c.held && c.device?.id === deviceId) return;
    // The shared view (2026-10-11): followers end with the phone's connection (nothing is kept for it); the pane header's
    // "Also on" line goes at once. A phone that connects again sends follow again.
    this.dropDeviceFollowers(deviceId);
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
    // Removed, expired, disconnected or phone access off (idleOnly is the grace timer, long after afterLeave dropped them).
    if (!idleOnly) this.dropDeviceFollowers(deviceId);
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
        // 2026-10-11 (ENROLL.md): Allow, Block or Forget one phone key behind an account device, and dismiss a "New phone connected" line.
        case 'remotePhoneDecision': await this.phoneDecision(String(c.accountDeviceId || ''), String(c.phoneId || ''), String(c.action || '')); break;
        case 'remoteNoticeDismiss': this.noticeDismiss(String(c.id || '')); break;
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
    for (const c of this.conns.values()) { clearTimeout(c.timer); clearTimeout(c.graceTimer); c.outbox?.close(); }
    this.conns.clear();
    this.clearAsks();
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
          // Once more before acting: one odd answer is not a changed site. 2026-10-11: after a pause, so a site
          // that is still spreading a fresh deploy across its edge (a file briefly missing) can settle first.
          await new Promise((res) => setTimeout(res, this.recheckPauseMs));
          const again = await check();
          if (again?.state === 'differs') {
            // A version this PC never saw check out is not "changed": it is not fully published yet (the incident:
            // phone access went off minutes after a deploy). Try again in a minute instead of turning access off.
            // A version it verified before that now differs still turns phone access off: that is the real alarm.
            const verified = Boolean(again.version) && store.loadPages(this.dir).some((p) => p.version === again.version);
            if (!verified) {
              this.log(`the phone page ${again.url || ''} is not fully available yet (${[...(again.differs || []), ...(again.missing || [])].slice(0, 5).join(', ')}); checking again in a minute`);
              clearTimeout(this.pendingRecheck);
              this.pendingRecheck = setTimeout(() => { this.pendingRecheck = null; this.recheckPages().catch(() => {}); }, this.recheckRetryMs);
              this.pendingRecheck.unref?.();
              results.push(again);
              continue;
            }
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
    for (const k of [...this.clientApps.keys()]) if (k === deviceId || k.startsWith(`${deviceId}:`)) this.clientApps.delete(k);
    // An account removed takes its phone keys and their "New phone connected" lines with it.
    this.notices = this.notices.filter((n) => n.accountDeviceId !== deviceId);
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
    const online = new Set(); // `${account device id}:${phone id}`: phone keys with a connection that is in
    for (const c of this.conns.values()) {
      // A held account connection (not let in yet) is not connected: the phone behind it may be refused.
      if (!c.open || !c.device || c.held) continue;
      connected.add(c.device.id);
      if (c.phone) online.add(`${c.device.id}:${c.phone.id}`);
      // A phone key's own name; an older page (no key proof) is marked as such; a direct pairing's via is its plain name.
      const label = c.phone ? c.phone.name : c.legacy ? `${c.via || 'A phone'} (older page)` : c.via;
      if (label) via.set(c.device.id, [...(via.get(c.device.id) || []), label]);
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
      protection: this.scheme === 'dpapi-user' ? 'dpapi' : this.scheme === 'keychain-aes' ? 'keychain' : this.scheme ? 'file' : null,
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
        // The phone app it runs and whether this PC wants a newer one (compat.js); null until the phone says.
        app: this.appInfo(this.clientApps.get(d.id)),
        // phones (2026-10-11, ENROLL.md): the phone keys behind an account device, with whether each is connected now.
        // No paused flag any more: Private lets an account device connect and asks about each phone.
        ...(d.kind === 'account' ? { kind: 'account', account: d.account || '', by: d.by || '', via: via.get(d.id) || [], phones: (d.phones || []).map((p) => ({ id: p.id, pub: p.pub, name: p.name, state: p.state, firstSeen: p.firstSeen || null, lastSeen: p.lastSeen || null, online: online.has(`${d.id}:${p.id}`), app: this.appInfo(this.clientApps.get(`${d.id}:${p.id}`)) })) } : {}),
      })),
      // The QR address holds the one-time secret: it goes to the desktop window only. unchecked: shown without a page check.
      pairing: this.offer && !this.offer.used ? { url: this.offer.url, exp: this.offer.exp, unchecked: Boolean(this.offer.unchecked) } : null,
      request: this.request ? { sas: this.request.sas, name: this.request.device.name, id: this.request.device.id } : null,
      // An account-link waiting for the person at the PC: who asks, the account's name, the access offered first.
      linkRequest: this.linkRequest ? { id: this.linkRequest.id, account: this.linkRequest.account, by: this.linkRequest.by, via: this.linkRequest.via, cap: this.linkRequest.cap, exp: this.linkRequest.exp } : null,
      // A phone key waiting for an Allow or Block in Private (the first question; the rest follow), and the "New phone connected" lines (Connected), newest first.
      phoneRequest: this.asks[0] ? { accountDeviceId: this.asks[0].accountDeviceId, phoneId: this.asks[0].phoneId, name: this.asks[0].name, account: this.asks[0].account, exp: this.asks[0].exp } : null,
      notices: this.notices.slice(0, MAX_NOTICES).map((n) => ({ ...n })),
    };
  }

  pushStatus(extra = {}) {
    this.emit({ ...this.statusInfo(), ...extra });
    // The names on the desktop panes' "Also on" lines follow the phones that are connected (an account's phones come and go).
    if (this.following.size) this.refreshFollowers();
  }

  /** Stops everything (the engine is exiting). */
  stop() {
    this.closeSocket();
    clearTimeout(this.pendingRecheck);
    clearTimeout(this.offerTimer);
    clearTimeout(this.panesTimer);
    clearTimeout(this.expiryTimer);
    clearTimeout(this.initTimer);
    clearTimeout(this.linkTimer);
    this.stopRecheck();
    for (const t of this.graceTimers.values()) clearTimeout(t);
    for (const c of this.conns.values()) { clearTimeout(c.timer); clearTimeout(c.graceTimer); }
    for (const a of this.asks) clearTimeout(a.timer);
  }
}
