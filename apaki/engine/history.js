/**
 * history.js: the whole conversation of a session, read from its transcript,
 * for a pane to show (Arthur, 2026-10-10: "im not entirely sure if we're
 * really pulling the FULL transcript of sessions").
 *
 * Why not the Agent SDK's getSessionMessages: it returns only the chain after
 * the last compaction, so a long session showed a few hundred of its
 * thousands of messages (measured 2026-10-10: 1128 of 6831 on a 76 MB
 * transcript, and the pane kept the last 400 of those). This module reads the
 * .jsonl itself and follows the SDK's own rules, across compactions:
 *   - the conversation is the chain from the current leaf back by parentUuid,
 *     so rewound or abandoned branches stay out (the leaf is picked the way
 *     the SDK picks it);
 *   - a compact_boundary has no parent: the chain continues at its
 *     logicalParentUuid, and the boundary becomes a marker that carries the
 *     summary Claude Code wrote (the isCompactSummary message after it). The
 *     messages a compaction kept stay where they were written, so nothing
 *     shows twice;
 *   - sidechains (subagents, shown in their own viewer), team entries and
 *     meta messages stay out;
 *   - parts of one assistant message (Claude Code writes one line per content
 *     block, all with the same message.id) that hang off the chain, such as
 *     parallel tool calls and their results, are put back where the SDK's
 *     sibling pass puts them, then consecutive parts are joined into one
 *     message;
 *   - queued commands delivered into a running turn become user messages, as
 *     in the SDK (queued: true).
 *
 * Fast on big files: the file is read once, in chunks, each line kept slim
 * (tool output cut to RESULT_CHARS, images, signatures and the duplicate
 * toolUseResult dropped, the line's byte range kept), and later reads parse
 * only what was appended (the cache is keyed by file, checked by size and
 * mtime). Anything cut can be fetched in full from its own line (block()).
 *
 * Pages: firstPage() returns the newest PAGE items, pageBefore() the ones
 * before an item. A page never starts with tool results whose tool call sits
 * on the page before, so a tool block always gets its result.
 *
 * Items (what a pane renders; the same shape the engine sent before, plus
 * markers and flags):
 *   { type: 'user'|'assistant', uuid, at, parent_tool_use_id: null, message: { role, content, model }, queued? }
 *   { type: 'compact', uuid, at, trigger, preTokens, postTokens, summary: { text, truncated?, length?, ref? } | null }
 * Content blocks that were cut carry truncated: true, length (the full
 * length) and ref (for block()); images are { type: 'image_marker', ref,
 * media_type, bytes } and images inside a tool result are listed in its
 * images: [{ ref, media_type, bytes }]. Thinking keeps its text.
 *
 * Read only: this never writes anything under ~/.claude.
 */

import fs from 'node:fs';

/** Items in the first page and in each earlier page. */
export const PAGE = 300;
/** Tool output kept per result in a page (the rest comes with block()). */
export const RESULT_CHARS = 4000;
/** Thinking text and a compaction summary kept in a page. */
export const THINK_CHARS = 4000;
export const SUMMARY_CHARS = 4000;
/** Message text kept in a page (far above any typed message; a pasted log can pass it). */
export const TEXT_CHARS = 200_000;
/** Most characters one "Show all" returns, and most base64 one image does. */
export const FULL_CHARS = 2_000_000;
export const IMAGE_B64_MAX = 16 * 1024 * 1024;

const CHUNK = 8 * 1024 * 1024;
const MAX_CACHED = 6;
/** Small blocks of other kinds (documents, search results) are kept as they are up to this size. */
const OTHER_BLOCK_CHARS = 4000;
const NEEDED_TYPES = new Set(['user', 'assistant', 'system', 'attachment', 'progress', 'queue-operation']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** A block reference: <uuid of the line>:<block index>[:<index inside a tool result>], or <uuid>:s for a summary. */
export const REF_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,5}|s)(?::(\d{1,5}))?$/i;
// Origins whose meta messages the SDK still shows (its jC: channel and peer messages, observers, Slack pings).
const SHOWN_META_ORIGINS = new Set(['channel', 'observer', 'observer-activity', 'slack-ping', 'peer']);
// User lines that end a turn early count as a reply to what came before them (the SDK's FI markers).
const INTERRUPTION_PREFIXES = [
  '[Request interrupted by user', '[Tool call did not complete', '[Tool call interrupted', '[Tool call result not in this copy',
  '[Tool call skipped', "The user doesn't want to take this action right now",
];

/* ---------- slim lines ---------- */

const str = (v) => (typeof v === 'string' && v ? v : null);
const num = (v) => (Number.isFinite(v) ? v : null);

/** Text cut to n characters, with the same "more characters" tail the engine always used. */
function cutText(s, n) {
  const t = String(s ?? '');
  if (t.length <= n) return { text: t };
  return { text: `${t.slice(0, n)}\n… (${(t.length - n).toLocaleString('en-US')} more characters)`, truncated: true, length: t.length };
}

/*
 * System lines from the transcript (2026-10-11, Arthur: "make sure that apaki shows ALL output that would
 * normally be seen by claude code users (including the yellow text that happens when a prompt gets
 * caught/etc)"). What Claude Code wrote down as its own words, not Claude's: a prompt a hook blocked (the
 * prompt relay's replies arrive this way), hook errors and cancels, model refusals, recaps, a command typed.
 * Each becomes { text, tone, label, mono } for the pane's system line (apaki/ui/notices.js draws live ones).
 */
