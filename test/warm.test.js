/**
 * Unit tests for keep-warm (src/warm.js): when the keeper pings, waits or
 * stops, and that recorded uses never hold a key. Run with `npm test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-warm-test-'));
process.env.LATCH_DIR = tmp;
process.env.LATCH_WARM_NO_KEEPER = '1';
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const { decide, keyFingerprint, noteUse, projection, readSettings, setOn } = await import('../src/warm.js');

const MIN = 60 * 1000;
const settings = { on: true, hours: 24, dailyCapUsd: 5 };
const t0 = Date.parse('2026-10-09T12:00:00Z');
const use = { sessionId: 's1', lastUseAt: t0 };

test('waits while the cache is fresh, pings before it expires, never pings an expired cache', () => {
  assert.equal(decide({ use, settings, now: t0 + 50 * MIN, spent: 0 }), 'warm');
  assert.equal(decide({ use, settings, now: t0 + 53 * MIN, spent: 0 }), 'ping');
  assert.equal(decide({ use, settings, now: t0 + 59 * MIN, spent: 0 }), 'cold');
});

test('a hit ping restarts the clock; a miss stops the session until its next use', () => {
  const hit = { lastHitAt: t0 + 53 * MIN };
  assert.equal(decide({ use, state: hit, settings, now: t0 + 60 * MIN, spent: 0 }), 'warm');
  assert.equal(decide({ use, state: hit, settings, now: t0 + 106 * MIN, spent: 0 }), 'ping');
  const missed = { missAt: t0 + 53 * MIN };
  assert.equal(decide({ use, state: missed, settings, now: t0 + 106 * MIN, spent: 0 }), 'missed');
  assert.equal(decide({ use: { ...use, lastUseAt: t0 + 60 * MIN }, state: missed, settings, now: t0 + 113 * MIN, spent: 0 }), 'ping');
});

test('stops after the keep window and at the daily cap; waits while the session is busy', () => {
  // Hit pings keep the cache alive, but never past 24 h after the last real message.
  const late = { lastHitAt: t0 + 24 * 60 * MIN };
  assert.equal(decide({ use, state: late, settings, now: t0 + 24 * 60 * MIN + 53 * MIN, spent: 0 }), 'expired');
  assert.equal(decide({ use, settings, now: t0 + 53 * MIN, spent: 5 }), 'capped');
  assert.equal(decide({ use, settings, now: t0 + 53 * MIN, spent: 0, transcriptMtime: t0 + 52.5 * MIN }), 'busy');
  // Busy never runs out the clock: close to expiry it pings anyway.
  assert.equal(decide({ use, settings, now: t0 + 55 * MIN, spent: 0, transcriptMtime: t0 + 54.5 * MIN }), 'ping');
});

test('records uses only when on and billed to a key, and stores a hash, not the key', () => {
  const key = `sk-ant-api03-${'q'.repeat(60)}`;
  assert.equal(noteUse({ sessionId: 'abc', mode: 'sdk', key, cwd: tmp }), false); // off by default
  setOn(true);
  assert.equal(readSettings().on, true);
  assert.equal(noteUse({ sessionId: 'abc', mode: 'sdk', cwd: tmp }), false); // subscription: no key
  assert.equal(noteUse({ sessionId: 'abc', mode: 'sdk', key, cwd: tmp, usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, input_tokens: 2 } }), true);
  const text = fs.readFileSync(path.join(tmp, 'warm', 'use', 'abc.json'), 'utf8');
  assert.equal(text.includes(key), false);
  const saved = JSON.parse(text);
  assert.equal(saved.keyFp, keyFingerprint(key));
  assert.equal(saved.contextTokens, 1202);
});

test('projects what keeping a session warm costs and what a cold reopen would cost', () => {
  const u = { lastUseAt: t0, contextTokens: 500000, options: { model: 'claude-opus-5-5' } };
  // A hit ping that read 500k tokens for $0.10 ($0.20 per million, Opus 5.5's read price).
  const st = { lastHitAt: t0 + 53 * MIN, last: { ok: true, read: 500000, write: 50, cost: 0.1 } };
  const p = projection(u, st, settings, t0 + 54 * MIN);
  assert.equal(p.pingsLeft, Math.floor((24 * 60 - 53) / 52));
  assert.ok(Math.abs(p.coldUsd - 4) < 1e-9); // 500k at $8 per million
  assert.equal(projection(u, {}, settings), null);
});
