/**
 * codex-client.js: Myrlin Apaki's client for `codex app-server`.
 *
 * WHY (Arthur, 2026-10-11: a Codex pane should match OpenAI's Codex app as close
 * to 1:1 as possible): the Codex app and its IDE extensions are clients of one
 * protocol, JSON-RPC over stdio, served by `codex app-server`. Apaki speaks the
 * same protocol, so a thread opened here is the thread the Codex app lists, with
 * the same models, approvals, plans and diffs (apaki/remote/CODEX.md has the
 * parity contract; apaki/parity keeps snapshots of the protocol's schema).
 *
 * One process per engine, started the first time anything needs it and stopped
 * when the last Codex pane has been gone a while (codex-panes.js decides). It is
 * configured per process only: every `-c key=value` below goes on this process's
 * command line, and ~/.codex/config.toml is never written (Arthur's rule).
 *
 * Wire format (measured against codex-cli 0.161.0, 2026-10-12): one JSON object
 * per line, in both directions. Responses carry no "jsonrpc" member. The client
 * sends `initialize` (with experimentalApi on, which the queue, dynamic tool and
 * collaboration mode fields need), waits for its answer, then sends the
 * `initialized` notification. After that:
 *   client request   {id, method, params}              answered by {id, result | error}
 *   notification     {method, params}                  in either direction
 *   server request   {id, method, params}              the client MUST answer, or the turn waits
 *                                                      forever (approvals, questions, tool calls)
 *
 * This module is transport and framing only. It knows no thread, turn or item;
 * codex-panes.js and codex-map.js do. The process can be replaced in tests with
 * a script (APAKI_CODEX_BIN) that replays recorded traffic.
 */

import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from './app-version.js';

/** A request that gets no answer in this long fails (the process is probably hung). thread/read of a huge rollout is the slow one. */
export const REQUEST_TIMEOUT_MS = 120 * 1000;
const START_TIMEOUT_MS = 30 * 1000;
/** A line longer than this is dropped with the process: a runaway, never a real message. */
const MAX_LINE_CHARS = 256 * 1024 * 1024;

const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/** The Rust target triple of the native build the npm package ships for this platform, or null. */
export function codexTriple(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (platform === 'linux' || platform === 'android') return arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
  return null;
}

/**
 * Where `codex` is on this machine, as something that can be spawned WITHOUT a shell (a shell would mangle the -c
 * values, which hold quotes and backslashes): { command, args } to put before `app-server`, or null.
 *
 * Order: APAKI_CODEX_BIN (a native file, or a .js/.mjs script run by this Node: tests use it); then, for every folder
 * on PATH, a native codex.exe / codex, or the npm shim (codex.cmd / codex.ps1 / codex) whose package holds the native
 * build or, failing that, bin/codex.js, which this Node runs. The shim itself is never spawned.
 */
