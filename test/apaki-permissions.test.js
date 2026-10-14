/**
 * Permission prompts (apaki/engine/permissions.js, apaki/ui/permission.js), 2026-10-12.
 *
 * Arthur: in "Ask permissions" and "Auto-accept edits" a tool Claude Code would normally ask about just ran,
 * because the engine's canUseTool allowed everything. It now holds the call and asks the pane's window (or phone)
 * with the question machinery: state.asks, the ask event, the answer op, ask_gone.
 *
 * Unit: the SDK's suggestions cleaned and described, the result for each reply (allow once, always allow passes the
 * suggestions as updatedPermissions, deny with a note, a reply that cannot be read denies), the gate (the event, answered
 * once, a cancelled call, a turn that ended, tools with their own sheets), a phone within its access (the capability
 * check first, rules saved only by a full phone, the answer op's fields), and the sheet's content and keys.
 *
 * End to end: the real engine.js in host mode in a temp world with a fake Agent SDK that calls the permission callback the
 * way Claude Code does (no Claude Code process, nothing billed; same approach as test/apaki-queue.test.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  OWN_TOOLS, PASS_THROUGH_TOOLS, REJECT_TEXT, WITHDRAWN_TEXT, cleanNote, cleanSuggestions, createPermissionGate, denyText, describeSuggestion,
  INPUT_CUT_CHARS, permissionPayload, permissionResult, ruleText, slimInput,
} from '../apaki/engine/permissions.js';
import { capCanUseTool, checkPhoneCommand, routeEvent } from '../apaki/engine/remote-policy.js';
import { ARM_MS, denyLabel, mcpParts, permissionChoices, permissionHtml, permissionKey, permissionReply, permissionView } from '../apaki/ui/permission.js';
import { connectHost, readHostInfo } from '../apaki/engine/host.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'apaki', 'engine', 'engine.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-perm-test-'));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } };

async function until(fn, ms = 10000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(step);
  }
}

const RULE = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' };
const MODE = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };

/* the SDK's suggestions */

test('cleanSuggestions keeps only well-formed PermissionUpdates, as copies', () => {
  const dirs = { type: 'addDirectories', directories: ['C:\\work\\other'], destination: 'projectSettings' };
  const out = cleanSuggestions([RULE, MODE, dirs,
    null, 'x', { type: 'addRules', rules: [], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: '' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'elsewhere' },
    { type: 'runCode', destination: 'session' },
    { type: 'setMode', destination: 'session' },
    { type: 'addDirectories', directories: [], destination: 'session' }]);
  assert.deepEqual(out, [RULE, MODE, dirs]);
  assert.notEqual(out[0], RULE, 'a copy, not the SDK object');
  assert.notEqual(out[0].rules[0], RULE.rules[0]);
  assert.deepEqual(cleanSuggestions(undefined), []);
  assert.deepEqual(cleanSuggestions('no'), []);
});

test('describeSuggestion says what Always allow would save, in words', () => {
  assert.equal(ruleText({ toolName: 'Bash', ruleContent: 'npm test:*' }), 'Bash(npm test:*)');
  assert.equal(ruleText({ toolName: 'WebFetch' }), 'WebFetch');
  assert.equal(describeSuggestion(RULE), 'Allow Bash(npm test:*) for this project, kept on this PC');
  assert.equal(describeSuggestion(MODE), 'Switch to Auto-accept edits for this session only');
  assert.equal(describeSuggestion({ ...RULE, destination: 'userSettings' }), 'Allow Bash(npm test:*) for every project');
  assert.equal(describeSuggestion({ ...RULE, destination: 'projectSettings' }), 'Allow Bash(npm test:*) for this project, shared in .claude/settings.json');
  assert.equal(describeSuggestion({ type: 'addDirectories', directories: ['D:\\a', 'D:\\b'], destination: 'localSettings' }), 'Allow access to D:\\a, D:\\b for this project, kept on this PC');
});

test('permissionPayload: the SDK\'s words for the sheet, and whether Always allow is offered', () => {
  const opts = { title: 'Claude wants to run npm test', displayName: 'Run command', description: 'Runs the unit tests', decisionReason: 'Not on your allow list', blockedPath: 'D:\\x', toolUseID: 'toolu_1', agentID: 'a1', suggestions: [RULE], mcpServer: { name: 'gh', source: 'user' } };
  const p = permissionPayload(opts);
  assert.equal(p.title, opts.title);
  assert.equal(p.toolUseId, 'toolu_1');
  assert.deepEqual(p.always, { lines: ['Allow Bash(npm test:*) for this project, kept on this PC'] });
  assert.deepEqual(p.mcpServer, { name: 'gh', source: 'user' });
  assert.equal(p.defaultToNo, false);
  // Not offered: nothing suggested, the SDK said not to, or this pane may not save rules.
  assert.equal(permissionPayload({}).always, null);
  assert.equal(permissionPayload({ ...opts, suppressAlwaysAllowRule: true }).always, null);
  assert.equal(permissionPayload(opts, { alwaysOk: false }).always, null);
  assert.equal(permissionPayload({ ...opts, defaultToNo: true }).defaultToNo, true);
  assert.equal(permissionPayload({}, { cut: true }).cut, true);
});

test('slimInput cuts long strings for the event and says so; the original is untouched', () => {
  const big = 'x'.repeat(INPUT_CUT_CHARS + 500);
  const input = { file_path: 'a.txt', content: big, edits: Array.from({ length: 60 }, (_, i) => ({ old_string: `o${i}`, new_string: big })) };
  const { input: shown, cut } = slimInput(input);
  assert.equal(cut, true);
  assert.equal(shown.content.length, INPUT_CUT_CHARS);
  assert.equal(shown.edits.length, 40);
  assert.equal(shown.edits[0].new_string.length, INPUT_CUT_CHARS);
  assert.equal(input.content.length, big.length);
  assert.deepEqual(slimInput({ command: 'ls' }), { input: { command: 'ls' }, cut: false });
  assert.deepEqual(slimInput(null), { input: {}, cut: false });
});

