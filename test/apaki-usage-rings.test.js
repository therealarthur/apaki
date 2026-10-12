/**
 * apaki-usage-rings.test.js: the Glass usage rings (apaki/ui/usage-rings.js, 2026-10-12).
 * Arthur asked for rings for the 5-hour and weekly limits with their timings, details on a click. These check which
 * windows the two rings show (Glass's real labels: "Session", "Weekly", "Weekly Fable", with windowSeconds; Codex's
 * "5-hour" and "Weekly" by label), the countdown and reset texts, and that the markup carries no style attribute.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { leftOf, pickWindows, resetMs, ringPairHtml, untilText, windowSeconds, windowsDetailHtml } from '../apaki/ui/usage-rings.js';

const H = 3600 * 1000;
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

test('rings: the short ring is the tightest window of 6 hours or less, the long one the tightest of 4 days or more', () => {
  const glass = [
    { label: 'Session', percent: 36, resetsAt: new Date(NOW + 2 * H).toISOString(), seconds: 18000 },
    { label: 'Weekly', percent: 41, resetsAt: new Date(NOW + 77 * H).toISOString(), seconds: 604800 },
    { label: 'Weekly Fable', percent: 88, resetsAt: new Date(NOW + 100 * H).toISOString(), seconds: 604800 },
  ];
  const { short, long } = pickWindows(glass);
  assert.equal(short.label, 'Session');
  assert.equal(long.label, 'Weekly Fable', 'the tightest weekly window');
  // Codex names them and gives no length: the label decides.
  const codex = pickWindows([{ label: '5-hour', percent: 29, resetsAt: 0 }, { label: 'Weekly', percent: 33, resetsAt: 0 }]);
  assert.equal(codex.short.label, '5-hour');
  assert.equal(codex.long.label, 'Weekly');
  assert.deepEqual(pickWindows([]), { short: null, long: null });
  assert.equal(windowSeconds({ label: 'something else' }), null);
  assert.equal(leftOf({ percent: 36 }), 64);
  assert.equal(leftOf({ percent: 140 }), 0);
});

test('rings: countdowns read short and drop zero parts; resets accept ISO, milliseconds and seconds', () => {
  assert.equal(untilText(new Date(NOW + 38 * 60000).toISOString(), NOW), '38m');
  assert.equal(untilText(NOW + 2 * H + 14 * 60000, NOW), '2h 14m');
  assert.equal(untilText(NOW + 3 * H, NOW), '3h');
  assert.equal(untilText(NOW + 77 * H, NOW), '3d 5h');
  assert.equal(untilText(NOW + 120 * H, NOW), '5d');
  assert.equal(untilText(NOW - 1000, NOW), 'now');
  assert.equal(untilText(null, NOW), '');
  assert.equal(resetMs(1791800000), 1791800000000, 'epoch seconds (Codex)');
  assert.equal(resetMs(1791800000000), 1791800000000);
  assert.equal(resetMs('not a date'), null);
});

test('rings: the card pair and the panel details are escaped and carry no style attribute', () => {
  const w = [{ label: '<b>Session</b>', percent: 90, resetsAt: NOW + H, seconds: 18000 }, { label: 'Weekly', percent: 20, resetsAt: NOW + 50 * H, seconds: 604800 }];
  const pair = ringPairHtml(w, NOW);
  assert.match(pair, /class="u-ring sm low" data-left="10"/, 'ten left: low');
  assert.match(pair, /<span class="u-until">1h<\/span>/);
  assert.match(pair, /<span class="u-until">2d 2h<\/span>/);
  assert.doesNotMatch(pair, /style=/);
  const detail = windowsDetailHtml(w, NOW);
  assert.match(detail, /&lt;b&gt;Session&lt;\/b&gt;/);
  assert.doesNotMatch(detail, /<b>Session/);
  assert.match(detail, /90% used · resets/);
  assert.doesNotMatch(detail, /style=/);
  assert.equal(ringPairHtml([], NOW), '');
  assert.equal(windowsDetailHtml([], NOW), '');
});
