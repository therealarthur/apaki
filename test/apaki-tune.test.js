/**
 * Ultracode and the other settings beside effort (apaki/engine/tune.js, remote-policy.js, the runner), 2026-10-13: the
 * mapping from a pane's tune to Claude Code's settings and to Codex's turn fields, the SDK rule about effort changes, what a
 * phone may send for it at each access level, and that the lists the pieces keep agree. Nothing is started.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SPEED_RE, SUMMARIES, WORKFLOW_SIZES, claudeChange, claudeTune, codexChange, codexTune, codexTurnFields, liveSettings, normalizeSize, startSettings,
} from '../apaki/engine/tune.js';
import { PHONE_OPS, capTuneText, checkPhoneCommand } from '../apaki/engine/remote-policy.js';
import { normalizeModels } from '../apaki/engine/codex-map.js';
import { SessionRunner } from '../src/runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('a Claude tune is Ultracode on or off and a known workflow size; anything else reads as off and the default size', () => {
  assert.deepEqual(WORKFLOW_SIZES, ['small', 'medium', 'large', 'unrestricted']);
  assert.deepEqual(claudeTune(null), { ultracode: false, size: null });
  assert.deepEqual(claudeTune({ ultracode: true, size: 'large' }), { ultracode: true, size: 'large' });
  assert.deepEqual(claudeTune({ ultracode: 'yes', size: 'huge' }), { ultracode: false, size: null }, 'only exactly true turns it on');
  assert.deepEqual(claudeTune({ summary: 'auto', speed: 'priority' }), { ultracode: false, size: null }, 'a Codex tune is not a Claude one');
  assert.equal(normalizeSize('medium'), 'medium');
  assert.equal(normalizeSize('MEDIUM'), null);
  assert.equal(normalizeSize(undefined), null);
});

test('a change moves only the keys it names: ultracode keeps the size, a size keeps ultracode, null puts the size back to default', () => {
  const on = claudeChange({ ultracode: false, size: 'small' }, { ultracode: true });
  assert.deepEqual(on, { ultracode: true, size: 'small' });
  assert.deepEqual(claudeChange(on, { size: 'large' }), { ultracode: true, size: 'large' });
  assert.deepEqual(claudeChange(on, { size: null }), { ultracode: true, size: null });
  assert.deepEqual(claudeChange(on, { ultracode: false }), { ultracode: false, size: 'small' }, 'off remembers the size for next time');
  assert.deepEqual(claudeChange(on, { size: 'bogus' }), { ultracode: true, size: null });
  assert.deepEqual(claudeChange(on, {}), on);
  assert.deepEqual(claudeChange(on, null), on);
});

test('a process starts with Ultracode and its size only when the pane uses them, so a pane that never does starts as before', () => {
  assert.deepEqual(startSettings(null), {});
  assert.deepEqual(startSettings({ ultracode: false, size: 'large' }), {}, 'a size alone is not sent while Ultracode is off');
  assert.deepEqual(startSettings({ ultracode: true }), { ultracode: true });
  assert.deepEqual(startSettings({ ultracode: true, size: 'unrestricted' }), { ultracode: true, workflowSizeGuideline: 'unrestricted' });
});

test('a phone below Full access starts with workflows off, the keyword trigger too, whatever its tune says', () => {
  const off = { ultracode: false, disableWorkflows: true, workflowKeywordTriggerEnabled: false };
  assert.deepEqual(startSettings({ ultracode: true, size: 'large' }, { restricted: true }), off);
  assert.deepEqual(startSettings(null, { restricted: true }), off);
  assert.deepEqual(startSettings({ ultracode: true }, { restricted: false }), { ultracode: true });
});

test('the SDK rule: a new effort level always goes with the ultracode key, so Ultracode is not switched off by it', () => {
  const was = { effort: 'high', ultracode: true, size: null };
  assert.deepEqual(liveSettings(was, { ...was, effort: 'max' }), { effortLevel: 'max', ultracode: true });
  assert.deepEqual(liveSettings({ ...was, ultracode: false }, { ...was, ultracode: false, effort: 'xhigh' }), { effortLevel: 'xhigh', ultracode: false }, 'both keys when it is off too');
  assert.deepEqual(liveSettings(was, { ...was, effort: 'low', size: 'small' }), { effortLevel: 'low', ultracode: true, workflowSizeGuideline: 'small' });
  assert.deepEqual(liveSettings(was, was), {}, 'nothing moved, nothing sent');
});

test('turning Ultracode on or off sends the ultracode key alone and leaves the effort alone; off clears the size', () => {
  const idle = { effort: 'xhigh', ultracode: false, size: null };
  assert.deepEqual(liveSettings(idle, { ...idle, ultracode: true }), { ultracode: true, workflowSizeGuideline: null }, 'on with the default size');
  assert.deepEqual(liveSettings({ ...idle, size: 'large' }, { ...idle, ultracode: true, size: 'large' }), { ultracode: true, workflowSizeGuideline: 'large' });
  assert.equal('effortLevel' in liveSettings(idle, { ...idle, ultracode: true }), false);
  const on = { effort: 'xhigh', ultracode: true, size: 'large' };
  assert.deepEqual(liveSettings(on, { ...on, ultracode: false }), { ultracode: false, workflowSizeGuideline: null });
});

test('a size picked while Ultracode is on is sent; while it is off it waits (nothing is sent for it)', () => {
  const on = { effort: 'high', ultracode: true, size: null };
  assert.deepEqual(liveSettings(on, { ...on, size: 'medium' }), { workflowSizeGuideline: 'medium' });
  assert.deepEqual(liveSettings(on, { ...on, size: null }), {});
  const sized = { ...on, size: 'small' };
  assert.deepEqual(liveSettings(sized, { ...sized, size: null }), { workflowSizeGuideline: null }, 'back to default clears it');
  const off = { effort: 'high', ultracode: false, size: null };
  assert.deepEqual(liveSettings(off, { ...off, size: 'large' }), {});
});

test('the runner passes flag settings to a running process, and says false when it cannot so the engine can restart instead', async () => {
  const base = { sessionId: 'abc', cwd: '/tmp', env: {}, canUseTool: async () => ({ behavior: 'allow' }), onMessage: () => {} };
  const r = new SessionRunner(base);
  assert.equal(await r.applyFlags({ ultracode: true }), false, 'no process, no call');
  assert.equal(await r.appliedSettings(), null);
  const calls = [];
  r.q = { applyFlagSettings: async (f) => { calls.push(f); }, getSettings: async () => ({ applied: { effort: 'max', ultracode: true, ultracodeRequested: true, ultracodeAvailable: true } }) };
  assert.equal(await r.applyFlags({ effortLevel: 'max', ultracode: true }), true);
  assert.deepEqual(calls, [{ effortLevel: 'max', ultracode: true }]);
  assert.equal(await r.applyFlags({}), false, 'an empty change is not a call');
  assert.equal((await r.appliedSettings()).effort, 'max');
  r.q = { applyFlagSettings: async () => { throw new Error('no'); }, getSettings: async () => { throw new Error('no'); } };
  assert.equal(await r.applyFlags({ ultracode: true }), false, 'a refused call is a false, not a throw');
  assert.equal(await r.appliedSettings(), null);
  r.q = {};
  assert.equal(await r.applyFlags({ ultracode: true }), false, 'an SDK without the call');
});

test('the Codex tune is a reasoning summary Codex knows and a speed id; the turn gets only what was picked and the model offers', () => {
  assert.deepEqual(SUMMARIES, ['auto', 'concise', 'detailed', 'none']);
  assert.deepEqual(codexTune(null), { summary: null, speed: null });
  assert.deepEqual(codexTune({ summary: 'detailed', speed: 'priority' }), { summary: 'detailed', speed: 'priority' });
  assert.deepEqual(codexTune({ summary: 'loud', speed: 'Fast!' }), { summary: null, speed: null });
  assert.deepEqual(codexTune({ ultracode: true }), { summary: null, speed: null }, 'a Claude tune is not a Codex one');
  assert.ok(SPEED_RE.test('priority') && SPEED_RE.test('default') && !SPEED_RE.test('Priority') && !SPEED_RE.test('a b'));
  const t = codexChange(null, { summary: 'none' });
  assert.deepEqual(codexChange(t, { speed: 'default' }), { summary: 'none', speed: 'default' });
  assert.deepEqual(codexChange(t, { summary: null }), { summary: null, speed: null }, 'null puts it back to never picked');
  const model = { serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }] };
  assert.deepEqual(codexTurnFields(null, model), {}, 'never picked, nothing sent');
  assert.deepEqual(codexTurnFields({ summary: 'concise', speed: 'priority' }, model), { summary: 'concise', serviceTier: 'priority' });
  assert.deepEqual(codexTurnFields({ speed: 'default' }, { serviceTiers: [] }), { serviceTier: 'default' }, 'standard speed always goes');
  assert.deepEqual(codexTurnFields({ speed: 'priority' }, { serviceTiers: [] }), {}, 'a tier the model does not list is left out');
  assert.deepEqual(codexTurnFields({ speed: 'priority' }, null), {});
});

test('Codex has no Ultracode switch: its models list the speeds they offer and the ultra effort stays one of their own efforts', () => {
  const rows = normalizeModels([
    { model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' }], defaultReasoningEffort: 'high', serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }, { id: 'BAD ID', name: 'x' }] },
    { model: 'gpt-6-luna', displayName: 'GPT-6-Luna', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' },
  ]);
  assert.deepEqual(rows[0].serviceTiers, [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }], 'a tier with an odd id is dropped');
  assert.deepEqual(rows[1].serviceTiers, [], 'no tiers listed, no speed row');
  assert.equal(rows[0].efforts.at(-1).value, 'ultra');
  assert.equal(rows[0].efforts.at(-1).description, 'Maximum reasoning with automatic task delegation');
});

/* ---------- what a phone may send ---------- */