/* what each reply becomes */

test('permissionResult: allow once sends the call\'s own input and no rules', () => {
  const input = { command: 'npm test' };
  const r = permissionResult({ behavior: 'allow', updatedInput: { command: 'rm -rf /' }, updatedPermissions: [{ type: 'addRules' }] }, { input, suggestions: [RULE], toolUseId: 'toolu_1' });
  assert.deepEqual(r, { behavior: 'allow', updatedInput: input, toolUseID: 'toolu_1', decisionClassification: 'user_temporary' });
});

test('permissionResult: always allow passes the SDK\'s suggestions as updatedPermissions', () => {
  const input = { command: 'npm test' };
  const sug = [RULE, MODE];
  const r = permissionResult({ behavior: 'allow', always: true }, { input, suggestions: sug });
  assert.deepEqual(r.updatedPermissions, [RULE, MODE]);
  assert.notEqual(r.updatedPermissions[0], sug[0], 'copies');
  assert.equal(r.decisionClassification, 'user_permanent');
  assert.equal(r.updatedInput, input);
  // A reply cannot bring rules of its own.
  const own = permissionResult({ behavior: 'allow', always: true, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' }] }, { input, suggestions: sug });
  assert.deepEqual(own.updatedPermissions, [RULE, MODE]);
  // Nothing suggested, or this pane may not save rules: the always is an allow once.
  assert.equal('updatedPermissions' in permissionResult({ behavior: 'allow', always: true }, { input, suggestions: [] }), false);
  const once = permissionResult({ behavior: 'allow', always: true }, { input, suggestions: sug, alwaysOk: false });
  assert.equal('updatedPermissions' in once, false);
  assert.equal(once.decisionClassification, 'user_temporary');
  // Only a real true counts.
  assert.equal('updatedPermissions' in permissionResult({ behavior: 'allow', always: 'yes' }, { input, suggestions: sug }), false);
});

test('permissionResult: deny carries the note as Claude\'s message; a reply that cannot be read denies', () => {
  const r = permissionResult({ behavior: 'deny', message: '  use pnpm instead  ' }, { input: {} });
  assert.equal(r.behavior, 'deny');
  assert.equal(r.decisionClassification, 'user_reject');
  assert.ok(r.message.includes('use pnpm instead'));
  assert.ok(r.message.startsWith("The user doesn't want to proceed with this tool use."));
  assert.equal(permissionResult({ behavior: 'deny' }, { input: {} }).message, REJECT_TEXT);
  assert.equal(permissionResult({ behavior: 'deny', message: '   ' }, { input: {} }).message, REJECT_TEXT);
  for (const junk of [null, undefined, 'allow', 7, {}, { behavior: 'maybe' }, [{ behavior: 'allow' }]]) {
    const d = permissionResult(junk, { input: {}, suggestions: [RULE] });
    assert.equal(d.behavior, 'deny', JSON.stringify(junk));
    assert.equal(d.message, WITHDRAWN_TEXT);
  }
  assert.equal(cleanNote('x'.repeat(5000)).length, 2000);
  assert.equal(cleanNote(42), '');
  assert.ok(!denyText('').includes('said'));
});

/* the gate */

/** A gate on a Map and a list of events, with ids ask-1, ask-2... */
function gateOf(o = {}) {
  const asks = new Map();
  const events = [];
  let n = 0;
  const gate = createPermissionGate({ paneId: o.paneId || 'p1', asks, emit: (ev) => events.push(ev), newId: () => `ask-${++n}`, alwaysOk: o.alwaysOk, now: o.now });
  return { gate, asks, events };
}

test('gate: holds the call, sends an ask with the tool, its input and the sheet\'s words; allow once settles it', async () => {
  const { gate, asks, events } = gateOf();
  let state = 'pending';
  const call = gate('Bash', { command: 'npm test', description: 'Run the tests' }, { toolUseID: 'toolu_1', title: 'Claude wants to run npm test', suggestions: [RULE], signal: new AbortController().signal }).then((r) => { state = 'settled'; return r; });
  await sleep(20);
  assert.equal(state, 'pending', 'the call waits for a person');
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.deepEqual([ev.ev, ev.askId, ev.paneId, ev.toolName], ['ask', 'ask-1', 'p1', 'Bash']);
  assert.deepEqual(ev.input, { command: 'npm test', description: 'Run the tests' });
  assert.equal(ev.permission.title, 'Claude wants to run npm test');
  assert.deepEqual(ev.permission.always, { lines: ['Allow Bash(npm test:*) for this project, kept on this PC'] });
  const a = asks.get('ask-1');
  assert.equal(a.kind, 'permission');
  assert.equal(a.paneId, 'p1');
  assert.ok(a.at > 0);
  a.answer({ behavior: 'allow' });
  const r = await call;
  assert.deepEqual(r, { behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run the tests' }, toolUseID: 'toolu_1', decisionClassification: 'user_temporary' });
  assert.equal(asks.size, 0, 'settled: gone from the engine\'s list');
});

test('gate: always allow, and deny with a note', async () => {
  const { gate, asks } = gateOf();
  const c1 = gate('Bash', { command: 'npm test' }, { suggestions: [RULE, MODE] });
  asks.get('ask-1').answer({ behavior: 'allow', always: true });
  const r1 = await c1;
  assert.deepEqual(r1.updatedPermissions, [RULE, MODE]);
  const c2 = gate('Edit', { file_path: 'a.js', old_string: 'a', new_string: 'b' }, {});
  asks.get('ask-2').answer({ behavior: 'deny', message: 'edit b.js instead' });
  const r2 = await c2;
  assert.equal(r2.behavior, 'deny');
  assert.ok(r2.message.endsWith('edit b.js instead'));
});

test('gate: answered once; a second answer changes nothing', async () => {
  const { gate, asks } = gateOf();
  const call = gate('Bash', { command: 'ls' }, {});
  const a = asks.get('ask-1');
  a.answer({ behavior: 'allow' });
  a.answer({ behavior: 'deny', message: 'too late' });
  a.resolve({ behavior: 'deny', message: 'engine too late' });
  assert.equal((await call).behavior, 'allow');
  assert.equal(asks.size, 0);
});

test('gate: a call Claude Code cancelled drops its sheet (ask_gone) and is refused; one already cancelled never asks', async () => {
  const { gate, asks, events } = gateOf();
  const ac = new AbortController();
  const call = gate('Bash', { command: 'sleep 99' }, { signal: ac.signal });
  assert.equal(asks.size, 1);
  ac.abort();
  const r = await call;
  assert.equal(r.behavior, 'deny');
  assert.equal(asks.size, 0);
  assert.deepEqual(events.map((e) => e.ev), ['ask', 'ask_gone']);
  assert.deepEqual([events[1].askId, events[1].paneId], ['ask-1', 'p1']);
  // Why it went, so the pane's card can leave its one line (askcard.js goneNote, 2026-10-12).
  assert.equal(events[1].why, 'cancelled');
  // A late answer to the sheet that went away does nothing.
  const done = new AbortController();
  done.abort();
  const before = events.length;
  assert.equal((await gate('Bash', { command: 'x' }, { signal: done.signal })).behavior, 'deny');
  assert.equal(events.length, before, 'no ask for a call that is already over');
  // An answered call ignores a later abort.
  const ac2 = new AbortController();
  const c2 = gate('Bash', { command: 'y' }, { signal: ac2.signal });
  asks.get('ask-2').answer({ behavior: 'allow' });
  await c2;
  ac2.abort();
  assert.equal(events.filter((e) => e.ev === 'ask_gone').length, 1);
});

test('gate: the engine settling a call (the turn ended, the pane closed) is a denial with its own words', async () => {
  const { gate, asks } = gateOf();
  const c1 = gate('Bash', { command: 'a' }, { toolUseID: 'toolu_9' });
  asks.get('ask-1').resolve(null);
  assert.deepEqual(await c1, { behavior: 'deny', message: WITHDRAWN_TEXT, toolUseID: 'toolu_9' });
  const c2 = gate('Bash', { command: 'b' }, {});
  asks.get('ask-2').resolve({ behavior: 'deny', message: 'The pane was closed.' });
  assert.deepEqual(await c2, { behavior: 'deny', message: 'The pane was closed.' });
  // The engine can only refuse: an allow from it is a refusal too.
  const c3 = gate('Bash', { command: 'c' }, {});
  asks.get('ask-3').resolve({ behavior: 'allow' });
  assert.equal((await c3).behavior, 'deny');
});

test('gate: tools with their own sheets are allowed here as before; a long input is cut in the event, not in the run', async () => {
  const { gate, asks, events } = gateOf();
  assert.deepEqual(PASS_THROUGH_TOOLS, ['AskUserQuestion', 'ExitPlanMode']);
  for (const name of PASS_THROUGH_TOOLS) assert.deepEqual(await gate(name, { x: 1 }, {}), { behavior: 'allow', updatedInput: { x: 1 } });
  assert.equal(events.length, 0);
  // Apaki's own show tool, from its own in-process server only (a user's MCP server named apaki is asked about like any other).
  // view_read (2026-10-13) only reads Apaki's own store: no prompt either.
  assert.deepEqual(OWN_TOOLS, ['mcp__apaki__show', 'mcp__apaki__view_read']);
  assert.deepEqual(await gate('mcp__apaki__show', { kind: 'html' }, { mcpServer: { name: 'apaki', source: 'sdk' } }), { behavior: 'allow', updatedInput: { kind: 'html' } });
  assert.equal(events.length, 0);
  const spoof = gate('mcp__apaki__show', { kind: 'html' }, { mcpServer: { name: 'apaki', source: 'user' } });
  const noInfo = gate('mcp__apaki__show', { kind: 'html' }, {});
  const browser = gate('mcp__apaki__browser_click', { ref: 3 }, { mcpServer: { name: 'apaki', source: 'sdk' } });
  assert.equal(events.length, 3, 'a look-alike, a call with no server information and the browser tools are asked about');
  for (const id of asks.keys()) asks.get(id).answer({ behavior: 'deny' });
  await Promise.all([spoof, noInfo, browser]);
  events.length = 0;
  const big = 'y'.repeat(INPUT_CUT_CHARS + 10);
  const call = gate('Write', { file_path: 'a.txt', content: big }, {});
  assert.equal(events[0].input.content.length, INPUT_CUT_CHARS);
  assert.equal(events[0].permission.cut, true);
  asks.get(events[0].askId).answer({ behavior: 'allow' });
  assert.equal((await call).updatedInput.content.length, big.length, 'the tool runs with the whole of it');
});

/* a phone, within its access */

const DEV = 'A'.repeat(22);
const OTHER = 'B'.repeat(22);
const PHONE_PANE = `phone:${DEV}:p1`;

test('phone: a restricted phone\'s blocked tools are refused before anyone is asked; the rest ask the phone', async () => {
  const { gate, asks, events } = gateOf({ paneId: PHONE_PANE });
  let cap = 'noshell';
  const canUse = capCanUseTool(() => cap, gate);
  const refused = await canUse('Bash', { command: 'dir' }, {});
  assert.equal(refused.behavior, 'deny');
  assert.equal(events.length, 0, 'no sheet on the phone for what its access does not allow');
  assert.equal((await canUse('mcp__someone__exec', {}, {})).behavior, 'deny');
  assert.equal(asks.size, 0);
  // Read passes the capability check, so the phone is asked (and the event is about the phone's own pane).
  const call = canUse('Read', { file_path: 'D:\\notes.txt' }, { blockedPath: 'D:\\notes.txt' });
  assert.equal(events.length, 1);
  assert.equal(routeEvent(events[0]).deviceId, DEV, 'it goes to that phone only');
  asks.get('ask-1').answer({ behavior: 'allow' });
  assert.equal((await call).behavior, 'allow');
  // A chat-only phone cannot carry out a plan, before or after this change.
  cap = 'chat';
  assert.equal((await canUse('ExitPlanMode', {}, {})).behavior, 'deny');
});

test('phone: only a full phone may save a rule; a restricted phone\'s always allow is an allow once, and its sheet has no such button', async () => {
  for (const [cap, saves] of [['full', true], ['noshell', false], ['chat', false]]) {
    const { gate, asks, events } = gateOf({ paneId: PHONE_PANE, alwaysOk: () => cap === 'full' });
    const canUse = capCanUseTool(() => cap, gate);
    const call = canUse('WebFetch', { url: 'https://example.com', prompt: 'summarize' }, { suggestions: [{ type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'localSettings' }] });
    assert.equal(Boolean(events[0].permission.always), saves, `${cap}: Always allow offered`);
    asks.get('ask-1').answer({ behavior: 'allow', always: true });
    const r = await call;
    assert.equal(r.behavior, 'allow', cap);
    assert.equal(Boolean(r.updatedPermissions), saves, `${cap}: rule saved`);
  }
});

test('phone: the answer op carries the yes or no and always, only for the phone\'s own pane, and never rules or a new input', () => {
  const own = new Map([['ask-1', PHONE_PANE], ['ask-2', `phone:${OTHER}:p1`], ['ask-3', 'p1']]);
  const ctx = { deviceId: DEV, askPane: (id) => own.get(id) ?? null };
  const ok = checkPhoneCommand({ op: 'answer', askId: 'ask-1', result: { behavior: 'allow', always: true, updatedPermissions: [{ type: 'addRules' }], updatedInput: { command: 'x' }, rules: [1] } }, ctx);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.cmd.result, { behavior: 'allow', updatedInput: { command: 'x' }, always: true }, 'no rules; the engine ignores the input for a permission prompt');
  assert.deepEqual(checkPhoneCommand({ op: 'answer', askId: 'ask-1', result: { behavior: 'allow' } }, ctx).cmd.result, { behavior: 'allow' });
  assert.deepEqual(checkPhoneCommand({ op: 'answer', askId: 'ask-1', result: { behavior: 'allow', always: 'yes' } }, ctx).cmd.result, { behavior: 'allow' });
  assert.deepEqual(checkPhoneCommand({ op: 'answer', askId: 'ask-1', result: { behavior: 'deny', message: 'no thanks', always: true } }, ctx).cmd.result, { behavior: 'deny', message: 'no thanks' });
  assert.equal(checkPhoneCommand({ op: 'answer', askId: 'ask-1', result: { behavior: 'deny', message: 'n'.repeat(5000) } }, ctx).cmd.result.message.length, 2000);
  assert.equal(checkPhoneCommand({ op: 'answer', askId: 'ask-2', result: { behavior: 'allow' } }, ctx).ok, false, 'another phone\'s prompt');
  assert.equal(checkPhoneCommand({ op: 'answer', askId: 'ask-3', result: { behavior: 'allow' } }, ctx).ok, false, 'a desktop pane\'s prompt');
  assert.equal(checkPhoneCommand({ op: 'answer', askId: 'nope', result: { behavior: 'allow' } }, ctx).ok, false);
  assert.equal(checkPhoneCommand({ op: 'answer', askId: 'ask-1', result: { behavior: 'sure' } }, ctx).ok, false);
});

/* the sheet (apaki/ui/permission.js) */

test('permissionView: a command, an edit, a file, a page, an MCP tool and an unknown tool each read plainly', () => {
  const ask = (toolName, input, permission = {}) => ({ ev: 'ask', askId: 'a', paneId: 'p1', toolName, input, permission });
  const bash = permissionView(ask('Bash', { command: 'npm run test', description: 'Run the tests', run_in_background: true, timeout: 60000 }));
  assert.equal(bash.question, 'Run this command?');
  assert.equal(bash.tool, 'Bash');
  assert.equal(bash.blocks[0].kind, 'code');
  assert.equal(bash.blocks[0].text, 'npm run test');
  assert.deepEqual(bash.blocks[1].rows, [['What it does', 'Run the tests'], ['Runs', 'in the background'], ['Time limit', '60 s']]);

  const edit = permissionView(ask('Edit', { file_path: 'C:\\Users\\Arthur\\app\\a.js', old_string: 'one\ntwo', new_string: 'three' }));
  assert.equal(edit.question, 'Edit this file?');
  assert.equal(edit.blocks[0].kind, 'diff');
  assert.deepEqual(edit.blocks[0].edits[0].del.lines, ['one', 'two']);
  assert.deepEqual(edit.blocks[0].edits[0].add.lines, ['three']);

  const write = permissionView(ask('Write', { file_path: 'notes.md', content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') }));
  assert.equal(write.blocks[0].kind, 'file');
  assert.equal(write.blocks[0].lines, 100);
  assert.equal(write.blocks[0].more, 60);

  const fetch = permissionView(ask('WebFetch', { url: 'https://example.com/x', prompt: 'What is this?' }));
  assert.equal(fetch.question, 'Fetch this page?');
  assert.deepEqual(fetch.blocks[0].rows, [['Address', 'https://example.com/x']]);

  const mcp = permissionView(ask('mcp__github__create_issue', { title: 'Bug', repo: 'a/b' }));
  assert.equal(mcp.question, 'Use create_issue from github?');
  assert.deepEqual([mcp.tool, mcp.server], ['create_issue', 'github']);
  assert.deepEqual(mcpParts('mcp__a__b__c'), { server: 'a', tool: 'b__c' });
  assert.equal(mcpParts('Bash'), null);

  const odd = permissionView(ask('FutureTool', { nested: { a: 1 }, list: [1, 2] }));
  assert.equal(odd.question, 'Use FutureTool?');
  assert.equal(odd.blocks[0].kind, 'code');
  assert.ok(odd.blocks[0].text.includes('"nested"'));
  assert.equal(permissionView(ask('FutureTool', {})).blocks[0].text, 'No details were given.');
});

test('permissionView: the SDK\'s own words win; notes say why it was asked and what is outside the folder', () => {
  const v = permissionView({ toolName: 'Read', input: { file_path: 'D:\\x\\y.txt' }, permission: {
    title: 'Claude wants to read y.txt', displayName: 'Read file', description: 'Outside the project', decisionReason: 'Path is outside the working directory', blockedPath: 'D:\\x\\y.txt',
    agentId: 'agent-1', cut: true, defaultToNo: true, always: { lines: ['Allow access to D:\\x for this session only'] },
  } });
  assert.equal(v.question, 'Claude wants to read y.txt');
  assert.equal(v.tool, 'Read file');
  assert.equal(v.sub, 'Outside the project');
  assert.deepEqual(v.notes.map((n) => n.tone), ['warn', 'info', 'info', 'info']);
  assert.ok(v.notes[0].text.startsWith('Outside the working folder: D:'));
  assert.deepEqual(v.always, ['Allow access to D:\\x for this session only']);
  assert.equal(v.defaultToNo, true);
  assert.equal(permissionView({ toolName: 'Bash', input: { command: 'x' }, permission: {} }).always, null);
});

test('permissionHtml: escapes everything, shows the three buttons only when they apply, and says what Always allow saves', () => {
  const view = permissionView({ toolName: 'Bash', input: { command: 'echo "<b>hi</b>" && rm x' }, permission: { title: 'Run <this>', always: { lines: ['Allow Bash(echo:*) for this project, kept on this PC'] } } });
  const html = permissionHtml(view, { from: 'My <pane>' });
  assert.ok(html.includes('My &lt;pane&gt;'));
  assert.ok(html.includes('Run &lt;this&gt;'));
  assert.ok(html.includes('echo &quot;&lt;b&gt;hi&lt;/b&gt;&quot; &amp;&amp; rm x') || html.includes('echo "&lt;b&gt;hi&lt;/b&gt;" &amp;&amp; rm x'));
  assert.ok(!html.includes('<b>hi</b>'));
  for (const k of ['deny', 'always', 'once']) assert.ok(html.includes(`data-k="${k}"`), k);
  assert.ok(html.includes('Always allow saves'));
  assert.ok(html.includes('Allow Bash(echo:*) for this project, kept on this PC'));
  assert.ok(html.includes('data-note'));
  // Inline in the pane since 2026-10-12 (askcard.js): numbered rows in Claude Code's order, and Esc only leaves the card.
  assert.ok(html.includes('Enter allows once. Esc goes back to your message.'));
  const nums = [...html.matchAll(/data-k="(\w+)"[^>]*><span class="ask-n" aria-hidden="true">(\d)<\/span>/g)].map((m) => `${m[2]} ${m[1]}`);
  assert.deepEqual(nums, ['1 once', '2 always', '3 deny']);
  assert.deepEqual(permissionChoices(view), ['once', 'always', 'deny']);
  const plain = permissionHtml(permissionView({ toolName: 'Bash', input: { command: 'x' }, permission: { defaultToNo: true } }));
  assert.ok(!plain.includes('data-k="always"'), 'no suggestion, no Always allow');
  assert.ok(plain.includes('Enter does not approve this one.'));
  assert.ok(plain.includes('<span class="ask-n" aria-hidden="true">2</span>') && !plain.includes('>3</span>'), 'without Always allow, Deny is 2');
  assert.ok(!/<h2|class="row perm-row"/.test(html), 'not the old sheet');
  assert.ok(!html.includes('\u2014') && !html.includes('-'.repeat(2)), 'no em dashes or double hyphens in the words');
});

test('permissionKey: Enter allows once, numbers pick their row, Esc leaves the card; a stray Enter, a focused button and a default of no approve nothing', () => {
  const k = (o) => permissionKey({ armed: true, ...o });
  assert.equal(k({ key: 'Enter' }), 'once');
  // Esc goes back to the message box without answering (2026-10-12, the card in the pane): it never denies now.
  assert.equal(k({ key: 'Escape' }), 'leave');
  assert.equal(k({ key: 'Escape', target: 'field', noteText: 'x' }), 'leave');
  assert.equal(k({ key: 'Enter', armed: false }), null, 'the first moments: a keystroke meant for the message box');
  assert.equal(k({ key: 'Escape', armed: false }), 'leave');
  assert.equal(k({ key: 'Enter', target: 'button' }), null, 'the focused button\'s own click');
  assert.equal(k({ key: 'Enter', target: 'field', noteText: '  ' }), null);
  assert.equal(k({ key: 'Enter', target: 'field', noteText: 'use pnpm' }), 'deny', 'a typed note goes with Deny');
  assert.equal(k({ key: 'Enter', defaultToNo: true }), null, 'the SDK asked for a default of no: no one-key approve');
  assert.equal(k({ key: 'Escape', defaultToNo: true }), 'leave');
  assert.equal(k({ key: 'Enter', shiftKey: true }), null);
  assert.equal(k({ key: 'Enter', ctrlKey: true }), null);
  assert.equal(k({ key: 'Enter', repeat: true }), null);
  assert.equal(k({ key: 'a' }), null);
  // The numbers: Claude Code's 1, 2, 3, on the card or a row, never while typing a note, never in the first moments.
  assert.equal(k({ key: '1' }), 'once');
  assert.equal(k({ key: '2' }), 'always');
  assert.equal(k({ key: '3', target: 'button' }), 'deny');
  assert.equal(k({ key: '2', choices: ['once', 'deny'] }), 'deny', 'without Always allow, Deny is 2');
  assert.equal(k({ key: '3', choices: ['once', 'deny'] }), null);
  assert.equal(k({ key: '1', target: 'field' }), null, 'typing a note');
  assert.equal(k({ key: '1', armed: false }), null);
  assert.equal(k({ key: '1', repeat: true }), null);
  assert.equal(k({ key: '1', altKey: true }), null);
  assert.ok(ARM_MS >= 300 && ARM_MS <= 1500);
});

test('permissionReply: the answer op\'s result for each choice', () => {
  assert.deepEqual(permissionReply('once'), { behavior: 'allow' });
  assert.deepEqual(permissionReply('always'), { behavior: 'allow', always: true });
  assert.deepEqual(permissionReply('deny', '  use pnpm  '), { behavior: 'deny', message: 'use pnpm' });
  assert.deepEqual(permissionReply('deny'), { behavior: 'deny', message: '' });
  assert.equal(denyLabel(''), 'Deny');
  assert.equal(denyLabel('  '), 'Deny');
  assert.equal(denyLabel('x'), 'Deny with note');
});

/* end to end: engine.js in host mode */

// A stand-in for @anthropic-ai/claude-agent-sdk (as in test/apaki-queue.test.js) whose turns call the permission callback
// the way Claude Code does:
//   perm:ask      one Bash call with a suggested rule; the reply is the callback's result as JSON
//   perm:abort    the same, cancelled by Claude Code (the signal) 200 ms later
//   perm:endturn  the same, but the turn ends while it waits; perm:late then reports what the callbacks returned
//   perm:after    the turn ends, and 150 ms later Claude Code asks (activity no send of this window is waiting for)
//   perm:agentend a subagent (agentID) asks and the main turn ends while it waits
//   q:ask         an AskUserQuestion through the PreToolUse hook, the way bypassPermissions answers questions
// Everything else is echoed. Everything not stubbed comes from the real SDK.
const REAL_SDK = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
const FAKE_SDK_BODY = String.raw`
import crypto from 'node:crypto';
const sessions = new Map();
const lates = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Chan {
  constructor() { this.items = []; this.waiters = []; this.done = false; }
  push(v) { const w = this.waiters.shift(); if (w) w({ value: v, done: false }); else this.items.push(v); }
  end() { this.done = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return {
      next: () => (this.items.length ? Promise.resolve({ value: this.items.shift(), done: false }) : this.done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => this.waiters.push(r))),
      return: () => { this.end(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '');
const RULE = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' };
export function query({ prompt, options = {} }) {
  const out = new Chan();
  let sid = options.resume || null;
  let n = 0;
  (async () => {
    let inited = false;
    for await (const m of prompt) {
      if (!sid) sid = crypto.randomUUID();
      if (!sessions.has(sid)) sessions.set(sid, []);
      if (!inited) { inited = true; out.push({ type: 'system', subtype: 'init', session_id: sid }); }
      const text = textOf(m.message && m.message.content);
      const id = 'msg_' + (++n);
      out.push({ type: 'stream_event', event: { type: 'message_start', message: { id } }, session_id: sid });
      let reply = 'echo: ' + text;
      const perm = /^perm:(\w+)/.exec(text);
      if (perm) {
        const ac = new AbortController();
        const ask = (extra = {}) => options.canUseTool('Bash', { command: 'npm test' }, { signal: ac.signal, suggestions: [RULE], toolUseID: 'toolu_1', title: 'Claude wants to run npm test', decisionReason: 'Not on your allow list', ...extra });
        const call = ['after', 'late', 'agentend'].includes(perm[1]) ? null : ask();
        if (perm[1] === 'after') setTimeout(() => { lates.push(ask()); }, 150);
        if (perm[1] === 'abort') setTimeout(() => ac.abort(), 200);
        if (perm[1] === 'endturn') { lates.push(call); reply = 'ended early'; }
        else if (perm[1] === 'after') { reply = 'asks later'; }
        else if (perm[1] === 'agentend') { lates.push(ask({ agentID: 'sub1' })); reply = 'a subagent asks'; }
        else if (perm[1] === 'late') { reply = 'late ' + JSON.stringify(await Promise.all(lates)); }
        else reply = 'perm ' + JSON.stringify(await call);
      }
      if (text.startsWith('q:ask')) {
        const matcher = options.hooks.PreToolUse.find((h) => h.matcher === 'AskUserQuestion|ExitPlanMode');
        const r = await matcher.hooks[0]({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } });
        reply = 'q ' + JSON.stringify(r);
      }
      sessions.get(sid).push({ type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
      out.push({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: reply }] }, session_id: sid });
      out.push({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, usage: {}, total_cost_usd: 0, result: reply, session_id: sid });
    }
    out.end();
  })().catch(() => out.end());
  return Object.assign(out, {
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, supportedCommands: async () => [],
    getContextUsage: async () => ({ percentage: 1, categories: [] }), stopTask: async () => {}, backgroundTasks: async () => false, getTaskOutput: async () => ({ output: '' }),
  });
}
export async function getSessionMessages(id) { return (sessions.get(id) || []).slice(); }
export async function getSessionInfo(id) { return sessions.has(id) ? { sessionId: id, summary: 'Fake session', cwd: process.cwd() } : null; }
export async function listSessions() { return []; }
export async function renameSession() {}
export function createSdkMcpServer(o = {}) { return { type: 'sdk', name: o.name, instance: {} }; }
export function tool(name, description, inputSchema, handler) { return { name, description, inputSchema, handler }; }
`;
const FAKE_SDK = `export * from ${JSON.stringify(REAL_SDK)};\n${FAKE_SDK_BODY}`;
const HOOKS = `export async function resolve(specifier, context, next) {
  if (specifier === '@anthropic-ai/claude-agent-sdk') return { url: new URL('./fake-agent-sdk.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
`;
const LOADER = `import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
`;
const APP = 'apaki-dev-permissions-test';

/** Starts engine.js in host mode in a temp world (isolated, no Glass, no index, no keeper); resolves once its host file names it. */
async function startHost(t) {
  const dir = tmp();
  const claude = path.join(dir, 'claude');
  const fake = path.join(dir, 'fake');
  fs.mkdirSync(path.join(claude, 'latch'), { recursive: true });
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'fake-agent-sdk.mjs'), FAKE_SDK);
  fs.writeFileSync(path.join(fake, 'hooks.mjs'), HOOKS);
  fs.writeFileSync(path.join(fake, 'loader.mjs'), LOADER);
  const file = path.join(claude, 'latch', `apaki-host.${APP}.json`);
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claude, LATCH_DIR: path.join(claude, 'latch'), APAKI_APP_ID: APP, APAKI_HOST_FILE: file,
    APAKI_REMOTE_DIR: path.join(dir, 'remote'), LATCH_GLASS_CLI: path.join(dir, 'no-glass.exe'), LATCH_LIVE_LOGIN_FILE: path.join(dir, 'no-login.json'),
    CLAUDE_CREDENTIALS_FILE: path.join(dir, 'no-credentials.md'), APAKI_VOICE_DIR: path.join(dir, 'voice'), LATCH_NO_INDEX: '1', LATCH_WARM_NO_KEEPER: '1',
    APAKI_SHELL_FEATURES: 'browser', APAKI_HOST_TICK_MS: '100', APAKI_HOST_IDLE_MS: '60000', APAKI_HOST_EXIT_MS: '60000',
  };
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(fake, 'loader.mjs')).href, ENGINE, '--host'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    rm(dir);
  });
  await until(() => readHostInfo(file)?.pid === child.pid || child.exitCode !== null, 30000);
  assert.equal(child.exitCode, null, `the host did not start:\n${log}`);
  return { child, file, dir, log: () => log };
}

