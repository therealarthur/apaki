/**
 * artifacts.js: what Claude shows the user, inside Myrlin Apaki.
 *
 * WHY (Arthur, 2026-10-09: artifacts like Codex has, out of the box): when
 * Claude calls Apaki's show tool, or runs a command that would open a page or
 * file in the OS (caught by the engine), the thing opens in a VIEWER PANE
 * beside the conversation that made it. A viewer is a pane like the others:
 * it sits in the tab's split layout, drags by its grip, resizes, closes with
 * Ctrl+W, and comes back with the workspace. The conversation gets a compact
 * CARD where the tool call was, also when the session is reopened later (the
 * cards come from the mcp__apaki__show calls and the "Opened in Apaki
 * instead" notes in its history), so anything can be opened again.
 *
 * Rendering is fast and contained:
 *   html     a sandboxed iframe (allow-scripts allow-forms allow-modals, never
 *            allow-same-origin) loading the page from the engine's localhost
 *            server, which serves it with a CSP that blocks every network
 *            load. A separate origin on purpose: srcdoc or blob: would inherit
 *            this window's CSP (no inline scripts) and its origin.
 *   svg, image   <img> (an SVG as an image runs no script)
 *   pdf      the browser's own PDF viewer in a frame
 *   markdown the app's own safe renderer (markdown.js)
 *   text     a code block
 * Web pages (kind url, BROWSER, Start-Process http://...) get a link card
 * whose Open shows the page in Apaki's built-in browser (browser.js, since
 * 2026-10-09), beside the conversation.
 *
 * The viewer talks to the app through `host`: send(op, args), focus(pane),
 * close(pane), dragPane(pane, e), dragEnd(), changed(pane), openUrl(url),
 * paneTitle(paneId).
 *
 * Viewers like ChatGPT's side window (2026-10-13, Arthur: "literally exactly
 * everything chatgpt's window could display and allow the session to do"):
 *   code      line numbers, syntax colours (highlight.js), wrap      codeview.js
 *   table     CSV, TSV and JSON records: sort, filter, fit, TSV     tableview.js
 *   json      a table for records, else a collapsible tree          jsontree.js
 *   sheet     xlsx, xlsm, xlsb, xls: a table per sheet (SheetJS)     sheets.js
 *   docx      Word documents, read only (mammoth)                   docview.js
 *   chart     a chart spec drawn as SVG, tooltips, PNG and SVG      chart.js
 * viewkind.js viewOf decides which; the heavy libraries load only when a
 * viewer of their kind opens (lazy.js). Every kind has one toolbar, inside
 * the viewer's own content (never in the pane header, so the viewer can be
 * mounted anywhere): revisions with a Changes view, Edit for Markdown and
 * text (a revision marked as the user's, read back by the session with the
 * view_read tool), Find, Copy, Download, Open outside, Reload, and Zoom for
 * pictures and charts. The phone draws every kind from content and says that
 * editing is on the PC.
 */

import { esc, md } from './markdown.js';
import { DIFFABLE_KINDS, EDITABLE_KINDS, fileNameFor, viewOf } from './viewkind.js';
import { renderCode } from './codeview.js';
import { TableView } from './tableview.js';
import { isTabularJson, parseDelimited, parseJsonLines, tableFromJson, tableFromRows } from './tabular.js';
import { collapseAll, expandAll, renderJsonTree } from './jsontree.js';
import { chartTable, normalizeChart } from './chartspec.js';
import { ChartView } from './chart.js';
import { renderDocx } from './docview.js';
import { b64Bytes, readWorkbook } from './sheets.js';
import { diffPatch } from './textdiff.js';
import { patchHtml } from './worktree.js';
import { openFind } from './find.js';
import { menu } from './menu.js';

// The phone build (apaki/web): artifacts come as content, never from the PC's local server (2026-10-12).
const ON_PHONE = typeof window !== 'undefined' && window.apakiShell === 'web';

export const SHOW_TOOL = 'mcp__apaki__show';

const KIND_LABEL = { html: 'HTML', markdown: 'Markdown', svg: 'SVG', image: 'Image', pdf: 'PDF', text: 'Text', file: 'File', url: 'Web page', sheet: 'Spreadsheet', docx: 'Document', chart: 'Chart' };
const GLYPH = {
  html: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9.2 3 6.8 13"/>',
  markdown: '<rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.6"/><path d="M4.2 10.4V5.6l1.9 2.3L8 5.6v4.8M11.4 5.6v4.6M9.9 8.8l1.5 1.5 1.5-1.5"/>',
  svg: '<path d="M3.2 12.8C5 7 10.8 9 12.8 3.2"/><rect x="1.6" y="11.2" width="3.2" height="3.2" rx=".8"/><rect x="11.2" y="1.6" width="3.2" height="3.2" rx=".8"/>',
  image: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><circle cx="5.8" cy="6.6" r="1.2"/><path d="m2.4 12 3.6-3.6 2.6 2.6 2-2 3.2 3.2"/>',
  pdf: '<path d="M4 1.8h5.4l3 3v9.4H4z"/><path d="M9.4 1.8v3h3M6 9h4.2M6 11.4h3"/>',
  text: '<path d="M3 4h10M3 6.8h10M3 9.6h7M3 12.4h4.6"/>',
  url: '<circle cx="8" cy="8" r="6.2"/><path d="M1.8 8h12.4M8 1.8c2.2 2.2 2.2 10.2 0 12.4M8 1.8c-2.2 2.2-2.2 10.2 0 12.4"/>',
  // 2026-10-13: the new kinds and views.
  sheet: '<rect x="2" y="2.6" width="12" height="10.8" rx="1.6"/><path d="M2 6.2h12M2 9.8h12M6.4 2.6v10.8"/>',
  table: '<rect x="2" y="2.6" width="12" height="10.8" rx="1.6"/><path d="M2 6.2h12M2 9.8h12M6.4 2.6v10.8"/>',
  docx: '<path d="M4 1.8h5.4l3 3v9.4H4z"/><path d="M9.4 1.8v3h3M6 7.6l.8 3.4L8 8.4l1.2 2.6.8-3.4"/>',
  chart: '<path d="M2.4 13.4h11.2"/><path d="M4 11V8.2M7 11V4.6M10 11V6.8M13 11V3"/>',
  code: '<path d="M5.4 4.6 2.2 8l3.2 3.4M10.6 4.6 13.8 8l-3.2 3.4"/>',
  json: '<path d="M5.6 2.6c-1.6 0-1.6 1-1.6 2.2s0 2.4-1.4 3.2c1.4.8 1.4 2 1.4 3.2s0 2.2 1.6 2.2M10.4 2.6c1.6 0 1.6 1 1.6 2.2s0 2.4 1.4 3.2c-1.4.8-1.4 2-1.4 3.2s0 2.2-1.6 2.2"/>',
};
const glyph = (kind) => `<svg viewBox="0 0 16 16" aria-hidden="true">${GLYPH[kind] || GLYPH.text}</svg>`;
const label = (kind) => KIND_LABEL[kind] || 'File';
/** A card's or badge's glyph and word for an artifact, finer for text: code in its language, a table, JSON (2026-10-13). */
function lookOf(kind, extra = {}) {
  if (kind !== 'text' || (!extra.ext && !extra.lang && !extra.title)) return { glyph: glyph(kind), label: label(kind) };
  const v = viewOf({ kind, ext: extra.ext, lang: extra.lang, title: extra.title });
  if (v.view === 'table') return { glyph: glyph('table'), label: v.label || 'Table' };
  if (v.view === 'json') return { glyph: glyph('json'), label: 'JSON' };
  return { glyph: glyph(v.lang && v.lang !== 'plaintext' ? 'code' : 'text'), label: v.lang && v.lang !== 'plaintext' ? v.label : 'Text' };
}
// For the conversation's reopen menu (pane.js).
export { glyph as kindGlyph, label as kindLabel };

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const hostOf = (u) => { try { const x = new URL(u); return x.host + (x.pathname !== '/' ? x.pathname : ''); } catch { return u; } };
const fmtSize = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Pulls { id, rev } out of a show result or an "Opened in Apaki instead" note. */
export function parseRef(text) {
  const m = String(text || '').match(/\bartifact ([a-z0-9-]{1,48}), rev (\d+)/);
  return m ? { id: m[1], rev: Number(m[2]) } : null;
}