const NOTE_CHARS = 8000;
const HOOK_LINE = /\b(PreToolUse|PostToolUse|PostToolUseFailure|UserPromptSubmit|Stop|SubagentStop|SessionStart|SessionEnd|Notification|PreCompact|PermissionRequest)\b.*\bhook\b/i;
const noteText = (s) => cutText(String(s ?? '').replace(/\r\n/g, '\n').trim(), NOTE_CHARS).text;

/** A system line of the transcript as a note, or null. */
export function systemNote(j) {
  const content = typeof j.content === 'string' ? j.content.trim() : '';
  switch (j.subtype) {
    case 'informational':
      return content ? { text: noteText(content), tone: j.level === 'warning' ? 'warn' : j.level === 'info' ? 'dim' : 'info', label: HOOK_LINE.test(content.split('\n')[0]) ? 'Hook' : '' } : null;
    case 'model_refusal_fallback':
    case 'model_refusal_no_fallback': {
      const text = content || str(j.apiRefusalExplanation) || (j.fallbackModel ? `Switched from ${j.originalModel} to ${j.fallbackModel}.` : `${j.originalModel || 'The model'} declined this request.`);
      return { text: noteText(text), tone: 'warn', label: 'Model' };
    }
    case 'away_summary':
      return content ? { text: noteText(content), tone: 'dim', label: 'Recap' } : null;
    case 'stop_hook_summary': {
      const errs = (Array.isArray(j.hookErrors) ? j.hookErrors : []).map((x) => (typeof x === 'string' ? x : x?.error || x?.message || '')).filter(Boolean);
      if (errs.length) return { text: noteText(`Stop hook error: ${errs.join('; ')}`), tone: 'error', label: 'Hook' };
      if (j.preventedContinuation && str(j.stopReason)) return { text: noteText(j.stopReason), tone: 'warn', label: 'Hook' };
      return null;
    }
    case 'api_error': {
      const err = content || str(j.error?.message) || str(j.error?.error?.message) || str(typeof j.error === 'string' ? j.error : null);
      return err ? { text: noteText(err), tone: 'warn', label: 'API' } : null;
    }
    case 'local_command':
      return content ? { text: noteText(`> ${content}`), tone: 'dim', label: '', mono: true } : null;
    default:
      return null;
  }
}

/** A hook attachment of the transcript as a note, or null (a quiet success stays out, as in Claude Code). */
export function hookNote(a) {
  const name = str(a.hookName) || str(a.hookEvent) || 'Hook';
  const out = String(a.stderr || a.stdout || '').trim();
  switch (a.type) {
    case 'hook_non_blocking_error':
      return { text: noteText(`${name} hook error${a.exitCode ? ` (exit ${a.exitCode})` : ''}${out ? `: ${out}` : ''}`), tone: 'error', label: 'Hook' };
    case 'hook_blocking_error': {
      const why = String(a.blockingError?.blockingError || (typeof a.blockingError === 'string' ? a.blockingError : '') || out || '').trim();
      return { text: noteText(`${name} hook blocked this${why ? `: ${why}` : ''}`), tone: 'warn', label: 'Hook' };
    }
    case 'hook_cancelled':
      return { text: `${name} hook was cancelled${a.timedOut ? ' (it timed out)' : ''}`, tone: 'dim', label: 'Hook' };
    case 'hook_system_message':
      return str(a.content) ? { text: noteText(a.content), tone: 'warn', label: 'Hook' } : null;
    case 'hook_error_during_execution':
      return { text: noteText(`${name} hook error${str(a.content) ? `: ${a.content}` : ''}`), tone: 'error', label: 'Hook' };
    case 'hook_stopped_continuation':
      return { text: noteText(str(a.message) || `${name} hook stopped Claude`), tone: 'warn', label: 'Hook' };
    default:
      return null;
  }
}

/** A small FNV-1a hash, to tell copies of one queued command apart without keeping their text. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${(h >>> 0).toString(36)}.${s.length}`;
}

const mediaOf = (b) => {
  const t = String(b?.source?.media_type || b?.mimeType || b?.media_type || '').toLowerCase();
  return IMAGE_TYPES.has(t) ? t : 'image/png';
};
const b64Of = (b) => (typeof b?.source?.data === 'string' ? b.source.data : typeof b?.data === 'string' ? b.data : '');
const bytesOf = (b) => Math.floor((b64Of(b).length * 3) / 4);

/** An origin, as much of it as the rules need. */
function originOf(o) {
  if (!o || typeof o !== 'object' || typeof o.kind !== 'string') return null;
  return o.senderTaskId !== undefined ? { kind: o.kind, senderTaskId: true } : { kind: o.kind };
}

/** One content block as a page carries it. ref is null where a block cannot be fetched again (queued prompts). */
export function slimBlock(b, ref) {
  if (!b || typeof b !== 'object') return { type: 'unknown' };
  const withRef = (o) => (ref ? { ...o, ref } : o);
  switch (b.type) {
    case 'text': {
      const c = cutText(b.text, TEXT_CHARS);
      return c.truncated ? withRef({ type: 'text', text: c.text, truncated: true, length: c.length }) : { type: 'text', text: c.text };
    }
    case 'thinking': {
      const t = String(b.thinking || '');
      if (!t) return { type: 'thinking' };
      const c = cutText(t, THINK_CHARS);
      return c.truncated ? withRef({ type: 'thinking', thinking: c.text, truncated: true, length: c.length }) : { type: 'thinking', thinking: c.text };
    }
    case 'redacted_thinking':
      return { type: 'thinking', redacted: true };
    case 'tool_use':
    case 'server_tool_use':
      return { type: b.type, id: b.id, name: b.name, input: b.input };
    case 'tool_result': {
      const parts = Array.isArray(b.content) ? b.content : null;
      const text = parts ? parts.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : String(b.content ?? '');
      const c = cutText(text, RESULT_CHARS);
      const out = { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: Boolean(b.is_error), content: c.text };
      if (c.truncated) Object.assign(out, withRef({ truncated: true, length: c.length }));
      if (parts) {
        const images = [];
        parts.forEach((x, j) => { if (x?.type === 'image') images.push({ ...(ref ? { ref: `${ref}:${j}` } : {}), media_type: mediaOf(x), bytes: bytesOf(x) }); });
        if (images.length) out.images = images;
      }
      return out;
    }
    case 'image':
      return withRef({ type: 'image_marker', media_type: mediaOf(b), bytes: bytesOf(b) });
    default: {
      let n = Infinity;
      try { n = JSON.stringify(b).length; } catch { /* circular or odd: keep its type only */ }
      return n <= OTHER_BLOCK_CHARS ? b : { type: b.type };
    }
  }
}

