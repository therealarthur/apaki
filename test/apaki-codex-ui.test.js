/**
 * What a Codex pane shows (apaki/ui/codex.js, permission.js, menu.js, pane.js), 2026-10-12: the pure parts. The window
 * and the phone page share these files, so one set of checks covers both.
 *
 *   codex.js       the three presets, model and effort choices, a patch's lines, the footer, what opens a viewer
 *   permission.js  the sheet with Codex's own words (Approve once, Approve for this session), a patch's diff, more access
 *   menu.js        the effort grid for a model's own list of efforts
 *   pane.js        a patch's tool line, and the wiring the demo harness showed (picked picks only, new Claude panes never inherit)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CARD_ONLY_VIA, CODEX_LOCAL, CODEX_MODES, codexFooter, codexMode, earlierText, effortNames, findModel, isCodexId, modelLabel, patchArgs, patchHtml, patchLines, pickMode, pickModel,
} from '../apaki/ui/codex.js';
import { approvalAsk } from '../apaki/engine/codex-map.js';
import { effortGrid, EFFORTS } from '../apaki/ui/menu.js';
import { permissionHtml, permissionView, denyLabel } from '../apaki/ui/permission.js';
import { toolArgs } from '../apaki/ui/pane.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const MODELS = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: 'd', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => ({ value, description: '' })), defaultEffort: 'low', isDefault: true },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'd', efforts: ['low', 'medium', 'high'].map((value) => ({ value, description: '' })), defaultEffort: 'medium', isDefault: false },
];

test('Codex presets: the three of the Codex app, most open first, each with a word, a mark and a hint that fits a menu', () => {
  assert.deepEqual(CODEX_MODES.map((m) => m.value), ['full-access', 'auto', 'read-only']);
  for (const m of CODEX_MODES) { assert.ok(m.label && m.short && m.mark && m.hint); assert.ok(m.hint.length <= 40, `${m.value} hint is short enough for the menu`); }
  assert.equal(codexMode('full-access').label, 'Full access');
  assert.equal(codexMode('bypassPermissions').value, 'auto', 'an unknown value reads as the middle preset');
  assert.deepEqual(CODEX_LOCAL.map((c) => c.name), ['new', 'resume', 'model', 'effort', 'approvals', 'folder']);
  assert.equal(isCodexId('codex:abc'), true);
  assert.equal(isCodexId('abc'), false);
});

test('model and effort choices come from the list the engine read; typed words find them', () => {
  assert.equal(modelLabel(MODELS, 'gpt-6-astra'), 'GPT-6-Astra');
  assert.equal(modelLabel(MODELS, 'unlisted'), 'unlisted');
  assert.equal(modelLabel(null, ''), 'Model');
  assert.deepEqual(effortNames(MODELS, 'gpt-6-astra'), ['low', 'medium', 'high']);
  assert.deepEqual(effortNames(MODELS, 'nope'), []);
  assert.equal(findModel(MODELS, 'gpt-6.1-sol').isDefault, true);
  assert.equal(pickModel(MODELS, 'astra').id, 'gpt-6-astra');
  assert.equal(pickModel(MODELS, 'GPT-6.1-SOL').id, 'gpt-6.1-sol');
  assert.equal(pickModel(MODELS, 'sol').id, 'gpt-6.1-sol');
  assert.equal(pickModel(MODELS, 'claude'), null);
  assert.equal(pickModel(MODELS, ''), null);
  assert.equal(pickMode('full'), 'full-access');
  assert.equal(pickMode('Full Access'), 'full-access');
  assert.equal(pickMode('bypass'), 'full-access');
  assert.equal(pickMode('read'), 'read-only');
  assert.equal(pickMode('read-only'), 'read-only');
  assert.equal(pickMode('default'), 'auto');
  assert.equal(pickMode('plan'), null);
  assert.equal(pickMode(''), null);
});

test('the effort grid spreads a model\'s own efforts over the five columns; Claude\'s five are unchanged', () => {
  const lit = (html) => (html.match(/class="lit"/g) || []).length / 3;
  for (let i = 0; i < EFFORTS.length; i++) assert.equal(lit(effortGrid(EFFORTS[i])), i + 1, 'five efforts, five columns, as before');
  assert.ok(effortGrid('max').includes('egrid max'));
  const six = MODELS[0].efforts.map((e) => e.value);
  assert.deepEqual(six.map((e) => lit(effortGrid(e, { levels: six }))), [1, 2, 3, 3, 4, 5], 'six levels over five columns, the top one full');
  assert.ok(effortGrid('ultra', { levels: six }).includes('egrid max'));
  assert.deepEqual(['low', 'medium', 'high'].map((e) => lit(effortGrid(e, { levels: ['low', 'medium', 'high'] }))), [2, 3, 5]);
  assert.equal(lit(effortGrid('unknown', { levels: six })), 1, 'an effort the model does not list lights the first column');
  assert.ok(effortGrid('low', { live: true }).includes('live'));
});

test('a patch as lines: hunks, additions, removals and context; a new file is all additions, a deleted one all removals', () => {
  const lines = patchLines({ kind: 'update', diff: '@@ -1,3 +1,3 @@\n keep\n-old\n+new\n' });
  assert.deepEqual(lines, [{ cls: 'hunk', text: '@@ -1,3 +1,3 @@' }, { cls: 'ctx', text: '  keep' }, { cls: 'del', text: '- old' }, { cls: 'add', text: '+ new' }]);
  assert.deepEqual(patchLines({ kind: 'add', diff: 'a\nb' }), [{ cls: 'add', text: '+ a' }, { cls: 'add', text: '+ b' }]);
  assert.deepEqual(patchLines({ kind: 'delete', diff: 'gone' }), [{ cls: 'del', text: '- gone' }]);
  assert.deepEqual(patchLines({ kind: 'update', diff: '' }), []);
  const html = patchHtml([{ path: '<a>.ts', kind: 'update', move_path: 'b.ts', diff: '@@ -1 +1 @@\n-<x>\n+y' }]);
  assert.ok(html.includes('&lt;a&gt;.ts'), 'the path is escaped');
  assert.ok(html.includes('edited to b.ts'));
  assert.ok(html.includes('<span class="del">- &lt;x&gt;</span>'));
  assert.ok(html.includes('<span class="add">+ y</span>'));
  const big = patchHtml([{ path: 'big.txt', kind: 'add', diff: Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n') }]);
  assert.ok(big.includes('... 100 more lines'));
  assert.equal(patchArgs([{ path: 'C:\\a\\x.ts' }, { path: 'y.ts' }, { path: 'z.ts' }, { path: 'w.ts' }]), 'x.ts, y.ts, z.ts, +1');
  assert.equal(patchArgs(null), '');
  assert.equal(toolArgs('ApplyPatch', { changes: [{ path: 'src/Table.tsx' }] }), 'Table.tsx', 'the tool line names the files');
});

test('the footer under a Codex turn, the loader line without counts, which artifacts are only cards', () => {
  assert.equal(codexFooter({ durationMs: 11800, tokens: 61800 }, { name: 'ChatGPT Plus' }), '11.8s · 61.8k tokens in context · ChatGPT Plus');
  assert.equal(codexFooter({ durationMs: 0, interrupted: true }, null), '0.0s · stopped');
  assert.equal(earlierText({ total: 304, earlier: 0, countless: true }), '304 messages loaded');
  assert.equal(earlierText({ total: 1200, earlier: 900 }), '900 earlier · 1,200 in all', 'Claude\'s wording is unchanged');
  assert.ok(CARD_ONLY_VIA.has('codex-diff') && CARD_ONLY_VIA.has('codex-image'));
  assert.ok(!CARD_ONLY_VIA.has('show'));
});

test('the permission sheet speaks Codex: its buttons, the diff of a patch, the access it asks for', () => {
  const cmd = approvalAsk('item/commandExecution/requestApproval', { itemId: 'i', command: 'npm install', cwd: 'C:\\p', reason: 'Needs network' });
  const view = permissionView({ toolName: cmd.toolName, input: cmd.input, permission: cmd.permission });
  assert.equal(view.question, 'Run this command?');
  assert.deepEqual(view.labels, { once: 'Approve once', always: 'Approve for this session', deny: 'Deny' });
  assert.equal(view.codex, true);
  const html = permissionHtml(view, { from: 'Pricing' });
  assert.ok(html.includes('>Approve once</button>'));
  assert.ok(html.includes('>Approve for this session</button>'));
  assert.ok(html.includes('Approve for this session means'));
  assert.ok(html.includes('Enter: approve once. Esc: deny.'));
  assert.ok(html.includes('Or tell Codex what to do instead'));
  assert.ok(html.includes('npm install'));
  assert.ok(!html.includes('Allow once') && !html.includes('Claude'));

  const item = { type: 'fileChange', id: 'f', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }] };
  const patch = approvalAsk('item/fileChange/requestApproval', { itemId: 'f', reason: 'Write access' }, { item });
  const pv = permissionView({ toolName: patch.toolName, input: patch.input, permission: patch.permission });
  assert.equal(pv.question, 'Apply these changes?');
  assert.equal(pv.blocks[0].kind, 'patch');
  const ph = permissionHtml(pv);
  assert.ok(ph.includes('<pre class="diff perm-diff">'));
  assert.ok(ph.includes('<span class="add">+ b</span>'));
  assert.ok(ph.includes('Write access'));

  const perms = approvalAsk('item/permissions/requestApproval', { itemId: 'p', cwd: 'C:\\p', permissions: { network: { enabled: true } } });
  const rv = permissionView({ toolName: perms.toolName, input: perms.input, permission: perms.permission });
  assert.equal(rv.question, 'Grant more access?');
  assert.ok(permissionHtml(rv).includes('<dt>Network</dt><dd>on</dd>'));
  const many = permissionView({ toolName: 'ApplyPatch', input: { changes: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}`, kind: 'add', diff: 'x' })) }, permission: patch.permission });
  assert.equal(many.blocks[0].changes.length, 8);
  assert.ok(permissionHtml(many).includes('4 more files'));

  // Claude's sheet is as it was.
  const claude = permissionView({ toolName: 'Bash', input: { command: 'npm test' }, permission: { title: 'Claude wants to run npm test', always: { lines: ['Allow Bash(npm test:*)'] } } });
  assert.deepEqual(claude.labels, { once: 'Allow once', always: 'Always allow', deny: 'Deny' });
  assert.equal(claude.codex, false);
  const ch = permissionHtml(claude);
  assert.ok(ch.includes('>Allow once</button>') && ch.includes('>Always allow</button>') && ch.includes('Always allow saves') && ch.includes('Enter allows once. Esc denies.'));
  assert.ok(ch.includes('Or tell Claude what to do instead'));
  assert.equal(denyLabel('x'), 'Deny with note');
  assert.equal(denyLabel('x', 'Not now'), 'Not now with note');
  assert.equal(denyLabel(''), 'Deny');
});

test('the pane and the window are wired for Codex: picks only, no inherited modes, rows, cards and the question sheet', () => {
  const pane = read('apaki', 'ui', 'pane.js');
  assert.ok(pane.includes("this.kind = settings.kind === 'codex' || isCodexId(settings.sessionId) ? 'codex' : 'claude';"));
  // open sends only what was picked in a Codex pane.
  assert.ok(pane.includes("...(this.picked.model ? { model: this.model } : {})"));
  assert.ok(pane.includes("s.id !== this.sessionId) this.setKind('claude')"), 'a restored Codex pane stays Codex when the row has no flag');
  assert.ok(pane.includes("case 'opened':") && pane.includes("if (e.kind === 'codex')"));
  assert.ok(pane.includes("e.codex ? codexFooter(e, this.billing)"));
  assert.ok(pane.includes("if (!e.quiet) this.$.T.append(el('div', 'foot'"));
  const app = read('apaki', 'ui', 'app.js');
  assert.ok(app.includes("case 'codexModels':") && app.includes("case 'codexThreads':"));
  assert.ok(app.includes("S.codexAvailable = Boolean(e.codex);"));
  assert.ok(app.includes("...inheritable(base)"), 'a new Claude pane never takes a Codex pane\'s model');
  assert.ok(!/model: base\?\.model/.test(app), 'every place that copied a pane\'s picks goes through inheritable');
  assert.ok(app.includes("(!CARD_ONLY_VIA.has(e.via) || e.open)"), 'a turn\'s changes are a card, not a viewer that pops up');
  assert.ok(app.includes("q.secret ? 'password' : 'text'"), 'a secret question hides what is typed');
  assert.ok(app.includes("who} has"), 'the question sheet says whose question it is');
  const html = read('apaki', 'ui', 'index.html');
  assert.ok(html.includes('class="kind-mark" hidden>Codex</span>'));
  const css = read('apaki', 'ui', 'app.css');
  for (const sel of ['.kind-mark', '.kind-pick', '.diff .hunk', '.chip.doc', '.chip-btn.mode[data-mode=full-access]']) assert.ok(css.includes(sel), sel);
  // No new px font sizes: the type tokens at the top of app.css are the scale.
  const added = css.slice(css.indexOf('Codex panes (2026-10-12)'));
  assert.ok(!/font-size:\s*\d+(\.\d+)?px/.test(added), 'only type tokens');
  assert.ok(!/font:[^;]*\b\d+(\.\d+)?px\b/.test(added), 'only type tokens in font shorthands');
});

test('the phone builds with the Codex pane: the shared modules ship, nothing of Codex is desktop only', async () => {
  const { build } = await import('../apaki/scripts/build-web.mjs');
  const fsx = await import('node:fs');
  const os = await import('node:os');
  const out = fsx.mkdtempSync(path.join(os.tmpdir(), 'apaki-codex-web-'));
  try {
    const r = build({ relay: 'wss://apaki.myrlin.io', out });
    assert.ok(r, 'the web build runs');
    const names = fsx.readdirSync(out, { recursive: true }).map(String);
    assert.ok(names.some((n) => n.endsWith('codex.js')), 'codex.js ships with the page');
    assert.ok(names.some((n) => n.endsWith('permission.js')));
  } finally { fsx.rmSync(out, { recursive: true, force: true }); }
});
