/**
 * perf-bench.mjs: what Apaki's window UI costs the machine, measured in the demo harness.
 *
 * Runs the real window UI (apaki/ui, through apaki/demo/server.mjs, on invented data) in Playwright's
 * Chromium with the real GPU (ANGLE on D3D11, the same stack WebView2 uses) and records, per scenario:
 *   - CPU of each browser process (browser, renderer, GPU) as cores used, from CDP SystemInfo.getProcessInfo
 *   - GPU engine use of those processes (Windows "GPU Engine" counters, when available)
 *   - main-thread work: Performance.getMetrics deltas (task, script, layout, style recalc), long tasks
 *   - frames drawn per second, from a short trace (Display::DrawAndSwap) and the main thread's busiest events
 *   - typing latency: key press to the next frame, while other panes stream
 *   - how many CSS animations are running
 *
 *   node apaki/scripts/perf-bench.mjs [scenario=idle,busy,stream,blurred] [secs=20] [label=before] [out=<file.json>]
 *
 * Scenarios (all on the 3-tab "split" workspace at 1600x900):
 *   idle     one pane on screen, nothing running: the cost of the decoration alone
 *   busy     4 split panes, 3 of them working (glow, working line, thinking verb), nothing streaming
 *   stream   as busy, and the 3 working panes plus 2 panes in background tabs stream long markdown replies
 *            (300 characters a second each) while text is typed into the fourth pane
 *   blurred  as busy, after the window loses focus (window blur): decorative motion should be stopped
 *
 * Nothing here touches the machine's own Apaki, browsers or accounts: it starts its own Chromium in a
 * temporary profile and its own harness server, and stops both when it ends (by handle, never by name).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../demo/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return i < 0 ? [a, '1'] : [a.slice(0, i), a.slice(i + 1)]; }));
const SECS = Number(args.secs || 20);
const LABEL = args.label || 'run';
const WANT = (args.scenario || 'idle,busy,stream,blurred').split(',');
const CORES = os.cpus().length;
const ID = {
  invoices: 'a1c4e7b2-0002-4f3a-9c6d-2b8e5f0d7102', push: 'a1c4e7b2-0003-4f3a-9c6d-2b8e5f0d7103', review: 'a1c4e7b2-0004-4f3a-9c6d-2b8e5f0d7104',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  const tries = [
    args.playwright && path.join(args.playwright, 'node_modules', 'playwright', 'index.mjs'),
    path.resolve(HERE, '..', '..', 'node_modules', 'playwright', 'index.mjs'),
    path.join(os.homedir(), '.claude', 'mcp', 'playwright', 'node_modules', 'playwright', 'index.mjs'),
  ].filter(Boolean);
  for (const t of tries) if (fs.existsSync(t)) return import(pathToFileURL(t).href);
  throw new Error(`Playwright not found. Tried: ${tries.join(', ')}`);
}

/** A full Chromium (new headless, real GPU) from Playwright's cache; the headless shell has no GPU. */
function chromiumExe() {
  if (args.chromium) return args.chromium;
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'ms-playwright');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))) : [];
  for (const d of dirs) {
    for (const sub of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

/* ---------- page-side helpers (run in the harness page) ---------- */

/** Long markdown the streaming panes cycle through: paragraphs, lists, code, a table, a quote, headings. */
const CORPUS = [
  '## What I found\n\nThe checkout test is flaky because the **order total** is read before the cart store has settled. The `useOrder` hook returns a stale `Cart` for one render, and the assertion races it.\n\n',
  '- The hook reads `cart.items` synchronously\n- The store flushes on the next microtask\n- The test asserts inside `act()` but does not await the flush\n- On a slow CI box the flush loses the race about one run in twelve\n\n',
  'Here is the change I would make:\n\n```ts\nexport function useOrder(cart: Cart) {\n  const [total, setTotal] = useState(() => sum(cart.items));\n  useEffect(() => {\n    // Recompute once the store has flushed, never on the stale render.\n    const off = cart.subscribe(() => setTotal(sum(cart.items)));\n    return off;\n  }, [cart]);\n  return { total, count: cart.items.length };\n}\n```\n\n',
  '| Run | Before | After |\n| - | -: | -: |\n| Local | 1 in 40 | 0 in 200 |\n| CI | 1 in 12 | 0 in 200 |\n| Slow CI | 1 in 5 | 0 in 200 |\n\n',
  '> A flaky test is a bug report from the future. Read it that way and the fix is rarely a retry.\n\n',
  '### Why not a retry\n\nA retry hides the race and keeps the slow path. The test now waits for the store with `await waitFor(() => expect(total).toBe(42))`, so it fails loudly when the hook is wrong and passes when it is right. Ten runs in a row, all green; I will leave the loop running on CI overnight and check the timing in the morning.\n\n',
  '1. Run `npm test -- checkout` ten times\n2. Compare the timings with `main`\n3. Open the pull request with the numbers in the description\n4. Ask for a review from the payments owners\n\nThat is the whole change. The diff is 14 lines in two files, and nothing else moves.\n\n',
].join('');

/**
 * Starts a fake reply stream in a pane: message_start, a text block, then 12-character deltas every 40 ms (about
 * 300 characters a second), cycling through the corpus, ending each reply with the finished message. Same
 * entry point the real engine events use (Pane.onSdk).
 */
function pageStreamer({ corpus }) {
  window.__streams = window.__streams || [];
  window.__startStream = (paneId, { cps = 300, tick = 40 } = {}) => {
    const pane = window.__apaki.S.panes.get(paneId);
    if (!pane) return false;
    pane.setBusy(true);
    const per = Math.max(1, Math.round((cps * tick) / 1000));
    let n = 0;
    let pos = 0;
    let id = null;
    let open = false;
    const h = setInterval(() => {
      if (!open) {
        id = `bench-${paneId}-${++n}`;
        pane.onSdk({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
        pane.onSdk({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
        open = true;
        pos = 0;
      }
      const text = corpus.slice(pos, pos + per);
      pos += per;
      pane.onSdk({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
      if (pos >= corpus.length) {
        pane.onSdk({ type: 'assistant', message: { id, content: [{ type: 'text', text: corpus }] } });
        open = false;
        // A pause between replies, as a turn has between messages.
        pos = -per * 12;
      }
    }, tick);
    window.__streams.push(h);
    return true;
  };
  window.__stopStreams = () => { for (const h of window.__streams) clearInterval(h); window.__streams = []; };
}

/**
 * Gives a pane a long conversation the way the engine's history event does: `turns` rounds of a prompt, a reply
 * with markdown, a tool call and its result (4 messages a round). Returns how long drawing it took.
 */
function pageHistory({ paneId, turns, corpus }) {
  const pane = window.__apaki.S.panes.get(paneId);
  if (!pane) return null;
  const now = Date.now();
  const messages = [];
  const tools = ['Read', 'Grep', 'Bash', 'Edit'];
  for (let i = 0; i < turns; i++) {
    const at = new Date(now - (turns - i) * 60000).toISOString();
    const tid = `toolu_${paneId}_${i}`;
    const name = tools[i % tools.length];
    const input = name === 'Bash' ? { command: `npm test -- --grep case${i}` } : name === 'Edit' ? { file_path: `src/mod${i % 40}.ts`, old_string: `const a${i} = 1;`, new_string: `const a${i} = 2;` } : name === 'Grep' ? { pattern: `thing${i}`, path: 'src' } : { file_path: `src/mod${i % 40}.ts` };
    messages.push({ type: 'user', uuid: `u-${paneId}-${i}`, at, prompt: { text: `Round ${i}: please look at module ${i % 40} and tell me what you find about case ${i}.` }, message: { content: [{ type: 'text', text: `Round ${i}` }] } });
    messages.push({ type: 'assistant', at, message: { content: [{ type: 'text', text: corpus.slice((i * 137) % 600, ((i * 137) % 600) + 900 + (i % 5) * 300) }, { type: 'tool_use', id: tid, name, input }] } });
    messages.push({ type: 'user', at, message: { content: [{ type: 'tool_result', tool_use_id: tid, content: `line one of ${name} output ${i}\nline two\nline three\nline four\nline five` }] } });
    messages.push({ type: 'assistant', at, message: { content: [{ type: 'text', text: `Done with round ${i}. The change is small and the tests still pass.` }] } });
  }
  const t0 = performance.now();
  pane.handle({ ev: 'history', paneId, sessionId: pane.sessionId, messages, total: messages.length, source: 'transcript', first: 0, hasMore: false, earlier: 0, rev: `bench-${paneId}-${turns}`, refresh: true });
  return { ms: Math.round(performance.now() - t0), messages: messages.length };
}

/** Installed before the measurement: long tasks, key-to-frame timings and event timing. */
function pageRecorder() {
  const rec = { longTasks: [], keys: [], slowEvents: [], loaf: [] };
  window.__rec = rec;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) rec.longTasks.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false });
  } catch (e) { /* not supported */ }
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) rec.slowEvents.push({ n: e.name, d: e.duration, delay: e.processingStart - e.startTime }); }).observe({ type: 'event', durationThreshold: 16, buffered: false });
  } catch (e) { /* not supported */ }
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) rec.loaf.push(Math.round(e.duration)); }).observe({ type: 'long-animation-frame', buffered: false });
  } catch (e) { /* not supported */ }
  // Key to next frame: from the event's own timestamp (when the browser got it, so queueing behind a busy main thread counts)
  // to a message posted from the frame callback (after the frame's work has run).
  const mc = new MessageChannel();
  const waiting = [];
  mc.port1.onmessage = () => { const t0 = waiting.shift(); if (t0 != null) rec.keys.push(performance.now() - t0); };
  document.addEventListener('input', (e) => {
    const t0 = e.timeStamp;
    requestAnimationFrame(() => { waiting.push(t0); mc.port2.postMessage(0); });
  }, true);
}

