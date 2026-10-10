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