/**
 * What an "Opened in Apaki instead: ..." note (a caught shell command, in its
 * tool result) showed: [{ kind: 'artifact', id, rev, path } | { kind: 'url', url }].
 */
export function parseOpened(text) {
  const t = String(text || '');
  const at = t.indexOf('Opened in Apaki instead: ');
  if (at === -1) return [];
  const body = t.slice(at + 25).split(/\.\s+(?:The user|Apaki)/)[0];
  const out = [];
  for (const part of body.split(/;\s+/)) {
    const ref = part.match(/^(.*) \(artifact ([a-z0-9-]{1,48}), rev (\d+)\)$/);
    if (ref) { out.push({ kind: 'artifact', path: ref[1], id: ref[2], rev: Number(ref[3]) }); continue; }
    const u = part.trim().replace(/[.,]$/, '');
    if (/^https?:\/\/\S+$/i.test(u)) out.push({ kind: 'url', url: u });
  }
  return out;
}

/**
 * True for an address a phone's own browser can reach: http(s) to a name or address on the internet. False for a page that
 * only exists on the PC (localhost, a LAN or link-local address, a name with no dot such as a dev machine, a .local or
 * .internal name), a file: address and anything that is not http(s). The phone page uses it to decide between opening a
 * link card in the phone's browser and showing the PC's browser (2026-10-12, app.js openOnPhone).
 */
export function isPublicWebUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return false;
  if (host.includes(':')) return !(host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host === '::' || /^::ffff:/.test(host));
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  return host.includes('.');
}

/* ---------- cards in the conversation ---------- */

/**
 * A compact card for one artifact. info: { id?, rev?, title, kind, state }
 * where state is 'pending' (the tool is still running), 'ready' or 'error'.
 * onOpen(card) opens it in a viewer.
 */
export function artifactCard(info, { onOpen }) {
  const c = el('div', 'art-card');
  c.innerHTML = `<span class="art-glyph">${glyph(info.kind)}</span><div class="art-main"><div class="art-kicker"></div><div class="art-title"></div><div class="art-sub"></div></div><button class="art-open">Open</button>`;
  c.querySelector('.art-open').onclick = (e) => { e.stopPropagation(); if (c.dataset.id) onOpen(c); };
  c.onclick = () => { if (c.dataset.id) onOpen(c); };
  updateCard(c, info);
  return c;
}

/** Fills or refreshes a card in place (a revision, the tool's result, an error). */
export function updateCard(c, info = {}) {
  if (info.id) c.dataset.id = info.id;
  if (info.rev) c.dataset.rev = String(info.rev);
  // 2026-10-13: the extension and language hint make a text card say "Python" or "CSV", with its glyph.
  if (info.ext) c.dataset.ext = info.ext;
  if (info.lang) c.dataset.lang = info.lang;
  if (info.title) c.dataset.title = info.title;
  if (info.kind) c.dataset.kind = info.kind;
  const look = lookOf(c.dataset.kind, { ext: c.dataset.ext, lang: c.dataset.lang, title: c.dataset.title });
  if (info.kind || info.ext || info.lang) c.querySelector('.art-glyph').innerHTML = look.glyph;
  // An edit of the user's in the viewer (2026-10-13): the card says so, so the conversation shows who changed it last.
  if (info.by) c.classList.toggle('by-user', info.by === 'user');
  const state = info.state || c.dataset.state || 'ready';
  c.dataset.state = state;
  const rev = Number(c.dataset.rev || 0);
  const mine = c.classList.contains('by-user') ? ' · edited by you' : '';
  c.querySelector('.art-kicker').textContent = state === 'pending' ? `${look.label} · preparing` : state === 'error' ? `${look.label} · not shown` : `${look.label}${rev > 1 ? ` · rev ${rev}` : ''}${mine}`;
  c.querySelector('.art-title').textContent = c.dataset.title || 'Artifact';
  const sub = info.error || info.sub || '';
  c.querySelector('.art-sub').textContent = sub;
  c.querySelector('.art-sub').hidden = !sub;
  c.querySelector('.art-open').hidden = state !== 'ready' || !c.dataset.id;
  c.classList.toggle('err', state === 'error');
}

/** A web page card: Open shows it in Apaki's built-in browser beside the conversation. */
export function linkCard({ url, title, reason }, { onOpen }) {
  const c = el('div', 'art-card link');
  c.dataset.kind = 'url';
  c.dataset.url = url;
  const why = reason && !['show', 'url'].includes(reason) ? ` · from ${reason}` : '';
  c.innerHTML = `<span class="art-glyph">${glyph('url')}</span><div class="art-main"><div class="art-kicker">Web page${esc(why)}</div><div class="art-title">${esc(title || hostOf(url))}</div><div class="art-sub mono">${esc(url)}</div></div><button class="art-open">Open</button>`;
  c.querySelector('.art-open').onclick = (e) => { e.stopPropagation(); onOpen(url); };
  c.title = url;
  return c;
}

/* ---------- the viewer pane ---------- */

let viewerSeq = 0;

const ICON = {
  prev: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  next: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  changes: '<path d="M5 2.5v6M2 5.5h6M8 12.5h6"/><rect x="1.5" y="1.5" width="13" height="13" rx="2.4" opacity=".55"/>',
  edit: '<path d="M10.4 2.8l2.8 2.8-7.6 7.6H2.8v-2.8z"/><path d="M8.8 4.4l2.8 2.8"/>',
  find: '<circle cx="7" cy="7" r="4.4"/><path d="m10.4 10.4 3.4 3.4"/>',
  copy: '<rect x="5.2" y="5.2" width="8.6" height="8.6" rx="1.8"/><path d="M10.8 5.2V3.6a1.4 1.4 0 0 0-1.4-1.4H3.6a1.4 1.4 0 0 0-1.4 1.4v5.8a1.4 1.4 0 0 0 1.4 1.4h1.6"/>',
  save: '<path d="M8 2.2v8.2M4.6 7.2 8 10.6l3.4-3.4M2.6 13.6h10.8"/>',
  outside: '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>',
  reload: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>',
  minus: '<path d="M3.5 8h9"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  wrap: '<path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8.5M10 10.5 8.5 12l1.5 1.5M2.5 12h3"/>',
  filter: '<circle cx="7" cy="7" r="4.4"/><path d="m10.4 10.4 3.4 3.4"/>',
};
const icon = (k) => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICON[k]}</svg>`;

// The toolbar every viewer has (2026-10-13), first in its content: revisions, the view's own controls, then actions.
const TOOLS_HTML = `<div class="art-tools" role="toolbar" aria-label="Viewer">
  <div class="at-revs" hidden>
    <button class="icon-btn at-prev" title="Earlier revision">${icon('prev')}</button>
    <span class="at-revn"></span>
    <button class="icon-btn at-next" title="Later revision">${icon('next')}</button>
    <button class="icon-btn at-changes" title="Changes from the revision before" aria-pressed="false">${icon('changes')}</button>
  </div>
  <div class="at-main"><span class="at-info"></span><div class="at-ctl"></div></div>
  <div class="at-acts">
    <span class="at-note" hidden></span>
    <button class="chip-btn at-edit" hidden title="Edit (a new revision, marked as yours)">${icon('edit')}<span>Edit</span></button>
    <span class="at-ro" hidden title="Editing is in Apaki on your PC">Read only on the phone</span>
    <button class="chip-btn at-cancel" hidden>Cancel</button>
    <button class="chip-btn at-commit" hidden title="Save (Ctrl+S)">Save</button>
    <button class="icon-btn at-find" title="Find (Ctrl+F)">${icon('find')}</button>
    <button class="icon-btn at-copy" title="Copy">${icon('copy')}</button>
    <button class="icon-btn at-save" title="Download">${icon('save')}</button>
    <button class="icon-btn at-outside" title="Open outside Apaki (default app)">${icon('outside')}</button>
    <button class="icon-btn at-reload" title="Reload">${icon('reload')}</button>
  </div>