/* ---------- measuring ---------- */

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

/** Windows "GPU Engine" counters for some pids, summed per pid over the window (percent of one engine). */
function gpuEngine(pids, seconds) {
  if (process.platform !== 'win32' || !pids.length) return Promise.resolve(null);
  const ps = `$s = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -SampleInterval 1 -MaxSamples ${Math.max(2, seconds)} -ErrorAction SilentlyContinue; `
    + `$o = @{}; foreach ($x in $s) { foreach ($c in $x.CounterSamples) { if ($c.Path -match 'pid_(\\d+)_' -and ($pidList -contains $Matches[1])) { $k = $Matches[1]; if (-not $o[$k]) { $o[$k] = 0 }; $o[$k] += $c.CookedValue } } } `
    + `$o.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value / ${Math.max(2, seconds)})" }`;
  const script = `$pidList = @(${pids.map((p) => `'${p}'`).join(',')}); ${ps}`;
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      const res = {};
      for (const line of out.split(/\r?\n/)) { const m = /^(\d+) ([\d.,]+)$/.exec(line.trim()); if (m) res[m[1]] = Number(m[2].replace(',', '.')); }
      resolve(res);
    });
    child.on('error', () => resolve(null));
  });
}

/** Sums a trace by thread: busy time of each thread's top-level tasks, frames drawn, and the busiest main-thread events. */
function summariseTrace(events, seconds) {
  const procName = new Map();
  const threadName = new Map();
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'process_name') procName.set(e.pid, e.args?.name);
    if (e.ph === 'M' && e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args?.name);
  }
  const busy = {};
  const byName = {};
  let swaps = 0;
  let begin = 0;
  let drawFrames = 0;
  for (const e of events) {
    if (e.ph !== 'X' && e.ph !== 'B' && e.ph !== 'I' && e.ph !== 'i') continue;
    const tn = threadName.get(`${e.pid}:${e.tid}`) || String(e.tid);
    const pn = procName.get(e.pid) || String(e.pid);
    if (e.name === 'Display::DrawAndSwap') swaps++;
    if (e.name === 'BeginMainThreadFrame' || e.name === 'ProxyMain::BeginMainFrame') begin++;
    if (e.name === 'DrawFrame') drawFrames++;
    if (e.ph !== 'X') continue;
    if (e.name === 'ThreadControllerImpl::RunTask') {
      const k = `${pn} / ${tn}`;
      busy[k] = (busy[k] || 0) + (e.dur || 0);
    }
    if (/CrRendererMain/.test(tn) && /^(UpdateLayoutTree|Layout|PrePaint|Paint|Layerize|Commit|HitTest|ParseHTML|FunctionCall|EvaluateScript|UpdateLayer|CompositeLayers|RunMicrotasks|TimerFire|FireAnimationFrame|RequestAnimationFrame|ResourceFinish|IntersectionObserverController::computeIntersections|ResizeObserver|StyleRecalc)/.test(e.name)) {
      byName[e.name] = (byName[e.name] || 0) + (e.dur || 0);
    }
  }
  // What the heavy events were about: style recalcs (elements touched) and layouts (objects dirty of all), per second.
  const rc = events.filter((e) => e.ph === 'X' && e.name === 'UpdateLayoutTree' && e.args?.elementCount != null);
  const lay = events.filter((e) => e.ph === 'X' && e.name === 'Layout' && e.args?.beginData);
  const detail = {
    recalcs: rc.length / seconds,
    recalcMeanElements: rc.length ? Math.round(rc.reduce((a, e) => a + e.args.elementCount, 0) / rc.length) : 0,
    recalcMeanMs: rc.length ? r1(rc.reduce((a, e) => a + (e.dur || 0), 0) / rc.length / 1000) : 0,
    layouts: lay.length / seconds,
    layoutMeanDirty: lay.length ? Math.round(lay.reduce((a, e) => a + (e.args.beginData.dirtyObjects || 0), 0) / lay.length) : 0,
    layoutMeanTotal: lay.length ? Math.round(lay.reduce((a, e) => a + (e.args.beginData.totalObjects || 0), 0) / lay.length) : 0,
    layoutMeanMs: lay.length ? r1(lay.reduce((a, e) => a + (e.dur || 0), 0) / lay.length / 1000) : 0,
  };
  const busyMs = Object.entries(busy).map(([k, us]) => [k, r1(us / 1000 / seconds)]).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const top = Object.entries(byName).map(([k, us]) => [k, r1(us / 1000 / seconds)]).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { detail, fps: r1(swaps / seconds), mainFrames: r1(begin / seconds), drawFrame: r1(drawFrames / seconds), busyMsPerSec: busyMs, mainEventsMsPerSec: top };
}

