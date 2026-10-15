/**
 * perf.mjs: measures how sharp Apaki's window stays under load (2026-10-15).
 *
 * The report: "our apaki app gets kind of laggy with multiple tabs and panes running at the same time - it doesnt stay
 * sharp - why?" This opens the real desktop UI on the demo harness's load workspace (harness/load.mjs: five tabs,
 * thirteen conversations, five working, long transcripts, the side panel, hundreds of sessions, 26 repositories whose
 * numbers move every few seconds) in headless Chromium, types into a composer the whole time like a person, and
 * reports what the page's main thread did:
 *
 *   startup        how long the workspace took to come back, and its longest stall
 *   busy           share of the main thread spent in tasks while the load runs (CDP Performance TaskDuration),
 *                  split into script, layout and style; and the share the pretend engine itself took (it runs on
 *                  the page's thread here, unlike the real one), so the window's own share can be read
 *   input          time from a key press in the composer to the next frame after it (p50, p95, worst)
 *   long tasks     how many per minute, and the worst
 *   watching       the same, with no one typing
 *   load all       the worst stall while a paged conversation's 2700 earlier messages come in (Load all)
 *   tab switches   the worst stall when each tab comes forward
 *   memory         JS heap and DOM nodes at the end
 *   hot spots      the functions with the most time, by self time and (Apaki's own) by total time
 *
 * Usage (key=value, none required):
 *   node apaki/demo/perf.mjs
 *   seconds=<n>     the measured stretch with the load running (default 60)
 *   warm=<n>        seconds of load before measuring (default 12)
 *   watch=<n>       seconds of the same load with no typing, measured after (default 15; 0 skips it)
 *   throttle=<n>    CPU slowdown, as DevTools does it (default 1)
 *   label=<text>    a name for this run in the summary (default "run")
 *   out=<folder>    also write <label>.json (the numbers) and <label>.cpuprofile (open it in DevTools) there
 *   ws=<preset>     another workspace (default load)
 *   ui=<folder>     serve another copy of apaki/ui (an older version, for a before and after on the same harness)
 *   playwright=<dir>, chromium=<exe>   as capture.mjs
 *
 * One headless browser in a temporary profile, closed at the end with the short-lived server it starts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return i < 0 ? [a, '1'] : [a.slice(0, i), a.slice(i + 1)]; }));
const SECONDS = Number(args.seconds || 60);
const WARM = Number(args.warm || 12);
const THROTTLE = Number(args.throttle || 1);
const LABEL = String(args.label || 'run').replace(/[^\w.-]+/g, '-');
const WS = args.ws || 'load';
const OUT = args.out ? path.resolve(args.out) : null;
const KEY_EVERY_MS = 250;
const WATCH = Number(args.watch ?? 15);

async function loadPlaywright() {
  const tries = [];
  if (args.playwright) tries.push(path.join(args.playwright, 'node_modules', 'playwright', 'index.mjs'));
  tries.push(path.resolve(HERE, '..', '..', 'node_modules', 'playwright', 'index.mjs'));
  tries.push(path.join(os.homedir(), '.claude', 'mcp', 'playwright', 'node_modules', 'playwright', 'index.mjs'));
  for (const t of tries) if (fs.existsSync(t)) return import(pathToFileURL(t).href);
  throw new Error(`Playwright not found. Tried:\n  ${tries.join('\n  ')}`);
}

/** The newest headless shell (or Chromium) in Playwright's cache, for when the one its version wants was never downloaded. */
function newestChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'), path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  const rel = {
    win32: [['chromium_headless_shell-', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'], ['chromium-', 'chrome-win64', 'chrome.exe']],
    darwin: [['chromium_headless_shell-', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'], ['chromium_headless_shell-', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell']],
    linux: [['chromium_headless_shell-', 'chrome-headless-shell-linux64', 'chrome-headless-shell'], ['chromium-', 'chrome-linux', 'chrome']],
  }[process.platform] || [];
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      for (const [prefix, a, b] of rel) {
        const exe = path.join(root, dir, a, b);
        if (dir.startsWith(prefix) && fs.existsSync(exe)) found.push({ rev: Number(dir.slice(prefix.length)) || 0, headless: prefix.includes('headless'), exe });
      }
    }
  }
  found.sort((x, y) => (Number(y.headless) - Number(x.headless)) || (y.rev - x.rev));
  return found[0]?.exe || null;
}

