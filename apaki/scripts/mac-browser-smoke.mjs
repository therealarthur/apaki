#!/usr/bin/env node
/**
 * mac-browser-smoke.mjs: runs the built macOS app for real and drives its built-in browser the way Claude does.
 * Written for macOS port phase 2 (2026-10-13). Needs a Mac with a desktop session (a GitHub macOS runner has one).
 *
 *   "<app>/Contents/Resources/node/node" apaki/scripts/mac-browser-smoke.mjs --app "<path>/Myrlin Apaki.app" [--mouse native|js|both]
 *                                                                         [--voice] [--model <ggml-base.en.bin>] [--keep]
 *
 * How: this script plays the engine host. It starts a HostServer (the app's own apaki/engine/host.js, the same protocol the
 * real host speaks) in a scratch CLAUDE_CONFIG_DIR, then opens the app with that folder in its environment, so the window
 * connects to THIS script instead of to a real engine (nothing of the Mac's own Apaki, sessions or keys is touched, and no
 * Claude Code process starts). The window says hello with the features it has; from then on the script is exactly what
 * the engine is to the shell: it builds Claude's browser tools (apaki/engine/browser-tools.js, the very file the app ships)
 * on a shell channel backed by that connection and calls browser_open, _read, _click, _type, _back, _screenshot and
 * _tabs against a small web server of its own. The window's own page reacts as in real use: it makes a browser pane for
 * the page the shell created and places it, which is checked through the shell's debug command.
 *
 *   --mouse   native: clicks go to the page as real mouse events when it is on screen (the default of the app);
 *             js: the same through the bridge script (APAKI_BROWSER_MOUSE=js); both: two runs, one each.
 *   --voice   also runs the bundled whisper-cli on a spoken sentence (say + afconvert) with --model (needs the model file).
 *   --keep    leave the app running and the scratch folder in place afterwards (for looking at it).
 *
 * Exit code 0 when every check passed. Scratch state (CLAUDE_CONFIG_DIR) is removed; the app process this script started
 * is stopped by its pid (never by name).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1] ?? true; };
const app = path.resolve(String(arg('--app') || ''));
if (!arg('--app') || !fs.existsSync(path.join(app, 'Contents', 'MacOS'))) { console.error('usage: mac-browser-smoke.mjs --app "<path to Myrlin Apaki.app>" [--mouse native|js|both] [--voice] [--model <file>] [--keep]'); process.exit(2); }
if (process.platform !== 'darwin') { console.error('this runs on a Mac'); process.exit(2); }
const keep = process.argv.includes('--keep');
const mouseArg = String(arg('--mouse') || 'both');
const resources = path.join(app, 'Contents', 'Resources');
const engineRoot = path.join(resources, 'engine');
const exe = path.join(app, 'Contents', 'MacOS', 'myrlin-apaki');
const imp = (rel) => import(pathToFileURL(path.join(engineRoot, 'apaki', 'engine', rel)).href);
const { HostServer, engineStamp, hostFile } = await imp('host.js');
const { createShell } = await imp('shell-channel.js');
const { createBrowserTools, pngSize } = await imp('browser-tools.js');

const t0 = Date.now();
const results = [];
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`[${at()}] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).replace(/\s+/g, ' ').slice(0, 220)})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- a small site to browse ---------- */

const pages = {
  '/': `<!doctype html><title>Smoke home</title><body style="font:16px sans-serif;margin:24px">
    <h1>Apaki browser smoke</h1>
    <p>Hello from the test site. <a id="two" href="/two">Go to page two</a></p>
    <form id="f" action="/search" method="get"><label>Search <input id="q" name="q" value="old"></label> <button id="go" type="submit">Search now</button></form>
    <p><label><input id="cb" type="checkbox"> Tick me</label></p>
    <p><select id="sel" name="sel"><option>Alpha</option><option>Beta</option><option>Gamma</option></select></p>
    <p><button id="count" onclick="this.textContent='clicked '+(window.n=(window.n||0)+1)">count</button></p>
    <p><textarea id="ta" rows="3" cols="30"></textarea></p>
    <p id="state">idle</p>
    <script>
      document.getElementById('cb').addEventListener('change', (e) => { document.getElementById('state').textContent = 'checkbox ' + (e.target.checked ? 'on' : 'off'); });
      document.getElementById('sel').addEventListener('change', (e) => { document.getElementById('state').textContent = 'selected ' + e.target.value; });
    </script></body>`,
  '/two': '<!doctype html><title>Page two</title><body style="font:16px sans-serif;margin:24px"><h1>Page two</h1><p>You made it. <a href="/">Back home</a></p></body>',
  '/gone': null,
};
const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/search') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Results</title><body style="font:16px sans-serif;margin:24px"><h1>Results</h1><p id="r">You searched for: ${(u.searchParams.get('q') || '').replace(/[<>&]/g, '')}</p></body>`);
    return;
  }
  if (u.pathname === '/gone') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Not here</title><h1>Not found</h1>'); return; }
  const page = pages[u.pathname];
  if (!page) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

