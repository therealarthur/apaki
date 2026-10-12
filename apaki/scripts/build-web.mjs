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
 *   node apaki/scripts/build-web.mjs --release [--relay wss://apaki.myrlin.io] [--site <dir>] [--serve 8790]
 *        publish this build at <site>/v/<version>/ (relay/site by default, which
 *        the relay Worker serves), keeping every earlier version, and rewrite
 *        <site>/app/index.html, the web app's entry with every published
 *        version (since 2026-10-12; the site's front page is the product's
 *        home page and a release leaves it alone)
 *
 * Trust (2026-10-10, Arthur: "a trustless solution where other users can use
 * this to reach their remote computers"): a build is reproducible (text files
 * with LF endings, everything hashed), so a PC can build the page it expects
 * from its own code (expected()) and compare it, file by file, with what the
 * site serves at /v/<version>/ before it shows a pairing code (engine
 * remote-page.js). Each version lives at its own path and never changes.
 *
 * The page's Content-Security-Policy (a meta tag) allows its own files, its
 * own origin's account API (2026-10-10, apaki/remote/ACCOUNTS.md) and a
 * WebSocket to that ONE relay origin, nothing else: no other connections,
 * no inline scripts, no framing by forms.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
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
// pager.js and desktop.js (2026-10-11): the conversation screen's tabs and pages, and "On your desktop" on the list.
// browserview.js (2026-10-12): the page Claude opened in the PC's browser, as a picture.
const WEB_FILES = ['boot.js', 'link.js', 'shim.js', 'store.js', 'scan.js', 'account.js', 'native.js', 'phonekey.js', 'pager.js', 'desktop.js', 'browserview.js', 'web.css', 'sandbox.html'];
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
  // Text with LF endings whatever the checkout uses, so the same code builds the same bytes on any machine.
  const TEXT = /\.(js|css|html|webmanifest|svg|json)$/i;
  const copy = (from, rel) => {
    if (TEXT.test(rel)) fs.writeFileSync(path.join(out, rel), fs.readFileSync(from, 'utf8').replace(/\r\n/g, '\n'));
    else fs.copyFileSync(from, path.join(out, rel));
    files.push(rel);
  };
  for (const f of uiFiles()) copy(path.join(UI, f), f);
  for (const f of WEB_FILES) copy(path.join(SRC, f), f);
  for (const f of REMOTE_FILES) copy(path.join(REMOTE, f), f);
  for (const f of fs.readdirSync(path.join(UI, 'fonts'))) if (f.endsWith('.woff2')) copy(path.join(UI, 'fonts', f), `fonts/${f}`);
  for (const f of fs.readdirSync(path.join(WEB, 'icons'))) if (f.endsWith('.png')) copy(path.join(WEB, 'icons', f), `icons/${f}`);
  copy(path.join(APAKI, 'icons', 'source', 'apaki-icon.svg'), 'icons/favicon.svg');
  copy(path.join(SRC, 'manifest.webmanifest'), 'manifest.webmanifest');

  const lf = (s) => s.replace(/\r\n/g, '\n');
  const template = lf(fs.readFileSync(path.join(UI, 'index.html'), 'utf8'));
  const markSrc = lf(fs.readFileSync(path.join(UI, 'mark.js'), 'utf8'));
  const mark = JSON.parse(markSrc.slice(markSrc.indexOf('"'), markSrc.lastIndexOf('"') + 1)).replace('class="m-mark"', 'class="m-mark pair-mark"');
  const shell = lf(fs.readFileSync(path.join(SRC, 'shell.html'), 'utf8')).replace('%MARK%', () => mark);

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
    // 'self': the Apaki account API (ACCOUNTS.md) is on the page's own origin; the relay is the only other place.
    `connect-src 'self' ${origin}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    // HTML artifacts run in sandbox.html (a page of this build) in a sandboxed frame of their own origin (2026-10-12).
    "frame-src 'self'",
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
  const sw = lf(fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8')).replace('__VERSION__', v).replace('__ASSETS__', () => JSON.stringify(assets));
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

/* ---------- publishing and checking (2026-10-10) ---------- */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Every file under `dir` (forward-slash paths) with its SHA-256, sorted; manifest.json itself left out. */
export function manifestOf(dir) {
  const out = {};
  const walk = (d, pre) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const rel = pre ? `${pre}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else if (rel !== 'manifest.json') out[rel] = sha256(fs.readFileSync(full));
    }
  };
  walk(dir, '');
  return out;
}

