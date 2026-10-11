/**
 * capture.mjs: renders Apaki's demo scenes to stills and short videos for the
 * product page (apaki.myrlin.io).
 *
 * For every scene and theme it opens the real desktop UI on demo data
 * (apaki/ui plus the harness in apaki/demo/harness, served from a short-lived
 * static server this script starts and stops itself) at 1440x900 with a
 * device scale factor of 2, light or dark, then
 *   stills:  runs the scene once and saves PNGs (2880x1800) at its key moments
 *   video:   runs it again with Playwright's recorder, cuts the clip to the
 *            scene, and converts it with ffmpeg to WebM (VP9) and MP4 (H.264),
 *            30 fps, 1440x900, each under 4 MB, 8 to 14 seconds.
 * Everything is invented demo data; nothing is read from this machine.
 *
 * Usage (arguments are key=value; none is required):
 *   node apaki/demo/capture.mjs
 *   node apaki/demo/capture.mjs scene=steer,phone-pair theme=dark video=0
 *   scene=<names>      comma separated; default all (see README.md)
 *   theme=<light|dark|both>   default both
 *   out=<folder>       default D:\apaki-media on Windows, ~/apaki-media elsewhere
 *   stills=<1|0>  video=<1|0>   default 1 and 1
 *   keep=1             keep the raw Playwright recordings (in <out>/video/raw)
 *   list=1             print the scenes and exit
 *   playwright=<dir>   a folder holding node_modules/playwright (default: this repo's, then ~/.claude/mcp/playwright)
 *   chromium=<exe>     a Chromium or headless shell executable (default: Playwright's, else the newest in its cache)
 *   ffmpeg=<exe>       ffmpeg (default: $FFMPEG, then ffmpeg on the PATH, then ffmpeg-static)
 *
 * Runs headless in its own temporary profile: it never touches your own browser.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './server.mjs';
import { SCENES, runScene, sceneNames } from './scenes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORT = { width: 1440, height: 900 };
const MAX_CLIP_BYTES = 4_000_000;
const MIN_SECONDS = 8;
const MAX_SECONDS = 14;
// The recorder starts a little before the page is on screen; the cut looks this much earlier than begin().
const CUT_LEAD_SECONDS = 0.1;

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return i < 0 ? [a, '1'] : [a.slice(0, i), a.slice(i + 1)]; }));
const flag = (k, d) => (args[k] == null ? d : !['0', 'false', 'no', 'off'].includes(String(args[k]).toLowerCase()));

if (args.list) {
  for (const n of sceneNames()) console.log(`${n.padEnd(11)} ${SCENES[n].title}\n            ${SCENES[n].shows}`);
  process.exit(0);
}

const OUT = path.resolve(args.out || process.env.APAKI_MEDIA_DIR || (process.platform === 'win32' ? 'D:\\apaki-media' : path.join(os.homedir(), 'apaki-media')));
const WANT_SCENES = args.scene ? args.scene.split(',').map((s) => s.trim()).filter(Boolean) : sceneNames();
const THEMES = args.theme === 'light' ? ['light'] : args.theme === 'dark' ? ['dark'] : ['light', 'dark'];
const DO_STILLS = flag('stills', true);
const DO_VIDEO = flag('video', true);
const KEEP_RAW = flag('keep', false);

for (const n of WANT_SCENES) if (!SCENES[n]) { console.error(`No scene called "${n}". Scenes: ${sceneNames().join(', ')}`); process.exit(1); }

/* finding the tools */

async function loadPlaywright() {
  const tries = [];
  if (args.playwright) tries.push(path.join(args.playwright, 'node_modules', 'playwright', 'index.mjs'));
  if (process.env.PLAYWRIGHT_DIR) tries.push(path.join(process.env.PLAYWRIGHT_DIR, 'node_modules', 'playwright', 'index.mjs'));
  tries.push(path.resolve(HERE, '..', '..', 'node_modules', 'playwright', 'index.mjs'));
  tries.push(path.join(os.homedir(), '.claude', 'mcp', 'playwright', 'node_modules', 'playwright', 'index.mjs'));
  for (const t of tries) if (fs.existsSync(t)) return import(pathToFileURL(t).href);
  try { return await import('playwright'); } catch { /* fall through */ }
  throw new Error(`Playwright not found. Tried:\n  ${tries.join('\n  ')}\nPass playwright=<folder holding node_modules/playwright>.`);
}

