/**
 * site-media.mjs: turns the demo harness's recordings (node apaki/demo/capture.mjs, D:\apaki-media by
 * default) into the media the product page and the README use. Written 2026-10-12 by Claude Code
 * (Opus 5.5) for Arthur.
 *
 *   relay/site/assets/media/   the home page (apaki.myrlin.io). Since 2026-10-12 (close-ups): the clips and
 *                              stills that capture.mjs writes to <in>/crops, light and dark: each close-up as
 *                              H.264 MP4 (muted, faststart, 30 fps, cut to the part of the window that matters
 *                              and encoded at 2x the width the page shows it) with its poster as WebP at the
 *                              clip's own pixel size (quality 90), and the still crops (sessions-list, pane-a to
 *                              pane-d) as WebP. The names are CROP_CLIPS and CROP_STILLS below. The older set
 *                              (full-window clips, their 1200 and 2000 px posters, the phone's stills, the
 *                              search-hits crop, the handoff files) is written only with legacy=1.
 *                              (assets/og.jpg comes from brand-images.mjs)
 *   apaki/docs/media/          the README: stills as WebP at 1440 px, and three short loops as
 *                              animated WebP (desktop 760 px wide at 12 fps, phone 300 px); the
 *                              wordmark there comes from brand-images.mjs
 *
 * Usage (key=value, all optional):
 *   node apaki/demo/site-media.mjs ffmpeg=<exe> [in=D:\apaki-media] [site=1] [docs=1] [legacy=0]
 * ffmpeg: as capture.mjs finds it ($FFMPEG, ffmpeg on the PATH, or the ffmpeg-static package); it
 * needs libwebp and libx264. Nothing here reads anything but the folder the harness wrote, which holds
 * only invented demo data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return i < 0 ? [a, '1'] : [a.slice(0, i), a.slice(i + 1)]; }));
const IN = path.resolve(args.in || process.env.APAKI_MEDIA_DIR || (process.platform === 'win32' ? 'D:\\apaki-media' : path.join(process.env.HOME || '', 'apaki-media')));
const SITE = path.join(REPO, 'relay', 'site', 'assets', 'media');
const DOCS = path.join(REPO, 'apaki', 'docs', 'media');
const THEMES = ['light', 'dark'];

/**
 * The close-ups (2026-10-12), written by capture.mjs to <in>/crops as <name>-<theme>.mp4 and <name>-<theme>.png (the
 * poster's still, cropped the same way). The clip is copied as it is; the poster becomes <name>-<theme>.webp at the
 * clip's own pixel size. hero-phone is the phone half of hero-pane, pair-phone of pair-sheet.
 */
const CROP_CLIPS = ['hero-pane', 'hero-phone', 'glass-card', 'steer-line', 'worktree-diff', 'search-meaning', 'browser-pane', 'pair-sheet', 'pair-phone'];

/** Still crops with no clip: [name, width to scale to (null: its own 2x pixels)]. */
const CROP_STILLS = [['sessions-list', 704], ['pane-a', null], ['pane-b', null], ['pane-c', null], ['pane-d', null]];

/** WebP quality of the close-ups' posters and still crops. */
const CROP_QUALITY = 90;

/** Which still is each clip's poster (the moment that says the most when nothing plays). */
const CLIPS = {
  // The hero (2026-10-12): the PC and the phone in step (scenes.mjs "handoff"), each with its own poster.
  handoff: 'followed',
  sessions: 'overview',
  search: 'results',
  steer: 'steered',
  history: 'system-lines',
  'glass-swap': 'panel',
  browser: 'browsing',
  'phone-pair': 'approve',
  // Git worktrees (shipped 2026-10-12): the diff viewer beside the conversation.
  worktrees: 'diff',
};

/**
 * The phone halves of paired scenes (2026-10-12): clip "<scene>-phone-<theme>.mp4" (390x844) and, as its
 * poster, the still "<scene>-phone-<label>" at 780 px, written as "<scene>-phone-<theme>.webp".
 */
const PHONE_CLIPS = {
  handoff: 'reply',
  'phone-pair': 'code',
};

/**
 * Crops of the 2880x1800 stills that float over the page's clips, at the stills' 2x pixels: just inside
 * the panel's own edge, so no window shows around it (the page draws the border and the corners).
 * [name, still, x, y, w, h]
 */
const CROPS = [
  ['search-hits', 'search-results', 4, 800, 690, 600],
];

