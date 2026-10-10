/**
 * warm.js
 *
 * Keeps the prompt cache of recently used sessions warm, so coming back to a
 * long conversation on an API key reads it from cache instead of writing it
 * again. On this PC a cache write cost about $8 per million tokens on Opus 5.5
 * (so $3-8 to reopen a 400k-1M token conversation), a cache read about a tenth
 * of that (measured from relayed turns, 2026-10-09).
 *
 * How: a ping resumes the session with the options its last real turn used,
 * saves nothing (persistSession false / --no-session-persistence, so the
 * transcript is untouched) and asks for a one-word reply. That request reads
 * the conversation from cache, which restarts the cache's lifetime (1 hour
 * with promptCacheTtl "1h"). Verified 2026-10-09 on a scratch session: the
 * ping read 46.6k of ~49.8k tokens from cache, wrote 0 bytes to the
 * transcript, and the next real turn still read the cache.
 *
 * Who does what:
 *   - SessionRunner (latch, Apaki) and the prompt-relay hook call noteUse()
 *     after each turn billed to an API key, recording how that turn ran.
 *   - The keeper (`latch warm run`, one detached process) pings each session
 *     that is still warm about 12 minutes before its cache would expire, for
 *     up to `hours` after its last real message, then lets it go.
 *
 * Guards: never pings a cache that has probably expired already (that would
 * pay the very write it exists to avoid); stops warming a session after a
 * ping that missed the cache; a daily spend cap across all sessions; API-key
 * billing only (subscriptions are not billed per token); promptCacheTtl must
 * be "1h" (with 5-minute caches the pings would cost more than they save).
 *
 * Files in ~/.claude/latch/warm/ (no secrets; keys are kept as a short hash):
 *   settings.json    {on, hours, dailyCapUsd}
 *   use/<id>.json    how the session's last real turn ran (written per turn)
 *   state/<id>.json  the keeper's view: last ping, result, status
 *   spend.json       {day, usd} spent on pings today
 *   keeper.json      {pid, startedAt} of the running keeper
 *   warm.log         one JSON line per ping or skip decision
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_DIR, childEnv, keySections, liveLogin } from './auth.js';
import { claudeBinary } from './launch.js';
import { ago, findSessionFiles, getSessionInfo, lastCostTotal, readTail } from './sessions.js';

const DIR = () => path.join(process.env.LATCH_DIR || path.join(CLAUDE_DIR, 'latch'), 'warm');
// 24 h after the last real message, as Arthur asked (2026-10-09); pings never extend it.
const DEFAULTS = { on: false, hours: 24, dailyCapUsd: 5 };
const MIN = 60 * 1000;
// With a 1-hour cache: ping 52 minutes after the last real use or hit ping,
// and treat anything older than 58 minutes as already expired. The cache's
// hour runs from a request's START, and lastUseAt is when the turn ended, so
// the margin covers the last request of a turn as well as a slow ping.
const PING_AFTER_MS = 52 * MIN;
const COLD_AFTER_MS = 58 * MIN;
// A ping is a hit when at least this share of its input came from cache.
const HIT_SHARE = 0.8;
const LOOP_MS = 30 * 1000;
const PING_TIMEOUT_MS = 5 * MIN;
const PING_PROMPT = 'Automatic keep-alive request to keep this conversation in the prompt cache; nothing to do. Reply with exactly: ok';

/* ---------- small file helpers ---------- */

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function log(entry) {
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.appendFileSync(path.join(DIR(), 'warm.log'), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch { /* logging is best effort */ }
}

const useFile = (id) => path.join(DIR(), 'use', `${id}.json`);
const stateFile = (id) => path.join(DIR(), 'state', `${id}.json`);

export function readSettings() {
  return { ...DEFAULTS, ...readJson(path.join(DIR(), 'settings.json'), {}) };
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch, changedAt: new Date().toISOString() };
  writeJson(path.join(DIR(), 'settings.json'), next);
  return next;
}

