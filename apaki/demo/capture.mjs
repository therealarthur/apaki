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
 * Close-ups (2026-10-12): a scene with a `crop` (scenes.mjs) is recorded another way, so text is sharp on 2x
 * screens. Playwright's recorder and a plain screencast give CSS-pixel frames, so the page runs in a second browser
 * started with Chromium's force-device-scale-factor switch (2), a context at device scale 2, and a CDP screencast
 * (Page.startScreencast, JPEG, up to 2880x1800) that is written out frame by frame with its arrival time. The clip
 * is cut at the scene's begin(), built at a constant 30 fps with ffmpeg's concat demuxer, cropped to the scene's
 * rectangle (CSS pixels times two) and scaled to its maxWidth, and encoded to MP4 under 1.5 MB. Stills of such a
 * scene are cropped the same way. Both land in <out>/crops: <name>-<theme>.mp4, <name>-<theme>.png (the hero's
 * cropped still, the poster) and <name>-<label>-<theme>.png. Scenes without a crop run exactly as before.
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
 *   tune=<name>        x264's -tune for the close-up clips (default animation; none for no tune)
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
/**
 * What each kind of scene is shown on (2026-10-12). A scene with device: 'phone' (scenes.mjs) opens
 * phone.html at an iPhone's 390x844 with touch (stills at 2x, 780x1688). Playwright's recorder
 * captures CSS pixels, so the clip is 390x844 (asking for more only pads the frame). Desktop scenes
 * are as before.
 */
const DEVICES = {
  desktop: { page: 'desktop.html', viewport: VIEWPORT, record: VIEWPORT, scale: 2, touch: false },
  phone: { page: 'phone.html', viewport: { width: 390, height: 844 }, record: { width: 390, height: 844 }, scale: 2, touch: true },
};
const deviceOf = (scene) => DEVICES[SCENES[scene]?.device] || DEVICES.desktop;
const MAX_CLIP_BYTES = 4_000_000;
// Close-up clips (2026-10-12) are small: each MP4 under 1.5 MB. They start at CRF 20 for crisp text; past CRF 23 a
// clip should be made shorter in its scene (clipFrom, clipSeconds) rather than blurrier, so that is reported.
const MAX_CROP_BYTES = 1_500_000;
const CROP_CRFS = [20, 21, 22, 23, 25, 28, 31];
const CROP_CRF_SOFT_LIMIT = 23;
const SCREENCAST_QUALITY = 90;
// The screencast shows the page late: a change in the page reaches a frame some tenths of a second afterwards (more on a busy
// machine, up to a second). A marker in the window's top left corner (outside every crop) flips colour on a known clock, and
// frameLag() finds how late each flip shows, so the clip is cut where the page really was. After the scene the page is kept
// alive this long so the last frames arrive.
const SYNC_FLIP_MS = 1200;
const SCREENCAST_SETTLE_MS = 3200;
// The 2x browser's switch has two leading hyphens; demo.test.mjs keeps double hyphens out of every source file, so it is made here.
const CROP_BROWSER_ARGS = [`${'-'.repeat(2)}force-device-scale-factor=2`];
const MIN_SECONDS = 8;
const MAX_SECONDS = 14;
// The recorder starts a little before the page is on screen; the cut looks this much earlier than begin().
const CUT_LEAD_SECONDS = 0.1;

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return i < 0 ? [a, '1'] : [a.slice(0, i), a.slice(i + 1)]; }));
// x264's animation tune keeps UI text as crisp (compared at 100%) and is about 15% smaller than no tune at the same quality; stillimage is far bigger.
const CROP_TUNE = args.tune === 'none' ? '' : (args.tune || 'animation');
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

