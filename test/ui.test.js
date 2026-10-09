/**
 * Tests for the full-screen UI: the picker and the chat screen, rendered with
 * ink-testing-library and driven with simulated keystrokes. The chat runs
 * against a fake SessionRunner that replays SDK-shaped messages, so no Claude
 * Code process or API call is involved.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from 'ink-testing-library';

const { h } = await import('../src/ui/components.js');
const { PickerScreen } = await import('../src/ui/picker.js');
const { Chat, ChatStore } = await import('../src/ui/chat.js');
const { historyItems, matchCommands, summarizeTool, toolArgs, nextMode, tailItems } = await import('../src/ui/model.js');

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const KEY = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', tab: '\t', shiftTab: '\x1b[Z' };

/* ---------- model ---------- */

test('describes tools the way Claude Code does', () => {
  assert.equal(toolArgs('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(toolArgs('Read', { file_path: 'C:\\proj\\src\\a.js' }, 'C:\\proj'), 'src\\a.js');
  assert.equal(toolArgs('Grep', { pattern: 'foo' }), 'pattern: "foo"');
  const edit = summarizeTool('Edit', { file_path: 'a.js', old_string: 'x\ny', new_string: 'z' }, 'ok', false);
  assert.equal(edit.lines[0], 'Updated a.js with 1 addition and 2 removals');
  assert.deepEqual(edit.diff.map((l) => l.sign), ['-', '-', '+']);
  const bash = summarizeTool('Bash', {}, 'a\nb\nc\nd\ne', false);
  assert.deepEqual(bash.lines, ['a', 'b', 'c', '… +2 lines']);
  assert.equal(summarizeTool('Read', {}, '1\n2\n3\n', false).lines[0], 'Read 3 lines');
  assert.equal(summarizeTool('TodoWrite', { todos: [{ content: 'a', status: 'completed' }] }, '', false).todos[0].status, 'completed');
});

test('slash menu ranks prefix matches first and modes cycle like shift+tab', () => {
  const cmds = [{ name: 'compact' }, { name: 'model' }, { name: 'gsd:plan-phase' }, { name: 'plan-multi' }];
  assert.deepEqual(matchCommands(cmds, 'pl').map((c) => c.name), ['plan-multi', 'gsd:plan-phase']);
  assert.equal(nextMode('default'), 'acceptEdits');
  assert.equal(nextMode('bypassPermissions'), 'default');
});

test('builds history items from saved messages, skipping injected context', () => {
  const msgs = [
    { type: 'user', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
    { type: 'user', message: { role: 'user', content: 'fix the test' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'all good' }] } },
    { type: 'assistant', parent_tool_use_id: 't9', message: { content: [{ type: 'text', text: 'subagent noise' }] } },
  ];
  const items = historyItems(msgs);
  assert.deepEqual(items.map((i) => i.kind), ['user', 'assistant', 'tool']);
  assert.deepEqual(items[2].lines, ['all good']);
  assert.equal(tailItems([...items, { kind: 'user', text: 'b' }], 1).hidden, 3);
});

/* ---------- picker ---------- */

function fakeLoader() {
  const now = Date.now();
  const items = [
    { id: 'aaaa1111', title: 'Walk detector ground truth drafter', firstPrompt: 'build the drafter', cwd: 'C:\\Users\\Arthur', branch: '', lastModified: now - 60000, size: 2e6, file: null, open: 1 },
    { id: 'bbbb2222', title: 'Toggleable claude -p message routing', firstPrompt: 'relay hook', cwd: 'C:\\Users\\Arthur', branch: 'main', lastModified: now - 120000, size: 5e5, file: null, open: 0 },
  ].map((it) => ({ ...it, titleLower: it.title.toLowerCase(), hay: [it.id, it.title, it.firstPrompt, it.cwd, it.branch].join(' ').toLowerCase() }));
  return async () => items;
}

test('picker filters as you type and opens the selected session', async () => {
  let picked = null;
  const ui = render(h`<${PickerScreen} loader=${fakeLoader()} billing="billing: test" onPick=${(it) => { picked = it; }} onQuit=${() => {}} />`);
  await tick(60);
  let frame = plain(ui.lastFrame());
  assert.match(frame, /Resume a conversation/);
  assert.match(frame, /Walk detector ground truth drafter/);
  assert.match(frame, /open in 1 window/);
  for (const ch of 'relay') { ui.stdin.write(ch); await tick(5); }
  await tick(30);
  frame = plain(ui.lastFrame());
  assert.doesNotMatch(frame, /Walk detector/);
  assert.match(frame, /❯ Toggleable claude -p message routing/);
  ui.stdin.write(KEY.enter);
  await tick(20);
  assert.equal(picked?.id, 'bbbb2222');
  ui.unmount();
});

/* ---------- chat ---------- */

function fakeRunner(script) {
  return {
    sessionId: null,
    cwd: 'C:\\proj',
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    permissionMode: 'bypassPermissions',
    transcript: null,
    onMessage: () => {},
    canUseTool: null,
    sent: [],
    start() {},
    async send(text) {
      this.sent.push(text);
      for (const step of script(text)) {
        if (step.wait) await tick(step.wait);
        else if (step.permission) await this.canUseTool(step.permission.name, step.permission.input, {});
        else this.onMessage(step);
      }
      const result = { type: 'result', subtype: 'success', duration_ms: 1200, latchTurnCost: 0.012 };
      this.onMessage(result);
      return result;
    },
    async interrupt() {},
    async setModel(m) { this.model = m; },
    async setPermissionMode(m) { this.permissionMode = m; },
    async restart(c) { Object.assign(this, c); },
    async stop() {},
    async supportedCommands() { return [{ name: 'compact', description: 'Clear conversation history but keep a summary' }, { name: 'gsd:quick', description: 'Execute a quick task' }]; },
    async supportedModels() { return []; },
    async supportedAgents() { return []; },
    async mcpServerStatus() { return [{ name: 'context7', status: 'connected' }]; },
  };
}

const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });

test('chat streams a reply, shows tool lines with results and a diff, and the footer', async () => {
  const runner = fakeRunner(() => [
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
    delta('Running the **tests**'),
    { wait: 20 },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Running the **tests**' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '12 passing' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'C:\\proj\\a.js', old_string: 'old line', new_string: 'new line' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
  ]);
  const store = new ChatStore({ runner, info: { credentialName: 'Claude Myrlin.io', keys: [], switchKey: () => ({}) }, onResume: () => {}, onExit: () => {} });
  const ui = render(h`<${Chat} store=${store} />`);
  await tick(60);
  let frame = plain(ui.lastFrame());
  assert.match(frame, /✻ latch/);
  assert.match(frame, /⏵⏵ bypass permissions on/);
  assert.match(frame, /Opus 5\.5 · xhigh · Claude Myrlin\.io/);
  for (const ch of 'run the tests') { ui.stdin.write(ch); await tick(2); }
  ui.stdin.write(KEY.enter);
  await tick(200);
  frame = plain(ui.frames.join('\n'));
  assert.match(frame, /> run the tests/);
  assert.match(frame, /⏺ Running the tests/);
  assert.match(frame, /⏺ Bash\(npm test\)/);
  assert.match(frame, /⎿ {2}12 passing/);
  assert.match(frame, /Updated a\.js with 1 addition and 1 removal/);
  assert.match(frame, /- old line/);
  assert.match(frame, /\+ new line/);
  assert.match(frame, /✻ Worked for 1s · \$0\.012 · Claude Myrlin\.io/);
  assert.deepEqual(runner.sent, ['run the tests']);
  ui.unmount();
});

