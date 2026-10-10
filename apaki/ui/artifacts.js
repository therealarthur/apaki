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
 * Web pages (kind url, BROWSER, Start-Process http://...) get a link card;
 * the built-in browser takes those over later. For now: Open in browser.
 *
 * The viewer talks to the app through `host`: send(op, args), focus(pane),
 * close(pane), dragPane(pane, e), dragEnd(), changed(pane), openUrl(url),
 * paneTitle(paneId).
 */

import { esc, md } from './markdown.js';

export const SHOW_TOOL = 'mcp__apaki__show';

const KIND_LABEL = { html: 'HTML', markdown: 'Markdown', svg: 'SVG', image: 'Image', pdf: 'PDF', text: 'Text', file: 'File', url: 'Web page' };
const GLYPH = {
  html: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9.2 3 6.8 13"/>',
  markdown: '<rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.6"/><path d="M4.2 10.4V5.6l1.9 2.3L8 5.6v4.8M11.4 5.6v4.6M9.9 8.8l1.5 1.5 1.5-1.5"/>',
  svg: '<path d="M3.2 12.8C5 7 10.8 9 12.8 3.2"/><rect x="1.6" y="11.2" width="3.2" height="3.2" rx=".8"/><rect x="11.2" y="1.6" width="3.2" height="3.2" rx=".8"/>',
  image: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><circle cx="5.8" cy="6.6" r="1.2"/><path d="m2.4 12 3.6-3.6 2.6 2.6 2-2 3.2 3.2"/>',
  pdf: '<path d="M4 1.8h5.4l3 3v9.4H4z"/><path d="M9.4 1.8v3h3M6 9h4.2M6 11.4h3"/>',
  text: '<path d="M3 4h10M3 6.8h10M3 9.6h7M3 12.4h4.6"/>',
  url: '<circle cx="8" cy="8" r="6.2"/><path d="M1.8 8h12.4M8 1.8c2.2 2.2 2.2 10.2 0 12.4M8 1.8c-2.2 2.2-2.2 10.2 0 12.4"/>',
};
const glyph = (kind) => `<svg viewBox="0 0 16 16" aria-hidden="true">${GLYPH[kind] || GLYPH.text}</svg>`;
const label = (kind) => KIND_LABEL[kind] || 'File';
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
  if (info.kind) { c.dataset.kind = info.kind; c.querySelector('.art-glyph').innerHTML = glyph(info.kind); }
  if (info.title) c.dataset.title = info.title;
  const state = info.state || c.dataset.state || 'ready';
  c.dataset.state = state;
  const rev = Number(c.dataset.rev || 0);
  c.querySelector('.art-kicker').textContent = state === 'pending' ? `${label(c.dataset.kind)} · preparing` : state === 'error' ? `${label(c.dataset.kind)} · not shown` : `${label(c.dataset.kind)}${rev > 1 ? ` · rev ${rev}` : ''}`;
  c.querySelector('.art-title').textContent = c.dataset.title || 'Artifact';
  const sub = info.error || info.sub || '';
  c.querySelector('.art-sub').textContent = sub;
  c.querySelector('.art-sub').hidden = !sub;
  c.querySelector('.art-open').hidden = state !== 'ready' || !c.dataset.id;
  c.classList.toggle('err', state === 'error');
}

/** A web page card: the built-in browser takes these over later; for now Open in browser. */
export function linkCard({ url, title, reason }, { onOpen }) {
  const c = el('div', 'art-card link');
  c.dataset.kind = 'url';
  c.dataset.url = url;
  const why = reason && !['show', 'url'].includes(reason) ? ` · from ${reason}` : '';
  c.innerHTML = `<span class="art-glyph">${glyph('url')}</span><div class="art-main"><div class="art-kicker">Web page${esc(why)}</div><div class="art-title">${esc(title || hostOf(url))}</div><div class="art-sub mono">${esc(url)}</div></div><button class="art-open">Open in browser</button>`;
  c.querySelector('.art-open').onclick = (e) => { e.stopPropagation(); onOpen(url); };
  c.title = url;
  return c;
}

/* ---------- the viewer pane ---------- */

let viewerSeq = 0;

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
      <div class="ground art-ground"><div class="art-body"></div></div>`;
    const q = (s) => this.el.querySelector(s);
    this.$ = { title: q('.title'), badge: q('.art-badge'), meta: q('.art-meta'), body: q('.art-body'), ground: q('.art-ground'), revs: q('.art-revs'), revN: q('.rev-n'), grip: q('.grip'), close: q('.close'), input: null };
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
    this.host.send('artifactGet', { reqId: this.reqId, paneId: this.id, id: this.art.id, sessionId: this.art.sessionId, rev, content: 'text' });
  }

  /**
   * Shows an artifact here: a new one, a live revision (an `artifact` event,
   * which has src and is the latest), or a card's revision (no src: loaded).
   */
  show(art) {
    const same = art.id === this.art.id && art.sessionId === this.art.sessionId;
    this.art = { ...(same ? this.art : {}), ...art };
    if (art.sourcePane) this.sourcePane = art.sourcePane;
    if (art.src) this.render({ ...art, latest: art.rev }); else this.load(art.rev || null);
  }

  renderHead() {
    const a = this.art;
    this.title = a.title || 'Artifact';
    this.$.title.textContent = this.title;
    this.$.title.title = this.title;
    this.$.badge.innerHTML = `${glyph(a.kind)}<span>${esc(label(a.kind))}</span>`;
    const from = this.sourcePane ? this.host.paneTitle?.(this.sourcePane) : null;
    this.$.meta.textContent = [a.source ? a.source.replace(/^C:\\Users\\[^\\]+/i, '~') : '', fmtSize(a.size), from ? `from ${from}` : ''].filter(Boolean).join('  ·  ');
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
  render(a) {
    this.art = { ...this.art, ...a, latest: a.latest || Math.max(this.art.latest || 0, a.rev || 0) || a.rev };
    this.renderHead();
    const body = this.$.body;
    const kind = a.kind;
    body.className = `art-body k-${kind}`;
    this.el.dataset.kind = kind;
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
      for (const link of doc.querySelectorAll('a[href]')) link.onclick = (e) => { e.preventDefault(); this.host.openUrl(link.href); };
      body.replaceChildren(doc);
    } else {
      if (a.content == null) { this.load(a.rev); return; }
      const pre = el('pre', 'art-code');
      pre.textContent = String(a.content).slice(0, 2_000_000);
      body.replaceChildren(pre);
    }
    this.host.changed(this);
  }

  fail(text) {
    this.$.body.className = 'art-body';
    this.$.body.innerHTML = `<div class="art-missing"><div class="tk-kicker">Not available</div><p>${esc(text)}</p></div>`;
  }

  /** Engine events addressed to this viewer. */
  handle(e) {
    if (e.ev !== 'artifactContent' || e.reqId !== this.reqId) return;
    if (e.error) { this.fail(e.error); return; }
    this.render(e);
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

  destroy() { this.el.remove(); }
}

export const newViewerId = () => `v${Date.now().toString(36)}${(++viewerSeq).toString(36)}`;