function slimContent(content, uuid) {
  if (typeof content === 'string') return cutText(content, TEXT_CHARS).text;
  if (!Array.isArray(content)) return content == null ? '' : content;
  return content.map((b, i) => slimBlock(b, `${uuid}:${i}`));
}

/** The text of a message's content (a string, or its text blocks). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

/** True when a forwarded intent marks a queued command the SDK never shows (its NM). */
const isForwarded = (f) => Boolean(f && typeof f === 'object' && 'lineage' in f && 'source' in f);

/**
 * One parsed transcript line, kept slim: the fields the chain rules read and
 * what a page shows, plus where the line is in the file (off, len). Lines
 * that never matter (titles, modes, file snapshots) give null.
 */
export function slimEntry(j, off = 0, len = 0) {
  if (!j || typeof j !== 'object') return null;
  const type = j.type;
  if (type === 'queue-operation') {
    if (j.operation !== 'remove' || j.reason !== 'absorbed_mid_turn') return null;
    const deliveryId = str(j.deliveryId);
    const commandUuid = str(j.commandUuid);
    return deliveryId || commandUuid ? { type, deliveryId, commandUuid } : null;
  }
  if (!NEEDED_TYPES.has(type) || typeof j.uuid !== 'string') return null;
  const e = { type, uuid: j.uuid, parentUuid: str(j.parentUuid), off, len };
  if (j.isSidechain) e.side = true;
  if (j.teamName) e.team = true;
  if (j.agentId !== undefined) e.agentId = j.agentId;
  if (j.isMeta) e.meta = true;
  if (typeof j.timestamp === 'string') e.at = j.timestamp;
  if (type === 'progress') return e;
  if (type === 'system') {
    e.subtype = j.subtype || null;
    if (j.subtype === 'compact_boundary') {
      e.lp = str(j.logicalParentUuid);
      const m = j.compactMetadata || {};
      e.cm = { trigger: str(m.trigger), preTokens: num(m.preTokens), postTokens: num(m.postTokens) };
    }
    const note = systemNote(j);
    if (note) e.note = note;
    return e;
  }
  if (type === 'attachment') {
    const a = j.attachment && typeof j.attachment === 'object' ? j.attachment : {};
    if (a.type !== 'queued_command') {
      e.att = { type: a.type || null };
      const note = hookNote(a);
      if (note) e.att.note = note;
      return e;
    }
    let sig = '';
    try { sig = fnv(JSON.stringify(a)); } catch { sig = `odd.${Math.random()}`; }
    e.att = {
      type: a.type, source_uuid: str(a.source_uuid), delivery_id: str(a.delivery_id), isMeta: Boolean(a.isMeta),
      origin: originOf(a.origin), commandMode: str(a.commandMode), forwarded: isForwarded(a.forwardedIntent), sig,
      // A queued prompt is shown as it was typed; its images cannot be fetched again from here.
      prompt: typeof a.prompt === 'string' ? cutText(a.prompt, TEXT_CHARS).text : Array.isArray(a.prompt) ? a.prompt.map((b) => slimBlock(b, null)) : a.prompt,
    };
    return e;
  }
  // user and assistant
  if (j.origin) e.origin = originOf(j.origin);
  if (j.promptSource !== undefined) e.ps = true;
  if (typeof j.sourceToolAssistantUUID === 'string') e.stau = j.sourceToolAssistantUUID;
  const m = j.message && typeof j.message === 'object' ? j.message : {};
  if (typeof m.id === 'string') e.mid = m.id;
  e.role = m.role || type;
  if (m.model) e.model = m.model;
  if (j.isCompactSummary) {
    e.cs = true;
    const c = cutText(textOf(m.content), SUMMARY_CHARS);
    e.summary = c.truncated ? { text: c.text, truncated: true, length: c.length, ref: `${j.uuid}:s` } : { text: c.text };
    e.content = '';
    return e;
  }
  e.content = slimContent(m.content, j.uuid);
  return e;
}

/* ---------- the chain (the SDK's rules, across compactions) ---------- */

const isUA = (e) => e.type === 'user' || e.type === 'assistant';
const keepsMeta = (origin) => Boolean(origin && SHOWN_META_ORIGINS.has(origin.kind));
const pushTo = (map, key, v) => { const a = map.get(key); if (a) a.push(v); else map.set(key, [v]); };

/** The ids in a message's blocks of one type (tool_use ids, tool_result tool_use_ids). */
function idsIn(e, type, field) {
  if (!Array.isArray(e.content)) return [];
  const out = [];
  for (const b of e.content) if (b && b.type === type && typeof b[field] === 'string') out.push(b[field]);
  return out;
}