const windowOf = async (h) => {
  const w = await connectHost({ file: h.file, role: 'window' });
  await w.next((m) => m.ev === 'ready');
  w.send({ op: 'shellHello', version: 1, features: ['browser'] });
  return w;
};

/** Waits for an event; a timeout says which one and what did arrive, so a failing run explains itself. */
async function waitFor(w, label, pred, ms = 10000, from = 0) {
  try { return await w.next(pred, ms, from); } catch (e) {
    throw new Error(`timed out waiting for ${label}; events since: ${w.events.slice(from).map((m) => `${m.ev}${m.paneId ? `@${m.paneId}` : ''}${m.subtype ? `/${m.subtype}` : ''}`).join(', ')}`, { cause: e });
  }
}

/** Opens a pane in Ask permissions mode and returns a function that sends a message and waits for its result. */
async function pane(w, h, paneId) {
  w.send({ op: 'open', reqId: `o-${paneId}`, paneId, sessionId: null, cwd: h.dir, warm: true, mode: 'default' });
  await w.next((m) => m.ev === 'opened' && m.reqId === `o-${paneId}`);
  let n = 0;
  return {
    send: (text) => { const reqId = `${paneId}-${++n}`; w.send({ op: 'send', reqId, paneId, text }); return reqId; },
    result: (reqId, ms = 15000) => waitFor(w, `the result of ${reqId}`, (m) => m.ev === 'result' && m.reqId === reqId, ms),
    ask: (from = 0, ms = 10000) => waitFor(w, `an ask in ${paneId}`, (m) => m.ev === 'ask' && m.paneId === paneId, ms, from),
  };
}

