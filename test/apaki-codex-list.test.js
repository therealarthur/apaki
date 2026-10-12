/**
 * Codex threads in the main session list from the start (2026-10-12; apaki/engine/codex-list.js, codex-rollouts.js,
 * last-active.js, wired in engine.js and app.js). Arthur: Codex sessions integrated exactly like Claude's (listed,
 * searchable, opened side by side), without starting the Codex app-server just to list them, cached like the Claude list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BATCH, REFRESH_MS, createCodexList } from '../apaki/engine/codex-list.js';
import { createRolloutScanner } from '../apaki/engine/codex-rollouts.js';
import { LastActive, lastMessageInfo } from '../apaki/engine/last-active.js';
import { groupRows, rowStates, statesHtml } from '../apaki/ui/sessionlist.js';

const L = (o) => JSON.stringify(o);
const A = '019a0000-0000-7000-8000-00000000000a';
const B = '019a0000-0000-7000-8000-00000000000b';
const C = '019a0000-0000-7000-8000-00000000000c';
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** A rollout whose last message is at `last` (ISO); the file's own time is set elsewhere. */
const rollout = (id, prompt, last, model = 'gpt-5.5-codex') => [
  L({ timestamp: '2026-10-01T08:00:00Z', type: 'session_meta', payload: { id, timestamp: '2026-10-01T08:00:00Z', cwd: 'C:\\acme\\api' } }),
  L({ timestamp: '2026-10-01T08:00:01Z', type: 'turn_context', payload: { model, effort: 'high' } }),
  L({ timestamp: '2026-10-01T08:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }),
  L({ timestamp: last, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } }),
  L({ timestamp: '2026-10-12T23:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: null } }),
  '',
].join('\n');

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-codex-list-'));
  const live = path.join(home, '.codex', 'sessions', '2026', '10', '01');
  const arch = path.join(home, '.codex', 'archived_sessions');
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(arch, { recursive: true });
  const put = (dir, id, prompt, last, mtime) => {
    const f = path.join(dir, `rollout-2026-10-01T08-00-00-${id}.jsonl`);
    fs.writeFileSync(f, rollout(id, prompt, last));
    fs.utimesSync(f, mtime, mtime);
    return f;
  };
  // The files' times say C is newest; their last messages say A is.
  put(live, A, 'Add a rate limiter to the public API', '2026-10-12T09:00:00Z', new Date('2026-10-02T00:00:00Z'));
  put(live, B, 'Port the date helpers to Temporal', '2026-10-11T09:00:00Z', new Date('2026-10-03T00:00:00Z'));
  put(arch, C, 'An old experiment', '2026-10-10T09:00:00Z', new Date('2026-10-04T00:00:00Z'));
  const roots = [{ dir: path.join(home, '.codex', 'sessions'), archived: false }, { dir: arch, archived: true }];
  return { home, roots, cacheFile: path.join(home, '.claude', 'latch', 'codex-list.json'), done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const sync = (fn) => { fn(); return null; };

test('codex list: rows from the rollouts without the app-server, newest last message first, archived marked, kept on disk', async () => {
  const w = world();
  try {
    let changes = 0;
    const list = createCodexList({ cacheFile: w.cacheFile, scanner: createRolloutScanner({ roots: w.roots }), onChange: () => { changes += 1; }, setTimer: sync });
    assert.deepEqual(list.rows(), [], 'nothing kept yet, nothing read yet: the first list is Claude only, at once');
    await list.refresh({ force: true });
    const rows = list.rows();
    assert.deepEqual(rows.map((r) => r.id), [`codex:${A}`, `codex:${B}`, `codex:${C}`], 'ordered by the last message, not the file time');
    assert.equal(rows[0].lastModified, Date.parse('2026-10-12T09:00:00Z'));
    assert.equal(rows[0].title, 'Add a rate limiter to the public API');
    assert.equal(rows[0].cwd, 'C:\\acme\\api');
    assert.equal(rows[0].codex, true);
    assert.equal(rows[0].model, 'gpt-5.5-codex', 'the model of its last turn, for the hover card');
    assert.ok(rows[0].size > 0, 'its size, for the hover card');
    assert.equal(rows[2].codexArchived, true);
    assert.equal(changes, 1);
    await list.refresh({ force: true });
    assert.equal(changes, 1, 'an unchanged pass sends nothing');
    const kept = JSON.parse(fs.readFileSync(w.cacheFile, 'utf8'));
    assert.equal(kept.v, 1);
    assert.equal(kept.rows.length, 3);
    assert.equal(kept.heads.length, 3);

    // A restart: the kept rows show before anything is read, and nothing unchanged is read again.
    const scanner = createRolloutScanner({ roots: w.roots });
    const again = createCodexList({ cacheFile: w.cacheFile, scanner, setTimer: sync });
    assert.deepEqual(again.rows().map((r) => r.id), [`codex:${A}`, `codex:${B}`, `codex:${C}`]);
    assert.equal(scanner.cacheSize(), 3, 'the heads came from the kept file');
    await again.refresh({ force: true });
    assert.equal(scanner.cacheSize(), 3, 'no head read again');
    assert.equal(again.rows()[0].lastModified, Date.parse('2026-10-12T09:00:00Z'));
  } finally { w.done(); }
});

test('codex list: the Codex view\'s rows (names set in Codex) win for the same thread; the later time wins', async () => {
  const w = world();
  try {
    const list = createCodexList({ scanner: createRolloutScanner({ roots: w.roots }), setTimer: sync });
    await list.refresh({ force: true });
    const server = [
      { id: `codex:${B}`, title: 'Temporal migration', cwd: 'C:\\acme\\api', lastModified: Date.parse('2026-10-13T09:00:00Z'), codex: true, size: 0 },
      { id: 'codex:019a0000-0000-7000-8000-0000000000ff', title: 'Only the server knows it', lastModified: 1, codex: true },
    ];
    const rows = list.rows(server);
    assert.deepEqual(rows.map((r) => r.id).slice(0, 3), [`codex:${B}`, `codex:${A}`, `codex:${C}`]);
    assert.equal(rows[0].title, 'Temporal migration');
    assert.ok(rows[0].size > 0, 'the rollout\'s size where the server has none');
    assert.equal(rows.length, 4);
    assert.equal(rows[2].codexArchived, true, 'archived stays archived');
  } finally { w.done(); }
});

test('codex list: a refresh at most every REFRESH_MS unless forced; a pass that read a full batch is followed by another', async () => {
  const w = world();
  try {
    let t = 1_000_000;
    let passes = 0;
    const scanner = createRolloutScanner({ roots: w.roots });
    const rows = scanner.rows.bind(scanner);
    scanner.rows = (known, o) => { passes += 1; return rows(known, o); };
    const timers = [];
    const list = createCodexList({ scanner, now: () => t, setTimer: (fn) => { timers.push(fn); return null; } });
    await list.refresh();
    await list.refresh();
    assert.equal(passes, 1);
    t += REFRESH_MS + 1;
    await list.refresh();
    assert.equal(passes, 2);
    assert.equal(timers.length, 0, 'three heads: no second batch');
    assert.ok(BATCH >= 20 && BATCH <= 250);
    // firstDelayMs: a refresh before then only schedules the first pass (once).
    const later = [];
    let p2 = 0;
    const s2 = createRolloutScanner({ roots: w.roots });
    const r2 = s2.rows.bind(s2);
    s2.rows = (known, o) => { p2 += 1; return r2(known, o); };
    const delayed = createCodexList({ scanner: s2, now: () => t, firstDelayMs: 3000, setTimer: (fn, ms) => { later.push([fn, ms]); return null; } });
    await delayed.refresh();
    await delayed.refresh();
    assert.equal(p2, 0);
    assert.equal(later.length, 1);
    assert.equal(later[0][1], 3000);
    await later[0][0]();
    await delayed.idle();
    assert.equal(p2, 1);
    assert.equal(delayed.rows().length, 3);
    // maxNew limits the heads one pass reads.
    const small = createRolloutScanner({ roots: w.roots });
    assert.equal((await small.rows(new Set(), { maxNew: 2 })).length, 2);
    assert.equal(small.cacheSize(), 2);
  } finally { w.done(); }
});

test('last active: a Codex rollout\'s time is its last message and its model the last turn_context\'s', async () => {
  const text = rollout(A, 'x y z w', '2026-10-12T09:00:00Z', 'gpt-5.5-codex');
  assert.deepEqual(lastMessageInfo(text), { at: Date.parse('2026-10-12T09:00:00Z'), model: 'gpt-5.5-codex' });
  const w = world();
  try {
    const la = new LastActive();
    const file = path.join(w.roots[0].dir, '2026', '10', '01', `rollout-2026-10-01T08-00-00-${A}.jsonl`);
    assert.equal(await la.lastActive(file), Date.parse('2026-10-12T09:00:00Z'), 'not the token count written later');
  } finally { w.done(); }
});

test('the window: Codex threads interleaved with Claude\'s in All, under the same headings, with the small Codex mark', () => {
  const claude = { id: '0e7f4b4e-1111-2222-3333-444455556666', title: 'Fix checkout', lastModified: Date.parse('2026-10-12T10:00:00Z') };
  const cx = { id: `codex:${A}`, codex: true, title: 'Rate limiter', lastModified: Date.parse('2026-10-12T11:00:00Z') };
  const groups = groupRows([claude, cx], Date.parse('2026-10-12T12:00:00Z'));
  assert.deepEqual(groups[0].rows.map((r) => r.id), [cx.id, claude.id], 'one list, by time');
  const html = statesHtml(rowStates(cx));
  assert.match(html, /<span class="sr-s sr-codex" role="img" aria-label="Codex"><svg class="sg sg-codex"/);
  const app = read('../apaki/ui/app.js');
  assert.equal(/if \(s\.codex && S\.view === 'all'/.test(app), false, 'All no longer leaves Codex threads out');
  assert.match(app, /\{ id: 'all', label: 'All', n: live\.length \}/);
  const engine = read('../apaki/engine/engine.js');
  assert.match(engine, /const codexList = CODEX_FOUND && !process\.env\.APAKI_NO_CODEX_LIST && !process\.env\.LATCH_NO_INDEX/, 'engine tests (real home folder) read no rollouts');
  assert.match(engine, /firstDelayMs: 3000,/);
  assert.match(engine, /for \(const row of codexRowsNow\(\)\) list\.push\(compact\(row, null, folderOf\)\);/);
  assert.match(engine, /codexList\?\.refresh\(\);/);
  assert.match(engine, /function codexRowsById\(\) \{ return new Map\(codexRowsNow\(\)/, 'search hits use the same rows');
  assert.equal(/codexList[^\n]*new CodexAppServer|codexList[^\n]*getClient/.test(engine), false, 'listing never starts the app-server');
  const archive = read('../apaki/engine/archive.js');
  assert.match(archive, /const ID_RE = \/\^\(\?:codex:\)\?/, 'a Codex thread archives in the list like a Claude session');
});