/* ---------- one run: the app, the fake host, the tools ---------- */

const appPids = () => {
  const r = spawnSync('pgrep', ['-f', `${exe}`], { encoding: 'utf8' });
  return new Set(String(r.stdout || '').split('\n').map((s) => Number(s.trim())).filter(Boolean));
};

async function run(mouse) {
  console.log(`\n=== run: clicks as ${mouse} events ===`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-browser-smoke-'));
  const env = { CLAUDE_CONFIG_DIR: path.join(scratch, 'claude') };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const before = appPids();
  if (before.size) { check('no other Myrlin Apaki is running on this Mac', false, `pids ${[...before].join(', ')}: quit it first (this run would have been refused by the single-instance check)`); return; }

  let conn = null;
  let shell = null;
  const lines = [];
  const server = new HostServer({
    appId: 'io.myrlin.apaki',
    file: hostFile('io.myrlin.apaki', env),
    root: engineRoot,
    stamp: engineStamp(path.join(engineRoot, 'apaki', 'engine', 'engine.js')),
    log: () => {},
    onConnect: (c) => {
      conn = c;
      shell = createShell({ emit: (ev) => c.send(ev) });
    },
    onLine: (line) => {
      lines.push(line);
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.op === 'shellHello') shell?.hello(m);
      else if (m.op === 'shellReply') shell?.reply(m);
    },
    onGone: () => { conn = null; },
  });
  await server.start();

  const args = ['-n', '--env', `CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`];
  if (mouse === 'js') args.push('--env', 'APAKI_BROWSER_MOUSE=js');
  execFileSync('/usr/bin/open', [...args, app]);

  let pids = new Set();
  try {
    for (let i = 0; i < 100 && !shell?.available; i++) {
      await sleep(300);
      if (!conn) continue;
      await shell.ready(300);
    }
    pids = appPids();
    check('the app started and its window connected to this script', Boolean(conn), conn ? `pids ${[...pids].join(', ')}` : 'no connection after 30 s');
    if (!conn) return;
    check('the window said hello with the browser feature', shell.has('browser'), JSON.stringify(shell.info));
    if (!shell.has('browser')) return;

    const owner = 'smoke-pane';
    const tools = createBrowserTools({ shell, owner: () => owner });
    const call = (name, input = {}) => tools.call(name, input);
    const dbg = async () => shell.request('browser.debug', { owner });

    // open + read
    let r = await call('open', { url: `${base}/` });
    check('browser_open loads a page and waits for it', r.ok && /Smoke home/.test(r.text), r.text);
    r = await call('read');
    const outline = r.text || '';
    check('browser_read gives the title, headings, links and fields with refs', r.ok && /Page: Smoke home/.test(outline) && /heading "Apaki browser smoke"/.test(outline) && /link "Go to page two" \[ref=\d+\]/.test(outline) && /textbox "Search" \[ref=\d+\]/.test(outline), outline.slice(0, 160));
    const ref = (re) => Number((outline.match(re) || [])[1]);

    // click a link
    r = await call('click', { ref: ref(/link "Go to page two" \[ref=(\d+)\]/) });
    check('browser_click follows a link and reports the new page', r.ok && /\/two/.test(r.text) && /Now at/.test(r.text), r.text);
    r = await call('read');
    check('the new page reads as page two', /Page: Page two/.test(r.text || ''), (r.text || '').slice(0, 80));
    r = await call('back');
    check('browser_back returns to the first page', r.ok && /Smoke home/.test(r.text), r.text);

    // type + submit
    r = await call('read');
    const out2 = r.text || '';
    const q = Number((out2.match(/textbox "Search" \[ref=(\d+)\]/) || [])[1]);
    r = await call('type', { ref: q, text: 'hello world', submit: true });
    check('browser_type replaces a field and Enter submits the form', r.ok && /search\?q=hello(\+|%20)world/.test(r.text), r.text);
    r = await call('read');
    check('the results page shows what was typed', /You searched for: hello world/.test(r.text || ''), (r.text || '').slice(0, 200));
    r = await call('back');

    // checkbox, select, button, textarea
    r = await call('read');
    const out3 = r.text || '';
    const num = (re) => Number((out3.match(re) || [])[1]);
    r = await call('click', { ref: num(/checkbox "Tick me" \[ref=(\d+)\]/) });
    const afterCb = (await call('read')).text || '';
    check('browser_click ticks a checkbox', r.ok && /checkbox "Tick me" \[ref=\d+\] \[checked\]/.test(afterCb) && /checkbox on/.test(afterCb), afterCb.split('\n').filter((l) => /checkbox|state|idle/.test(l)).join(' | '));
    r = await call('type', { ref: num(/combobox "[^"]*" \[ref=(\d+)\]/), text: 'Beta' });
    check('browser_type picks an option in a dropdown', r.ok && /Beta/.test(r.text), r.text);
    r = await call('click', { ref: num(/button "count" \[ref=(\d+)\]/) });
    const afterBtn = (await call('read')).text || '';
    check('browser_click presses a button (page script runs)', /clicked 1/.test(afterBtn), afterBtn.split('\n').filter((l) => /button/.test(l)).join(' | '));
    r = await call('type', { ref: num(/textbox "" \[ref=(\d+)\]/), text: 'line one' });
    check('browser_type fills a textarea', r.ok && /line one/.test(r.text), r.text);

    // pictures
    r = await call('screenshot');
    const size = r.image ? pngSize(Buffer.from(r.image, 'base64')) : null;
    check('browser_screenshot returns a PNG at most 1280 px wide', r.ok && size && size.w >= 200 && size.w <= 1280 && size.h >= 100, size ? `${size.w}x${size.h}, ${Math.round((r.image.length * 3) / 4 / 1024)} KB` : r.text);
    const shotHome = r.image;
    await call('open', { url: `${base}/two` });
    const shotTwo = (await call('screenshot')).image;
    check('a different page gives a different picture', Boolean(shotHome && shotTwo) && shotHome !== shotTwo && shotTwo.length > 2000);
    const view = await tools.view();
    check('the phone view (a JPEG of the page and its state) works', view.ok && view.mimeType === 'image/jpeg' && view.width <= 1280, `${view.width}x${view.height} ${view.mimeType}`);

    // status and errors
    r = await call('open', { url: `${base}/gone` });
    check('an HTTP 404 is reported with its status', r.ok && /404/.test(r.text), r.text);
    r = await call('open', { url: 'http://127.0.0.1:9/' });
    check('an address that cannot be reached is reported, not hung', !r.ok && /could not load|connect/.test(r.text), r.text);

    // tabs
    await call('open', { url: `${base}/`, paneHint: 'tab' });
    let tabs = await call('tabs');
    check('a second page opens as a tab of the same browser pane', tabs.ok && (tabs.tabs || []).length >= 2, tabs.text);
    tabs = await call('tabs', { select: 1 });
    check('browser_tabs switches tabs', tabs.ok && /Switched to tab 1/.test(tabs.text), tabs.text);
    const list = (await call('tabs')).tabs || [];
    tabs = await call('tabs', { close: list.length });
    check('browser_tabs closes a tab', tabs.ok && /Closed tab/.test(tabs.text), tabs.text);

    // placement: the window's page placed the pane; the frame must lie inside the window
    await sleep(1500);
    const d = await dbg();
    const wf = d.window?.frame;
    const mainF = d.main?.frame;
    const b = (d.browsers || []).find((x) => x.shown) || (d.browsers || [])[0];
    check('the window made a pane for the page and placed it inside the window', Boolean(b && b.shown && wf && b.frame.w > 150 && b.frame.h > 150 && b.frame.w <= (mainF?.w || wf.w) + 1 && b.frame.h <= (mainF?.h || wf.h) + 1), JSON.stringify({ scale: d.scale, window: wf && { w: wf.w, h: wf.h }, main: mainF, frame: b?.frame, hidden: b?.hidden, shown: b?.shown, flipped: d.main?.flipped }));
    if (b && d.main) {
      const flipped = d.main.flipped;
      const topInMain = flipped ? b.frame.y - d.main.frame.y : d.main.frame.y + d.main.frame.h - (b.frame.y + b.frame.h);
      check('the pane sits below the title bar and the tab row, not at the very top', topInMain > 20, `top edge ${topInMain.toFixed(0)} pt below the top of the page`);
    }
    // a placement with known numbers lands where it should
    const scale = d.scale || 2;
    await shell.request('browser.place', { id: b?.id, x: 200 * scale, y: 120 * scale, w: 500 * scale, h: 300 * scale, visible: true });
    const d2 = await dbg();
    const f2 = (d2.browsers || []).find((x) => x.id === b?.id)?.frame;
    const m2 = d2.main;
    if (f2 && m2) {
      const topLeftX = f2.x - m2.frame.x;
      const topY = m2.flipped ? f2.y - m2.frame.y : m2.frame.y + m2.frame.h - (f2.y + f2.h);
      check('place() puts a pane at the point given in physical pixels', Math.abs(topLeftX - 200) < 1.5 && Math.abs(topY - 120) < 1.5 && Math.abs(f2.w - 500) < 1.5 && Math.abs(f2.h - 300) < 1.5, JSON.stringify({ topLeftX, topY, w: f2.w, h: f2.h }));
    } else check('place() puts a pane at the point given in physical pixels', false, 'no frame');
    const counters = d2.mouse || {};
    console.log(`  clicks sent: ${counters.native || 0} as real mouse events, ${counters.js || 0} through the bridge`);
    check(`clicks used the ${mouse} path`, mouse === 'js' ? (counters.native || 0) === 0 && (counters.js || 0) > 0 : (counters.native || 0) > 0, JSON.stringify(counters));

    // everything closes
    for (const t of (await call('tabs')).tabs || []) await shell.request('browser.close', { id: t.id }).catch(() => {});
  } catch (e) {
    check('the run finished without an error', false, e.stack || e);
  } finally {
    if (!keep) {
      for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      await sleep(800);
      for (const pid of appPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      server.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/* ---------- voice ---------- */

function voice() {
  console.log('\n=== voice ===');
  const cli = path.join(resources, 'voice', 'bin', 'Release', 'whisper-cli');
  check('whisper-cli is in the app and signed', fs.existsSync(cli) && spawnSync('codesign', ['--verify', '--strict', cli]).status === 0);
  const model = arg('--model');
  if (!model || model === true || !fs.existsSync(model)) { console.log('  (no --model file: the spoken-sentence check is skipped)'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-voice-smoke-'));
  try {
    execFileSync('say', ['-o', path.join(tmp, 'a.aiff'), 'Hello from the Apaki voice check, one two three.']);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path.join(tmp, 'a.aiff'), path.join(tmp, 'a.wav')]);
    const t1 = Date.now();
    const r = spawnSync(cli, ['-m', model, '-f', path.join(tmp, 'a.wav'), '-nt', '-np', '-l', 'en'], { encoding: 'utf8' });
    const text = String(r.stdout || '').replace(/\s+/g, ' ').trim();
    check('whisper-cli transcribes a spoken sentence on this Mac', r.status === 0 && /hello/i.test(text) && /(one|1).*(two|2)/i.test(text), `"${text}" in ${Date.now() - t1} ms${/metal|GPU/i.test(r.stderr || '') ? ', Metal in use' : ''}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/* ---------- BROWSER shim ---------- */

function shim() {
  console.log('\n=== BROWSER shim ===');
  const sh = path.join(engineRoot, 'apaki', 'bin', 'apaki-open');
  check('apaki-open is in the app and executable', fs.existsSync(sh) && (fs.statSync(sh).mode & 0o111) !== 0);
  const r = spawnSync(sh, ['http://127.0.0.1:9/x?a=1&b=2'], { env: { ...process.env, APAKI_NODE: path.join(resources, 'node', 'node'), APAKI_OPEN_NO_FALLBACK: '1' }, encoding: 'utf8' });
  check('apaki-open runs on the app\'s own Node and exits cleanly', r.status === 0, r.stderr);
}

try {
  shim();
  if (process.argv.includes('--voice')) voice();
  for (const m of mouseArg === 'both' ? ['native', 'js'] : mouseArg === 'none' ? [] : [mouseArg]) await run(m);
} finally {
  site.close();
}
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
