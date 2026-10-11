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
 */

import { ID } from './harness/data.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MOUSE_FRAME_MS = 9;

/** A small seeded generator, so typing rhythm and pointer arcs repeat from run to run. */
function lcg(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

class Director {
  constructor(page, { stills = false, onStill = null } = {}) {
    this.page = page;
    this.stillsOn = stills;
    this.onStill = onStill;
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
    const png = await this.page.screenshot({ type: 'png' });
    await this.page.evaluate(() => window.__demo.cursor(true));
    await this.onStill(label, png);
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
    shows: 'The Phone sheet: pair with a QR code, approve the phone that scanned it by its code, and see it connected among the paired phones.',
    ws: 'phone-pair',
    hero: 'qr',
    async run(s) {
      await s.waitFor(() => document.querySelector('#phone'));
      await s.begin();
      await s.pause(500);
      await s.click('#phone', { ms: 900 });
      await s.waitFor(() => document.querySelector('.phone-sheet [data-k="pair"]'));
      await s.pause(1300);
      await s.click('.phone-sheet [data-k="pair"]', { ms: 800 });
      await s.waitFor(() => document.querySelector('.phone-sheet .ph-qr svg'));
      await s.pause(1500);
      await s.still('qr');
      await s.pause(500);
      await s.evaluate(() => window.__demo.phoneScan());
      await s.waitFor(() => document.querySelector('.phone-sheet .ph-code'));
      await s.pause(1400);
      await s.still('approve');
      await s.click('.phone-sheet [data-k="allow"]', { ms: 800 });
      await s.waitFor(() => document.querySelector('.phone-sheet .ph-done'));
      await s.pause(1500);
      await s.still('paired');
      await s.pause(500);
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

export const sceneNames = () => Object.keys(SCENES);

/**
 * Runs one scene on a page that has the harness open (its workspace chosen by the address).
 * Returns { name, beganAt, endedAt, seconds, log } with wall-clock times, for trimming a recording.
 */
export async function runScene(page, name, { stills = false, onStill = null } = {}) {
  const scene = SCENES[name];
  if (!scene) throw new Error(`no scene called ${name}`);
  const s = new Director(page, { stills, onStill });
  await scene.run(s);
  const endedAt = Date.now();
  return { name, beganAt: s.beganAt, endedAt, seconds: s.beganAt == null ? 0 : (endedAt - s.beganAt) / 1000, log: s.log, hero: scene.hero };
}
