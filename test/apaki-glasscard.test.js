/**
 * The Glass card's account logic (apaki/ui/glasscard.js): what is left in
 * words and as a share, and the switch menu (subscriptions, then API keys
 * tagged as such, unusable accounts dimmed with the reason).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountItems, leftShare, leftText } from '../apaki/ui/glasscard.js';

const sub = (id, name, headroom, state = 'ok', extra = {}) => ({ id, name, plan: 'Max 20x', isKey: false, state, headroom, windows: [], active: false, detail: '', ...extra });
const key = (id, name, leftUsd, extra = {}) => ({ id, name, plan: 'API key', isKey: true, state: 'ok', headroom: null, leftUsd, creditUsd: 200, windows: [], active: false, detail: '', ...extra });

test('left: dollars for a key, a percentage for a subscription', () => {
  assert.equal(leftText(key('a', 'blitzen', 190.59)), '$191 left');
  assert.equal(leftText(key('a', 'yahoo', 12.4)), '$12.40 left');
  assert.equal(leftText(sub('s', 'Work', 62)), '62% left');
  assert.equal(leftText(sub('s', 'Work', null)), '');
  assert.equal(leftShare(key('a', 'k', 50)), 25);
  assert.equal(leftShare(sub('s', 'Work', 140)), 100);
  assert.equal(leftShare(sub('s', 'Work', null)), null);
});

test('Claude menu: subscriptions by what is left, then keys tagged API key; sign-in-needed ones dimmed', () => {
  const items = accountItems('claude', [
    key('k1', 'yahoo', 12.4), sub('s1', 'Low', 8), sub('s2', 'Dead', 100, 'needsLogin', { detail: 'Workbook could not renew this login' }), sub('s3', 'High', 62, 'ok', { active: true }), key('k2', 'blitzen', 190),
  ]);
  const shown = items.map((it) => it.heading || it.value || (it.divider ? 'divider' : ''));
  assert.deepEqual(shown, ['Claude subscriptions', 's3', 's1', 's2', 'Claude API keys · billed per token', 'k2', 'k1', 'divider', '__refresh']);
  const dead = items.find((it) => it.value === 's2');
  assert.equal(dead.disabled, 'Workbook could not renew this login');
  assert.equal(dead.hint, 'sign in again in Glass');
  assert.equal(items.find((it) => it.value === 's3').checked, true);
  assert.match(items.find((it) => it.value === 'k2').html, /class="key-tag">API key</);
  assert.equal(items.find((it) => it.value === 'k2').hint, '$190 left');
  assert.equal(items.find((it) => it.value === 's1').hint, 'Max 20x · 8% left');
});

test('Codex menu and an empty list', () => {
  assert.equal(accountItems('codex', [sub('c1', 'arthur', 3)])[0].heading, 'Codex accounts');
  const empty = accountItems('codex', []);
  assert.equal(empty[0].disabled, true);
  assert.equal(empty.at(-1).value, '__refresh');
});

test('the card row in Glass\'s manner: provider, name, the line that matters; a key says so in words', async () => {
  const { heroRowHtml } = await import('../apaki/ui/glasscard.js');
  const H = 3600 * 1000;
  const live = sub('s1', 'Work', 59, 'ok', { windows: [{ label: 'Session', percent: 36, resetsAt: Date.now() + 2 * H, seconds: 18000 }, { label: 'Weekly', percent: 41, resetsAt: Date.now() + 77 * H, seconds: 604800 }] });
  const row = heroRowHtml('claude', live);
  assert.match(row, /^<button class="gc-row hero" data-p="claude"/, 'the demo and the scenes find rows by data-p');
  assert.match(row, /<span class="gc-prov">Claude<\/span>/);
  assert.match(row, /<span class="gc-n">Work<\/span><span class="gc-plan">Max 20x<\/span>/);
  assert.match(row, /<b>41<\/b>/, 'the weekly window matters most here');
  assert.match(row, /<span class="lbl">Weekly<\/span>/);
  assert.doesNotMatch(row, /style=/);
  const k = heroRowHtml('claude', key('k', 'Acme <Console>', 150));
  assert.match(k, /class="gc-row hero is-key"/);
  assert.match(k, /<span class="gc-prov">Claude · API key<\/span>/);
  assert.match(k, /Acme &lt;Console&gt;/);
  assert.match(k, /\$150 left/);
  assert.match(k, /<b>25<\/b>/, 'a quarter of the credit spent');
  assert.match(heroRowHtml('codex', live, true), /class="g-line">Switching…</);
  assert.match(heroRowHtml('claude', sub('d', 'Dead', 10, 'needsLogin')), /class="g-line is-bad">sign in again in Glass</);
  assert.match(heroRowHtml('codex', null), /Not signed in/);
});
