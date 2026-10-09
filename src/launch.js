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
import os from 'node:os';
import path from 'node:path';

const SAFE_ARG_RE = /^[A-Za-z0-9._:[\]-]+$/;

/** Path of the native Claude Code binary, or null to fall back to `claude` on PATH. */
export function claudeBinary() {
  if (process.env.LATCH_CLAUDE_BIN) return process.env.LATCH_CLAUDE_BIN;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const exe = path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(exe) ? exe : null;
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
