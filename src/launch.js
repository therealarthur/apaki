/**
 * launch.js
 *
 * Opens the real Claude Code TUI on a session, billed to the chosen API key.
 * This is latch's default mode (Arthur, 2026-10-09: the interface must be
 * "1 to 1 with the claude code tui", so latch runs Claude Code itself rather
 * than imitating it; the SDK UI remains as `latch --lite`).
 *
 * How the key is used: interactive Claude Code takes ANTHROPIC_API_KEY from its
 * environment once the key has been approved, which it asks for once per key
 * and remembers in ~/.claude.json (customApiKeyResponses, last 20 characters).
 * That takes precedence over the subscription login (Claude Code auth docs,
 * "Authentication precedence"). latch only reads that file, never writes it.
 *
 * The native claude.exe from the global npm install is started directly. Going
 * through the claude.cmd shim would add a batch file, and Windows then asks
 * "Terminate batch job (Y/N)?" after a Ctrl+C.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const SAFE_ARG_RE = /^[A-Za-z0-9._:[\]-]+$/;
const require = createRequire(import.meta.url);

/**
 * The Claude Code binary the Agent SDK ships with (its per-platform package,
 * e.g. @anthropic-ai/claude-agent-sdk-win32-x64/claude.exe), or null.
 *
 * WHY (fresh-install audit, 2026-10-10): a PC that never installed Claude Code
 * has no global npm claude.exe and no `claude` on PATH, so `latch --relay`,
 * keep-warm's CLI ping and sign-in had nothing to run. Myrlin Apaki's package
 * already carries this full native Claude Code (the SDK runs it for every
 * pane), so it is the fallback.
 */
export function bundledClaudeBinary() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const names = [`${process.platform}-${process.arch}`];
  if (process.platform === 'linux') names.push(`${process.platform}-${process.arch}-musl`);
  for (const name of names) {
    try {
      const dir = path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${name}/package.json`));
      const file = path.join(dir, exe);
      if (fs.existsSync(file)) return file;
    } catch { /* that platform package is not installed */ }
  }
  return null;
}

/**
 * Path of the native Claude Code binary, or null to fall back to `claude` on PATH.
 * Order: LATCH_CLAUDE_BIN, the user's own global npm install (kept first so a
 * machine with Claude Code installed keeps using its version), then the binary
 * bundled with the Agent SDK.
 */
export function claudeBinary() {
  if (process.env.LATCH_CLAUDE_BIN) return process.env.LATCH_CLAUDE_BIN;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const exe = path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(exe) ? exe : bundledClaudeBinary();
}

/** Claude Code arguments for a latch launch. */
export function claudeArgs({ sessionId, model, effort, permissionMode }) {
  const args = [];
  if (sessionId) args.push('--resume', sessionId);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else if (permissionMode) args.push('--permission-mode', permissionMode);
  for (const a of args) {
    if (!a.startsWith('--') && !SAFE_ARG_RE.test(a)) throw new Error(`refusing an unexpected argument: ${a}`);
  }
  return args;
}

/** True when Claude Code has already approved this key for interactive use. Read only. */
export function keyApproved(key, file = path.join(os.homedir(), '.claude.json')) {
  try {
    const responses = JSON.parse(fs.readFileSync(file, 'utf8')).customApiKeyResponses || {};
    return (responses.approved || []).includes(key.slice(-20));
  } catch {
    return false;
  }
}

/**
 * Runs Claude Code in this terminal and calls onExit(code, error) when it ends.
 * Claude Code owns the terminal meanwhile, including Ctrl+C.
 */
export function launchClaude({ args, cwd, env, onExit }) {
  process.on('SIGINT', () => { /* Claude Code handles it */ });
  const bin = claudeBinary();
  const child = bin
    ? spawn(bin, args, { cwd, env, stdio: 'inherit' })
    : spawn('claude', args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('error', (error) => onExit(1, error));
  child.on('exit', (code, signal) => onExit(code ?? (signal ? 1 : 0)));
}