</div>`;

/** Views drawn by the viewer itself from the artifact's content (the rest load from the PC's artifact server). */
const OWN_VIEWS = new Set(['code', 'table', 'json', 'sheet', 'docx', 'chart']);
const WRAP_KEY = 'apaki.viewer.wrap';
const fmtCount = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, w) => `${fmtCount(n)} ${w}${n === 1 ? '' : 's'}`;
const sizeOfB64 = (s) => Math.floor((String(s || '').length * 3) / 4);

/** Copies text (the clipboard API, or a hidden textarea where it is refused). Resolves true when it worked. */
async function copyTextOut(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* the fallback below */ }
  const t = document.createElement('textarea');
  t.value = text;
  t.style.position = 'fixed';
  t.style.opacity = '0';
  document.body.append(t);
  t.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  t.remove();
  return ok;
}

/** A picture's bytes as a PNG Blob (the clipboard takes PNG only), through a canvas. */
async function pngOf(blob) {
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('no picture'))), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

/** Saves bytes on this device with the browser's own download (the phone; a Blob link with a file name). */
function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

const blobToB64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

export class ArtifactPane {
  /**
   * art: { sessionId, id, rev?, title?, kind?, sourcePane? }. Loads the
   * artifact from the engine (artifactGet) unless `ready` already has it.
   */
  constructor(id, host, art = {}) {
    this.id = id;
    this.host = host;
    this.isViewer = true;
    this.sessionId = null; // a viewer holds no session of its own
    this.cwd = '';
    this.busy = false;
    this.unread = false;
    this.art = { ...art };
    this.title = art.title || 'Artifact';
    this.sourcePane = art.sourcePane || null;
    this.el = el('section', 'pane viewer');
    this.el.dataset.pane = id;
    this.el.innerHTML = `
      <header class="pane-bar">
        <span class="grip" draggable="true" title="Drag to move this viewer">
          <svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="7" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="7" cy="13" r="1.2"/></svg>
        </span>
        <div class="title-block">
          <h2 class="title">Artifact</h2>
          <div class="meta-line"><span class="art-badge"></span><span class="cwd art-meta"></span></div>
        </div>
        <div class="art-revs" hidden>
          <button class="icon-btn rev-prev" title="Earlier revision"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg></button>
          <span class="rev-n mono"></span>
          <button class="icon-btn rev-next" title="Later revision"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg></button>
        </div>
        <button class="icon-btn reload" title="Reload"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/></svg></button>
        <button class="icon-btn outside" title="Open outside Apaki (default app)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg></button>
        <button class="icon-btn close" title="Close viewer (Ctrl+W)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
      </header>
      <div class="ground art-ground">${TOOLS_HTML}<div class="art-body"></div><nav class="art-sheets" hidden aria-label="Sheets"></nav><div class="art-toast" role="status" aria-live="polite" hidden></div></div>`;
    const q = (s) => this.el.querySelector(s);
    this.$ = { title: q('.title'), badge: q('.art-badge'), meta: q('.art-meta'), body: q('.art-body'), ground: q('.art-ground'), revs: q('.art-revs'), revN: q('.rev-n'), grip: q('.grip'), close: q('.close'), input: null };
    // The viewer's toolbar (2026-10-13): inside its own content, so it goes wherever the viewer is mounted.
    this.el.classList.add('art-tooled');
    this.mode = 'view'; // 'view' | 'edit' | 'changes'
    this.sub = null; // a second way to look at the same thing: 'source', 'tree', 'data'
    this.zoom = null; // null: fit
    this.viewer = null; // the TableView or ChartView on screen
    this.gen = 0;
    this.aux = new Map();
    this.initTools();
    this.el.addEventListener('pointerdown', () => host.focus(this), true);
    this.$.close.onclick = () => host.close(this);
    q('.reload').onclick = () => this.load(this.shownRev());
    q('.outside').onclick = () => host.send('openExternal', { id: this.art.id, sessionId: this.art.sessionId, rev: this.shownRev() });
    q('.rev-prev').onclick = () => this.step(-1);
    q('.rev-next').onclick = () => this.step(1);
    this.$.grip.addEventListener('dragstart', (e) => host.dragPane(this, e));
    this.$.grip.addEventListener('dragend', () => host.dragEnd());
    this.renderHead();
    this.$.body.innerHTML = '<div class="art-loading"><i></i><i></i><i></i></div>';
    if (art.src) this.render(art); else this.load(art.rev || null);
  }

  /** The revision on screen (art.rev); art.latest is the newest there is. */
  shownRev() { return this.art.rev || this.art.latest || null; }

  step(d) {
    const revs = (this.art.revs || []).map((r) => r.rev);
    const next = revs[revs.indexOf(this.shownRev()) + d];
    if (next) this.load(next);
  }

  load(rev = null) {
    this.reqId = `${this.id}-${++viewerSeq}`;
    // On the phone every kind comes as content (images and PDFs as base64): the PC's artifact server is not reachable there.
    this.host.send('artifactGet', { reqId: this.reqId, paneId: this.id, id: this.art.id, sessionId: this.art.sessionId, rev, content: ON_PHONE ? true : 'text' });
  }

  /**
   * Shows an artifact here: a new one, a live revision (an `artifact` event,
   * which has src and is the latest), or a card's revision (no src: loaded).
   */
  show(art) {
    const same = art.id === this.art.id && art.sessionId === this.art.sessionId;
    // 2026-10-13: another artifact for this viewer's place while you edit waits until you save or cancel (your text
    // is never thrown away); otherwise a new artifact starts with the plain view (no sub-view, zoom or filter of the last).
    if (!same && this.mode === 'edit') {
      this.pendingArt = art;
      this.toolNote(`"${art.title || 'Another artifact'}" opens here when you save or cancel.`);
      return;
    }
    if (!same) {
      this.mode = 'view';
      this.sub = null;
      this.zoom = null;
      this.filterText = '';
      this.sheetIndex = 0;
      this.shown = null;
    }
    this.art = { ...(same ? this.art : {}), ...art };
    if (art.sourcePane) this.sourcePane = art.sourcePane;
    // The phone draws from content only (its src is the PC's 127.0.0.1 server), so it always loads.
    if (art.src && !ON_PHONE) this.render({ ...art, latest: art.rev }); else this.load(art.rev || null);
  }

  renderHead() {
    const a = this.art;
    this.title = a.title || 'Artifact';
    this.$.title.textContent = this.title;
    this.$.title.title = this.title;
    this.$.badge.innerHTML = `${glyph(a.kind)}<span>${esc(label(a.kind))}</span>`;
    // Whose it is shows in the header's link chip since 2026-10-12 (app.js renderLinks), in that conversation's accent.
    this.$.meta.textContent = [a.source ? a.source.replace(/^C:\\Users\\[^\\]+/i, '~') : '', fmtSize(a.size)].filter(Boolean).join('  ·  ');
    const revs = a.revs || [];
    this.$.revs.hidden = revs.length < 2;
    if (revs.length > 1) {
      const cur = this.shownRev();
      const i = revs.findIndex((r) => r.rev === cur);
      this.$.revN.textContent = `rev ${cur} of ${revs[revs.length - 1].rev}`;
      this.$.revs.querySelector('.rev-prev').disabled = i <= 0;
      this.$.revs.querySelector('.rev-next').disabled = i === -1 || i >= revs.length - 1;
      this.$.revs.classList.toggle('old', cur !== revs[revs.length - 1].rev);
    }
  }

  /** Draws one revision. a: an artifact event or artifactContent reply (src, kind, content?). */
  render(a, { answer = false } = {}) {
    this.art = { ...this.art, ...a, latest: a.latest || Math.max(this.art.latest || 0, a.rev || 0) || a.rev };
    this.renderHead();
    const body = this.$.body;
    const kind = a.kind;
    // 2026-10-13: which viewer draws it, the content of the revision on screen, and the toolbar for both.
    this.view = viewOf(this.art);
    if (a.content != null) this.shown = { rev: a.rev, content: a.content, encoding: a.encoding || 'utf8', kind };
    else if (this.shown && this.shown.rev !== a.rev) this.shown = null;
    if (!DIFFABLE_KINDS.includes(kind) && this.mode === 'changes') this.mode = 'view';
    if (this.mode === 'edit') {
      // A revision that arrived while you edit (the session's) leaves your text alone; saving asks first.
      this.renderTools();
      if (a.rev && a.rev !== this.editBase) this.toolNote(`Rev ${a.rev} came in while you edit. Saving asks first.`);
      return;
    }
    body.className = `art-body k-${kind}`;
    this.el.dataset.kind = kind;
    this.renderTools();
    if (OWN_VIEWS.has(this.view.view) || this.mode === 'changes' || this.sub === 'source') {
      // No content in the engine's own answer (an engine that does not send it): say so rather than ask forever.
      if (!this.shown) { if (answer) this.fail('This PC did not send the content to draw this.'); else this.load(a.rev || null); return; }
      body.classList.add(`v-${this.mode === 'changes' ? 'changes' : this.sub === 'source' ? 'code' : this.view.view}`);
      this.drawOwn();
      this.host.changed(this);
      return;
    }
    this.dropViewer();
    if (ON_PHONE) { this.renderOnPhone(a); this.afterDraw(); this.host.changed(this); return; }
    if (!a.src && kind !== 'markdown' && kind !== 'text') { this.fail('Apaki\'s artifact server is not running; reopen this once the engine is back.'); return; }
    if (kind === 'html') {
      const f = el('iframe', 'art-frame');
      // Scripts, forms and alerts only: never allow-same-origin, so the page
      // cannot reach this window, its storage or Tauri, whatever it runs.
      f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.setAttribute('allow', '');
      f.title = a.title || 'Artifact';
      f.src = a.src;
      body.replaceChildren(f);
    } else if (kind === 'pdf') {
      const f = el('iframe', 'art-frame pdf');
      f.title = a.title || 'PDF';
      f.src = a.src;
      body.replaceChildren(f);
    } else if (kind === 'image' || kind === 'svg') {
      const fig = el('figure', 'art-figure');
      const img = el('img');
      img.alt = a.title || '';
      img.decoding = 'async';
      img.src = a.src;
      img.onload = () => { fig.dataset.size = `${img.naturalWidth}×${img.naturalHeight}`; };
      // Click: fit to the pane, or actual pixels.
      fig.onclick = () => fig.classList.toggle('actual');
      fig.append(img);
      body.replaceChildren(fig);
    } else if (kind === 'markdown') {
      if (a.content == null) { this.load(a.rev); return; }
      const doc = el('article', 'art-doc turn-assistant', md(a.content));
      for (const link of doc.querySelectorAll('a[href]')) link.onclick = (e) => { e.preventDefault(); this.host.openUrl(link.href, this); };
      body.replaceChildren(doc);
    } else {
      if (a.content == null) { this.load(a.rev); return; }
      const pre = el('pre', 'art-code');
      pre.textContent = String(a.content).slice(0, 2_000_000);
      body.replaceChildren(pre);
    }
    this.afterDraw();
    this.host.changed(this);
  }

  /**
   * The phone (2026-10-12): every kind from the content the PC sent. HTML runs in sandbox.html, a page of the phone build
   * loaded in a sandboxed frame (an origin of its own: it cannot reach this page, its keys or its storage), whose own CSP
   * allows the artifact's scripts and no network, the way the desktop runs it with no network. Images and SVG as data URLs
   * (an SVG in an img runs nothing); a PDF opens in the phone's own viewer.
   */
  renderOnPhone(a) {
    const body = this.$.body;
    const kind = a.kind;
    if (a.content == null) { this.load(a.rev); return; }
    const b64 = a.encoding === 'base64';
    if (kind === 'html') {
      const f = el('iframe', 'art-frame');
      f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.title = a.title || 'Artifact';
      const html = b64 ? atob(a.content) : String(a.content);
      f.onload = () => f.contentWindow?.postMessage({ apakiArtifact: html }, '*');
      f.src = 'sandbox.html';
      body.replaceChildren(f);
    } else if (kind === 'image' || kind === 'svg') {
      const fig = el('figure', 'art-figure');
      const img = el('img');
      img.alt = a.title || '';
      img.decoding = 'async';
      img.src = b64 ? `data:${a.mime || 'image/png'};base64,${a.content}` : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(a.content))}`;
      img.onload = () => { fig.dataset.size = `${img.naturalWidth}×${img.naturalHeight}`; };
      fig.onclick = () => fig.classList.toggle('actual');
      fig.append(img);
      body.replaceChildren(fig);
    } else if (kind === 'pdf') {
      const box = el('div', 'art-missing');
      box.innerHTML = `<div class="tk-kicker">PDF</div><p>${esc(a.title || 'Document')}, ${esc(fmtSize(a.size))}</p>`;
      const open = el('button', 'btn', 'Open');
      open.onclick = () => {
        const bin = atob(String(a.content));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        window.open(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), '_blank');
      };
      box.append(open);
      body.replaceChildren(box);
    } else if (kind === 'markdown') {
      const doc = el('article', 'art-doc turn-assistant', md(String(a.content)));
      for (const link of doc.querySelectorAll('a[href]')) link.onclick = (e) => { e.preventDefault(); this.host.openUrl(link.href, this); };
      body.replaceChildren(doc);
    } else {
      const pre = el('pre', 'art-code');
      pre.textContent = (b64 ? `(binary, ${fmtSize(a.size)})` : String(a.content)).slice(0, 2_000_000);
      body.replaceChildren(pre);
    }
  }

  fail(text) {
    this.$.body.className = 'art-body';
    this.$.body.innerHTML = `<div class="art-missing"><div class="tk-kicker">Not available</div><p>${esc(text)}</p></div>`;
  }

  /** Engine events addressed to this viewer. */
  handle(e) {
    // Answers to the toolbar's own requests (2026-10-13): an earlier revision for Changes, content for Copy, a save, an edit.
    if (e.reqId && this.aux.has(e.reqId)) {
      const w = this.aux.get(e.reqId);
      this.aux.delete(e.reqId);
      w(e);
      return;
    }
    if (e.ev === 'artifactSaved') { this.toast(e.ok ? `Saved to Downloads as ${e.name}` : e.message || 'Could not save it.', !e.ok); return; }
    if (e.ev === 'artifactEdited') { this.edited(e); return; }
    // A refusal from the PC (its policy, or an engine without the op) ends the wait with the reason, not an endless spinner.
    if (e.ev === 'error' && e.reqId && e.reqId === this.reqId) { this.fail(e.message || 'The PC could not send this artifact.'); return; }
    if (e.ev !== 'artifactContent' || e.reqId !== this.reqId) return;
    if (e.error) { this.fail(e.error); return; }
    this.render(e, { answer: true });
  }

  /* The toolbar and the viewers it drives (2026-10-13). */

  initTools() {
    const q = (s) => this.el.querySelector(`.art-tools ${s}`);
    this.t = {
      bar: this.el.querySelector('.art-tools'), revs: q('.at-revs'), prev: q('.at-prev'), next: q('.at-next'), revn: q('.at-revn'), changes: q('.at-changes'),
      info: q('.at-info'), ctl: q('.at-ctl'), note: q('.at-note'), edit: q('.at-edit'), ro: q('.at-ro'), cancel: q('.at-cancel'), commit: q('.at-commit'),
      find: q('.at-find'), copy: q('.at-copy'), save: q('.at-save'), outside: q('.at-outside'), reload: q('.at-reload'),
      sheets: this.el.querySelector('.art-sheets'), toast: this.el.querySelector('.art-toast'),
    };
    const t = this.t;
    t.prev.onclick = () => this.step(-1);
    t.next.onclick = () => this.step(1);
    t.changes.onclick = () => { this.mode = this.mode === 'changes' ? 'view' : 'changes'; this.redraw(); };
    t.edit.onclick = () => this.startEdit();
    t.cancel.onclick = () => this.stopEdit();
    t.commit.onclick = () => this.saveEdit();
    t.find.onclick = () => openFind(this);
    t.copy.onclick = () => this.copy();
    t.save.onclick = () => this.download();
    t.outside.onclick = () => this.host.send('openExternal', { id: this.art.id, sessionId: this.art.sessionId, rev: this.shownRev() });
    t.reload.onclick = () => this.load(this.shownRev());
    // Ctrl and the mouse wheel zoom a picture or a chart.
    this.$.body.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !this.zoomable()) return;
      e.preventDefault();
      this.setZoom((this.zoom || this.fitZoom()) * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    }, { passive: false });
    // The phone saves on the phone and opens nothing on the PC's screen.
    if (ON_PHONE) t.outside.hidden = true;
  }

  /** Draws the toolbar for the current view, mode and revision. */
  renderTools() {
    const t = this.t;
    if (!t) return;
    const a = this.art;
    const v = this.view || viewOf(a);
    const kind = a.kind;
    const editing = this.mode === 'edit';
    const revs = a.revs || [];
    const cur = this.shownRev();
    const i = revs.findIndex((r) => r.rev === cur);
    t.revs.hidden = revs.length < 2 || editing;
    if (revs.length > 1) {
      const r = revs[i] || {};
      t.revn.textContent = `rev ${cur} of ${revs[revs.length - 1].rev}${r.by === 'user' ? ' · yours' : ''}`;
      t.revn.title = r.at ? `${r.by === 'user' ? 'Edited by you' : 'Made by the session'}, ${new Date(r.at).toLocaleString()}` : '';
      t.prev.disabled = i <= 0;
      t.next.disabled = i === -1 || i >= revs.length - 1;
      t.revs.classList.toggle('old', cur !== revs[revs.length - 1].rev);
      t.changes.hidden = !DIFFABLE_KINDS.includes(kind) || i <= 0;
      t.changes.classList.toggle('on', this.mode === 'changes');
      t.changes.setAttribute('aria-pressed', String(this.mode === 'changes'));
    }
    const canEdit = EDITABLE_KINDS.includes(kind);
    t.edit.hidden = editing || !canEdit || ON_PHONE || this.mode === 'changes';
    t.ro.hidden = !(canEdit && ON_PHONE);
    t.cancel.hidden = !editing;
    t.commit.hidden = !editing;
    for (const b of [t.find, t.copy, t.save, t.reload]) b.hidden = editing;
    t.outside.hidden = editing || ON_PHONE;
    t.find.hidden = editing || ['html', 'pdf', 'image', 'svg'].includes(v.view) && this.sub !== 'source' && this.mode !== 'changes' || (v.view === 'chart' && this.sub !== 'data' && this.sub !== 'source');
    t.copy.hidden = editing || kind === 'pdf';
    t.copy.title = this.copyTitle();
    t.save.title = 'Download';
    if (!editing) t.note.hidden = true;
    this.renderControls();
  }

  /** The view's own controls and the line of facts beside them (lines, rows, size, zoom). */
  renderControls({ infoOnly = false } = {}) {
    const t = this.t;
    const v = this.view || viewOf(this.art);
    const a = this.art;
    const ctl = [];
    let info = '';
    const seg = (items) => {
      const s = el('div', 'seg at-seg');
      for (const it of items) {
        const b = el('button', it.on ? 'on' : '', esc(it.label));
        b.type = 'button';
        b.onclick = () => { if (!it.on) it.pick(); };
        s.append(b);
      }
      return s;
    };
    if (this.mode === 'edit') {
      info = `Editing rev ${this.editBase}`;
    } else if (this.mode === 'changes') {
      info = this.diffInfo || 'Changes';
    } else {
      const sourceable = ['markdown', 'html', 'svg'].includes(v.view);
      if (v.view === 'code' || this.sub === 'source') {
        const lines = this.lineCount ?? null;
        info = [this.sub === 'source' ? (v.view === 'chart' ? 'JSON' : v.view === 'markdown' ? 'Markdown' : v.view.toUpperCase()) : v.label, lines !== null ? plural(lines, 'line') : ''].filter(Boolean).join(' · ');
        const w = el('button', `icon-btn at-wrap${this.wrapOn() ? ' on' : ''}`, icon('wrap'));
        w.title = this.wrapOn() ? 'Do not wrap long lines' : 'Wrap long lines';
        w.setAttribute('aria-pressed', String(this.wrapOn()));
        w.onclick = () => { this.setWrap(!this.wrapOn()); };
        ctl.push(w);
      }
      if (v.view === 'table' || v.view === 'sheet' || (v.view === 'json' && this.viewer instanceof TableView) || (v.view === 'chart' && this.sub === 'data')) {
        const c = this.viewer instanceof TableView ? this.viewer.counts() : null;
        if (c) info = `${c.shown !== c.total ? `${fmtCount(c.shown)} of ` : ''}${plural(c.total, 'row')} · ${plural(c.columns, 'column')}${this.cutNote || ''}`;
        const box = el('label', 'at-filter');
        box.innerHTML = `${icon('filter')}<input type="search" placeholder="Filter rows" spellcheck="false" autocomplete="off" aria-label="Filter rows">`;
        const input = box.querySelector('input');
        input.value = this.filterText || '';
        let timer = null;
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { this.filterText = input.value; this.viewer?.setFilter?.(input.value); }, 120); });
        input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { input.value = ''; this.filterText = ''; this.viewer?.setFilter?.(''); } });
        if (this.viewer instanceof TableView) ctl.push(box);
      }
      if (v.view === 'json' && this.jsonValue !== undefined) {
        const tabular = isTabularJson(this.jsonValue);
        if (tabular) ctl.push(seg([{ label: 'Table', on: this.sub !== 'tree', pick: () => { this.sub = null; this.redraw(); } }, { label: 'Tree', on: this.sub === 'tree', pick: () => { this.sub = 'tree'; this.redraw(); } }]));
        if (!(this.viewer instanceof TableView)) {
          info ||= `JSON · ${fmtSize(a.size)}`;
          const more = el('button', 'chip-btn at-small', 'Expand all');
          more.onclick = () => { const r = this.$.body.querySelector('.jt'); if (r) expandAll(r); };
          const less = el('button', 'chip-btn at-small', 'Collapse');
          less.onclick = () => { const r = this.$.body.querySelector('.jt'); if (r) collapseAll(r); };
          ctl.push(more, less);
        }
      }
      if (v.view === 'chart') {
        if (this.sub !== 'source' && this.sub !== 'data') info = this.chartInfo || 'Chart';
        // The chart, its numbers as a table (the accessible view), or the spec itself.
        ctl.push(seg([
          { label: 'Chart', on: !this.sub, pick: () => { this.sub = null; this.redraw(); } },
          { label: 'Data', on: this.sub === 'data', pick: () => { this.sub = 'data'; this.redraw(); } },
          { label: 'Spec', on: this.sub === 'source', pick: () => { this.sub = 'source'; this.redraw(); } },
        ]));
      }
      if (v.view === 'docx') info = `Word document · read only${this.docNote ? ` · ${this.docNote}` : ''}`;
      if (v.view === 'pdf') info = `PDF · ${fmtSize(a.size)}`;
      if (v.view === 'html' && this.sub !== 'source') info = 'Page · runs with no network';
      if ((v.view === 'image' || v.view === 'svg') && this.sub !== 'source') info = this.picSize || (v.view === 'svg' ? 'SVG' : 'Image');
      if (v.view === 'markdown' && this.sub !== 'source') info = this.wordCount ? plural(this.wordCount, 'word') : 'Markdown';
      if (sourceable) {
        const label = v.view === 'markdown' ? 'Preview' : v.view === 'html' ? 'Page' : 'Picture';
        ctl.push(seg([{ label, on: this.sub !== 'source', pick: () => { this.sub = null; this.redraw(); } }, { label: 'Source', on: this.sub === 'source', pick: () => { this.sub = 'source'; this.redraw(); } }]));
      }
      if (this.zoomable()) {
        const z = el('div', 'at-zoom');
        const minus = el('button', 'icon-btn', icon('minus'));
        minus.title = 'Zoom out';
        minus.onclick = () => this.setZoom((this.zoom || this.fitZoom()) / 1.25);
        const pct = el('button', 'chip-btn at-pct', this.zoom ? `${Math.round(this.zoom * 100)}%` : 'Fit');
        pct.title = this.zoom ? 'Fit to the pane' : 'Actual size';
        pct.onclick = () => this.setZoom(this.zoom ? null : 1);
        const plus = el('button', 'icon-btn', icon('plus'));
        plus.title = 'Zoom in';
        plus.onclick = () => this.setZoom((this.zoom || this.fitZoom()) * 1.25);
        z.append(minus, pct, plus);
        ctl.push(z);
      }
    }
    t.info.textContent = info;
    t.info.hidden = !info;
    if (!infoOnly) t.ctl.replaceChildren(...ctl);
  }

  /** Whether the thing on screen zooms (a picture or a chart). */
  zoomable() {
    if (this.mode !== 'view' || this.sub === 'source') return false;
    const v = this.view?.view;
    return v === 'image' || v === 'svg' || (v === 'chart' && this.sub !== 'data' && this.viewer instanceof ChartView);
  }

  /** The zoom a picture shows at when it fits the pane, so + and - start from what you see. */
  fitZoom() {
    const img = this.$.body.querySelector('.art-figure img');
    // An SVG with only a viewBox fits wider than its nominal 300 px, so the fit can be above 100 percent.
    if (img && img.naturalWidth) return img.clientWidth / img.naturalWidth || 1;
    return 1;
  }

  setZoom(z) {
    this.zoom = z === null ? null : Math.max(0.1, Math.min(8, z));
    const img = this.$.body.querySelector('.art-figure img');
    const fig = this.$.body.querySelector('.art-figure');
    if (img && fig) {
      fig.classList.toggle('zoomed', this.zoom !== null);
      fig.classList.remove('actual');
      if (this.zoom === null) { img.style.width = ''; img.style.height = ''; } else if (img.naturalWidth) {
        img.style.width = `${Math.round(img.naturalWidth * this.zoom)}px`;
        img.style.height = 'auto';
      }
    }
    if (this.viewer instanceof ChartView) this.viewer.setZoom(this.zoom || 1);
    this.renderControls();
  }

  wrapOn() {
    let saved = null;
    try { saved = localStorage.getItem(`${WRAP_KEY}.${this.view?.lang || 'text'}`); } catch { saved = null; }
    return saved === null ? Boolean(this.sub === 'source' ? true : this.view?.wrap) : saved === '1';
  }

  setWrap(on) {
    try { localStorage.setItem(`${WRAP_KEY}.${this.view?.lang || 'text'}`, on ? '1' : '0'); } catch { /* not kept */ }
    this.$.body.querySelector('.cv')?.classList.toggle('wrap', on);
    this.renderControls();
  }

  /** A note in the toolbar (an edit that could not be saved, a revision that came in), with optional buttons. */
  toolNote(text, actions = []) {
    const n = this.t.note;
    n.replaceChildren(document.createTextNode(text));
    for (const a of actions) {
      const b = el('button', 'chip-btn at-small', esc(a.label));
      b.onclick = a.onClick;
      n.append(b);
    }
    n.hidden = !text;
  }

  /** A short message at the bottom of the viewer that goes away by itself. */
  toast(text, bad = false) {
    const t = this.t.toast;
    t.textContent = text;
    t.classList.toggle('bad', bad);
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 5200 : 2600);
  }

  /** Draws again what is on screen (a mode or sub-view changed), loading content first when needed. */
  redraw() {
    // this.art keeps the fields of the last answer, content included: only the content of the revision on screen is passed on.
    const base = { ...this.art, content: undefined, encoding: undefined };
    this.render({ ...base, ...(this.shown && this.shown.rev === this.shownRev() ? { content: this.shown.content, encoding: this.shown.encoding } : {}) });
  }

  /** Destroys the table or chart on screen (its observers), and the sheet tabs. */
  dropViewer() {
    this.viewer?.destroy?.();
    this.viewer = null;
    this.jsonValue = undefined;
    this.lineCount = null;
    this.cutNote = '';
    this.t.sheets.hidden = true;
    this.t.sheets.replaceChildren();
  }

  /** After the older kinds drew themselves: facts for the toolbar (picture size, word count). */
  afterDraw() {
    const img = this.$.body.querySelector('.art-figure img');
    if (img) {
      const done = () => { this.picSize = img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight} px` : ''; if (this.zoom !== null) this.setZoom(this.zoom); else this.renderControls(); };
      if (img.complete) done(); else img.addEventListener('load', done, { once: true });
      // A click still flips between fit and actual size; the toolbar follows.
      img.closest('.art-figure')?.addEventListener('click', () => { this.zoom = null; img.style.width = ''; this.renderControls(); });
    }
    const doc = this.$.body.querySelector('.art-doc');
    this.wordCount = doc ? (doc.textContent.match(/\S+/g) || []).length : 0;
    this.renderControls();
  }

  /** The text of the revision on screen (utf8 content), or null when it is not text or not loaded. */
  text() {
    return this.shown && this.shown.encoding !== 'base64' ? String(this.shown.content) : null;
  }

  /** Draws the views the viewer makes itself (OWN_VIEWS), Changes, and any Source view. */
  drawOwn() {
    const body = this.$.body;
    const v = this.view;
    const gen = ++this.gen;
    this.dropViewer();
    const fail = (msg) => { if (gen === this.gen) { body.innerHTML = `<div class="art-missing"><div class="tk-kicker">Could not show it</div><p>${esc(msg)}</p></div>`; this.renderControls(); } };
    try {
      if (this.mode === 'changes') { this.drawChanges(gen); return; }
      if (this.sub === 'source' || v.view === 'code') {
        const text = this.text() ?? '';
        const grammar = this.sub === 'source' ? { markdown: 'markdown', html: 'xml', svg: 'xml', chart: 'json' }[v.view] || v.grammar : v.grammar;
        const r = renderCode(text, { grammar, wrap: this.wrapOn() });
        this.lineCount = r.lines;
        body.replaceChildren(r.el);
        this.renderControls();
        return;
      }
      if (v.view === 'table') {
        const parsed = parseDelimited(this.text() ?? '', v.delim);
        const data = tableFromRows(parsed.rows);
        this.cutNote = parsed.truncated ? ' · first rows only' : '';
        this.mountTable(data);
        return;
      }
      if (v.view === 'json') {
        const text = this.text() ?? '';
        let value;
        try { value = v.lines ? parseJsonLines(text) : JSON.parse(text); } catch (e) {
          // Not valid JSON: show it as code, with the reason.
          const r = renderCode(text, { grammar: 'json', wrap: this.wrapOn() });
          this.lineCount = r.lines;
          body.replaceChildren(r.el);
          this.toolNote(`Not valid JSON: ${String(e.message || e).slice(0, 120)}`);
          this.t.note.hidden = false;
          return;
        }
        this.jsonValue = value;
        if (this.sub !== 'tree' && isTabularJson(value)) { this.mountTable(tableFromJson(value)); return; }
        body.replaceChildren(renderJsonTree(value));
        this.renderControls();
        return;
      }
      if (v.view === 'chart') {
        const r = normalizeChart(this.text() ?? '');
        if (!r.ok) { fail(r.errors.join(' ')); return; }
        const s = r.spec;
        this.chartInfo = s.type === 'pie' ? `Pie chart · ${plural(s.categories.length, 'slice')}` : `${s.type[0].toUpperCase()}${s.type.slice(1)} chart · ${fmtCount(s.series.length)} series`;
        if (this.sub === 'data') { this.mountTable(chartTable(s)); return; }
        const cv = new ChartView(s);
        this.viewer = cv;
        body.replaceChildren(cv.el);
        cv.zoom = this.zoom || 1;
        cv.draw();
        this.renderControls();
        return;
      }
      if (v.view === 'sheet') {
        body.innerHTML = '<div class="art-loading"></div>';
        const bytes = b64Bytes(this.shown.content);
        readWorkbook(bytes).then((wb) => {
          if (gen !== this.gen) return;
          const visible = wb.sheets.filter((s) => !s.hidden);
          const list = visible.length ? visible : wb.sheets;
          if (!list.length) { fail('This workbook has no sheets.'); return; }
          this.sheetList = list;
          const pick = Math.min(this.sheetIndex || 0, list.length - 1);
          this.showSheet(pick);
        }).catch((e) => fail(`The workbook could not be read: ${e.message || e}`));
        return;
      }
      if (v.view === 'docx') {
        body.innerHTML = '<div class="art-loading"></div>';
        renderDocx(b64Bytes(this.shown.content)).then(({ el: doc, notes }) => {
          if (gen !== this.gen) return;
          for (const link of doc.querySelectorAll('a[href]')) {
            link.onclick = (e) => {
              e.preventDefault();
              const h = link.getAttribute('href');
              if (h.startsWith('#')) doc.querySelector(h)?.scrollIntoView({ block: 'start' });
              else if (/^https?:/i.test(h)) this.host.openUrl(h, this);
            };
          }
          this.docNote = notes.length ? `${plural(notes.length, 'part')} simplified` : '';
          body.replaceChildren(doc);
          this.wordCount = (doc.textContent.match(/\S+/g) || []).length;
          this.renderControls();
        }).catch((e) => fail(`The document could not be read: ${e.message || e}`));
        return;
      }
    } catch (e) {
      // Whatever went wrong, the text is still worth seeing.
      const text = this.text();
      if (text !== null) { const pre = el('pre', 'art-code'); pre.textContent = text.slice(0, 2_000_000); body.replaceChildren(pre); this.toolNote(String(e.message || e).slice(0, 160)); return; }
      fail(String(e.message || e));
    }
  }

  /** A table in the body, its filter and counts in the toolbar. */
  mountTable(data) {
    // A sort or a filter changes only the counts: the filter box keeps its focus while you type.
    const tv = new TableView(data, { onChange: () => this.renderControls({ infoOnly: true }) });
    this.viewer = tv;
    this.$.body.replaceChildren(tv.el);
    if (this.filterText) tv.setFilter(this.filterText);
    this.renderControls();
  }

  /** One sheet of the workbook on screen, with the sheet tabs under it. */
  showSheet(i) {
    const list = this.sheetList || [];
    const s = list[i];
    if (!s) return;
    this.sheetIndex = i;
    this.viewer?.destroy?.();
    this.viewer = null;
    this.cutNote = s.truncated ? ' · first rows only' : '';
    this.mountTable(tableFromRows(s.rows));
    const nav = this.t.sheets;
    nav.replaceChildren(...list.map((x, j) => {
      const b = el('button', j === i ? 'on' : '', esc(x.name));
      b.type = 'button';
      b.title = x.name;
      b.onclick = () => this.showSheet(j);
      return b;
    }));
    nav.hidden = list.length < 2;
  }

  /** What changed from the revision before the one on screen, as a diff (the same look as a worktree's changes). */
  async drawChanges(gen) {
    const body = this.$.body;
    const revs = this.art.revs || [];
    const cur = this.shownRev();
    const i = revs.findIndex((r) => r.rev === cur);
    const before = revs[i - 1];
    if (!before) { this.mode = 'view'; this.redraw(); return; }
    body.innerHTML = '<div class="art-loading"></div>';
    let old;
    try { old = await this.request({ rev: before.rev }); } catch (e) { if (gen === this.gen) body.innerHTML = `<div class="art-missing"><p>${esc(e.message || e)}</p></div>`; return; }
    if (gen !== this.gen) return;
    const a = old.encoding === 'base64' ? '' : String(old.content ?? '');
    const b = this.text() ?? '';
    const p = diffPatch(a, b);
    this.diffInfo = `From rev ${before.rev}${before.by === 'user' ? ' (yours)' : ''}: +${fmtCount(p.added)} -${fmtCount(p.removed)}`;
    const box = el('div', 'art-diff');
    box.innerHTML = p.hunks.length ? patchHtml(p) : '<div class="df-note">No lines changed (only the title, or nothing at all).</div>';
    body.replaceChildren(box);
    this.renderControls();
  }

  /** Asks the engine for a revision's content for the toolbar (not for the screen). Resolves with the artifactContent event. */
  request({ rev = null, content = true } = {}) {
    const reqId = `${this.id}-x${++viewerSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.aux.delete(reqId); reject(new Error('The PC did not answer.')); }, 20000);
      this.aux.set(reqId, (e) => {
        clearTimeout(timer);
        if (e.error || e.ev === 'error') reject(new Error(e.error || e.message || 'The PC could not send it.'));
        else resolve(e);
      });
      this.host.send('artifactGet', { reqId, paneId: this.id, id: this.art.id, sessionId: this.art.sessionId, rev: rev ?? this.shownRev(), content });
    });
  }

  /** The revision on screen with its content: what is loaded, or fetched now. */
  async withContent() {
    if (this.shown && this.shown.rev === this.shownRev() && this.shown.content != null) return this.shown;
    const e = await this.request({});
    return { rev: e.rev, content: e.content, encoding: e.encoding, kind: e.kind, mime: e.mime };
  }

  copyTitle() {
    const v = this.view?.view;
    if (this.viewer instanceof TableView) return 'Copy the rows shown, as TSV';
    if (this.viewer instanceof ChartView) return 'Copy the chart as a picture';
    if (v === 'image' || (v === 'svg' && this.sub !== 'source')) return 'Copy the picture';
    if (v === 'docx') return 'Copy the text';
    return 'Copy';
  }

  /** Copy: the rows shown, a chart or a picture as an image, a document's text, else the text itself. */
  async copy() {
    try {
      const v = this.view?.view;
      if (this.viewer instanceof TableView) {
        const c = this.viewer.counts();
        if (await copyTextOut(this.viewer.tsv())) this.toast(`Copied ${plural(c.shown, 'row')} as TSV`);
        return;
      }
      if (this.viewer instanceof ChartView || ((v === 'image' || v === 'svg') && this.sub !== 'source' && this.mode === 'view')) {
        let blob;
        if (this.viewer instanceof ChartView) blob = await this.viewer.png(2);
        else {
          const s = await this.withContent();
          blob = s.encoding === 'base64' ? new Blob([b64Bytes(s.content)], { type: s.mime || 'image/png' }) : new Blob([String(s.content)], { type: 'image/svg+xml' });
          blob = await pngOf(blob);
        }
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        this.toast('Copied the picture');
        return;
      }
      if (v === 'docx' && this.mode === 'view') {
        const doc = this.$.body.querySelector('.art-doc');
        if (doc && await copyTextOut(doc.innerText)) this.toast('Copied the text');
        return;
      }
      const s = await this.withContent();
      if (s.encoding === 'base64') { this.toast('This is not text; use Download.', true); return; }
      if (await copyTextOut(String(s.content))) this.toast(`Copied ${plural(String(s.content).split('\n').length, 'line')}`);
    } catch (e) {
      this.toast(`Could not copy: ${e.message || e}`, true);
    }
  }

  /** Download: the file itself, or (from a menu) the rows shown as CSV, a chart as PNG or SVG. */
  download() {
    const a = this.art;
    const name = fileNameFor({ title: a.title, ext: a.ext });
    const stem = name.replace(/\.[^.]+$/, '');
    const items = [{ value: 'file', label: name, hint: 'The file' }];
    if (this.viewer instanceof TableView && (this.view?.view === 'sheet' || this.viewer.counts().shown !== this.viewer.counts().total || this.viewer.sort)) items.push({ value: 'csv', label: `${stem}${this.view?.view === 'sheet' ? ` (${this.sheetList?.[this.sheetIndex || 0]?.name || 'sheet'})` : ' (rows shown)'}.csv`, hint: 'CSV' });
    if (this.viewer instanceof ChartView) items.push({ value: 'png', label: `${stem}.png`, hint: 'Picture' }, { value: 'svg', label: `${stem}.svg`, hint: 'Vector picture' });
    if (items.length === 1) { this.saveAs('file'); return; }
    menu(this.t.save, [{ heading: 'Download' }, ...items], { above: false, width: 260, onPick: (v) => this.saveAs(v) });
  }

  async saveAs(what) {
    const a = this.art;
    const name = fileNameFor({ title: a.title, ext: a.ext });
    const stem = name.replace(/\.[^.]+$/, '');
    try {
      let out = null; // { name, blob }
      if (what === 'csv') out = { name: `${stem}${this.view?.view === 'sheet' ? ` (${this.sheetList?.[this.sheetIndex || 0]?.name || 'sheet'})` : ''}.csv`, blob: new Blob([this.viewer.csv()], { type: 'text/csv' }) };
      if (what === 'png') out = { name: `${stem}.png`, blob: await this.viewer.png(2) };
      if (what === 'svg') out = { name: `${stem}.svg`, blob: new Blob([this.viewer.svgText()], { type: 'image/svg+xml' }) };
      if (ON_PHONE) {
        if (!out) {
          const s = await this.withContent();
          out = { name, blob: s.encoding === 'base64' ? new Blob([b64Bytes(s.content)], { type: s.mime || 'application/octet-stream' }) : new Blob([String(s.content)], { type: 'text/plain' }) };
        }
        downloadBlob(out.name, out.blob);
        this.toast(`Saved ${out.name}`);
        return;
      }
      // The desktop: the engine writes it into Downloads and shows it in Explorer (artifactSaved answers).
      if (!out) this.host.send('artifactSave', { reqId: `${this.id}-s${++viewerSeq}`, paneId: this.id, id: a.id, sessionId: a.sessionId, rev: this.shownRev(), name });
      else this.host.send('artifactSave', { reqId: `${this.id}-s${++viewerSeq}`, paneId: this.id, name: out.name, data: await blobToB64(out.blob), encoding: 'base64' });
    } catch (e) {
      this.toast(`Could not save it: ${e.message || e}`, true);
    }
  }

  /* Edit and send back (the canvas, 2026-10-13). */

  /** Edit mode: the text of the revision on screen in an editor; Save makes a new revision marked as yours. */
  async startEdit() {
    if (ON_PHONE || !EDITABLE_KINDS.includes(this.art.kind)) return;
    let s;
    try { s = await this.withContent(); } catch (e) { this.toast(e.message || String(e), true); return; }
    if (s.encoding === 'base64') return;
    this.dropViewer();
    this.mode = 'edit';
    this.editBase = this.shownRev();
    this.editOrig = String(s.content);
    const ta = el('textarea', 'art-editor');
    ta.value = this.editOrig;
    ta.spellcheck = this.art.kind === 'markdown';
    ta.setAttribute('aria-label', `Edit ${this.art.title || 'artifact'}`);
    ta.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); e.stopPropagation(); this.saveEdit(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.stopEdit(); return; }
      // Tab indents (two spaces) instead of leaving the editor; Ctrl+W would drop the edit, so it waits for Save or Cancel.
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'w' && ta.value !== this.editOrig) { e.preventDefault(); e.stopPropagation(); this.toolNote('Save or cancel your edit first.'); }
    });
    this.$.body.className = `art-body k-${this.art.kind} v-edit`;
    this.$.body.replaceChildren(ta);
    this.editor = ta;
    this.renderTools();
    ta.focus();
    ta.setSelectionRange(0, 0);
  }

  /** Leaves edit mode. With unsaved changes the first Cancel asks; the second discards. */
  stopEdit(force = false) {
    if (this.mode !== 'edit') return;
    const dirty = this.editor && this.editor.value !== this.editOrig;
    if (dirty && !force && !this.confirmDiscard) {
      this.confirmDiscard = true;
      this.toolNote('Discard your changes?', [{ label: 'Discard', onClick: () => this.stopEdit(true) }, { label: 'Keep editing', onClick: () => { this.confirmDiscard = false; this.toolNote(''); this.editor?.focus(); } }]);
      return;
    }
    this.confirmDiscard = false;
    this.mode = 'view';
    this.editor = null;
    this.toolNote('');
    if (!this.takePending()) this.load(this.shownRev());
  }

  /** Shows the artifact that came for this place while you edited, if one did. True when it did. */
  takePending() {
    const next = this.pendingArt;
    this.pendingArt = null;
    if (!next) return false;
    this.show(next);
    return true;
  }

  /** Sends your version to the engine (artifactEdit); force saves over a newer revision of the session's. */
  saveEdit(force = false) {
    if (this.mode !== 'edit' || !this.editor) return;
    const content = this.editor.value;
    if (content === this.editOrig && !force) { this.stopEdit(true); return; }
    this.t.commit.disabled = true;
    this.host.send('artifactEdit', { reqId: `${this.id}-e${++viewerSeq}`, paneId: this.id, sourcePane: this.sourcePane, id: this.art.id, sessionId: this.art.sessionId, baseRev: this.editBase, content, force });
  }

  /** The engine's answer to Save. */
  edited(e) {
    this.t.commit.disabled = false;
    if (e.ok) {
      this.mode = 'view';
      this.editor = null;
      this.toolNote('');
      this.art.rev = e.rev;
      this.toast(`Saved as rev ${e.rev}. Claude reads it with view_read, and hears of it with your next message.`);
      if (!this.takePending()) this.load(e.rev);
      return;
    }
    if (e.stale) {
      this.toolNote(`Rev ${e.rev} is newer than the one you started from.`, [{ label: 'Save anyway', onClick: () => this.saveEdit(true) }]);
      return;
    }
    this.toolNote(e.message || 'Could not save it.');
  }

  /** Ctrl+F in a table: the data is searched, not the page (only a screenful of rows exists in it). */
  findAdapter() {
    return this.mode === 'view' && this.viewer instanceof TableView ? this.viewer.findAdapter() : null;
  }

  /** The engine restarted: its server has a new address, so draw again from it. */
  engineBack() { this.load(this.shownRev()); }

  /** What the workspace saves for this viewer. */
  saved() { const a = this.art; return { sessionId: a.sessionId, id: a.id, title: a.title, kind: a.kind, sourcePane: this.sourcePane }; }

  // The pane interface app.js uses; a viewer has no conversation behind it.
  note() {}
  engineLost() {}
  setVoice() {}
  renderFolderSelect() {}
  open() {}

  destroy() {
    // A chart watches the theme and its size, a table its size: they stop with the viewer (2026-10-13).
    this.dropViewer();
    this.el.remove();
  }
}

export const newViewerId = () => `v${Date.now().toString(36)}${(++viewerSeq).toString(36)}`;
