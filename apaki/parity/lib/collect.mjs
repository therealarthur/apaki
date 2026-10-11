/**
 * collect.mjs: run every extractor of the upstream parity tracker and return
 * fresh snapshots (apaki/parity/PARITY.md, 2026-10-11). Shared by extract.mjs
 * (which saves them) and diff.mjs (which compares them with the saved ones).
 *
 * Nothing here writes a file. The codex extractor writes a temp folder for the
 * schema and deletes it before returning.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectClaudeSdk } from './claude-sdk.mjs';
import { collectCodex } from './codex.mjs';
import { collectDesktop } from './desktop.mjs';

/** apaki/parity (the folder that holds features.json, snapshots, manual). */
export const PARITY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The repository root (two folders above apaki/parity). */
export const REPO_ROOT = path.resolve(PARITY_ROOT, '..', '..');

/** Product names the extractors can produce. */
export const EXTRACTABLE = ['claude-sdk', 'codex', 'claude-desktop', 'chatgpt-desktop'];

/**
 * @param {object} [o]
 * @param {string[]} [o.only] limit to these products
 * @param {Date} [o.now]
 * @returns {{ snapshots: Object<string, object>, notes: string[] }}
 */
export function collectAll({ only, now = new Date(), root = PARITY_ROOT, repoRoot = REPO_ROOT } = {}) {
  const want = (p) => !only || !only.length || only.includes(p);
  const snapshots = {};
  const notes = [];
  if (want('claude-sdk')) {
    try {
      const r = collectClaudeSdk(repoRoot, now);
      snapshots['claude-sdk'] = r.snapshot;
      notes.push(...r.notes.map((n) => `claude-sdk: ${n}`));
    } catch (e) {
      notes.push(`claude-sdk: extraction failed: ${e.message}`);
    }
  }
  if (want('codex')) {
    try {
      const r = collectCodex(now);
      if (r.snapshot) snapshots.codex = r.snapshot;
      notes.push(...r.notes.map((n) => `codex: ${n}`));
    } catch (e) {
      notes.push(`codex: extraction failed: ${e.message}`);
    }
  }
  for (const p of ['claude-desktop', 'chatgpt-desktop']) {
    if (!want(p)) continue;
    try {
      const r = collectDesktop(root, p, now);
      snapshots[p] = r.snapshot;
      notes.push(...r.notes);
    } catch (e) {
      notes.push(`${p}: extraction failed: ${e.message}`);
    }
  }
  return { snapshots, notes };
}
