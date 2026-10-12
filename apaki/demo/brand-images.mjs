/**
 * brand-images.mjs: draws Apaki's wordmark and link preview with the app's own fonts, in a headless
 * browser (the same Playwright and Chromium capture.mjs uses, in a temporary profile). Written
 * 2026-10-12 by Claude Code (Opus 5.5) for Arthur.
 *
 *   apaki/docs/media/wordmark-light.png, wordmark-dark.png
 *       the Myrlin M and "Apaki" in wide italic Archivo on a transparent ground, for the README
 *       (GitHub shows images without their web fonts, so the type is drawn here once)
 *   relay/site/assets/og.jpg
 *       the 1200x630 link preview: the wordmark, one line, and the handoff window (the PC with the phone's session) on the pearl
 *
 * Run after site-media.mjs (the preview uses relay/site/assets/media/handoff-light-2000.webp):
 *   node apaki/demo/brand-images.mjs [playwright=<dir>] [chromium=<exe>] [ffmpeg=<exe>]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return i < 0 ? [a, '1'] : [a.slice(0, i), a.slice(i + 1)]; }));

async function loadPlaywright() {
  const tries = [args.playwright && path.join(args.playwright, 'node_modules', 'playwright', 'index.mjs'),
    path.join(REPO, 'node_modules', 'playwright', 'index.mjs'),
    path.join(os.homedir(), '.claude', 'mcp', 'playwright', 'node_modules', 'playwright', 'index.mjs')].filter(Boolean);
  for (const t of tries) if (fs.existsSync(t)) return import(pathToFileURL(t).href);
  return import('playwright');
}

/** The newest headless shell in Playwright's cache, for when the one its version wants is not there. */
function cachedChromium() {
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'ms-playwright');
  if (!fs.existsSync(root)) return null;
  const found = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of found) {
    for (const rel of [['chrome-headless-shell-win64', 'chrome-headless-shell.exe'], ['chrome-headless-shell-linux64', 'chrome-headless-shell'], ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell']]) {
      const exe = path.join(root, d, ...rel);
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

function findFfmpeg() {
  const cands = [args.ffmpeg, process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
  try { cands.push(createRequire(import.meta.url)('ffmpeg-static')); } catch { /* not installed here */ }
  for (const c of cands) { const r = spawnSync(c, ['-version']); if (!r.error && r.status === 0) return c; }
  return null;
}

const b64 = (f) => fs.readFileSync(f).toString('base64');
const FONTS = path.join(REPO, 'apaki', 'ui', 'fonts');
const markSrc = fs.readFileSync(path.join(REPO, 'apaki', 'ui', 'mark.js'), 'utf8');
const MARK = JSON.parse(markSrc.slice(markSrc.indexOf('"'), markSrc.lastIndexOf('"') + 1));

const css = (theme) => {
  const dark = theme === 'dark';
  return `
@font-face { font-family: 'Archivo'; font-style: italic; font-weight: 100 900; font-stretch: 62% 125%; src: url(data:font/woff2;base64,${b64(path.join(FONTS, 'Archivo-italic.woff2'))}) format('woff2'); }
@font-face { font-family: 'Archivo'; font-style: normal; font-weight: 100 900; font-stretch: 62% 125%; src: url(data:font/woff2;base64,${b64(path.join(FONTS, 'Archivo-normal.woff2'))}) format('woff2'); }
html, body { margin: 0; background: transparent; }
.m-mark .m-stroke { fill: ${dark ? '#ECEDF8' : '#171717'}; }
.m-mark .m-fold { fill: ${dark ? '#A3ABF2' : '#6572D4'}; }
.wm { display: inline-flex; align-items: center; gap: 22px; padding: 18px 26px 18px 14px; color: ${dark ? '#ECEDF8' : '#171717'};
  font: italic 880 132px/1 'Archivo'; font-stretch: 125%; letter-spacing: -.035em; }
.wm svg { width: 142px; height: 67px; transform: translateY(3px); }
`;
};

const ogHtml = () => `<!doctype html><html><head><style>${css('light')}
body { width: 1200px; height: 630px; position: relative; overflow: hidden; background: #FDFDFF; font-family: 'Archivo'; }
.pearl { position: absolute; inset: 0; background: linear-gradient(90deg, hsla(217, 91%, 60%, .35), hsla(277, 87%, 63%, .35), hsla(22, 92%, 72%, .42), hsla(189, 94%, 43%, .35)); }
.wash { position: absolute; inset: 0; background: radial-gradient(circle, #fff 1.4px, transparent 1.5px) 0 0 / 8px 8px, radial-gradient(circle, #fff 1.4px, transparent 1.5px) 4px 4px / 8px 8px, linear-gradient(180deg, hsla(0, 0%, 100%, .9) 30%, hsla(0, 0%, 100%, .55)); }
.copy { position: absolute; left: 64px; top: 70px; }
.wm { font-size: 112px; padding: 0; gap: 18px; }
.wm svg { width: 120px; height: 57px; }
.line { margin-top: 26px; width: 520px; font: 760 34px/1.15 'Archivo'; font-stretch: 112%; letter-spacing: -.015em; color: #171717; }
.fine { margin-top: 22px; font: 600 19px/1.3 'Archivo'; color: #4F5066; }
.win { position: absolute; left: 640px; top: 120px; width: 720px; border-radius: 16px; overflow: hidden; border: 1px solid #D5D8EF;
  box-shadow: 0 40px 80px -36px rgba(44, 53, 120, .55), 0 14px 28px -14px rgba(44, 53, 120, .3); }
.win img { display: block; width: 100%; }
</style></head><body><div class="pearl"></div><div class="wash"></div>
<div class="copy"><div class="wm">${MARK}<span>Apaki</span></div>
<div class="line">Every Claude Code session on your PC, in one window.</div>
<div class="fine">Free and open source · apaki.myrlin.io</div></div>
<div class="win"><img src="data:image/webp;base64,${b64(path.join(REPO, 'relay', 'site', 'assets', 'media', 'handoff-light-2000.webp'))}"></div>
</body></html>`;

const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default.chromium;
let browser;
try { browser = await chromium.launch({ headless: true, ...(args.chromium ? { executablePath: args.chromium } : {}) }); } catch (e) {
  const exe = args.chromium || cachedChromium();
  if (!exe) throw e;
  browser = await chromium.launch({ headless: true, executablePath: exe });
}
try {
  const docs = path.join(REPO, 'apaki', 'docs', 'media');
  fs.mkdirSync(docs, { recursive: true });
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 900, height: 300 } });
    await page.setContent(`<!doctype html><html><head><style>${css(theme)}</style></head><body><div class="wm">${MARK}<span>Apaki</span></div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(docs, `wordmark-${theme}.png`);
    await page.locator('.wm').screenshot({ path: out, omitBackground: true });
    console.log(`  ${path.relative(REPO, out)}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
    await page.close();
  }
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1200, height: 630 } });
  await page.setContent(ogHtml());
  await page.evaluate(() => document.fonts.ready);
  const png = path.join(os.tmpdir(), `apaki-og-${process.pid}.png`);
  await page.screenshot({ path: png });
  await page.close();
  const og = path.join(REPO, 'relay', 'site', 'assets', 'og.jpg');
  const ff = findFfmpeg();
  if (ff) {
    spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', png, '-q:v', '3', og]);
    fs.rmSync(png, { force: true });
  } else {
    fs.renameSync(png, og.replace(/\.jpg$/, '.png'));
    console.log('  (no ffmpeg: wrote og.png instead of og.jpg; the page names og.jpg)');
  }
  if (fs.existsSync(og)) console.log(`  ${path.relative(REPO, og)}  ${(fs.statSync(og).size / 1024).toFixed(0)} KB`);
} finally {
  await browser.close();
}