const jsonAfter = (result, word) => JSON.parse(String(result.result).slice(word.length + 1));

test('end to end: Ask permissions asks the window; allow once, always allow, deny with a note and answered once', { timeout: 120000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await pane(w, h, 'pA');

  // Allow once, and a second, contradicting answer to the same prompt is ignored.
  let mark = w.events.length;
  let req = p.send('perm:ask');
  let ask = await p.ask(mark);
  assert.equal(ask.toolName, 'Bash');
  assert.deepEqual(ask.input, { command: 'npm test' });
  assert.equal(ask.permission.title, 'Claude wants to run npm test');
  assert.equal(ask.permission.decisionReason, 'Not on your allow list');
  assert.deepEqual(ask.permission.always, { lines: ['Allow Bash(npm test:*) for this project, kept on this PC'] });
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'allow' } });
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'deny', message: 'too late' } });
  let got = jsonAfter(await p.result(req), 'perm');
  assert.equal(got.behavior, 'allow');
  assert.deepEqual(got.updatedInput, { command: 'npm test' });
  assert.equal(got.updatedPermissions, undefined, 'allow once saves nothing');
  assert.equal(got.toolUseID, 'toolu_1');

  // Always allow: the SDK's suggestions come back as updatedPermissions.
  mark = w.events.length;
  req = p.send('perm:ask');
  ask = await p.ask(mark);
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'allow', always: true, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' }] } });
  got = jsonAfter(await p.result(req), 'perm');
  assert.equal(got.behavior, 'allow');
  assert.deepEqual(got.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }]);

  // Deny with a note: Claude gets the note.
  mark = w.events.length;
  req = p.send('perm:ask');
  ask = await p.ask(mark);
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'deny', message: 'run pnpm test instead' } });
  got = jsonAfter(await p.result(req), 'perm');
  assert.equal(got.behavior, 'deny');
  assert.ok(got.message.includes('run pnpm test instead'));

  // Deny with no note: the plain rejection.
  mark = w.events.length;
  req = p.send('perm:ask');
  ask = await p.ask(mark);
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'deny' } });
  got = jsonAfter(await p.result(req), 'perm');
  assert.equal(got.message, REJECT_TEXT);

  assert.ok(!w.events.some((m) => m.ev === 'error'), `no errors: ${JSON.stringify(w.events.filter((m) => m.ev === 'error'))}`);
  w.close();
});