/** The newest browser in Playwright's cache, for when the one its version wants was never downloaded. */
function newestChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'), path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  const rel = {
    win32: [['chromium_headless_shell-', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'], ['chromium-', 'chrome-win64', 'chrome.exe'], ['chromium-', 'chrome-win', 'chrome.exe']],
    darwin: [['chromium_headless_shell-', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'], ['chromium_headless_shell-', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell']],
    linux: [['chromium_headless_shell-', 'chrome-headless-shell-linux64', 'chrome-headless-shell'], ['chromium-', 'chrome-linux', 'chrome']],
  }[process.platform] || [];
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      for (const [prefix, a, b] of rel) {
        if (!dir.startsWith(prefix)) continue;
        const exe = path.join(root, dir, a, b);
        if (fs.existsSync(exe)) found.push({ rev: Number(dir.slice(prefix.length)) || 0, headless: prefix.includes('headless'), exe });
      }
    }
  }
  found.sort((x, y) => (Number(y.headless) - Number(x.headless)) || (y.rev - x.rev));
  return found[0]?.exe || null;
}

function findFfmpeg() {
  const cands = [args.ffmpeg, process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
  try { cands.push(createRequire(import.meta.url)('ffmpeg-static')); } catch { /* not installed here */ }
  for (const c of cands) {
    const r = spawnSync(c, ['-version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

function run(cmd, argv) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, err }));
  });
}

/** Duration, size and codec of a media file, read from ffmpeg's banner. */
function probe(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const text = `${r.stderr || ''}`;
  const d = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(text);
  const v = /Video:\s*(\w+)[^\n]*?,\s*(\d{3,5})x(\d{3,5})/.exec(text);
  return { seconds: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null, codec: v?.[1] || null, width: v ? Number(v[2]) : null, height: v ? Number(v[3]) : null };
}

/** Cuts [start, start+len) from a raw recording and encodes it under the size limit; steps the quality down until it fits. */
async function encode(ffmpeg, raw, base, start, len) {
  const vf = 'fps=30,scale=1440:900:flags=lanczos,format=yuv420p';
  const outs = [];
  const targets = [
    { ext: 'webm', crfs: [31, 35, 39, 43], build: (crf, out) => ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf), '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-an', out] },
    { ext: 'mp4', crfs: [22, 26, 30, 34], build: (crf, out) => ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out] },
  ];
  for (const t of targets) {
    const out = `${base}.${t.ext}`;
    for (const crf of t.crfs) {
      const r = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(3), '-i', raw, '-t', len.toFixed(3), '-vf', vf, ...t.build(crf, out)]);
      if (r.code !== 0) { console.error(`    ffmpeg failed for ${path.basename(out)}: ${r.err.trim().split('\n').pop()}`); break; }
      const size = fs.statSync(out).size;
      if (size <= MAX_CLIP_BYTES || crf === t.crfs[t.crfs.length - 1]) { outs.push({ file: out, bytes: size, crf }); break; }
    }
  }
  return outs;
}

/**
 * A fingerprint of apaki/ui as it is right now (names, sizes and contents of its html, js and css), written into
 * the manifest so a picture can later be told apart from the UI it came from.
 */
function uiFingerprint() {
  const ui = path.resolve(HERE, '..', 'ui');
  const h = createHash('sha1');
  let newest = 0;
  let count = 0;
  for (const f of fs.readdirSync(ui).filter((n) => /\.(html|js|css)$/.test(n)).sort()) {
    const full = path.join(ui, f);
    h.update(f).update(fs.readFileSync(full));
    newest = Math.max(newest, fs.statSync(full).mtimeMs);
    count += 1;
  }
  return { files: count, sha1: h.digest('hex').slice(0, 12), newestChange: new Date(newest).toISOString() };
}

/* provenance notes (the folder is outside the repo; see ~/.claude/CLAUDE.md rule 8) */

