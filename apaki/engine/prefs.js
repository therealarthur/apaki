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
 *
 * Off by default (Arthur, 2026-10-10 night: "should not auto compact"). 'off'
 * passes { autoCompactEnabled: false, idleCompaction: false }, checked live
 * against the bundled Claude Code the same night (getContextUsage reported
 * isAutoCompactEnabled false; with nothing passed it was true at 967k, with
 * 300k it was true at 267k). A conversation then grows until the window is
 * full; Compact now (the context meter) or /compact summarizes it by hand.
 * The sizes stay as choices for anyone who wants Claude Code to do it.
 *
 * releaseHiddenMin (2026-10-12, input lag and memory): a Claude Code process is kept for every open pane, about 150 MB
 * each, and one in a tab that is not showing does nothing for hours. After this many minutes hidden and idle (no turn,
 * no question, no background task) the host ends that pane's process and frees its session lock; the pane stays, and
 * its next message starts the process again, resuming from disk (about 1.3 s measured, with the real settings, hooks
 * and plugins). 0 turns it off. See host.js planIdle (hiddenSince, hideCloseMs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { latchDir } from './host.js';

/** The choices, in the sheet's order; 'off' turns auto-compact off, 'default' leaves it to Claude Code (nothing is passed). */
export const COMPACT_CHOICES = Object.freeze(['off', 200000, 300000, 500000, 'default']);
/** What a new install starts with: off (Arthur, 2026-10-10 night; 300k before that). */
export const COMPACT_DEFAULT = 'off';

/** The choices of "Free hidden conversations", in minutes, in the sheet's order; 0 is off. */
export const RELEASE_CHOICES = Object.freeze([0, 5, 15, 30, 60]);
/** What a new install starts with: 15 minutes. */
export const RELEASE_DEFAULT = 15;

/** One of RELEASE_CHOICES: a number or its text; anything else is the install default. */
export function normalizeRelease(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return RELEASE_CHOICES.includes(n) ? n : RELEASE_DEFAULT;
}

/** Where the engine's settings are kept. */
export function prefsFile(env = process.env) {
  return path.join(latchDir(env), 'apaki-settings.json');
}

/** One of COMPACT_CHOICES: a number or its text ('300000'), 'off' or 'default'; anything else is the install default. */
export function normalizeCompact(v) {
  if (v === 'default') return 'default';
  if (v === 'off' || v === false) return 'off';
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return COMPACT_CHOICES.includes(n) ? n : COMPACT_DEFAULT;
}

/** The settings as saved; a missing or damaged file reads as the defaults. */
export function loadPrefs(file = prefsFile()) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet, or not readable */ }
  return {
    autoCompact: normalizeCompact(j && typeof j === 'object' ? j.autoCompact : undefined),
    releaseHiddenMin: normalizeRelease(j && typeof j === 'object' ? j.releaseHiddenMin : undefined),
  };
}

/** Saves the settings atomically (a crash mid-write never leaves half a file). */
export function savePrefs(file, prefs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ autoCompact: normalizeCompact(prefs?.autoCompact), releaseHiddenMin: normalizeRelease(prefs?.releaseHiddenMin) }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * The per-process Claude Code settings for a choice: { autoCompactWindow: n }
 * (100000 to 1000000 tokens), { autoCompactEnabled: false, idleCompaction:
 * false } for 'off', or null for 'default' so Claude Code (and the user's own
 * settings files) decide as before.
 */
export function compactSettings(choice) {
  const c = normalizeCompact(choice);
  if (c === 'off') return { autoCompactEnabled: false, idleCompaction: false };
  return c === 'default' ? null : { autoCompactWindow: c };
}