export function findCodex({ env = process.env, platform = process.platform, arch = process.arch, execPath = process.execPath, realpath = fs.realpathSync } = {}) {
  const forced = env.APAKI_CODEX_BIN;
  if (forced) {
    if (!exists(forced)) return null;
    return /\.(?:mjs|cjs|js)$/i.test(forced) ? { command: execPath, args: [forced], label: forced } : { command: forced, args: [], label: forced };
  }
  const triple = codexTriple(platform, arch);
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const pkgName = triple ? `@openai/codex-${platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'}-${/^aarch64/.test(triple) ? 'arm64' : 'x64'}` : null;
  // PATH, then the places a global install lands when the app was started from a desktop shortcut with a short PATH
  // (taken from the environment given, so a test with its own PATH sees only that).
  const home = env.USERPROFILE || env.HOME || '';
  const extra = platform === 'win32'
    ? [env.APPDATA && path.join(env.APPDATA, 'npm')]
    : home ? ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin')] : [];
  const dirs = [...new Set([...String(env.PATH || env.Path || '').split(path.delimiter), ...extra].filter(Boolean))];
  for (const dir of dirs) {
    // A real binary on PATH (a standalone install, Homebrew, a cargo build).
    const direct = path.join(dir, exe);
    if (exists(direct) && !(platform !== 'win32' && isScript(direct))) return { command: direct, args: [], label: direct };
    // The npm shim: find the package it belongs to.
    for (const shim of ['codex.cmd', 'codex.ps1', 'codex']) {
      if (!exists(path.join(dir, shim))) continue;
      const pkg = path.join(dir, 'node_modules', '@openai', 'codex');
      if (!exists(path.join(pkg, 'package.json'))) continue;
      if (triple && pkgName) {
        for (const root of [path.join(pkg, 'node_modules', ...pkgName.split('/')), path.join(dir, 'node_modules', ...pkgName.split('/'))]) {
          const native = path.join(root, 'vendor', triple, 'bin', exe);
          if (exists(native)) return { command: native, args: [], label: native };
        }
      }
      const js = path.join(pkg, 'bin', 'codex.js');
      if (exists(js)) return { command: execPath, args: [js], label: js };
    }
    // The npm layout on macOS and Linux (2026-10-12, macOS port): <prefix>/bin/codex is a symlink to
    // <prefix>/lib/node_modules/@openai/codex/bin/codex.js, and the native build sits inside that package (or beside it).
    if (platform !== 'win32' && exists(direct)) {
      let real = null;
      try { real = realpath(direct); } catch { real = null; }
      const pkg = real ? path.resolve(path.dirname(real), '..') : null;
      if (pkg && exists(path.join(pkg, 'package.json'))) {
        if (triple && pkgName) {
          for (const root of [path.join(pkg, 'node_modules', ...pkgName.split('/')), path.join(pkg, '..', pkgName.split('/')[1])]) {
            const native = path.join(root, 'vendor', triple, 'bin', exe);
            if (exists(native)) return { command: native, args: [], label: native };
          }
        }
        const js = path.join(pkg, 'bin', 'codex.js');
        if (exists(js)) return { command: execPath, args: [js], label: js };
      }
    }
  }
  return null;
}

