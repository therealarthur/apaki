/**
 * host.js: Myrlin Apaki's engine as a per-user background host that outlives
 * the window.
 *
 * WHY (Arthur, 2026-10-10): "apaki closing should not close the claude
 * sessions that are open - they should all just move to the background until
 * they stop naturally or are stopped. apaki just connects to them and takes
 * over". Until then the window owned the engine as a child process over
 * stdin/stdout, so closing the window stopped every Claude Code process,
 * including turns still running.
 *
 * DESIGN
 *
 * One host per app id. The Rust shell (apaki/src/main.rs) starts the engine
 * as `node engine.js --host`, detached from the window, once per APAKI_APP_ID
 * (the installed app and a dev build have separate hosts, workspaces and
 * locks). The host listens on 127.0.0.1 on a random port and writes
 * ~/.claude/latch/apaki-host.json (apaki-host.<app id>.json for other app
 * ids; APAKI_HOST_FILE overrides) with { v, app, pid, port, token, root,
 * stamp, startedAt }. The file sits in the user's profile, so only this user
 * (and administrators) can read the token; on macOS and Linux it is mode 600.
 * A window that opens reads the file and connects; when nothing answers it
 * starts a host and connects to that. Closing the window only disconnects.
 *
 * Transport and authentication: JSON lines over TCP on 127.0.0.1, the same
 * lines the engine used on stdin/stdout (ops in, events out, the shell's
 * shellHello / shellReply and ev:shell requests for the built-in browser).
 * Before anything else, both sides prove they know the token without sending
 * it (HMAC-SHA256 over both nonces):
 *   host   -> { t: 'apaki-host', v: 1, app, nonce: SN }
 *   client -> { t: 'auth', v: 1, role: 'window' | 'control', nonce: CN,
 *               mac: HMAC(token, "apaki-host/v1 client\n" app \n SN \n CN \n role) }
 *   host   -> { t: 'ok', v: 1, mac: HMAC(token, "apaki-host/v1 server\n" app \n CN \n SN),
 *               pid, root, stamp, startedAt }
 * A wrong mac, a line longer than 4 KB or no answer within 5 s closes the
 * connection with nothing said; nothing is processed before the mac checks
 * out, so a web page reaching the port gets nothing. The client checks the
 * host's mac too, so a process that took over a dead host's port learns
 * nothing from it either. One window at a time: a newer window connection
 * replaces an older one. 'control' connections (the installer, tests) may
 * only send hostStatus and hostQuit, and get only their answers.
 *
 * What runs with no window connected:
 *   - Running turns finish naturally; their events go nowhere (phones still
 *     get their own panes' events). The engine has no message queue of its
 *     own (a pane's queue lives in the window), so nothing new is sent for a
 *     desktop pane until a window is back; ops the engine had already
 *     received run to the end as before.
 *   - Questions (AskUserQuestion, plan approval) wait, as they always did, for
 *     up to a week; a window that comes back is asked again, and a phone gets
 *     the questions of its own panes.
 *   - A desktop pane whose turn ends while no window is connected is marked
 *     in the saved workspace (busy false, its session id if it made a new
 *     one), so a later window never says the turn was cut off.
 *   - Idle desktop panes (no turn, no background task, no question) have
 *     their Claude Code process closed and their session lock freed after
 *     IDLE_CLOSE_MS (5 minutes) without a window. The pane record stays, so
 *     a window that comes back reopens it from disk as usual. Keep-warm is not
 *     affected: the keeper (src/warm.js, `latch warm run`) is its own process
 *     and pings from each session's last real turn, whether or not a Claude
 *     Code process is open, so caches stay warm exactly as before; the next
 *     message resumes from disk and reads the warm cache.
 *   - Phone access: while it is on, the host stays up with the window closed,
 *     so paired phones keep reaching this PC (pairing a NEW phone still needs
 *     the window, which approves it). Phone panes follow remote.js's own rule
 *     (closed a while after their phone leaves, once idle).
 *   - The host exits when no window is connected, no turn or background task
 *     runs, no question waits and phone access is off (so every idle process
 *     has been closed), for EXIT_GRACE_MS (1 minute).
 *
 * Coming back: the window connects and restores its workspace; a restored
 * pane sends open with warm:false, which the host turns into attach when that
 * pane still has its Claude Code process here (same session, or the new
 * session that pane created). attach sends opened { attached: true, busy (a
 * message sent there still runs; its result follows), turn (any turn runs),
 * running (the process is up) }, the history, any question still waiting and
 * the pane's running tasks, without restarting anything. A pane the host no
 * longer has opens as before (opened without attached), so the window can
 * tell the two apart. A window whose engine build differs from the host's
 * (root or stamp in the ok line) still connects, so nothing running is lost,
 * and asks the host to exit once idle with no window, so the next window
 * gets a host of its own build.
 *
 * Failures: if the host dies, the window's connection ends; the shell tells
 * the window (ev engine_exit, "restarting") and connects to a new host. If the
 * window crashes, the host sees the connection end and carries on as above.
 * The built-in browser lives in the window: with no window, browser requests
 * fail at once with a clear message, and work again once a window is back.
 *
 * Updates: the installer must not replace files under a running host. It
 * asks the host to exit when idle and waits for it:
 *   node apaki/engine/host-ctl.js quit --when-idle --wait <seconds>
 * (op hostQuit { whenIdle: true } on a connection does the same). With a quit
 * asked, the host exits as soon as no window is connected, no turn or task
 * runs and no question waits, closing idle processes at once and ignoring
 * phone access. { now: true } stops everything at once.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const HOST_PROTOCOL = 1;
export const DEFAULT_APP_ID = 'io.myrlin.apaki';
// Without a window: idle Claude Code processes close after this long.
export const IDLE_CLOSE_MS = Number(process.env.APAKI_HOST_IDLE_MS) || 5 * 60 * 1000;
// Nothing left to do and no window: the host exits after this long.
export const EXIT_GRACE_MS = Number(process.env.APAKI_HOST_EXIT_MS) || 60 * 1000;
// A quit was asked and the host is idle: exits after this long (lets the last events settle).
export const QUIT_GRACE_MS = 1000;
export const TICK_MS = Number(process.env.APAKI_HOST_TICK_MS) || 5000;
export const HANDSHAKE_MS = 5000;
export const PRE_AUTH_MAX_BYTES = 4096;
// A line after authentication (a message with images, a screenshot for the browser).
export const MAX_LINE_BYTES = 256 * 1024 * 1024;
const CONTROL_OPS = new Set(['hostStatus', 'hostQuit']);

/* ---------- where the host is written down ---------- */