async function processTimes(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  return processInfo;
}

const metricsMap = (m) => Object.fromEntries(m.metrics.map((x) => [x.name, x.value]));

async function openWindow(browser, baseUrl, { ws = 'split', theme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.addInitScript(pageRecorder);
  await page.goto(`${baseUrl}/desktop.html?ws=${ws}&theme=${theme}&cursor=0`);
  await page.waitForFunction(() => window.__demo?.ready?.(), null, { timeout: 30000 });
  // css=<rules>: injected after load, to try a change without editing app.css (A/B runs).
  if (args.css) await page.addStyleTag({ content: args.css });
  // rings=<n>: n sidebar rows get a keep-warm ring (Arthur keeps about 19 warm), to cost the ring at his scale.
  if (args.rings) {
    await page.waitForSelector('.sessions li', { timeout: 15000 });
    await sleep(800);
    await page.evaluate((n) => {
      const rows = [...document.querySelectorAll('.sessions li')].filter((li) => !li.querySelector('.warm-ring')).slice(0, n);
      for (const li of rows) { li.classList.add('warm'); const r = document.createElement('span'); r.className = 'warm-ring'; li.append(r); }
    }, Number(args.rings));
  }
  await page.evaluate(pageStreamer, { corpus: CORPUS });
  await sleep(1200);
  return { ctx, page };
}

async function openSplit(page) {
  for (const [key, id, script] of [['inv', ID.invoices, 'background-invoices'], ['push', ID.push, 'background-push'], ['rev', ID.review, 'background-review']]) {
    await page.click(`.sessions li[data-id="${id}"]`, { modifiers: ['Shift'] });
    await page.waitForFunction((sid) => window.__demo.state().panes.some((p) => p.sessionId === sid), id);
    await sleep(300);
    void key; void script;
  }
}

/** Scenario setups. Each returns after the window is in the state to be measured. */
const SETUP = {
  async idle(page) { await sleep(500); },
  async busy(page) {
    await openSplit(page);
    for (const [id, script] of [[ID.invoices, 'background-invoices'], [ID.push, 'background-push'], [ID.review, 'background-review']]) {
      await page.evaluate(({ sid, sc }) => window.__demo.autoTurn(sid, sc), { sid: id, sc: script });
      await sleep(300);
    }
    // Past the scripts' opening replies, into their long tool waits: working, glowing, quiet.
    await sleep(12000);
  },
  async stream(page) {
    await SETUP.busy(page);
  },
  /** Arthur's load: 3 tabs, 6 panes, long transcripts, 4 streaming at once, typing in a visible pane. */
  async heavy(page) {
    const turns = Number(args.turns || 600);
    // Tab 1 gets two more panes (3), tab 2 one more (2), tab 3 stays at one: 6 panes in 3 tabs.
    for (const id of [ID.invoices, ID.push]) {
      await page.click(`.sessions li[data-id="${id}"]`, { modifiers: ['Shift'] });
      await page.waitForFunction((sid) => window.__demo.state().panes.some((p) => p.sessionId === sid), id);
      await sleep(300);
    }
    await page.click('#tabs .tab:nth-child(2)');
    await sleep(300);
    await page.click(`.sessions li[data-id="${ID.review}"]`, { modifiers: ['Shift'] });
    await page.waitForFunction((sid) => window.__demo.state().panes.some((p) => p.sessionId === sid), ID.review);
    await sleep(300);
    await page.click('#tabs .tab:nth-child(1)');
    await sleep(500);
    const list = await page.evaluate(() => [...window.__apaki.S.panes.values()].map((p) => ({ id: p.id, sid: p.sessionId })));
    const drawn = [];
    for (const p of list) {
      const r = await page.evaluate(pageHistory, { paneId: p.id, turns, corpus: CORPUS });
      drawn.push({ pane: p.id, ...r });
      await sleep(200);
    }
    await page.evaluate(() => { for (const p of window.__apaki.S.panes.values()) p.scrollDown?.(true); });
    await sleep(1500);
    SETUP.heavyInfo = { panes: list.length, history: drawn };
  },
  async blurred(page) {
    await SETUP.busy(page);
    // What Tauri forwards when the window loses focus: the page is no longer the focused document, and blur fires.
    await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
    await sleep(800);
  },
};

async function measure(browser, page, { seconds, typing = false, trace = true, typeSel = '.pane.focused textarea' }) {
  const cdp = await page.context().newCDPSession(page);
  const bcdp = await browser.newBrowserCDPSession();
  await cdp.send('Performance.enable');
  const procs0 = await processTimes(bcdp);
  const m0 = metricsMap(await cdp.send('Performance.getMetrics'));
  await page.evaluate(() => { window.__rec.longTasks.length = 0; window.__rec.keys.length = 0; window.__rec.slowEvents.length = 0; window.__rec.loaf.length = 0; });
  const t0 = Date.now();
  const gpuP = gpuEngine(procs0.filter((p) => p.type === 'GPU' || p.type === 'renderer' || p.type === 'browser').map((p) => p.id), seconds);
  let typed = 0;
  const typer = (async () => {
    if (!typing) return;
    await sleep(3000);
    await page.focus(typeSel);
    const text = 'Please check the retry path as well and tell me what you find. ';
    const end = Date.now() + Math.max(2000, (seconds - 6) * 1000);
    let i = 0;
    while (Date.now() < end) {
      await page.keyboard.type(text[i % text.length], { delay: 0 });
      typed++; i++;
      await sleep(90 + Math.round(Math.random() * 60));
    }
  })();
  await sleep(seconds * 1000);
  await typer;
  const wall = (Date.now() - t0) / 1000;
  const procs1 = await processTimes(bcdp);
  const m1 = metricsMap(await cdp.send('Performance.getMetrics'));
  const gpuUse = await gpuP;
  const rec = await page.evaluate(() => ({ longTasks: window.__rec.longTasks.slice(), keys: window.__rec.keys.slice(), slow: window.__rec.slowEvents.slice(), loaf: window.__rec.loaf.slice(), anims: document.getAnimations().length, running: document.getAnimations().filter((a) => a.playState === 'running').length, nodes: document.getElementsByTagName('*').length }));

  const byType = {};
  for (const p1 of procs1) {
    const p0 = procs0.find((p) => p.id === p1.id);
    if (!p0) continue;
    const key = p1.type === 'renderer' ? 'renderer' : p1.type === 'GPU' ? 'gpu' : p1.type === 'browser' ? 'browser' : 'other';
    byType[key] = (byType[key] || 0) + (p1.cpuTime - p0.cpuTime) / wall;
  }
  const cores = Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, r2(v)]));
  const total = r2(Object.values(byType).reduce((a, b) => a + b, 0));
  const d = (k) => r1(((m1[k] || 0) - (m0[k] || 0)) * 1000 / wall);
  const main = { taskMsPerSec: d('TaskDuration'), scriptMsPerSec: d('ScriptDuration'), layoutMsPerSec: d('LayoutDuration'), styleMsPerSec: d('RecalcStyleDuration'), layouts: r1(((m1.LayoutCount || 0) - (m0.LayoutCount || 0)) / wall), recalcs: r1(((m1.RecalcStyleCount || 0) - (m0.RecalcStyleCount || 0)) / wall), heapMB: r1((m1.JSHeapUsedSize || 0) / 1048576), domNodes: rec.nodes };
  const gpuPid = procs1.find((p) => p.type === 'GPU')?.id;
  const gpuPct = gpuUse ? r1(Object.entries(gpuUse).reduce((a, [, v]) => a + v, 0)) : null;
  const out = { seconds: r1(wall), coresUsed: cores, totalCores: total, pctOfAllCores: r2((total / CORES) * 100), gpuEnginePct: gpuPct, gpuProcessEnginePct: gpuUse && gpuPid ? r1(gpuUse[String(gpuPid)] || 0) : null, main, longTasks: { n: rec.longTasks.length, maxMs: Math.max(0, ...rec.longTasks), totalMs: rec.longTasks.reduce((a, b) => a + b, 0) }, longFrames: { n: rec.loaf.length, maxMs: Math.max(0, ...rec.loaf) }, animations: { total: rec.anims, running: rec.running } };
  if (typing) {
    out.typing = { keys: typed, measured: rec.keys.length, p50: r1(pct(rec.keys, 50)), p95: r1(pct(rec.keys, 95)), max: r1(Math.max(0, ...rec.keys)), slowEvents16ms: rec.slow.length, slowestEventMs: Math.max(0, ...rec.slow.map((e) => e.d)), worstInputDelayMs: r1(Math.max(0, ...rec.slow.map((e) => e.delay))) };
  }
  await cdp.send('Performance.disable');

  // profile=1: a JS CPU profile of a few seconds, the busiest functions by self time (JS only; layout and paint are in the trace).
  if (args.profile) {
    const pcdp = await page.context().newCDPSession(page);
    await pcdp.send('Profiler.enable');
    await pcdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await pcdp.send('Profiler.start');
    await sleep(6000);
    const { profile } = await pcdp.send('Profiler.stop');
    const self = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const dt = profile.timeDeltas;
    profile.samples.forEach((id, i) => {
      const n = byId.get(id);
      const f = n.callFrame;
      const key = `${f.functionName || '(anon)'} ${String(f.url).split('/').pop()}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) || 0) + (dt[i] || 0));
    });
    // Inclusive time: every function on a sample's stack gets the sample's time once.
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const incl = new Map();
    profile.samples.forEach((id, i) => {
      const seen = new Set();
      for (let cur = id; cur != null; cur = parent.get(cur)) {
        const f = byId.get(cur).callFrame;
        const key = `${f.functionName || '(anon)'} ${String(f.url).split('/').pop()}:${f.lineNumber + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        incl.set(key, (incl.get(key) || 0) + (dt[i] || 0));
      }
    });
    out.profileInclusive = [...incl.entries()].filter(([k]) => !/^\(root\)|^\(program\)|^\(idle\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 22).map(([k, us]) => [k, r1(us / 1000 / 6)]);
    out.profile = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, us]) => [k, r1(us / 1000 / 6)]);
    await pcdp.send('Profiler.disable');
  }

  // A second, short pass with a trace on for frames per second and where the main thread's time goes (tracing perturbs, so not in the CPU numbers).
  if (trace) {
    const tf = path.join(os.tmpdir(), `apaki-perf-trace-${process.pid}.json`);
    await browser.startTracing(page, { path: tf, categories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'cc', 'viz', 'gpu', 'benchmark'] });
    const tsecs = Math.min(8, seconds);
    await sleep(tsecs * 1000);
    await browser.stopTracing();
    let events = [];
    try { events = JSON.parse(fs.readFileSync(tf, 'utf8')).traceEvents || []; } catch (e) { out.traceError = String(e.message || e); }
    try { fs.unlinkSync(tf); } catch { /* temp file already gone */ }
    out.trace = summariseTrace(events, tsecs);
  }
  return out;
}