/** Headless Chromium: the one chromium= names, else Playwright's own, else the newest in its cache. */
async function launch(chromium) {
  if (args.chromium) return chromium.launch({ headless: true, executablePath: args.chromium });
  try { return await chromium.launch({ headless: true }); } catch (e) {
    const exe = newestChromium();
    if (!exe) throw e;
    return chromium.launch({ headless: true, executablePath: exe });
  }
}

/** What the page records for us: long tasks, and each key press's time to the next frame. Installed before the UI loads. */
function probe() {
  const P = { longs: [], keys: [], measuring: false };
  window.__perf = P;
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) P.longs.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true });
  } catch { /* no long-task timing */ }
  // From the key's own time stamp (when the browser took it in) to the next frame, plus a task after it: the moment the
  // typed letter can be on screen. Queueing behind other work on the main thread is in it.
  window.addEventListener('keydown', (e) => {
    if (!P.measuring) return;
    const t0 = e.timeStamp;
    requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => P.keys.push(performance.now() - t0);
      ch.port2.postMessage(0);
    });
  }, true);
}

/**
 * A Chrome trace of the measured stretch, summed (trace=1): the renderer main thread's own time per event name, and for
 * style and layout the script that forced them (or "frame" when the browser did it for a frame).
 */
function summarizeTrace(events) {
  const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  if (!main) return null;
  const mine = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X' && typeof e.dur === 'number').sort((a, b) => a.ts - b.ts);
  // Self time: each event's duration minus its children's (events nest by time on one thread).
  const self = new Map();
  const forced = new Map();
  const stack = [];
  for (const e of mine) {
    while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.child += e.dur;
    const rec = { e, end: e.ts + e.dur, child: 0, root: !parent, kids: [] };
    if (parent) { let r = parent; while (r.up) r = r.up; rec.up = r; r.kids.push(e); }
    stack.push(rec);
    e._rec = rec;
  }
  for (const e of mine) {
    const s = (e.dur - e._rec.child) / 1000;
    self.set(e.name, (self.get(e.name) || 0) + s);
    if (e.name === 'UpdateLayoutTree' || e.name === 'Layout') {
      const st = e.args?.beginData?.stackTrace || e.args?.data?.stackTrace;
      const top = st?.[0] ? `${st[0].functionName || '(anonymous)'} ${String(st[0].url || '').replace(/^.*\/(ui|harness)\//, '$1/')}:${st[0].lineNumber}` : 'frame';
      const k = `${e.name} <- ${top}`;
      const f = forced.get(k) || { ms: 0, n: 0, objects: 0, elements: 0 };
      f.ms += e.dur / 1000;
      f.n += 1;
      // How much each one touched: objects laid out (Layout), elements restyled (UpdateLayoutTree).
      f.objects += Number(e.args?.beginData?.dirtyObjects) || 0;
      f.elements += Number(e.args?.elementCount ?? e.args?.data?.elementCount) || 0;
      forced.set(k, f);
    }
  }
  // The long tasks (over 50 ms): what filled each one, by event name and by the scripts that ran in it.
  const longs = [];
  for (const r of mine) {
    if (!r._rec.root || r.dur < 50_000) continue;
    const inside = r._rec.kids;
    const by = new Map();
    for (const e of inside) {
      const fn = e.name === 'FunctionCall' || e.name === 'EventDispatch' || e.name === 'TimerFire' || e.name === 'FireAnimationFrame'
        ? `${e.name}:${e.args?.data?.functionName || e.args?.data?.type || ''}@${String(e.args?.data?.url || '').replace(/^.*\/(ui|harness)\//, '$1/')}:${e.args?.data?.lineNumber ?? ''}`
        : e.name;
      by.set(fn, (by.get(fn) || 0) + (e.dur - e._rec.child) / 1000);
    }
    const laid = inside.filter((e) => e.name === 'Layout').reduce((n, e) => n + (Number(e.args?.beginData?.dirtyObjects) || 0), 0);
    const styled = inside.filter((e) => e.name === 'UpdateLayoutTree').reduce((n, e) => n + (Number(e.args?.elementCount) || 0), 0);
    longs.push({ ms: Math.round(r.dur / 1000), what: `[laid out ${laid}, restyled ${styled}] ${[...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}` });
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => (b[1].ms ?? b[1]) - (a[1].ms ?? a[1])).slice(0, n);
  return {
    longs: longs.sort((a, b) => b.ms - a.ms).slice(0, 15),
    selfMs: top(self, 25).map(([k, v]) => ({ name: k, ms: Math.round(v) })),
    styleLayout: top(forced, 25).map(([k, v]) => ({ what: k, ms: Math.round(v.ms), n: v.n, avgObjects: Math.round(v.objects / v.n), avgElements: Math.round(v.elements / v.n) })),
  };
}

