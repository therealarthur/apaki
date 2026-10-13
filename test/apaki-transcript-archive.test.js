/**
 * The slim transcript archive (apaki/engine/transcript-archive.js, 2026-10-12): every conversation kept past
 * Claude Code's 30-day cleanup, images out, everything else whole, only what changed copied again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { archiveTranscripts, slimLine } from '../apaki/engine/transcript-archive.js';

test('archive: images out, text and tool calls whole; non-JSON lines unchanged', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(5000) } };
  const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'look' }, img, { type: 'tool_result', content: [img, { type: 'text', text: 'out' }] }] } });
  const j = JSON.parse(slimLine(line));
  assert.equal(j.message.content[0].text, 'look');
  assert.match(j.message.content[1].source.data, /kept out/);
  assert.equal(j.message.content[1].source.archivedBytes, 5000);
  assert.match(j.message.content[2].content[0].source.data, /kept out/);
  assert.equal(j.message.content[2].content[1].text, 'out');
  const plain = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  assert.equal(slimLine(plain), plain);
  assert.equal(slimLine('not json "image" "data"'), 'not json "image" "data"');
});

test('archive: copies every transcript (subagents too), gzips it, and only what changed on the next run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-arch-'));
  try {
    const from = path.join(dir, 'projects');
    const root = path.join(dir, 'archive');
    fs.mkdirSync(path.join(from, 'C--x', 'sess-1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(from, 'C--x', 'sess-1.jsonl'), '{"type":"user","message":{"content":"one"}}\n');
    fs.writeFileSync(path.join(from, 'C--x', 'sess-1', 'subagents', 'agent-a.jsonl'), '{"type":"assistant"}\n');
    let r = await archiveTranscripts({ from, root });
    assert.equal(r.copied, 2);
    const gz = path.join(root, 'claude', 'C--x', 'sess-1.jsonl.gz');
    assert.equal(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8'), '{"type":"user","message":{"content":"one"}}\n');
    r = await archiveTranscripts({ from, root });
    assert.deepEqual([r.copied, r.skipped], [0, 2], 'nothing changed, nothing copied');
    fs.appendFileSync(path.join(from, 'C--x', 'sess-1.jsonl'), '{"type":"assistant","message":{"content":[]}}\n');
    r = await archiveTranscripts({ from, root });
    assert.deepEqual([r.copied, r.skipped], [1, 1], 'the grown transcript is copied again');
    fs.rmSync(path.join(from, 'C--x', 'sess-1.jsonl'));
    r = await archiveTranscripts({ from, root });
    assert.ok(fs.existsSync(gz), 'a transcript Claude Code deleted stays in the archive');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

import { archivedMeta, archivedSessions, openArchived, restoreArchived } from '../apaki/engine/transcript-archive.js';

test('archive: a conversation Claude Code deleted is listed, read from the archive, and restored where it was', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-arch2-'));
  try {
    const from = path.join(dir, 'projects');
    const root = path.join(dir, 'archive');
    const cache = path.join(dir, 'open');
    const id = '0e7f4b4e-aaaa-4bbb-8ccc-000000000a01';
    fs.mkdirSync(path.join(from, 'C--proj'), { recursive: true });
    const live = path.join(from, 'C--proj', `${id}.jsonl`);
    fs.writeFileSync(live, [
      JSON.stringify({ type: 'user', cwd: 'C:\proj', sessionId: id, timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'plan the release' } }),
      JSON.stringify({ type: 'assistant', sessionId: id, timestamp: '2026-09-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Release plan', sessionId: id }),
      '',
    ].join('\n'));
    await archiveTranscripts({ from, root });
    fs.rmSync(live); // Claude Code's 30-day cleanup
    assert.deepEqual([...archivedSessions(root).keys()], [id]);
    const meta = archivedMeta(id, { root });
    assert.deepEqual({ title: meta.title, cwd: meta.cwd, firstPrompt: meta.firstPrompt, lastActive: meta.lastActive }, { title: 'Release plan', cwd: 'C:\proj', firstPrompt: 'plan the release', lastActive: Date.parse('2026-09-01T10:01:00Z') });
    const readable = openArchived(id, { root, cache });
    assert.match(fs.readFileSync(readable, 'utf8'), /plan the release/);
    const back = restoreArchived(id, { root, to: from });
    assert.equal(back, live, 'restored to the same place');
    assert.match(fs.readFileSync(live, 'utf8'), /Release plan/);
    assert.equal(restoreArchived(id, { root, to: from }), live, 'never overwrites a live transcript');
    assert.equal(openArchived('nope', { root, cache }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('archive: the manifest is parsed once per version of the file, however many conversations the list asks about (found on a Mac with 1,742 archived-only conversations)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-arch3-'));
  try {
    const root = path.join(dir, 'archive');
    fs.mkdirSync(root, { recursive: true });
    // A manifest of 3,000 conversations, each with its meta already kept, as an archive that has been listed before.
    const files = {};
    for (let i = 0; i < 3000; i++) files[`proj/id-${i}.jsonl`] = { size: 1, mtimeMs: 1, gz: 1, meta: { title: `t${i}`, cwd: '/x', firstPrompt: '', lastActive: i } };
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ v: 1, files }));
    const realParse = JSON.parse;
    let parses = 0;
    JSON.parse = (...a) => { if (typeof a[0] === 'string' && a[0].length > 100000) parses += 1; return realParse(...a); };
    try {
      for (let i = 0; i < 3000; i++) assert.equal(archivedMeta(`id-${i}`, { root }).title, `t${i}`);
      assert.equal(parses, 1, 'one parse of the big manifest for 3,000 asks');
      assert.equal(archivedSessions(root).size, 3000);
      assert.equal(parses, 1);
      // The file changes (another run archived something): the next ask parses again and sees it.
      files['proj/id-new.jsonl'] = { size: 2, mtimeMs: 2, gz: 1, meta: { title: 'new', cwd: '', firstPrompt: '', lastActive: 1 } };
      fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ v: 1, files }));
      assert.equal(archivedMeta('id-new', { root }).title, 'new');
      assert.equal(parses, 2);
    } finally { JSON.parse = realParse; }
    // What archivedSessions hands out is the caller's own copy.
    const a = archivedSessions(root);
    a.clear();
    assert.equal(archivedSessions(root).size, 3001);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});