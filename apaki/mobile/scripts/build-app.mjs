#!/usr/bin/env node
/**
 * build-app.mjs: builds the page the Apaki app ships (apaki/mobile,
 * 2026-10-10) into apaki/mobile/www, which `cap sync` copies into the iOS
 * and Android projects.
 *
 *   node scripts/build-app.mjs            the app's page (Debug and Release)
 *   node scripts/build-app.mjs --demo     plus the pretend PC (Debug only, for screenshots)
 *   node scripts/build-app.mjs --out <dir>
 *
 * It is the phone web client the site serves, built by
 * apaki/scripts/build-web.mjs from the same commit with the relay
 * wss://apaki.myrlin.io, plus the app's own files (src/ here, into www/app/):
 *
 *   - index.html starts app/entry.js (which installs the native shell, then
 *     imports boot.js) and loads app/mobile.css after web.css.
 *   - Its Content-Security-Policy is the site's, tighter: the page connects
 *     to nothing but its own files (connect-src 'self'); the relay socket
 *     and the account API go through the native side, which allows
 *     wss://apaki.myrlin.io/v1/rooms/<id>/phone and https://apaki.myrlin.io/v1/
 *     only. No service worker and no web manifest.
 *   - A few web modules are swapped for app ones with the same exports:
 *     store.js (the Keychain and the Secure Enclave), scan.js (the native
 *     camera scanner), and in a demo build link.js (the pretend PC). The
 *     build stops if an app module misses an export the web one has.
 *   - @capacitor/core's own ES module becomes app/vendor/capacitor-core.js
 *     (no bundler).
 *   - app/build.js records the page version, the commit and whether this is
 *     a demo build.
 *
 * The point (Arthur's trust rule for the phone): the app carries its own
 * copy of the code that holds the keys, so no server can change it; the
 * site's copy is checked by the PC instead (engine remote-page.js).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../../scripts/build-web.mjs';
import { exportNames, RELAY } from '../src/codec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(here, '..');
const SRC = path.join(MOBILE, 'src');
const OUT = path.join(MOBILE, 'www');
const CORE = path.join(MOBILE, 'node_modules', '@capacitor', 'core', 'dist', 'index.js');

/** The app's own files, into www/app/. */
export const APP_FILES = ['entry.js', 'cap.js', 'codec.js', 'native-shell.js', 'native-store.js', 'native-socket.js', 'native-http.js', 'passkeys.js', 'scan-native.js', 'mobile.css'];
/** The pretend PC, into www/app/demo/ in a demo build only. */
export const DEMO_FILES = ['demo-engine.js', 'demo-link.js', 'demo-store.js', 'demo-setup.js'];

/** Web modules (www root) the app replaces, and the app module each one re-exports. */
export function swapsFor(demo) {
  return {
    'store.js': demo ? './app/demo/demo-store.js' : './app/native-store.js',
    'scan.js': './app/scan-native.js',
    ...(demo ? { 'link.js': './app/demo/demo-link.js' } : {}),
  };
}

/** The app page's CSP: the site's, with no network for the WebView itself and no service worker or manifest. */
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob: mediastream:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const lf = (s) => s.replace(/\r\n/g, '\n');

function gitCommit() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: MOBILE, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '..'], { cwd: MOBILE, encoding: 'utf8' }).trim() ? '+changes' : '';
    return sha + dirty;
  } catch { return ''; }
}

/** Replaces exactly one occurrence, or stops: the web page changed under the app build. */
function swapOnce(html, from, to) {
  const n = html.split(from).length - 1;
  if (n !== 1) throw new Error(`build-app: expected exactly one ${JSON.stringify(from)} in the web build's index.html, found ${n}`);
  return html.replace(from, () => to);
}

