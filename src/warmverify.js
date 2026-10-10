/**
 * warmverify.js
 *
 * `latch warm verify`: proves (or disproves) on this account and model that a
 * keep-warm ping extends a cache's lifetime, before keep-warm runs unattended.
 * Anthropic documents that a cache read refreshes the entry, but had not
 * measured refreshing an existing entry on Opus 5.5 (Arthur's notes,
 * 2026-10-09), so this checks it directly:
 *
 *   t=0     two scratch conversations, T and C, each opening with ~25k tokens
 *           of different text, so their caches cannot stand in for each other
 *   t=52m   ping T the way the keeper would (nothing saved); leave C alone
 *   t=68m   one real turn on each: 8 minutes past the 1-hour lifetime of the
 *           original writes
 *
 * If the ping refreshed T, T's last turn reads its text from cache while C has
 * to write its own again. The result goes to ~/.claude/latch/warm/verify.json
 * (shown by `latch warm status` and /warm); the scratch sessions are deleted.
 * Cost on Opus 5.5: about $1.50 (two ~57k-token cache writes, then the control writing its text again).
 */

import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR, childEnv, vaultKey } from './auth.js';
import { SessionRunner } from './runner.js';
import { findSessionFiles } from './sessions.js';
import { keyFingerprint, ping } from './warm.js';

// LATCH_VERIFY_SCALE shrinks the waits for a smoke test (e.g. 0.01); the real check uses 1.
const MIN = 60 * 1000 * (Number(process.env.LATCH_VERIFY_SCALE) || 1);
const DIR = () => path.join(process.env.LATCH_DIR || path.join(CLAUDE_DIR, 'latch'), 'warm');
const OUT = () => path.join(DIR(), 'verify.json');

/**
 * About 25k tokens of plain, numbered prose, labelled with the conversation's
 * name so the two conversations differ from their first line on. (A random
 * syllable version tokenized ten times larger than intended and was refused
 * by the API, 2026-10-09; ordinary sentences keep the size predictable.)
 */
function filler(name, paragraphs = 280) {
  const out = [];
  for (let i = 1; i <= paragraphs; i++) {
    out.push(`Note ${i} for conversation ${name}: the weather station on the hill logs temperature, wind speed and rainfall every ten minutes, `
      + `and on day ${i} the readings were copied into the shared notebook, checked against the previous day, and filed under week ${Math.ceil(i / 7)}. `
      + 'Nothing unusual was found, the batteries were fine, and the next check is planned for the following morning.');
  }
  return out.join('\n');
}

function save(result) {
  fs.mkdirSync(DIR(), { recursive: true });
  fs.writeFileSync(OUT(), JSON.stringify(result, null, 2));
}

const sleepUntil = (t) => new Promise((r) => setTimeout(r, Math.max(0, t - Date.now())));
const usage = (m) => {
  const u = m?.usage || {};
  return { read: u.cache_read_input_tokens || 0, write: (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0), cost: m?.latchTurnCost ?? null };
};