/** The cache lifetime Claude Code is set to use, from ~/.claude/settings.json. */
export function cacheTtl() {
  const s = readJson(path.join(CLAUDE_DIR, 'settings.json'), {});
  return s.promptCacheTtl || '5m';
}

/** Short, non-reversible id of a key, so files never hold the key itself. */
export function keyFingerprint(key) {
  return key ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) : null;
}

/** The key with this fingerprint: a credentials.md key, or the live login when Glass switched it to one. */
export function keyForFingerprint(fp) {
  const live = liveLogin();
  if (live.kind === 'key' && keyFingerprint(live.key) === fp) return live.key;
  try {
    for (const s of keySections()) {
      for (const m of s.body.join('\n').matchAll(/sk-ant-[A-Za-z0-9_-]{20,}/g)) {
        if (keyFingerprint(m[0]) === fp) return m[0];
      }
    }
  } catch { /* no vault */ }
  return null;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function spentToday() {
  const s = readJson(path.join(DIR(), 'spend.json'), {});
  return s.day === today() ? Number(s.usd) || 0 : 0;
}

function addSpend(usd) {
  writeJson(path.join(DIR(), 'spend.json'), { day: today(), usd: spentToday() + (usd || 0) });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* ---------- recording real turns ---------- */

/**
 * Records how a real turn ran so the keeper can repeat it as a ping, and makes
 * sure the keeper is running. Does nothing when keep-warm is off, when the
 * turn was not billed to an API key, or without a session id.
 *
 * @param {object} u
 * @param {string} u.sessionId
 * @param {'sdk'|'cli'} u.mode   'sdk' = latch/Apaki runner options, 'cli' = claude -p args (relay hook)
 * @param {string} u.key         the API key the turn was billed to (only its hash is stored)
 * @param {string} u.cwd
 * @param {object} [u.options]   sdk mode: { model, effort, permissionMode }
 * @param {string[]} [u.args]    cli mode: the claude args, without -p and output flags
 * @param {object} [u.usage]     the turn's usage, for the context size
 * @param {number} [u.at]        when the turn ended (default now)
 */
export function noteUse(u) {
  if (!u.sessionId || !u.key || !readSettings().on) return false;
  const x = u.usage || {};
  writeJson(useFile(u.sessionId), {
    sessionId: u.sessionId,
    mode: u.mode,
    cwd: u.cwd,
    options: u.options || null,
    args: u.args || null,
    keyFp: keyFingerprint(u.key),
    contextTokens: (x.cache_read_input_tokens || 0) + (x.cache_creation_input_tokens || 0) + (x.input_tokens || 0),
    lastUseAt: u.at || Date.now(),
  });
  ensureKeeper();
  return true;
}

/** Records a SessionRunner's last turn (called from runner.finishTurn). */
export function noteRunnerUse(runner, result) {
  return noteUse({
    sessionId: runner.sessionId,
    mode: 'sdk',
    key: runner.env?.ANTHROPIC_API_KEY,
    cwd: runner.cwd,
    options: { model: runner.model || null, effort: runner.effort || null, permissionMode: runner.permissionMode || null },
    usage: result?.usage,
    at: runner.lastTurnAt,
  });
}

/** Starts the keeper unless one is running. */
export function ensureKeeper() {
  if (process.env.LATCH_WARM_NO_KEEPER === '1') return null; // tests drive keeperPass() themselves
  const k = readJson(path.join(DIR(), 'keeper.json'), {});
  if (k.pid && pidAlive(k.pid)) return k.pid;
  const script = fileURLToPath(new URL('../bin/latch.js', import.meta.url));
  const child = spawn(process.execPath, [script, 'warm', 'run'], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, PROMPT_RELAY_CHILD: '1' },
  });
  child.unref();
  return child.pid;
}

/* ---------- pinging ---------- */

