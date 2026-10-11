/**
 * prefs.js: the few Apaki settings the engine itself keeps, in one small JSON
 * under ~/.claude/latch (apaki-settings.json; CLAUDE_CONFIG_DIR moves
 * ~/.claude), next to the workspace and host files. Never ~/.claude/settings.json
 * or ~/.claude.json: those are Claude Code's, and Apaki does not write them.
 *
 * Today: autoCompact, "Auto-compact at" in the Settings sheet (Arthur,
 * 2026-10-10, to cut cost). Opus 5.5's 1M window only auto-compacts near 967k
 * tokens, so a long conversation re-reads ~550k tokens on every call. The
 * choice is passed to every Claude Code process Apaki starts as its
 * `autoCompactWindow` setting, through the Agent SDK's `settings` option (the
 * same layer as `claude --settings`, in force for that process only), see
 * compactSettings and SessionRunner.flagSettings.
 */

import fs from 'node:fs';
import path from 'node:path';
import { latchDir } from './host.js';

/** The choices, in the sheet's order; 'default' leaves it to Claude Code (nothing is passed). */
export const COMPACT_CHOICES = Object.freeze([200000, 300000, 500000, 'default']);
/** What a new install starts with (Arthur approved 300k). */
export const COMPACT_DEFAULT = 300000;

/** Where the engine's settings are kept. */
export function prefsFile(env = process.env) {
  return path.join(latchDir(env), 'apaki-settings.json');
}

/** One of COMPACT_CHOICES: a number or its text ('300000'), or 'default'; anything else is the install default. */
export function normalizeCompact(v) {
  if (v === 'default') return 'default';
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return COMPACT_CHOICES.includes(n) ? n : COMPACT_DEFAULT;
}

/** The settings as saved; a missing or damaged file reads as the defaults. */
export function loadPrefs(file = prefsFile()) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet, or not readable */ }
  return { autoCompact: normalizeCompact(j && typeof j === 'object' ? j.autoCompact : undefined) };
}

/** Saves the settings atomically (a crash mid-write never leaves half a file). */
export function savePrefs(file, prefs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ autoCompact: normalizeCompact(prefs?.autoCompact) }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * The per-process Claude Code settings for a choice: { autoCompactWindow: n }
 * (100000 to 1000000 tokens), or null for 'default' so Claude Code (and the
 * user's own settings files) decide as before.
 */
export function compactSettings(choice) {
  const c = normalizeCompact(choice);
  return c === 'default' ? null : { autoCompactWindow: c };
}
