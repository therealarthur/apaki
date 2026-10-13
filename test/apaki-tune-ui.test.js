/**
 * The effort popup with Ultracode (apaki/ui/tune.js, menu.js, pane.js, app.js, app.css), 2026-10-13: the pure parts. The window and
 * the phone page share these files, so one set of checks covers both. What the popup holds for a Claude pane and for a Codex
 * pane, what a pick means, how the chip says Ultracode is on, and that the pane, the workspace and the page are wired to it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODEX_NO_ULTRA_LINE, CODEX_ULTRA_LINE, EFFORT_HINTS, PICK_ULTRACODE, SUMMARIES, ULTRACODE_LINE, UNAVAILABLE_LINE, WORKFLOW_SIZES, chipExtra, chipExtraHtml, chipTitle, claudeEffortMenu, claudePick,
  claudeTune, codexEffortMenu, codexPick, codexTune, speedChoices, tuneChange, tuneFor, ultracodeLock,
} from '../apaki/ui/tune.js';
import { EFFORTS } from '../apaki/ui/menu.js';
import * as engine from '../apaki/engine/tune.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const rowsOf = (rows) => rows.filter((r) => !r.divider);
const labels = (rows) => rows.map((r) => r.value || r.label || (r.note ? 'note' : r.divider ? '---' : '?'));

test('the Claude popup: the five efforts with Max, then Ultracode off with its one line, and no size row until it is on', () => {
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
  const rows = claudeEffortMenu({ effort: 'xhigh', tune: null });
  assert.deepEqual(labels(rows), ['low', 'medium', 'high', 'xhigh', 'max', '---', PICK_ULTRACODE, 'note']);
  assert.deepEqual(rows.filter((r) => r.checked).map((r) => r.value), ['xhigh'], 'only the effort is checked while Ultracode is off');
  assert.equal(rows.find((r) => r.value === 'max').hint, EFFORT_HINTS.max);
  const uc = rows.find((r) => r.value === PICK_ULTRACODE);
  assert.equal(uc.keep, true, 'a toggle leaves the popup open');
  assert.equal(uc.hint, 'Off');
  assert.equal(uc.disabled, false);
  assert.match(uc.html, />Ultracode</);
  assert.equal(rows.at(-1).note, ULTRACODE_LINE);
  assert.ok(ULTRACODE_LINE.length <= 100 && !ULTRACODE_LINE.includes('\n'), 'one short line');
});

test('Ultracode on checks the row and brings the workflow size: Small, Medium, Large, No limit', () => {
  const rows = claudeEffortMenu({ effort: 'high', tune: { ultracode: true, size: null } });
  const toggle = rows.find((r) => r.value === PICK_ULTRACODE);
  assert.equal(toggle.checked, true);
  assert.equal(toggle.hint, '', 'the check mark says it, not a word');
  const seg = rows.find((r) => r.seg);
  assert.equal(seg.label, 'Workflow size');
  assert.deepEqual(seg.seg.map((s) => s.label), ['Small', 'Medium', 'Large', 'No limit']);
  assert.deepEqual(seg.seg.map((s) => s.value), ['size:small', 'size:medium', 'size:large', 'size:unrestricted']);
  assert.equal(seg.seg.some((s) => s.checked), false, 'no size picked: Claude Code\'s own default');
  assert.match(rows.at(-1).note, /Medium, Small on a Pro plan/);
  const sized = claudeEffortMenu({ effort: 'high', tune: { ultracode: true, size: 'large' } });
  assert.deepEqual(sized.find((r) => r.seg).seg.filter((s) => s.checked).map((s) => s.label), ['Large']);
  assert.match(sized.at(-1).note, /fewer than 50 agents/);
  assert.deepEqual(WORKFLOW_SIZES.map((s) => s.value), engine.WORKFLOW_SIZES, 'the popup and the engine take the same sizes');
});

test('a pick means: an effort, the Ultracode flip, a size (again for the default); nothing else is a pick', () => {
  assert.deepEqual(claudePick('max', null), { effort: 'max' });
  assert.deepEqual(claudePick(PICK_ULTRACODE, null), { tune: { ultracode: true } });
  assert.deepEqual(claudePick(PICK_ULTRACODE, { ultracode: true }), { tune: { ultracode: false } });
  assert.deepEqual(claudePick('size:small', { ultracode: true }), { tune: { size: 'small' } });
  assert.deepEqual(claudePick('size:small', { ultracode: true, size: 'small' }), { tune: { size: null } }, 'the chosen size again goes back to the default');
  assert.equal(claudePick('size:huge', null), null);
  assert.equal(claudePick('turbo', null), null);
  assert.equal(claudePick(undefined, null), null);
});

test('a change moves only the keys it names; switching Ultracode off keeps the size and clears "cannot run it"', () => {
  const on = tuneChange('claude', null, { ultracode: true });
  assert.deepEqual(on, { ultracode: true, size: null });
  assert.deepEqual(tuneChange('claude', on, { size: 'medium' }), { ultracode: true, size: 'medium' });
  const waiting = { ultracode: true, size: 'large', available: false };
  assert.deepEqual(tuneChange('claude', waiting, { size: 'small' }), { ultracode: true, size: 'small', available: false });
  assert.deepEqual(tuneChange('claude', waiting, { ultracode: false }), { ultracode: false, size: 'large' });
  assert.deepEqual(tuneFor('codex', { ultracode: true }), { summary: null, speed: null });
  assert.deepEqual(tuneFor('claude', { summary: 'none' }), { ultracode: false, size: null });
  assert.deepEqual(claudeTune({ ultracode: true, size: 'nope' }), { ultracode: true, size: null });
});

test('when the engine says the model cannot run Ultracode, the popup says it waits', () => {
  const rows = claudeEffortMenu({ effort: 'high', tune: { ultracode: true, available: false } });
  assert.ok(rows.some((r) => r.note === UNAVAILABLE_LINE));
  assert.equal(rows.some((r) => r.note === ULTRACODE_LINE), false, 'the usual line gives way to this one');
  assert.match(chipTitle('claude', 'high', { ultracode: true, available: false }), /waiting for a model that can run it/);
});

test('a phone below Full access sees Ultracode dimmed with the reason, and no size row', () => {
  assert.equal(ultracodeLock('full'), null);
  assert.equal(ultracodeLock(undefined), null);
  assert.match(ultracodeLock('chat'), /^Chat only/);
  assert.match(ultracodeLock('noshell'), /^No shell/);
  for (const cap of ['chat', 'noshell']) {
    const lock = ultracodeLock(cap);
    const rows = claudeEffortMenu({ effort: 'high', tune: { ultracode: true, size: 'large' }, lock });
    const toggle = rows.find((r) => r.value === PICK_ULTRACODE);
    assert.equal(toggle.disabled, lock, 'dimmed, with the reason as its tooltip');
    assert.equal(toggle.checked, false);
    assert.equal(rows.some((r) => r.seg), false);
    assert.equal(rows.at(-1).note, lock, 'the reason stands where the explanation was (a phone has no tooltips)');
  }
});

test('the chip: "+ ultracode" after the effort when it is on (a shorter word in a narrow box), nothing otherwise', () => {
  assert.equal(chipExtra('claude', null), null);
  assert.equal(chipExtra('claude', { ultracode: false, size: 'large' }), null);
  assert.deepEqual(chipExtra('claude', { ultracode: true }), { full: '+ ultracode', short: '+ ultra' });
  const html = chipExtraHtml(chipExtra('claude', { ultracode: true }));
  assert.match(html, /class="uc-full">\+ ultracode</);
  assert.match(html, /class="uc-short">\+ ultra</);
  assert.equal(chipExtraHtml(null), '');
  assert.ok(!/<i|dot|pill/.test(html), 'a word, never a dot or a capsule');
  assert.equal(chipTitle('claude', 'xhigh', null), 'Effort: xhigh');
  assert.equal(chipTitle('claude', 'max', { ultracode: true, size: 'small' }), 'Effort: max, Ultracode on (small workflows)');
});

const GPT = {
  id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol',
  efforts: [['low', 'Fast'], ['medium', 'Balanced'], ['high', 'Deep'], ['xhigh', 'Deeper'], ['max', 'Deepest'], ['ultra', 'Maximum reasoning with automatic task delegation']].map(([value, description]) => ({ value, description })),
  serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
};
const LUNA = { id: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low', 'medium', 'high'].map((value) => ({ value, description: '' })), serviceTiers: [] };

test('the Codex popup: the model\'s own efforts with Ultra, the reasoning summary, the speed it lists, and the line on Ultracode', () => {
  const rows = codexEffortMenu({ model: GPT, effort: 'ultra', tune: null });
  assert.deepEqual(rows.slice(0, 6).map((r) => r.value), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(rows.find((r) => r.value === 'ultra').checked, true);
  assert.equal(rows.find((r) => r.value === 'ultra').hint, 'Maximum reasoning with automatic task delegation');
  const [summary, speed] = rows.filter((r) => r.seg);
  assert.equal(summary.label, 'Reasoning summary');
  assert.deepEqual(summary.seg.map((s) => s.label), ['Auto', 'Short', 'Detailed', 'Off']);
  assert.deepEqual(summary.seg.map((s) => s.value), ['summary:auto', 'summary:concise', 'summary:detailed', 'summary:none']);
  assert.deepEqual(summary.seg.filter((s) => s.checked).map((s) => s.label), ['Auto'], 'nothing picked: the turn asks for auto');
  assert.equal(speed.label, 'Speed');
  assert.deepEqual(speed.seg.map((s) => s.label), ['Standard', 'Fast']);
  assert.deepEqual(speed.seg.filter((s) => s.checked).map((s) => s.label), ['Standard']);
  assert.equal(rows.some((r) => r.note === '2x speed, increased usage' || r.note === 'The usual speed and usage'), true);
  assert.equal(rows.at(-1).note, CODEX_ULTRA_LINE);
  assert.match(CODEX_ULTRA_LINE, /no Ultracode switch/i);
  assert.match(CODEX_ULTRA_LINE, /Ultra above is its version/);
  assert.equal(rows.some((r) => r.value === PICK_ULTRACODE), false, 'no invented toggle');
  assert.deepEqual(summary.seg.map((s) => s.value.slice('summary:'.length)), engine.SUMMARIES, 'the popup and the engine take the same summaries');
  assert.deepEqual(SUMMARIES.map((s) => s.value), engine.SUMMARIES);
});

test('a Codex model without Ultra or faster tiers: no speed row, and the line says there is no Ultracode here', () => {
  const rows = codexEffortMenu({ model: LUNA, effort: 'high', tune: { summary: 'detailed' } });
  assert.deepEqual(rows.filter((r) => r.value).map((r) => r.value), ['low', 'medium', 'high']);
  assert.equal(rows.filter((r) => r.seg).length, 1, 'only the summary');
  assert.deepEqual(rows.find((r) => r.seg).seg.filter((s) => s.checked).map((s) => s.label), ['Detailed']);
  assert.equal(rows.at(-1).note, CODEX_NO_ULTRA_LINE);
  assert.deepEqual(speedChoices(LUNA).map((s) => s.value), ['default']);
  assert.deepEqual(speedChoices(GPT).map((s) => s.value), ['default', 'priority']);
});

test('the Codex speed shown is the pane\'s pick, else what the user\'s own Codex config starts with, else Standard', () => {
  const checked = (rows) => rows.filter((r) => r.seg).at(-1).seg.filter((s) => s.checked).map((s) => s.label);
  assert.deepEqual(checked(codexEffortMenu({ model: GPT, effort: 'low', tune: { speed: 'priority' } })), ['Fast']);
  assert.deepEqual(checked(codexEffortMenu({ model: GPT, effort: 'low', tune: null, defaults: { speed: 'priority' } })), ['Fast']);
  assert.deepEqual(checked(codexEffortMenu({ model: GPT, effort: 'low', tune: null, defaults: { speed: 'turbo' } })), ['Standard'], 'a tier the model does not list is not shown as chosen');
  assert.deepEqual(checked(codexEffortMenu({ model: GPT, effort: 'low', tune: { speed: 'default' }, defaults: { speed: 'priority' } })), ['Standard']);
});

test('Codex picks: an effort, a summary, a speed', () => {
  assert.deepEqual(codexPick('ultra'), { effort: 'ultra' });
  assert.deepEqual(codexPick('summary:none'), { tune: { summary: 'none' } });
  assert.deepEqual(codexPick('speed:priority'), { tune: { speed: 'priority' } });
  assert.deepEqual(codexPick('speed:default'), { tune: { speed: 'default' } });
  assert.equal(codexPick('summary:loud'), null);
  assert.equal(codexPick('speed:Fast!'), null);
  assert.equal(codexPick(''), null);
  assert.equal(codexPick(null), null);
  assert.deepEqual(codexTune({ summary: 'concise', speed: 'priority' }), { summary: 'concise', speed: 'priority' });
  assert.deepEqual(tuneChange('codex', { summary: 'none', speed: 'priority' }, { speed: null }), { summary: 'none', speed: null });
});

test('the Codex chip says "+ fast" for a faster speed and nothing for standard or none', () => {
  assert.equal(chipExtra('codex', null, { model: GPT }), null);
  assert.equal(chipExtra('codex', { speed: 'default' }, { model: GPT }), null);
  assert.deepEqual(chipExtra('codex', { speed: 'priority' }, { model: GPT }), { full: '+ fast', short: '+ fast' });
  assert.equal(chipTitle('codex', 'ultra', { speed: 'priority' }, { model: GPT }), 'Reasoning effort: ultra, fast speed');
  assert.equal(chipTitle('codex', 'low', null), 'Reasoning effort: low');
});

/* ---------- the wiring (read from the source, like the other window tests) ---------- */

