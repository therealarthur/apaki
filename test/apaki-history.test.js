/**
 * The whole history of a session (apaki/engine/history.js, 2026-10-10):
 * the chain across compactions, rewound branches left out, parts of one
 * assistant message joined (and parallel tool calls put back), queued
 * commands, sidechains and meta lines, pages that never start on tool
 * results, the file cache (append-only reads), blocks fetched in full, and
 * the phone policy for the two read-only ops (remote-policy.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HistoryStore, PAGE, RESULT_CHARS, buildHistory, pageOf, slimEntry } from '../apaki/engine/history.js';
import { checkPhoneCommand } from '../apaki/engine/remote-policy.js';

/* ---------- a tiny transcript builder ---------- */

let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const at = (i) => new Date(Date.UTC(2026, 9, 10, 12, 0, i)).toISOString();
let clock = 0;

/** Line objects as Claude Code writes them; each helper returns the line. */
function T() {
  const lines = [];
  const add = (o) => { lines.push({ timestamp: at(clock++), sessionId: 's', ...o }); return lines[lines.length - 1]; };
  return {
    lines,
    user: (parent, content, extra = {}) => add({ type: 'user', uuid: extra.uuid || uid(), parentUuid: parent?.uuid ?? null, message: { role: 'user', content }, ...extra }),
    asst: (parent, content, mid, extra = {}) => add({ type: 'assistant', uuid: uid(), parentUuid: parent?.uuid ?? null, message: { id: mid, role: 'assistant', model: 'claude-opus-5-5', content }, ...extra }),
    att: (parent, attachment) => add({ type: 'attachment', uuid: uid(), parentUuid: parent?.uuid ?? null, attachment }),
    boundary: (logical) => add({ type: 'system', subtype: 'compact_boundary', uuid: uid(), parentUuid: null, logicalParentUuid: logical.uuid, compactMetadata: { trigger: 'auto', preTokens: 900000, postTokens: 40000 } }),
    raw: (o) => add(o),
  };
}

const slim = (lines) => lines.map((j, i) => slimEntry(j, i * 10, 10)).filter(Boolean);
const build = (lines) => buildHistory(slim(lines).filter((e) => e.type !== 'queue-operation'), slim(lines).filter((e) => e.type === 'queue-operation'));
const texts = (h) => h.items.map((it) => (it.type === 'compact' ? '#compact' : typeof it.message.content === 'string' ? it.message.content : it.message.content.map((b) => b.text || b.type).join('+')));

/* ---------- the chain ---------- */

test('history: a compacted conversation comes back whole, with a marker holding the summary', () => {
  const t = T();
  const u1 = t.user(null, 'first question');
  const a1 = t.asst(u1, [{ type: 'text', text: 'first answer' }], 'm1');
  const u2 = t.user(a1, 'second question');
  const a2 = t.asst(u2, [{ type: 'text', text: 'second answer' }], 'm2');
  const b = t.boundary(a2);
  const env = t.att(b, { type: 'environment' });
  const sum = t.user(env, 'This session is being continued from a previous conversation... (summary)', { isCompactSummary: true, isVisibleInTranscriptOnly: true });
  const u3 = t.user(sum, 'third question');
  t.asst(u3, [{ type: 'text', text: 'third answer' }], 'm3');
  const h = build(t.lines);
  assert.deepEqual(texts(h), ['first question', 'first answer', 'second question', 'second answer', '#compact', 'third question', 'third answer']);
  const mark = h.items[4];
  assert.equal(mark.type, 'compact');
  assert.equal(mark.trigger, 'auto');
  assert.equal(mark.preTokens, 900000);
  assert.match(mark.summary.text, /being continued/);
  assert.equal(h.compactions, 1);
  // Every item keeps its time; the summary's uuid finds the marker.
  assert.ok(h.items.every((it) => it.at));
  assert.equal(h.index.get(sum.uuid), 4);
});

test('history: a rewound branch stays out (the latest tip wins, like the SDK)', () => {
  const t = T();
  const u1 = t.user(null, 'start');
  const a1 = t.asst(u1, [{ type: 'text', text: 'ok' }], 'm1');
  const old = t.user(a1, 'abandoned question');
  t.asst(old, [{ type: 'text', text: 'abandoned answer' }], 'm2');
  const redo = t.user(a1, 'rewritten question');
  t.asst(redo, [{ type: 'text', text: 'new answer' }], 'm3');
  assert.deepEqual(texts(build(t.lines)), ['start', 'ok', 'rewritten question', 'new answer']);
});