/** Launches headless Chromium (the one chromium= names, else Playwright's, else the newest in its cache); extra browser args are optional. */
async function launchBrowser(chromium, extraArgs = []) {
  const withArgs = extraArgs.length ? { args: extraArgs } : {};
  try { return await chromium.launch({ headless: true, ...(args.chromium ? { executablePath: args.chromium } : {}), ...withArgs }); } catch (e) {
    const exe = args.chromium || newestChromium();
    if (!exe || !/Executable doesn't exist|not found|install/i.test(String(e.message))) throw e;
    console.log(`Using the browser at ${exe}`);
    return chromium.launch({ headless: true, executablePath: exe, ...withArgs });
  }
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
async function encode(ffmpeg, raw, base, start, len, size = VIEWPORT) {
  const vf = `fps=30,scale=${size.width}:${size.height}:flags=lanczos,format=yuv420p`;
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

/* close-up clips (2026-10-12): a 2x screencast, cropped */

/**
 * Starts a CDP screencast on a page and writes every JPEG frame into `dir`, stamped with the time it arrived.
 * Chrome sends a frame only when the page changes (about 15 to 20 a second while it moves), so the stamps are what
 * makes a constant-rate clip possible. Each frame is acknowledged at once (Chrome sends no more until it is) and
 * written without waiting. `stop()` resolves with the frames, in order: [{ t (ms), file }], and the marker's flips
 * ([[colour, epoch ms]]) when `sync` put a marker in the page's top left corner (the desktop window; see SYNC_FLIP_MS).
 */
async function startScreencast(page, dir, dev, { sync = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const writes = [];
  cdp.on('Page.screencastFrame', (ev) => {
    const t = Date.now();
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    const file = path.join(dir, `f${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ t, file });
    writes.push(fs.promises.writeFile(file, Buffer.from(ev.data, 'base64')));
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: SCREENCAST_QUALITY, maxWidth: dev.viewport.width * dev.scale, maxHeight: dev.viewport.height * dev.scale, everyNthFrame: 1 });
  if (sync) {
    await page.evaluate((every) => {
      const d = document.createElement('div');
      d.id = 'rec-sync';
      d.style.cssText = 'position:fixed;left:0;top:0;width:12px;height:12px;z-index:2147483647;pointer-events:none;background:#00ff00';
      document.body.append(d);
      window.__recSync = [];
      let on = false;
      setInterval(() => { on = !on; d.style.background = on ? '#ff0000' : '#00ff00'; window.__recSync.push([on ? 'r' : 'g', performance.timeOrigin + performance.now()]); }, every);
    }, SYNC_FLIP_MS);
  }
  return {
    async stop() {
      const flips = sync ? await page.evaluate(() => window.__recSync || []).catch(() => []) : [];
      await cdp.send('Page.stopScreencast').catch(() => {});
      await Promise.all(writes);
      await cdp.detach().catch(() => {});
      return { frames, flips };
    },
  };
}

/**
 * How late the screencast shows the page. Reads the marker's colour out of every frame (one ffmpeg run, one pixel a
 * frame), pairs each colour change with the flip that caused it, and returns { arrivalOf(pageMs), median, min, max }:
 * the arrival time (ms) of the frame that shows what the page looked like at pageMs. Without flips to go by, no shift.
 */
async function frameLag(ffmpeg, frames, flips, dir) {
  const none = { arrivalOf: (t) => t, median: 0, min: 0, max: 0, flips: 0 };
  if (frames.length < 3 || flips.length < 2) return none;
  const list = path.join(dir, 'sync.ffconcat');
  const raw = path.join(dir, 'sync.rgb');
  fs.writeFileSync(list, `ffconcat version 1.0\n${frames.map((f) => `file '${path.basename(f.file)}'\nduration 0.04`).join('\n')}\nfile '${path.basename(frames[frames.length - 1].file)}'\n`);
  const r = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'crop=12:12:6:6,scale=1:1:flags=area,format=rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', raw]);
  if (r.code !== 0) { console.warn(`    note: could not read the sync marker (${r.err.trim().split('\n').pop()}); clips are cut on arrival times`); return none; }
  const px = fs.readFileSync(raw);
  const colourOf = (i) => { const R = px[i * 3]; const G = px[i * 3 + 1]; return R > 170 && G < 100 ? 'r' : G > 170 && R < 100 ? 'g' : '?'; };
  const lags = [];
  let seen = '?';
  const fl = flips.slice().sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < Math.min(frames.length, px.length / 3); i += 1) {
    const c = colourOf(i);
    if (c === '?' || c === seen) continue;
    const had = seen;
    seen = c;
    if (had === '?') continue; // the first colour is whatever the marker showed when it started
    // The flip that did this: the latest one to that colour that is not later than the frame.
    const k = fl.filter((f) => f[0] === c && f[1] <= frames[i].t).pop();
    if (k && frames[i].t - k[1] < 3000) lags.push({ at: k[1], lag: frames[i].t - k[1] });
  }
  if (lags.length < 2) { console.warn('    note: too few sync flips seen in the frames; clips are cut on arrival times'); return none; }
  // A little smoothing (median of three), then straight lines between the flips.
  const sm = lags.map((l, i) => ({ at: l.at, lag: [lags[Math.max(0, i - 1)].lag, l.lag, lags[Math.min(lags.length - 1, i + 1)].lag].sort((a, b) => a - b)[1] }));
  const at = (t) => {
    if (t <= sm[0].at) return sm[0].lag;
    if (t >= sm[sm.length - 1].at) return sm[sm.length - 1].lag;
    const j = sm.findIndex((l) => l.at >= t);
    const a = sm[j - 1];
    const b = sm[j];
    return a.lag + ((b.lag - a.lag) * (t - a.at)) / (b.at - a.at);
  };
  const sorted = sm.map((l) => l.lag).sort((a, b) => a - b);
  return { arrivalOf: (t) => t + at(t), median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1], flips: sm.length };
}

/**
 * Builds a close-up clip from screencast frames. The window [cutAt, cutAt + seconds) of the timeline is laid out as an
 * ffconcat list (each frame held until the next arrives; the frame showing at cutAt is held from cutAt), then cropped
 * to `rect` (CSS pixels, null for the whole frame), scaled down to `maxWidth`, converted to a constant 30 fps and
 * encoded as H.264 at rising CRF values until it is under maxBytes (default MAX_CROP_BYTES; a scene can ask for less). Returns { file, bytes, crf, frames } or null.
 */
async function encodeCrop(ffmpeg, frames, { cutAt, seconds, rect, dev, maxWidth, maxBytes = MAX_CROP_BYTES, out }) {
  if (!frames.length) { console.error(`    no screencast frames for ${path.basename(out)}`); return null; }
  const t0 = cutAt;
  const t1 = cutAt + seconds * 1000;
  let first = 0;
  for (let i = 0; i < frames.length; i += 1) if (frames[i].t <= t0) first = i;
  const dir = path.dirname(frames[0].file);
  const lines = ['ffconcat version 1.0'];
  let used = 0;
  let lastFile = null;
  for (let i = first; i < frames.length && (i === first || frames[i].t < t1); i += 1) {
    const start = i === first ? t0 : frames[i].t;
    const end = i + 1 < frames.length ? Math.min(frames[i + 1].t, t1) : t1;
    if (end - start <= 0) continue;
    lines.push(`file '${path.basename(frames[i].file)}'`, `duration ${((end - start) / 1000).toFixed(4)}`);
    lastFile = frames[i].file;
    used += 1;
  }
  if (!used) { console.error(`    no screencast frames inside the cut for ${path.basename(out)}`); return null; }
  lines.push(`file '${path.basename(lastFile)}'`); // the concat demuxer drops the last duration unless the file is named again
  const list = path.join(dir, `${path.basename(out, '.mp4')}.ffconcat`);
  fs.writeFileSync(list, `${lines.join('\n')}\n`);

  // The frames are 2x only if the switch and the context scale both took; crop in the frame's own pixels either way.
  const info = probe(ffmpeg, frames[first].file);
  const k = info.width ? info.width / dev.viewport.width : dev.scale;
  if (Math.abs(k - dev.scale) > 0.01) console.warn(`    note: ${path.basename(out)} frames are ${info.width}x${info.height}, not ${dev.scale}x`);
  const px = (v) => Math.round(v * k);
  const width = rect ? px(rect.w) : info.width;
  // The frames are JPEG (full range, BT.601). The clip is limited range yuv420p tagged BT.709 (what a browser expects of a
  // video this size). swscale does not convert the matrix from yuv to yuv, so the frames go through RGB: out of the JPEG's
  // range and matrix into gbrp, then, with the resize if there is one, into limited range BT.709 (checked against the source
  // pixels: within about one level; without the detour the colours drift by two or three).
  const toRgb = 'scale=iw:ih:in_range=pc:in_color_matrix=bt601,format=gbrp';
  const toVideo = (w, h) => `scale=${w}:${h}:flags=lanczos+accurate_rnd+full_chroma_int:out_range=tv:out_color_matrix=bt709`;
  const filters = [
    ...(rect ? [`crop=${px(rect.w)}:${px(rect.h)}:${px(rect.x)}:${px(rect.y)}`] : []),
    toRgb,
    maxWidth && maxWidth < width ? toVideo(maxWidth, '-2') : toVideo('iw', 'ih'),
    'setsar=1', 'fps=30', 'format=yuv420p',
  ];
  for (const crf of CROP_CRFS) {
    const r = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-t', seconds.toFixed(3), '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'slow', ...(CROP_TUNE ? ['-tune', CROP_TUNE] : []), '-g', '600', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', '-an', out]);
    if (r.code !== 0) { console.error(`    ffmpeg failed for ${path.basename(out)}: ${r.err.trim().split('\n').pop()}`); return null; }
    const bytes = fs.statSync(out).size;
    if (bytes <= maxBytes || crf === CROP_CRFS[CROP_CRFS.length - 1]) {
      if (crf > CROP_CRF_SOFT_LIMIT || bytes > maxBytes) console.warn(`    note: ${path.basename(out)} needed CRF ${crf} (${(bytes / 1e6).toFixed(2)} MB); shorten the scene's clip (clipFrom, clipSeconds)`);
      return { file: out, bytes, crf, frames: used };
    }
  }
  return null;
}

/**
 * Records one close-up scene (and the phone half of a paired one) with the 2x screencast, in the 2x browser, and writes
 * <out>/crops/<name>-<theme>.mp4 (and the phone's). Returns { entries (manifest lines), summary, moments, result, problems }.
 */
async function recordCrop({ ffmpeg, browser, name, theme, baseUrl, rawDir }) {
  const sc = SCENES[name];
  const pair = sc.pair || null;
  const maxSeconds = sc.maxSeconds || MAX_SECONDS;
  const dir = fs.mkdtempSync(path.join(rawDir, `${name}-${theme}-`));
  const dev = deviceOf(name);
  const sdev = pair ? (DEVICES[pair.device] || DEVICES.phone) : null;
  // A scene whose timing slips on a busy machine can run past the length the clip may have (its last moment would be cut
  // off): record it again, up to three times, and keep the last.
  const from = sc.clipFrom || 0;
  let main; let side; let result; let frames; let sideFrames; let lag;
  for (let attempt = 1; ; attempt += 1) {
    const sub = `a${attempt}`;
    main = await openScene(browser, { scene: name, theme, baseUrl });
    side = pair ? await openPair(browser, { scene: name, theme, baseUrl }) : null;
    const rec = await startScreencast(main.page, path.join(dir, sub, 'main'), dev, { sync: true });
    const sideRec = side ? await startScreencast(side.page, path.join(dir, sub, 'side'), sdev) : null;
    result = await runScene(main.page, name, { stills: false, ...(side ? { pairPage: side.page } : {}) });
    // The page stays up a moment, so the frames of the scene's last moments (they arrive late) are in before the recording stops.
    await new Promise((resolve) => setTimeout(resolve, SCREENCAST_SETTLE_MS));
    const got = await rec.stop();
    frames = got.frames;
    sideFrames = sideRec ? (await sideRec.stop()).frames : null;
    await main.ctx.close();
    if (side) await side.ctx.close();
    lag = await frameLag(ffmpeg, frames, got.flips, path.dirname(frames[0]?.file || dir));
    if (result.seconds - from + CUT_LEAD_SECONDS <= maxSeconds + 0.05 || attempt >= 3) break;
    console.warn(`    note: ${name} ran ${(result.seconds - from).toFixed(1)} s, longer than the ${maxSeconds} s a clip may be; recording it again (${attempt} of 3)`);
  }

  // A scene can start its clip later than begin() (clipFrom, seconds after it) and cap its length (clipSeconds). The
  // clip ends where the scene does: screencast frames are live (no recorder lag to wait out), and the page's own
  // wind-down after the scene (it is closed right after) must not get into the clip.
  const seconds = Math.min(sc.clipSeconds || maxSeconds, maxSeconds, result.seconds - from + CUT_LEAD_SECONDS);
  if (result.seconds - from < MIN_SECONDS || result.seconds > maxSeconds + 1 + from) console.warn(`    note: ${name} runs ${(result.seconds - from).toFixed(1)} s; the target is ${MIN_SECONDS} to ${maxSeconds}`);
  // Both halves are cut at the same instant, to the same length, where the page was (not where the frames arrived): the
  // desktop's measured lag is used for the phone too (its own page has no marker to read).
  const pageStart = result.beganAt + from * 1000 - CUT_LEAD_SECONDS * 1000;
  const cutAt = lag.arrivalOf(pageStart);
  const cutSeconds = (lag.arrivalOf(pageStart + seconds * 1000) - cutAt) / 1000;
  console.log(`    screencast lag: median ${lag.median.toFixed(0)} ms (${lag.min.toFixed(0)} to ${lag.max.toFixed(0)}) from ${lag.flips} marker flips`);
  const lastArrival = frames.length ? frames[frames.length - 1].t : 0;
  if (cutAt + cutSeconds * 1000 > lastArrival + 250) console.warn(`    note: ${name}: the last ${((cutAt + cutSeconds * 1000 - lastArrival) / 1000).toFixed(1)} s of the clip had no frames yet when the recording stopped (the lag was larger than ${SCREENCAST_SETTLE_MS} ms); the last frame is held`);
  const jobs = [{ base: name, frames, rect: sc.crop, dev, maxWidth: sc.maxWidth, maxBytes: sc.maxBytes }];
  if (side) jobs.push({ base: pair.name || `${name}-phone`, frames: sideFrames, rect: pair.crop || null, dev: sdev, maxWidth: pair.maxWidth, maxBytes: pair.maxBytes });
  const entries = [];
  const summary = [];
  for (const j of jobs) {
    const out = path.join(OUT, 'crops', `${j.base}-${theme}.mp4`);
    const e = await encodeCrop(ffmpeg, j.frames, { cutAt, seconds: cutSeconds, rect: j.rect, dev: j.dev, maxWidth: j.maxWidth, maxBytes: j.maxBytes, out });
    if (!e) continue;
    const info = probe(ffmpeg, e.file);
    entries.push({ scene: j.base, theme, kind: 'crop-video', file: path.relative(OUT, e.file).replace(/\\/g, '/'), bytes: e.bytes, seconds: info.seconds, width: info.width, height: info.height, codec: info.codec, crf: e.crf, crop: j.rect || 'whole page', maxWidth: j.maxWidth });
    summary.push(`${path.basename(e.file)} ${info.width}x${info.height} ${(e.bytes / 1e6).toFixed(2)} MB (${j.frames.length} frames, crf ${e.crf})`);
  }
  // The scene's noted moments, in seconds into the clip as cut (what the page times things to).
  const moments = result.log.filter((l) => !l.what.startsWith('still ') || l.what === `still ${sc.hero}`)
    .map((l) => ({ what: l.what, at: l.at, inClip: Number((l.at + CUT_LEAD_SECONDS - from).toFixed(2)) }));
  return { entries, summary, moments, result, problems: [...main.problems, ...(side?.problems || [])] };

}

/** Width and height of a PNG, from its header. */
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

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
  fs.mkdirSync(path.join(OUT, 'crops'), { recursive: true });
  write(OUT, `# apaki-media

Screenshots and short screen recordings of Myrlin Apaki's desktop window, for the product landing page (apaki.myrlin.io).

- Project: claude-latch (apaki), request: "a demo harness that runs Apaki's real desktop UI in a browser on demo data, for marketing screenshots and recordings".
- Made by: ${made}.
- Every picture shows invented demo data (a fictional team, "acme-web", "Fix flaky checkout test"). Nothing in it comes from a real session, path, account or person.

## What is here

- \`stills/\`: PNG screenshots at 2880x1800 (1440x900 at 2x), \`<scene>-<theme>.png\` for each scene's hero shot and \`<scene>-<label>-<theme>.png\` for its other moments. Light and dark. The \`phone\` scene is the phone client at 780x1688.
- \`video/\`: the same scenes as clips, \`<scene>-<theme>.webm\` (VP9) and \`.mp4\` (H.264), 1440x900 (the \`phone\` scene 390x844), 30 fps, 8 to 14 seconds, each under 4 MB.
- \`crops/\`: close-ups for the home page (added 2026-10-12): scenes recorded at 2x and cropped to the part of the window that matters, as \`<name>-<theme>.mp4\` (H.264, under 1.5 MB) with their cropped poster stills \`<name>-<theme>.png\` and \`<name>-<label>-<theme>.png\`, and still-only crops (the sidebar rows, each pane of the split grid).
- \`node apaki/demo/site-media.mjs\` converts these into the repo (relay/site/assets/media, apaki/docs/media); those are copies.
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
  write(path.join(OUT, 'crops'), `# crops

Close-up clips and stills of Apaki's demo scenes for the home page: \`<name>-<theme>.mp4\` (H.264, recorded at 2x with a screencast and cropped, under 1.5 MB), \`<name>-<theme>.png\` (the poster) and \`<name>-<label>-<theme>.png\`, made by \`node apaki/demo/capture.mjs scene=glass-card,...\` (Claude Code, Sonnet 5.5, 2026-10-12).
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
  return openPage(browser, { dev: deviceOf(scene), ws: SCENES[scene].ws, theme, baseUrl, recordDir });
}

/** A paired scene's phone page (2026-10-12): the device and workspace its pair names. */
function openPair(browser, { scene, theme, baseUrl, recordDir }) {
  const pair = SCENES[scene].pair;
  return openPage(browser, { dev: DEVICES[pair.device] || DEVICES.phone, ws: pair.ws, theme, baseUrl, recordDir });
}

/** Opens a page, trying again (up to three times) if the harness is slow to come up: on a busy machine the first load can miss its 20 s. */
async function openPage(browser, opts) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await openPageOnce(browser, opts); } catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`    note: ${opts.ws} did not come up (${String(e.message).split('\n')[0]}); opening it again (${attempt} of 3)`);
    }
  }
}