test('the pane builds its popup from tune.js, keeps the tune, sends it with open, and hears the engine\'s word', () => {
  const pane = read('apaki', 'ui', 'pane.js');
  assert.match(pane, /from '\.\/tune\.js'/);
  assert.match(pane, /this\.\$\.effort\.onclick = \(\) => \(this\.kind === 'codex' \? this\.codexMenu\('effort'\) : this\.effortMenu\(\)\)/);
  assert.match(pane, /claudeEffortMenu\(\{ effort: this\.effort, tune: this\.tune, lock: ultracodeLock\(this\.host\.phoneCap/);
  assert.match(pane, /codexEffortMenu\(\{ model: findModel/);
  assert.match(pane, /popup\.update\?\.\(rows\(\)\)/, 'a tune pick repaints the open popup');
  assert.match(pane, /setTune\(change\) \{[\s\S]*?this\.send\('tune', change\)/);
  assert.match(pane, /tune: \{ ultracode: this\.tune\?\.ultracode === true, size: this\.tune\?\.size \|\| null \}/, 'a Claude open carries the tune');
  assert.match(pane, /case 'settings':[\s\S]*?if \(e\.tune\) this\.tune = tuneFor\(this\.kind, e\.tune\)/);
  assert.match(pane, /chipExtraHtml\(chipExtra\('claude', this\.tune\)\)/);
  assert.match(pane, /chipExtraHtml\(chipExtra\('codex', this\.tune/);
  assert.equal(/^const EFFORT_HINTS/m.test(pane), false, 'the hints live in tune.js now');
});

test('the window keeps the tune in the saved workspace, hands new panes the workflow size but never Ultracode itself, and tells the popup its access', () => {
  const app = read('apaki', 'ui', 'app.js');
  assert.match(app, /tune: p\?\.tune \|\| null/);
  assert.equal((app.match(/tune: lf\.tune/g) || []).length, 2, 'both ways a saved pane comes back');
  assert.match(app, /const inheritable = [^\n]*tune: \{ ultracode: false, size: base\.tune\?\.size \|\| null \}/);
  assert.match(app, /phoneCap: \(\) => phoneCap\(\)/);
  assert.match(app, /defaults: \{[^}]*tune: \{ ultracode: false, size: null \}/);
});

test('the stylesheet draws the notes, the segmented rows and the chip word with type tokens and no capsule or dot', () => {
  const css = read('apaki', 'ui', 'app.css');
  for (const sel of ['.menu-note', '.menu-seg-label', '.menu-seg', '.menu-seg-item', '.chip-btn.effort .uc', '.chip-btn.effort .uc-short']) assert.ok(css.includes(sel), sel);
  const block = css.slice(css.indexOf('/* The effort popup holds settings'), css.indexOf('.chip-btn.effort .uc-short { display: inline; }') + 60);
  assert.ok(block.length > 400);
  assert.equal(/font(-size)?:[^;]*\d+px/.test(block), false, 'no new px font sizes');
  assert.equal(/border-radius:\s*(999|50%)/.test(block), false, 'no capsule');
  assert.match(block, /@container composer \(max-width: 480px\)/);
});

test('menu.js knows keep, note and seg rows and repaints with update(); a plain item still closes the menu', () => {
  const menu = read('apaki', 'ui', 'menu.js');
  assert.match(menu, /if \(!it\.keep\) closeMenu\(\); onPick\?\.\(it\.value, it\)/);
  assert.match(menu, /className: 'menu-note'/);
  assert.match(menu, /className: 'menu-seg'/);
  assert.match(menu, /el\.update = \(next\) =>/);
});

test('the phone builds with the popup: tune.js ships with the other window modules', () => {
  const buildWeb = read('apaki', 'scripts', 'build-web.mjs');
  assert.match(buildWeb, /uiFiles = \(\) => fs\.readdirSync\(UI\)/, 'every window module is copied');
  assert.ok(fs.existsSync(path.join(ROOT, 'apaki', 'ui', 'tune.js')));
  assert.equal(/from '\.\.\/engine/.test(read('apaki', 'ui', 'tune.js')), false, 'a window module never imports the engine');
});