async function main() {
  const pw = await loadPlaywright();
  const exe = chromiumExe();
  const browser = await pw.chromium.launch({
    headless: true,
    ...(exe ? { executablePath: exe } : {}),
    args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
  });
  const server = await startServer();
  const results = { label: LABEL, when: new Date().toISOString(), cores: CORES, browser: await browser.version(), seconds: SECS, scenarios: {} };
  try {
    for (const name of WANT) {
      if (!SETUP[name]) { console.error(`No scenario "${name}"`); continue; }
      const { ctx, page } = await openWindow(browser, server.url);
      try {
        await SETUP[name](page);
        if (name === 'heavy') {
          const ids = await page.evaluate(() => [...window.__apaki.S.panes.values()].map((p) => ({ id: p.id, session: p.sessionId })));
          // Four stream (two in the visible tab, two in a background tab); the typing pane and the sixth stay quiet.
          let n = 0;
          for (const p of ids) {
            if (p.session === 'a1c4e7b2-0001-4f3a-9c6d-2b8e5f0d7101' || p.session === 'a1c4e7b2-0005-4f3a-9c6d-2b8e5f0d7105') continue;
            if (n >= Number(args.streams ?? 4)) break;
            if (await page.evaluate((id) => window.__startStream(id), p.id)) n++;
          }
          results.streamingPanes = n;
          results.heavyInfo = SETUP.heavyInfo;
          await sleep(1500);
        }
        if (name === 'stream') {
          // Three visible working panes and two background tabs stream together.
          const ids = await page.evaluate(() => [...window.__apaki.S.panes.values()].map((p) => ({ id: p.id, hasBox: p.hasBox(), session: p.sessionId, tab: window.__apaki.S.tabs.find((t) => window.__apaki.L.ids(t.root).includes(p.id))?.id, active: window.__apaki.S.active })));
          let n = 0;
          for (const p of ids) {
            if (p.session === 'a1c4e7b2-0001-4f3a-9c6d-2b8e5f0d7101') continue; // the idle pane keeps the keyboard
            if (await page.evaluate((id) => window.__startStream(id), p.id)) n++;
          }
          results.streamingPanes = n;
          await sleep(1500);
        }
        console.log(`${name}: measuring ${SECS}s ...`);
        results.scenarios[name] = await measure(browser, page, { seconds: SECS, typing: args.typing !== '0' && (name === 'stream' || name === 'busy' || name === 'heavy'), trace: args.trace !== '0', typeSel: name === 'heavy' ? '[data-pane="pa1"] textarea' : undefined });
        if (!args.quiet) console.log(JSON.stringify({ [name]: results.scenarios[name] }, null, 1));
      } finally {
        await page.evaluate(() => window.__stopStreams?.()).catch(() => {});
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  const file = args.out || path.join(os.tmpdir(), `apaki-perf-${LABEL}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`Wrote ${file}`);
  table(results);
}

function table(results) {
  const rows = [['scenario', 'cores (renderer/gpu/browser)', 'total %all', 'gpu eng %', 'fps', 'main ms/s', 'key p50/p95/max ms', 'anim run']];
  for (const [name, s] of Object.entries(results.scenarios)) {
    rows.push([name, `${s.coresUsed.renderer ?? 0}/${s.coresUsed.gpu ?? 0}/${s.coresUsed.browser ?? 0}`, s.pctOfAllCores, s.gpuEnginePct ?? '-', s.trace?.fps ?? '-', s.main.taskMsPerSec, s.typing ? `${s.typing.p50}/${s.typing.p95}/${s.typing.max}` : '-', `${s.animations.running}/${s.animations.total}`]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join('  '));
}

main().catch((e) => { console.error(e); process.exit(1); });
