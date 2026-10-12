/**
 * Codex threads found in the rollout files (apaki/engine/codex-rollouts.js), 2026-10-12.
 *
 * A temp CODEX_HOME with a few rollout files: the scanner lists the ones the server did not, takes the title and folder
 * from the head of the file, marks archived ones, reads a file again only when it changed, and never writes anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRolloutScanner, rolloutRoots } from '../apaki/engine/codex-rollouts.js';
import { createCodex } from '../apaki/engine/codex-panes.js';

const A = '01a00000-0000-7000-8000-00000000000a';
const B = '01a00000-0000-7000-8000-00000000000b';
const C = '01a00000-0000-7000-8000-00000000000c';

const meta = (id, cwd) => JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-12T01:02:03Z' } });
const user = (text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-rollouts-'));
  const day = path.join(home, 'sessions', '2026', '10', '12');
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(path.join(home, 'archived_sessions'), { recursive: true });
  const file = (dir, stamp, id, lines) => { const f = path.join(dir, `rollout-${stamp}-${id}.jsonl`); fs.writeFileSync(f, `${lines.join('\n')}\n`); return f; };
  const a = file(day, '2026-10-12T01-02-03', A, [meta(A, 'C:\proj\a'), user('# AGENTS.md instructions for C:\proj\a'), user('Explain the retry schedule')]);
  const b = file(path.join(home, 'archived_sessions'), '2026-09-01T01-02-03', B, [meta(B, 'C:\proj\b'), user('Old archived thread')]);
  fs.writeFileSync(path.join(day, 'notes.txt'), 'not a rollout');
  fs.writeFileSync(path.join(day, 'rollout-broken.jsonl'), 'x');
  return { home, day, a, b, rm: () => fs.rmSync(home, { recursive: true, force: true }), snapshot: () => fs.readdirSync(home, { recursive: true }).sort().join('|') };
}

test('the roots are $CODEX_HOME or ~/.codex, sessions and archived_sessions', () => {
  const r = rolloutRoots('H', {});
  assert.deepEqual(r.map((x) => [path.relative('H', x.dir), x.archived]), [[path.join('.codex', 'sessions'), false], [path.join('.codex', 'archived_sessions'), true]]);
  const e = rolloutRoots('H', { CODEX_HOME: 'X' });
  assert.deepEqual(e.map((x) => x.dir), [path.join('X', 'sessions'), path.join('X', 'archived_sessions')]);
});

test('lists the rollouts the server did not, with a title and folder from the file, archived ones marked, and writes nothing', async (t) => {
  const w = world();
  t.after(w.rm);
  const before = w.snapshot();
  const scan = createRolloutScanner({ roots: rolloutRoots(w.home, { CODEX_HOME: w.home }) });
  const rows = await scan.rows(new Set([`codex:${C}`]));
  assert.deepEqual(rows.map((r) => r.id).sort(), [`codex:${A}`, `codex:${B}`]);
  const a = rows.find((r) => r.id === `codex:${A}`);
  assert.equal(a.title, 'Explain the retry schedule', 'injected context is not the title');
  assert.equal(a.cwd, 'C:\proj\a');
  assert.equal(a.codex, true);
  assert.equal(a.source, 'rollout');
  assert.ok(a.lastModified > 0);
  assert.equal(a.codexArchived, undefined);
  assert.equal(rows.find((r) => r.id === `codex:${B}`).codexArchived, true);
  // The server's own row wins for a thread it lists.
  assert.deepEqual((await scan.rows(new Set([`codex:${A}`]))).map((r) => r.id), [`codex:${B}`]);
  assert.equal(w.snapshot(), before, 'nothing was created or removed');
});

test('a file is read again only when its size or time changed; a missing folder is no rows', async (t) => {
  const w = world();
  t.after(w.rm);
  const scan = createRolloutScanner({ roots: rolloutRoots(w.home, { CODEX_HOME: w.home }) });
  await scan.rows();
  assert.equal(scan.cacheSize(), 2);
  fs.appendFileSync(w.a, `${user('A later question')}\n`);
  const again = await scan.rows();
  assert.equal(again.find((r) => r.id === `codex:${A}`).title, 'Explain the retry schedule', 'the title is the first prompt');
  assert.equal(scan.cacheSize(), 2);
  assert.deepEqual(await createRolloutScanner({ roots: rolloutRoots(path.join(w.home, 'missing'), {}) }).rows(), []);
});

test('the Codex module lists them after the server rows, and still lists them when the server will not start', async (t) => {
  const w = world();
  t.after(w.rm);
  const events = [];
  const server = { ready: true, async ensure() {}, request: async (m) => (m === 'thread/list' ? { data: [{ id: C, name: 'Server thread', cwd: 'C:\c', recencyAt: 99 }], nextCursor: null } : {}), on() {}, off() {}, removeListener() {}, respond() {}, respondError() {}, async stop() {} };
  const mk = (client) => createCodex({ emit: (e) => events.push(e), asks: new Map(), panes: new Map(), tools: () => ({}), openPage: () => {}, createClient: () => client, rolloutRoots: rolloutRoots(w.home, { CODEX_HOME: w.home }), log: () => {} });
  const ok = await mk(server).list({ reqId: 'l1', refresh: true });
  assert.equal(ok[0].id, `codex:${C}`, 'the server rows come first');
  assert.deepEqual(ok.slice(1).map((r) => r.id).sort(), [`codex:${A}`, `codex:${B}`]);
  const dead = { ...server, ensure: async () => { throw new Error('codex not installed'); } };
  events.length = 0;
  await mk(dead).list({ reqId: 'l2', refresh: true });
  const ev = events.find((e) => e.ev === 'codexThreads');
  assert.equal(ev.error, 'codex not installed');
  assert.deepEqual(ev.items.map((r) => r.id).sort(), [`codex:${A}`, `codex:${B}`]);
});