function findFfmpeg() {
  const cands = [args.ffmpeg, process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
  try { cands.push(createRequire(import.meta.url)('ffmpeg-static')); } catch { /* not installed here */ }
  for (const c of cands) {
    const r = spawnSync(c, ['-version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  throw new Error('No ffmpeg found: pass ffmpeg=<exe> (it needs libwebp and libx264).');
}

const FF = findFfmpeg();
function ff(argv) {
  const r = spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', ...argv], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${argv.join(' ')}\n${r.stderr}`);
}
const need = (f) => { if (!fs.existsSync(f)) throw new Error(`missing ${f}: run node apaki/demo/capture.mjs first`); return f; };
const still = (name, theme) => need(path.join(IN, 'stills', `${name}-${theme}.png`));
const clip = (scene, theme) => need(path.join(IN, 'video', `${scene}-${theme}.mp4`));
const kb = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;
const made = [];
const note = (f) => { made.push(f); console.log(`  ${path.relative(REPO, f).replace(/\\/g, '/')}  ${kb(f)}`); };

/** Width and height of an image or video, from ffmpeg's banner. */
function sizeOf(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(`${r.stderr || ''}`);
  if (!m) throw new Error(`cannot read the size of ${file}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** A close-up's poster: the cropped still as WebP at exactly the clip's pixel size (it is already cropped; scaled only if the clip was). */
function poster(png, mp4, out) {
  const clipSize = sizeOf(mp4);
  const have = sizeOf(png);
  const same = have.width === clipSize.width && have.height === clipSize.height;
  ff(['-i', png, ...(same ? [] : ['-vf', `scale=${clipSize.width}:${clipSize.height}:flags=lanczos`]), '-c:v', 'libwebp', '-quality', String(CROP_QUALITY), '-compression_level', '6', '-preset', 'text', out]);
  note(out);
}

/** A still to WebP at a width (height follows), at a quality. */
function webp(src, out, width, q = 80, crop = null) {
  const vf = [crop ? `crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]}` : null, width ? `scale=${width}:-2:flags=lanczos` : null].filter(Boolean).join(',');
  ff(['-i', src, ...(vf ? ['-vf', vf] : []), '-c:v', 'libwebp', '-quality', String(q), '-compression_level', '6', '-preset', 'picture', out]);
  note(out);
}

/** The close-ups: each clip copied with its poster, and the still crops. */
function closeUps() {
  fs.mkdirSync(SITE, { recursive: true });
  const crop = (name, theme, ext) => need(path.join(IN, 'crops', `${name}-${theme}.${ext}`));
  for (const theme of THEMES) {
    for (const name of CROP_CLIPS) {
      const mp4 = path.join(SITE, `${name}-${theme}.mp4`);
      fs.copyFileSync(crop(name, theme, 'mp4'), mp4);
      note(mp4);
      poster(crop(name, theme, 'png'), mp4, path.join(SITE, `${name}-${theme}.webp`));
    }
    for (const [name, width] of CROP_STILLS) {
      const out = path.join(SITE, `${name}-${theme}.webp`);
      ff(['-i', crop(name, theme, 'png'), ...(width ? ['-vf', `scale=${width}:-2:flags=lanczos`] : []), '-c:v', 'libwebp', '-quality', String(CROP_QUALITY), '-compression_level', '6', '-preset', 'text', out]);
      note(out);
    }
  }
}

/** The older set: full-window clips with 1200 and 2000 px posters, the phone's stills, the search-hits crop (only with legacy=1). */
function site() {
  fs.mkdirSync(SITE, { recursive: true });
  for (const theme of THEMES) {
    for (const [scene, label] of Object.entries(CLIPS)) {
      const mp4 = path.join(SITE, `${scene}-${theme}.mp4`);
      fs.copyFileSync(clip(scene, theme), mp4);
      note(mp4);
      if (!label) continue;
      const src = still(`${scene}-${label}`, theme);
      webp(src, path.join(SITE, `${scene}-${theme}-1200.webp`), 1200, 80);
      webp(src, path.join(SITE, `${scene}-${theme}-2000.webp`), 2000, 78);
    }
    for (const [scene, label] of Object.entries(PHONE_CLIPS)) {
      const mp4 = path.join(SITE, `${scene}-phone-${theme}.mp4`);
      fs.copyFileSync(clip(`${scene}-phone`, theme), mp4);
      note(mp4);
      webp(still(`${scene}-phone-${label}`, theme), path.join(SITE, `${scene}-phone-${theme}.webp`), 780, 82);
    }
    for (const [name, from, x, y, w, h] of CROPS) webp(still(from, theme), path.join(SITE, `${name}-${theme}.webp`), null, 86, [x, y, w, h]);
  }
  // The link preview (assets/og.jpg) and the README's wordmark are drawn by brand-images.mjs, which needs a browser.
}

/** A loop for the README: animated WebP from the MP4, smaller and slower than the page's clip. */
function loop(scene, theme, out, width, fps, q) {
  ff(['-i', clip(scene, theme), '-vf', `fps=${fps},scale=${width}:-2:flags=lanczos`, '-c:v', 'libwebp_anim', '-loop', '0', '-quality', String(q), '-compression_level', '6', '-an', out]);
  note(out);
}

function docs() {
  fs.mkdirSync(DOCS, { recursive: true });
  for (const theme of THEMES) {
    for (const [name, from] of [['hero', 'split-grid'], ['sessions', 'search-results'], ['browser', 'browser-browsing'], ['phone-pair', 'phone-pair-approve'], ['history', 'history-system-lines']]) {
      webp(still(from, theme), path.join(DOCS, `${name}-${theme}.webp`), 1440, 80);
    }
    loop('glass-swap', theme, path.join(DOCS, `glass-swap-${theme}.webp`), 760, 12, 62);
    loop('steer', theme, path.join(DOCS, `steer-${theme}.webp`), 760, 12, 62);
    loop('phone', theme, path.join(DOCS, `phone-loop-${theme}.webp`), 300, 12, 66);
  }
}

console.log(`From ${IN}, with ${FF}`);
if (args.site !== '0') closeUps();
if (args.site !== '0' && args.legacy === '1') site();
if (args.docs !== '0') docs();
const total = made.reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(`${made.length} files, ${(total / 1e6).toFixed(1)} MB in all.`);