const DEVICE = 'A'.repeat(22);
const ctx = (over = {}) => ({ deviceId: DEVICE, cap: 'full', paneExists: () => true, paneCount: () => 0, paneKind: (id) => (/:c\d+$/.test(id) ? 'codex' : 'claude'), phoneSessions: () => [], ...over });
const ok = (cmd, c) => { const r = checkPhoneCommand(cmd, c || ctx()); assert.equal(r.ok, true, r.error); return r.cmd; };
const bad = (cmd, c) => { const r = checkPhoneCommand(cmd, c || ctx()); assert.equal(r.ok, false, 'should be refused'); return r.error; };

test('tune is a phone op on a pane, and a Full phone may turn Ultracode on, pick a size and clear it', () => {
  assert.ok(PHONE_OPS.includes('tune'));
  const on = ok({ op: 'tune', paneId: 'p1', ultracode: true, size: 'medium', junk: 1 });
  assert.deepEqual(on, { op: 'tune', paneId: `phone:${DEVICE}:p1`, ultracode: true, size: 'medium' });
  assert.deepEqual(ok({ op: 'tune', paneId: 'p1', size: null }), { op: 'tune', paneId: `phone:${DEVICE}:p1`, size: null });
  assert.match(bad({ op: 'tune', paneId: 'p1', ultracode: 'yes' }), /on or off/);
  assert.match(bad({ op: 'tune', paneId: 'p1', size: 'huge' }), /workflow size/);
  assert.match(bad({ op: 'tune', paneId: 'p1' }), /Nothing to change/);
  assert.match(bad({ op: 'tune', ultracode: true }), /Bad pane id/);
});

