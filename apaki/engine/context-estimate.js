/**
 * context-estimate.js: how full a conversation's context window was at its
 * last call, read from the end of its transcript (Arthur, 2026-10-10 night:
 * "i dont see the context in anywhere"). The live meter (engine sendContext)
 * asks the running Claude Code process; a conversation that was only opened,
 * not run, has no process yet, so the meter stayed hidden until the first
 * turn. The last assistant message's usage (input + cache read + cache write
 * + output) is what the next call starts from, so it shows right away, marked
 * as an estimate, and the live number replaces it once Claude runs.
 *
 * Reads only the transcript's tail (TAIL_BYTES); never writes anything.
 */

import fs from 'node:fs';

/** How much of the transcript's end is read: the last assistant line is near the end. */
export const TAIL_BYTES = 512 * 1024;

/**
 * The window size of a model, when nothing measured it yet. The live meter
 * reports the real one and the engine remembers it per model (windowFor's
 * `known`); this is only the first guess. Claude 5 family models run with a
 * 1M window in Claude Code (measured for Opus 5.5 on 2026-10-10: 1,000,000).
 */
export function guessWindow(model) {
  const m = String(model || '').toLowerCase();
  if (/\[1m\]/.test(m) || /claude-(opus|sonnet|fable)-5/.test(m)) return 1_000_000;
  return 200_000;
}

/** The window for a model: a measured one when known, else the guess. */
export function windowFor(model, known = new Map()) {
  return known.get(model) || guessWindow(model);
}

/**
 * The usage of the last assistant message in some transcript text (JSON
 * lines), or null. Lines may be cut at the start (a tail read): those fail to
 * parse and are skipped.
 */
export function lastUsageIn(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const u = j?.type === 'assistant' ? j.message?.usage : null;
    if (!u || typeof u !== 'object') continue;
    const n = (k) => (Number.isFinite(Number(u[k])) ? Number(u[k]) : 0);
    const total = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
    if (total <= 0) continue;
    return { totalTokens: total, model: j.message?.model || null, at: j.timestamp || null };
  }
  return null;
}

/** Reads the end of a transcript file and returns lastUsageIn of it; null when it cannot be read. */
export async function lastUsage(file, { tailBytes = TAIL_BYTES } = {}) {
  if (!file) return null;
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return lastUsageIn(buf.toString('utf8'));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** The window's { ev: 'context' } fields for an estimate, or null. */
export function estimateEvent(usage, known) {
  if (!usage) return null;
  const max = windowFor(usage.model, known);
  return { percentage: Math.min(100, Math.round((100 * usage.totalTokens) / max)), totalTokens: usage.totalTokens, maxTokens: max, model: usage.model, estimate: true };
}
