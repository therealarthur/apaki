/**
 * SessionRunner.steer: a message added to a running turn goes straight into
 * the prompt stream without a pending entry (the CLI folds it into the turn,
 * which ends with one result), and is refused when no turn is running.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.LATCH_WARM_NO_KEEPER = '1';
const { SessionRunner } = await import('../src/runner.js');

function fakeRunner() {
  const r = new SessionRunner({ sessionId: 's1', cwd: '.', env: {}, canUseTool: async () => ({}), onMessage: () => {} });
  const pushed = [];
  r.inbox = { push: (m) => pushed.push(m) };
  return { r, pushed };
}

test('steer is refused when the process is not running or no turn is waiting', () => {
  const { r, pushed } = fakeRunner();
  assert.equal(r.steer('hi'), false); // no process
  r.q = {}; // a process, but idle
  assert.equal(r.steer('hi'), false);
  assert.equal(pushed.length, 0);
});

test('steer pushes into the running turn without a pending entry and with no priority', () => {
  const { r, pushed } = fakeRunner();
  r.q = {};
  r.pending.push({ resolve() {}, reject() {} });
  assert.equal(r.turnRunning, true);
  assert.equal(r.steer('also use the blue palette'), true);
  assert.equal(r.pending.length, 1);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].message.content, 'also use the blue palette');
  // priority "now" interrupts the turn (measured 2026-10-09); steering must not set it.
  assert.equal(pushed[0].priority, undefined);
});

test('a turn Claude started by itself (no pending send) can be steered until its result', async () => {
  const { r, pushed } = fakeRunner();
  const msgs = [{ type: 'stream_event', event: { type: 'message_start' } }, { type: 'assistant', message: { content: [] } }];
  let release;
  const gate = new Promise((res) => { release = res; });
  // A fake query: streams the start of a turn, waits, then ends it with a result.
  const q = (async function* stream() { for (const m of msgs) yield m; await gate; yield { type: 'result', subtype: 'success' }; }());
  r.q = q;
  const done = r.pump(q);
  await new Promise((res) => setImmediate(res));
  assert.equal(r.pending.length, 0, 'nothing was sent from here');
  assert.equal(r.steer('also check the tests'), true, 'steerable while it runs');
  assert.equal(pushed.length, 1);
  release();
  await done;
  assert.equal(r.steer('too late'), false, 'not after its result');
});