function ensureNotes() {
  const made = 'Claude Code (Sonnet 5.5), 2026-10-11';
  const write = (dir, text) => { const f = path.join(dir, '_WHY_THIS_IS_HERE.md'); if (!fs.existsSync(f)) fs.writeFileSync(f, text); };
  fs.mkdirSync(path.join(OUT, 'stills'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'video'), { recursive: true });
  write(OUT, `# apaki-media

Screenshots and short screen recordings of Myrlin Apaki's desktop window, for the product landing page (apaki.myrlin.io).

- Project: claude-latch (apaki), request: "a demo harness that runs Apaki's real desktop UI in a browser on demo data, for marketing screenshots and recordings".
- Made by: ${made}.
- Every picture shows invented demo data (a fictional team, "acme-web", "Fix flaky checkout test"). Nothing in it comes from a real session, path, account or person.

## What is here

- \`stills/\`: PNG screenshots at 2880x1800 (1440x900 at 2x), \`<scene>-<theme>.png\` for each scene's hero shot and \`<scene>-<label>-<theme>.png\` for its other moments. Light and dark.
- \`video/\`: the same scenes as clips, \`<scene>-<theme>.webm\` (VP9) and \`.mp4\` (H.264), 1440x900, 30 fps, 8 to 14 seconds, each under 4 MB.
- \`manifest.json\`: every file with its size, duration and the scene and theme it belongs to.

## Where it comes from

\`node apaki/demo/capture.mjs\` in the claude-latch repo (apaki/demo/README.md explains the scenes, the options and the harness).
It serves apaki/ui with a pretend engine on 127.0.0.1, drives it with Playwright, and converts with ffmpeg.
Each run overwrites the files for the scenes it renders.

## Safe to delete?

Yes. Nothing else reads this folder; the site gets copies. Regenerate everything with \`node apaki/demo/capture.mjs\`.
If you copy files to the site, copy them; do not point the site at this folder.
`);
  write(path.join(OUT, 'stills'), `# stills

PNG screenshots of Apaki's demo scenes (2880x1800, light and dark), made by \`node apaki/demo/capture.mjs\` (Claude Code, Sonnet 5.5, 2026-10-11).
See ../_WHY_THIS_IS_HERE.md. Safe to delete; regenerate with that command.
`);
  write(path.join(OUT, 'video'), `# video

Short clips of Apaki's demo scenes: .webm (VP9) and .mp4 (H.264), 1440x900, 30 fps, under 4 MB each, made by \`node apaki/demo/capture.mjs\` (Claude Code, Sonnet 5.5, 2026-10-11).
\`raw/\` holds Playwright's own recordings only when capture ran with keep=1.
See ../_WHY_THIS_IS_HERE.md. Safe to delete; regenerate with that command.
`);
}

/* running a scene */

async function openScene(browser, { scene, theme, baseUrl, recordDir }) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'America/New_York', colorScheme: theme,
    ...(recordDir ? { recordVideo: { dir: recordDir, size: VIEWPORT } } : {}),
  });
  const startedAt = Date.now();
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  await page.goto(`${baseUrl}/desktop.html?ws=${encodeURIComponent(SCENES[scene].ws)}&theme=${theme}`);
  await page.waitForFunction(() => window.__demo?.ready?.(), null, { timeout: 20000 });
  // Context meters, history and the Glass card settle in over the first second or two.
  await page.waitForTimeout(2200);
  return { ctx, page, problems, startedAt };
}