/** The phone page a PC expects for `relay`: { version, files: { path: sha256 } }, built in a temp folder. */
export function expected({ relay }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-web-'));
  try {
    const r = build({ relay, out: tmp });
    return { version: r.version, relay: r.relay, files: manifestOf(tmp) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export const DEFAULT_SITE = path.resolve(APAKI, '..', 'relay', 'site');

/**
 * Publishes this build at <site>/v/<version>/ with a manifest.json of its
 * files' hashes. Earlier versions stay (a PC on an older Apaki still opens the
 * page it was built with); a version already there must match byte for byte.
 */
export function release({ relay, site = DEFAULT_SITE } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-web-'));
  try {
    const r = build({ relay, out: tmp });
    const files = manifestOf(tmp);
    const dest = path.join(site, 'v', r.version);
    if (fs.existsSync(dest)) {
      const have = manifestOf(dest);
      const differ = [...new Set([...Object.keys(files), ...Object.keys(have)])].filter((k) => files[k] !== have[k]);
      if (differ.length) throw new Error(`build-web: ${dest} exists with different files (${differ.slice(0, 5).join(', ')}); a published version never changes`);
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(tmp, dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'manifest.json'), `${JSON.stringify({ version: r.version, relay: r.relay, publishedAt: new Date().toISOString(), files }, null, 1)}\n`);
    }
    writeLanding(site);
    return { ...r, dest, files: Object.keys(files).length };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** The published versions in a site, newest first: [{ version, relay, publishedAt, files }]. */
export function versionsOf(site = DEFAULT_SITE) {
  const root = path.join(site, 'v');
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.map((v) => { try { const m = JSON.parse(fs.readFileSync(path.join(root, v, 'manifest.json'), 'utf8')); return { version: v, relay: m.relay, publishedAt: m.publishedAt, files: Object.keys(m.files || {}).length }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The Myrlin M for the /app/ page's header (apaki/ui/mark.js, the same mark the phone page shows). */
function markSvg() {
  const src = fs.readFileSync(path.join(UI, 'mark.js'), 'utf8').replace(/\r\n/g, '\n');
  return JSON.parse(src.slice(src.indexOf('"'), src.lastIndexOf('"') + 1));
}

/**
 * The web app's entry, /app/ (2026-10-12): the way into the newest published phone page, what this site can
 * and cannot see, and every published version with its manifest. Until 2026-10-12 this was the site's front
 * page; the front page (relay/site/index.html) is now the product's home page, written by hand, and a release
 * never touches it. Pairing links from PCs open /v/<version>/ directly and do not pass through here.
 * A site folder with no front page yet (a fresh self-hosted copy) gets a small one that points here.
 */
export function writeLanding(site = DEFAULT_SITE) {
  // The newest published page is where "Open Apaki" goes (Arthur, 2026-10-10: "make sure users can login on
  // apaki to see their connected machines"): signing in or pairing both start there.
  const newest = versionsOf(site)[0] || null;
  const list = versionsOf(site).map((v) => `<li><code>${esc(v.version)}</code> <span>${esc(String(v.publishedAt || '').slice(0, 10))} · ${v.files} files · relay ${esc(new URL(v.relay).host)}</span> <a href="../v/${esc(v.version)}/manifest.json">file hashes</a></li>`).join('\n        ');
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="color-scheme" content="light dark">
  <title>Open the Apaki web app</title>
  <!-- impeccable-disable marquee: the one infinite horizontal animation here is the pearl background's slow drift (the desktop app's own background); it scrolls no content and stops under prefers-reduced-motion (2026-10-12) -->
  <link rel="icon" href="../assets/apaki-icon.svg" type="image/svg+xml">
  <script src="../assets/theme.js"></script>
  <link rel="stylesheet" href="../site.css">
</head>
<body class="app-page">
  <header class="app-head">
    <a class="app-brand" href="../" aria-label="Myrlin Apaki home">${markSvg()}<span>Apaki</span></a>
    <a class="app-home" href="../">About Apaki</a>
  </header>
  <main class="app-main">
    <h1>The Apaki web app</h1>
    <p class="lead">Your PC's Claude Code sessions, on your phone or any browser, end to end encrypted.</p>
    ${newest ? `<p class="cta"><a class="btn" href="../v/${esc(newest.version)}/">Open Apaki</a></p>
    <p class="cta-note">Sign in with your Apaki account (a passkey) to see your PCs and connect, or pair a new phone with the code Apaki shows on your PC (Phone, at the bottom of its sidebar).</p>` : '<p class="cta-note">No phone page is published on this site yet.</p>'}
    <h2>What this site can and cannot see</h2>
    <ul>
      <li>It serves the phone page and relays frames between your PC and your phones. Everything in those frames is end-to-end encrypted between the two; this site cannot read them and keeps nothing about your conversations. If you make an Apaki account, it stores the account's name, its passkeys' public keys and a vault it cannot open.</li>
      <li>The one-time pairing secret is in the part of the link after #, which browsers never send to a server.</li>
      <li>Your Claude and Codex logins never leave your PC. A paired phone works in conversations on your PC as you would there, so Claude can run commands and edit files for it; billing, accounts and pairing stay on the PC.</li>
      <li>Every version of the phone page has its own address and never changes. Before your PC shows a pairing code, it builds the page it expects from its own code and checks, file by file, that this site serves exactly that.</li>
    </ul>
    <h2>Published phone pages</h2>
    <ul class="versions">
        ${list || '<li>None yet.</li>'}
    </ul>
    <p class="small">Anyone can run their own copy: the relay and this page come from the Apaki source (relay/ and apaki/web/), and Apaki can point at another address.</p>
  </main>
</body>
</html>
`;
  fs.mkdirSync(path.join(site, 'app'), { recursive: true });
  fs.writeFileSync(path.join(site, 'app', 'index.html'), html);
  // A fresh site folder (someone running their own relay) has no front page: give it one line and a link here.
  const front = path.join(site, 'index.html');
  if (!fs.existsSync(front)) {
    fs.writeFileSync(front, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Myrlin Apaki</title>
  <link rel="stylesheet" href="site.css">
</head>
<body class="app-page">
  <main class="app-main">
    <h1>Myrlin Apaki</h1>
    <p class="lead">This site relays Apaki's end-to-end encrypted phone connections and serves its phone page.</p>
    <p class="cta"><a class="btn" href="app/">Open the web app</a></p>
  </main>
</body>
</html>
`);
  }
  return html;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json',
  // The home page's media (relay/site/assets, 2026-10-12), so --serve shows the whole site.
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.webp': 'image/webp', '.avif': 'image/avif', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

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
  const relayArg = typeof args.relay === 'string' ? args.relay : undefined;
  if (args.release) {
    const site = typeof args.site === 'string' ? path.resolve(args.site) : DEFAULT_SITE;
    const r = release({ relay: relayArg || process.env.APAKI_RELAY_URL || 'wss://apaki.myrlin.io', site });
    process.stdout.write(`published version ${r.version} (${r.files} files) at ${r.dest}
the page may connect to ${r.origin} only
`);
    if (args.serve) {
      const port = Number(args.serve) || 8790;
      await serve(site, port);
      process.stdout.write(`serving ${site} on http://127.0.0.1:${port}/ (the page: /v/${r.version}/)
`);
    }
  } else {
    const r = build({ relay: relayArg, out: typeof args.out === 'string' ? path.resolve(args.out) : undefined });
    process.stdout.write(`built ${r.files} files (${Math.round(r.bytes / 1024)} KB) into ${r.out}
version ${r.version}; the page may connect to ${r.origin} only${r.relay === RELAY_PLACEHOLDER ? ' (placeholder: set APAKI_RELAY_URL or --relay)' : ''}
`);
    if (args.serve) {
      const port = Number(args.serve) || 8790;
      await serve(r.out, port);
      process.stdout.write(`serving ${r.out} on http://127.0.0.1:${port}/
`);
    }
  }
}