/** A user line that answers tool calls (the SDK's vN). */
const isResultMsg = (e) => e.type === 'user' && Boolean(e.parentUuid) && Array.isArray(e.content) && e.content.some((b) => b?.type === 'tool_result');

/** A user line that only says the turn was cut short (the SDK's FI). */
function isInterruption(e) {
  if (e.type !== 'user') return false;
  const starts = (t) => typeof t === 'string' && INTERRUPTION_PREFIXES.some((p) => t.startsWith(p));
  if (typeof e.content === 'string') return starts(e.content);
  if (!Array.isArray(e.content) || !e.content.length) return false;
  return e.content.every((b) => starts(b?.type === 'text' ? b.text : b?.type === 'tool_result' && b.is_error ? b.content : undefined));
}

/** What a local command's lines are (the SDK's HM): its record, its output, or the caveat before them. */
function localTag(e) {
  if (e.ps) return undefined;
  const c = e.content;
  const t = Array.isArray(c) ? [...c].reverse().find((b) => b?.type === 'text')?.text : typeof c === 'string' ? c : undefined;
  if (typeof t !== 'string') return undefined;
  if (t.startsWith('<command-name>')) return 'record';
  if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')) return 'output';
  if (t.startsWith('<local-command-caveat>')) return 'caveat';
  return undefined;
}

/**
 * The newest tip of the conversation, walked back to its last user or
 * assistant line (the SDK's leaf): the latest line nothing continues from,
 * ignoring sidechains, team entries and progress lines.
 */
function findLeaf(all, by, pos) {
  const counts = (e) => !e.side && !e.team && e.type !== 'progress' && !(e.type === 'attachment' && e.att?.type === 'fork_briefing');
  const parents = new Set();
  for (const e of all) if (e.parentUuid && counts(e)) parents.add(e.parentUuid);
  const tips = all.filter((e) => counts(e) && !parents.has(e.uuid)).sort((a, b) => pos.get(b.uuid) - pos.get(a.uuid));
  const passed = new Set();
  for (const t of tips) {
    const trail = [];
    const seen = new Set();
    for (let c = t; c && !passed.has(c.uuid) && !seen.has(c.uuid); c = c.parentUuid ? by.get(c.parentUuid) : undefined) {
      if (isUA(c)) return c;
      seen.add(c.uuid);
      trail.push(c.uuid);
    }
    for (const u of trail) passed.add(u);
  }
  // No tip reaches a message: the latest message there is, preferring real ones.
  const msgs = all.filter(isUA);
  if (!msgs.length) return null;
  const real = msgs.filter((e) => !e.side && !e.team && !e.meta);
  const pick = real.length ? real : msgs;
  return pick.reduce((a, b) => (pos.get(b.uuid) > pos.get(a.uuid) ? b : a));
}

/**
 * Parts of the chain's assistant messages that are not on the chain (other
 * blocks of the same message.id, results of parallel tool calls), put after
 * the last part that is (the SDK's kCe, same order: parts by time, then
 * results by time).
 */
function addSiblings(by, chain, on, pos) {
  const asst = chain.filter((e) => e.type === 'assistant');
  if (!asst.length) return chain;
  const lastOf = new Map();
  for (const e of asst) if (e.mid) lastOf.set(e.mid, e);
  const partsOf = new Map();
  const kids = new Map();
  const owner = new Map(); // tool_use id -> the assistant line with it (null when two messages claim it)
  const results = [];
  for (const e of by.values()) {
    const mid = e.type === 'assistant' ? e.mid : undefined;
    if (mid) {
      pushTo(partsOf, mid, e);
      for (const id of idsIn(e, 'tool_use', 'id')) {
        const was = owner.get(id);
        owner.set(id, was === undefined || (was !== null && was.mid === mid) ? e : null);
      }
    } else if (isResultMsg(e)) results.push(e);
  }
  const linked = new Set();
  const link = (parent, e) => { const k = `${parent}\n${e.uuid}`; if (linked.has(k)) return; linked.add(k); pushTo(kids, parent, e); };
  const same = (a, b) => Boolean(a.side) === Boolean(b.side) && a.agentId === b.agentId;
  for (const e of results) {
    link(e.parentUuid, e);
    const src = e.stau && e.stau !== e.parentUuid ? by.get(e.stau) : undefined;
    if (src && same(e, src)) link(src.uuid, e);
    for (const id of idsIn(e, 'tool_result', 'tool_use_id')) { const w = owner.get(id); if (w && same(e, w)) link(w.uuid, e); }
  }
  const answered = new Set();
  for (const e of chain) for (const id of idsIn(e, 'tool_result', 'tool_use_id')) answered.add(id);
  const order = (e) => pos.get(e.uuid) ?? Number.MAX_SAFE_INTEGER;
  const byTime = (a, b) => (a.at ?? '').localeCompare(b.at ?? '');
  const done = new Set();
  const extra = new Map();
  let added = 0;
  for (const e of asst) {
    const mid = e.mid;
    if (!mid || done.has(mid)) continue;
    done.add(mid);
    const parts = partsOf.get(mid) ?? [e];
    const partIds = new Set(parts.map((p) => p.uuid));
    const offParts = parts.filter((p) => !on.has(p.uuid));
    const direct = [];
    const loose = [];
    const seen = new Set();
    for (const p of parts) {
      for (const k of kids.get(p.uuid) ?? []) {
        if (on.has(k.uuid) || seen.has(k.uuid)) continue;
        seen.add(k.uuid);
        if (partIds.has(k.parentUuid)) direct.push(k); else loose.push(k);
      }
    }
    if (loose.length) {
      const got = new Set(answered);
      for (const k of direct) for (const id of idsIn(k, 'tool_result', 'tool_use_id')) got.add(id);
      loose.sort((a, b) => order(a) - order(b));
      for (const k of loose) {
        const tids = idsIn(k, 'tool_result', 'tool_use_id');
        if (!tids.some((id) => { const w = owner.get(id); return !got.has(id) && Boolean(w) && partIds.has(w.uuid); })) continue;
        for (const id of tids) got.add(id);
        direct.push(k);
      }
    }
    if (!offParts.length && !direct.length) continue;
    offParts.sort(byTime);
    direct.sort(byTime);
    const add = [...offParts, ...direct];
    for (const x of add) on.add(x.uuid);
    added += add.length;
    extra.set(lastOf.get(mid).uuid, add);
  }
  if (!added) return chain;
  const out = [];
  for (const e of chain) { out.push(e); const x = extra.get(e.uuid); if (x) out.push(...x); }
  return out;
}