test('end to end: a prompt that waits is shown again to a window that reattaches, and a stale one drops when the turn ends or Claude Code cancels it', { timeout: 120000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await pane(w, h, 'pB');

  // A window that comes back (attach) is asked again, with the same sheet.
  let mark = w.events.length;
  let req = p.send('perm:ask');
  const ask = await p.ask(mark);
  const sessionId = (await waitFor(w, 'the session id', (m) => m.ev === 'session_id' && m.paneId === 'pB')).sessionId;
  mark = w.events.length;
  w.send({ op: 'attach', reqId: 'at1', paneId: 'pB', sessionId });
  const again = await waitFor(w, 'the ask again after attach', (m) => m.ev === 'ask' && m.askId === ask.askId, 10000, mark);
  assert.deepEqual(again.permission, ask.permission);
  assert.deepEqual(again.input, ask.input);
  w.send({ op: 'answer', askId: ask.askId, result: { behavior: 'allow' } });
  assert.equal(jsonAfter(await p.result(req), 'perm').behavior, 'allow');

  // The turn ends while the prompt waits: the engine settles it, the sheet drops (ask_gone), a late answer is ignored.
  mark = w.events.length;
  req = p.send('perm:endturn');
  const stale = await p.ask(mark);
  await p.result(req);
  const gone = await waitFor(w, 'ask_gone after the turn ended', (m) => m.ev === 'ask_gone' && m.askId === stale.askId, 10000, mark);
  assert.equal(gone.paneId, 'pB');
  assert.equal(gone.why, 'turn', 'the card says the turn ended');
  w.send({ op: 'answer', askId: stale.askId, result: { behavior: 'allow' } });
  req = p.send('perm:late');
  const late = JSON.parse(String((await p.result(req)).result).slice('late '.length));
  assert.equal(late.length, 1);
  assert.equal(late[0].behavior, 'deny', 'the call that was waiting was refused, not allowed by a late answer');
  assert.equal(late[0].message, WITHDRAWN_TEXT);

  // Claude Code cancels the call (its signal): the sheet drops too.
  mark = w.events.length;
  req = p.send('perm:abort');
  const cancelled = await p.ask(mark);
  const gone2 = await waitFor(w, 'ask_gone after a cancel', (m) => m.ev === 'ask_gone' && m.askId === cancelled.askId, 10000, mark);
  assert.equal(gone2.paneId, 'pB');
  assert.equal(gone2.why, 'cancelled');
  assert.equal(jsonAfter(await p.result(req), 'perm').behavior, 'deny');
  w.close();
});

