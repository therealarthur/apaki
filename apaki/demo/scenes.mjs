/**
 * scenes.mjs: the named scenes of Apaki's demo harness, and the director that
 * runs them.
 *
 * A scene is a short, scripted piece of the real desktop UI running on demo
 * data: a sequence of timed UI actions (a pointer gliding to a button, a
 * click, typing at a human pace, a scroll) and, through the demo engine, the
 * events the PC would send back. The director drives a Playwright `page`
 * that has the harness open (capture.mjs does that; see README.md).
 *
 * Every scene starts from a named workspace (ws, in harness/data.mjs PRESETS)
 * and does its own setup first. Whatever happens before `s.begin()` is cut
 * from the video; the clip is what happens between begin() and the end of
 * run(). Aim for 8 to 14 seconds.
 *
 *   import { SCENES, runScene } from './scenes.mjs';
 *   const result = await runScene(page, 'steer', { stills: true });
 *
 * The director API (the `s` in run(s)):
 *   begin()                      marks the start of the clip
 *   pause(ms)                    a calm beat
 *   move(target, { ms })         glides the pointer; target is a selector, a Locator or { x, y }
 *   click(target, opts)          glides, then clicks ({ shift, right, ms })
 *   type(text, { ms })           types at a human pace (about 55 ms a key, with small swings)
 *   press(key)                   one key or chord, e.g. 'Enter', 'Control+Enter'
 *   scrollTo(selector, y, ms)    eased scroll of an element
 *   scrollToElement(find, opts)  eased scroll of the focused transcript to an element ({ sel, text })
 *   waitFor(fn, arg, timeout)    waits in the page until fn(arg) is truthy
 *   evaluate(fn, arg)            runs a function in the page
 *   still(label, opts)           a PNG (only in a stills run); { cursor: true } keeps the pointer in it
 *
 * Paired scenes (2026-10-12): a scene with `pair: { device, ws }` runs on two pages at once, the desktop window
 * and the phone client, recorded together and cut at the same instant, so the page can play both in step. Its
 * run(s, p) gets a director for each; s.begin() marks the start for both.
 *
 * Close-ups (2026-10-12): a scene with `crop: { x, y, w, h }` (CSS pixels of the window) is recorded by capture.mjs
 * at 2x with a screencast and cut to that rectangle, so text stays sharp on 2x screens; its stills are cropped the
 * same way. The scenes at the end of SCENES reuse the run() of a full scene (or a small variant of it).
 */

import { HANDOFF, ID } from './harness/data.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MOUSE_FRAME_MS = 9;

