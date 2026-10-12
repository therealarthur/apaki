/**
 * open-server.js: Myrlin Apaki's small HTTP server on 127.0.0.1.
 *
 * Two jobs, both behind random tokens on a random port (never a fixed port):
 *
 *   GET  /a/<uiToken>/<sessionId>/<file>   serves a stored artifact to the
 *        window's viewer. HTML and SVG come with a Content-Security-Policy
 *        that blocks every network load and sandboxes the page (scripts,
 *        forms and alerts only, no same-origin), so an artifact can never
 *        phone home or reach the app. The viewer is a sandboxed iframe on top.
 *        It is a separate origin from the window on purpose: a page served
 *        from the app's own origin (srcdoc, blob:) would inherit the window's
 *        CSP and lose its inline scripts.
 *
 *   POST /open  (header x-apaki-token: <paneToken>, body {"url": "..."})
 *        what apaki/bin/apaki-open.cmd sends. Each pane's Claude Code process
 *        gets BROWSER pointing at that shim and its own token, so `vite
 *        --open`, Python's webbrowser and other tools that honour BROWSER
 *        open inside Apaki, in the pane that asked. POST only, so a page
 *        cannot trigger it by navigating.
 *
 *   POST /shown (same token, body {"sessionId", "id"}) what the stdio tool
 *        server (apaki-mcp-stdio.mjs, for a later Codex tab) sends after it
 *        stored an artifact, so the pane shows it like an in-process show.
 *
 *   POST /tool (same token, body {"tool", "input", "meta"?}) the stdio tool
 *        server of a Codex process (2026-10-12): Apaki's show and browser tools
 *        run in the engine, for the pane the token belongs to (a Codex process
 *        has one token for all its threads: the engine picks the pane whose turn
 *        runs). The answer is JSON {ok, text, image?, mimeType?}.
 *
 * Idle cost is zero: a listening socket and nothing else. Requests whose Host
 * is not 127.0.0.1:<port> are refused (DNS rebinding).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { mimeOf } from './artifacts.js';

/** The policy every served HTML and SVG artifact runs under. */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts allow-forms allow-modals',
].join('; ');

const token = () => crypto.randomBytes(18).toString('base64url');
const MAX_BODY = 64 * 1024;
// A show call carries a whole page or report as text.
const MAX_TOOL_BODY = 16 * 1024 * 1024;

/**
 * Starts the server. `store` is an ArtifactStore; onOpen(paneId, url) is
 * called for every URL a shim hands over, onShown(paneId, { id, sessionId })
 * for every artifact the stdio tool server stored. Resolves to
 * { port, base, uiToken, openUrl, shownUrl, artifactUrl(rec, rev), paneToken(paneId), forget(paneId), close() }.
 */
export function startOpenServer({ store, onOpen = () => {}, onShown = () => {}, onTool = null } = {}) {
  const uiToken = token();
  const panes = new Map(); // token -> paneId
  const tokens = new Map(); // paneId -> token
  let port = 0;

  const server = http.createServer((req, res) => {
    const deny = (code, text = '') => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(text); };
    if (req.headers.host !== `127.0.0.1:${port}`) { deny(421, 'wrong host'); return; }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'POST' && url.pathname === '/tool' && onTool) {
      const paneId = panes.get(String(req.headers['x-apaki-token'] || ''));
      if (!paneId) { deny(403, 'bad token'); return; }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (d) => { body += d; if (body.length > MAX_TOOL_BODY) req.destroy(); });
      req.on('end', async () => {
        let j = null;
        try { j = JSON.parse(body); } catch { j = null; }
        if (!j || typeof j.tool !== 'string') { deny(400, 'need a tool'); return; }
        let r;
        try { r = await onTool(paneId, j.tool, j.input && typeof j.input === 'object' ? j.input : {}, j.meta && typeof j.meta === 'object' ? j.meta : {}); } catch (e) { r = { ok: false, text: String(e?.message || e) }; }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: Boolean(r?.ok), text: String(r?.text ?? ''), ...(r?.image ? { image: r.image, mimeType: r.mimeType || 'image/png' } : {}) }));
      });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/open' || url.pathname === '/shown')) {
      const paneId = panes.get(String(req.headers['x-apaki-token'] || ''));
      if (!paneId) { deny(403, 'bad token'); return; }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (d) => { body += d; if (body.length > MAX_BODY) req.destroy(); });
      req.on('end', () => {
        let j = null;
        try { j = JSON.parse(body); } catch { j = null; }
        if (url.pathname === '/shown') {
          // The stdio tool server (apaki-mcp-stdio.mjs) stored an artifact: show it in the pane.
          if (!j || typeof j.id !== 'string' || typeof j.sessionId !== 'string') { deny(400, 'need id and sessionId'); return; }
          try { onShown(paneId, { id: j.id, sessionId: j.sessionId }); } catch { /* reported by the engine */ }
        } else {
          const target = j ? String(j.url || '') : body.trim();
          if (!/^(https?|file):\/\/\S+$/i.test(target)) { deny(400, 'not a url'); return; }
          try { onOpen(paneId, target); } catch { /* the engine reports its own errors */ }
        }
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
      });
      return;
    }

    const m = url.pathname.match(/^\/a\/([A-Za-z0-9_-]+)\/([A-Za-z0-9-]{1,80})\/([^/]+)$/);
    if ((req.method === 'GET' || req.method === 'HEAD') && m) {
      if (m[1] !== uiToken) { deny(403); return; }
      const file = store.servedFile(m[2], decodeURIComponent(m[3]));
      if (!file) { deny(404, 'no such artifact'); return; }
      const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
      const mime = mimeOf(ext);
      const headers = {
        'content-type': mime,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'cross-origin',
      };
      // PDF goes to the browser's own viewer, which a sandbox would block.
      if (ext !== 'pdf') headers['content-security-policy'] = ARTIFACT_CSP;
      // Markdown and code are shown by the window, but as files they are plain text.
      if (/^text\/(markdown|plain)/.test(mime)) headers['content-type'] = 'text/plain; charset=utf-8';
      let size = 0;
      try { size = fs.statSync(file).size; } catch { deny(404); return; }
      headers['content-length'] = String(size);
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
      return;
    }
    deny(404);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      server.unref();
      const base = `http://127.0.0.1:${port}`;
      resolve({
        port,
        base,
        uiToken,
        openUrl: `${base}/open`,
        shownUrl: `${base}/shown`,
        /** Where the viewer loads one revision of an artifact. */
        artifactUrl: (rec, rev = rec.rev) => {
          const r = rec.revs.find((x) => x.rev === Number(rev)) || rec.revs[rec.revs.length - 1];
          const name = r.rev === rec.rev ? `${rec.id}.${r.ext}` : `${rec.id}.r${r.rev}.${r.ext}`;
          return `${base}/a/${uiToken}/${rec.sessionId}/${name}`;
        },
        /** The token a pane's Claude Code process sends with URLs it opens. */
        paneToken: (paneId) => {
          let t = tokens.get(paneId);
          if (!t) { t = token(); tokens.set(paneId, t); panes.set(t, paneId); }
          return t;
        },
        forget: (paneId) => { const t = tokens.get(paneId); if (t) panes.delete(t); tokens.delete(paneId); },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