test('end to end: questions and plan approvals are answered as before; closing a pane drops its prompt', { timeout: 120000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await pane(w, h, 'pC');
  let mark = w.events.length;
  let req = p.send('q:ask');
  const q = await p.ask(mark);
  assert.equal(q.toolName, 'AskUserQuestion');
  assert.equal(q.permission, undefined, 'a question is not a permission prompt');
  w.send({ op: 'answer', askId: q.askId, result: { behavior: 'allow', updatedInput: { questions: [], answers: { 'Which?': 'A' } } } });
  const r = jsonAfter(await p.result(req), 'q');
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(r.hookSpecificOutput.updatedInput.answers, { 'Which?': 'A' });

  // A prompt waits (asked after the turn ended, so no send holds the pane), then the pane is closed: the sheet goes.
  mark = w.events.length;
  req = p.send('perm:after');
  await p.result(req);
  const open = await p.ask(mark);
  w.send({ op: 'close', reqId: 'cl1', paneId: 'pC' });
  const gone = await waitFor(w, 'ask_gone after closing the pane', (m) => m.ev === 'ask_gone' && m.askId === open.askId, 10000, mark);
  assert.equal(gone.paneId, 'pC');
  assert.equal(gone.why, 'closed');
  await waitFor(w, 'closed', (m) => m.ev === 'closed' && m.paneId === 'pC', 10000, mark);
  w.close();
});

