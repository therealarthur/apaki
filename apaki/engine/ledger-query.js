/**
 * ledger-query.js: the questions the ledger tool server answers about a switched conversation (ledger-mcp-stdio.mjs).
 *
 * WHY (SWITCH.md, 2026-10-12: "Make 'everything' available, but don't stuff it into the prompt ... The full record
 * sits behind a small MCP server that both agents can query"): a handoff carries a summary and the recent turns; when
 * the agent needs more (an older turn, a tool's whole output, a word said weeks ago), it asks here. Read only: the
 * answers come from the two native files through the ledger readers (ledger.js) and from the link files switch.js
 * keeps, nothing is written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { claudeLineEvents, claudeTranscript, codexLineEvents, codexRollout, fileLines, lineAt, readEvents } from './ledger.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const oneLine = (s, n = 200) => { const t = str(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const SIDES = ['claude', 'codex'];

/** The links switch.js keeps, newest first. */
export function loadLinks(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^ln-[\w-]+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of names) { try { const l = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (l?.id) out.push(l); } catch { /* skipped */ } }
  return out.sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)));
}

/**
 * The link a call is about: the one asked for by id, the one this process was given (a Claude pane's), the one whose
 * Codex thread is making the call (Codex passes its thread id in the call's metadata), else the newest.
 */
export function pickLink(links, { asked = null, fixed = null, threadId = null } = {}) {
  const by = (id) => links.find((l) => l.id === id) || null;
  if (asked) return by(asked) || links.find((l) => l.claude?.sessionId === asked || l.codex?.threadId === String(asked).replace(/^codex:/, '')) || null;
  if (fixed) return by(fixed);
  if (threadId) { const hit = links.find((l) => l.codex?.threadId === threadId); if (hit) return hit; }
  return links[0] || null;
}

/** The thread id a Codex call carries in its metadata, if any. */
export function threadOfMeta(meta) {
  const m = meta || {};
  return str(m.threadId || m.thread_id || m['x-codex-turn-metadata']?.thread_id || m['x-codex-turn-metadata']?.session_id) || null;
}

/** Each side's file for a link: { claude, codex } (null where there is none yet). */
export function filesOf(link, { claudeDir, rolloutRoots = [] } = {}) {
  const claude = link?.claude?.sessionId ? claudeTranscript(link.claude.sessionId, { claudeDir }) : null;
  let codex = link?.codex?.file && fs.existsSync(link.codex.file) ? link.codex.file : null;
  if (!codex && link?.codex?.threadId) codex = codexRollout(link.codex.threadId, rolloutRoots);
  return { claude, codex };
}

/** One event as a line: its id, time, kind and the gist. */
export function eventLine(e) {
  const at = e.at ? `${String(e.at).slice(0, 16).replace('T', ' ')} ` : '';
  let gist = '';
  switch (e.kind) {
    case 'prompt': gist = `user: ${oneLine(e.text, 240)}${e.images ? ` [${e.images} image(s)]` : ''}`; break;
    case 'reply': gist = `${e.side}: ${oneLine(e.text, 240)}`; break;
    case 'reasoning': gist = `${e.side} thinking: ${oneLine(e.text, 160)}`; break;
    case 'tool_call': gist = `${e.side} called ${e.tool}: ${oneLine(typeof e.input === 'string' ? e.input : JSON.stringify(e.input), 160)} (call ${e.callId})`; break;
    case 'tool_result': gist = `result of ${e.callId}${e.isError ? ' (error)' : ''}: ${oneLine(e.output, 160)} [${str(e.output).length} chars]`; break;
    case 'command': gist = `${e.side} ran: ${oneLine(e.command, 200)} (exit ${e.exitCode ?? '?'}) [${str(e.output).length} chars of output]`; break;
    case 'file_change': gist = `${e.side} changed: ${(e.changes || []).map((c) => `${c.path} (${c.type})`).join(', ')}`; break;
    case 'compaction': gist = `${e.side} compacted its context${e.text ? `: ${oneLine(e.text, 160)}` : ''}`; break;
    case 'settings': gist = `${e.side} settings: ${[e.model, e.cwd, e.mode, e.sandbox].filter(Boolean).join(', ')}`; break;
    default: gist = e.kind;
  }
  return `[${e.id}] ${at}${gist}`;
}

