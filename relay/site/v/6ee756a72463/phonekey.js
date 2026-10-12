/**
 * phonekey.js: the phone key, what it signs, and the small decisions the page
 * makes around it (2026-10-11, apaki/remote/ENROLL.md, version 2).
 *
 * The phone key is an ECDSA P-256 key pair made once per phone (per browser
 * profile, per app install). Its private half never leaves the phone: store.js
 * keeps it as a non-extractable CryptoKey, the iOS app keeps it in the Secure
 * Enclave (native-store.js). It tells the phones of one Apaki account apart,
 * so a PC can apply its rule (allow, ask, block) to each phone. The page only
 * ever holds a "phone key" object here: { pub, sign(bytes) }, with pub the raw
 * 65-byte public key and sign giving the 64-byte r||s ECDSA / SHA-256
 * signature that WebCrypto and the Secure Enclave both produce.
 *
 * Nothing in this file touches the DOM, IndexedDB or a socket, so the Node test
 * runner checks it directly (test/apaki-web-phone.test.js). Wanted by link.js (the
 * signed via), account.js (the enroll proof) and boot.js (what to do after a
 * scan, whether to connect by itself, what to remember per PC).
 */

import { b64urlEncode, concat } from './protocol.js';

/** Signs "this connection is this phone" (ENROLL.md, via). */
export const VIA_LABEL = 'apaki/v1 via';
/** Signs "this phone adds this account device right after its scan" (ENROLL.md, enroll). */
export const ENROLL_LABEL = 'apaki/v1 enroll';
/** The phone's display name, at most this many characters (ENROLL.md, via). */
export const NAME_MAX = 64;
/** A P-256 ECDSA signature in raw r||s form. */
export const SIG_LEN = 64;
/** What a PC's encrypted close starts with when it blocked this phone (ENROLL.md, BLOCKED). */
export const BLOCKED_PREFIX = 'This phone was blocked on';
/** What a PC's encrypted close starts with when nobody allowed this phone in time (ENROLL.md). */
export const NOT_ALLOWED_PREFIX = 'Nobody allowed this phone on';

const subtle = globalThis.crypto.subtle;

/** `name` cut to at most `max` UTF-16 units without splitting a character. */
export function clipName(name, max = NAME_MAX) {
  let out = '';
  for (const ch of String(name ?? '')) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** The bytes a via signature covers: UTF8("apaki/v1 via") || nonce || phone pub || UTF8(name). */
export const viaBytes = (nonce, pub, name) => concat(VIA_LABEL, nonce, pub, name);

/** The bytes an enroll signature covers: UTF8("apaki/v1 enroll") || nonce || phone pub || account device pub. */
export const enrollBytes = (nonce, phonePub, accountPub) => concat(ENROLL_LABEL, nonce, phonePub, accountPub);

async function signWith(phone, bytes) {
  const sig = new Uint8Array(await phone.sign(bytes));
  if (sig.length !== SIG_LEN) throw new Error(`the phone key gave a ${sig.length}-byte signature, not ${SIG_LEN}`);
  return sig;
}

/**
 * The version 2 via for one connection: { name, pub, sig } ready to send as
 * { t: 'via', name, pub, sig }. `nonce` is the bytes of the PC's hello nonce;
 * the name is cut to NAME_MAX first, and the signature covers that name.
 */
export async function signVia(phone, nonce, name) {
  const clipped = clipName(name);
  return { name: clipped, pub: b64urlEncode(phone.pub), sig: b64urlEncode(await signWith(phone, viaBytes(nonce, phone.pub, clipped))) };
}

/** The proof inside an enrolling account-link: { pub, sig } for `phone` (the account-link's `phone` field). */
export async function signEnroll(phone, nonce, accountPub) {
  return { pub: b64urlEncode(phone.pub), sig: b64urlEncode(await signWith(phone, enrollBytes(nonce, phone.pub, accountPub))) };
}

/** A WebCrypto key pair's private key as a phone key object ({ pub, sign }); the key stays a CryptoKey. */
export function webPhoneKey({ privateKey, pub }) {
  return {
    pub,
    sign: async (bytes) => new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes)),
  };
}