/** True when a file starts with a #! line (an npm shim on macOS or Linux), so it should go through the package lookup. */
function isScript(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(2);
      fs.readSync(fd, b, 0, 2, 0);
      return b[0] === 0x23 && b[1] === 0x21;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** A TOML basic string ("...") for a -c value: backslashes and quotes escaped, so a Windows path survives the parse. */
export const tomlString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
/** A TOML array of strings. */
export const tomlList = (list) => `[${list.map(tomlString).join(', ')}]`;
/** A TOML inline table of string values. */
export const tomlTable = (obj) => `{ ${Object.entries(obj).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)} = ${tomlString(v)}`).join(', ')} }`;

export class CodexRpcError extends Error {
  constructor(message, code = null, data = null) {
    super(message);
    this.name = 'CodexRpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * The app-server connection.
 *
 * Events: 'notification' (method, params), 'request' (id, method, params; answer with respond or respondError),
 * 'exit' (code, signal), 'log' (line from stderr).
 *
 * @param {object} o
 * @param {{command: string, args: string[]}} [o.binary]       from findCodex(); looked up lazily when absent
 * @param {string[]} [o.overrides]                              "key=value" pairs, each passed as -c on this process only
 * @param {object} [o.env]                                      environment for the process (BROWSER and friends)
 * @param {{name: string, title: string, version: string}} [o.clientInfo]
 * @param {Function} [o.spawn]                                  injectable for tests
 * @param {() => ({command: string, args: string[]}|null)} [o.locate]
 */
export class CodexAppServer extends EventEmitter {
  constructor({ binary = null, overrides = [], env = null, clientInfo = null, spawn = nodeSpawn, locate = findCodex, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    super();
    this.binary = binary;
    this.overrides = overrides;
    this.env = env;
    this.clientInfo = clientInfo || { name: 'myrlin-apaki', title: 'Myrlin Apaki', version: APP_VERSION };
    this.spawnFn = spawn;
    this.locate = locate;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.starting = null;
    this.initResult = null;
    this.nextId = 1;
    /** id -> { resolve, reject, method, timer } */
    this.pending = new Map();
    this.buf = '';
    this.stopping = false;
    /** Increments with every process started, so late events of a replaced process are ignored. */
    this.generation = 0;
  }

  /** True while a process is up and has answered initialize. */
  get ready() { return Boolean(this.child && this.initResult && !this.stopping); }

  get pid() { return this.child?.pid || null; }

  /** The text codex-cli reports as its user agent ("apaki/0.161.0 ..."), once started. */
  get userAgent() { return this.initResult?.userAgent || null; }

  /**
   * Starts the process if it is not running and finishes the initialize handshake. Concurrent callers share one
   * start. Rejects with a sentence a person can read when codex is missing or does not answer.
   */
  ensure() {
    if (this.ready) return Promise.resolve(this.initResult);
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async start() {
    this.stopping = false;
    const bin = this.binary || this.locate();
    if (!bin) throw new Error('Codex is not installed on this PC (no codex command was found). Install it with npm install -g @openai/codex and open the pane again.');
    this.binary = bin;
    const args = [...bin.args, 'app-server'];
    for (const o of this.overrides) args.push('-c', o);
    const gen = ++this.generation;
    const child = this.spawnFn(bin.command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env || process.env });
    this.child = child;
    this.buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (gen === this.generation) this.onData(d); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { if (gen === this.generation) this.emit('log', String(d)); });
    child.stdin.on('error', () => { /* the exit handler reports it */ });
    child.once('error', (e) => { if (gen === this.generation) this.onGone(null, null, e); });
    child.once('exit', (code, signal) => { if (gen === this.generation) this.onGone(code, signal); });
    try {
      this.initResult = await this.requestRaw('initialize', {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      }, START_TIMEOUT_MS);
    } catch (e) {
      // A process that does not initialize is not a server.
      this.kill();
      throw new Error(`Codex did not start: ${e.message}`);
    }
    this.write({ method: 'initialized' });
    return this.initResult;
  }

  onData(chunk) {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE_CHARS) { this.buf = ''; this.kill(); return; }
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
  }

  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { this.emit('log', `unreadable line from codex: ${line.slice(0, 200)}`); return; }
    if (!m || typeof m !== 'object') return;
    const hasId = m.id !== undefined && m.id !== null;
    if (typeof m.method === 'string') {
      try {
        if (hasId) this.emit('request', m.id, m.method, m.params ?? {});
        else this.emit('notification', m.method, m.params ?? {});
      } catch (e) {
        // A handler's bug must not kill the connection; a server request nobody answered is refused below.
        this.emit('log', `handler for ${m.method} failed: ${e.message}`);
        if (hasId) this.respondError(m.id, -32603, `Apaki could not handle ${m.method}`);
      }
      return;
    }
    if (!hasId) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new CodexRpcError(String(m.error.message || 'request failed'), m.error.code ?? null, m.error.data ?? null));
    else p.resolve(m.result);
  }

  write(obj) {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error('The Codex app-server is not running.');
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  requestRaw(method, params, timeoutMs = this.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(`Codex did not answer ${method} in ${Math.round(timeoutMs / 1000)} s.`, 'TIMEOUT'));
      }, timeoutMs) : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, method, timer });
      try { this.write({ id, method, params: params ?? undefined }); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  /** One request; starts the process first when it is not up. */
  async request(method, params, { timeoutMs } = {}) {
    await this.ensure();
    return this.requestRaw(method, params, timeoutMs);
  }

  /** A notification to the server (no answer). */
  async notify(method, params) {
    await this.ensure();
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /** Answers a server request with its result. A request already settled (the process exited) is ignored. */
  respond(id, result) {
    try { this.write({ id, result }); } catch { /* the process is gone: nothing waits for this */ }
  }

  respondError(id, code, message) {
    try { this.write({ id, error: { code, message } }); } catch { /* gone */ }
  }

  onGone(code, signal, error = null) {
    const expected = this.stopping;
    this.child = null;
    this.initResult = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CodexRpcError(expected ? 'The Codex app-server was stopped.' : `The Codex app-server stopped${error ? ` (${error.message})` : code != null ? ` (exit ${code})` : signal ? ` (${signal})` : ''}.`, 'EXIT'));
      this.pending.delete(id);
    }
    this.stopping = false;
    this.emit('exit', code, signal, { expected, error });
  }

  /** Kills the process now (only the one this object started). */
  kill() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try { child.stdin.end(); } catch { /* closed */ }
    try { child.kill(); } catch { /* gone */ }
  }

  /** Stops the process politely: stdin closes (the server exits on EOF), then it is killed if it lingers. */
  async stop({ graceMs = 1500 } = {}) {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const gone = new Promise((resolve) => child.once('exit', () => resolve()));
    try { child.stdin.end(); } catch { /* closed */ }
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, graceMs);
    t.unref?.();
    await Promise.race([gone, new Promise((r) => setTimeout(r, graceMs + 1500).unref?.())]);
    clearTimeout(t);
  }
}