/** The newest events of one side or both. */
export async function recent(files, { side = null, limit = 30, tailBytes = 8 * 1024 * 1024 } = {}) {
  const out = [];
  for (const s of SIDES) {
    if (side && side !== s) continue;
    const f = files[s];
    if (!f) continue;
    let size = 0;
    try { size = fs.statSync(f).size; } catch { continue; }
    const r = await readEvents(s, f, { from: Math.max(0, size - tailBytes), maxBytes: tailBytes });
    out.push(...r.events.filter((e) => e.kind !== 'settings'));
  }
  out.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return out.slice(-Math.max(1, Math.min(200, limit)));
}

/** Every event of either side whose words contain all the query's words (case does not matter), newest first. */
export async function search(files, query, { side = null, limit = 20 } = {}) {
  const words = str(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const s of SIDES) {
    if (side && side !== s) continue;
    const f = files[s];
    if (!f) continue;
    const parse = s === 'codex' ? codexLineEvents : claudeLineEvents;
    for await (const l of fileLines(f)) {
      // A quick look at the raw line first: most lines never need parsing.
      const low = l.text.toLowerCase();
      if (!words.every((w) => low.includes(w) || low.includes(JSON.stringify(w).slice(1, -1)))) continue;
      let j;
      try { j = JSON.parse(l.text); } catch { continue; }
      for (const e of parse(j, l.offset, null)) {
        const hay = [e.text, e.tool, e.command, e.output, typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? ''), ...(e.changes || []).map((c) => c.path)].map(str).join('\n').toLowerCase();
        if (words.every((w) => hay.includes(w))) hits.push(e);
      }
    }
  }
  hits.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return hits.slice(0, Math.max(1, Math.min(100, limit)));
}

/** An event id ('claude@123' or 'codex@456#2') as its side, offset and index within the line. */
export function parseId(id) {
  const m = /^(claude|codex)@(\d{1,15})(?:#(\d{1,4}))?$/.exec(str(id).trim());
  return m ? { side: m[1], offset: Number(m[2]), index: Number(m[3] || 0) } : null;
}

/** The event(s) on the line an id points to: [{ ...event }] (the asked one first), or []. */
export async function eventAt(files, id) {
  const p = parseId(id);
  if (!p || !files[p.side]) return [];
  const text = await lineAt(files[p.side], p.offset);
  if (text == null) return [];
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  const evs = (p.side === 'codex' ? codexLineEvents : claudeLineEvents)(j, p.offset, null);
  const asked = evs.find((e) => e.id === str(id).trim());
  return asked ? [asked, ...evs.filter((e) => e !== asked)] : evs;
}

/** One event in full, as text: every field, long text and output cut at `max` characters. */
export function eventText(e, max = 100000) {
  const lines = [eventLine(e)];
  const add = (label, v) => { if (v == null || v === '') return; const t = typeof v === 'string' ? v : JSON.stringify(v, null, 1); lines.push(`${label}:\n${t.length > max ? `${t.slice(0, max)}\n[... ${t.length - max} more characters; ledger_tool_output pages through outputs]` : t}`); };
  add('text', e.text);
  add('tool', e.tool);
  add('input', e.input);
  add('command', e.command);
  add('output', e.output);
  if (e.exitCode != null) lines.push(`exit code: ${e.exitCode}`);
  if (e.callId) lines.push(`call id: ${e.callId}`);
  return lines.join('\n\n');
}

/**
 * A tool's whole output, by its call id (or an event id of its call or result), paged by characters.
 * @returns {Promise<{ found: boolean, text: string, total: number, start: number, next: number|null }>}
 */
export async function toolOutput(files, { callId = null, id = null, start = 0, length = 50000 } = {}) {
  let want = str(callId);
  if (!want && id) { const evs = await eventAt(files, id); want = str(evs[0]?.callId); }
  if (!want) return { found: false, text: '', total: 0, start: 0, next: null };
  for (const s of SIDES) {
    const f = files[s];
    if (!f) continue;
    const parse = s === 'codex' ? codexLineEvents : claudeLineEvents;
    for await (const l of fileLines(f)) {
      if (!l.text.includes(want)) continue;
      let j;
      try { j = JSON.parse(l.text); } catch { continue; }
      const hit = parse(j, l.offset, null).find((e) => e.callId === want && (e.kind === 'tool_result' || e.kind === 'command'));
      if (!hit) continue;
      const all = str(hit.output);
      const from = Math.max(0, Math.floor(start) || 0);
      const len = Math.max(1000, Math.min(200000, Math.floor(length) || 50000));
      const end = Math.min(all.length, from + len);
      return { found: true, text: all.slice(from, end), total: all.length, start: from, next: end < all.length ? end : null };
    }
  }
  return { found: false, text: '', total: 0, start: 0, next: null };
}
