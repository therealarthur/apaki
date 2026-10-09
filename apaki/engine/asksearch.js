/**
 * asksearch.js: "Ask Claude" in Myrlin Apaki's session search, and the prompt
 * for "Dig deeper".
 *
 * WHY (Arthur, 2026-10-09): "an integrated advanced search that uses the
 * currently selected subscription or api credit to search for sessions that
 * match what you're looking for". The local search (words + meaning, see
 * index/src/semantic.rs) is free and instant but literal; Claude understands
 * "specifically the marketing and growth related sessions" and can reject
 * near misses. It runs in two short turns of ONE headless Claude Code
 * process, so it starts once:
 *   1. Claude turns the request into 3 to 6 searches plus a one-sentence
 *      description of a matching session.
 *   2. The local indexes run all of them; the best ~40 sessions are merged by
 *      reciprocal rank, each summarized (title, folders, first and latest
 *      prompts, matching excerpts), and Claude keeps the ones that fit, best
 *      first, with a one-line reason each.
 * Billed to the given credential (the focused pane's account), on Haiku by
 * default (APAKI_ASK_MODEL), no tools, no settings or CLAUDE.md loaded, and
 * persistSession: false, so it leaves no session behind. Typical cost is
 * about a cent; time is a few seconds.
 */

import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { childEnv } from '../../src/auth.js';
import { searchHybrid, indexBin } from '../../src/deepindex.js';
import { tailFacts } from '../../src/picker.js';

export const ASK_MODEL = process.env.APAKI_ASK_MODEL || 'claude-haiku-5-5';
const ASK_MODEL_NAME = { 'claude-haiku-5-5': 'Haiku 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5-5': 'Opus 5.5' };
const POOL = 40;
const RRF_K = 60;

const SYSTEM = 'You help a developer find their own past AI coding sessions (Claude Code and Codex) on their PC. Reply with one JSON object only: no prose, no code fences.';

