/** Kimi Code 2.3.1 ACP transport. Only children started here are ever stopped. */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_VERSION } from './app-version.js';

export const KIMI_MODEL = 'kimi-code/k3.1-pro';
export const KIMI_EFFORT = 'max';
export const isKimiId = (id) => typeof id === 'string' && id.startsWith('kimi:');
export const isKimiPane = (p) => p?.kind === 'kimi';
export function kimiSessionId(id) {
  const raw = String(id || '').replace(/^kimi:/, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(raw)) throw new Error('Invalid Kimi session id.');
  return raw;
}
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/** Resolve npm entry points directly, including the portable Windows kit. Never execute an npm shell shim. */
export function findKimi({ env = process.env, platform = process.platform, execPath = process.execPath, exists = isFile } = {}) {
  const p = platform === 'win32' ? path.win32 : path;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const kit = p.join(home, 'Projects', 'kimi-kit-20261023', 'state');
  const portable = p.join(kit, 'npm', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
  const portableNode = p.join(kit, 'node-v22.22.1-win-x64', 'node.exe');
  const wrap = (file, node = execPath) => {
    if (!exists(file) || /\.(?:cmd|bat|ps1)$/i.test(file)) return null;
    return /\.(?:mjs|cjs|js)$/i.test(file)
      ? { command: env.APAKI_KIMI_NODE || node, args: [file] }
      : { command: file, args: [] };
  };
  if (env.APAKI_KIMI_BIN) return wrap(env.APAKI_KIMI_BIN);
  if (platform === 'win32' && exists(portable) && exists(portableNode)) return wrap(portable, portableNode);
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform === 'win32' && env.APPDATA) dirs.push(p.join(env.APPDATA, 'npm'));
  for (const dir of dirs) {
    for (const root of [p.join(dir, 'node_modules'), p.join(dir, '..', 'lib', 'node_modules')]) {
      const found = wrap(p.join(root, '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs'));
      if (found) return found;
    }
    const direct = p.join(dir, platform === 'win32' ? 'kimi.exe' : 'kimi');
    if (exists(direct)) return wrap(direct);
  }
  return null;
}

export function kimiHome(env = process.env, platform = process.platform, exists = isFile) {
  if (env.KIMI_CODE_HOME) return env.KIMI_CODE_HOME;
  const p = platform === 'win32' ? path.win32 : path;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const kit = p.join(home, 'Projects', 'kimi-kit-20261023', 'state', 'kimi-home');
  if (platform === 'win32' && exists(p.join(kit, 'config.toml'))) return kit;
  return p.join(home, '.kimi-code');
}

export function kimiEnv(env = process.env) {
  return { ...env, KIMI_CODE_HOME: kimiHome(env), KIMI_SECONDARY_MODEL: KIMI_MODEL, KIMI_SECONDARY_EFFORT: 'high' };
}

export class KimiClient extends EventEmitter {
  constructor({ binary = null, env = process.env, cwd, timeoutMs = 30000, spawnFn = spawn } = {}) {
    super();
    this.binary = binary;
    this.env = env;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.spawnFn = spawnFn;
    this.pending = new Map();
    this.nextId = 0;
    this.child = null;
    this.closed = false;
    this.buf = '';
  }

  async start() {
    const bin = this.binary || findKimi({ env: this.env });
    if (!bin) throw new Error('Kimi Code was not found. Set APAKI_KIMI_BIN to its dist/main.mjs and APAKI_KIMI_NODE to Node 22.19 or newer, then restart the Apaki host.');
    const child = this.child = this.spawnFn(bin.command, [...bin.args, '-m', KIMI_MODEL, 'acp'], {
      cwd: this.cwd, env: kimiEnv(this.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => this.read(data));
    // ACP errors arrive through JSON RPC. Stderr may contain credential or file details, so never forward it to a log.
    child.stderr.resume();
    child.stdin.on('error', () => this.fail(new Error('Kimi closed its input. Reopen this pane to continue.')));
    child.once('error', () => this.fail(new Error('Kimi could not start. Check its Node and CLI paths.')));
    child.once('exit', () => this.fail(new Error('Kimi stopped. Reopen this pane to continue; the last prompt was not retried.')));
    try {
      const result = await this.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'myrlin-apaki', version: APP_VERSION },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: true } },
      });
      if (result?.protocolVersion !== 1 || result?.agentCapabilities?.loadSession !== true) throw new Error('This Kimi ACP version does not support protocol 1 with session loading.');
      this.capabilities = result.agentCapabilities;
      return result;
    } catch (e) { await this.stop(); throw e; }
  }

  write(message) {
    if (this.closed || !this.child?.stdin.writable) throw new Error('Kimi is disconnected. Reopen this pane.');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.fail(new Error(`Kimi did not answer ${method}. Reopen this pane; no prompt was retried.`));
        this.stop().catch(() => {});
      }, timeoutMs) : null;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  notify(method, params) { this.write({ method, params }); }
  respond(id, result) { if (!this.closed) this.write({ id, result }); }
  reject(id, code, message) { if (!this.closed) this.write({ id, error: { code, message } }); }

  read(data) {
    if (this.closed) return;
    this.buf += data;
    let end;
    while ((end = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, end);
      this.buf = this.buf.slice(end + 1);
      if (line.length > 16 * 1024 * 1024) { this.badFrame(); return; }
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { this.badFrame(); return; }
      if (!m || m.jsonrpc !== '2.0' || typeof m !== 'object') { this.badFrame(); return; }
      if (typeof m.method === 'string') {
        const request = m.id !== undefined && m.id !== null;
        try { this.emit(request ? 'request' : 'notification', ...(request ? [m.id] : []), m.method, m.params || {}); }
        catch { if (request) this.reject(m.id, -32603, 'Apaki could not handle this request.'); }
      } else {
        const pending = this.pending.get(m.id);
        if (!pending) continue;
        this.pending.delete(m.id);
        clearTimeout(pending.timer);
        if (m.error) {
          const e = new Error(m.error.code === -32000 ? 'Kimi needs its CLI OAuth login. Sign in through the portable Kimi CLI, then reopen this pane.' : String(m.error.message || 'Kimi rejected the request.'));
          e.code = m.error.code;
          e.data = m.error.data;
          pending.reject(e);
        } else pending.resolve(m.result);
      }
    }
    if (this.buf.length > 16 * 1024 * 1024) this.badFrame();
  }
  badFrame() { this.fail(new Error('Kimi sent an invalid ACP frame. Reopen this pane.')); this.stop().catch(() => {}); }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.emit('gone', error);
  }
  async stop() {
    const child = this.child;
    this.fail(new Error('Kimi pane closed.'));
    if (!child || child.exitCode !== null || child.signalCode) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 1500);
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    timer.unref(); force.unref();
    await this.exited;
    clearTimeout(timer); clearTimeout(force);
  }
}
