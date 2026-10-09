/**
 * Tests for the session picker: filtering and ranking, search inside
 * transcripts, the latest-prompt preview, open-session detection, and the
 * picker itself driven by fake keystrokes on fake streams.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-picker-'));
process.env.CLAUDE_CONFIG_DIR = tmp;
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const { filterItems, findSpoken, lastPrompt, openSessions, pickSession, searchInside, toItems } = await import('../src/picker.js');

const now = Date.now();
const infos = [
  { sessionId: 'aaaa1111-0000-0000-0000-000000000001', summary: 'Walk detector ground truth drafter', firstPrompt: 'find this session', cwd: 'C:\\Users\\A', lastModified: now - 3600e3, fileSize: 500e3 },
  { sessionId: 'bbbb2222-0000-0000-0000-000000000002', summary: 'Hytale arena runs', firstPrompt: 'start the arena', cwd: 'C:\\Users\\A\\Projects\\hytale', lastModified: now - 60e3, fileSize: 2e6 },
  { sessionId: 'cccc3333-0000-0000-0000-000000000003', summary: 'Fresh chat check', firstPrompt: 'ground truth answer key for signalsentry', cwd: 'C:\\Users\\A', lastModified: now - 10e3, fileSize: 6e6 },
];

function writeTranscript(id, lines) {
  const file = path.join(tmp, `${id}.jsonl`);
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}

const files = new Map([
  [infos[0].sessionId, writeTranscript(infos[0].sessionId, [{ type: 'user', message: { content: 'find this session' } }])],
  [infos[1].sessionId, writeTranscript(infos[1].sessionId, [
    { type: 'user', message: { content: 'start the arena' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The Pantex walk data is in the archive.' }] } },
    { type: 'user', message: { content: 'now export the PANTEX walks' } },
    { type: 'user', message: { content: '<command-name>/effort</command-name>' } },
  ])],
  [infos[2].sessionId, writeTranscript(infos[2].sessionId, [{ type: 'user', message: { content: 'ground truth answer key for signalsentry' } }])],
]);

test('filters by every word and ranks title matches first', () => {
  const items = toItems(infos, files, new Map());
  assert.deepEqual(filterItems(items, 'ground truth').map((i) => i.id.slice(0, 4)), ['aaaa', 'cccc']);
  assert.deepEqual(filterItems(items, '').map((i) => i.id.slice(0, 4)), ['cccc', 'bbbb', 'aaaa']);
  assert.deepEqual(filterItems(items, 'hytale').map((i) => i.id.slice(0, 4)), ['bbbb']);
  assert.deepEqual(filterItems(items, 'bbbb2222').map((i) => i.id.slice(0, 4)), ['bbbb']);
  assert.deepEqual(filterItems(items, 'nothing here'), []);
});

test('open-only keeps sessions open in a running process', () => {
  const items = toItems(infos, files, new Map([[infos[0].sessionId, 2]]));
  assert.deepEqual(filterItems(items, '', { openOnly: true }).map((i) => [i.id.slice(0, 4), i.open]), [['aaaa', 2]]);
});

test('searches inside transcripts, any letter case, with a snippet', async () => {
  const items = toItems(infos, files, new Map());
  const hits = new Map();
  await new Promise((done) => searchInside(items, 'pantex walk', { onProgress: () => {}, onHit: (id, s) => hits.set(id, s), onDone: done }));
  assert.deepEqual([...hits.keys()], [infos[1].sessionId]);
  assert.match(hits.get(infos[1].sessionId), /Pantex walk data/);
});

test('search inside counts only what was said, at word starts', () => {
  const lines = (entries) => Buffer.from(`${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const context = lines([
    { parentUuid: null, attachment: { type: 'instructions', text: 'ground truth lives here' }, type: 'attachment' },
    { type: 'user', message: { content: '<system-reminder>ground truth</system-reminder> hello' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep "ground truth"' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ground truth.md' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The background has no truthiness.' }] } },
  ]);
  assert.equal(findSpoken(context, ['ground', 'truth']), null);
  const said = Buffer.concat([context, lines([{ type: 'assistant', message: { content: [{ type: 'text', text: 'The draft ground truth covers 28 walks.' }] } }])]);
  assert.match(findSpoken(said, ['ground', 'truth']), /draft ground truth covers 28 walks/);
  assert.match(findSpoken(said, ['grou']), /ground truth/); // a word start matches as a prefix
});

test('latest prompt skips command records', () => {
  assert.equal(lastPrompt(files.get(infos[1].sessionId)), 'now export the PANTEX walks');
});

test('reads open sessions from live records and ignores dead processes', () => {
  const dir = path.join(tmp, 'live');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 's1' }));
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ pid: 2, sessionId: 's1' }));
  fs.writeFileSync(path.join(dir, '3.json'), JSON.stringify({ pid: 3, sessionId: 's2' }));
  const open = openSessions(dir, (pid) => pid !== 3);
  assert.deepEqual([...open], [['s1', 2]]);
});

/** Runs the picker on fake streams, feeding keys with short pauses. */
async function drive(keys, opts = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 24;
  let screen = '';
  output.on('data', (d) => { screen += d; });
  const picked = pickSession({ input, output, loadInfos: async () => infos, files, open: new Map(), ...opts });
  for (const k of keys) {
    // A number is a pause in ms (for async work such as Ctrl+F to finish).
    await new Promise((r) => setTimeout(r, typeof k === 'number' ? k : 25));
    if (typeof k === 'string') input.write(k);
  }
  return { id: await picked, screen };
}

test('picker: type to filter, arrow down, Enter opens', async () => {
  const { id, screen } = await drive(['g', 'r', 'o', 'u', 'n', 'd', '\x1b[B', '\r']);
  assert.equal(id, infos[2].sessionId);
  assert.match(screen, /2 of 3/);
  assert.match(screen, /Walk detector ground truth drafter/);
});

test('picker: Enter with no search opens the newest session', async () => {
  const { id } = await drive(['\r']);
  assert.equal(id, infos[2].sessionId);
});

test('picker: Ctrl+F finds a word only inside a conversation', async () => {
  const { id, screen } = await drive(['p', 'a', 'n', 't', 'e', 'x', '\x06', 300, '\r']);
  assert.match(screen, /0 of 3/);
  assert.match(screen, /found: /);
  assert.equal(id, infos[1].sessionId);
});

test('picker: Ctrl+C quits with nothing chosen', async () => {
  const { id } = await drive(['\x03']);
  assert.equal(id, null);
});