async function main() {
  const pw = await loadPlaywright();
  const chromium = pw.chromium || pw.default?.chromium;
  const ffmpeg = DO_VIDEO ? findFfmpeg() : null;
  if (DO_VIDEO && !ffmpeg) console.warn('No ffmpeg found (set ffmpeg=<exe> or $FFMPEG): videos are skipped; stills are still made.');
  ensureNotes();

  let browser;
  const launchOpts = { headless: true, ...(args.chromium ? { executablePath: args.chromium } : {}) };
  try { browser = await chromium.launch(launchOpts); } catch (e) {
    const exe = args.chromium || newestChromium();
    if (!exe || !/Executable doesn't exist|not found|install/i.test(String(e.message))) throw e;
    console.log(`Using the browser at ${exe}`);
    browser = await chromium.launch({ headless: true, executablePath: exe });
  }

  const server = await startServer();
  console.log(`Harness at ${server.url} (stops when this run ends). Output: ${OUT}`);
  const manifest = [];
  const problems = [];
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-demo-raw-'));
  const started = Date.now();

  try {
    for (const theme of THEMES) {
      for (const name of WANT_SCENES) {
        if (DO_STILLS) {
          const t0 = Date.now();
          const { ctx, page, problems: probs } = await openScene(browser, { scene: name, theme, baseUrl: server.url });
          const saved = [];
          const result = await runScene(page, name, {
            stills: true,
            onStill: async (label, png) => {
              const file = path.join(OUT, 'stills', `${name}-${label}-${theme}.png`);
              fs.writeFileSync(file, png);
              saved.push({ label, file, bytes: png.length });
              if (label === SCENES[name].hero) fs.writeFileSync(path.join(OUT, 'stills', `${name}-${theme}.png`), png);
            },
          });
          await ctx.close();
          for (const s of saved) manifest.push({ scene: name, theme, kind: 'still', hero: s.label === SCENES[name].hero, label: s.label, file: path.relative(OUT, s.file).replace(/\\/g, '/'), bytes: s.bytes, width: 2880, height: 1800 });
          console.log(`  ${name} / ${theme}: ${saved.length} stills (${((Date.now() - t0) / 1000).toFixed(1)} s, scene ${result.seconds.toFixed(1)} s)`);
          for (const p of probs) problems.push(`${name}/${theme} stills: ${p}`);
        }
        if (DO_VIDEO && ffmpeg) {
          const t0 = Date.now();
          const dir = fs.mkdtempSync(path.join(rawDir, `${name}-${theme}-`));
          const { ctx, page, problems: probs, startedAt } = await openScene(browser, { scene: name, theme, baseUrl: server.url, recordDir: dir });
          const result = await runScene(page, name, { stills: false });
          const video = page.video();
          await ctx.close();
          const raw = await video.path();
          const start = Math.max(0, (result.beganAt - startedAt) / 1000 - CUT_LEAD_SECONDS);
          const len = Math.min(MAX_SECONDS, result.seconds + CUT_LEAD_SECONDS + 0.3);
          if (result.seconds < MIN_SECONDS || result.seconds > MAX_SECONDS + 1) console.warn(`    note: ${name} runs ${result.seconds.toFixed(1)} s; the target is ${MIN_SECONDS} to ${MAX_SECONDS}`);
          const base = path.join(OUT, 'video', `${name}-${theme}`);
          const outs = await encode(ffmpeg, raw, base, start, len);
          for (const o of outs) {
            const info = probe(ffmpeg, o.file);
            manifest.push({ scene: name, theme, kind: 'video', file: path.relative(OUT, o.file).replace(/\\/g, '/'), bytes: o.bytes, seconds: info.seconds, width: info.width, height: info.height, codec: info.codec, crf: o.crf });
          }
          if (KEEP_RAW) { fs.mkdirSync(path.join(OUT, 'video', 'raw'), { recursive: true }); fs.copyFileSync(raw, path.join(OUT, 'video', 'raw', `${name}-${theme}.webm`)); }
          console.log(`  ${name} / ${theme}: video ${outs.map((o) => `${path.extname(o.file)} ${(o.bytes / 1e6).toFixed(2)} MB`).join(', ')} (${((Date.now() - t0) / 1000).toFixed(1)} s, scene ${result.seconds.toFixed(1)} s)`);
          for (const p of probs) problems.push(`${name}/${theme} video: ${p}`);
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close();
    fs.rmSync(rawDir, { recursive: true, force: true });
  }

  // The manifest keeps earlier entries for scenes this run did not render.
  const mf = path.join(OUT, 'manifest.json');
  let old = [];
  try { old = JSON.parse(fs.readFileSync(mf, 'utf8')).files || []; } catch { /* first run */ }
  const fresh = new Set(manifest.map((m) => `${m.scene}|${m.theme}|${m.kind}`));
  const files = [...old.filter((m) => !fresh.has(`${m.scene}|${m.theme}|${m.kind}`)), ...manifest].sort((a, b) => a.file.localeCompare(b.file));
  fs.writeFileSync(mf, `${JSON.stringify({ madeBy: 'node apaki/demo/capture.mjs', madeAt: new Date().toISOString(), ui: uiFingerprint(), viewport: VIEWPORT, deviceScaleFactor: 2, files }, null, 2)}\n`);

  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(0)} s. ${manifest.length} files written under ${OUT}.`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s) seen in the page:`);
    for (const p of [...new Set(problems)].slice(0, 40)) console.log(`  ${p}`);
    process.exitCode = 2;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