/** True when a PC's close reason says this phone was blocked there. */
export const isBlockedClose = (reason) => String(reason ?? '').trim().startsWith(BLOCKED_PREFIX);

/** True when a PC's close reason says nobody allowed this phone in time. */
export const isNotAllowedClose = (reason) => String(reason ?? '').trim().startsWith(NOT_ALLOWED_PREFIX);

/* what the page decides */

/**
 * What to do about the Apaki account right after a pairing completed and the
 * PC's hello arrived (ENROLL.md, "Phone: what the page does"):
 *   'quiet'  signed in already: send the enrolling account-link at once
 *   'sheet'  not signed in: offer "Next time, sign in with Face ID"
 *   'none'   nothing: the PC does not offer 'enroll', this page has no phone
 *            key, the PC is in the account already, or the person said "Not now"
 * `notNow` is the per-PC memory (wasNotNow). A signed-in phone is never
 * asked, so "Not now" only matters when nobody is signed in.
 */
export function enrollPlan({ offered, hasPhoneKey, asAccount = false, signedIn, inAccount = false, notNow = false }) {
  if (!offered || !hasPhoneKey || asAccount || inAccount) return 'none';
  if (signedIn) return 'quiet';
  return notNow ? 'none' : 'sheet';
}

/**
 * The PC the home screen connects to by itself, or null. Signed in, with one
 * PC online and every other PC known to be offline (or blocked for this
 * phone), there is nothing to choose, so this returns that PC's room id. It
 * stays null when the person is choosing (the PC list is open, `overlay`),
 * is already connected or connecting (`linked`), just disconnected or came
 * back from a blocked close (`noAuto`), or when any other PC's state is not
 * known (a PC the relay was not asked about could be the one they want).
 *
 * @param {object} o
 * @param {boolean} o.signedIn
 * @param {{roomId: string}[]} o.pcs  the PCs on the home screen
 * @param {Map<string, boolean>} o.presence  roomId -> online now (absent: not known)
 * @param {(roomId: string) => boolean} [o.isBlocked]  blocked for this phone on that PC
 */
export function autoConnectChoice({ signedIn, pcs, presence, isBlocked = () => false, noAuto = false, overlay = false, linked = false }) {
  if (!signedIn || noAuto || overlay || linked) return null;
  const live = (pcs || []).filter((p) => !isBlocked(p.roomId));
  const online = live.filter((p) => presence.get(p.roomId) === true);
  if (online.length !== 1) return null;
  if (live.some((p) => p !== online[0] && presence.get(p.roomId) !== false)) return null;
  return online[0].roomId;
}

/* what the page remembers (localStorage and sessionStorage) */

/** Set once the person chose "Not now" on the enroll sheet for this PC (localStorage, like boot.js linkAskedKey). */
export const notNowKey = (roomId) => `apaki.enrollNotNow@${roomId}`;
/** Set when this PC blocked this phone, until a connection to it works again or the PC is forgotten. */
export const blockedKey = (roomId) => `apaki.blocked@${roomId}`;
/** Set in sessionStorage by a disconnect or a blocked close, so the next start shows the PC list instead of connecting. */
export const HOME_KEY = 'apaki.home';

const read = (storage, key) => { try { return storage?.getItem(key) || null; } catch { return null; } };
const write = (storage, key, value) => { try { storage.setItem(key, value); return true; } catch { return false; } };
const drop = (storage, key) => { try { storage?.removeItem(key); } catch { /* nothing to do */ } };

export const wasNotNow = (storage, roomId) => Boolean(read(storage, notNowKey(roomId)));
export const rememberNotNow = (storage, roomId, now = new Date()) => write(storage, notNowKey(roomId), now.toISOString());
export const isBlocked = (storage, roomId) => Boolean(read(storage, blockedKey(roomId)));
export const markBlocked = (storage, roomId, now = new Date()) => write(storage, blockedKey(roomId), now.toISOString());
export const clearBlocked = (storage, roomId) => drop(storage, blockedKey(roomId));
export const markHome = (storage) => write(storage, HOME_KEY, '1');

/** True once after markHome: reads the flag and removes it. */
export function takeHome(storage) {
  const on = Boolean(read(storage, HOME_KEY));
  if (on) drop(storage, HOME_KEY);
  return on;
}