/** Queued commands written after the leaf that no later message continues from (the SDK's NCe). */
function trailingQueued(all, chain, leaf, by) {
  if (!leaf) return [];
  const kids = new Map();
  for (const d of all) if (d.parentUuid && !isUA(d)) pushTo(kids, d.parentUuid, d);
  const on = new Set(chain.map((d) => d.uuid));
  const toOther = new Set();
  for (const d of all) {
    if (!isUA(d) || d.side || d.team || on.has(d.uuid)) continue;
    for (let p = d.parentUuid ? by.get(d.parentUuid) : undefined; p && !on.has(p.uuid) && !toOther.has(p.uuid); p = p.parentUuid ? by.get(p.parentUuid) : undefined) toOther.add(p.uuid);
  }
  const out = [];
  const stack = [leaf];
  const byTime = (a, b) => ((a.at ?? '') < (b.at ?? '') ? -1 : (a.at ?? '') > (b.at ?? '') ? 1 : 0);
  while (stack.length) {
    const d = stack.pop();
    if (d !== leaf) {
      if (on.has(d.uuid)) continue;
      on.add(d.uuid);
      if (d.type === 'attachment' && d.att?.type === 'queued_command' && !toOther.has(d.uuid)) out.push(d);
    }
    const k = kids.get(d.uuid) ?? [];
    const f = k.length > 1 ? [...k].sort(byTime) : k;
    for (let m = f.length - 1; m >= 0; m--) if (!on.has(f[m].uuid)) stack.push(f[m]);
  }
  return out;
}

/** How many times each queued command was taken into a running turn (the SDK's CN and AN). */
function deliveredCounts(entries, ops) {
  const counts = new Map();
  const copies = new Map();
  const mixed = new Set();
  const dcopies = new Map();
  const dseen = new Set();
  for (const o of ops) {
    const key = o.deliveryId ? `delivery:${o.deliveryId}` : o.commandUuid ? `uuid:${o.commandUuid}` : null;
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const e of entries) {
    const a = e.type === 'attachment' && e.att?.type === 'queued_command' ? e.att : null;
    if (!a) continue;
    if (a.delivery_id) {
      if (!dseen.has(e.uuid)) { dseen.add(e.uuid); pushTo(dcopies, `delivery:${a.delivery_id}`, e.uuid); }
      continue;
    }
    if (!a.source_uuid) continue;
    const s = copies.get(a.source_uuid);
    if (s === undefined) copies.set(a.source_uuid, a.sig);
    else if (s !== a.sig) mixed.add(a.source_uuid);
  }
  for (const t of mixed) counts.delete(`uuid:${t}`);
  for (const [k, uuids] of dcopies) {
    const r = counts.get(k) ?? 0;
    for (const u of uuids.slice(Math.max(0, uuids.length - r))) counts.set(`entry:${u}`, 1);
  }
  return counts;
}

/** Which queued commands in seq were delivered, by position (the SDK's DCe). */
function deliveredFlags(seq, counts) {
  const out = new Map();
  if (!counts.size) return out;
  const groups = new Map();
  seq.forEach((e, s) => {
    const a = e.type === 'attachment' && e.att?.type === 'queued_command' ? e.att : null;
    if (!a) return;
    const key = a.delivery_id ? `delivery:${a.delivery_id}` : a.source_uuid ? `uuid:${a.source_uuid}` : null;
    if (key && counts.has(key)) pushTo(groups, key, s);
  });
  for (const [key, idxs] of groups) {
    if (key.startsWith('delivery:')) { for (const s of idxs) out.set(s, counts.has(`entry:${seq[s].uuid}`)); continue; }
    const n = counts.get(key);
    idxs.forEach((s, l) => out.set(s, l >= idxs.length - n));
  }
  return out;
}

/** Positions of a finished local command's record and output lines (the SDK's ICe). */
function localCommandRuns(seq) {
  const out = new Set();
  seq.forEach((r, o) => {
    if (r.type !== 'user' || !r.meta || localTag(r) !== 'caveat') return;
    let seen = false;
    for (let i = o + 1; i < seq.length; i++) {
      const a = seq[i];
      if (a.type === 'assistant') break;
      if (a.type !== 'user' || a.meta) continue;
      const l = localTag(a);
      if (l === 'record' && !seen) seen = true;
      else if (l !== 'output' || !seen) break;
      out.add(i);
    }
  });
  return out;
}