export async function runVerify({ keyWords = 'myrlin.io', model = 'claude-opus-5-5', effort = 'xhigh' } = {}) {
  const key = vaultKey(keyWords);
  const started = Date.now();
  const result = { startedAt: new Date(started).toISOString(), doneBy: new Date(started + 70 * MIN).toISOString(), model, effort, key: key.name || keyWords, steps: [] };
  if (key.error) { result.verdict = `could not start: ${key.error}`; save(result); return result; }
  save(result);
  const cwd = path.join(DIR(), 'verify-wd');
  fs.mkdirSync(cwd, { recursive: true });
  const make = (sessionId = null) => {
    const r = new SessionRunner({ sessionId, cwd, env: childEnv(key.key), model, effort, permissionMode: 'bypassPermissions', canUseTool: async (_n, i) => ({ behavior: 'allow', updatedInput: i }), onMessage: () => {}, onStderr: () => {} });
    r.noWarm = true; // the keeper must not touch these
    return r;
  };
  const step = (name, data) => { result.steps.push({ at: new Date().toISOString(), name, ...data }); save(result); };
  const runners = { T: make(), C: make() };
  const ids = {};
  try {
    for (const name of ['T', 'C']) {
      const r = runners[name];
      r.start();
      const m = await r.send(`Cache test, conversation ${name}. Below is reference text; nothing to do with it yet. Reply with exactly: ok\n\n${filler(name)}`);
      ids[name] = r.sessionId;
      await r.stop();
      step(`${name} first turn (writes its cache)`, usage(m));
    }
    const t0 = Date.parse(result.steps[1].at);
    await sleepUntil(t0 + 52 * MIN);
    const p = await ping({ sessionId: ids.T, mode: 'sdk', cwd, options: { model, effort, permissionMode: 'bypassPermissions' }, keyFp: keyFingerprint(key.key) }, key.key);
    step('T keep-warm ping (C left alone)', { read: p.read, write: p.write, cost: p.cost ?? null, ok: p.ok, error: p.error || null });
    await sleepUntil(t0 + 68 * MIN);
    const last = {};
    for (const name of ['T', 'C']) {
      const r = make(ids[name]);
      runners[name] = r;
      r.start();
      last[name] = usage(await r.send('Reply with exactly: done'));
      await r.stop();
      step(`${name} turn 68 min after its cache was written`, last[name]);
    }
    // The two conversations are the same size and share Claude Code's system
    // prompt, so the comparison is between them: the text only C has to
    // write again (~25k tokens) shows as T reading that much more from cache.
    // Both turns also write a few thousand tokens of per-turn context, so
    // neither turn's own write count proves anything alone.
    const MARGIN = 10000;
    const tKept = last.T.read >= last.C.read + MARGIN && last.C.write >= last.T.write + MARGIN;
    const bothLost = p.ok && last.T.read < 0.6 * (p.read || 1) && Math.abs(last.T.read - last.C.read) < MARGIN && last.C.write >= MARGIN;
    result.verdict = !p.ok ? `inconclusive: the ping failed (${p.error})`
      : tKept ? `PROVEN: 68 min after the first writes, the pinged conversation read ${last.T.read} tokens from cache and wrote ${last.T.write}, while the unpinged control read ${last.C.read} and had to write ${last.C.write}. Pings extend the cache on ${model}.`
      : bothLost ? `NOT PROVEN: both conversations had to write their text again (pinged read ${last.T.read}, control ${last.C.read}), so the ping did not extend the cache on ${model}. Keep-warm should stay off.`
      : `inconclusive: the pinged conversation read ${last.T.read} and the control ${last.C.read} (control wrote ${last.C.write}); the control's cache may not have expired, or the timing slipped (PC asleep?).`;
    result.finishedAt = new Date().toISOString();
    save(result);
  } catch (e) {
    result.verdict = `failed: ${e.message || e}`;
    save(result);
  } finally {
    for (const r of Object.values(runners)) { try { await r.stop(); } catch { /* stopped */ } }
    // Delete the scratch sessions; keep only verify.json.
    const dirs = new Set();
    for (const id of Object.values(ids)) {
      for (const f of findSessionFiles(id)) {
        dirs.add(path.dirname(f));
        try { fs.rmSync(f, { force: true }); fs.rmSync(f.replace(/\.jsonl$/, ''), { recursive: true, force: true }); } catch { /* gone */ }
      }
    }
    // The project folder Claude Code made for the scratch cwd, once empty.
    // Claude Code also makes an empty memory/ folder there.
    for (const d of dirs) {
      try {
        const left = fs.readdirSync(d);
        const emptyMemory = left.length === 1 && left[0] === 'memory' && !fs.readdirSync(path.join(d, 'memory')).length;
        if (!left.length || emptyMemory) fs.rmSync(d, { recursive: true, force: true });
      } catch { /* not ours to remove */ }
    }
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* gone */ }
  }
  return result;
}