/** A small seeded generator, so typing rhythm and pointer arcs repeat from run to run. */
function lcg(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

class Director {
  constructor(page, { stills = false, onStill = null, clip = null } = {}) {
    this.page = page;
    this.stillsOn = stills;
    this.onStill = onStill;
    // A close-up scene's stills (2026-10-12): null (the whole window), a rectangle { x, y, w, h } in CSS pixels, or
    // { each: selector, names: [...], at: label } for one picture per element (the grid's panes), sorted top to bottom, left to right.
    this.clip = clip;
    this.rng = lcg(11);
    this.pos = { x: 1160, y: 700 };
    this.bend = 1;
    this.beganAt = null;
    this.t0 = 0;
    this.log = [];
  }

  /** The clip starts here. Everything before it is setup. */
  async begin() {
    await sleep(250);
    this.beganAt = Date.now();
    this.t0 = performance.now();
  }

  seconds() { return this.beganAt == null ? 0 : (performance.now() - this.t0) / 1000; }

  note(what) { this.log.push({ at: Number(this.seconds().toFixed(2)), what }); }

  pause(ms) { return sleep(ms); }

  loc(target) { return typeof target === 'string' ? this.page.locator(target).first() : target; }

  /** The point a target stands for: the middle of its box, nudged by dx, dy. */
  async point(target, { dx = 0, dy = 0 } = {}) {
    if (target && typeof target.x === 'number') return { x: target.x + dx, y: target.y + dy };
    const loc = this.loc(target);
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    const b = await loc.boundingBox();
    if (!b) throw new Error('no box for a target');
    return { x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 + dy };
  }

  /** An eased glide along a gentle arc, with real mouse events on the way (hover states fire as they would). */
  async move(target, { ms = 750, dx = 0, dy = 0 } = {}) {
    const p = await this.point(target, { dx, dy });
    const { x: x0, y: y0 } = this.pos;
    const dist = Math.hypot(p.x - x0, p.y - y0);
    if (ms <= 0 || dist < 2) { await this.page.mouse.move(p.x, p.y); this.pos = p; return; }
    const nx = -(p.y - y0) / dist;
    const ny = (p.x - x0) / dist;
    this.bend = -this.bend;
    const arc = Math.min(48, dist * 0.07) * this.bend;
    const start = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
      const bow = Math.sin(Math.PI * e) * arc;
      await this.page.mouse.move(x0 + (p.x - x0) * e + nx * bow, y0 + (p.y - y0) * e + ny * bow);
      if (t >= 1) break;
      await sleep(MOUSE_FRAME_MS);
    }
    this.pos = p;
  }

  async click(target, { ms = 750, shift = false, right = false, dx = 0, dy = 0, hold = 80 } = {}) {
    await this.move(target, { ms, dx, dy });
    if (shift) await this.page.keyboard.down('Shift');
    await this.page.mouse.down({ button: right ? 'right' : 'left' });
    await sleep(hold);
    await this.page.mouse.up({ button: right ? 'right' : 'left' });
    if (shift) await this.page.keyboard.up('Shift');
  }

  /** Types one key at a time: about 55 ms each, a little longer after spaces and punctuation. */
  async type(text, { ms = 55 } = {}) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      const swing = (this.rng() - 0.5) * ms * 0.7;
      await sleep(Math.max(18, ms + swing + (/[\s.,]/.test(ch) ? ms * 0.5 : 0)));
    }
  }

  press(key) { return this.page.keyboard.press(key); }

  /** Sets a field and presses Enter at once (setup, cut from the clip). */
  async sendQuickly(selector, text) {
    await this.page.fill(selector, text);
    await this.page.press(selector, 'Enter');
  }

  /** Scrolls an element to y over ms, eased (a wheel would jump). */
  async scrollTo(selector, y, ms = 1200) {
    await this.page.evaluate(({ selector: sel, y: to, ms: dur }) => new Promise((resolve) => {
      const el = document.querySelector(sel);
      if (!el) { resolve(); return; }
      const from = el.scrollTop;
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const e = t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
        el.scrollTop = from + (to - from) * e;
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    }), { selector, y, ms });
  }

  /**
   * Scrolls the focused pane's transcript, eased, until the first element matching `sel` (and containing `text`)
   * sits `at` of the way down the pane (0.3 leaves room for the prompt pin above it). False when nothing matches.
   */
  scrollToElement({ sel, text = '' }, { at = 0.3, ms = 1500 } = {}) {
    return this.page.evaluate(({ sel: q, text: t, at: frac, ms: dur }) => new Promise((resolve) => {
      const g = document.querySelector('.pane.focused .ground');
      const el = g && [...g.querySelectorAll(q)].find((n) => !t || n.textContent.includes(t));
      if (!el) { resolve(false); return; }
      const gr = g.getBoundingClientRect();
      const to = g.scrollTop + (el.getBoundingClientRect().top - gr.top) - gr.height * frac;
      const from = g.scrollTop;
      const start = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - start) / dur);
        const e = k < 0.5 ? 4 * k * k * k : 1 - ((-2 * k + 2) ** 3) / 2;
        g.scrollTop = from + (to - from) * e;
        if (k < 1) requestAnimationFrame(step); else resolve(true);
      };
      requestAnimationFrame(step);
    }), { sel, text, at, ms });
  }

  waitFor(fn, arg, timeout = 15000) { return this.page.waitForFunction(fn, arg, { timeout }); }

  evaluate(fn, arg) { return this.page.evaluate(fn, arg); }

  /** A PNG of the window now (stills runs only). The pointer is hidden unless asked for. */
  async still(label, { cursor = false } = {}) {
    this.note(`still ${label}`);
    if (!this.stillsOn || !this.onStill) return;
    await this.page.evaluate((on) => window.__demo.cursor(on), cursor);
    // Let hover and transition frames settle, so the picture is of a calm moment.
    await sleep(180);
    const shots = await this.shots(label);
    await this.page.evaluate(() => window.__demo.cursor(true));
    for (const shot of shots) await this.onStill(label, shot.png, shot.name);
  }

  /** The pictures a still stands for: [{ png, name }]. One whole-window PNG, unless this is a close-up scene (see clip). */
  async shots(label) {
    const c = this.clip;
    if (!c) return [{ png: await this.page.screenshot({ type: 'png' }), name: null }];
    if (!c.each) return [{ png: await this.page.screenshot({ type: 'png', clip: { x: c.x, y: c.y, width: c.w, height: c.h } }), name: null }];
    if (c.at && c.at !== label) return [];
    const boxes = await this.page.evaluate((sel) => [...document.querySelectorAll(sel)].map((n) => {
      const b = n.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    }), c.each);
    // Rows first (panes in one row can differ by a pixel or two in top), then columns.
    boxes.sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
    const out = [];
    for (const [i, b] of boxes.entries()) {
      if (!c.names?.[i]) break;
      out.push({ png: await this.page.screenshot({ type: 'png', clip: { x: b.x, y: b.y, width: b.w, height: b.h } }), name: c.names[i] });
    }
    return out;
  }
}

/* shared selectors */

const COMPOSER = '.pane.focused textarea';
const row = (id) => `.sessions li[data-id="${id}"]`;

/** True once the focused pane's transcript has a finished reply that contains `text`. */
const replyDone = (text) => ({ text, fn: (t) => [...document.querySelectorAll('.pane.focused .turn-assistant:not(.streaming)')].some((n) => n.textContent.includes(t)) });

/* the scenes */