export function buildApp({ demo = false, out = OUT, core = CORE, now = new Date() } = {}) {
  if (!fs.existsSync(core)) throw new Error(`build-app: ${core} is missing; run npm install in apaki/mobile first`);
  const web = build({ relay: RELAY, out });
  const v = web.version;

  // The PWA's parts have no job in the app (and a service worker could serve a stale page).
  for (const f of ['sw.js', 'manifest.webmanifest']) fs.rmSync(path.join(out, f), { force: true });

  const app = path.join(out, 'app');
  fs.mkdirSync(path.join(app, 'vendor'), { recursive: true });
  const copy = (from, to) => fs.writeFileSync(to, lf(fs.readFileSync(from, 'utf8')));
  for (const f of APP_FILES) copy(path.join(SRC, f), path.join(app, f));
  copy(core, path.join(app, 'vendor', 'capacitor-core.js'));
  if (demo) {
    fs.mkdirSync(path.join(app, 'demo'), { recursive: true });
    for (const f of DEMO_FILES) copy(path.join(SRC, 'demo', f), path.join(app, 'demo', f));
  }
  const info = { version: v, commit: gitCommit(), builtAt: now.toISOString(), demo: Boolean(demo) };
  fs.writeFileSync(path.join(app, 'build.js'), `/* Written by apaki/mobile/scripts/build-app.mjs: this build of the app's page. */\nexport const BUILD = Object.freeze(${JSON.stringify(info)});\n`);

  // Swap web modules for app ones, keeping every export the web module has.
  for (const [name, target] of Object.entries(swapsFor(demo))) {
    const theirs = exportNames(fs.readFileSync(path.join(out, name), 'utf8'));
    const mine = exportNames(fs.readFileSync(path.join(out, target), 'utf8'));
    const missing = theirs.filter((n) => !mine.includes(n));
    if (missing.length) throw new Error(`build-app: ${target} must export everything apaki/web's ${name} does; missing: ${missing.join(', ')}`);
    fs.writeFileSync(path.join(out, name), `/* ${name} in the Apaki app (apaki/mobile/scripts/build-app.mjs): the same exports as the web client's, from ${target}. */\nexport { ${mine.join(', ')} } from '${target}';\n`);
  }

  let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  html = swapOnce(html, `<meta http-equiv="Content-Security-Policy" content="${web.csp}">`, `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}">`);
  html = swapOnce(html, `<script type="module" src="boot.js?v=${v}"></script>`, `<script type="module" src="app/entry.js?v=${v}"></script>`);
  html = swapOnce(html, `<link rel="stylesheet" href="web.css?v=${v}">`, `<link rel="stylesheet" href="web.css?v=${v}">\n  <link rel="stylesheet" href="app/mobile.css?v=${v}">`);
  html = swapOnce(html, '<link rel="manifest" href="manifest.webmanifest">\n  ', '');
  fs.writeFileSync(path.join(out, 'index.html'), html);

  // Every relative static import must resolve, and the modules entry.js loads must be there.
  const missing = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
        if (!fs.existsSync(path.join(path.dirname(full), m[1]))) missing.push(`${path.relative(out, full)} imports ${m[1]}`);
      }
    }
  };
  walk(out);
  for (const f of ['boot.js', 'app/native-store.js', ...(demo ? ['app/demo/demo-setup.js'] : [])]) if (!fs.existsSync(path.join(out, f))) missing.push(`entry.js needs ${f}`);
  if (missing.length) throw new Error(`build-app: these imports are not in the build:\n  ${missing.join('\n  ')}`);
  // A build for release must not carry the pretend PC.
  if (!demo && fs.existsSync(path.join(app, 'demo'))) throw new Error('build-app: a non-demo build contains app/demo');

  const files = [];
  const list = (dir) => { for (const n of fs.readdirSync(dir)) { const f = path.join(dir, n); if (fs.statSync(f).isDirectory()) list(f); else files.push(f); } };
  list(out);
  const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  return { out, version: v, build: info, csp: APP_CSP, files: files.length, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const r = buildApp({ demo: args.includes('--demo'), out: outAt >= 0 ? path.resolve(args[outAt + 1]) : OUT });
  process.stdout.write(`built the app page ${r.version}${r.build.demo ? ' (DEMO: debug builds only)' : ''} from ${r.build.commit || 'an unknown commit'}: ${r.files} files, ${Math.round(r.bytes / 1024)} KB in ${r.out}\n`);
}
