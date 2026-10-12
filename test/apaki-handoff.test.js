/**
 * The handoff packet at a Claude / Codex switch (apaki/engine/handoff.js), 2026-10-12.
 *
 * Built from the synthetic fixtures the ledger tests read (test-fixtures/switch): the header for each direction, the
 * summary, the recent turns word for word, the other side's tools in plain text (each command once), the code diff,
 * the artifacts, the budget, and the message Claude gets with the handoff in front of the person's words.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HANDOFF_END, HANDOFF_MARK, buildPacket, describeCall, patchFiles, renderTurn, toTurns, withHandoff } from '../apaki/engine/handoff.js';
import { readEvents, stripHandoff } from '../apaki/engine/ledger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE = path.join(ROOT, 'test-fixtures', 'switch', 'claude-session.jsonl');
const CODEX = path.join(ROOT, 'test-fixtures', 'switch', 'codex-rollout.jsonl');
const NOW = new Date(2026, 9, 12, 9, 30);
const DIFF = { ok: true, stat: ' src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)', patch: 'diff --git a/src/a.ts b/src/a.ts\n-const a = foo;\n+import { foo } from \'./foo\';', cut: false, files: 1, commits: '' };

test('handoff: Claude to Codex, the first time: header, summary, every turn word for word, tools as text, code, artifacts', async () => {
  const { events } = await readEvents('claude', CLAUDE);
  const { text, counts } = buildPacket({
    from: 'claude', to: 'codex', events, first: true, n: 1, cwd: 'C:\\proj', title: 'Build fix', diff: DIFF, checkpoint: { ref: 'refs/apaki/handoff/1', base: 'HEAD' },
    artifacts: [{ title: 'Build report', kind: 'markdown', path: 'C:\\art\\report.md' }], delivery: 'inject', ledgerTools: true, now: NOW,
  });
  assert.ok(text.startsWith(`${HANDOFF_MARK} Switch 1, 2026-10-12 09:30: this conversation is moving from Claude Code to you (Codex), in the same folder: C:\\proj.`));
  assert.match(text, /Nothing below is a new request/);
  assert.match(text, /- Conversation: Build fix/);
  assert.match(text, /It started with the user asking: "Make the build pass"/);
  assert.match(text, /Files Claude changed: C:\\proj\\src\\a\.ts, C:\\proj\\src\\foo\.test\.ts/);
  assert.match(text, /Claude's own summary at its last compaction:\n {2}This session is being continued/);
  // Word for word, in order, with the tools in plain text and the failure shown.
  const order = ['### The user (2026-10-12', 'Make the build pass', '(thinking) The build probably fails', '- ran `npm run build`: failed: error TS2304', '- edited C:\\proj\\src\\a.ts', 'Fixed the missing import', '/compact', 'Now add a test for foo', '- wrote C:\\proj\\src\\foo.test.ts', 'I hit my usage limit', 'Carry on with the tests', 'The tests pass.'];
  let at = -1;
  for (const s of order) { const i = text.indexOf(s, at + 1); assert.ok(i > at, `"${s}" in order`); at = i; }
  assert.ok(!text.includes('the record...'), 'an earlier handoff is not handed on again');
  assert.match(text, /## Code changes\nWhat changed on disk since the last commit \(git: HEAD to refs\/apaki\/handoff\/1/);
  assert.match(text, /```diff\ndiff --git a\/src\/a\.ts/);
  assert.match(text, /## Artifacts Claude showed the user\n- Build report \(markdown: C:\\art\\report\.md\)/);
  assert.match(text, /ledger_search finds words in either conversation/);
  assert.match(text, /ledger_skills lists the user's Claude Code skills/);
  assert.ok(text.trimEnd().endsWith('End of the handoff.'));
  assert.equal(counts.prompts, 4);
  assert.equal(counts.verbatim, counts.turns);
});

test('handoff: Codex back to Claude: everything since Claude left, each command once, the patch and the plan', async () => {
  const { events } = await readEvents('codex', CODEX);
  const { text, counts } = buildPacket({ from: 'codex', to: 'claude', events, first: false, n: 2, cwd: 'C:\\proj', diff: DIFF, checkpoint: { ref: 'refs/apaki/handoff/2', prevRef: 'refs/apaki/handoff/1' }, delivery: 'prepend', ledgerTools: true, now: NOW });
  assert.ok(text.startsWith(`${HANDOFF_MARK} Switch 2, 2026-10-12 09:30: this conversation is coming back to you (Claude Code) from Codex, which worked in the same folder: C:\\proj.`));
  assert.match(text, /While you were away the user worked with Codex/);
  assert.match(text, /Run the tests and fix what fails/);
  assert.match(text, /\(thinking\) Looking at the test runner first\./);
  // The command from its item, once; the exec script call is not listed again; the older shell call is.
  assert.equal(text.split('ran `npm test`').length - 1, 1);
  assert.match(text, /- ran `npm test` \(exit 1\)|- ran `npm test`: failed \(exit 1\): 1 failing/);
  assert.match(text, /- changed C:\\proj\\src\\foo\.ts/);
  assert.match(text, /Fixed foo in src\/foo\.ts; all tests pass now\./);
  assert.match(text, /Thanks, now update the README \[with 1 image\]/);
  assert.match(text, /- used apaki show/);
  assert.match(text, /Codex's own summary at its last compaction:\n {2}Summary: foo was fixed/);
  assert.match(text, /git: refs\/apaki\/handoff\/1 to refs\/apaki\/handoff\/2; the full patch is `git diff refs\/apaki\/handoff\/1 refs\/apaki\/handoff\/2`/);
  assert.ok(!/ledger_skills/.test(text), 'Claude has its own skills');
  assert.ok(!text.includes('End of the handoff.'));
  assert.equal(counts.prompts, 2);
});

test('handoff: a small budget keeps the newest turns word for word and older ones as one line each', () => {
  const events = [];
  for (let i = 0; i < 40; i++) {
    events.push({ side: 'claude', kind: 'prompt', text: `Question ${i} ${'q'.repeat(300)}`, at: '2026-10-12T08:00:00.000Z', id: `claude@${i}` });
    events.push({ side: 'claude', kind: 'reply', text: `Answer ${i} ${'a'.repeat(600)}` });
  }
  const { text, counts } = buildPacket({ from: 'claude', to: 'codex', events, first: true, budget: 8000, now: NOW });
  assert.ok(text.length < 8000 + 2000, String(text.length));
  assert.ok(counts.verbatim >= 1 && counts.verbatim < 40);
  assert.match(text, /Answer 39/);
  assert.match(text, /## Earlier turns, in one line each \(\d+ older ones are in the ledger\)/);
  assert.match(text, /- 2026-10-12 \d\d:\d\d the user: "Question 3\d? q+/);
  assert.match(text, /## The most recent turns, word for word/);
  // One giant turn alone: its end is kept.
  const big = [{ side: 'codex', kind: 'prompt', text: 'Go' }, { side: 'codex', kind: 'reply', text: `${'x'.repeat(30000)} THE END` }];
  const one = buildPacket({ from: 'codex', to: 'claude', events: big, budget: 6000, now: NOW });
  assert.match(one.text, /\[\.\.\. the start of this turn is cut\]/);
  assert.match(one.text, /THE END/);
  // Nothing happened on the other side.
  const none = buildPacket({ from: 'codex', to: 'claude', events: [], now: NOW, checkpointNote: 'the folder is not in a git repository' });
  assert.match(none.text, /Nothing new happened in Codex since Claude Code last saw this conversation\./);
  assert.match(none.text, /No code diff: the folder is not in a git repository\./);
});

test('handoff: tool calls in words, for both sides', () => {
  const c = (tool, input) => describeCall({ side: 'claude', tool, input }).text;
  assert.equal(c('Bash', { command: 'npm test' }), 'ran `npm test`');
  assert.equal(c('Read', { file_path: 'a.ts' }), 'read a.ts');
  assert.equal(c('MultiEdit', { file_path: 'a.ts' }), 'edited a.ts');
  assert.equal(c('Grep', { pattern: 'foo', path: 'src' }), 'searched the code for "foo" in src');
  assert.equal(c('Task', { description: 'Find the bug' }), 'ran a subagent: Find the bug');
  assert.equal(c('TodoWrite', { todos: [{ status: 'completed' }, { status: 'pending' }] }), 'updated its checklist (1 of 2 done)');
  assert.equal(c('mcp__figma__get_file', {}), 'used figma get_file');
  assert.equal(c('Mystery', {}), 'used Mystery');
  const x = (tool, input) => describeCall({ side: 'codex', tool, input }).text;
  assert.equal(x('exec', 'text(await tools.exec_command({cmd:"git status --short"}))'), 'ran `git status --short`');
  assert.equal(x('shell', { command: ['bash', '-lc', 'ls'] }), 'ran `ls`');
  assert.equal(x('apply_patch', '*** Begin Patch\n*** Update File: a.ts\n@@\n*** Add File: b.ts\n+x\n*** End Patch'), 'edited a.ts, b.ts (add)');
  assert.deepEqual(patchFiles('*** Delete File: old.ts'), [{ path: 'old.ts', type: 'delete' }]);
  assert.equal(x('collaboration.send_message', {}), 'used collaboration send_message');
  assert.equal(x('web_search', { query: 'ts2304' }), 'searched the web for "ts2304"');
  // A turn without a prompt (the end of one the bookmark cut) still renders.
  const turns = toTurns([{ side: 'codex', kind: 'reply', text: 'Done.' }]);
  assert.equal(turns.length, 1);
  assert.equal(renderTurn(turns[0], 'Codex'), '### Codex\nDone.');
});

test('handoff: the message Claude gets carries the handoff in front of the person\'s own words', () => {
  const s = withHandoff('keep going', `${HANDOFF_MARK} the record`);
  assert.equal(s, `${HANDOFF_MARK} the record\n${HANDOFF_END}\n\nkeep going`);
  assert.equal(stripHandoff(s), 'keep going');
  const blocks = withHandoff([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }, { type: 'text', text: 'look' }], `${HANDOFF_MARK} r`);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[1].text, `${HANDOFF_MARK} r\n${HANDOFF_END}\n\nlook`);
  const onlyImage = withHandoff([{ type: 'image', source: {} }], `${HANDOFF_MARK} r`);
  assert.equal(onlyImage[1].text, `${HANDOFF_MARK} r\n${HANDOFF_END}`);
});