/** ~/.claude/latch (CLAUDE_CONFIG_DIR moves ~/.claude), where the engine keeps its per-user files. */
export function latchDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'latch');
}

/** An app id as it appears in a file name (same rule as the saved workspace). */
export function safeAppId(appId) {
  return String(appId || DEFAULT_APP_ID).replace(/[^\w.-]/g, '_');
}

/**
 * The file that says where the host of one app id listens. The shell passes
 * APAKI_HOST_FILE to the host it starts, so both sides use the very same path.
 */
export function hostFile(appId = DEFAULT_APP_ID, env = process.env) {
  if (env.APAKI_HOST_FILE) return env.APAKI_HOST_FILE;
  const id = String(appId || DEFAULT_APP_ID);
  return path.join(latchDir(env), id === DEFAULT_APP_ID ? 'apaki-host.json' : `apaki-host.${safeAppId(id)}.json`);
}

export function readHostInfo(file) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!info || typeof info !== 'object' || !Number.isInteger(info.port) || typeof info.token !== 'string') return null;
    return info;
  } catch {
    return null;
  }
}

/** Writes the host file atomically, readable by this user only where the OS has modes. */
export function writeHostInfo(file, info) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Removes the host file, but only while it still names this host (a newer host may have replaced it). */
export function removeHostInfo(file, pid = process.pid) {
  const info = readHostInfo(file);
  if (!info || info.pid !== pid) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/**
 * Which build of the engine a host runs: size and modification time of
 * engine.js in whole seconds (main.rs engine_stamp computes the same; whole
 * seconds so float rounding of mtimeMs can never make two equal files differ).
 */
export function engineStamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}-${Math.floor(st.mtimeMs / 1000)}`;
  } catch {
    return '';
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* ---------- authentication ---------- */

const hmac = (token, text) => crypto.createHmac('sha256', String(token)).update(text, 'utf8').digest('hex');

/** What the client proves: it knows the token, for this host's nonce, in this role. */
export function clientMac(token, { app, serverNonce, clientNonce, role }) {
  return hmac(token, `apaki-host/v1 client\n${app}\n${serverNonce}\n${clientNonce}\n${role}`);
}

/** What the host proves back: it knows the token too, for the client's nonce. */
export function serverMac(token, { app, serverNonce, clientNonce }) {
  return hmac(token, `apaki-host/v1 server\n${app}\n${clientNonce}\n${serverNonce}`);
}

/** Constant-time comparison of two hex macs. */
export function macEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false;
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/* ---------- lines on a socket ---------- */

/**
 * Splits a socket's bytes into lines (UTF-8, '\n', a trailing '\r' dropped).
 * A line longer than maxBytes() calls onOverflow and stops reading.
 */
export function readLines(socket, onLine, { maxBytes = () => MAX_LINE_BYTES, onOverflow = () => socket.destroy() } = {}) {
  let parts = [];
  let size = 0;
  let dead = false;
  socket.on('data', (chunk) => {
    if (dead) return;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      const piece = chunk.subarray(start, nl < 0 ? chunk.length : nl);
      size += piece.length;
      if (size > maxBytes()) { dead = true; parts = []; onOverflow(); return; }
      if (piece.length) parts.push(piece);
      if (nl < 0) return;
      const line = Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
      parts = [];
      size = 0;
      start = nl + 1;
      onLine(line);
      if (dead || socket.destroyed) return;
    }
  });
  return { stop() { dead = true; parts = []; } };
}

function writeLine(socket, obj) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try { socket.write(`${JSON.stringify(obj)}\n`); return true; } catch { return false; }
}

/* ---------- the host's server ---------- */

/**
 * The host's listening side. Window lines go to onLine; a window connecting
 * or going away calls onConnect / onGone; control connections are answered by
 * control(cmd) (a reply object, or a promise of one).
 */
export class HostServer {
  /**
   * @param {object} o
   * @param {string} o.appId
   * @param {string} o.file      the host file (hostFile())
   * @param {string} [o.root]    the engine's root folder, for the shell's build check
   * @param {string} [o.stamp]   engineStamp(engine.js)
   * @param {(conn) => void} [o.onConnect]  a window connected (authenticated)
   * @param {(line: string, conn) => void} [o.onLine]  a line from the current window
   * @param {(conn) => void} [o.onGone]  the current window went away
   * @param {(cmd: object, conn) => any} [o.control]  answers hostStatus / hostQuit from control connections
   * @param {(line: string) => void} [o.log]
   */
  constructor(o) {
    this.appId = String(o.appId || DEFAULT_APP_ID);
    this.file = o.file || hostFile(this.appId);
    this.root = o.root || '';
    this.stamp = o.stamp || '';
    this.token = o.token || crypto.randomBytes(32).toString('hex');
    this.onConnect = o.onConnect || (() => {});
    this.onLine = o.onLine || (() => {});
    this.onGone = o.onGone || (() => {});
    this.control = o.control || (() => ({ ev: 'error', message: 'not available' }));
    this.log = o.log || ((line) => process.stderr.write(`apaki host: ${line}\n`));
    this.handshakeMs = o.handshakeMs ?? HANDSHAKE_MS;
    this.startedAt = new Date().toISOString();
    this.server = null;
    this.port = null;
    this.window = null; // the current window connection
    this.authenticating = 0; // connections between accept and their auth line
    this.everConnected = false;
    this.seq = 0;
  }

  /** Listens on 127.0.0.1 (a random port) and writes the host file. */
  async start() {
    this.server = net.createServer((socket) => this.accept(socket));
    this.server.on('error', (e) => this.log(`server: ${e.message}`));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { this.server.off('error', reject); resolve(); });
    });
    this.port = this.server.address().port;
    writeHostInfo(this.file, this.info());
    return this.port;
  }

  info() {
    return { v: HOST_PROTOCOL, app: this.appId, pid: process.pid, port: this.port, token: this.token, root: this.root, stamp: this.stamp, startedAt: this.startedAt };
  }

  accept(socket) {
    socket.setNoDelay?.(true);
    socket.on('error', () => {}); // a reset connection is just a closed one
    const serverNonce = crypto.randomBytes(32).toString('hex');
    const conn = { id: ++this.seq, socket, role: null, at: Date.now(), send: (obj) => writeLine(socket, obj), close: () => socket.destroy() };
    this.authenticating += 1;
    let pending = true;
    const settle = () => { if (pending) { pending = false; this.authenticating -= 1; } };
    const timer = setTimeout(() => { settle(); socket.destroy(); }, this.handshakeMs);
    timer.unref?.();
    readLines(socket, (line) => {
      if (!conn.role) {
        clearTimeout(timer);
        settle();
        if (!this.authenticate(conn, line, serverNonce)) { socket.destroy(); return; }
        return;
      }
      if (conn.role === 'window') {
        if (this.window === conn) this.onLine(line, conn);
        return;
      }
      this.controlLine(conn, line);
    }, { maxBytes: () => (conn.role ? MAX_LINE_BYTES : PRE_AUTH_MAX_BYTES) });
    socket.on('close', () => {
      clearTimeout(timer);
      settle();
      if (this.window === conn) {
        this.window = null;
        try { this.onGone(conn); } catch (e) { this.log(`onGone: ${e.message}`); }
      }
    });
    writeLine(socket, { t: 'apaki-host', v: HOST_PROTOCOL, app: this.appId, nonce: serverNonce });
  }

  /** Checks the client's first line; on success answers ok and takes the connection in its role. */
  authenticate(conn, line, serverNonce) {
    let m;
    try { m = JSON.parse(line); } catch { return false; }
    if (!m || m.t !== 'auth' || m.v !== HOST_PROTOCOL) return false;
    const role = m.role === 'control' ? 'control' : m.role === 'window' ? 'window' : null;
    const clientNonce = typeof m.nonce === 'string' && /^[0-9a-f]{32,128}$/i.test(m.nonce) ? m.nonce : null;
    if (!role || !clientNonce) return false;
    const want = clientMac(this.token, { app: this.appId, serverNonce, clientNonce, role });
    if (!macEqual(String(m.mac || ''), want)) { this.log('a connection failed authentication'); return false; }
    conn.role = role;
    conn.send({ t: 'ok', v: HOST_PROTOCOL, mac: serverMac(this.token, { app: this.appId, serverNonce, clientNonce }), pid: process.pid, root: this.root, stamp: this.stamp, startedAt: this.startedAt, reconnect: this.everConnected });
    if (role === 'window') {
      const old = this.window;
      this.window = conn;
      this.everConnected = true;
      if (old) {
        // A newer window replaces the old one (a window that crashed and came back before its socket closed).
        try { this.onGone(old); } catch (e) { this.log(`onGone: ${e.message}`); }
        old.socket.destroy();
      }
      try { this.onConnect(conn); } catch (e) { this.log(`onConnect: ${e.message}`); }
    }
    return true;
  }

  async controlLine(conn, line) {
    let c;
    try { c = JSON.parse(line); } catch { return; }
    if (!c || !CONTROL_OPS.has(c.op)) { conn.send({ ev: 'error', reqId: c?.reqId ?? null, message: `a control connection cannot send ${c?.op}` }); return; }
    try {
      const r = await this.control(c, conn);
      if (r) conn.send(r);
    } catch (e) {
      conn.send({ ev: 'error', reqId: c.reqId ?? null, message: e.message || String(e) });
    }
  }

  /** One event to the current window, if one is connected. */
  send(ev) {
    return this.window ? this.window.send(ev) : false;
  }

  /** Stops listening, drops every connection and removes the host file (if it is still ours). */
  close() {
    try { this.server?.close(); } catch { /* closing */ }
    removeHostInfo(this.file);
    this.window?.socket.destroy();
  }
}

/* ---------- a client: the installer's host-ctl, tests ---------- */

/**
 * Connects to the host named in `file` and authenticates. Resolves with
 * { info, ok, send(obj), next(pred, ms), events, close(), socket }; rejects
 * with code NO_HOST (no file or nothing listening) or AUTH (a bad answer).
 */
export function connectHost({ file, role = 'control', timeoutMs = 5000, info = null } = {}) {
  const hi = info || readHostInfo(file);
  if (!hi) return Promise.reject(Object.assign(new Error('No Apaki host is running.'), { code: 'NO_HOST' }));
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: hi.port });
    socket.setNoDelay?.(true);
    const events = [];
    const waiters = [];
    const clientNonce = crypto.randomBytes(32).toString('hex');
    let stage = 'hello';
    let serverNonce = null;
    let done = false;
    const fail = (code, message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(Object.assign(new Error(message), { code }));
    };
    const timer = setTimeout(() => fail('NO_HOST', 'The Apaki host did not answer.'), timeoutMs);
    socket.on('error', (e) => fail('NO_HOST', `The Apaki host is not reachable (${e.code || e.message}).`));
    const client = {
      info: hi,
      ok: null,
      socket,
      events,
      send: (obj) => writeLine(socket, obj),
      close: () => socket.end(),
      /** Waits for the next event (or one already received since `from`) that matches. */
      next(pred = () => true, ms = 10000, from = 0) {
        for (let i = from; i < events.length; i++) if (pred(events[i])) return Promise.resolve(events[i]);
        return new Promise((res, rej) => {
          const w = { pred, res, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timed out waiting for an event')); }, ms) };
          waiters.push(w);
        });
      },
      closed: new Promise((res) => socket.on('close', res)),
    };
    readLines(socket, (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (stage === 'hello') {
        if (m?.t !== 'apaki-host' || typeof m.nonce !== 'string') { fail('AUTH', 'Not an Apaki host.'); return; }
        serverNonce = m.nonce;
        stage = 'ok';
        writeLine(socket, { t: 'auth', v: HOST_PROTOCOL, role, nonce: clientNonce, mac: clientMac(hi.token, { app: m.app, serverNonce, clientNonce, role }) });
        client.app = m.app;
        return;
      }
      if (stage === 'ok') {
        if (m?.t !== 'ok' || !macEqual(String(m.mac || ''), serverMac(hi.token, { app: client.app, serverNonce, clientNonce }))) { fail('AUTH', 'The Apaki host did not prove itself.'); return; }
        stage = 'open';
        done = true;
        clearTimeout(timer);
        client.ok = m;
        resolve(client);
        return;
      }
      events.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.res(m); }
    });
    socket.on('close', () => fail('NO_HOST', 'The Apaki host closed the connection.'));
  });
}

/* ---------- what a pane is doing (fed from its SDK messages) ---------- */

const TERMINAL_TASK = new Set(['completed', 'failed', 'killed', 'stopped']);

/**
 * Folds one SDK message into a pane's activity record:
 *   inTurn     a turn is running (one we sent, or one Claude started itself)
 *   bgTasks    live background tasks (background_tasks_changed, ambient left out)
 *   taskLog    the last task_* messages of each task still running, to send a window that attaches
 *   lastActiveAt
 * The background level is per Claude Code process, so it starts empty for each new process (`q`).
 */
export function noteSdkMessage(p, msg, { now = Date.now(), q = null } = {}) {
  p.lastActiveAt = now;
  if (!p.bgTasks || (q && p.trackedQ !== q)) {
    p.trackedQ = q;
    p.bgTasks = new Map();
    p.bgLevel = null;
    p.taskLog = new Map();
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'result' || msg.type === 'latch_error') { p.inTurn = false; return; }
  if (msg.type === 'system') {
    const sub = String(msg.subtype || '');
    if (sub === 'background_tasks_changed') {
      p.bgTasks = new Map((Array.isArray(msg.tasks) ? msg.tasks : []).filter((t) => t && !t.ambient && t.task_id).map((t) => [t.task_id, t]));
      p.bgLevel = msg;
      return;
    }
    if (sub.startsWith('task_') && msg.task_id) {
      const id = msg.task_id;
      const entry = p.taskLog.get(id) || {};
      if (sub === 'task_notification' || (sub === 'task_updated' && TERMINAL_TASK.has(msg.patch?.status))) { p.taskLog.delete(id); return; }
      if (sub === 'task_started') entry.started = msg;
      else if (sub === 'task_progress') entry.progress = msg;
      else if (sub === 'task_updated') entry.updated = msg;
      p.taskLog.set(id, entry);
    }
    return;
  }
  // Subagent messages (parent_tool_use_id) belong to their task, not to the main turn.
  if (!msg.parent_tool_use_id && (msg.type === 'stream_event' || msg.type === 'assistant' || msg.type === 'user')) p.inTurn = true;
}

/** A turn is running in this pane (what the window shows as working, with Stop). */
export function paneTurnBusy(p) {
  const r = p?.runner;
  return Boolean(p?.busy) || Boolean(r?.running && (r.turnRunning || p.inTurn));
}

/** Anything still running in this pane's Claude Code process: a turn or a background task. */
export function paneWorking(p) {
  return paneTurnBusy(p) || Boolean(p?.runner?.running && p.bgTasks?.size);
}

/** The task messages to send a window that attaches to a pane, oldest first, then the background level. */
export function taskReplay(p) {
  const out = [];
  for (const e of p?.taskLog?.values() || []) for (const m of [e.started, e.updated, e.progress]) if (m) out.push(m);
  if (p?.bgLevel && p.bgTasks?.size) out.push(p.bgLevel);
  return out;
}

/* ---------- restoring a window: open becomes attach ---------- */

/**
 * The window restores its panes with open { warm: false }. When the host
 * still has that pane's Claude Code process, for the same session (or for the
 * session the pane created, which a window that closed early may not have
 * saved), the window takes it over with attach instead of a restart.
 * Returns the attach command, or null to run the open as sent.
 */
export function restoreAsAttach(c, p) {
  if (!c || c.op !== 'open' || c.warm !== false || c.force || !p || !p.runner) return null;
  const want = c.sessionId || null;
  const have = p.sessionId || null;
  if (want !== have && !(want === null && have && p.createdHere)) return null;
  return { op: 'attach', reqId: c.reqId ?? null, paneId: c.paneId, sessionId: have, cwd: c.cwd || null };
}

/* ---------- the saved workspace, for turns that ended with no window ---------- */

/**
 * The window's saved workspace with one pane's leaves patched (busy false, the
 * session id it made), and savedAt moved forward by 1 ms so this copy wins
 * over the window's localStorage copy of the same save. Never replaces a
 * different session a leaf already holds. Null when no leaf matched.
 */
export function patchWorkspaceLeaves(ws, paneId, patch = {}) {
  if (!ws || typeof ws !== 'object' || !Array.isArray(ws.tabs)) return null;
  let hit = false;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'leaf') {
      if (node.pane !== paneId || node.view || node.web) return node;
      const next = { ...node };
      if ('busy' in patch) next.busy = Boolean(patch.busy);
      if (patch.s && (!node.s || node.s === patch.s)) next.s = patch.s;
      if (patch.away) next.away = patch.away;
      hit = true;
      return next;
    }
    return Array.isArray(node.children) ? { ...node, children: node.children.map(walk) } : node;
  };
  const tabs = ws.tabs.map((t) => (t && typeof t === 'object' ? { ...t, root: walk(t.root) } : t));
  if (!hit) return null;
  return { ...ws, tabs, savedAt: (Number(ws.savedAt) || 0) + 1 };
}

/* ---------- when idle processes close and when the host exits ---------- */

/**
 * One look at the host's state. panes: [{ id, phone, open, working, asks, lastActiveAt }].
 * Returns the desktop panes to close now and whether the host may exit.
 */
export function planIdle({ window = false, remoteOn = false, quit = false, panes = [], windowGoneAt = 0, now = Date.now(), idleCloseMs = IDLE_CLOSE_MS } = {}) {
  const close = [];
  const waiting = [];
  let working = 0;
  let asks = 0;
  let open = 0;
  for (const p of panes) {
    if (p.working) { working += 1; waiting.push({ id: p.id, why: 'working' }); }
    if (p.asks) { asks += p.asks; waiting.push({ id: p.id, why: 'question' }); }
    if (!p.open) continue;
    open += 1;
    if (window || p.working || p.asks) continue;
    // Phone panes follow remote.js (closed once their phone has been gone a while); a quit closes them too.
    if (p.phone && !quit) continue;
    const idleFor = now - Math.max(p.lastActiveAt || 0, windowGoneAt || 0);
    if (quit || idleFor >= idleCloseMs) close.push(p.id);
  }
  const openAfter = open - close.length;
  const exitReady = !window && working === 0 && asks === 0 && (quit || (!remoteOn && openAfter === 0));
  if (!exitReady && !window && remoteOn && !quit) waiting.push({ id: null, why: 'phone access is on' });
  if (window) waiting.push({ id: null, why: 'a window is connected' });
  return { close, exitReady, waiting, working, asks, open };
}

/**
 * The host's lifecycle: every tick it closes idle processes (no window) and
 * exits once planIdle says so for long enough. Timers and the clock are
 * injectable for tests.
 *
 * @param {object} o
 * @param {() => { remoteOn: boolean, panes: object[] }} o.view
 * @param {(paneId: string) => void} o.closeIdle
 * @param {(reason: string) => void} o.exit
 */
export function createLifecycle(o) {
  const now = o.now || Date.now;
  const idleCloseMs = o.idleCloseMs ?? IDLE_CLOSE_MS;
  const exitGraceMs = o.exitGraceMs ?? EXIT_GRACE_MS;
  const quitGraceMs = o.quitGraceMs ?? QUIT_GRACE_MS;
  const log = o.log || (() => {});
  let window = false;
  let windowGoneAt = now();
  let quit = null;
  let readySince = null;
  let exiting = false;
  let last = null;
  const timer = o.tickMs === 0 ? null : setInterval(() => tick(), o.tickMs ?? TICK_MS);
  timer?.unref?.();

  function tick() {
    if (exiting) return last;
    const t = now();
    const v = o.view();
    const plan = planIdle({ window, remoteOn: Boolean(v.remoteOn), quit: Boolean(quit), panes: v.panes || [], windowGoneAt, now: t, idleCloseMs });
    for (const id of plan.close) {
      log(`closing the idle Claude Code process of pane ${id}`);
      try { o.closeIdle(id); } catch (e) { log(`closeIdle ${id}: ${e.message}`); }
    }
    if (plan.exitReady) {
      if (readySince === null) readySince = t;
      if (t - readySince >= (quit ? quitGraceMs : exitGraceMs)) {
        exiting = true;
        if (timer) clearInterval(timer);
        log(`exiting (${quit ? 'asked to quit' : 'idle with no window'})`);
        o.exit(quit ? 'quit' : 'idle');
      }
    } else {
      readySince = null;
    }
    last = plan;
    return plan;
  }

  return {
    tick,
    windowConnected() { window = true; readySince = null; },
    windowGone() { window = false; windowGoneAt = now(); readySince = null; },
    /** { now: true } exits at once; otherwise once idle with no window. */
    requestQuit({ now: immediate = false, by = '' } = {}) {
      if (immediate) {
        if (!exiting) { exiting = true; if (timer) clearInterval(timer); log(`exiting now (asked by ${by || 'someone'})`); o.exit('quit-now'); }
        return;
      }
      quit = quit || { at: now(), by };
      readySince = null;
    },
    get exiting() { return exiting; },
    status() {
      return { window, windowGoneAt, quit, readySince, exiting, idleCloseMs, exitGraceMs, plan: last };
    },
    stop() { if (timer) clearInterval(timer); exiting = true; },
  };
}