test('slash menu lists latch and Claude Code commands; shift+tab cycles the mode', async () => {
  const runner = fakeRunner(() => []);
  const store = new ChatStore({ runner, info: { credentialName: 'k', keys: [], switchKey: () => ({}) }, onResume: () => {}, onExit: () => {} });
  const ui = render(h`<${Chat} store=${store} />`);
  await tick(60);
  ui.stdin.write('/');
  await tick(30);
  let frame = plain(ui.lastFrame());
  assert.match(frame, /\/clear +Clear conversation history/);
  ui.stdin.write('com');
  await tick(30);
  assert.match(plain(ui.lastFrame()), /\/compact +Clear conversation history but keep a summary/);
  for (let i = 0; i < 3; i++) { ui.stdin.write('\x7f'); await tick(5); }
  ui.stdin.write('gsd');
  await tick(30);
  frame = plain(ui.lastFrame());
  assert.match(frame, /\/gsd:quick/);
  ui.stdin.write(KEY.enter);
  await tick(60);
  assert.deepEqual(runner.sent, ['/gsd:quick'], 'Claude Code commands go to the SDK');
  ui.stdin.write(KEY.shiftTab);
  await tick(30);
  assert.equal(store.state.mode, 'default');
  ui.stdin.write(KEY.shiftTab);
  await tick(30);
  assert.equal(runner.permissionMode, 'acceptEdits');
  assert.match(plain(ui.lastFrame()), /⏵⏵ accept edits on/);
  ui.unmount();
});

test('permission and question dialogs answer the SDK callback', async () => {
  let answer = null;
  const runner = fakeRunner(() => [{ permission: { name: 'Bash', input: { command: 'rm -rf build' } } }]);
  const store = new ChatStore({ runner, info: { credentialName: 'k', keys: [], switchKey: () => ({}) }, onResume: () => {}, onExit: () => {} });
  const ui = render(h`<${Chat} store=${store} />`);
  await tick(60);
  const original = store.canUseTool.bind(store);
  runner.canUseTool = async (...a) => { answer = await original(...a); return answer; };
  ui.stdin.write('clean');
  ui.stdin.write(KEY.enter);
  await tick(80);
  let frame = plain(ui.lastFrame());
  assert.match(frame, /Bash command/);
  assert.match(frame, /rm -rf build/);
  assert.match(frame, /Do you want to proceed\?/);
  ui.stdin.write('1');
  await tick(60);
  assert.equal(answer.behavior, 'allow');

  const q = store.interactive('AskUserQuestion', { questions: [{ question: 'Tea or coffee?', header: 'Drink', options: [{ label: 'Tea' }, { label: 'Coffee' }] }] });
  await tick(40);
  frame = plain(ui.lastFrame());
  assert.match(frame, /Tea or coffee\?/);
  assert.match(frame, /❯ 1\. Tea/);
  ui.stdin.write(KEY.down);
  await tick(20);
  ui.stdin.write(KEY.enter);
  const res = await q;
  assert.equal(res.updatedInput.answers['Tea or coffee?'], 'Coffee');
  ui.unmount();
});

test('built-in /status and /mcp are answered locally', async () => {
  const runner = fakeRunner(() => []);
  const store = new ChatStore({ runner, info: { credentialName: 'Claude Myrlin.io', keys: [], switchKey: () => ({}) }, onResume: () => {}, onExit: () => {} });
  const ui = render(h`<${Chat} store=${store} />`);
  await tick(60);
  ui.stdin.write('/status ');
  await tick(10);
  ui.stdin.write(KEY.enter);
  await tick(60);
  ui.stdin.write('/mcp ');
  await tick(10);
  ui.stdin.write(KEY.enter);
  await tick(60);
  const frame = plain(ui.frames.join('\n'));
  assert.match(frame, /Billing {6}Claude Myrlin\.io/);
  assert.match(frame, /✔ context7/);
  assert.deepEqual(runner.sent, [], 'nothing went to Claude Code');
  ui.unmount();
});
