/**
 * A session's subagents and shells on disk (apaki/engine/tasks.js): listing
 * with their .meta.json, workflow agents, shell output files, finding the
 * agent a tool call started, reading transcript lines as they are appended,
 * and which files a viewer may read.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentByToolUse, compactEntry, countSubagents, isAgentFile, isTaskOutputFile, listShells, listSubagents, readEntries, readText, shellDir } from '../apaki/engine/tasks.js';

const SID = '0d5e7c1a-1111-4222-8333-944445555666';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-tasks-'));
  const proj = path.join(root, 'projects', 'C--Test-Project');
  fs.mkdirSync(path.join(proj, SID, 'subagents', 'workflows', 'wf_1'), { recursive: true });
  const transcript = path.join(proj, `${SID}.jsonl`);
  fs.writeFileSync(transcript, '');
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(path.join(proj, SID, 'subagents', 'agent-a1.jsonl'), line({ type: 'user', uuid: 'u1', timestamp: '2026-10-10T01:00:00.000Z', message: { role: 'user', content: 'Count the folders' } }));
  fs.writeFileSync(path.join(proj, SID, 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Scout', description: 'Count folders', toolUseId: 'toolu_1', spawnDepth: 1, requestShape: 'background', model: 'haiku' }));
  fs.writeFileSync(path.join(proj, SID, 'subagents', 'workflows', 'wf_1', 'agent-w1.jsonl'), line({ type: 'user', uuid: 'u2', timestamp: '2026-10-10T01:05:00.000Z', message: { role: 'user', content: 'Review' } }));
  const shells = shellDir(transcript);
  fs.mkdirSync(shells, { recursive: true });
  fs.writeFileSync(path.join(shells, 'b123.output'), 'line one\nline two\n');
  return { root, proj, transcript, shells, line };
}

test('subagents come with their meta, workflow agents too, newest first', () => {
  const f = fixture();
  try {
    const list = listSubagents(f.transcript);
    assert.equal(list.length, 2);
    assert.equal(countSubagents(f.transcript), 2);
    const a = list.find((x) => x.id === 'a1');
    assert.deepEqual([a.type, a.description, a.model, a.toolUseId, a.background, a.workflow], ['Scout', 'Count folders', 'haiku', 'toolu_1', true, null]);
    assert.equal(a.startedAt, Date.parse('2026-10-10T01:00:00.000Z'));
    assert.equal(list.find((x) => x.id === 'w1').workflow, 'wf_1');
    assert.equal(agentByToolUse(f.transcript, 'toolu_1').id, 'a1');
    assert.equal(agentByToolUse(f.transcript, 'nope'), null);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(path.dirname(path.dirname(f.shells)), { recursive: true, force: true }); }
});

test('shell output files of the session, and only those may be read by a viewer', () => {
  const f = fixture();
  try {
    const sh = listShells(f.transcript);
    assert.deepEqual(sh.map((s) => s.id), ['b123']);
    assert.equal(sh[0].running, true);
    assert.equal(isTaskOutputFile(path.join(f.shells, 'b123.output')), true);
    assert.equal(isTaskOutputFile(path.join(os.tmpdir(), 'other.output')), false);
    assert.equal(isTaskOutputFile('C:\\Windows\\win.ini'), false);
    assert.equal(isAgentFile(path.join(f.proj, SID, 'subagents', 'agent-a1.jsonl'), path.join(f.root, 'projects')), true);
    assert.equal(isAgentFile(f.transcript, path.join(f.root, 'projects')), false);
    const t = readText(path.join(f.shells, 'b123.output'));
    assert.equal(t.text, 'line one\nline two\n');
    fs.appendFileSync(path.join(f.shells, 'b123.output'), 'line three\n');
    assert.equal(readText(path.join(f.shells, 'b123.output'), t.next).text, 'line three\n');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(path.dirname(path.dirname(f.shells)), { recursive: true, force: true }); }
});

test('transcript lines are read as they are appended; a half-written line waits', () => {
  const f = fixture();
  try {
    const file = path.join(f.proj, SID, 'subagents', 'agent-a1.jsonl');
    const first = readEntries(file, 0);
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0].message.content, 'Count the folders');
    fs.appendFileSync(file, f.line({ type: 'assistant', uuid: 'x1', timestamp: '2026-10-10T01:00:05.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Found 3' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }));
    fs.appendFileSync(file, '{"type":"user","uuid":"half');
    const next = readEntries(file, first.next);
    assert.equal(next.entries.length, 1);
    assert.deepEqual(next.entries[0].message.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
    assert.equal(next.entries[0].message.content[0].thinking, undefined);
    assert.equal(readEntries(file, next.next).entries.length, 0);
    assert.equal(compactEntry('{"type":"file-history-snapshot"}'), null);
    assert.equal(compactEntry('{"type":"user","isMeta":true,"message":{"content":"x"}}'), null);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(path.dirname(path.dirname(f.shells)), { recursive: true, force: true }); }
});
