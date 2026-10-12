/**
 * apaki-tooltip.test.js: the formatting of Apaki's own tooltips (apaki/ui/tooltip.js, 2026-10-12).
 * Arthur: hover popups "are not formatted properly"; they were the browser's plain title boxes. These check that a
 * title's lines become a heading and body, quieter parts and click hints are set apart, keys are drawn as keys,
 * text is escaped, and a structured tooltip (the context meter's) carries its bar without inline style markup.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { formatRich, formatTip } from '../apaki/ui/tooltip.js';

test('tooltip text: one line stays one line; several lines get a heading', () => {
  assert.equal(formatTip('Reasoning effort'), '<div class="tt-line tt-only">Reasoning effort</div>');
  const html = formatTip('fix-checkout\nC:\\code\\acme.worktrees\\fix-checkout\n+11 -2 in 3 files');
  assert.match(html, /^<div class="tt-head">fix-checkout<\/div><div class="tt-line">C:\\code/);
  assert.equal((html.match(/tt-line/g) || []).length, 2);
  assert.equal(formatTip(''), '');
  assert.equal(formatTip(null), '');
});

test('tooltip text: parts after " · " are quieter, and what a click does moves to a hint at the end', () => {
  const html = formatTip('Plan mode: Claude plans before it acts · Shift+Tab to cycle');
  // A shortcut is a how-to: it moves to the hint line, as one unbreakable combination.
  assert.match(html, /^<div class="tt-line tt-only">Plan mode: Claude plans before it acts<\/div><div class="tt-hint"><span class="tt-keys"><kbd>Shift<\/kbd><span class="tt-plus">\+<\/span><kbd>Tab<\/kbd><\/span> to cycle<\/div>$/);
  assert.match(formatTip('Saved 2m ago · 3 files'), /<span class="tt-q"> · 3 files<\/span>/, 'other parts stay, quieter');
  const billing = formatTip('Billing: Claude Max (follows Myrlin Glass) · click to change');
  assert.match(billing, /<div class="tt-line tt-only">Billing: Claude Max \(follows Myrlin Glass\)<\/div><div class="tt-hint">Click to change<\/div>$/);
  const glass = formatTip('Claude: Work (Max 20x)\n5h: 34% used\nClick to switch account');
  assert.match(glass, /<div class="tt-head">Claude: Work \(Max 20x\)<\/div><div class="tt-line">5h: 34% used<\/div><div class="tt-hint">Click to switch account<\/div>/);
});

test('tooltip text: keys are drawn as keys, words that only look like keys are not, and markup is escaped', () => {
  assert.match(formatTip('Send (Enter)'), /Send \(<kbd>Enter<\/kbd>\)/);
  assert.match(formatTip('Ctrl+Enter steers it in now'), /<kbd>Ctrl<\/kbd><span class="tt-plus">\+<\/span><kbd>Enter<\/kbd>/);
  assert.match(formatTip('Toggle the sidebar (Ctrl+B)'), /<kbd>Ctrl<\/kbd><span class="tt-plus">\+<\/span><kbd>B<\/kbd>/);
  assert.doesNotMatch(formatTip('Press Enter to send'), /<kbd>/, 'a bare Enter in a sentence stays a word');
  const evil = formatTip('<img src=x onerror=alert(1)> "quoted" & more');
  assert.doesNotMatch(evil, /<img/);
  assert.match(evil, /&lt;img src=x onerror=alert\(1\)&gt; &quot;quoted&quot; &amp; more/);
});

test('tooltip card: heading, meter, rows, lines and hint; the fill comes from script, not a style attribute', () => {
  const html = formatRich({ head: 'Context 34%', meter: 0.34, tone: 'warm', rows: [['Used', '68k of 200k tokens']], lines: ['Claude Code compacts it on its own near 92%.'], hint: 'Click for the breakdown' });
  assert.match(html, /<div class="tt-head">Context 34%<\/div>/);
  assert.match(html, /<div class="tt-meter warm" data-v="0\.340"><i><\/i><\/div>/);
  assert.match(html, /<span class="tt-k">Used<\/span><span class="tt-v">68k of 200k tokens<\/span>/);
  assert.match(html, /<div class="tt-hint">Click for the breakdown<\/div>$/);
  assert.doesNotMatch(html, /style=/, 'the phone page CSP refuses style attributes in markup');
  assert.match(formatRich({ meter: 7 }), /data-v="1\.000"/, 'clamped');
  assert.equal(formatRich({ head: '<b>x</b>' }), '<div class="tt-head">&lt;b&gt;x&lt;/b&gt;</div>');
});

test('tooltip styles: type tokens only, no left stripe, no dot', () => {
  const css = fs.readFileSync(new URL('../apaki/ui/app.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('/* ---------- tooltips (tooltip.js'));
  assert.ok(block.length > 500);
  assert.deepEqual([...block.matchAll(/font(-size)?:[^;]*?\d+(\.\d+)?px/g)].map((m) => m[0]), []);
  assert.doesNotMatch(block, /border-left|border-radius: 50%/);
  assert.match(block, /pointer-events: none/);
  assert.match(block, /prefers-reduced-motion/);
});
