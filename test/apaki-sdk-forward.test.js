/**
 * apaki-sdk-forward.test.js: the engine sends windows and phones only the live SDK messages they draw (2026-10-15).
 * pane.js onSdk drops subagent messages and draws only text deltas while streaming; these keep the engine's filter
 * and that consumer in step, so a client never loses something it uses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardToClients } from '../apaki/engine/sdk-forward.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const delta = (type, extra = {}) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type, ...extra } } });

test('text deltas, block starts and stops, whole messages, results and system messages go out', () => {
  assert.equal(forwardToClients(delta('text_delta', { text: 'hi' })), true);
  assert.equal(forwardToClients({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } }), true);
  assert.equal(forwardToClients({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }), true);
  assert.equal(forwardToClients({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } }), true);
  assert.equal(forwardToClients({ type: 'assistant', message: { id: 'm1', content: [] } }), true);
  assert.equal(forwardToClients({ type: 'result', subtype: 'success' }), true);
  assert.equal(forwardToClients({ type: 'system', subtype: 'hook_response', hook_name: 'PreToolUse:Bash' }), true);
  assert.equal(forwardToClients(null), true);
});

test('thinking, signature and tool-input deltas, and any subagent message, stay in the engine', () => {
  assert.equal(forwardToClients(delta('thinking_delta', { thinking: '...' })), false);
  assert.equal(forwardToClients(delta('signature_delta', { signature: 'x' })), false);
  assert.equal(forwardToClients(delta('input_json_delta', { partial_json: '{"a' })), false);
  assert.equal(forwardToClients({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [] } }), false);
  assert.equal(forwardToClients({ type: 'user', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'tool_result', content: 'x'.repeat(100000) }] } }), false);
  assert.equal(forwardToClients({ ...delta('text_delta', { text: 'sub' }), parent_tool_use_id: 'toolu_1' }), false);
});

test('the window still drops exactly what the engine no longer sends, and the engine filters where it forwards', () => {
  const pane = read('apaki', 'ui', 'pane.js');
  const onSdk = pane.slice(pane.indexOf('  onSdk(msg) {'), pane.indexOf("if (msg.type === 'assistant')", pane.indexOf('  onSdk(msg) {')));
  assert.match(onSdk, /if \(msg\.parent_tool_use_id\) return;/);
  assert.match(onSdk, /ev\.delta\?\.type === 'text_delta'/);
  assert.doesNotMatch(onSdk, /thinking_delta|input_json_delta|signature_delta/, 'if the pane starts drawing these, sdk-forward.js must send them');
  assert.match(read('apaki', 'engine', 'engine.js'), /if \(forwardToClients\(msg\)\) emit\(\{ ev: 'sdk', paneId: p\.id, sessionId: p\.sessionId, msg \}\);/);
});