test('history: parts of one assistant message are joined, and a parallel tool result off the chain comes back', () => {
  const t = T();
  const u1 = t.user(null, 'do two things');
  const think = t.asst(u1, [{ type: 'thinking', thinking: 'plan it', signature: 'x'.repeat(500) }], 'm1');
  const p1 = t.asst(think, [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'one' } }], 'm1');
  const p2 = t.asst(p1, [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'two' } }], 'm1');
  // The first result hangs off the first part (not on the chain); the second continues the chain.
  t.user(p1, [{ type: 'tool_result', tool_use_id: 'tu1', content: 'out one' }], { sourceToolAssistantUUID: p1.uuid });
  const r2 = t.user(p2, [{ type: 'tool_result', tool_use_id: 'tu2', content: 'out two' }], { sourceToolAssistantUUID: p2.uuid });
  t.asst(r2, [{ type: 'text', text: 'both done' }], 'm2');
  const h = build(t.lines);
  const kinds = h.items.map((it) => `${it.type}:${Array.isArray(it.message.content) ? it.message.content.map((b) => b.type).join(',') : 'text'}`);
  assert.deepEqual(kinds, ['user:text', 'assistant:thinking,tool_use,tool_use', 'user:tool_result', 'user:tool_result', 'assistant:text']);
  const results = h.items.filter((it) => it.type === 'user' && Array.isArray(it.message.content)).map((it) => it.message.content[0].tool_use_id).sort();
  assert.deepEqual(results, ['tu1', 'tu2']);
  // Thinking keeps its text, never the signature.
  assert.deepEqual(h.items[1].message.content[0], { type: 'thinking', thinking: 'plan it' });
});

test('history: sidechains and meta lines stay out; a delivered queued command becomes a user message', () => {
  const t = T();
  const u1 = t.user(null, 'go');
  const a1 = t.asst(u1, [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'x' } }], 'm1');
  t.raw({ type: 'user', uuid: uid(), parentUuid: a1.uuid, isSidechain: true, message: { role: 'user', content: 'subagent prompt' } });
  const meta = t.user(a1, 'caveat text', { isMeta: true });
  const q = t.att(meta, { type: 'queued_command', prompt: 'also check the tests', source_uuid: uid() });
  const r = t.user(q, [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file text' }]);
  t.asst(r, [{ type: 'text', text: 'done' }], 'm2');
  const h = build(t.lines);
  assert.deepEqual(texts(h), ['go', 'tool_use', 'also check the tests', 'tool_result', 'done']);
  assert.equal(h.items[2].queued, true);
});

test('history: cut tool output and images are marked with refs; pages never start on tool results', () => {
  const t = T();
  let prev = null;
  for (let i = 0; i < 6; i++) {
    const u = t.user(prev, `q${i}`);
    const a = t.asst(u, [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'x' } }], `m${i}`);
    prev = t.user(a, [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: 'y'.repeat(RESULT_CHARS + 50) }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }]);
  }
  const h = build(t.lines);
  const res = h.items[2].message.content[0];
  assert.equal(res.truncated, true);
  assert.equal(res.length, RESULT_CHARS + 50);
  assert.match(res.ref, /^[0-9a-f-]{36}:0$/);
  assert.deepEqual(res.images, [{ ref: `${res.ref}:1`, media_type: 'image/png', bytes: 3 }]);
  // 18 items; a page of 4 would start on a tool result, so it starts one earlier, on the tool call.
  const first = pageOf(h, { limit: 4 });
  assert.equal(first.messages[0].type, 'assistant');
  assert.equal(first.messages.length, 5);
  assert.equal(first.hasMore, true);
  assert.equal(first.earlier, 13);
  const before = pageOf(h, { before: first.first, limit: 4 });
  assert.equal(before.messages.at(-1).uuid, h.items[12].uuid);
  assert.equal(pageOf(h, { before: first.first, all: true }).messages.length, 13);
  assert.equal(pageOf(h, { before: '00000000-0000-4000-8000-999999999999' }).gone, true);
  assert.equal(PAGE, 300);
});

/* ---------- the store: the file, appends, blocks ---------- */

