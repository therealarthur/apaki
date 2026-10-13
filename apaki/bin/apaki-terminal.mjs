#!/usr/bin/env node
/**
 * apaki-terminal.mjs: what an "Open in terminal" window runs (2026-10-12).
 *
 * WHY (Arthur, 2026-10-12: "there should also be an "open in terminal" button to just open the exact session with all
 * settings/effort/models/etc in a terminal window"): Apaki's engine builds the exact command (apaki/engine/console.js,
 * the same builder its in-pane console uses: `claude --resume <id>` with the pane's model, effort, permission mode,
 * settings and billing, or `codex resume <id>` with its model, effort and preset), writes it to a spec file under
 * ~/.claude/latch/console, and opens a terminal window running this script with Apaki's own Node.
 *
 * This script:
 *   - reads the spec and deletes it (it holds no secrets: the environment changes only, never the environment);
 *   - says the window has the conversation (held-<id>.json, and for Claude Code the session lock, app 'apaki-terminal'),
 *     so Apaki's pane does not write over it and shows "in use" instead;
 *   - runs the TUI in this window (it owns the keyboard, Ctrl+C included) and exits with its code;
 *   - when Apaki takes the conversation back (Take it back in the pane), stops the TUI with a note before it can write
 *     again, ending only the process tree it started, by PID.
 *
 * Usage: node apaki-terminal.mjs <spec.json>
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from '../../src/auth.js';
import { releaseLock, takeLock } from '../../src/sessions.js';
import { applyEnv, clearHeld, heldFile, writeHeld } from '../engine/console.js';

const specFile = process.argv[2];
let spec;
try {
  spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
} catch (e) {
  process.stderr.write(`Myrlin Apaki: could not read what to run (${e.message}).\n`);
  process.exit(2);
}
try { fs.unlinkSync(specFile); } catch { /* already gone */ }

const dir = path.dirname(specFile);
const { sessionId, kind } = spec;
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[22m` : s);

if (sessionId) {
  writeHeld(dir, { sessionId, kind, pid: process.pid, cwd: spec.cwd });
  // Claude Code sessions also carry latch's lock, which latch, Apaki and the prompt-relay hook all respect.
  if (kind === 'claude') takeLock(sessionId, { force: true, app: 'apaki-terminal' });
}

let child = null;
let done = false;
let takenBack = false;

/** Lets go of the conversation (Apaki may write again). */
function letGo() {
  if (!sessionId) return;
  clearHeld(dir, sessionId, process.pid);
  if (kind === 'claude') releaseLock(sessionId);
}

/** Lets go of the conversation and leaves with `code` (after a moment to read the note when Apaki took it back). */
function finish(code) {
  if (done) return;
  done = true;
  letGo();
  if (takenBack) setTimeout(() => process.exit(code), 4000);
  else process.exit(code);
}

/** Ends the TUI and what it started, by its PID (only the processes this window started). */
function endChild() {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } }
}

// The TUI owns Ctrl+C; this runner only waits for it.
process.on('SIGINT', () => {});
// The window was closed: let go of the conversation before Windows ends this process.
process.on('SIGHUP', () => { endChild(); finish(0); });

if (spec.note) process.stdout.write(`${dim(spec.note)}\n`);
process.stdout.write(`${dim(`Myrlin Apaki: ${spec.display || spec.file}`)}\n`);

// LATCH_LOCK_PID: this runner holds the lock, so the relay hook blocks this window if Apaki takes the session back.
const env = applyEnv(childEnv(null), { ...spec, envSet: { ...(spec.envSet || {}), ...(kind === 'claude' ? { LATCH_LOCK_PID: String(process.pid) } : {}) } });
child = spawn(spec.file, spec.args || [], { cwd: spec.cwd || process.cwd(), env, stdio: 'inherit' });
child.on('error', (e) => { process.stderr.write(`Myrlin Apaki: could not start ${spec.file}: ${e.message}\n`); finish(1); });
child.on('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));

// Taken back in Apaki: stop before this window writes again.
if (sessionId) {
  setInterval(() => {
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(heldFile(dir, sessionId), 'utf8')); } catch { /* removed */ }
    if (rec?.takenBy && !takenBack) {
      takenBack = true;
      endChild();
      letGo();
      process.stdout.write(`\n${dim('Myrlin Apaki took this conversation back, so this window stopped before it could write anything. Continue it in Apaki.')}\n`);
      setTimeout(() => finish(0), 300);
    }
  }, 1000).unref();
}
