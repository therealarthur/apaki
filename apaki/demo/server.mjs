/**
 * server.mjs: a short-lived static server for Apaki's demo harness.
 *
 * It serves the real desktop UI (apaki/ui, read only) and the harness
 * (apaki/demo/harness) on 127.0.0.1 and composes /desktop.html from the
 * template apaki/demo/desktop.html plus the head and body of apaki/ui/index.html,
 * so the demo always shows the UI as it is now: nothing in apaki/ui is copied.
 *
 *   import { startServer } from './server.mjs';
 *   const { url, close } = await startServer();   // a free port; close() when done
 *
 * Run by hand to look at the demo in a browser:
 *   node apaki/demo/server.mjs port=8765
 * then open http://127.0.0.1:8765/desktop.html?ws=steer&theme=dark
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '..', 'ui');
const HARNESS = path.join(HERE, 'harness');
const TEMPLATE = path.join(HERE, 'desktop.html');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

/** The page: the demo template with the UI's own head and body poured in (no copy kept on disk). */
export function composeDesktop() {
  const idx = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  const head = (/<head>([\s\S]*?)<\/head>/i.exec(idx) || [])[1] || '';
  const body = (/<body>([\s\S]*?)<\/body>/i.exec(idx) || [])[1] || '';
  const uiHead = head.replace(/<meta[^>]*>/gi, '').replace(/<title>[\s\S]*?<\/title>/i, '');
  // app.js is loaded by the template, after the harness shim.
  const uiBody = body.replace(/<script\s+type="module"\s+src="app\.js"\s*><\/script>/i, '');
  return fs.readFileSync(TEMPLATE, 'utf8').replace('{{UI_HEAD}}', () => uiHead).replace('{{UI_BODY}}', () => uiBody);
}

/** A file under `root` for a url path, or null when it escapes the root or is missing. */
function fileUnder(root, rel) {
  const full = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
}

export function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    if (p === '/' || p === '/desktop.html') {
      try { send(200, TYPES['.html'], composeDesktop()); } catch (e) { send(500, 'text/plain', String(e)); }
      return;
    }
    if (p === '/favicon.ico') { send(204, 'text/plain', ''); return; }
    const hit = p.startsWith('/ui/') ? fileUnder(UI, p.slice(4)) : p.startsWith('/harness/') ? fileUnder(HARNESS, p.slice(9)) : null;
    if (!hit) { send(404, 'text/plain', 'not found'); return; }
    send(200, TYPES[path.extname(hit).toLowerCase()] || 'application/octet-stream', fs.readFileSync(hit));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ url: `http://${host}:${addr.port}`, port: addr.port, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }) });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.slice(2).find((a) => a.startsWith('port='));
  startServer({ port: arg ? Number(arg.slice(5)) : 8765 }).then(({ url }) => {
    console.log(`Apaki demo harness: ${url}/desktop.html?ws=steer&theme=dark   (Ctrl+C to stop)`);
  });
}
