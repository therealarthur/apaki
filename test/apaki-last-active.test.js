/**
 * The session list's times follow the last real message, not the transcript's modified time
 * (apaki/engine/last-active.js; Arthur, 2026-10-11: "lots of chats have very fresh timestamps").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LastActive, lastActiveOf, lastMessageAt } from '../apaki/engine/last-active.js';

const L = (o) => JSON.stringify(o);

test('last active: the last user or assistant line, past the bookkeeping Claude Code adds on open and close', () => {
  const text = [
    L({ type: 'user', timestamp: '2026-10-07T10:00:00Z', message: { content: 'hi' } }),
    L({ type: 'assistant', timestamp: '2026-10-07T10:01:00Z', message: { content: [] } }),
    L({ type: 'assistant', timestamp: '2026-10-11T09:00:00Z', isSidechain: true, message: { content: [] } }),
    L({ type: 'system', subtype: 'away_summary', timestamp: '2026-10-11T09:30:00Z', content: 'recap' }),
    L({ type: 'cost-state' }), L({ type: 'last-prompt', lastPrompt: 'x' }), '',
  ].join('\n');
  assert.equal(lastMessageAt(text), Date.parse('2026-10-07T10:01:00Z'));
  assert.equal(lastMessageAt(L({ type: 'cost-state' })), null);
  assert.equal(lastMessageAt('{"type":"user","timestamp":"2026-10-0'), null, 'a cut line is skipped');
});

test('last active: reads a larger tail when the first holds no message; caches per file version', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-la-'));
  try {
    const file = path.join(dir, 's.jsonl');
    const noise = L({ type: 'attachment', attachment: { type: 'deferred_tools_record', pad: 'x'.repeat(3000) } });
    fs.writeFileSync(file, [L({ type: 'user', timestamp: '2026-10-01T00:00:00Z', message: { content: 'old' } }), ...Array(60).fill(noise), ''].join('\n'));
    assert.equal(await lastActiveOf(file, fs.statSync(file).size), Date.parse('2026-10-01T00:00:00Z'), 'found past 64 KB of bookkeeping');
    const la = new LastActive();
    const items = [{ id: 'a', lastModified: Date.now() }, { id: 'b', lastModified: 5 }];
    await la.apply(items, new Map([['a', file]]));
    assert.equal(items[0].lastModified, Date.parse('2026-10-01T00:00:00Z'));
    assert.ok(items[0].fileModified > items[0].lastModified, 'the file time is kept aside');
    assert.equal(items[1].lastModified, 5, 'no transcript: unchanged');
    fs.appendFileSync(file, `${L({ type: 'assistant', timestamp: '2026-10-11T12:00:00Z', message: { content: [] } })}\n`);
    assert.equal(await la.lastActive(file), Date.parse('2026-10-11T12:00:00Z'), 'a new message is seen after the file changes');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
