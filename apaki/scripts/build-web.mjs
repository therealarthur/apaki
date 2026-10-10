#!/usr/bin/env node
/**
 * build-web.mjs: builds the Apaki phone web client (Track B part 2,
 * 2026-10-09) into apaki/web/dist: static files any static host can serve at
 * the address the pairing QR opens (APAKI_WEB_URL on the PC).
 *
 * It reuses Apaki's own window unchanged: apaki/ui's modules, styles, fonts
 * and index.html, plus the phone's own parts from apaki/web/src (boot, shim,
 * link, store, scan, web.css, shell.html), protocol.js and wire.js from
 * apaki/remote, a PWA manifest, a service worker caching this build's files,
 * and the Myrlin M icons (apaki/web/icons, made from
 * apaki/icons/source/apaki-icon-1024.png; favicon apaki-icon.svg).
 *
 *   node apaki/scripts/build-web.mjs                    relay from APAKI_RELAY_URL, else the placeholder
 *   node apaki/scripts/build-web.mjs --relay ws://127.0.0.1:8787 [--out <dir>]
 *   node apaki/scripts/build-web.mjs --serve 8790        then serve dist on 127.0.0.1:8790 (local testing)
 *
 * The page's Content-Security-Policy (a meta tag) allows its own files and a
 * WebSocket to that ONE relay origin, nothing else: no other connections,
 * no inline scripts, no framing by forms.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APAKI = path.resolve(here, '..');
const UI = path.join(APAKI, 'ui');
const WEB = path.join(APAKI, 'web');
const SRC = path.join(WEB, 'src');
const REMOTE = path.join(APAKI, 'remote');

// Every top-level module and stylesheet of Apaki's window comes along, so a
// module added there later (the artifacts viewer, say) reaches the phone
// too. phone.js (the desktop's Phone sheet and its QR encoder) stays behind:
// app.js loads it only on the desktop.
const UI_SKIP = new Set(['phone.js']);
const uiFiles = () => fs.readdirSync(UI).filter((f) => /\.(js|css)$/.test(f) && !UI_SKIP.has(f) && fs.statSync(path.join(UI, f)).isFile());
const WEB_FILES = ['boot.js', 'link.js', 'shim.js', 'store.js', 'scan.js', 'web.css'];
const REMOTE_FILES = ['protocol.js', 'wire.js'];
const RELAY_PLACEHOLDER = 'wss://relay.apaki.invalid';

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) o[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return o;
}

/** The relay's origin for connect-src: ws(s)://host[:port]. */
function relayOrigin(relay) {
  const u = new URL(relay);
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new Error(`the relay must be ws:// or wss://, not ${u.protocol}`);
  return `${u.protocol}//${u.host}`;
}