test('No shell and Chat only cannot turn Ultracode on, and say why; turning it off and choosing a size stay open', () => {
  for (const cap of ['noshell', 'chat']) {
    const why = bad({ op: 'tune', paneId: 'p1', ultracode: true }, ctx({ cap }));
    assert.equal(why, capTuneText(cap));
    assert.match(why, cap === 'chat' ? /Chat only/ : /No shell/);
    assert.match(why, /sub-agents/);
    assert.equal(ok({ op: 'tune', paneId: 'p1', ultracode: false }, ctx({ cap })).ultracode, false);
    assert.equal(ok({ op: 'tune', paneId: 'p1', size: 'small' }, ctx({ cap })).size, 'small');
  }
  // An unknown capability fails closed, like everywhere else.
  assert.equal(bad({ op: 'tune', paneId: 'p1', ultracode: true }, ctx({ cap: 'weird' })), capTuneText('chat'));
});

test('an open carries the tune; a phone below Full access is clamped to Ultracode off instead of refused', () => {
  const full = ok({ op: 'open', paneId: 'p1', sessionId: null, tune: { ultracode: true, size: 'large' } });
  assert.deepEqual(full.tune, { ultracode: true, size: 'large' });
  for (const cap of ['noshell', 'chat']) {
    const o = ok({ op: 'open', paneId: 'p1', sessionId: null, tune: { ultracode: true, size: 'large' } }, ctx({ cap }));
    assert.deepEqual(o.tune, { ultracode: false, size: 'large' }, `${cap}: opens, Ultracode off`);
  }
  assert.equal(ok({ op: 'open', paneId: 'p1', sessionId: null }).tune, undefined, 'an older page sends none');
  assert.match(bad({ op: 'open', paneId: 'p1', sessionId: null, tune: 'on' }), /Bad settings/);
  assert.match(bad({ op: 'open', paneId: 'p1', sessionId: null, tune: { size: 'x' } }), /workflow size/);
});