export const SCENES = {
  sessions: {
    title: 'Sessions overview',
    shows: 'The sidebar: folders, sessions working in terminals, Codex sessions marked read-only, a right-click menu, a session opening in a new tab.',
    ws: 'sessions',
    hero: 'overview',
    async run(s) {
      await s.waitFor(() => document.querySelectorAll('.sessions li').length > 8);
      await s.begin();
      await s.still('overview');
      await s.pause(500);
      await s.move(row(ID.invoices), { ms: 900 });
      await s.pause(500);
      await s.click('.folder-list .folder-row:nth-child(1)', { ms: 800 });
      await s.pause(1300);
      await s.click('#clearView', { ms: 700 });
      await s.pause(500);
      await s.click(row(ID.flaky), { ms: 800, right: true, dy: -8 });
      await s.pause(300);
      await s.still('menu', { cursor: true });
      await s.pause(1700);
      await s.press('Escape');
      await s.pause(300);
      await s.click(row(ID.review), { ms: 800 });
      await s.waitFor(() => document.querySelectorAll('.tabs .tab').length >= 4);
      await s.pause(1500);
      await s.still('opened');
    },
  },

  search: {
    title: 'Search by meaning, then Ask Claude',
    shows: 'Typing a vague question finds the right session by what it is about, then Ask Claude reads the best matches and says why each fits.',
    ws: 'search',
    hero: 'results',
    async run(s) {
      await s.waitFor(() => document.querySelectorAll('.sessions li').length > 8);
      await s.begin();
      await s.pause(400);
      await s.click('#q', { ms: 800 });
      await s.type('payment page randomly failing');
      await s.waitFor(() => document.querySelector('#lensInfo')?.textContent.includes('ms'));
      await s.pause(900);
      await s.still('results');
      await s.pause(700);
      await s.press('Control+Enter');
      await s.waitFor(() => document.querySelector('#lensInfo')?.textContent.includes('fit'), null, 20000);
      await s.pause(900);
      await s.still('picks');
      await s.pause(1500);
    },
  },

  steer: {
    title: 'Queue and steer a running turn',
    shows: 'Claude is working. Enter queues a message for when it finishes; Ctrl+Enter steers it into the running turn now. A subagent runs, the edit lands, the test runs ten times.',
    ws: 'steer',
    hero: 'steered',
    async run(s) {
      // Setup (cut): the first prompt goes in and Claude works up to its first pause.
      await s.sendQuickly(COMPOSER, 'Yes, fix the hook. Then run the test ten times in a row so we know it is really gone.');
      const r = replyDone('which I will leave until the hook is fixed');
      await s.waitFor(r.fn, r.text, 20000);
      await s.begin();
      await s.pause(300);
      await s.click(COMPOSER, { ms: 700 });
      await s.type('then open a pull request', { ms: 50 });
      await s.press('Enter');
      await s.waitFor(() => document.querySelector('.pane.focused .queue:not([hidden]) .q-item'));
      await s.still('queued');
      await s.pause(600);
      await s.type('Also check billing-service for retries', { ms: 50 });
      await s.pause(300);
      await s.press('Control+Enter');
      await s.waitFor(() => document.querySelector('.pane.focused .tasks-btn.lit'), null, 20000);
      await s.pause(600);
      await s.still('steered');
      await s.waitFor(() => [...document.querySelectorAll('.pane.focused .tool .sum')].some((n) => n.textContent.includes('10 of 10 runs passed')), null, 20000);
      await s.pause(600);
    },
  },

  'glass-swap': {
    title: 'Myrlin Glass: switch account',
    shows: 'The Glass card at the bottom of the sidebar: open the panel, switch Claude to another subscription, then to an API key; the usage bars and the billing chip follow.',
    ws: 'glass-swap',
    hero: 'panel',
    async run(s) {
      await s.waitFor(() => document.querySelector('#glassState .gc-row'));
      await s.begin();
      await s.pause(500);
      await s.click('#glassState .gc-row[data-p="claude"]', { ms: 900 });
      await s.waitFor(() => document.querySelector('.glass-panel .gp-row'));
      await s.pause(1300);
      await s.still('panel');
      const team = '.glass-panel .gp-row:has(.gp-n:text-is("Team seat"))';
      await s.move(team, { ms: 700 });
      await s.pause(250);
      await s.click(`${team} [data-a="use"]`, { ms: 450 });
      await s.waitFor(() => document.querySelector('#glassState .gc-row[data-p="claude"] .gc-n')?.textContent === 'Team seat', null, 8000);
      await s.pause(1300);
      await s.still('team');
      const key = '.glass-panel .gp-row:has(.gp-n:text-is("Acme Console"))';
      await s.click(`${key} [data-a="use"]`, { ms: 800 });
      await s.waitFor(() => document.querySelector('#glassState .gc-row[data-p="claude"] .gc-n')?.textContent === 'Acme Console', null, 8000);
      await s.pause(900);
      await s.press('Escape');
      await s.pause(1200);
      await s.still('key');
    },
  },

  browser: {
    title: 'Claude browses in a pane',
    shows: 'Ask Claude to try the checkout page: a browser pane opens beside the conversation, Claude types and clicks in it, and its activity shows above the page.',
    ws: 'browser',
    hero: 'browsing',
    async run(s) {
      await s.waitFor(() => document.querySelector('.pane.focused textarea'));
      await s.begin();
      await s.pause(300);
      await s.click(COMPOSER, { ms: 700 });
      await s.type('Open the checkout and try paying', { ms: 48 });
      await s.press('Enter');
      await s.waitFor(() => document.querySelector('.pane.web .web-act.on'), null, 20000);
      await s.pause(1200);
      await s.still('browsing');
      await s.waitFor(() => document.querySelector('.demo-page iframe')?.contentDocument?.getElementById('banner')?.classList.contains('on'), null, 20000);
      await s.pause(1300);
      await s.waitFor(() => [...document.querySelectorAll('.pane.focused .turn-assistant:not(.streaming)')].some((n) => n.textContent.includes('Reproduced')), null, 20000);
      await s.pause(700);
      await s.still('reproduced');
      // The order number arrives a moment later, which is the whole bug.
      await s.waitFor(() => document.querySelector('.demo-page iframe')?.contentDocument?.getElementById('order-id')?.textContent.length > 1, null, 12000);
      await s.pause(900);
    },
  },

  'phone-pair': {
    title: 'Pair a phone',
    shows: 'The Phone sheet: pair with a QR code, approve the phone that scanned it by its code, and see it connected among the paired phones. In step, the phone (2026-10-12): its Connect screen, the same six digits, then the PC\'s sessions.',
    ws: 'phone-pair',
    hero: 'qr',
    pair: { device: 'phone', ws: 'pair-phone', hero: 'code' },
    async run(s, p) {
      await s.waitFor(() => document.querySelector('#phone'));
      if (p) await p.waitFor(() => document.querySelector('#pairScreen:not([hidden]) .pair-steps'));
      await s.begin();
      await s.pause(500);
      await s.click('#phone', { ms: 900 });
      await s.waitFor(() => document.querySelector('.phone-sheet [data-k="pair"]'));
      await s.pause(1300);
      await s.click('.phone-sheet [data-k="pair"]', { ms: 800 });
      await s.waitFor(() => document.querySelector('.phone-sheet .ph-qr svg'));
      await s.pause(900);
      // The phone's camera opened the link: it reaches the PC through the relay.
      if (p) await p.evaluate(() => window.__demo.phone.pairing('reaching'));
      await s.pause(600);
      await s.still('qr');
      await s.pause(500);
      await s.evaluate(() => window.__demo.phoneScan());
      if (p) await p.evaluate(() => window.__demo.phone.pairing('code', '482913'));
      await s.waitFor(() => document.querySelector('.phone-sheet .ph-code'));
      await s.pause(1400);
      await s.still('approve');
      if (p) await p.still('code');
      await s.click('.phone-sheet [data-k="allow"]', { ms: 800 });
      if (p) await p.evaluate(() => window.__demo.phone.pairing('done'));
      await s.waitFor(() => document.querySelector('.phone-sheet .ph-done'));
      await s.pause(1500);
      await s.still('paired');
      if (p) await p.still('connected');
      await s.pause(500);
    },
  },

  /**
   * The handoff (2026-10-12, the home page's hero): four sessions work in one tab on the PC; the phone opens the
   * one in the top right from "On your desktop", takes it over, and asks for the fix. The desktop pane says the
   * phone took it, and follows the conversation from the transcript as Claude Code writes it (every 5 s, as the
   * real pane does), so the phone's message and Claude's reply show up on the PC too. Nothing here is planned
   * work: a phone that only watches a desktop pane (follow) is not built on the PC side, so it is not shown.
   */
  handoff: {
    title: 'Handoff: the phone picks up a desktop session',
    shows: 'Four working panes on the PC; the phone takes over the top right one from On your desktop and asks for the fix; the PC pane says the phone has it and follows the turn from the transcript.',
    ws: 'handoff',
    pair: { device: 'phone', ws: 'handoff-phone', hero: 'reply' },
    hero: 'followed',
    maxSeconds: 19,
    async run(s, p) {
      const flaky = ID.flaky;
      await s.waitFor(() => document.querySelectorAll('.stage.on .pane').length >= 3);
      // The other two work for the whole clip (started before it, so they are mid-turn when it begins).
      await s.evaluate((ids) => { for (const id of ids) window.__demo.autoTurn(id); }, [ID.invoices, ID.review]);
      await s.evaluate(() => window.__demo.cursor(false));
      if (p) await p.waitFor(() => document.querySelectorAll('.desk-row.go').length >= 3);
      await s.pause(1600);
      await s.begin();
      await s.pause(900);
      if (!p) { await s.pause(9000); await s.still('followed'); return; }
      await p.still('list');
      await p.click('.desk-row.go:has-text("Fix flaky checkout test")', { ms: 550, hold: 140 });
      await p.waitFor(() => document.querySelector('.pane.focused .tk-go'));
      await p.pause(1000);
      // Take over here on the phone; on the PC, at the same moment, the pane that had it says so. That pane looks
      // at the transcript every 5 s from now, so the phone's turn is timed to be written just before its second look.
      await p.click('.pane.focused .tk-go', { ms: 450, hold: 140 });
      await s.evaluate((id) => window.__demo.engine.takenBy(id), flaky);
      s.note('taken over');
      // A click that lands while the pane is still sliding in can miss under load: if the conversation has not opened, click again.
      const opened = () => document.querySelectorAll('.pane.focused .turn-assistant').length > 0;
      if (!(await p.waitFor(opened, null, 5000).then(() => true, () => false))) await p.click('.pane.focused .tk-go', { ms: 300, hold: 140 });
      await p.waitFor(opened);
      await p.pause(300);
      await p.click('.pane.focused textarea', { ms: 300, hold: 110 });
      await p.type(HANDOFF.prompt, { ms: 30 });
      await p.pause(150);
      const tools = await p.evaluate(() => document.querySelectorAll('.pane.focused .tool').length);
      await p.click('.pane.focused .send', { ms: 300, hold: 110 });
      // What Claude Code on the phone has written to the transcript so far, for the desktop pane's next look.
      const grew = (n) => s.evaluate(({ id, k }) => window.__demo.engine.transcriptGrew(id, k), { id: flaky, k: n });
      await grew(1);
      s.note('sent');
      await p.waitFor((n) => document.querySelectorAll('.pane.focused .tool').length > n, tools, 15000);
      await grew(3);
      await p.waitFor((t) => [...document.querySelectorAll('.pane.focused .tool .sum')].some((x) => x.textContent.includes(t)), '10 of 10 runs passed', 15000);
      await grew(5);
      const r = replyDone('ten passes');
      await p.waitFor(r.fn, r.text, 15000);
      await grew(6);
      s.note('reply written');
      await p.still('reply');
      // The desktop pane looks again within 5 s and shows the reply above its Taken over card. On a busy machine the
      // phone's turn can be written just after a look, and the next is 5 s away: then a glance at the window (focus,
      // which makes every pane on screen check its conversation, as it does when you come back to it) makes it look now.
      const onPc = (t) => [...document.querySelectorAll('.pane .turn-assistant')].some((x) => x.textContent.includes(t));
      if (!(await s.waitFor(onPc, 'ten passes', 1500).then(() => true, () => false))) await s.evaluate(() => window.dispatchEvent(new Event('focus')));
      await s.waitFor(onPc, 'ten passes', 12000);
      await s.pause(900);
      await s.still('followed');
      await s.pause(300);
    },
  },

  split: {
    title: 'Tabs and split panes',
    shows: 'Several tabs, then three working sessions shift-clicked into split panes, each streaming at once, and the Even grid button.',
    ws: 'split',
    hero: 'grid',
    async run(s) {
      await s.waitFor(() => document.querySelectorAll('.sessions li').length > 8);
      await s.begin();
      await s.pause(500);
      const open = async (id, script) => {
        await s.click(row(id), { ms: 800, shift: true });
        await s.waitFor((sid) => window.__demo.state().panes.some((p) => p.sessionId === sid), id);
        await s.pause(450);
        await s.evaluate(({ sid, sc }) => window.__demo.autoTurn(sid, sc), { sid: id, sc: script });
        await s.pause(750);
      };
      await open(ID.invoices, 'background-invoices');
      await open(ID.push, 'background-push');
      await open(ID.review, 'background-review');
      await s.still('four');
      await s.click('.tab-tool', { ms: 800 });
      await s.pause(1100);
      // Ctrl+B hides the sidebar, and the grid takes the room.
      await s.press('Control+b');
      await s.pause(1500);
      await s.still('grid');
      await s.pause(300);
    },
  },

  /**
   * The phone client (2026-10-12): phone.html, Apaki's own window as the phone runs it (apaki/web/src native.js),
   * at a phone's size. capture.mjs opens it at 390x844 because of device: 'phone'.
   */
  phone: {
    title: 'Apaki on a phone',
    shows: 'The phone app: the sessions list is home, a conversation slides in, a message goes to Claude Code on the PC and the reply streams back.',
    ws: 'phone',
    device: 'phone',
    hero: 'reply',
    async run(s) {
      await s.waitFor(() => document.body.classList.contains('native') && document.querySelectorAll('.sessions li').length > 8);
      await s.begin();
      await s.pause(900);
      await s.still('list');
      await s.click(row(ID.flaky), { ms: 600, hold: 140 });
      await s.waitFor(() => document.body.classList.contains('at-chat') && document.querySelector('.pane.focused .turn-assistant'));
      await s.pause(1000);
      await s.click(COMPOSER, { ms: 500, hold: 120 });
      await s.pause(150);
      await s.type('Fix the hook, then run it ten times', { ms: 46 });
      await s.pause(300);
      const tools = await s.evaluate(() => document.querySelectorAll('.pane.focused .tool').length);
      await s.click('.pane.focused .send', { ms: 450, hold: 120 });
      await s.waitFor((n) => document.querySelectorAll('.pane.focused .tool').length > n, tools, 15000);
      await s.pause(700);
      await s.still('working');
      const r = replyDone('which I will leave until the hook is fixed');
      await s.waitFor(r.fn, r.text, 20000);
      await s.pause(1000);
      await s.still('reply');
    },
  },

  /**
   * Git worktrees (2026-10-12, shipped that day; apaki/remote/WORKTREES.md): the sidebar on its Worktrees view, the
   * pane's branch label with its change count, its menu, and View changes opening the diff viewer beside the
   * conversation. The repositories are the harness's invented ones (harness/worktrees.mjs).
   */
  worktrees: {
    title: 'Worktrees: the branch label, its menu and the diff viewer',
    shows: 'Conversations grouped by repository and worktree in the sidebar; the pane header shows the branch and its change count; its menu opens View changes, a diff viewer beside the conversation.',
    ws: 'worktrees',
    hero: 'diff',
    async run(s) {
      await s.waitFor(() => document.querySelector('.pane.focused .wt-btn'));
      await s.begin();
      await s.pause(900);
      await s.still('list');
      await s.click('.pane.focused .wt-btn', { ms: 900 });
      await s.waitFor(() => [...document.querySelectorAll('.menu .menu-item')].some((b) => b.textContent.includes('View changes')));
      await s.pause(1300);
      await s.still('menu', { cursor: true });
      await s.click('.menu .menu-item:has-text("View changes")', { ms: 700 });
      await s.waitFor(() => document.querySelector('.df-body .df-bar'), null, 10000);
      await s.pause(1600);
      // Down through the changed files, slowly.
      await s.scrollTo('.df-ground', 260, 1600);
      await s.pause(1200);
      await s.still('diff');
      await s.pause(600);
    },
  },

  history: {
    title: 'A long transcript',
    shows: 'The whole conversation: tool calls and a diff, a subagent, and what Claude Code says itself (a hook, an API retry, a usage warning), up to the compaction at the top.',
    ws: 'history',
    hero: 'system-lines',
    async run(s) {
      await s.waitFor(() => document.querySelectorAll('.pane.focused .tool').length > 6);
      // Setup (cut): the earlier page loads once, at the top, so the clip scrolls through a settled transcript.
      await s.evaluate(() => { document.querySelector('.pane.focused .ground').scrollTop = 0; });
      await s.waitFor(() => document.querySelector('.pane.focused .compact-mark'), null, 10000);
      await s.pause(600);
      await s.evaluate(() => { const g = document.querySelector('.pane.focused .ground'); g.scrollTop = g.scrollHeight; });
      await s.pause(600);
      await s.begin();
      await s.pause(800);
      await s.still('summary');
      // Up through the transcript, slowly: what Claude Code said itself, a diff, the compaction at the top.
      await s.scrollToElement({ sel: '.sysline', text: 'Stop hook feedback' }, { at: 0.2, ms: 2000 });
      await s.pause(300);
      await s.still('system-lines');
      await s.scrollToElement({ sel: 'details.tool', text: 'Edit(server/signed-upload.ts)' }, { at: 0.4, ms: 1500 });
      await s.click('.pane.focused details.tool:has(.name:text-is("Edit")):has(.args:has-text("signed-upload")) summary', { ms: 800 });
      await s.pause(1000);
      await s.still('diff');
      await s.scrollTo('.pane.focused .ground', 0, 2400);
      await s.pause(300);
      await s.click('.pane.focused .compact-mark summary', { ms: 700 });
      await s.pause(1400);
      await s.still('compaction');
    },
  },
};

