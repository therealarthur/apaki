/**
 * The live session list (apaki/engine/live.js): which file changes count,
 * when the terminal map changed, the bare item for a transcript the SDK's
 * list skips, and that a window opening and closing reaches onTerminals.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bareItem, isTopTranscript, startLive, terminalSignature } from '../apaki/engine/live.js';

test('only top-level transcripts count, on either slash', () => {
  assert.equal(isTopTranscript('C--Users-Arthur\\0f1e.jsonl'), true);
  assert.equal(isTopTranscript('C--Users-Arthur/0f1e.jsonl'), true);
  assert.equal(isTopTranscript('C--Users-Arthur\\0f1e\\subagents\\agent-1.jsonl'), false);
  assert.equal(isTopTranscript('C--Users-Arthur\\0f1e.json'), false);
  assert.equal(isTopTranscript(''), false);
});

test('the terminal signature changes with a window, its status or its name, not with order', () => {
  const a = new Map([['s1', [{ pid: 1, status: 'idle', name: 'w1' }]], ['s2', [{ pid: 2, status: 'busy', name: 'w2' }]]]);
  const b = new Map([['s2', [{ pid: 2, status: 'busy', name: 'w2' }]], ['s1', [{ pid: 1, status: 'idle', name: 'w1' }]]]);
  assert.equal(terminalSignature(a), terminalSignature(b));
  assert.notEqual(terminalSignature(a), terminalSignature(new Map([['s1', [{ pid: 1, status: 'busy', name: 'w1' }]]])));
  assert.notEqual(terminalSignature(a), terminalSignature(new Map()));
});

test('a transcript with no prompt yet still becomes a list item', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-live-'));
  const f = path.join(dir, '11111111-2222-3333-4444-555555555555.jsonl');
  fs.writeFileSync(f, '{"type":"file-history-snapshot"}\n{"type":"attachment","cwd":"C:\\\\Users\\\\Arthur\\\\Projects"}\n');
  const it = bareItem('11111111-2222-3333-4444-555555555555', f);
  assert.equal(it.title, '(no messages yet)');
  assert.equal(it.cwd, 'C:\\Users\\Arthur\\Projects');
  assert.equal(it.bare, true);
  assert.equal(bareItem('x', path.join(dir, 'missing.jsonl')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a window opening and closing reaches onTerminals within the poll', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-live-'));
  const live = path.join(dir, 'sessions');
  const projects = path.join(dir, 'projects');
  fs.mkdirSync(live);
  fs.mkdirSync(projects);
  let map = new Map();
  const seen = [];
  const stop = startLive({ liveDir: live, projectsDir: projects, terminals: () => map, onTerminals: (m) => seen.push([...m.keys()]), onChange: () => {} });
  map = new Map([['s1', [{ pid: 1, status: 'idle', name: 'w1' }]]]);
  fs.writeFileSync(path.join(live, '1.json'), '{}');
  await new Promise((r) => setTimeout(r, 2300));
  map = new Map();
  fs.rmSync(path.join(live, '1.json'));
  await new Promise((r) => setTimeout(r, 2300));
  stop();
  assert.deepEqual(seen, [['s1'], []]);
  fs.rmSync(dir, { recursive: true, force: true });
});
