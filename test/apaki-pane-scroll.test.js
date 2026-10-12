/**
 * A conversation in a background tab opens at its end, not at the top (2026-10-12; found in the last desktop UI pass:
 * "Background tab opens scrolled to the top instead of the end of its conversation"). A background tab is display:
 * none, so its conversation has no box: scrollHeight and clientHeight read 0 and a scrollTop written to it is lost.
 * pane.js now keeps where the reader is while it has no box (scrollMemo) and puts them there when it gets one
 * (settleScroll); the workspace saves that place instead of "at the end, 0". The phone's tabs are the same stages, so
 * the phone has the same fix. A Pane's prototype on a plain object with a ground that can be sized or hidden.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Pane } from '../apaki/ui/pane.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/* a background tab opens at the end */

/** A Pane's prototype on a plain object with a ground that can be sized or hidden (clientHeight 0 is display: none). */
function scrollPane() {
  const ground = { clientHeight: 0, scrollHeight: 0, scrollTop: 0 };
  const style = {};
  const p = Object.create(Pane.prototype);
  Object.assign(p, {
    $: { ground, wrap: { offsetHeight: 120 } }, el: { style: { setProperty: (k, v) => { style[k] = v; } } },
    schedulePin() {},
  });
  // What a box does: content of `h` px in a view of `view` px (scrollTop is clamped to the end like the browser does).
  const show = (view, content) => { ground.clientHeight = view; ground.scrollHeight = content; };
  const hide = () => { ground.clientHeight = 0; ground.scrollHeight = 0; ground.scrollTop = 0; };
  return { p, ground, style, show, hide };
}
const raf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (f) => { f(); return 0; };
after(() => { if (raf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = raf; });

test('pane: a conversation drawn in a hidden tab goes to its end when the tab is first shown (found in the last desktop UI pass)', () => {
  const { p, ground, show } = scrollPane();
  p.settleScroll(); // the observer's first look: no box
  assert.equal(p.hasBox(), false);
  p.scrollDown(true); // history drawn while hidden: nothing to scroll, the end is remembered
  assert.deepEqual(p.scrollState(), { atEnd: true, top: 0 });
  assert.equal(ground.scrollTop, 0);
  show(600, 5000); // the tab is switched to
  p.settleScroll();
  assert.equal(ground.scrollTop, 5000, 'at the end, not the top');
});

test('pane: where the reader was is put back, in a background tab and after a tab was hidden and shown again', () => {
  const { p, ground, style, show, hide } = scrollPane();
  show(600, 5000);
  p.settleScroll();
  ground.scrollTop = 1200; // the reader scrolled up
  p.noteScroll();
  assert.deepEqual(p.scrollState(), { atEnd: false, top: 1200 });
  hide(); // another tab comes to the front
  p.settleScroll();
  assert.deepEqual(p.scrollState(), { atEnd: false, top: 1200 }, 'the workspace saves this, not "at the end, 0"');
  p.scrollDown(); // a reply streams in while hidden: the reader is not dragged to the end
  assert.equal(p.scrollState().atEnd, false);
  show(600, 5400);
  p.settleScroll();
  assert.equal(ground.scrollTop, 1200);
  assert.equal(style['--composer-h'], '120px', 'the composer is measured first, so the end is the real end');
  // At the end when it was hidden: it is at the end of the longer conversation when it comes back.
  ground.scrollTop = 4800;
  p.noteScroll();
  assert.equal(p.scrollState().atEnd, true);
  hide();
  p.settleScroll();
  show(600, 6200);
  p.settleScroll();
  assert.equal(ground.scrollTop, 6200);
});

test('pane: a saved reading place for a pane that is not shown waits until it is; a shown pane is placed at once', () => {
  const hidden = scrollPane();
  hidden.p.settleScroll();
  hidden.p.scrollMemo = { atEnd: false, top: 640 };
  hidden.show(600, 5000);
  hidden.p.settleScroll();
  assert.equal(hidden.ground.scrollTop, 640);
  // renderHistory's restore rule, as written: a box scrolls now, no box keeps it in the memo.
  const src = read('../apaki/ui/pane.js');
  assert.match(src, /if \(this\.hasBox\(\)\) this\.\$\.ground\.scrollTop = this\.restoreScroll\.top;\n\s+else this\.scrollMemo = \{ atEnd: false, top: this\.restoreScroll\.top \};/);
  assert.match(src, /new ResizeObserver\(\(\) => \{ this\.settleScroll\(\); this\.schedulePin\(\); \}\)\.observe\(this\.\$\.ground\)/);
  assert.match(read('../apaki/ui/app.js'), /scroll: p\?\.scrollState \? p\.scrollState\(\) : null/, 'the saved workspace uses the pane\'s own place');
});
