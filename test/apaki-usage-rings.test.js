/**
 * apaki-usage-rings.test.js: the Glass usage rings (apaki/ui/usage-rings.js, 2026-10-12).
 * Arthur asked for rings for the 5-hour and weekly limits with their timings, details on a click. These check which
 * windows the two rings show (Glass's real labels: "Session", "Weekly", "Weekly Fable", with windowSeconds; Codex's
 * "5-hour" and "Weekly" by label), the countdown and reset texts, and that the markup carries no style attribute.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { heroFor, heroRingHtml, heroWindows, leftOf, pickWindows, resetMs, ringPairHtml, sevOf, untilText, windowSeconds, windowsDetailHtml, worstWindow } from '../apaki/ui/usage-rings.js';

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

/* Glass's hero ring (2026-10-13, apaki/docs/style.md): the Glass card draws each live account the way the Glass widget
   does, so an account reads the same in both apps. */

test('hero: outer the short window, inner the plain weekly one; a per-model weekly gets no ring', () => {
  const glass = [
    { label: 'Weekly Fable', percent: 88, resetsAt: NOW + 100 * H, seconds: 604800 },
    { label: 'Session', percent: 36, resetsAt: NOW + 2 * H, seconds: 18000 },
    { label: 'Weekly', percent: 41, resetsAt: NOW + 77 * H, seconds: 604800 },
  ];
  const { outer, inner } = heroWindows(glass);
  assert.equal(outer.label, 'Session');
  assert.equal(inner.label, 'Weekly');
  const codex = heroWindows([{ label: 'Weekly', percent: 33, resetsAt: 0 }, { label: '5-hour', percent: 29, resetsAt: 0 }]);
  assert.equal(codex.outer.label, '5-hour', 'Codex gives no lengths: the label decides');
  assert.equal(codex.inner.label, 'Weekly');
  assert.deepEqual(heroWindows([{ label: 'Session', percent: 5 }]), { outer: { label: 'Session', percent: 5 }, inner: null });
  assert.deepEqual(heroWindows([]), { outer: null, inner: null });
});

test('hero: Glass\'s severity steps, and the window that matters is the worse one', () => {
  assert.equal(sevOf(74), '');
  assert.equal(sevOf(75), 'warn');
  assert.equal(sevOf(89.9), 'warn');
  assert.equal(sevOf(90), 'crit');
  const a = { label: 'Session', percent: 80 };
  const b = { label: 'Weekly', percent: 92 };
  assert.equal(worstWindow({ outer: a, inner: b }), b);
  assert.equal(worstWindow({ outer: { label: 'Session', percent: 20 }, inner: { label: 'Weekly', percent: 41 } }).label, 'Weekly');
  assert.equal(worstWindow({ outer: null, inner: null }), null);
});

test('hero: the ring, its centre and the line under the name; escaped, and no style attribute', () => {
  const w = [{ label: '<b>Session</b>', percent: 91, resetsAt: NOW + H, seconds: 18000 }, { label: 'Weekly', percent: 20, resetsAt: NOW + 50 * H, seconds: 604800 }];
  const h = heroFor(w, { now: NOW });
  assert.equal(h.sev, 'crit');
  assert.match(h.ring, /class="g-a sev-crit" cx="23" cy="23" r="20\.75" pathLength="100" data-p="91"/, 'the outer arc is the session, red');
  assert.match(h.ring, /class="g-a in" cx="23" cy="23" r="15\.5" pathLength="100" data-p="20"/, 'the inner arc is the week');
  assert.match(h.ring, /<span class="g-pct"><b>91<\/b><i>%<\/i><\/span>/, 'the centre is the window that matters');
  assert.match(h.line, /&lt;b&gt;Session&lt;\/b&gt;<\/span><span class="sep"> · <\/span><span class="num">1h<\/span>/);
  assert.doesNotMatch(h.ring + h.line, /style=/);
  // An account without windows keeps its share left in words; a full ring drops its per cent sign to fit.
  assert.match(heroFor([], { headroom: 62 }).line, /62%<\/span> left/);
  assert.equal(heroFor([], {}).line, '');
  assert.match(heroRingHtml({ outer: 100, center: '100' }), /class="g-pct is-full"><b>100<\/b><\/span>/);
  assert.match(heroRingHtml({ outer: 0 }), /class="g-a is-zero"/, 'an empty arc is hidden, not drawn as a speck');
  assert.match(heroRingHtml({ outer: 40 }), /class="g-ring single"/);
});

test('rings: the small rings carry Glass\'s severity on their arc, the markup is otherwise unchanged', () => {
  const pair = ringPairHtml([{ label: 'Session', percent: 90, resetsAt: NOW + H, seconds: 18000 }, { label: 'Weekly', percent: 76, resetsAt: NOW + 50 * H, seconds: 604800 }], NOW);
  assert.match(pair, /class="u-ring sm low" data-left="10"/);
  assert.match(pair, /<circle class="u-a sev-crit"/);
  assert.match(pair, /<circle class="u-a sev-warn"/);
});