/** Starts and stops a timeline trace on a CDP session; stop() resolves with summarizeTrace's numbers. */
function traceTo(cdp) {
  let events = [];
  cdp.on('Tracing.dataCollected', (d) => { events.push(...d.value); });
  return {
    async start() {
      events = [];
      await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack', 'blink', '__metadata'] } });
    },
    async stop() {
      const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
      await cdp.send('Tracing.end');
      await done;
      return summarizeTrace(events);
    },
  };
}

const pct = (list, p) => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/** Self and total time per function from a CPU profile; `own` picks the functions whose total is reported. */
function hotSpots(profile, own = (url) => /\/ui\//.test(url)) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const key = (n) => `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.replace(/^.*\/(ui|harness)\//, '$1/')}:${n.callFrame.lineNumber + 1}`;
  const self = new Map();
  const total = new Map();
  let harness = 0;
  let idle = 0;
  let all = 0;
  const dts = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i += 1) {
    const dt = (dts[i + 1] ?? dts[i] ?? 0) / 1000;
    const leaf = byId.get(profile.samples[i]);
    if (!leaf) continue;
    all += dt;
    const name = leaf.callFrame.functionName;
    if (name === '(idle)' || name === '(program)') { if (name === '(idle)') idle += dt; }
    const k = key(leaf);
    self.set(k, (self.get(k) || 0) + dt);
    const seen = new Set();
    let inHarness = false;
    for (let id = leaf.id; id != null; id = parent.get(id)) {
      const n = byId.get(id);
      if (/\/harness\//.test(n.callFrame.url)) inHarness = true;
      if (!own(n.callFrame.url)) continue;
      const kk = key(n);
      if (seen.has(kk)) continue;
      seen.add(kk);
      total.set(kk, (total.get(kk) || 0) + dt);
    }
    // Time under the pretend engine (its turns, its timers, building events) is not the window's.
    if (inHarness && !own(leaf.callFrame.url)) harness += dt;
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => ({ fn: k, ms: Math.round(ms) }));
  return { selfTop: top(new Map([...self].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k))), 30), ownTotalTop: top(total, 30), harnessMs: Math.round(harness), idleMs: Math.round(idle), sampledMs: Math.round(all), gcMs: Math.round([...self].filter(([k]) => k.startsWith('(garbage collector)')).reduce((s, [, v]) => s + v, 0)) };
}