/** For each position: does a reply (not a new prompt) come next (the SDK's PCe)? */
function replyFollows(seq, local) {
  const out = new Array(seq.length).fill(false);
  let r;
  for (let o = seq.length - 1; o >= 0; o--) {
    const s = seq[o];
    out[o] = r === 'reply';
    if (s.type === 'assistant' || isResultMsg(s) || isInterruption(s)) r = 'reply';
    else if (s.type === 'user' && !s.meta && !s.cs && !local.has(o)) r = 'prompt';
  }
  return out;
}

/** Queued commands that reached Claude become user messages (the SDK's YC and LCe). */
function convertQueued(seq, counts, trailingIds) {
  const local = localCommandRuns(seq);
  const reply = replyFollows(seq, local);
  const delivered = deliveredFlags(seq, counts);
  const ids = new Set(seq.map((e) => e.uuid));
  return seq.map((e, c) => {
    if (local.has(c)) return e;
    const shown = delivered.has(c) ? delivered.get(c) : (reply[c] || trailingIds.has(e.uuid));
    if (!shown || e.type !== 'attachment' || e.att?.type !== 'queued_command') return e;
    const a = e.att;
    if ((a.isMeta && !keepsMeta(a.origin)) || (typeof a.prompt !== 'string' && !Array.isArray(a.prompt)) || a.forwarded) return e;
    const uuid = a.source_uuid || e.uuid;
    if (uuid !== e.uuid && ids.has(uuid)) return e;
    ids.add(uuid);
    const origin = a.origin || (a.commandMode === 'task-notification' ? { kind: 'task-notification' } : null);
    return { type: 'user', uuid, line: e.uuid, parentUuid: e.parentUuid, at: e.at, role: 'user', content: a.prompt, meta: a.isMeta || undefined, origin, queued: true, side: e.side, team: e.team };
  });
}

/** True for a user message made only of tool results (a page must not start on one). */
const resultsOnly = (it) => it.type === 'user' && Array.isArray(it.message?.content) && it.message.content.length > 0 && it.message.content.every((b) => b?.type === 'tool_result');

/**
 * The whole linear conversation from slim lines (in file order) and the
 * queue operations: { items, index (uuid -> item), by (uuid -> line),
 * compactions, leaf }.
 */
export function buildHistory(entries, ops = []) {
  const by = new Map();
  const pos = new Map();
  entries.forEach((e, i) => { by.set(e.uuid, e); pos.set(e.uuid, i); });
  const all = [...by.values()];
  const leaf = findLeaf(all, by, pos);
  const empty = { items: [], index: new Map(), by, compactions: 0, leaf: null };
  if (!leaf) return empty;
  // Back from the leaf; at a compaction (no parent), on from where the conversation was before it.
  const chain = [];
  const on = new Set();
  for (let c = leaf; c && !on.has(c.uuid);) {
    on.add(c.uuid);
    chain.push(c);
    const up = c.parentUuid || (c.type === 'system' && c.subtype === 'compact_boundary' ? c.lp : null);
    c = up ? by.get(up) : undefined;
  }
  chain.reverse();
  const full = addSiblings(by, chain, on, pos);
  const trailing = trailingQueued(all, full, leaf, by);
  const seq = convertQueued(full.concat(trailing), deliveredCounts(entries, ops), new Set(trailing.map((e) => e.uuid)));

  const items = [];
  const index = new Map();
  const mids = [];
  let compactions = 0;
  for (const e of seq) {
    // A system line Claude Code showed (systemNote, hookNote): a notice item, drawn apart from Claude's words.
    const note = e.type === 'system' ? e.note : e.type === 'attachment' ? e.att?.note : null;
    if (note && !e.side && !e.team) {
      index.set(e.uuid, items.length);
      items.push({ type: 'notice', uuid: e.uuid, at: e.at || null, notice: note });
      mids.push(null);
      continue;
    }
    if (e.type === 'system') {
      if (e.subtype !== 'compact_boundary') continue;
      compactions += 1;
      index.set(e.uuid, items.length);
      items.push({ type: 'compact', uuid: e.uuid, at: e.at || null, trigger: e.cm?.trigger || null, preTokens: e.cm?.preTokens ?? null, postTokens: e.cm?.postTokens ?? null, summary: null });
      mids.push(null);
      continue;
    }
    if (!isUA(e) || e.side || e.team) continue;
    if (e.meta && !keepsMeta(e.origin)) continue;
    if (e.cs) {
      // The summary goes into the marker of the compaction it belongs to (right before it).
      const last = items[items.length - 1];
      if (last?.type === 'compact' && !last.summary) { last.summary = e.summary || null; index.set(e.uuid, items.length - 1); continue; }
      compactions += 1;
      index.set(e.uuid, items.length);
      items.push({ type: 'compact', uuid: e.uuid, at: e.at || null, trigger: null, preTokens: null, postTokens: null, summary: e.summary || null });
      mids.push(null);
      continue;
    }
    const prev = items[items.length - 1];
    if (e.type === 'assistant' && prev?.type === 'assistant' && e.mid && mids[items.length - 1] === e.mid && Array.isArray(prev.message.content) && Array.isArray(e.content)) {
      // One API message written as several lines: one message again.
      prev.message.content = prev.message.content.concat(e.content);
      index.set(e.uuid, items.length - 1);
      continue;
    }
    index.set(e.uuid, items.length);
    items.push({
      type: e.type, uuid: e.uuid, at: e.at || null, parent_tool_use_id: null,
      message: { role: e.role || e.type, content: e.content, ...(e.model ? { model: e.model } : {}) },
      ...(e.queued ? { queued: true } : {}),
    });
    mids.push(e.type === 'assistant' ? e.mid || null : null);
  }
  return { items, index, by, compactions, leaf: leaf.uuid };
}