/** Runs one ping for a recorded use. Resolves { ok, read, write, cost, error }. */
export async function ping(use, key) {
  const file = findSessionFiles(use.sessionId)[0];
  if (!file) return { ok: false, error: 'transcript not found' };
  const before = lastCostTotal(readTail(file));
  const sizeBefore = fs.statSync(file).size;
  const out = use.mode === 'cli' ? await pingCli(use, key) : await pingSdk(use, key);
  if (out.ok && typeof out.total === 'number') out.cost = out.total >= before ? out.total - before : out.total;
  // A ping must never add to the conversation; say so loudly if it did.
  const grew = fs.statSync(file).size - sizeBefore;
  if (grew > 0) out.note = `transcript grew by ${grew} bytes during the ping (another writer, or persistence was not disabled)`;
  return out;
}

function usageOf(m) {
  const x = m?.usage || {};
  return { read: x.cache_read_input_tokens || 0, write: (x.cache_creation_input_tokens || 0) + (x.input_tokens || 0) };
}

async function pingSdk(use, key) {
  const o = use.options || {};
  // Same options as SessionRunner.start(), so the request matches the cached one.
  const options = {
    cwd: use.cwd,
    env: childEnv(key),
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    allowDangerouslySkipPermissions: true,
    enableFileCheckpointing: true,
    resume: use.sessionId,
    persistSession: false,
    maxTurns: 1,
    abortController: new AbortController(),
    stderr: () => {},
  };
  if (o.model) options.model = o.model;
  if (o.effort) options.effort = o.effort;
  if (o.permissionMode) options.permissionMode = o.permissionMode;
  const timer = setTimeout(() => options.abortController.abort(), PING_TIMEOUT_MS);
  async function* one() {
    yield { type: 'user', message: { role: 'user', content: PING_PROMPT }, parent_tool_use_id: null, session_id: use.sessionId };
  }
  try {
    let result = null;
    for await (const m of query({ prompt: one(), options })) if (m.type === 'result') result = m;
    if (!result) return { ok: false, error: 'no result' };
    return { ok: !result.is_error, ...usageOf(result), total: result.total_cost_usd, error: result.is_error ? String(result.result || result.subtype) : null };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function pingCli(use, key) {
  return new Promise((resolve) => {
    const bin = claudeBinary();
    if (!bin) { resolve({ ok: false, error: 'claude.exe not found' }); return; }
    const args = ['-p', '--output-format', 'json', ...(use.args || []), '--no-session-persistence'];
    const child = spawn(bin, args, { cwd: use.cwd, env: childEnv(key), windowsHide: true });
    let out = '';
    const timer = setTimeout(() => child.kill(), PING_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
      let r = null;
      try { r = line ? JSON.parse(line) : null; } catch { /* handled below */ }
      if (!r) { resolve({ ok: false, error: 'no result' }); return; }
      resolve({ ok: !r.is_error, ...usageOf(r), total: r.total_cost_usd, error: r.is_error ? String(r.result || r.subtype) : null });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(PING_PROMPT);
  });
}

/* ---------- the keeper ---------- */

function uses() {
  const dir = path.join(DIR(), 'use');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { /* none yet */ }
  return names.map((n) => readJson(path.join(dir, n))).filter(Boolean);
}

/**
 * What the keeper should do for one session now: 'ping', or a reason to wait
 * or stop. Pure, so it can be tested.
 */
export function decide({ use, state = {}, settings, now, spent, transcriptMtime = 0 }) {
  if (now - use.lastUseAt > settings.hours * 60 * MIN) return 'expired';
  if (state.missAt && state.missAt > use.lastUseAt) return 'missed';
  const lastWarm = Math.max(use.lastUseAt, state.lastHitAt || 0);
  const age = now - lastWarm;
  if (age >= COLD_AFTER_MS) return 'cold';
  if (age < PING_AFTER_MS) return 'warm';
  if (spent >= settings.dailyCapUsd) return 'capped';
  // Something is writing to the session right now; a real turn refreshes the
  // cache by itself, so wait unless that would run out the clock.
  if (now - transcriptMtime < 2 * MIN && age < COLD_AFTER_MS - 4 * MIN) return 'busy';
  return 'ping';
}

/** One pass over all recorded sessions. Returns how many are still being kept warm. */
export async function keeperPass(now = Date.now()) {
  const settings = readSettings();
  let active = 0;
  for (const use of uses()) {
    const sf = stateFile(use.sessionId);
    const state = readJson(sf, {});
    const file = findSessionFiles(use.sessionId)[0];
    const mtime = file ? fs.statSync(file).mtimeMs : 0;
    const verdict = decide({ use, state, settings, now, spent: spentToday(), transcriptMtime: mtime });
    if (verdict !== 'expired' && verdict !== 'cold' && verdict !== 'missed') active++;
    if (verdict !== 'ping') {
      if (state.status !== verdict) {
        writeJson(sf, { ...state, status: verdict, statusAt: now });
        if (verdict !== 'warm') log({ sessionId: use.sessionId, status: verdict });
      }
      continue;
    }
    const key = keyForFingerprint(use.keyFp);
    if (!key) {
      writeJson(sf, { ...state, status: 'no-key', statusAt: now });
      log({ sessionId: use.sessionId, status: 'no-key' });
      continue;
    }
    const r = await ping(use, key);
    const total = r.read + r.write;
    const hit = r.ok && total > 0 && r.read / total >= HIT_SHARE;
    if (r.ok) addSpend(r.cost || 0);
    const next = {
      ...state,
      lastPingAt: now,
      pings: (state.pings || 0) + 1,
      spent: (state.spent || 0) + (r.cost || 0),
      last: { ok: r.ok, read: r.read || 0, write: r.write || 0, cost: r.cost ?? null, error: r.error || null },
      status: !r.ok ? 'error' : hit ? 'warm' : 'missed',
      statusAt: now,
    };
    if (hit) next.lastHitAt = next.lastPingAt;
    if (r.ok && !hit) next.missAt = next.lastPingAt;
    writeJson(sf, next);
    log({ sessionId: use.sessionId, status: next.status, read: r.read, write: r.write, cost: r.cost, error: r.error, note: r.note });
  }
  return active;
}

/** The keeper loop: runs until keep-warm is turned off or nothing is left to keep warm. */
export async function runKeeper() {
  const kf = path.join(DIR(), 'keeper.json');
  const other = readJson(kf, {});
  if (other.pid && other.pid !== process.pid && pidAlive(other.pid)) return;
  writeJson(kf, { pid: process.pid, startedAt: new Date().toISOString() });
  log({ status: 'keeper-start', pid: process.pid });
  try {
    for (;;) {
      if (!readSettings().on) { log({ status: 'keeper-stop', why: 'turned off' }); return; }
      if (cacheTtl() !== '1h') { log({ status: 'keeper-stop', why: `promptCacheTtl is ${cacheTtl()}, needs 1h` }); return; }
      const active = await keeperPass();
      if (active === 0) { log({ status: 'keeper-stop', why: 'nothing left to keep warm' }); return; }
      await new Promise((r) => setTimeout(r, LOOP_MS));
    }
  } finally {
    const k = readJson(kf, {});
    if (k.pid === process.pid) { try { fs.unlinkSync(kf); } catch { /* gone */ } }
  }
}

/* ---------- projections ---------- */

// Cache write (1 h) to cache read price, per model. Opus 5.5: $8 vs $0.20 per
// million tokens (Anthropic's price list, and $8.03 measured here on
// 2026-10-09). Other current models: 2x vs 0.1x the input price.
const WRITE_TO_READ = { 'claude-opus-5-5': 40 };

function modelOf(use) {
  if (use.options?.model) return use.options.model;
  const i = (use.args || []).indexOf('--model');
  return i >= 0 ? use.args[i + 1] : null;
}

/**
 * What keeping one session warm costs and saves, from its last ping:
 * perPing, pingsLeft (to the cutoff, if idle all along), leftUsd, and
 * coldUsd (about what reopening it would cost if the cache expired).
 */
export function projection(use, state, settings, now = Date.now()) {
  const last = state.last;
  if (!last?.ok || !last.read) return null;
  const perPing = last.cost || 0;
  const lastWarm = Math.max(use.lastUseAt, state.lastHitAt || 0);
  const cutoff = use.lastUseAt + settings.hours * 60 * MIN;
  const pingsLeft = Math.max(0, Math.floor((cutoff - lastWarm) / PING_AFTER_MS));
  const readPrice = perPing / last.read; // per token; includes the ping's small extras
  const ratio = WRITE_TO_READ[modelOf(use)] || 20;
  return { perPing, pingsLeft, leftUsd: perPing * pingsLeft, coldUsd: readPrice * ratio * (use.contextTokens || last.read) };
}

/* ---------- status and control ---------- */

const STATUS_TEXT = {
  warm: 'warm', ping: 'pinging', busy: 'in use', cold: 'cache expired, waits for your next message',
  expired: 'past the keep window', missed: 'last ping missed the cache, stopped until your next message',
  capped: 'daily cap reached', 'no-key': 'its key is no longer available', error: 'last ping failed',
};

/** Lines describing keep-warm, for /warm and `latch warm status`. */
export async function statusText() {
  const s = readSettings();
  const k = readJson(path.join(DIR(), 'keeper.json'), {});
  const lines = [
    `Keep cache warm: ${s.on ? 'ON' : 'OFF'} · up to ${s.hours} h after a session's last message · cap ${s.dailyCapUsd.toFixed(2)}/day · spent today ${spentToday().toFixed(3)}`,
  ];
  const v = readJson(path.join(DIR(), 'verify.json'));
  if (v) lines.push(`  Refresh check (${v.model}, ${v.startedAt?.slice(0, 16).replace('T', ' ')}Z): ${v.verdict || `running, done about ${v.doneBy?.slice(11, 16)}Z`}`);
  if (cacheTtl() !== '1h') lines.push(`  Needs "promptCacheTtl": "1h" in ~/.claude/settings.json (now ${cacheTtl()}).`);
  lines.push(`  Keeper: ${k.pid && pidAlive(k.pid) ? `running (pid ${k.pid})` : 'not running'}`);
  const now = Date.now();
  const list = uses().sort((a, b) => b.lastUseAt - a.lastUseAt);
  if (!list.length) lines.push(s.on ? '  No sessions yet: each session used on an API key is added after its next message.' : '  Turn on with: latch warm on (or /warm on).');
  for (const use of list) {
    const st = readJson(stateFile(use.sessionId), {});
    const verdict = decide({ use, state: st, settings: s, now, spent: spentToday() });
    const info = await getSessionInfo(use.sessionId).catch(() => null);
    const title = (info?.customTitle || info?.summary || use.sessionId).replace(/\s+/g, ' ').slice(0, 48);
    const lastWarm = Math.max(use.lastUseAt, st.lastHitAt || 0);
    const nextIn = verdict === 'warm' ? ` · next ping in ${Math.max(1, Math.round((lastWarm + PING_AFTER_MS - now) / MIN))} min` : '';
    const last = st.last ? ` · last ping ${st.last.ok ? `${Math.round((100 * st.last.read) / Math.max(1, st.last.read + st.last.write))}% cached, $${(st.last.cost || 0).toFixed(3)}` : `failed: ${st.last.error}`}` : '';
    lines.push(`  ${use.sessionId.slice(0, 8)}  ${title}`);
    lines.push(`            ${STATUS_TEXT[verdict] || verdict} · ${Math.round(use.contextTokens / 1000)}k tokens · used ${ago(now - use.lastUseAt)}${nextIn}${last} · ${st.pings || 0} pings, ${(st.spent || 0).toFixed(3)}`);
    const pr = projection(use, st, s, now);
    if (pr) lines.push(`            per ping ${pr.perPing.toFixed(3)} · up to ${pr.leftUsd.toFixed(2)} more if idle until the ${s.hours} h cutoff · reopening it cold would cost about ${pr.coldUsd.toFixed(2)}`);
  }
  return lines.join('\n');
}

/**
 * The sessions keep-warm is looking after right now (on, and each one's
 * cache still warm, being pinged or in use), for Apaki's animated border.
 */
export function warmSessions(now = Date.now()) {
  const s = readSettings();
  if (!s.on) return [];
  const spent = spentToday();
  return uses()
    .filter((use) => ['warm', 'ping', 'busy'].includes(decide({ use, state: readJson(stateFile(use.sessionId), {}), settings: s, now, spent })))
    .map((use) => use.sessionId);
}

/** Keep-warm in a few fields, for Apaki's Settings sheet. */
export function summary() {
  const s = readSettings();
  const k = readJson(path.join(DIR(), 'keeper.json'), {});
  const v = readJson(path.join(DIR(), 'verify.json'));
  return {
    on: Boolean(s.on), hours: s.hours, dailyCapUsd: s.dailyCapUsd, spentToday: spentToday(), ttl: cacheTtl(),
    keeper: Boolean(k.pid && pidAlive(k.pid)), sessions: uses().length, verdict: v?.verdict || null,
  };
}

/** Turns keep-warm on or off for every session. */
export function setOn(on, { hours, cap } = {}) {
  const patch = { on };
  if (hours !== undefined) patch.hours = Number(hours);
  if (cap !== undefined) patch.dailyCapUsd = Number(cap);
  const s = writeSettings(patch);
  if (on && uses().length) ensureKeeper();
  return s;
}

/** Stops keeping one session warm (until its next message on a key). */
export function forget(prefix) {
  const hit = uses().filter((u) => u.sessionId.startsWith(prefix));
  for (const u of hit) {
    for (const f of [useFile(u.sessionId), stateFile(u.sessionId)]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
  }
  return hit.map((u) => u.sessionId);
}

/** `latch warm ...` */
export async function warmCli(argv) {
  const [verb = 'status', ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const out = (s) => process.stdout.write(`${s}\n`);
  switch (verb) {
    case 'run': await runKeeper(); return;
    case 'verify': {
      // The check takes about 70 minutes, so it runs on its own.
      const script = fileURLToPath(new URL('../bin/latch.js', import.meta.url));
      const child = spawn(process.execPath, [script, 'warm', 'verify-run', ...rest], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, PROMPT_RELAY_CHILD: '1' } });
      child.unref();
      out(`Started the refresh check (pid ${child.pid}): two scratch conversations on ${opt('model') || 'claude-opus-5-5'}, a ping at 52 min, the proof at 68 min. About $1.50. See the result with: latch warm status`);
      return;
    }
    case 'verify-run': {
      const { runVerify } = await import('./warmverify.js');
      await runVerify({ keyWords: opt('key') || 'myrlin.io', model: opt('model') || 'claude-opus-5-5', effort: opt('effort') || 'xhigh' });
      return;
    }
    case 'on': setOn(true, { hours: opt('hours'), cap: opt('cap') }); out(await statusText()); return;
    case 'off': {
      const id = rest.find((a) => !a.startsWith('--'));
      if (id) { const gone = forget(id); out(gone.length ? `Stopped keeping ${gone.map((g) => g.slice(0, 8)).join(', ')} warm (until its next message).` : `No warm session starts with ${id}.`); return; }
      setOn(false); out('Keep cache warm: OFF. The keeper stops within 30 seconds.'); return;
    }
    case 'ping': {
      const id = rest.find((a) => !a.startsWith('--'));
      const use = uses().find((u) => id && u.sessionId.startsWith(id));
      if (!use) { out(`No recorded session starts with ${id || '(none)'}.`); return; }
      const key = keyForFingerprint(use.keyFp);
      if (!key) { out('Its key is no longer available.'); return; }
      const r = await ping(use, key);
      if (r.ok) addSpend(r.cost || 0);
      log({ sessionId: use.sessionId, status: 'manual-ping', read: r.read, write: r.write, cost: r.cost, error: r.error, note: r.note });
      out(JSON.stringify(r));
      return;
    }
    default: out(await statusText());
  }
}