/**
 * Close-ups (2026-10-12, for the home page): each runs a full scene's run() (or a small variant of it) and is
 * recorded at 2x by capture.mjs, then cut to `crop`, a rectangle of the 1440x900 window in CSS pixels, so text stays
 * sharp on 2x screens. capture.mjs writes <out>/crops/<name>-<theme>.mp4 and the cropped still of `hero` as its
 * poster. `maxWidth` is the width both are encoded at: 2x the widest the page shows them (never upscaled; without it,
 * the crop's own 2x width). clipFrom (seconds after begin()) and clipSeconds trim the clip. A stillsOnly scene makes
 * cropped stills and no clip (heroOnly: just the hero's). A paired close-up gives its phone half pair.name,
 * pair.maxWidth and, as `pair.crop`, a rectangle of the phone page (none: the whole page).
 */
const closeUp = (from, extra) => ({ ...SCENES[from], ...extra });

Object.assign(SCENES, {
  /**
   * The home page's hero (replaces the full-window handoff clip): the pane the phone takes over, and the phone, in step.
   * The pane is the left one of the handoff's grid (x 9 to 717, y 47 to 891). The takeover is noted as 'taken over'.
   */
  'hero-pane': closeUp('handoff', {
    title: 'Close-up: the phone takes over a desktop pane',
    shows: 'The pane on the PC that the phone takes over, and the phone, recorded in step: Session in use, take over, the fix; the pane says the phone has it, then shows the phone\'s turn.',
    hero: 'followed',
    crop: { x: 8, y: 46, w: 710, h: 846 },
    maxWidth: 1200,
    // The two clips autoplay on the page's first load, so together they stay near 2.2 MB: the phone at 520 wide (shown at about 256 CSS px).
    maxBytes: 1_200_000,
    pair: { ...SCENES.handoff.pair, name: 'hero-phone', maxWidth: 520, maxBytes: 1_000_000 },
    // Starts 0.8 s in (the idle beat before the phone moves) and holds on the followed pane a moment at the end.
    clipFrom: 0.8,
    async run(s, p) {
      await SCENES.handoff.run(s, p);
      await s.pause(700);
    },
  }),

  'glass-card': closeUp('glass-swap', {
    title: 'Close-up: the Glass panel and card',
    shows: 'The Glass panel over the sidebar and the Glass card under it, as the account is switched.',
    hero: 'team',
    // 470 wide (from x 4) so the hover tooltip beside the Use button (it reaches x 470) is whole; from y 262 so the panel,
    // which grows taller once an account is live (its top is at y 268), is never cut; down to the Glass card's bottom edge.
    crop: { x: 4, y: 262, w: 470, h: 598 },
    maxWidth: 784,
  }),

  /**
   * The steer scene with a shorter middle and a new ending: the pointer glides to the context meter at the end of the
   * composer's settings line and rests on it, so its tooltip (the meter, what is in the window) shows.
   */
  'steer-line': closeUp('steer', {
    title: 'Close-up: the queue, the composer and the context meter',
    shows: 'The Running line, the Queued card with Steer, the composer with its settings line, and the context meter\'s tooltip.',
    hero: 'steered',
    // The Running line (y 658 to 680) to the composer's bottom; the meter tooltip opens above the chip (x 895 to 1188, y 688 to 827).
    crop: { x: 452, y: 644, w: 896, h: 248 },
    maxWidth: 1520,
    clipFrom: 0.4,
    async run(s) {
      // Setup (cut): the first prompt goes in and Claude works up to its first pause.
      await s.sendQuickly(COMPOSER, 'Yes, fix the hook. Then run the test ten times in a row so we know it is really gone.');
      const r = replyDone('which I will leave until the hook is fixed');
      await s.waitFor(r.fn, r.text, 20000);
      await s.begin();
      await s.pause(300);
      await s.click(COMPOSER, { ms: 700 });
      await s.type('then open a pull request', { ms: 50 });
      await s.press('Enter');
      await s.waitFor(() => document.querySelector('.pane.focused .queue:not([hidden]) .q-item'));
      await s.still('queued');
      await s.pause(600);
      await s.type('Also check billing-service for retries', { ms: 50 });
      await s.pause(300);
      await s.press('Control+Enter');
      await s.waitFor(() => document.querySelector('.pane.focused .tasks-btn.lit'), null, 20000);
      await s.pause(600);
      await s.still('steered');
      // The pointer rests on the context meter chip until its tooltip has shown for a while.
      await s.move('.pane.focused .chip-btn.ctx', { ms: 800 });
      await s.waitFor(() => { const t = document.querySelector('.tt'); return t && !t.hidden; }, null, 5000);
      await s.pause(1000);
      await s.still('meter', { cursor: true });
      await s.pause(1800);
    },
  }),

  'worktree-diff': closeUp('worktrees', {
    title: 'Close-up: the branch label, its menu and the diff viewer',
    shows: 'The pane header\'s branch label (fix-flaky-checkout +11 -2), its menu, and the diff viewer opening on the right.',
    hero: 'diff',
    // From the pane's own left edge (x 360), so its title is whole; to the window's right edge; down past the menu (it ends at y 513).
    crop: { x: 360, y: 44, w: 1080, h: 484 },
    maxWidth: 1530,
    clipFrom: 0.6,
  }),

  'search-meaning': closeUp('search', {
    title: 'Close-up: search by meaning, then Ask Claude',
    shows: 'The search box, the results marked "by meaning", then Ask Claude\'s picks.',
    hero: 'picks',
    // Under the New conversation button (it ends at y 102) and down to the Glass card (it starts at y 742).
    crop: { x: 0, y: 104, w: 352, h: 634 },
    maxWidth: 704,
  }),

  /**
   * The browser scene with its opening done in the setup: the prompt goes in at once and the clip starts with the
   * browser pane already there and its page loaded, so it is all Claude typing, Pay now, the banner bug and the order id arriving.
   */
  'browser-pane': closeUp('browser', {
    title: 'Close-up: Claude browsing in a pane',
    shows: 'The browser pane with its "Claude, type [3]" activity line, Pay now, the banner bug and the order id arriving.',
    hero: 'browsing',
    // The pane is x 899 to 1431; the page is taller once the confirmation banner is up (Pay now ends near y 715, the cards near y 745).
    crop: { x: 896, y: 44, w: 538, h: 704 },
    maxWidth: 840,
    async run(s) {
      await s.waitFor(() => document.querySelector('.pane.focused textarea'));
      // Setup (cut): the prompt goes in and Claude opens the pane; wait for the page to be drawn in it (its tab title says Checkout).
      await s.sendQuickly(COMPOSER, 'Open the checkout and try paying');
      await s.waitFor(() => document.querySelector('.pane.web .title')?.textContent.includes('Checkout') && document.querySelector('.demo-page iframe')?.contentDocument?.getElementById('pay'), null, 20000);
      await s.pause(150);
      await s.begin();
      await s.waitFor(() => document.querySelector('.pane.web .web-act.on'), null, 20000);
      await s.pause(1200);
      await s.still('browsing');
      await s.waitFor(() => document.querySelector('.demo-page iframe')?.contentDocument?.getElementById('banner')?.classList.contains('on'), null, 20000);
      await s.pause(1300);
      await s.waitFor(() => [...document.querySelectorAll('.pane.focused .turn-assistant:not(.streaming)')].some((n) => n.textContent.includes('Reproduced')), null, 20000);
      await s.pause(700);
      await s.still('reproduced');
      // The order number arrives a moment later, which is the whole bug.
      await s.waitFor(() => document.querySelector('.demo-page iframe')?.contentDocument?.getElementById('order-id')?.textContent.length > 1, null, 12000);
      await s.pause(2600);
    },
  }),

  /** The paired Phone sheet scene: the desktop's sheet (pair-sheet) and the whole phone page (pair-phone), in step. */
  'pair-sheet': closeUp('phone-pair', {
    title: 'Close-up: pairing a phone, the sheet and the phone',
    shows: 'The QR card, then the "wants to connect" card with its code, Deny and Allow, in the same place in the sheet; beside it the phone page, in step.',
    hero: 'approve',
    // The QR card and the "wants to connect" card share x 416 to 1024 and y 222 to 487; the sheet's intro text ends at y 192
    // and the card under them starts at y 503, so the edges sit in those gaps.
    crop: { x: 402, y: 204, w: 636, h: 292 },
    maxWidth: 1120,
    pair: { ...SCENES['phone-pair'].pair, name: 'pair-phone', maxWidth: 520 },
    // phone-pair with the Phone sheet opened in the setup: the clip starts on the sheet's Pair a phone button.
    async run(s, p) {
      await s.waitFor(() => document.querySelector('#phone'));
      if (p) await p.waitFor(() => document.querySelector('#pairScreen:not([hidden]) .pair-steps'));
      await s.click('#phone', { ms: 900 });
      await s.waitFor(() => document.querySelector('.phone-sheet [data-k="pair"]'));
      await s.pause(1200);
      await s.begin();
      await s.pause(500);
      await s.click('.phone-sheet [data-k="pair"]', { ms: 800 });
      await s.waitFor(() => document.querySelector('.phone-sheet .ph-qr svg'));
      await s.pause(900);
      // The phone's camera opened the link: it reaches the PC through the relay.
      if (p) await p.evaluate(() => window.__demo.phone.pairing('reaching'));
      await s.pause(600);
      await s.still('qr');
      await s.pause(500);
      await s.evaluate(() => window.__demo.phoneScan());
      if (p) await p.evaluate(() => window.__demo.phone.pairing('code', '482913'));
      await s.waitFor(() => document.querySelector('.phone-sheet .ph-code'));
      await s.pause(1400);
      await s.still('approve');
      if (p) await p.still('code');
      await s.click('.phone-sheet [data-k="allow"]', { ms: 800 });
      if (p) await p.evaluate(() => window.__demo.phone.pairing('done'));
      await s.waitFor(() => document.querySelector('.phone-sheet .ph-done'));
      await s.pause(1500);
      await s.still('paired');
      if (p) await p.still('connected');
      await s.pause(800);
    },
  }),

  /** Still crops: the sidebar's session rows (from the sessions overview). */
  'sessions-list': closeUp('sessions', {
    title: 'Still crop: the sidebar\'s sessions',
    shows: 'The SESSIONS header and its rows (terminal, working; waiting; codex).',
    hero: 'overview',
    stillsOnly: true,
    heroOnly: true,
    crop: { x: 0, y: 300, w: 352, h: 440 },
    maxWidth: 704,
    // The list is scrolled by one row first (64 px), so a working, a waiting and a Codex row all show.
    async run(s) {
      await s.waitFor(() => document.querySelectorAll('.sessions li').length > 8);
      await s.begin();
      await s.evaluate(() => { document.querySelector('#sessions').scrollTop = 64; });
      await s.pause(400);
      await s.still('overview');
    },
  }),

  /** Still crops: each pane of the split grid on its own at its own 2x pixels (pane-a to pane-d, top to bottom, left to right). */
  panes: closeUp('split', {
    title: 'Still crops: the panes of the split grid',
    shows: 'Each of the grid\'s working panes by itself.',
    hero: 'grid',
    stillsOnly: true,
    heroOnly: true,
    crop: { each: '.stage.on .pane', names: ['pane-a', 'pane-b', 'pane-c', 'pane-d'], at: 'grid' },
  }),
});

export const sceneNames = () => Object.keys(SCENES);

/**
 * Runs one scene on a page that has the harness open (its workspace chosen by the address).
 * Returns { name, beganAt, endedAt, seconds, log } with wall-clock times, for trimming a recording.
 */
export async function runScene(page, name, { stills = false, onStill = null, pairPage = null, onPairStill = null, clip = null, pairClip = null } = {}) {
  const scene = SCENES[name];
  if (!scene) throw new Error(`no scene called ${name}`);
  const s = new Director(page, { stills, onStill, clip });
  // A paired scene's phone (2026-10-12): its own director, starting when the desktop's does.
  const p = pairPage ? new Director(pairPage, { stills, onStill: onPairStill, clip: pairClip }) : null;
  if (p) {
    p.pos = { x: 300, y: 600 };
    const begin = s.begin.bind(s);
    s.begin = async () => { await begin(); p.beganAt = s.beganAt; p.t0 = s.t0; };
  }
  await scene.run(s, p);
  const endedAt = Date.now();
  return { name, beganAt: s.beganAt, endedAt, seconds: s.beganAt == null ? 0 : (endedAt - s.beganAt) / 1000, log: s.log, pairLog: p?.log || null, hero: scene.hero };
}
