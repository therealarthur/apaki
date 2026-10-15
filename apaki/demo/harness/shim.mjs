/**
 * shim.mjs: the entry of Apaki's demo harness page. It runs before apaki/ui/app.js
 * (module scripts run in document order) and sets up everything app.js expects
 * from the Tauri shell, so the real desktop UI runs unchanged in a normal browser:
 *
 *   window.__TAURI__.core.invoke      engine_send goes to the demo engine, browser to the fake shell
 *   window.__TAURI__.event.listen     the 'engine' and 'browser' event streams
 *   window.__TAURI__.window / dpi     the window buttons and size, as inert stubs
 *   Date and Math.random              a fixed demo clock (10:42 on Tue 13 Oct 2026, ticking) and a seeded generator,
 *                                     so screenshots and recordings repeat
 *   window.__demo                     the handle the scene runner uses (scenes.mjs)
 *
 * Query string: ws=<preset> picks the starting workspace (data.mjs PRESETS),
 * cursor=0 hides the on-screen pointer, seed=<n> and now=<epoch ms> override
 * the generator and the clock, theme=<light|dark|auto> is read by desktop.html.
 */

import { createEngine } from './engine.mjs';
import { createBrowserShell } from './browser-shell.mjs';
import { installCursor } from './cursor.mjs';

const q = new URLSearchParams(location.search);

/* the clock and the dice */

const RealDate = Date;
const startMs = q.get('now') ? Number(q.get('now')) : new RealDate(2026, 9, 13, 10, 42, 0).getTime();
const offset = startMs - RealDate.now();
class DemoDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...args);
  }

  static now() { return RealDate.now() + offset; }
}
window.Date = DemoDate;

let seed = Number(q.get('seed')) || 0x9e3779b9;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/* events to the window */

const listeners = { engine: new Set(), browser: new Set() };
const early = { engine: [], browser: [] };

function deliver(name, payload) {
  setTimeout(() => {
    if (!listeners[name].size) { early[name].push(payload); return; }
    for (const cb of listeners[name]) cb({ event: name, id: 0, payload });
  }, 0);
}

/* the pretend shell and engine */

const shell = createBrowserShell({ emitBrowser: (ev) => deliver('browser', ev), emitEngine: (ev) => deliver('engine', ev) });
const engine = createEngine({ send: (ev) => deliver('engine', ev), browser: shell, preset: q.get('ws') || 'base', now: () => Date.now() });

const sent = [];
// The lines the page writes to apaki-window.log (ui_log: a stall, a busy minute), kept for perf.mjs to show (2026-10-15).
const uiLog = [];

async function invoke(cmd, args = {}) {
  if (cmd === 'ui_log') { uiLog.push(String(args.text || '')); if (uiLog.length > 50) uiLog.shift(); return null; }
  // The last ops the window sent, newest last, for a check from outside (window.__demo.sent: an answer, a send...).
  if (cmd === 'engine_send') { sent.push(args.msg); if (sent.length > 200) sent.shift(); engine.handle(args.msg); return null; }
  if (cmd === 'browser') return shell.invoke(args.cmd, args.args || {});
  return null;
}

async function listen(name, cb) {
  if (!listeners[name]) return () => {};
  listeners[name].add(cb);
  for (const payload of early[name].splice(0)) cb({ event: name, id: 0, payload });
  // The engine says hello once the window listens, as the real one does when its pipe opens.
  if (name === 'engine') engine.boot();
  return () => listeners[name].delete(cb);
}

const noop = async () => {};

/**
 * The shell grows new window APIs now and then (a taskbar badge, an overlay icon). Anything the harness
 * does not know answers with a function that does nothing, at any depth, so a new call never throws here.
 */
const deep = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : deep()),
  apply: () => Promise.resolve(undefined),
  construct: () => ({}),
});
const lenient = (real) => new Proxy(real, { get: (t, k) => (k in t ? t[k] : (k === 'then' || typeof k === 'symbol' ? undefined : deep())) });

const win = lenient({
  minimize: noop, toggleMaximize: noop, maximize: noop, close: noop, setSize: noop, setPosition: noop,
  isMaximized: async () => false,
  onResized: async () => () => {},
  onMoved: async () => () => {},
  outerPosition: async () => ({ x: 0, y: 0 }),
  outerSize: async () => ({ width: 2880, height: 1800 }),
});
class Physical { constructor(a, b) { this.width = a; this.height = b; this.x = a; this.y = b; } }

window.__TAURI__ = lenient({
  core: { invoke },
  event: { listen },
  window: lenient({ getCurrentWindow: () => win, availableMonitors: async () => [] }),
  dpi: { PhysicalSize: Physical, PhysicalPosition: Physical },
});

/* the handle for the scene runner */

window.__demo = {
  engine: engine.control,
  shell,
  startedAt: startMs,
  /** The window finished starting: app.js restored its workspace and the first events arrived. */
  ready: () => Boolean(window.__apaki?.S?.restored && window.__apaki.S.sessions.length && window.__apaki.S.defaults.billing),
  /** Show or hide the on-screen pointer (stills hide it). */
  cursor: (on) => document.body.classList.toggle('demo-nocursor', !on),
  phoneScan: (name) => engine.control.phoneScan(name),
  autoTurn: (sessionId, script) => engine.control.autoTurn(sessionId, script),
  state: () => engine.control.state(),
  /** One engine event, as if the engine sent it: an ask, an ask_gone (questions in the pane, askcard.js, 2026-10-12). */
  emit: (ev) => deliver('engine', ev),
  sent,
  uiLog,
};

window.addEventListener('DOMContentLoaded', () => {
  installCursor();
  if (q.get('cursor') === '0') document.body.classList.add('demo-nocursor');
});