async function openPageOnce(browser, { dev, ws, theme, baseUrl, recordDir }) {
  const ctx = await browser.newContext({
    viewport: dev.viewport, deviceScaleFactor: dev.scale, locale: 'en-US', timezoneId: 'America/New_York', colorScheme: theme,
    ...(dev.touch ? { hasTouch: true, isMobile: true } : {}),
    ...(recordDir ? { recordVideo: { dir: recordDir, size: dev.record } } : {}),
  });
  const startedAt = Date.now();
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  try {
    await page.goto(`${baseUrl}/${dev.page}?ws=${encodeURIComponent(ws)}&theme=${theme}`);
    await page.waitForFunction(() => window.__demo?.ready?.(), null, { timeout: 20000 });
  } catch (e) { await ctx.close().catch(() => {}); throw e; }
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

  // One browser at a time (2026-10-13, round 3: the PC that runs this is short on memory). The stills and the full-window
  // clips use a plain headless Chromium; the close-up clips (2026-10-12) are screencast in a browser of their own,
  // started with the 2x switch. Each is started the first time it is needed and the other is closed first.
  let mainBrowser = null;
  let cropBrowser = null;
  const getBrowser = async () => {
    if (cropBrowser) { await cropBrowser.close().catch(() => {}); cropBrowser = null; }
    return mainBrowser || (mainBrowser = await launchBrowser(chromium));
  };
  const getCropBrowser = async () => {
    if (mainBrowser) { await mainBrowser.close().catch(() => {}); mainBrowser = null; }
    return cropBrowser || (cropBrowser = await launchBrowser(chromium, CROP_BROWSER_ARGS));
  };

  const server = await startServer();
  console.log(`Harness at ${server.url} (stops when this run ends). Output: ${OUT}`);
  const manifest = [];
  const problems = [];
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-demo-raw-'));
  const started = Date.now();

  try {
    for (const theme of THEMES) {
      for (const name of WANT_SCENES) {
        // A paired scene (2026-10-12) runs the phone page beside the desktop one; its files are "<name>-phone-...".
        const pair = SCENES[name].pair || null;
        const maxSeconds = SCENES[name].maxSeconds || MAX_SECONDS;
        // A close-up scene (2026-10-12) has a crop: its stills are cropped and go to crops/, its clip is screencast at 2x.
        const crop = SCENES[name].crop || null;
        const stillDir = crop ? 'crops' : 'stills';
        if (DO_STILLS) {
          const t0 = Date.now();
          const browser = await getBrowser();
          const { ctx, page, problems: probs } = await openScene(browser, { scene: name, theme, baseUrl: server.url });
          const side = pair ? await openPair(browser, { scene: name, theme, baseUrl: server.url }) : null;
          const saved = [];
          // For a close-up: a still named by the scene (a pane of the grid) is its own hero; heroOnly drops the other moments.
          const keep = (prefix, hero, dv, heroOnly = false) => async (label, png, named = null) => {
            if (heroOnly && !named && label !== hero) return;
            const file = path.join(OUT, stillDir, `${named || `${prefix}-${label}`}-${theme}.png`);
            fs.writeFileSync(file, png);
            saved.push({ label: named || label, file, bytes: png.length, hero: !!named || label === hero, dv, ...(crop ? pngSize(png) : {}) });
            if (!named && label === hero) fs.writeFileSync(path.join(OUT, stillDir, `${prefix}-${theme}.png`), png);
          };
          const result = await runScene(page, name, {
            stills: true,
            onStill: keep(name, SCENES[name].hero, deviceOf(name), !!SCENES[name].heroOnly),
            clip: crop,
            ...(side ? { pairPage: side.page, onPairStill: keep(pair.name || `${name}-phone`, pair.hero, DEVICES[pair.device] || DEVICES.phone, !!SCENES[name].heroOnly), pairClip: pair.crop || null } : {}),
          });
          await ctx.close();
          if (side) await side.ctx.close();
          for (const s of saved) manifest.push({ scene: name, theme, kind: crop ? 'crop-still' : 'still', hero: s.hero, label: s.label, file: path.relative(OUT, s.file).replace(/\\/g, '/'), bytes: s.bytes, width: s.width || s.dv.viewport.width * s.dv.scale, height: s.height || s.dv.viewport.height * s.dv.scale });
          console.log(`  ${name} / ${theme}: ${saved.length} stills (${((Date.now() - t0) / 1000).toFixed(1)} s, scene ${result.seconds.toFixed(1)} s)`);
          for (const p of [...probs, ...(side?.problems || [])]) problems.push(`${name}/${theme} stills: ${p}`);
        }
        const wantClip = DO_VIDEO && ffmpeg && !SCENES[name].stillsOnly;
        if (wantClip && crop) {
          const t0 = Date.now();
          const r = await recordCrop({ ffmpeg, browser: await getCropBrowser(), name, theme, baseUrl: server.url, rawDir });
          manifest.push(...r.entries);
          console.log(`  ${name} / ${theme}: close-up ${r.summary.join(', ')} (${((Date.now() - t0) / 1000).toFixed(1)} s, scene ${r.result.seconds.toFixed(1)} s)`);
          if (r.moments.length) console.log(`    moments (s into the clip): ${r.moments.map((l) => `${l.what} at ${l.inClip}`).join(', ')}`);
          for (const p of r.problems) problems.push(`${name}/${theme} video: ${p}`);
        } else if (wantClip) {
          const t0 = Date.now();
          const dir = fs.mkdtempSync(path.join(rawDir, `${name}-${theme}-`));
          const browser = await getBrowser();
          const { ctx, page, problems: probs, startedAt } = await openScene(browser, { scene: name, theme, baseUrl: server.url, recordDir: dir });
          const side = pair ? await openPair(browser, { scene: name, theme, baseUrl: server.url, recordDir: fs.mkdtempSync(path.join(rawDir, `${name}-phone-${theme}-`)) }) : null;
          const result = await runScene(page, name, { stills: false, ...(side ? { pairPage: side.page } : {}) });
          const video = page.video();
          const sideVideo = side?.page.video();
          await ctx.close();
          if (side) await side.ctx.close();
          const len = Math.min(maxSeconds, result.seconds + CUT_LEAD_SECONDS + 0.3);
          if (result.seconds < MIN_SECONDS || result.seconds > maxSeconds + 1) console.warn(`    note: ${name} runs ${result.seconds.toFixed(1)} s; the target is ${MIN_SECONDS} to ${maxSeconds}`);
          // Both recordings are cut at the same instant (begin), each from its own start, and to the same length.
          const cuts = [{ raw: await video.path(), startedAt, base: `${name}-${theme}`, size: deviceOf(name).record }];
          if (side) cuts.push({ raw: await sideVideo.path(), startedAt: side.startedAt, base: `${name}-phone-${theme}`, size: (DEVICES[pair.device] || DEVICES.phone).record });
          const sizes = [];
          for (const c of cuts) {
            const start = Math.max(0, (result.beganAt - c.startedAt) / 1000 - CUT_LEAD_SECONDS);
            const outs = await encode(ffmpeg, c.raw, path.join(OUT, 'video', c.base), start, len, c.size);
            for (const o of outs) {
              const info = probe(ffmpeg, o.file);
              manifest.push({ scene: c.base.endsWith(`-${theme}`) && c.base.includes('-phone-') ? `${name}-phone` : name, theme, kind: 'video', file: path.relative(OUT, o.file).replace(/\\/g, '/'), bytes: o.bytes, seconds: info.seconds, width: info.width, height: info.height, codec: info.codec, crf: o.crf });
              sizes.push(`${path.basename(o.file)} ${(o.bytes / 1e6).toFixed(2)} MB`);
            }
            if (KEEP_RAW) { fs.mkdirSync(path.join(OUT, 'video', 'raw'), { recursive: true }); fs.copyFileSync(c.raw, path.join(OUT, 'video', 'raw', `${c.base}.webm`)); }
          }
          console.log(`  ${name} / ${theme}: video ${sizes.join(', ')} (${((Date.now() - t0) / 1000).toFixed(1)} s, scene ${result.seconds.toFixed(1)} s)`);
          // The moments a scene noted (seconds into the clip), for a page that times something to them.
          const moments = result.log.filter((l) => !l.what.startsWith('still '));
          if (moments.length) console.log(`    moments: ${moments.map((l) => `${l.what} at ${l.at} s`).join(', ')}`);
          for (const p of [...probs, ...(side?.problems || [])]) problems.push(`${name}/${theme} video: ${p}`);
        }
      }
    }
  } finally {
    if (mainBrowser) await mainBrowser.close().catch(() => {});
    if (cropBrowser) await cropBrowser.close().catch(() => {});
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