export function build({ relay = process.env.APAKI_RELAY_URL || RELAY_PLACEHOLDER, out = path.join(WEB, 'dist') } = {}) {
  const origin = relayOrigin(relay);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
  const files = [];
  const copy = (from, rel) => { fs.copyFileSync(from, path.join(out, rel)); files.push(rel); };
  for (const f of uiFiles()) copy(path.join(UI, f), f);
  for (const f of WEB_FILES) copy(path.join(SRC, f), f);
  for (const f of REMOTE_FILES) copy(path.join(REMOTE, f), f);
  for (const f of fs.readdirSync(path.join(UI, 'fonts'))) if (f.endsWith('.woff2')) copy(path.join(UI, 'fonts', f), `fonts/${f}`);
  for (const f of fs.readdirSync(path.join(WEB, 'icons'))) if (f.endsWith('.png')) copy(path.join(WEB, 'icons', f), `icons/${f}`);
  copy(path.join(APAKI, 'icons', 'source', 'apaki-icon.svg'), 'icons/favicon.svg');
  copy(path.join(SRC, 'manifest.webmanifest'), 'manifest.webmanifest');

  const template = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  const markSrc = fs.readFileSync(path.join(UI, 'mark.js'), 'utf8');
  const mark = JSON.parse(markSrc.slice(markSrc.indexOf('"'), markSrc.lastIndexOf('"') + 1)).replace('class="m-mark"', 'class="m-mark pair-mark"');
  const shell = fs.readFileSync(path.join(SRC, 'shell.html'), 'utf8').replace('%MARK%', () => mark);

  // One version for the whole build: a hash of everything in it.
  const hash = crypto.createHash('sha256');
  for (const rel of [...files].sort()) hash.update(rel).update(fs.readFileSync(path.join(out, rel)));
  hash.update(template).update(shell).update(origin);
  const v = hash.digest('hex').slice(0, 12);

  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${origin}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "media-src 'self' blob: mediastream:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  let html = template;
  const swap = (from, to) => {
    const n = html.split(from).length - 1;
    if (n !== 1) throw new Error(`build-web: expected exactly one ${JSON.stringify(from)} in apaki/ui/index.html, found ${n}`);
    html = html.replace(from, () => to);
  };
  swap('<meta name="viewport" content="width=device-width, initial-scale=1">', [
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="theme-color" content="#FDFDFF">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Apaki">',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="icon" href="icons/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
  ].join('\n  '));
  swap('<link rel="stylesheet" href="app.css">', `<link rel="stylesheet" href="app.css?v=${v}">\n  <link rel="stylesheet" href="web.css?v=${v}">`);
  swap('<body>', `<body class="web">\n${shell}`);
  swap('<nav class="tabs" id="tabs"', '<button class="drawer-btn" id="drawerBtn" aria-label="Sessions" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 6h13M3.5 10h13M3.5 14h8"/></svg></button>\n      <nav class="tabs" id="tabs"');
  swap('<footer class="rail-foot">', '<footer class="rail-foot">\n      <div class="pc-line" id="pcLine"></div>');
  swap('<script type="module" src="app.js"></script>', `<script type="module" src="boot.js?v=${v}"></script>`);
  fs.writeFileSync(path.join(out, 'index.html'), html);
  files.push('index.html');

  const assets = ['./', ...files, `app.css?v=${v}`, `web.css?v=${v}`, `boot.js?v=${v}`].map((f) => (f === './' ? f : `./${f}`));
  const sw = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8').replace('__VERSION__', v).replace('__ASSETS__', () => JSON.stringify(assets));
  fs.writeFileSync(path.join(out, 'sw.js'), sw);
  files.push('sw.js');

  // Every relative static import must resolve inside the build, or the phone
  // would get a page that fails to start. (Dynamic imports are allowed to be
  // missing: app.js imports phone.js on the desktop only.)
  const missing = [];
  for (const f of files.filter((x) => x.endsWith('.js') && x !== 'sw.js')) {
    const src = fs.readFileSync(path.join(out, f), 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const target = path.join(path.dirname(path.join(out, f)), m[1]);
      if (!fs.existsSync(target)) missing.push(`${f} imports ${m[1]}`);
    }
  }
  if (missing.length) throw new Error(`build-web: these imports are not in the build:\n  ${missing.join('\n  ')}`);

  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
  return { out, version: v, relay, origin, csp, files: files.length, bytes };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

/**
 * A static server for local testing. It logs every path it is asked for:
 * the pairing secret rides in the URL fragment, which browsers never send,
 * so it can never show up here.
 */
export function serve(dir, port, { log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    log(`${req.method} ${url.pathname}${url.search}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, `.${rel}`);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const r = build({ relay: typeof args.relay === 'string' ? args.relay : undefined, out: typeof args.out === 'string' ? path.resolve(args.out) : undefined });
  process.stdout.write(`built ${r.files} files (${Math.round(r.bytes / 1024)} KB) into ${r.out}\nversion ${r.version}; the page may connect to ${r.origin} only${r.relay === RELAY_PLACEHOLDER ? ' (placeholder: set APAKI_RELAY_URL or --relay)' : ''}\n`);
  if (args.serve) {
    const port = Number(args.serve) || 8790;
    await serve(r.out, port);
    process.stdout.write(`serving ${r.out} on http://127.0.0.1:${port}/\n`);
  }
}