/**
 * A page of a built history: the `limit` items before the item `before`
 * (or the newest ones), never starting on tool results. all = everything
 * before it. { messages, total, hasMore, first, earlier, compactions }, or
 * { gone: true } when `before` is no longer in the conversation.
 */
/*
 * Your prompts across the whole conversation (2026-10-11, Arthur: "still im seeing 13 of 13 messages when i know
 * much more messages have been sent in a chat"): the pane's "You asked N of M" pin counted only the prompts loaded
 * on screen. A page now says how many prompts come before it and how many there are in all, counted the way the
 * pane draws them (a user message with words; not tool results, command wrappers or reminders).
 */
const NOT_A_PROMPT = /^\s*<(command-|local-command-|system-reminder)/;
export function isPromptItem(it) {
  if (!it || it.type !== 'user' || it.parent_tool_use_id) return false;
  const c = it.message?.content;
  if (typeof c === 'string') return Boolean(c.trim()) && !NOT_A_PROMPT.test(c);
  if (!Array.isArray(c)) return false;
  return c.some((b) => (b?.type === 'text' && b.text?.trim() && !NOT_A_PROMPT.test(b.text)) || b?.type === 'image');
}
/** Prompts before each item index (cached on the built history): before[i] = prompts in items[0..i). */
function promptsBefore(h) {
  if (h.promptsBefore && h.promptsBefore.length === h.items.length + 1) return h.promptsBefore;
  const out = new Int32Array(h.items.length + 1);
  for (let i = 0; i < h.items.length; i++) out[i + 1] = out[i] + (isPromptItem(h.items[i]) ? 1 : 0);
  h.promptsBefore = out;
  return out;
}

export function pageOf(h, { before = null, limit = PAGE, all = false } = {}) {
  const n = h.items.length;
  let end = n;
  if (before) {
    const i = h.index.get(before);
    if (i === undefined) return { gone: true, total: n };
    end = i;
  }
  let start = all ? 0 : Math.max(0, end - Math.max(1, Math.floor(limit) || PAGE));
  while (start > 0 && resultsOnly(h.items[start])) start -= 1;
  const pb = promptsBefore(h);
  return { messages: h.items.slice(start, end), total: n, hasMore: start > 0, first: h.items[start]?.uuid ?? null, earlier: start, compactions: h.compactions, prompts: { before: pb[start], total: pb[n] } };
}

/* ---------- reading the file ---------- */

/** The first-line type of a line that starts {"type":"...", or null (then it is parsed). */
function leadingType(buf, s, e) {
  if (e - s < 12 || buf[s] !== 0x7b || buf[s + 1] !== 0x22 || buf.toString('latin1', s + 2, s + 9) !== 'type":"') return null;
  const q = buf.indexOf(0x22, s + 9);
  return q > 0 && q - s < 64 && q < e ? buf.toString('latin1', s + 9, q) : null;
}

/**
 * Reads the complete lines of `file` from byte `from` and calls onLine(buf,
 * start, end, fileOffset) for each. A half-written last line waits for the
 * next read. Returns { parsedTo, size, mtimeMs }.
 */
async function readLines(file, from, onLine) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const st = await fh.stat();
    const size = st.size;
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, size - from)));
    let pos = from;
    let carry = null;
    let carryOff = from;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (!bytesRead) break;
      let data = buf.subarray(0, bytesRead);
      let base = pos;
      if (carry) { data = Buffer.concat([carry, data]); base = carryOff; carry = null; }
      pos += bytesRead;
      let s = 0;
      for (let nl = data.indexOf(10, s); nl !== -1; nl = data.indexOf(10, s)) {
        let e = nl;
        if (e > s && data[e - 1] === 0x0d) e -= 1;
        if (e > s) onLine(data, s, e, base + s);
        s = nl + 1;
      }
      if (s < data.length) { carry = Buffer.from(data.subarray(s)); carryOff = base + s; }
    }
    return { parsedTo: carry ? carryOff : pos, size, mtimeMs: st.mtimeMs };
  } finally {
    await fh.close();
  }
}

/** The first bytes of a file, to tell an appended file from a rewritten one. */
async function headOf(file, n = 512) {
  try {
    const fh = await fs.promises.open(file, 'r');
    try {
      const b = Buffer.alloc(n);
      const { bytesRead } = await fh.read(b, 0, n, 0);
      return b.toString('latin1', 0, bytesRead);
    } finally { await fh.close(); }
  } catch { return null; }
}

/** One line of the file, parsed (block() reads the full content from it). */
async function readLineAt(file, off, len) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const b = Buffer.alloc(len);
    const { bytesRead } = await fh.read(b, 0, len, off);
    return JSON.parse(b.toString('utf8', 0, bytesRead));
  } catch { return null; } finally { await fh.close(); }
}

/**
 * Transcripts read so far (the last few, by file), each brought up to date
 * on use, with its built history.
 */
export class HistoryStore {
  /**
   * @param {object} o
   * @param {(sessionId: string) => (string|null)} o.fileOf  the transcript of a session
   * @param {number} [o.maxCached]
   * @param {(line: string) => void} [o.log]
   */
  constructor({ fileOf, maxCached = MAX_CACHED, log = () => {} } = {}) {
    this.fileOf = fileOf;
    this.max = maxCached;
    this.log = log;
    this.cache = new Map(); // file -> { file, entries, ops, parsedTo, size, mtimeMs, head, built, busy }
  }

