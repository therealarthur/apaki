/**
 * remote-policy.js: what a paired phone may ask the Apaki engine to do, and
 * which engine events it gets back. Pure functions, no I/O, so the rules are
 * tested on their own (test/apaki-remote-bridge.test.js).
 *
 * Track B part 2 (2026-10-09). A phone speaks the same commands the desktop
 * window sends (engine.js ops), but only these, through an explicit
 * allowlist:
 *   sessions, search                         the session list
 *   open, attach, send, interrupt, answer,   its own conversations
 *   model, effort, mode, commands, close
 *   artifactGet                              when the engine has it (artifacts track)
 * Never billing, never the remote* ops (pairing, devices), never voice,
 * folders, Ask Claude or Dig deeper (they write files or spend outside a
 * conversation), and nothing that reaches the shell or the filesystem.
 *
 * Panes: a phone names its panes like the desktop does (p1, pab3...). The
 * engine sees them as phone:<deviceId>:<name>, so a phone can never touch a
 * desktop pane or another phone's pane, and every event about a phone pane
 * goes to that phone only. Request ids get the same prefix so answers to a
 * phone's requests (sessions, search) go back to it and not to the desktop.
 */

export const PHONE_PREFIX = 'phone:';

/** Engine ops a phone may send. artifactGet only when the engine has that op. */
export const PHONE_OPS = Object.freeze([
  'sessions', 'search',
  'open', 'attach', 'send', 'interrupt', 'answer', 'model', 'effort', 'mode', 'commands', 'close',
  'artifactGet',
  // 2026-10-10: steering a queued message into the running turn (same power as send), and the context meter.
  'steer', 'contextUsage',
]);

/** Ops that act on one pane (paneId required). */
const PANE_OPS = new Set(['open', 'attach', 'send', 'interrupt', 'model', 'effort', 'mode', 'commands', 'close', 'steer', 'contextUsage']);

/** Most panes one phone may have open at once (the desktop's limit per tab). */
export const MAX_PHONE_PANES = 6;

/** Events every connected phone gets, besides those for its own panes and requests. */
export const BROADCAST_EVENTS = new Set(['folders', 'glass', 'index', 'meaning']);

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODES = ['bypassPermissions', 'acceptEdits', 'plan', 'default'];
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const LOCAL_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const REQ_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{22}$/;
const SESSION_RE = /^[A-Za-z0-9-]{8,80}$/;
const MODEL_RE = /^claude-[a-z0-9.-]{1,60}$/;
const MAX_TEXT = 200_000;
const MAX_QUERY = 500;
const MAX_IMAGES = 8;
const MAX_IMAGE_B64 = 8 * 1024 * 1024;

/** The engine pane id of a phone's pane. */
export function phonePaneId(deviceId, local) {
  return `${PHONE_PREFIX}${deviceId}:${local}`;
}

/** Splits phone:<deviceId>:<local> (a pane or request id); null for anything else. */
export function parsePhoneId(id) {
  if (typeof id !== 'string' || !id.startsWith(PHONE_PREFIX)) return null;
  const rest = id.slice(PHONE_PREFIX.length);
  const i = rest.indexOf(':');
  if (i < 0) return null;
  const deviceId = rest.slice(0, i);
  const local = rest.slice(i + 1);
  if (!DEVICE_RE.test(deviceId) || !local) return null;
  return { deviceId, local };
}

/** True for a pane id that belongs to a phone. */
export const isPhonePane = (id) => parsePhoneId(id) !== null;