async function main() {
  const { chromium } = await loadPlaywright();
  const server = await startServer({ ui: args.ui || null });
  const browser = await launch(chromium);
  const summary = { label: LABEL, ws: WS, seconds: SECONDS, warm: WARM, throttle: THROTTLE, at: new Date().toISOString() };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.addInitScript(probe);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

    // Startup: the saved workspace comes back, every pane opens and draws its transcript.
    const t0 = Date.now();
    await page.goto(`${server.url}/desktop.html?ws=${encodeURIComponent(WS)}&theme=dark&cursor=0`);
    await page.waitForFunction(() => window.__demo?.ready?.(), null, { timeout: 60_000 });
    await page.waitForFunction(() => [...window.__apaki.S.panes.values()].filter((p) => !p.isViewer).every((p) => !p.sessionId || p.historyShownFor), null, { timeout: 120_000 }).catch(() => {});
    summary.startup = { readyMs: Date.now() - t0 };
    await page.waitForTimeout(1500);
    const boot = await page.evaluate(() => window.__perf.longs.splice(0));
    summary.startup.longTasks = boot.length;
    summary.startup.worstMs = Math.round(Math.max(0, ...boot.map((l) => l.ms)));
    summary.startup.totalLongMs = Math.round(boot.reduce((s, l) => s + l.ms, 0));

    // The load runs a while before anything is measured.
    await page.waitForTimeout(WARM * 1000);

    // The measured stretch: typing into the focused conversation's message box the whole time.
    await page.evaluate(() => { const p = window.__apaki.focusedPane(); p.$.input.focus(); window.__perf.longs.length = 0; window.__perf.keys.length = 0; window.__perf.measuring = true; });
    const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    // The window's own busy estimate (perfwatch.js, the minute line's), read over the same stretch to check it.
    const peekWatch = () => page.evaluate(async () => { try { const { watch } = await import('/ui/perfwatch.js'); const p = watch.peek(); return { samples: p.allSamples, busy: p.allBusy }; } catch { return null; } });
    const pw0 = await peekWatch();
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
    // trace=1: a timeline trace as well (it slows the page a little; for finding causes, not for the numbers).
    const tracer = traceTo(cdp);
    if (args.trace === '1') await tracer.start();
    const start = Date.now();
    let typed = 0;
    while (Date.now() - start < SECONDS * 1000) {
      const next = start + (typed + 1) * KEY_EVERY_MS;
      await page.keyboard.press(String.fromCharCode(97 + (typed % 26)));
      typed += 1;
      // A person clears what they typed now and then; the box never grows past a line or two.
      if (typed % 40 === 0) { await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace'); }
      const wait = next - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    const wall = (Date.now() - start) / 1000;
    if (args.trace === '1') summary.trace = await tracer.stop();
    const { profile } = await cdp.send('Profiler.stop');
    const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const pw1 = await peekWatch();
    const got = await page.evaluate(() => { window.__perf.measuring = false; return { longs: window.__perf.longs.splice(0), keys: window.__perf.keys.splice(0) }; });
    const d = (k) => (m1[k] || 0) - (m0[k] || 0);
    const hs = hotSpots(profile);
    summary.measured = {
      wallS: r1(wall),
      keys: got.keys.length,
      busyPct: r1((d('TaskDuration') / wall) * 100),
      scriptPct: r1((d('ScriptDuration') / wall) * 100),
      layoutPct: r1((d('LayoutDuration') / wall) * 100),
      stylePct: r1((d('RecalcStyleDuration') / wall) * 100),
      harnessPct: r1((hs.harnessMs / 1000 / wall) * 100),
      windowBusyPct: r1(((d('TaskDuration') - hs.harnessMs / 1000) / wall) * 100),
      layouts: d('LayoutCount'),
      styleRecalcs: d('RecalcStyleCount'),
      inputP50Ms: r1(pct(got.keys, 50)),
      inputP95Ms: r1(pct(got.keys, 95)),
      inputMaxMs: r1(Math.max(0, ...got.keys)),
      longTasksPerMin: r1((got.longs.length / wall) * 60),
      worstLongTaskMs: Math.round(Math.max(0, ...got.longs.map((l) => l.ms))),
      longTaskMsPerMin: Math.round((got.longs.reduce((s, l) => s + l.ms, 0) / wall) * 60),
      gcMs: hs.gcMs,
      // What the window's minute line would say for this stretch (null for a UI without perfwatch.js).
      windowBusyEstimatePct: pw0 && pw1 && pw1.samples > pw0.samples ? r1(((pw1.busy - pw0.busy) / (pw1.samples - pw0.samples)) * 100) : null,
    };
    summary.memory = { jsHeapMB: r1((m1.JSHeapUsedSize || 0) / 1048576), domNodes: m1.Nodes, listeners: m1.JSEventListeners };

    // Watching: the same load with no one typing (reading what the panes write), for WATCH seconds.
    if (WATCH > 0) {
      await page.evaluate(() => { document.activeElement?.blur?.(); window.__perf.longs.length = 0; });
      const w0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
      const ws = Date.now();
      await page.waitForTimeout(WATCH * 1000);
      const ww = (Date.now() - ws) / 1000;
      const w1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
      const wl = await page.evaluate(() => window.__perf.longs.splice(0));
      const dw = (k) => (w1[k] || 0) - (w0[k] || 0);
      summary.watching = {
        wallS: r1(ww), busyPct: r1((dw('TaskDuration') / ww) * 100), layoutPct: r1((dw('LayoutDuration') / ww) * 100), stylePct: r1((dw('RecalcStyleDuration') / ww) * 100),
        layouts: dw('LayoutCount'), styleRecalcs: dw('RecalcStyleCount'), longTasksPerMin: r1((wl.length / ww) * 60), worstLongTaskMs: Math.round(Math.max(0, ...wl.map((l) => l.ms))),
      };
    }

    // Load all: the whole of a paged conversation in the tab on screen (2700 earlier messages), as Load all and Ctrl+F's
    // Search all bring it in; the worst stall while it comes.
    {
      await page.evaluate(() => { window.__perf.longs.length = 0; });
      const la0 = Date.now();
      const ok = await page.evaluate(() => window.__apaki.S.panes.get('lp4')?.loadAllHistory?.() ?? null).catch(() => null);
      await page.waitForTimeout(1500);
      const ll = await page.evaluate(() => window.__perf.longs.splice(0));
      summary.loadAll = { done: ok, ms: Date.now() - la0 - 1500, worstMs: Math.round(Math.max(0, ...ll.map((l) => l.ms))), longTasks: ll.length };
    }

    // Each tab comes forward once (Ctrl+Tab), as you would go and look at the work in the others.
    // trace=switch: a trace and a profile of the switches instead of the measured stretch.
    if (args.trace === 'switch') { await tracer.start(); await cdp.send('Profiler.start'); }
    const switches = [];
    for (let i = 0; i < 5; i += 1) {
      await page.evaluate(() => { window.__perf.longs.length = 0; });
      await page.keyboard.press('Control+Tab');
      await page.waitForTimeout(2500);
      const ls = await page.evaluate(() => window.__perf.longs.splice(0));
      switches.push(Math.round(Math.max(0, ...ls.map((l) => l.ms))));
    }
    summary.tabSwitch = { worstMs: Math.max(...switches), each: switches };
    // What the page wrote to apaki-window.log meanwhile (a stall over a second, a busy minute: app.js, perfwatch.js).
    summary.windowLog = await page.evaluate(() => [...(window.__demo.uiLog || [])]);
    if (args.trace === 'switch') {
      summary.trace = await tracer.stop();
      const sw = hotSpots((await cdp.send('Profiler.stop')).profile);
      hs.selfTop = sw.selfTop;
      hs.ownTotalTop = sw.ownTotalTop;
    }
    summary.hot = { selfTop: hs.selfTop, ownTotalTop: hs.ownTotalTop };
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify(summary, null, 2));
      fs.writeFileSync(path.join(OUT, `${LABEL}.cpuprofile`), JSON.stringify(profile));
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  const { hot, trace, ...numbers } = summary;
  console.log(JSON.stringify(numbers, null, 2));
  if (trace) {
    console.log('\nMain thread self time by trace event (top 25):');
    for (const t of trace.selfMs) console.log(`  ${String(t.ms).padStart(6)} ms  ${t.name}`);
    console.log('\nStyle and layout by cause (top 25):');
    for (const t of trace.styleLayout) console.log(`  ${String(t.ms).padStart(6)} ms  ${String(t.n).padStart(5)}x  ${t.what}  (each: ${t.avgObjects} objects, ${t.avgElements} elements)`);
    console.log('\nLong tasks (the 15 longest, self time inside in ms):');
    for (const t of trace.longs) console.log(`  ${String(t.ms).padStart(6)} ms  ${t.what}`);
  }
  console.log('\nSelf time (top 30):');
  for (const h of hot.selfTop) console.log(`  ${String(h.ms).padStart(6)} ms  ${h.fn}`);
  console.log('\nApaki UI functions by total time (top 30):');
  for (const h of hot.ownTotalTop) console.log(`  ${String(h.ms).padStart(6)} ms  ${h.fn}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