test('a Codex pane takes a reasoning summary and a speed at every access level, and never an Ultracode switch', () => {
  const t = ok({ op: 'tune', paneId: 'c1', summary: 'detailed', speed: 'priority' });
  assert.deepEqual(t, { op: 'tune', paneId: `phone:${DEVICE}:c1`, summary: 'detailed', speed: 'priority' });
  for (const cap of ['noshell', 'chat']) {
    assert.equal(ok({ op: 'tune', paneId: 'c1', summary: 'none', speed: 'default' }, ctx({ cap })).speed, 'default', `${cap}: speed and summary start nothing`);
  }
  assert.match(bad({ op: 'tune', paneId: 'c1', summary: 'loud' }), /reasoning summary/);
  assert.match(bad({ op: 'tune', paneId: 'c1', speed: 'Fast!' }), /Unknown speed/);
  assert.match(bad({ op: 'tune', paneId: 'c1', ultracode: true }), /Nothing to change/, 'the Claude keys mean nothing to a Codex pane');
  assert.deepEqual(ok({ op: 'tune', paneId: 'c1', summary: null }).summary, null);
  const open = ok({ op: 'open', paneId: 'c2', sessionId: null, kind: 'codex', tune: { summary: 'concise', speed: 'priority' } }, ctx({ cap: 'chat' }));
  assert.deepEqual(open.tune, { summary: 'concise', speed: 'priority' });
});

test('a pane that shows a desktop conversation cannot change its tune, like its model, effort and mode', () => {
  const r = checkPhoneCommand({ op: 'tune', paneId: 'f1', size: 'small' }, ctx({ followOf: () => 'dp1' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /set on the PC/);
});

test('the lists the pieces keep agree: sizes and summaries in the policy, the engine and the window', () => {
  const policy = read('apaki', 'engine', 'remote-policy.js');
  const grab = (src, name) => JSON.parse(new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(src)[1].replace(/'/g, '"'));
  assert.deepEqual(grab(policy, 'WORKFLOW_SIZES'), [...WORKFLOW_SIZES]);
  assert.deepEqual(grab(policy, 'CODEX_SUMMARIES'), [...SUMMARIES]);
  assert.ok(policy.includes(`const CODEX_SPEED_RE = /${SPEED_RE.source}/;`), 'the speed pattern is the same');
});