test('history store: reads the file, catches up on appends, fetches cut blocks and images in full', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-history-test-'));
  try {
    const file = path.join(dir, 's.jsonl');
    const t = T();
    const u1 = t.user(null, 'hello');
    const a1 = t.asst(u1, [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'dump' } }], 'm1');
    const big = 'z'.repeat(RESULT_CHARS * 3);
    const r1 = t.user(a1, [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: big }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }] }]);
    // Lines Apaki skips without parsing, and a half-written last line, must not get in the way.
    t.raw({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} });
    fs.writeFileSync(file, `${t.lines.map((l) => JSON.stringify(l)).join('\n')}\n{"type":"user","uu`);
    const store = new HistoryStore({ fileOf: () => file });
    const p1 = await store.firstPage('s');
    assert.equal(p1.source, 'transcript');
    assert.equal(p1.total, 3);
    assert.equal(p1.hasMore, false);
    const cut = p1.messages[2].message.content[0];
    const full = await store.block('s', cut.ref);
    assert.equal(full.kind, 'text');
    assert.equal(full.text, big);
    const img = await store.block('s', cut.images[0].ref);
    assert.deepEqual({ kind: img.kind, media_type: img.media_type, data: img.data }, { kind: 'image', media_type: 'image/jpeg', data: 'QUJD' });
    assert.ok((await store.block('s', 'not-a-ref')).error);
    assert.ok((await store.block('s', `${u1.uuid}:7`)).error);
    // Appended (the half line finished, one more message): only the new lines are read.
    const before = store.cache.get(file).parsedTo;
    const a2 = { type: 'assistant', uuid: uid(), parentUuid: r1.uuid, timestamp: at(99), message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'all done' }] } };
    fs.writeFileSync(file, `${t.lines.map((l) => JSON.stringify(l)).join('\n')}\n${JSON.stringify(a2)}\n`);
    const p2 = await store.firstPage('s');
    assert.equal(p2.total, 4);
    assert.equal(p2.messages.at(-1).message.content[0].text, 'all done');
    assert.ok(store.cache.get(file).parsedTo > before);
    // No file: null, so the engine falls back to the SDK.
    assert.equal(await new HistoryStore({ fileOf: () => path.join(dir, 'missing.jsonl') }).firstPage('s'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- phones (remote-policy.js) ---------- */

test('policy: a phone may page its own open conversation and fetch its blocks, nothing else', () => {
  const DEV = 'AbCdEfGhIjKlMnOpQrStUv';
  const SID = '0e7f4b4e-1111-2222-3333-444455556666';
  const U = '00000000-0000-4000-8000-000000000001';
  const ctx = { deviceId: DEV, paneExists: (id) => id === `phone:${DEV}:p1`, paneCount: () => 1, phoneSessions: () => [SID] };
  const ok = checkPhoneCommand({ op: 'historyBefore', reqId: 'r1', paneId: 'p1', sessionId: SID, before: U, limit: 300, all: false, path: 'C:/x' }, ctx);
  assert.deepEqual(ok, { ok: true, cmd: { op: 'historyBefore', reqId: `phone:${DEV}:r1`, paneId: `phone:${DEV}:p1`, sessionId: SID, before: U, limit: 300, all: false } });
  assert.equal(checkPhoneCommand({ op: 'historyBefore', paneId: 'p2', before: U }, ctx).ok, false); // not its pane
  assert.equal(checkPhoneCommand({ op: 'historyBefore', paneId: 'p1', before: '../../etc' }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'historyBefore', paneId: 'p1', before: U, limit: 100000 }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'historyBefore', paneId: 'p1', before: U, sessionId: '0e7f4b4e-9999-2222-3333-444455556666' }, ctx).ok, false); // a session it does not have open
  const blk = checkPhoneCommand({ op: 'historyBlock', paneId: 'p1', ref: `${U}:3:1` }, ctx);
  assert.deepEqual(blk, { ok: true, cmd: { op: 'historyBlock', paneId: `phone:${DEV}:p1`, ref: `${U}:3:1` } });
  assert.equal(checkPhoneCommand({ op: 'historyBlock', paneId: 'p1', ref: `${U}:s` }, ctx).ok, true);
  for (const ref of ['C:/Windows/win.ini', `${U}`, `${U}:x`, `${U}:1:2:3`, 42]) assert.equal(checkPhoneCommand({ op: 'historyBlock', paneId: 'p1', ref }, ctx).ok, false, String(ref));
  // Allowed for a chat-only phone too: it only reads what that phone already has open.
  assert.equal(checkPhoneCommand({ op: 'historyBlock', paneId: 'p1', ref: `${U}:0` }, { ...ctx, cap: 'chat' }).ok, true);
});
