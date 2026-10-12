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
