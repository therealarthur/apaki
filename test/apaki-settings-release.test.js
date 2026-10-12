/**
 * "Free hidden conversations" in the Settings sheet (apaki/ui/settings.js, 2026-10-12): a row of choices that follows the
 * engine's releaseHidden event, asks for it when the sheet opens, and is left out on the phone (it is the PC's).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initSettings } from '../apaki/ui/settings.js';

function sheetRig(opts = {}) {
  const sent = [];
  let root = null;
  const fakeRoot = { innerHTML: '', querySelectorAll: () => [], querySelector: () => ({}) };
  const sheet = (html, cb) => { root = { querySelector: () => fakeRoot }; cb(root, () => {}); };
  const settings = initSettings({
    button: null, sheet, send: (op, args) => sent.push([op, args]), theme: null, themeUi: {}, sound: { on: () => true, set() {} }, indexText: () => 'ready',
    ...opts,
  });
  return { settings, sent, html: () => fakeRoot.innerHTML };
}

// window is not defined in node: the sheet adds a key handler to it.
globalThis.window ||= { addEventListener() {}, removeEventListener() {} };

test('the row asks for the setting when the sheet opens and shows the engine\'s answer', () => {
  const r = sheetRig();
  r.settings.open();
  assert.ok(r.sent.some(([op]) => op === 'releaseHidden'), 'asks the engine');
  assert.match(r.html(), /Free hidden conversations/);
  assert.match(r.html(), /data-seg="release"/);
  for (const label of ['Off', '5 min', '15 min', '30 min', '1 h']) assert.ok(r.html().includes(`>${label}<`) || r.html().includes(label), label);
  r.settings.handle({ ev: 'releaseHidden', value: 30, choices: [0, 5, 15, 30, 60], standard: 15 });
  assert.match(r.html(), /aria-checked="true" class="on" data-v="30"/);
  r.settings.handle({ ev: 'releaseHidden', value: 0 });
  assert.match(r.html(), /aria-checked="true" class="on" data-v="0"/);
});

test('the phone client leaves the row out and never asks', () => {
  const r = sheetRig({ release: false, compact: false, warm: false });
  r.settings.open();
  assert.ok(!r.sent.some(([op]) => op === 'releaseHidden'));
  assert.doesNotMatch(r.html(), /Free hidden conversations/);
});