test('end to end: a prompt from a subagent outlives the main turn; the end of the Claude Code process drops what is left',{ timeout: 120000 }, async (t) => {
  const h = await startHost(t);
  const w = await windowOf(h);
  const p = await pane(w, h, 'pD');
  let mark = w.events.length;
  let req = p.send('perm:agentend');
  const sub = await p.ask(mark);
  assert.equal(sub.permission.agentId, 'sub1');
  await p.result(req);
  await sleep(500);
  assert.ok(!w.events.slice(mark).some((m) => m.ev === 'ask_gone' && m.askId === sub.askId), 'a background subagent can still be waiting when the main turn ends');
  w.send({ op: 'answer', askId: sub.askId, result: { behavior: 'allow' } });
  req = p.send('perm:late');
  const late = JSON.parse(String((await p.result(req)).result).slice('late '.length));
  assert.deepEqual(late.map((r) => r.behavior), ['allow'], 'it was still answerable');

  // The process ends (a restart for another effort): what only it waited for goes.
  mark = w.events.length;
  req = p.send('perm:agentend');
  const left = await p.ask(mark);
  await p.result(req);
  w.send({ op: 'effort', reqId: 'ef1', paneId: 'pD', effort: 'low' });
  const gone = await waitFor(w, 'ask_gone after the process ended', (m) => m.ev === 'ask_gone' && m.askId === left.askId, 10000, mark);
  assert.equal(gone.paneId, 'pD');
  assert.equal(gone.why, 'stopped');
  w.close();
});