  /** The transcript's lines, read or brought up to date; null when it cannot be read. */
  async load(sessionId) {
    const file = sessionId ? this.fileOf(sessionId) : null;
    if (!file) return null;
    let rec = this.cache.get(file);
    // One read at a time per file: a second caller waits for the first and then checks again.
    while (rec?.busy) { await rec.busy.catch(() => {}); rec = this.cache.get(file); }
    let st;
    try { st = await fs.promises.stat(file); } catch { return null; }
    if (rec && rec.size === st.size && rec.mtimeMs === st.mtimeMs) { this.touch(file, rec); return rec; }
    const job = (async () => {
      const t0 = performance.now();
      let next = rec;
      const head = await headOf(file);
      // Appended since the last read: parse only the new lines. Shorter, or a different start: read it all again.
      if (!next || st.size < next.parsedTo || head !== next.head) next = { file, entries: [], ops: [], parsedTo: 0, head };
      const fresh = next.parsedTo === 0;
      const r = await readLines(file, next.parsedTo, (buf, s, e, off) => {
        const t = leadingType(buf, s, e);
        if (t && !NEEDED_TYPES.has(t)) return;
        let j;
        try { j = JSON.parse(buf.toString('utf8', s, e)); } catch { return; }
        const x = slimEntry(j, off, e - s);
        if (!x) return;
        if (x.type === 'queue-operation') next.ops.push(x); else next.entries.push(x);
      });
      Object.assign(next, { parsedTo: r.parsedTo, size: r.size, mtimeMs: r.mtimeMs, head, built: null });
      this.log(`history: ${fresh ? 'read' : 'caught up on'} ${file.split(/[\\/]/).pop()} (${next.entries.length} lines kept, ${Math.round(performance.now() - t0)} ms)`);
      return next;
    })();
    const holder = rec || { file };
    holder.busy = job;
    if (!rec) this.cache.set(file, holder);
    try {
      const done = await job;
      this.touch(file, done);
      return done;
    } catch (e) {
      this.cache.delete(file);
      this.log(`history: could not read ${file.split(/[\\/]/).pop()}: ${e.message || e}`);
      return null;
    } finally {
      holder.busy = null;
    }
  }

  /** Marks a record as just used, and drops the oldest past the limit. */
  touch(file, rec) {
    this.cache.delete(file);
    this.cache.set(file, rec);
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value);
  }

  /** The built history of a session (null when its transcript cannot be read). */
  async history(sessionId) {
    const rec = await this.load(sessionId);
    if (!rec) return null;
    if (!rec.built) rec.built = buildHistory(rec.entries, rec.ops);
    return rec.built;
  }

  /** The newest page, with source: 'transcript'; null when the transcript cannot be read or holds no messages. */
  async firstPage(sessionId, { limit = PAGE } = {}) {
    const h = await this.history(sessionId);
    if (!h || !h.items.length) return null;
    return { ...pageOf(h, { limit }), source: 'transcript' };
  }

  /** The page before item `before` (all: everything before it); null when the transcript cannot be read. */
  async pageBefore(sessionId, before, { limit = PAGE, all = false } = {}) {
    const h = await this.history(sessionId);
    if (!h) return null;
    return { ...pageOf(h, { before, limit, all }), source: 'transcript' };
  }

  /**
   * One block in full, from its own line: { kind: 'text', text, length, cut }
   * or { kind: 'image', media_type, data, bytes }, or { error }.
   */
  async block(sessionId, ref) {
    const m = REF_RE.exec(String(ref || ''));
    if (!m) return { error: 'That is not a part of a message.' };
    const [, uuid, bi, sub] = m;
    const h = await this.history(sessionId);
    if (!h) return { error: 'The transcript of this conversation is not on this PC.' };
    const rec = this.cache.get(this.fileOf(sessionId));
    const e = h.by.get(uuid);
    if (!e || !rec) return { error: 'That message is not in this conversation.' };
    const j = await readLineAt(rec.file, e.off, e.len);
    if (!j || j.uuid !== uuid) return { error: 'That message changed on disk. Reopen the conversation.' };
    const content = j.message?.content;
    if (bi === 's') return fullText(textOf(content));
    let b = typeof content === 'string' ? (bi === '0' ? { type: 'text', text: content } : null) : Array.isArray(content) ? content[Number(bi)] : null;
    if (sub !== undefined) b = b?.type === 'tool_result' && Array.isArray(b.content) ? b.content[Number(sub)] : null;
    if (!b || typeof b !== 'object') return { error: 'That part of the message is not there.' };
    if (b.type === 'image') {
      const data = b64Of(b);
      if (!data) return { error: 'That image is not stored in the transcript.' };
      if (data.length > IMAGE_B64_MAX) return { error: `That image is too large to show here (${Math.round(data.length / 1048576)} MB).` };
      if (!/^[A-Za-z0-9+/=\s]*$/.test(data.slice(0, 4096))) return { error: 'That image is not readable.' };
      return { kind: 'image', media_type: mediaOf(b), data: data.replace(/\s+/g, ''), bytes: bytesOf(b) };
    }
    if (b.type === 'tool_result') {
      const text = Array.isArray(b.content) ? b.content.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : String(b.content ?? '');
      return fullText(text);
    }
    if (b.type === 'thinking') return fullText(b.thinking || '');
    if (b.type === 'text') return fullText(b.text || '');
    return { error: 'That part of the message has no text.' };
  }
}

function fullText(t) {
  const s = String(t ?? '');
  return s.length > FULL_CHARS ? { kind: 'text', text: s.slice(0, FULL_CHARS), length: s.length, cut: true } : { kind: 'text', text: s, length: s.length, cut: false };
}
