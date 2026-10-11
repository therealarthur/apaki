/**
 * The context meter before a conversation runs (apaki/engine/context-estimate.js, 2026-10-10 night):
 * the last assistant message's usage, read from the transcript's tail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateEvent, guessWindow, lastUsage, lastUsageIn, windowFor } from '../apaki/engine/context-estimate.js';

const line = (o) => JSON.stringify(o);
const assistant = (usage, model = 'claude-opus-5-5') => line({ type: 'assistant', timestamp: '2026-10-10T23:00:00Z', message: { model, usage } });

test('context estimate: the last assistant usage wins, cut and unrelated lines are skipped', () => {
  const text = [
    '{"type":"assistant","message":{"usage":{"input_tok', // a cut first line of a tail read
    assistant({ input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 5 }),
    line({ type: 'user', message: { content: 'hi' } }),
    assistant({ input_tokens: 3, cache_read_input_tokens: 400000, cache_creation_input_tokens: 2000, output_tokens: 500 }),
    line({ type: 'system', subtype: 'turn_duration' }),
    '',
  ].join('\n');
  assert.deepEqual(lastUsageIn(text), { totalTokens: 402503, model: 'claude-opus-5-5', at: '2026-10-10T23:00:00Z' });
  assert.equal(lastUsageIn(line({ type: 'user', message: { usage: { input_tokens: 9 } } })), null, 'only assistant messages count');
  assert.equal(lastUsageIn(assistant({ input_tokens: 0, output_tokens: 0 })), null, 'an empty usage is not a measurement');
  assert.equal(lastUsageIn(''), null);
});

test('context estimate: window guesses, measured windows, and the event', () => {
  assert.equal(guessWindow('claude-opus-5-5'), 1_000_000);
  assert.equal(guessWindow('claude-sonnet-5-5'), 1_000_000);
  assert.equal(guessWindow('claude-haiku-5-5'), 200_000);
  assert.equal(guessWindow('claude-haiku-5-5[1m]'), 1_000_000);
  assert.equal(guessWindow(null), 200_000);
  const known = new Map([['claude-haiku-5-5', 400_000]]);
  assert.equal(windowFor('claude-haiku-5-5', known), 400_000, 'a measured window beats the guess');
  assert.deepEqual(estimateEvent({ totalTokens: 250_000, model: 'claude-opus-5-5' }, known),
    { percentage: 25, totalTokens: 250_000, maxTokens: 1_000_000, model: 'claude-opus-5-5', estimate: true });
  assert.equal(estimateEvent({ totalTokens: 5_000_000, model: 'claude-opus-5-5' }).percentage, 100, 'capped at 100');
  assert.equal(estimateEvent(null), null);
});

test('context estimate: reads only the end of a file; missing files are null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-ctx-'));
  try {
    const file = path.join(dir, 't.jsonl');
    const filler = line({ type: 'user', message: { content: 'x'.repeat(2000) } });
    fs.writeFileSync(file, [assistant({ input_tokens: 1, output_tokens: 1 }), ...Array(50).fill(filler), assistant({ input_tokens: 7, cache_read_input_tokens: 93, output_tokens: 0 }), ''].join('\n'));
    assert.equal((await lastUsage(file, { tailBytes: 4096 })).totalTokens, 100);
    assert.equal(await lastUsage(path.join(dir, 'none.jsonl')), null);
    assert.equal(await lastUsage(null), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