/** The window a pane belongs to: 'desktop', or phone:<deviceId>. */
export function windowOf(paneId) {
  const p = parsePhoneId(paneId);
  return p ? `${PHONE_PREFIX}${p.deviceId}` : 'desktop';
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (error, cmd) => ({ ok: false, error, reqId: typeof cmd?.reqId === 'string' ? cmd.reqId.slice(0, 64) : null, paneId: typeof cmd?.paneId === 'string' ? cmd.paneId.slice(0, 40) : null });

/**
 * Checks one command from a phone and rewrites it for the engine: only the
 * fields the op uses are kept, ids get the phone's prefix.
 *
 * @param {object} cmd  what the phone sent ({ op, reqId, paneId, ... })
 * @param {object} ctx
 * @param {string} ctx.deviceId
 * @param {(op: string) => boolean} [ctx.hasOp]  the engine has this op (artifactGet)
 * @param {(paneId: string) => boolean} [ctx.paneExists]
 * @param {(deviceId: string) => number} [ctx.paneCount]  panes this phone has in the engine
 * @param {(askId: string) => (string|null)} [ctx.askPane]  the pane a pending question belongs to
 * @param {(cwd: string) => boolean} [ctx.knownCwd]  a folder some listed session ran in
 * @param {(deviceId: string) => string[]} [ctx.phoneSessions]  sessions open in this phone's panes
 * @returns {{ok: true, cmd: object} | {ok: false, error: string, reqId: string|null, paneId: string|null}}
 */
export function checkPhoneCommand(cmd, ctx) {
  const { deviceId } = ctx;
  if (!isObj(cmd)) return fail('A command must be an object.', null);
  const op = cmd.op;
  if (typeof op !== 'string' || !PHONE_OPS.includes(op)) return fail(`"${String(op).slice(0, 40)}" is not available from a phone.`, cmd);
  if (op === 'artifactGet' && !(ctx.hasOp?.(op))) return fail('Artifacts are not available on this PC.', cmd);
  if (cmd.reqId !== undefined && cmd.reqId !== null && (typeof cmd.reqId !== 'string' || !REQ_ID_RE.test(cmd.reqId))) return fail('Bad request id.', null);
  const out = { op };
  if (cmd.reqId) out.reqId = phonePaneId(deviceId, cmd.reqId);

  let paneId = null;
  if (PANE_OPS.has(op) || (op === 'artifactGet' && cmd.paneId != null)) {
    if (typeof cmd.paneId !== 'string' || !LOCAL_ID_RE.test(cmd.paneId)) return fail('Bad pane id.', cmd);
    paneId = phonePaneId(deviceId, cmd.paneId);
    out.paneId = paneId;
    const exists = ctx.paneExists ? ctx.paneExists(paneId) : true;
    if (op === 'open' || op === 'attach') {
      if (!exists && (ctx.paneCount?.(deviceId) ?? 0) >= MAX_PHONE_PANES) return fail(`A phone can have ${MAX_PHONE_PANES} conversations open at once. Close one first.`, cmd);
    } else if (!exists && op !== 'close') {
      return fail('That pane is not open on the PC.', cmd);
    }
  }

  switch (op) {
    case 'sessions':
      break;
    case 'search':
      if (typeof cmd.query !== 'string') return fail('A search needs a query.', cmd);
      out.query = cmd.query.slice(0, MAX_QUERY);
      break;
    case 'open':
    case 'attach': {
      const sid = cmd.sessionId ?? null;
      if (sid !== null && (typeof sid !== 'string' || !SESSION_RE.test(sid))) return fail('Bad session id.', cmd);
      out.sessionId = sid;
      // A phone does not choose folders on the PC: a session runs where it
      // always ran (the engine reads it from the session), and a new
      // conversation starts in a folder some listed session already uses, or
      // in the home folder.
      out.cwd = typeof cmd.cwd === 'string' && cmd.cwd && ctx.knownCwd?.(cmd.cwd) ? cmd.cwd : null;
      if (op === 'open') {
        if (cmd.warm !== undefined) out.warm = cmd.warm !== false;
        if (cmd.force !== undefined) out.force = cmd.force === true;
        if (cmd.model != null) { if (!MODEL_RE.test(String(cmd.model))) return fail('Unknown model.', cmd); out.model = cmd.model; }
        if (cmd.effort != null) { if (!EFFORTS.includes(cmd.effort)) return fail('Unknown effort.', cmd); out.effort = cmd.effort; }
        if (cmd.mode != null) { if (!MODES.includes(cmd.mode)) return fail('Unknown permission mode.', cmd); out.mode = cmd.mode; }
      }
      break;
    }
    case 'steer':
      // The window's own id for the steered message comes back on steered / steer_missed.
      if (typeof cmd.qid !== 'string' || !LOCAL_ID_RE.test(cmd.qid)) return fail('Bad message id.', cmd);
      out.qid = cmd.qid;
      // falls through: the text and images are checked like a sent message
    case 'send': {
      if (cmd.text != null && typeof cmd.text !== 'string') return fail('Bad message.', cmd);
      const text = String(cmd.text ?? '');
      if (text.length > MAX_TEXT) return fail('That message is too long.', cmd);
      const images = cmd.images ?? [];
      if (!Array.isArray(images) || images.length > MAX_IMAGES) return fail(`At most ${MAX_IMAGES} images per message.`, cmd);
      const clean = [];
      for (const im of images) {
        if (!isObj(im) || !IMAGE_TYPES.has(im.media_type) || typeof im.data !== 'string' || im.data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(im.data)) return fail('An image could not be sent (PNG, JPEG, GIF or WebP, at most 6 MB).', cmd);
        clean.push({ media_type: im.media_type, data: im.data });
      }
      if (!text.trim() && !clean.length) return fail('Nothing to send.', cmd);
      out.text = text;
      out.images = clean;
      break;
    }
    case 'interrupt':
    case 'commands':
    case 'close':
    case 'contextUsage':
      break;
    case 'answer': {
      if (typeof cmd.askId !== 'string' || cmd.askId.length > 80) return fail('Bad question id.', cmd);
      const owner = ctx.askPane?.(cmd.askId) ?? null;
      if (!owner || windowOf(owner) !== `${PHONE_PREFIX}${deviceId}`) return fail('That question belongs to another window.', cmd);
      const r = cmd.result;
      if (r !== null && r !== undefined) {
        if (!isObj(r) || (r.behavior !== 'allow' && r.behavior !== 'deny')) return fail('Bad answer.', cmd);
        out.result = { behavior: r.behavior };
        if (r.behavior === 'allow' && isObj(r.updatedInput)) out.result.updatedInput = r.updatedInput;
        if (typeof r.message === 'string') out.result.message = r.message.slice(0, 2000);
      } else {
        out.result = null;
      }
      out.askId = cmd.askId;
      break;
    }
    case 'model':
      if (!MODEL_RE.test(String(cmd.model))) return fail('Unknown model.', cmd);
      out.model = cmd.model;
      break;
    case 'effort':
      if (!EFFORTS.includes(cmd.effort)) return fail('Unknown effort.', cmd);
      out.effort = cmd.effort;
      break;
    case 'mode':
      if (!MODES.includes(cmd.mode)) return fail('Unknown permission mode.', cmd);
      out.mode = cmd.mode;
      break;
    case 'artifactGet': {
      // Only artifacts of sessions this phone has open.
      if (typeof cmd.id !== 'string' || cmd.id.length > 120) return fail('Bad artifact id.', cmd);
      const sid = cmd.sessionId;
      if (typeof sid !== 'string' || !(ctx.phoneSessions?.(deviceId) || []).includes(sid)) return fail('Open the conversation that made this artifact first.', cmd);
      out.id = cmd.id;
      out.sessionId = sid;
      if (Number.isInteger(cmd.rev)) out.rev = cmd.rev;
      if (cmd.content !== undefined) out.content = Boolean(cmd.content);
      break;
    }
    default:
      return fail('Not available from a phone.', cmd);
  }
  return { ok: true, cmd: out };
}

/**
 * Where an engine event goes. Returns { deviceId, ev } with the phone's own
 * ids put back when the event is about a phone's pane or answers a phone's
 * request (only that phone gets it, the desktop does not), else null (the
 * desktop gets it; BROADCAST_EVENTS also go to every connected phone).
 */
export function routeEvent(ev) {
  if (!isObj(ev)) return null;
  const byPane = parsePhoneId(ev.paneId);
  const byReq = parsePhoneId(ev.reqId);
  const deviceId = byPane?.deviceId || byReq?.deviceId;
  if (!deviceId) return null;
  const out = { ...ev };
  if (byPane) out.paneId = byPane.deviceId === deviceId ? byPane.local : null;
  if (byReq) out.reqId = byReq.deviceId === deviceId ? byReq.local : null;
  if (typeof ev.otherPane === 'string') {
    const other = parsePhoneId(ev.otherPane);
    out.otherPane = other && other.deviceId === deviceId ? other.local : null;
  }
  return { deviceId, ev: out };
}

const FIRST_PROMPT_CHARS = 200;
const trimItem = (it) => (it && typeof it.firstPrompt === 'string' && it.firstPrompt.length > FIRST_PROMPT_CHARS ? { ...it, firstPrompt: it.firstPrompt.slice(0, FIRST_PROMPT_CHARS) } : it);

/**
 * An event as a phone should see it: voice off (dictation is the phone
 * keyboard's job; the PC's Whisper is not reachable from a phone), and the
 * session list trimmed to what the phone shows.
 */
export function phoneView(ev) {
  if (!isObj(ev)) return ev;
  let out = ev;
  if ('voice' in ev) out = { ...out, voice: false };
  if (ev.ev === 'sessions' && Array.isArray(ev.items)) out = { ...out, items: ev.items.map(trimItem) };
  if ((ev.ev === 'search' || ev.ev === 'askSearch') && Array.isArray(ev.results)) out = { ...out, results: ev.results.map((r) => (r && r.item ? { ...r, item: trimItem(r.item) } : r)) };
  return out;
}

/** A small fast hash (FNV-1a, 32 bit) of a string: the session list is sent again only when it changed. */
export function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
