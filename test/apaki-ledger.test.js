/**
 * The switch ledger's readers (apaki/engine/ledger.js), 2026-10-12.
 *
 * Both readers run over small synthetic files shaped like the real ones (test-fixtures/switch: a Claude Code transcript
 * and a codex-cli 0.161 rollout, with made-up names and texts; never a real transcript): every kind of event, the
 * handoff text taken out, unknown line types counted and skipped, bookmarks by byte offset, a giant file read from
 * its newest part, and finding the files by id.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HANDOFF_END, HANDOFF_MARK, claudeTranscript, codexRollout, commandLine, contentText, fileLines, isHandoff, lineAt, readEvents, stripHandoff,
} from '../apaki/engine/ledger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE = path.join(ROOT, 'test-fixtures', 'switch', 'claude-session.jsonl');
const CODEX = path.join(ROOT, 'test-fixtures', 'switch', 'codex-rollout.jsonl');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-ledger-test-'));

test('ledger: the Claude reader turns a transcript into prompts, replies, thinking, tool calls and results, in order', async () => {
  const r = await readEvents('claude', CLAUDE);
  const kinds = r.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['prompt', 'reasoning', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'reply', 'prompt', 'compaction', 'compaction', 'prompt', 'tool_call', 'tool_result', 'reply', 'prompt', 'reply']);
  const [p1] = r.events;
  assert.equal(p1.text, 'Make the build pass');
  assert.equal(p1.side, 'claude');
  assert.match(p1.id, /^claude@\d+$/);
  assert.equal(p1.at, '2026-10-12T09:00:01.000Z');
  const bash = r.events.find((e) => e.kind === 'tool_call' && e.tool === 'Bash');
  assert.deepEqual(bash.input, { command: 'npm run build', description: 'Build' });
  const failed = r.events.find((e) => e.kind === 'tool_result' && e.callId === 'toolu_1');
  assert.equal(failed.isError, true);
  assert.match(failed.output, /TS2304/);
  // A result given as blocks of text.
  assert.match(r.events.find((e) => e.callId === 'toolu_2' && e.kind === 'tool_result').output, /has been updated/);
  // The slash command as typed; the meta line and the subagent's own step are left out.
  assert.equal(r.events[7].text, '/compact');
  assert.ok(!r.events.some((e) => /subagent's own step/.test(e.text || '')));
  // The compaction summary Claude Code wrote.
  assert.match(r.events[9].text, /missing import of foo/);
  // System reminders come off a prompt.
  assert.equal(r.events[10].text, 'Now add a test for foo');
  // A handoff sent in front of a message leaves only the person's own words.
  assert.equal(r.events[14].text, 'Carry on with the tests');
  // The session's title and model, the unknown line type counted, the bad line counted, nothing thrown.
  assert.equal(r.stats.title, 'Build fix');
  assert.equal(r.stats.model, 'claude-opus-5-5');
  assert.deepEqual([...r.stats.unknown], [['future-thing', 1]]);
  assert.equal(r.stats.bad, 1);
  assert.equal(r.end, fs.statSync(CLAUDE).size);
  assert.equal(r.skipped, 0);
});

test('ledger: the Codex reader understands 0.161 rollouts and older shapes, and skips what Codex writes for itself', async () => {
  const r = await readEvents('codex', CODEX);
  const kinds = r.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['settings', 'settings', 'prompt', 'reasoning', 'tool_call', 'command', 'tool_result', 'tool_call', 'tool_result', 'file_change', 'reply', 'compaction', 'prompt', 'tool_call', 'tool_result', 'reply']);
  // The environment message and the injected handoff are not prompts.
  const prompts = r.events.filter((e) => e.kind === 'prompt');
  assert.deepEqual(prompts.map((e) => e.text), ['Run the tests and fix what fails', 'Thanks, now update the README']);
  assert.equal(prompts[1].images, 1);
  assert.equal(r.events[1].model, 'gpt-6.1-sol');
  assert.equal(r.events[1].sandbox, 'danger-full-access');
  assert.equal(r.events[3].text, 'Looking at the test runner first.');
  // The command as its app shows it: the shell wrapper off, the exit code and output kept.
  const cmd = r.events.find((e) => e.kind === 'command');
  assert.equal(cmd.command, 'npm test');
  assert.equal(cmd.exitCode, 1);
  assert.match(cmd.output, /1 failing/);
  // An older shell call: JSON arguments, a JSON output with the exit code.
  const shell = r.events.find((e) => e.kind === 'tool_call' && e.tool === 'shell');
  assert.deepEqual(shell.input, { command: ['bash', '-lc', 'ls src'] });
  const out = r.events.find((e) => e.kind === 'tool_result' && e.callId === 'call_2');
  assert.equal(out.output, 'a.ts\nfoo.ts\nfoo.test.ts\n');
  assert.equal(out.exitCode, 0);
  assert.equal(out.isError, false);
  // Content items as text.
  assert.match(r.events.find((e) => e.callId === 'call_1' && e.kind === 'tool_result').output, /Script completed[\s\S]*1 failing/);
  assert.deepEqual(r.events.find((e) => e.kind === 'file_change').changes, [{ path: 'C:\\proj\\src\\foo.ts', type: 'update' }]);
  assert.equal(r.events.find((e) => e.kind === 'reply').phase, 'final_answer');
  assert.equal(r.events.find((e) => e.kind === 'tool_call' && e.callId === 'call_3').tool, 'apaki.show');
  assert.equal(r.stats.threadId, '01a20000-0000-7000-8000-000000000001');
  assert.deepEqual(Object.fromEntries(r.stats.unknown), { brand_new_line: 1, 'event_msg/some_new_event': 1, 'response_item/some_new_item': 1 });
});

test('ledger: a bookmark reads only what came after it, and a line still being written waits for the next read', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 's.jsonl');
    const all = fs.readFileSync(CLAUDE, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(f, `${all.slice(0, 8).join('\n')}\n`);
    const first = await readEvents('claude', f);
    assert.equal(first.end, fs.statSync(f).size);
    // More lines, the last one half written.
    const rest = `${all.slice(8, 20).join('\n')}\n`;
    const half = all[20].slice(0, 30);
    fs.appendFileSync(f, rest + half);
    const second = await readEvents('claude', f, { from: first.end });
    assert.equal(second.events[0].text, '/compact');
    assert.equal(second.events.at(-1).kind, 'reply');
    assert.match(second.events.at(-1).text, /usage limit/);
    assert.equal(second.end, fs.statSync(f).size - half.length);
    // The rest of the half line arrives: the next read starts at it.
    fs.appendFileSync(f, `${all[20].slice(30)}\n${all[21]}\n`);
    const third = await readEvents('claude', f, { from: second.end });
    assert.deepEqual(third.events.map((e) => e.text), ['Carry on with the tests', 'The tests pass.']);
    // Every event id leads back to its line.
    const ev = second.events[0];
    const line = await lineAt(f, ev.offset);
    assert.match(line, /command-name/);
    assert.equal(await lineAt(f, ev.offset + 1), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ledger: a giant file is read from its newest part, starting at a whole line', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'big.jsonl');
    const line = (i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `prompt ${i} ${'x'.repeat(200)}` }, timestamp: '2026-10-12T00:00:00.000Z' });
    fs.writeFileSync(f, `${Array.from({ length: 400 }, (_, i) => line(i)).join('\n')}\n`);
    const r = await readEvents('claude', f, { maxBytes: 10000 });
    assert.ok(r.skipped > 0);
    assert.equal(r.stats.bad, 0, 'the cut line is skipped, not parsed');
    assert.match(r.events.at(-1).text, /^prompt 399 /);
    assert.ok(r.events.length >= 30 && r.events.length <= 46, String(r.events.length));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ledger: fileLines gives exact offsets for long lines across chunks', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'long.jsonl');
    const long = `{"a":"${'é'.repeat(700 * 1024)}"}`;
    fs.writeFileSync(f, `{"x":1}\n${long}\n{"y":2}\n`);
    const got = [];
    for await (const l of fileLines(f)) got.push([l.offset, l.text.length, l.next]);
    const b1 = Buffer.byteLength('{"x":1}\n');
    const b2 = b1 + Buffer.byteLength(long) + 1;
    assert.deepEqual(got.map((g) => g[0]), [0, b1, b2]);
    assert.equal(got[1][1], long.length);
    assert.equal(got[2][2], fs.statSync(f).size);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ledger: the handoff text and small helpers', () => {
  assert.equal(stripHandoff('plain words'), 'plain words');
  assert.equal(stripHandoff(`${HANDOFF_MARK} the record`), '');
  assert.equal(stripHandoff(`${HANDOFF_MARK} the record\n${HANDOFF_END}\n\nkeep going`), 'keep going');
  assert.ok(isHandoff(`  ${HANDOFF_MARK} x`));
  assert.ok(!isHandoff('hello'));
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'image' }]), 'a\n[2 images]');
  assert.equal(commandLine(['C:\\x\\pwsh.exe', '-Command', 'npm test']), 'npm test');
  assert.equal(commandLine(['bash', '-lc', 'ls -la']), 'ls -la');
  assert.equal(commandLine(['git', 'status']), 'git status');
  assert.equal(commandLine('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "npm run build"'), 'npm run build');
});

test('ledger: finding a Claude transcript and a Codex rollout by id', () => {
  const dir = tmp();
  try {
    const claudeDir = path.join(dir, 'claude');
    const sid = '5e55a0c0-0000-4000-8000-000000000001';
    fs.mkdirSync(path.join(claudeDir, 'projects', 'C--proj'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'projects', 'C--proj', `${sid}.jsonl`), '');
    assert.equal(claudeTranscript(sid, { claudeDir }), path.join(claudeDir, 'projects', 'C--proj', `${sid}.jsonl`));
    assert.equal(claudeTranscript('5e55a0c0-0000-4000-8000-000000000009', { claudeDir }), null);
    assert.equal(claudeTranscript('../../etc/passwd', { claudeDir }), null);
    const sessions = path.join(dir, 'codex', 'sessions');
    const archived = path.join(dir, 'codex', 'archived_sessions');
    const tid = '01a20000-0000-7000-8000-000000000001';
    fs.mkdirSync(path.join(sessions, '2026', '10', '12'), { recursive: true });
    fs.mkdirSync(archived, { recursive: true });
    const live = path.join(sessions, '2026', '10', '12', `rollout-2026-10-12T09-10-00-${tid}.jsonl`);
    fs.writeFileSync(live, '');
    const old = '01a20000-0000-7000-8000-000000000002';
    fs.writeFileSync(path.join(archived, `rollout-2026-09-01T10-00-00-${old}.jsonl`), '');
    assert.equal(codexRollout(tid, [sessions, archived]), live);
    assert.equal(codexRollout(old, [sessions, archived]), path.join(archived, `rollout-2026-09-01T10-00-00-${old}.jsonl`));
    assert.equal(codexRollout('01a20000-0000-7000-8000-000000000003', [sessions, archived]), null);
    assert.equal(codexRollout('nope', [sessions]), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