/** Minimal async queue, the prompt stream of one Claude Code process. */
class Inbox {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(v) { const w = this.waiters.shift(); if (w) w({ value: v, done: false }); else this.items.push(v); }
  close() { this.closed = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return {
      next: () => (this.items.length ? Promise.resolve({ value: this.items.shift(), done: false })
        : this.closed ? Promise.resolve({ value: undefined, done: true })
          : new Promise((r) => this.waiters.push(r))),
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

/** The first JSON object in a reply (tolerates stray prose or fences). */
export function parseJsonReply(text) {
  const t = String(text || '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const short = (p) => String(p || '').replace(/^C:\\Users\\[^\\]+/i, '~');
const ago = (ms) => {
  if (!ms) return '';
  const d = (Date.now() - ms) / 86400000;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.round(d)} days ago`;
};
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Merges several rankings (lists of session ids, best first) by reciprocal rank. */
export function fuseRankings(lists) {
  const score = new Map();
  for (const list of lists) list.forEach((id, r) => score.set(id, (score.get(id) || 0) + 1 / (RRF_K + r)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** One candidate as Claude reads it. */
export function digest(key, item, hits) {
  const facts = item.file && !item.codex ? (() => { try { return tailFacts(item.file); } catch { return null; } })() : null;
  const lines = [`[${key}] ${clip(item.title || '(untitled)', 120)} · ${short(item.cwd) || 'unknown folder'} · last active ${ago(item.lastModified) || 'unknown'}${item.codex ? ' · Codex' : ''}`];
  if (facts?.folders?.length > 1) lines.push(`  also ran in: ${facts.folders.slice(0, 4).map(short).join(', ')}`);
  if (item.firstPrompt) lines.push(`  first prompt: ${clip(item.firstPrompt, 260)}`);
  const recent = (facts?.prompts || []).filter((p) => p !== item.firstPrompt).slice(0, 2);
  for (const p of recent) lines.push(`  later prompt: ${clip(p, 200)}`);
  for (const h of hits.slice(0, 2)) if (h.snippet) lines.push(`  matched (${h.kind || 'text'}${h.sources ? `, by ${h.sources.join(' and ')}` : ''}): ${clip(h.snippet, 220)}`);
  return lines.join('\n');
}

/**
 * Runs Ask Claude. `items` maps session id -> list item (title, cwd, file...).
 * `progress(text)` reports each stage. Resolves with
 * { results: [{ id, why }], terms, considered, model, cost, ms, note } or { error }.
 */
export async function askSearch({ query: question, credential, items, progress = () => {}, makeItem }) {
  const t0 = Date.now();
  const inbox = new Inbox();
  const q = query({
    prompt: inbox,
    options: {
      model: ASK_MODEL,
      cwd: os.homedir(),
      env: childEnv(credential.key),
      tools: [],
      settingSources: [],
      persistSession: false,
      systemPrompt: SYSTEM,
    },
  });
  const it = q[Symbol.asyncIterator]();
  const turn = async (text) => {
    inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
    for (;;) {
      const { value: m, done } = await it.next();
      if (done) throw new Error('Claude stopped before answering');
      if (m.type === 'result') {
        if (m.is_error) throw new Error(m.result || (m.errors || []).join('; ') || m.subtype);
        return m;
      }
    }
  };
  try {
    progress('Claude is turning your question into searches…');
    const r1 = await turn(`The user is looking for past sessions with this request:\n"${question}"\n\nWrite the searches to run against an index of every session's prompts and replies (a keyword index and a semantic index).\nReturn JSON: {"searches": [3 to 6 short queries of 1 to 4 words: the key names, domains, products and repos involved, and the words such sessions would use, including likely synonyms], "meaning": "one sentence describing what a matching session is about, phrased like a summary of one"}`);
    const plan = parseJsonReply(r1.result) || {};
    const searches = (Array.isArray(plan.searches) ? plan.searches : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
    const meaning = typeof plan.meaning === 'string' ? plan.meaning.trim() : '';

    progress(`Searching for ${[...searches].slice(0, 4).join(' · ') || question}…`);
    const queries = [question, ...searches, ...(meaning ? [meaning] : [])];
    const runs = await Promise.all(queries.map((s) => searchHybrid(s, { limit: 60 })));
    const hitsBy = new Map();
    const lists = runs.filter(Boolean).map((r) => r.sessions.map((h) => {
      if (!hitsBy.has(h.session)) hitsBy.set(h.session, []);
      hitsBy.get(h.session).push(h);
      return h.session;
    }));
    const pool = fuseRankings(lists).slice(0, POOL);
    if (!pool.length) return { results: [], terms: searches, considered: 0, model: ASK_MODEL_NAME[ASK_MODEL] || ASK_MODEL, ms: Date.now() - t0, cost: null, note: 'Nothing in the index matched any of those searches.' };

    const keyed = pool.map((id, i) => ({ key: `c${i + 1}`, id, item: items.get(id) || makeItem(id, hitsBy.get(id)?.[0]) }));
    progress(`Claude is reading ${keyed.length} candidates…`);
    const digests = keyed.map(({ key, item, id }) => digest(key, item, hitsBy.get(id) || [])).join('\n');
    const r2 = await turn(`Candidates (key, title, folder, when, excerpts):\n${digests}\n\nPick the sessions that genuinely fit the request "${question}", best first. Leave out ones that are only loosely related. For each pick, one plain sentence of at most 18 words saying what in that session fits.\nReturn JSON: {"picks": [{"id": "c3", "why": "..."}], "note": "only if nothing fits well or the request is ambiguous: one short sentence that names sessions by title, never by key"}`);
    const verdict = parseJsonReply(r2.result) || {};
    const byKey = new Map(keyed.map((k) => [k.key, k]));
    const results = [];
    for (const p of Array.isArray(verdict.picks) ? verdict.picks : []) {
      const k = byKey.get(String(p.id || '').trim());
      if (!k || results.some((r) => r.id === k.id)) continue;
      results.push({ id: k.id, why: clip(p.why, 160), hit: hitsBy.get(k.id)?.[0] || null });
    }
    return {
      results,
      terms: searches,
      considered: keyed.length,
      model: ASK_MODEL_NAME[ASK_MODEL] || ASK_MODEL,
      cost: typeof r2.total_cost_usd === 'number' ? r2.total_cost_usd : null,
      ms: Date.now() - t0,
      // Keys like c12 mean nothing to the reader: drop any the note still cites.
      note: typeof verdict.note === 'string' ? clip(verdict.note.replace(/\s*\((?:c\d+(?:,\s*)?)+\)/g, '').replace(/\bc\d+\b,?\s*/g, ''), 200) : '',
    };
  } catch (e) {
    return { error: e.message || String(e) };
  } finally {
    inbox.close();
    try { await q.return?.(); } catch { /* already finished */ }
  }
}

/** The first message of a "Dig deeper" session: what to find, how, and where. */
export function digPrompt(question, candidates = []) {
  const bin = indexBin();
  const projects = `${os.homedir()}\\.claude\\projects`;
  const cands = candidates.length
    ? `\nThe quick search already ranked these (title · folder · id); start from them but do not trust them blindly:\n${candidates.map((c) => `- ${c.title} · ${short(c.cwd)} · ${c.id}`).join('\n')}\n`
    : '';
  return [
    `Find the sessions on this PC that match this request: "${question}"`,
    '',
    'This is a search task. Do not change any files.',
    '',
    'Where the sessions are:',
    `- Claude Code: ${projects}\\<project>\\<session-id>.jsonl (one JSON entry per line; "type":"user" and "type":"assistant" entries hold the conversation; subagent runs live under <project>\\<session-id>\\).`,
    `- Codex: ${os.homedir()}\\.codex\\sessions\\YYYY\\MM\\DD\\rollout-*.jsonl.`,
    bin ? `- A full-text index over all of them: \`"${bin}" search <words> --limit 40\` prints JSON (session, hits, snippet), and \`"${bin}" hybrid <words>\` searches by words and meaning.` : '',
    cands,
    'How: try several searches with different words, names and synonyms; open the promising transcripts and read enough of the conversation to judge (look at the user prompts first); follow leads such as repo names, domains and dates.',
    '',
    'Answer with a ranked list, best first. For each session: its full session id (plain UUID, so it can be clicked open), its title or a short description, the folder it ran in, roughly when, one line on why it matches, and how sure you are. End with anything close that you ruled out and why.',
  ].filter((l) => l !== '').join('\n');
}
