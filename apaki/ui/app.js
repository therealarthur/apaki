/**
 * app.js: Myrlin Apaki's window. Talks to the engine (apaki/engine/engine.js)
 * through the Rust shell: `engine_send` sends a command, `engine` events bring
 * everything back. The engine is latch's Claude Code runner, so a turn here is
 * a turn in the Claude Code session itself.
 *
 * Since 2026-10-09 (Arthur: a ding when any session comes back, several tabs,
 * drag sessions in to split up to six resizable panes) the window holds TABS,
 * each with a split LAYOUT of up to six PANES (pane.js), each pane its own
 * session with its own Claude Code process in the engine. The layout is a tree
 * (layout-tree.js); this file renders it, with draggable gutters between panes.
 *
 * Sessions from the rail:
 *   click        open in the focused pane (or focus the pane that has it)
 *   Ctrl+click   open in a new tab (middle click too)
 *   Shift+click  split it to the right of the focused pane
 *   drag         drop on a pane's edge to split, in its middle to replace it,
 *                on a tab to add it there, on + for a new tab
 * Panes move by dragging the grip at the left of their header.
 * Keys: Ctrl+T new tab, Ctrl+W close pane, Ctrl+Tab next tab, Ctrl+1..6 pane.
 *
 * The tabs and layout are saved in localStorage and come back at launch;
 * restored panes start Claude Code on their first message.
 */

import { esc, md } from './markdown.js';
import * as L from './layout-tree.js';
import { Pane, short } from './pane.js';
import { closeMenu, menu } from './menu.js';
import { arm, ding, setSoundOn, soundOn } from './sound.js';
import { MARK_SVG } from './mark.js';
import { ArtifactPane, newViewerId } from './artifacts.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

const SEARCH_DEBOUNCE_MS = 160;
const SAVE_KEY = 'apaki.workspace.v1';
const GUTTER_PX = 6;
// Smallest a pane can be dragged to; "resizable at any size" within reason.
const MIN_PANE_W = 150;
const MIN_PANE_H = 110;
const EDGE_ZONE = 0.28; // share of a pane's width or height that counts as its edge when dropping
const TAB_HOVER_SWITCH_MS = 450;
const DRAG_SESSION = 'application/x-apaki-session';
const DRAG_PANE = 'application/x-apaki-pane';

const S = {
  sessions: [], folders: [], view: 'all', query: '', results: null, searchInfo: '', ai: null, asking: null, lastSearch: null,
  voice: false, seq: 0, engineLost: false,
  defaults: { model: 'claude-opus-5-5', effort: 'xhigh', mode: 'bypassPermissions', billing: null },
  tabs: [], active: null, panes: new Map(), drag: null,
};

function send(op, args = {}) {
  return invoke('engine_send', { msg: { op, reqId: `r${++S.seq}`, ...args } }).catch((e) => focusedPane()?.note(String(e), 'error'));
}

/* ---------- formatting helpers ---------- */

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const kindLabel = (kind = '', codex = false) => {
  const agent = kind.startsWith('agent-');
  const base = agent ? kind.slice(6) : kind;
  const who = { prompt: 'you', reply: codex ? 'codex' : 'claude', tool: 'tool call', result: 'tool output' }[base] || base;
  return agent ? `subagent ${who}` : who;
};
/**
 * Bolds the words the search actually used (the server's terms, without
 * filler like "the" or "find"), at word starts only, so "in" never lights up
 * inside "leading".
 */
function highlight(text, query) {
  let h = esc(text || '');
  const terms = S.searchTerms?.length ? S.searchTerms : query.split(/\s+/);
  const words = [...new Set(terms.flatMap((t) => String(t).replace(/"/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length > 2))];
  if (!words.length) return h;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  return h.replace(re, '$1<b>$2</b>');
}

/* ---------- panes and tabs ---------- */

let paneSeq = 0;
const newPaneId = () => `p${Date.now().toString(36)}${(++paneSeq).toString(36)}`;
let tabSeq = 0;
const newTabId = () => `t${Date.now().toString(36)}${(++tabSeq).toString(36)}`;

const activeTab = () => S.tabs.find((t) => t.id === S.active) || S.tabs[0] || null;
const tabOf = (pane) => S.tabs.find((t) => L.has(t.root, pane.id)) || null;
function focusedPane() {
  const t = activeTab();
  if (!t) return null;
  return S.panes.get(t.focused) || S.panes.get(L.ids(t.root)[0]) || null;
}
const paneBySession = (id) => (id ? [...S.panes.values()].find((p) => p.sessionId === id) : null);

const host = {
  defaults: S.defaults,
  send,
  focus: (p) => focusPane(p, { scroll: false }),
  close: (p) => closePane(p),
  voice: (p) => toggleVoice(p),
  folder: (p, value) => paneFolder(p, value),
  folderMenu: (p, anchor) => folderMenu(p.sessionId, anchor),
  newConversation: (p) => newConversation(p),
  changed: () => { renderTabs(); renderRailMarks(); save(); },
  dragPane: (p, e) => {
    e.dataTransfer.setData(DRAG_PANE, p.id);
    e.dataTransfer.effectAllowed = 'move';
    S.drag = { kind: 'pane', paneId: p.id };
    document.body.classList.add('dragging');
  },
  dragEnd: () => endDrag(),
  linkSessions: (node) => linkSessions(node),
  // Artifacts (artifacts.js): a card's Open, and web pages. The built-in
  // browser (next) takes openUrl over; for now pages open in the system browser.
  showArtifact: (art, opts) => openViewer(art, opts),
  openUrl: (url) => send('openExternal', { url }),
  paneTitle: (id) => S.panes.get(id)?.title || null,
};

/* ---------- artifact viewers ---------- */

const viewers = () => [...S.panes.values()].filter((p) => p.isViewer);

function createViewer(art, id = newViewerId()) {
  const v = new ArtifactPane(id, host, art);
  S.panes.set(v.id, v);
  return v;
}

/**
 * Shows an artifact: in the viewer already showing it, else in the viewer
 * that belongs to the conversation that made it, else in a new viewer split
 * to that conversation's right. Claude's own shows (auto) never rearrange a
 * full tab; the card's Open then puts the viewer in a new tab. Focus stays
 * where it was unless asked, so typing in the conversation is not interrupted.
 */
function openViewer(art, { focus = false, auto = false } = {}) {
  const src = S.panes.get(art.sourcePane) || null;
  let v = viewers().find((x) => x.art.id === art.id && x.art.sessionId === art.sessionId) || null;
  const t = (v && tabOf(v)) || (src && tabOf(src)) || activeTab();
  if (!v && t?.root) v = L.ids(t.root).map((id) => S.panes.get(id)).find((x) => x?.isViewer && x.sourcePane === art.sourcePane) || null;
  const keep = document.activeElement;
  const restoreFocus = () => { if (!focus && keep && document.contains(keep) && document.activeElement !== keep) keep.focus({ preventScroll: true }); };
  if (v) {
    v.show(art);
    if (focus) focusPane(v);
    renderTabs();
    save();
    return v;
  }
  if (!t || (t.root && L.count(t.root) >= L.MAX_PANES)) {
    if (auto && t) return null;
    const nt = createTab(null);
    v = createViewer(art);
    nt.root = L.leaf(v.id);
    nt.focused = v.id;
    layout(nt);
    switchTab(nt);
    focusPane(v);
    save();
    return v;
  }
  v = createViewer(art);
  const anchor = src && L.has(t.root, src.id) ? src.id : t.focused || L.ids(t.root)[0];
  t.root = t.root ? L.insert(t.root, anchor, v.id, 'right') : L.leaf(v.id);
  if (!t.focused) t.focused = v.id;
  layout(t);
  if (focus) focusPane(v); else restoreFocus();
  renderTabs();
  save();
  return v;
}

function createPane(settings = {}) {
  const p = new Pane(settings.id || newPaneId(), host, settings);
  p.setVoice(S.voice);
  p.renderFolderSelect(S.folders, S.sessions);
  S.panes.set(p.id, p);
  return p;
}

function createTab(root = null) {
  const stage = el('div', 'stage');
  stage.append(el('div', 'drop-hint'));
  $('stages').append(stage);
  const t = { id: newTabId(), root, focused: root ? L.ids(root)[0] : null, stage };
  wireStage(t);
  S.tabs.push(t);
  return t;
}

/** A new tab with one pane, holding `session` or a new conversation. */
function addTab({ session = null, cwd = null, activate = true } = {}) {
  const base = focusedPane();
  const p = createPane({ cwd: cwd || session?.cwd || base?.cwd || '', model: base?.model, effort: base?.effort, mode: base?.mode });
  const t = createTab(L.leaf(p.id));
  layout(t);
  p.open(session, { warm: true });
  if (activate) switchTab(t);
  focusPane(p);
  return t;
}

function switchTab(t) {
  if (!t) return;
  S.active = t.id;
  for (const x of S.tabs) x.stage.classList.toggle('on', x === t);
  const p = S.panes.get(t.focused);
  if (p) { p.unread = false; p.el.classList.remove('unread'); }
  renderTabs();
  renderRailMarks();
  save();
}

function focusPane(p, { scroll = true } = {}) {
  if (!p) return;
  const t = tabOf(p);
  if (!t) return;
  if (t.id !== S.active) switchTab(t);
  if (t.focused !== p.id || !p.el.classList.contains('focused')) {
    t.focused = p.id;
    for (const id of L.ids(t.root)) S.panes.get(id)?.el.classList.toggle('focused', id === p.id);
    save();
  }
  if (p.unread) { p.unread = false; p.el.classList.remove('unread'); }
  if (scroll && document.activeElement?.closest?.('.pane') !== p.el) p.$.input?.focus({ preventScroll: true });
  document.title = `Myrlin Apaki · ${p.title}`;
  renderTabs();
  renderRailMarks();
}

function closePane(p, { confirmBusy = true } = {}) {
  if (confirmBusy && p.busy && !window.confirm(`"${p.title}" is still working. Stop it and close the pane?`)) return;
  const t = tabOf(p);
  if (rec?.pane === p) stopVoice(true);
  if (!p.isViewer) send('close', { paneId: p.id });
  S.panes.delete(p.id);
  p.destroy();
  if (!t) return;
  t.root = L.remove(t.root, p.id);
  if (t.focused === p.id) t.focused = L.ids(t.root)[0] || null;
  if (!t.root && S.tabs.length > 1) { closeTab(t, { confirmBusy: false }); return; }
  layout(t);
  const next = S.panes.get(t.focused);
  if (next) focusPane(next); else { renderTabs(); save(); }
}

function closeTab(t, { confirmBusy = true } = {}) {
  const panes = L.ids(t.root).map((id) => S.panes.get(id)).filter(Boolean);
  if (confirmBusy && panes.some((p) => p.busy) && !window.confirm('A pane in this tab is still working. Stop it and close the tab?')) return;
  for (const p of panes) { if (!p.isViewer) send('close', { paneId: p.id }); S.panes.delete(p.id); p.destroy(); }
  const i = S.tabs.indexOf(t);
  S.tabs.splice(i, 1);
  t.stage.remove();
  if (!S.tabs.length) { addTab(); return; }
  if (S.active === t.id) switchTab(S.tabs[Math.max(0, i - 1)]);
  renderTabs();
  save();
}

function newConversation(p) {
  if (!p || p.busy || p.isViewer) { addTab(); return; }
  p.open(null, { warm: true });
}

/* ---------- layout rendering ---------- */

/** Renders a tab's layout tree, moving the existing pane elements (their state stays). */
function layout(t) {
  const scrolls = new Map();
  for (const id of L.ids(t.root)) { const p = S.panes.get(id); if (p) scrolls.set(p, p.$.ground.scrollTop); }
  const hint = t.stage.querySelector('.drop-hint');
  t.stage.replaceChildren(hint);
  t.stage.classList.toggle('multi', L.count(t.root) > 1);
  if (!t.root) {
    const empty = el('div', 'stage-empty', `${MARK_SVG.replace('class="m-mark"', 'class="m-mark empty-mark"')}<p>Drag a session here from the left, or</p>`);
    const b = el('button', 'new', 'New conversation');
    b.onclick = () => { const p = createPane({}); t.root = L.leaf(p.id); t.focused = p.id; layout(t); p.open(null, { warm: true }); focusPane(p); };
    empty.append(b);
    t.stage.append(empty);
    return;
  }
  const build = (node) => {
    if (node.type === 'leaf') return S.panes.get(node.pane)?.el || el('div', 'pane missing');
    const box = el('div', `split ${node.dir}`);
    node.children.forEach((c, i) => {
      if (i) box.append(gutter(t, node, i, box));
      const child = build(c);
      child.style.flex = `${node.sizes[i]} 1 0px`;
      box.append(child);
    });
    return box;
  };
  const rootEl = build(t.root);
  rootEl.style.flex = '1 1 0px';
  t.stage.append(rootEl);
  for (const [p, top] of scrolls) p.$.ground.scrollTop = top;
  for (const id of L.ids(t.root)) S.panes.get(id)?.el.classList.toggle('focused', id === t.focused);
}

/** The draggable bar between two neighbours of a split. Double-click evens the split out. */
function gutter(t, node, i, box) {
  const g = el('div', `gutter ${node.dir}`);
  g.title = 'Drag to resize · double-click to even out';
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    g.classList.add('active');
    document.body.classList.add(node.dir === 'row' ? 'resizing-x' : 'resizing-y');
    const horizontal = node.dir === 'row';
    const rect = box.getBoundingClientRect();
    const total = (horizontal ? rect.width : rect.height) - GUTTER_PX * (node.children.length - 1);
    const a = i - 1;
    const b = i;
    const start = horizontal ? e.clientX : e.clientY;
    const sa = node.sizes[a];
    const sb = node.sizes[b];
    const sum = node.sizes.reduce((x, y) => x + y, 0);
    const minFrac = ((horizontal ? MIN_PANE_W : MIN_PANE_H) / total) * sum;
    const kids = [...box.children].filter((c) => !c.classList.contains('gutter'));
    const move = (ev) => {
      const d = (((horizontal ? ev.clientX : ev.clientY) - start) / total) * sum;
      let na = sa + d;
      let nb = sb - d;
      if (na < minFrac) { nb -= minFrac - na; na = minFrac; }
      if (nb < minFrac) { na -= minFrac - nb; nb = minFrac; }
      if (na < minFrac || nb < minFrac) return;
      node.sizes[a] = na;
      node.sizes[b] = nb;
      kids[a].style.flex = `${na} 1 0px`;
      kids[b].style.flex = `${nb} 1 0px`;
    };
    const up = () => {
      g.releasePointerCapture(e.pointerId);
      g.classList.remove('active');
      document.body.classList.remove('resizing-x', 'resizing-y');
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      save();
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', () => {
    node.sizes = node.children.map(() => 1 / node.children.length);
    layout(t);
    save();
  });
  return g;
}

/** Rearranges the active tab's panes into an even grid (2 side by side, 2x2, 3+2, 3x3...). */
function arrangeGrid() {
  const t = activeTab();
  if (!t?.root) return;
  t.root = L.grid(L.ids(t.root));
  layout(t);
  save();
}

/* ---------- drag and drop into the stage ---------- */

function dragKind(e) {
  const types = [...(e.dataTransfer?.types || [])];
  if (types.includes(DRAG_PANE)) return 'pane';
  if (types.includes(DRAG_SESSION)) return 'session';
  if (types.includes('Files')) return 'files';
  return null;
}

/** Where a drop at this point would go: a pane edge, a pane's middle, or the empty stage. */
function dropZone(t, e, kind) {
  const stageRect = t.stage.getBoundingClientRect();
  if (!t.root) return { where: 'root', rect: stageRect, stageRect };
  const paneEl = e.target.closest?.('.pane');
  const pane = paneEl && S.panes.get(paneEl.dataset.pane);
  if (!pane) return null;
  const r = paneEl.getBoundingClientRect();
  const movingId = kind === 'pane' ? S.drag?.paneId : null;
  if (movingId === pane.id) return null;
  const sameTab = movingId && L.has(t.root, movingId);
  const full = L.count(t.root) >= L.MAX_PANES && !sameTab;
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const [edge, dist] = Object.entries({ left: x, right: 1 - x, top: y, bottom: 1 - y }).sort((p, q) => p[1] - q[1])[0];
  if (dist < EDGE_ZONE && !full) {
    const half = {
      left: { left: r.left, top: r.top, width: r.width / 2, height: r.height },
      right: { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height },
      top: { left: r.left, top: r.top, width: r.width, height: r.height / 2 },
      bottom: { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 },
    }[edge];
    return { where: 'edge', edge, pane, rect: half, stageRect };
  }
  return { where: 'center', pane, rect: r, stageRect, full };
}

function showHint(t, z, kind) {
  const hint = t.stage.querySelector('.drop-hint');
  if (!z) { hint.classList.remove('on'); return; }
  const { rect, stageRect } = z;
  Object.assign(hint.style, { left: `${rect.left - stageRect.left + 4}px`, top: `${rect.top - stageRect.top + 4}px`, width: `${rect.width - 8}px`, height: `${rect.height - 8}px` });
  let text = 'Open here';
  if (z.where === 'edge') text = `Split ${z.edge}`;
  if (z.where === 'center') {
    if (kind === 'pane') text = L.has(t.root, S.drag?.paneId) ? 'Swap these panes' : 'Move here';
    else text = z.full ? `${L.MAX_PANES} panes is the most per tab. Drop here to replace this one, or on + for a new tab` : z.pane.isViewer ? 'Replace this viewer' : 'Replace this conversation';
    if (z.pane.busy && kind === 'session') text = 'This pane is working; drop on an edge instead';
  }
  hint.textContent = text;
  hint.classList.toggle('full', Boolean(z.full) || (z.where === 'center' && z.pane.busy && kind === 'session'));
  hint.classList.add('on');
}

function endDrag() {
  S.drag = null;
  document.body.classList.remove('dragging');
  for (const t of S.tabs) t.stage.querySelector('.drop-hint')?.classList.remove('on');
  for (const tab of document.querySelectorAll('.tab.drop')) tab.classList.remove('drop');
}

function wireStage(t) {
  t.stage.addEventListener('dragover', (e) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    if (kind === 'files') {
      const paneEl = e.target.closest?.('.pane');
      for (const c of t.stage.querySelectorAll('.composer.drop')) if (c.closest('.pane') !== paneEl) c.classList.remove('drop');
      paneEl?.querySelector('.composer')?.classList.add('drop');
      e.dataTransfer.dropEffect = 'copy';
      return;
    }
    const z = dropZone(t, e, kind);
    e.dataTransfer.dropEffect = z ? (kind === 'pane' ? 'move' : 'copy') : 'none';
    showHint(t, z, kind);
  });
  t.stage.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && t.stage.contains(e.relatedTarget)) return;
    t.stage.querySelector('.drop-hint').classList.remove('on');
    for (const c of t.stage.querySelectorAll('.composer.drop')) c.classList.remove('drop');
  });
  t.stage.addEventListener('drop', async (e) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    if (kind === 'files') {
      for (const c of t.stage.querySelectorAll('.composer.drop')) c.classList.remove('drop');
      let pane = S.panes.get(e.target.closest?.('.pane')?.dataset.pane) || focusedPane();
      if (pane?.isViewer) pane = S.panes.get(pane.sourcePane) || null;
      for (const f of e.dataTransfer.files || []) await pane?.addImageFile?.(f);
      return;
    }
    const z = dropZone(t, e, kind);
    const payload = kind === 'pane' ? e.dataTransfer.getData(DRAG_PANE) : e.dataTransfer.getData(DRAG_SESSION);
    endDrag();
    if (!z) return;
    if (kind === 'session') dropSession(t, z, JSON.parse(payload || 'null'));
    else dropPane(t, z, S.panes.get(payload));
  });
}

/** A session dropped on a stage: split, replace, or fill an empty tab. */
function dropSession(t, z, s) {
  if (!s) return;
  const existing = paneBySession(s.id);
  if (existing) { focusPane(existing); existing.note('This session is already open here.'); return; }
  if (z.where === 'center' && z.pane.isViewer) {
    // Dropped on a viewer: the session takes the viewer's place.
    const v = z.pane;
    const p = createPane({ cwd: s.cwd, title: s.title });
    t.root = L.mapLeaves(t.root, (lf) => (lf.pane === v.id ? L.leaf(p.id) : lf));
    if (t.focused === v.id) t.focused = p.id;
    S.panes.delete(v.id);
    v.destroy();
    layout(t);
    p.open(s, { warm: true });
    focusPane(p);
    save();
    return;
  }
  if (z.where === 'center') {
    if (z.pane.busy) { z.pane.note('This pane is working. Drop the session on an edge to split instead.', 'warn'); return; }
    z.pane.open(s, { warm: true });
    focusPane(z.pane);
    return;
  }
  const base = z.pane || focusedPane();
  const p = createPane({ cwd: s.cwd, title: s.title, model: base?.model, effort: base?.effort, mode: base?.mode });
  t.root = z.where === 'root' ? L.leaf(p.id) : L.insert(t.root, z.pane.id, p.id, z.edge);
  t.focused = p.id;
  layout(t);
  p.open(s, { warm: true });
  focusPane(p);
  save();
}

/** A pane dragged by its grip: move it to an edge, or swap with the pane it was dropped on. */
function dropPane(t, z, moving) {
  if (!moving) return;
  const from = tabOf(moving);
  if (z.where === 'center' && from === t) {
    t.root = L.swap(t.root, moving.id, z.pane.id);
    layout(t);
    save();
    return;
  }
  if (from) from.root = L.remove(from.root, moving.id);
  if (z.where === 'root') t.root = L.leaf(moving.id);
  else if (z.where === 'edge') t.root = L.insert(t.root, z.pane.id, moving.id, z.edge);
  else t.root = L.insert(t.root, z.pane.id, moving.id, 'right');
  t.focused = moving.id;
  if (from && from !== t) {
    if (from.focused === moving.id) from.focused = L.ids(from.root)[0] || null;
    if (!from.root) { S.tabs.splice(S.tabs.indexOf(from), 1); from.stage.remove(); } else layout(from);
  }
  layout(t);
  focusPane(moving);
  save();
}

/** Adds a session to a tab without a drop position: next to its focused pane. */
function addToTab(t, s) {
  if (!t.root) { dropSession(t, { where: 'root' }, s); return; }
  const target = S.panes.get(t.focused) || S.panes.get(L.ids(t.root)[0]);
  if (L.count(t.root) >= L.MAX_PANES) { target?.note(`${L.MAX_PANES} panes is the most per tab; opened in a new tab instead.`, 'warn'); addTab({ session: s }); return; }
  dropSession(t, { where: 'edge', edge: 'right', pane: target }, s);
}

/* ---------- tab bar ---------- */

let hoverTimer = null;

function renderTabs() {
  const bar = $('tabs');
  bar.innerHTML = '';
  for (const t of S.tabs) {
    const panes = L.ids(t.root).map((id) => S.panes.get(id)).filter(Boolean);
    const f = S.panes.get(t.focused) || panes[0];
    const busy = panes.some((p) => p.busy);
    const unread = panes.some((p) => p.unread);
    const tab = el('div', `tab${t.id === S.active ? ' on' : ''}${busy ? ' busy' : ''}${unread ? ' unread' : ''}`);
    tab.title = panes.map((p) => `${p.busy ? 'working: ' : p.unread ? 'finished: ' : ''}${p.title}`).join('\n') || 'Empty tab';
    tab.innerHTML = `<span class="tab-t">${esc(f?.title || 'Empty tab')}</span>${panes.length > 1 ? `<span class="tab-n">${panes.length}</span>` : ''}`;
    const x = el('button', 'tab-x', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>');
    x.title = 'Close tab';
    x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
    tab.append(x);
    tab.onclick = () => switchTab(t);
    tab.onauxclick = (e) => { if (e.button === 1) closeTab(t); };
    tab.addEventListener('dragover', (e) => {
      const kind = dragKind(e);
      if (kind !== 'session' && kind !== 'pane') return;
      e.preventDefault();
      tab.classList.add('drop');
      if (t.id !== S.active && !hoverTimer) hoverTimer = setTimeout(() => { hoverTimer = null; switchTab(t); }, TAB_HOVER_SWITCH_MS);
    });
    tab.addEventListener('dragleave', () => { tab.classList.remove('drop'); clearTimeout(hoverTimer); hoverTimer = null; });
    tab.addEventListener('drop', (e) => {
      const kind = dragKind(e);
      if (kind !== 'session' && kind !== 'pane') return;
      e.preventDefault();
      clearTimeout(hoverTimer); hoverTimer = null;
      const data = e.dataTransfer.getData(kind === 'pane' ? DRAG_PANE : DRAG_SESSION);
      endDrag();
      if (kind === 'session') { switchTab(t); addToTab(t, JSON.parse(data || 'null')); return; }
      const moving = S.panes.get(data);
      if (!moving || tabOf(moving) === t) return;
      if (L.count(t.root) >= L.MAX_PANES) { moving.note(`That tab already has ${L.MAX_PANES} panes.`, 'warn'); return; }
      switchTab(t);
      dropPane(t, t.root ? { where: 'edge', edge: 'right', pane: S.panes.get(t.focused) || S.panes.get(L.ids(t.root)[0]) } : { where: 'root' }, moving);
    });
    bar.append(tab);
  }
  const plus = el('button', 'tab-plus', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>');
  plus.title = 'New tab (Ctrl+T) · drop a session here to open it in a new tab';
  plus.onclick = () => addTab();
  plus.addEventListener('dragover', (e) => { const k = dragKind(e); if (k === 'session' || k === 'pane') { e.preventDefault(); plus.classList.add('drop'); } });
  plus.addEventListener('dragleave', () => plus.classList.remove('drop'));
  plus.addEventListener('drop', (e) => {
    const kind = dragKind(e);
    if (kind !== 'session' && kind !== 'pane') return;
    e.preventDefault();
    const data = e.dataTransfer.getData(kind === 'pane' ? DRAG_PANE : DRAG_SESSION);
    endDrag();
    if (kind === 'session') {
      const s = JSON.parse(data || 'null');
      const existing = s && paneBySession(s.id);
      if (existing) { focusPane(existing); return; }
      addTab({ session: s });
      return;
    }
    const moving = S.panes.get(data);
    if (!moving) return;
    const t = createTab(null);
    dropPane(t, { where: 'root' }, moving);
    switchTab(t);
  });
  bar.append(plus);
  const tools = el('div', 'tabs-tools');
  const t = activeTab();
  const n = L.count(t?.root);
  const gridBtn = el('button', 'tab-tool', '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="5" height="4.5" rx="1"/><rect x="9" y="2.5" width="5" height="4.5" rx="1"/><rect x="2" y="9" width="5" height="4.5" rx="1"/><rect x="9" y="9" width="5" height="4.5" rx="1"/></svg><span>Even grid</span>');
  gridBtn.title = 'Arrange this tab\'s panes into an even grid';
  gridBtn.disabled = n < 2;
  gridBtn.onclick = arrangeGrid;
  tools.append(el('span', 'tab-count', n ? `${n} of ${L.MAX_PANES} panes` : ''), gridBtn);
  bar.append(tools);
  const unread = [...S.panes.values()].filter((p) => p.unread).length;
  const fp = focusedPane();
  document.title = `${unread ? `(${unread}) ` : ''}Myrlin Apaki${fp ? ` · ${fp.title}` : ''}`;
}

/* ---------- rail ---------- */

function viewList() {
  const term = S.sessions.filter((s) => s.terminal).length;
  return [
    { id: 'all', label: 'All', n: S.sessions.length },
    { id: 'terminal', label: 'In terminals', n: term },
  ];
}

/* ---------- folders ---------- */

// Folders (Arthur, 2026-10-09: "very clean and simple and easy to organize,
// move things in and out of"). One folder per session. Drag a session (or a
// pane's grip) onto a folder to move it in, onto All to take it out. Click a
// folder to show it, double-click to rename, the x deletes it (its sessions
// stay). Right-click a session for the same moves.
const folderUI = { creating: false, pendingSession: null, renaming: null };

function moveToFolder(sessionId, folderId) {
  if (!sessionId) return;
  send('folder', { action: 'move', sessionId, folderId: folderId || null });
}

function startNewFolder(sessionId = null) {
  folderUI.creating = true;
  folderUI.pendingSession = sessionId;
  renderFolders();
}

/** Drop handling shared by folder rows, the new-folder row and All. */
function folderDropTarget(node, onSession) {
  node.addEventListener('dragover', (e) => {
    const kind = dragKind(e);
    if (kind !== 'session' && kind !== 'pane') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', (e) => {
    const kind = dragKind(e);
    if (kind !== 'session' && kind !== 'pane') return;
    e.preventDefault();
    node.classList.remove('drop');
    const sid = kind === 'pane' ? S.panes.get(e.dataTransfer.getData(DRAG_PANE))?.sessionId : JSON.parse(e.dataTransfer.getData(DRAG_SESSION) || 'null')?.id;
    endDrag();
    if (sid) onSession(sid);
  });
}

function renderFolders() {
  const box = $('folders');
  box.innerHTML = '';
  const head = el('div', 'sec-head folders-head', `<span class="sec-t">Folders</span><span class="sec-n">${S.folders.length || ''}</span>`);
  const add = el('button', 'folder-add', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>');
  add.title = 'New folder (drop a session here to make one with it)';
  add.onclick = () => startNewFolder();
  folderDropTarget(add, (sid) => startNewFolder(sid));
  head.append(add);
  box.append(head);
  const list = el('ul', 'folder-list');
  if (folderUI.creating) {
    const li = el('li', 'folder-row editing');
    const input = el('input');
    input.placeholder = 'Folder name';
    input.spellcheck = false;
    const done = (ok) => {
      const name = input.value.trim();
      folderUI.creating = false;
      if (ok && name) send('folder', { action: 'create', name, sessionId: folderUI.pendingSession });
      folderUI.pendingSession = null;
      renderFolders();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
    input.onblur = () => done(true);
    li.append(input);
    list.append(li);
    setTimeout(() => input.focus(), 0);
  }
  for (const f of S.folders) {
    const li = el('li', `folder-row${S.view === f.id ? ' on' : ''}`);
    if (folderUI.renaming === f.id) {
      const input = el('input');
      input.value = f.name;
      const done = (ok) => {
        folderUI.renaming = null;
        const name = input.value.trim();
        if (ok && name && name !== f.name) send('folder', { action: 'rename', folderId: f.id, name });
        renderFolders();
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
      input.onblur = () => done(true);
      li.classList.add('editing');
      li.append(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      li.innerHTML = `<svg class="fi" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z"/></svg><span class="fn">${esc(f.name)}</span><span class="count">${f.sessions.length}</span>`;
      const x = el('button', 'folder-x', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>');
      x.title = 'Delete folder (its sessions stay)';
      x.onclick = (e) => {
        e.stopPropagation();
        if (!window.confirm(`Delete folder "${f.name}"? Its ${f.sessions.length} session(s) stay, just without a folder.`)) return;
        send('folder', { action: 'delete', folderId: f.id });
        if (S.view === f.id) S.view = 'all';
      };
      li.append(x);
      li.onclick = () => { S.view = S.view === f.id ? 'all' : f.id; renderRail(); };
      li.ondblclick = () => { folderUI.renaming = f.id; renderFolders(); };
      li.title = 'Click to show · double-click to rename · drop sessions here to move them in';
    }
    folderDropTarget(li, (sid) => moveToFolder(sid, f.id));
    list.append(li);
  }
  if (!S.folders.length && !folderUI.creating) list.append(el('li', 'folder-empty', 'Drag sessions onto + to group them.'));
  box.append(list);
}

/** The folder menu for one session: move into a folder, a new folder, or out. */
function folderMenu(sessionId, anchor) {
  if (!sessionId) return;
  const cur = S.sessions.find((x) => x.id === sessionId)?.folder || null;
  const items = [
    ...S.folders.map((f) => ({ value: f.id, label: f.name, checked: f.id === cur })),
    ...(S.folders.length ? [{ divider: true }] : []),
    { value: '__new', label: 'New folder…' },
    ...(cur ? [{ value: '__out', label: 'Remove from folder' }] : []),
  ];
  menu(anchor, items, {
    above: false,
    width: 200,
    onPick: (v) => {
      if (v === '__new') { startNewFolder(sessionId); return; }
      moveToFolder(sessionId, v === '__out' ? null : v);
    },
  });
}

/** Right-click on a session row. */
function sessionMenu(s, e) {
  e.preventDefault();
  if (s.codex) return;
  const cur = s.folder || null;
  const items = [
    { value: 'here', label: 'Open here' },
    { value: 'tab', label: 'Open in new tab', hint: 'Ctrl+click' },
    { value: 'split', label: 'Split right', hint: 'Shift+click' },
    { divider: true },
    { heading: 'Move to folder' },
    ...S.folders.map((f) => ({ value: `f:${f.id}`, label: f.name, checked: f.id === cur })),
    { value: 'new', label: 'New folder…' },
    ...(cur ? [{ value: 'out', label: 'Remove from folder' }] : []),
  ];
  menu({ x: e.clientX, y: e.clientY }, items, {
    above: false,
    width: 210,
    onPick: (v) => {
      if (v === 'here') openFromRail(s, {});
      else if (v === 'tab') openFromRail(s, { ctrlKey: true });
      else if (v === 'split') openFromRail(s, { shiftKey: true });
      else if (v === 'new') startNewFolder(s.id);
      else if (v === 'out') moveToFolder(s.id, null);
      else if (v.startsWith('f:')) moveToFolder(s.id, v.slice(2));
    },
  });
}

function inView(s) {
  if (S.view === 'all') return true;
  if (S.view === 'terminal') return Boolean(s.terminal);
  const f = S.folders.find((x) => x.id === S.view);
  return Boolean(f && f.sessions.includes(s.id));
}

function renderRail() {
  const views = $('views');
  views.innerHTML = '';
  for (const v of viewList()) {
    const b = el('button', v.id === S.view ? 'on' : '', `${esc(v.label)}<span class="count">${v.n}</span>`);
    b.onclick = () => { S.view = v.id; renderRail(); };
    // Dropping a session on All takes it out of its folder.
    if (v.id === 'all') { b.title = 'Drop a session here to take it out of its folder'; folderDropTarget(b, (sid) => moveToFolder(sid, null)); }
    views.append(b);
  }
  let rows;
  if (S.results) {
    rows = S.results.filter((r) => inView(r.item)).map((r) => ({ ...r.item, kind: r.kind, snippet: r.snippet, hits: r.hits, why: r.why || '', sources: r.sources || null }));
  } else {
    rows = S.sessions.filter(inView).sort((a, b) => (Boolean(b.terminal) - Boolean(a.terminal)) || (b.lastModified - a.lastModified));
  }
  renderFolders();
  const folder = S.folders.find((f) => f.id === S.view);
  $('sessionsTitle').textContent = S.results ? (S.ai ? 'Picks' : 'Results') : folder ? folder.name : S.view === 'terminal' ? 'In terminals' : 'Sessions';
  $('sessionsCount').textContent = String(Math.min(rows.length, 400));
  $('clearView').hidden = !folder;
  $('searchState').textContent = S.results ? S.searchInfo : '';
  $('searchState').hidden = !S.results;
  const list = $('sessions');
  list.innerHTML = '';
  const folderName = (id) => S.folders.find((f) => f.id === id)?.name;
  for (const s of rows.slice(0, 400)) {
    const li = el('li');
    li.dataset.id = s.id;
    const meta = [
      s.codex ? '<span class="codex">codex · read-only</span>' : '',
      s.terminal ? `<span class="live">terminal${s.terminal.status ? ` · ${esc(s.terminal.status)}` : ''}</span>` : '',
      ago(s.lastModified), esc(short(s.cwd)),
      S.view === 'all' && s.folder ? `▸ ${esc(folderName(s.folder) || '')}` : '',
    ].filter(Boolean).join(' · ');
    const byMeaning = s.sources && !s.sources.includes('words');
    const snip = s.snippet ? `<div class="snip">${byMeaning ? '<span class="by-meaning" title="Found by what it is about, not by your words">by meaning</span> ' : ''}${esc(kindLabel(s.kind, s.codex))}: ${highlight(s.snippet, S.query)}${s.hits > 1 ? ` <span class="mono">(${s.hits})</span>` : ''}</div>` : '';
    li.innerHTML = `<div class="t">${esc(s.title || '(untitled)')}</div><div class="m">${meta}</div>${s.why ? `<div class="why">${esc(s.why)}</div>` : snip}`;
    li.onclick = (e) => openFromRail(s, e);
    li.oncontextmenu = (e) => sessionMenu(s, e);
    li.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); openFromRail(s, { ctrlKey: true }); } };
    if (!s.codex) {
      li.draggable = true;
      li.title = 'Click: open here · Ctrl+click: new tab · Shift+click: split right · drag onto a pane edge to split, or onto a folder · right-click for more';
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(DRAG_SESSION, JSON.stringify({ id: s.id, cwd: s.cwd, title: s.title }));
        e.dataTransfer.effectAllowed = 'copyMove';
        S.drag = { kind: 'session', id: s.id };
        document.body.classList.add('dragging');
      });
      li.addEventListener('dragend', endDrag);
    }
    list.append(li);
  }
  if (!rows.length) list.append(el('li', 'note', S.results ? 'Nothing matches in this view.' : 'No sessions here yet.'));
  if (S.results && S.query) {
    const dig = el('button', 'dig', '<b>Dig deeper in a dedicated session</b>Claude searches every transcript with its tools and reports what it finds.');
    dig.onclick = () => digDeeper(S.query);
    const li = el('li', 'dig-row');
    li.append(dig);
    list.append(li);
  }
  renderRailMarks();
}

/** Marks which rail rows are open in a pane, and which one is focused. */
function renderRailMarks() {
  const open = new Set([...S.panes.values()].map((p) => p.sessionId).filter(Boolean));
  const cur = focusedPane()?.sessionId;
  for (const li of $('sessions').children) {
    const id = li.dataset.id;
    li.classList.toggle('on', Boolean(id) && id === cur);
    li.classList.toggle('shown', Boolean(id) && id !== cur && open.has(id));
  }
}

function openFromRail(s, e = {}) {
  if (s.codex) { (focusedPane() || addTab().root && focusedPane())?.open(s, { warm: false }); return; }
  const existing = paneBySession(s.id);
  if (existing) { focusPane(existing); return; }
  if (e.ctrlKey || e.metaKey) { addTab({ session: s }); return; }
  const t = activeTab();
  let p = focusedPane();
  if (e.shiftKey && t?.root) { addToTab(t, s); return; }
  // A viewer is focused: open in the conversation it belongs to, if that is here and free.
  if (p?.isViewer) {
    const src = S.panes.get(p.sourcePane);
    if (src && !src.busy && tabOf(src) === t) p = src;
    else { if (t?.root) addToTab(t, s); else addTab({ session: s }); return; }
  }
  if (!p || p.busy) { addTab({ session: s }); return; }
  p.open(s, { warm: true });
  focusPane(p);
}

let searchTimer = null;
$('q').addEventListener('input', (e) => {
  S.query = e.target.value.trim();
  S.ai = null;
  clearTimeout(searchTimer);
  renderLens();
  if (!S.query) { S.results = null; renderRail(); return; }
  searchTimer = setTimeout(() => send('search', { query: S.query }), SEARCH_DEBOUNCE_MS);
});
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; S.query = ''; S.results = null; S.ai = null; renderLens(); renderRail(); }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && S.query) { e.preventDefault(); askClaude(); }
});

/* ---------- advanced search (Arthur, 2026-10-09) ---------- */

// Three depths, cheapest first:
//   1. As you type (free, local, about a tenth of a second): the keyword
//      index and the meaning index together, so "marketing and growth on
//      forge.myrlin.io" also finds GA4 funnels and landing-page work.
//   2. Ask Claude (Ctrl+Enter, about a cent, a few seconds): Claude turns the
//      question into searches, the local indexes run them, and Claude reads
//      the best candidates and keeps the ones that fit, with a reason each.
//      Billed to the focused pane's account; no session is saved.
//   3. Dig deeper: a dedicated Claude Code session that searches with its
//      own tools; it says so before it opens.
function billingName() {
  return focusedPane()?.billing?.name || S.defaults.billing?.name || 'the live account';
}

function renderLens() {
  const lens = $('lens');
  lens.hidden = !S.query;
  if (!S.query) return;
  const ask = $('ask');
  ask.classList.toggle('busy', Boolean(S.asking));
  ask.querySelector('span').textContent = S.asking ? 'Asking…' : 'Ask Claude';
  ask.title = `Claude turns your question into searches, reads the best matches and keeps the sessions that fit, with a reason for each. Billed to ${billingName()}, about a cent. Ctrl+Enter`;
  const info = $('lensInfo');
  if (S.asking) { info.innerHTML = esc(S.asking); return; }
  if (S.ai) { info.innerHTML = `<b>Claude</b> · ${esc(S.ai.summary)}`; return; }
  const r = S.lastSearch;
  info.innerHTML = r && r.query === S.query ? `<b>${r.n}</b> · ${esc(r.how)} · ${r.ms} ms` : 'Searching…';
}

function askClaude() {
  if (!S.query || S.asking) return;
  S.asking = 'Claude is reading your question…';
  renderLens();
  send('askSearch', { query: S.query, paneId: focusedPane()?.id || null });
}
$('ask').onclick = askClaude;

function digDeeper(query) {
  const who = billingName();
  sheet(`<h2>Dig deeper</h2>
    <p>This opens a <b>dedicated Claude Code session</b> in a new tab. Claude searches every transcript on this PC with its own tools (the index, grep, reading files), follows leads, and reports the sessions that match, with ids you can click to open.</p>
    <p class="note">It runs on Opus 5.5 billed to <b>${esc(who)}</b>, usually a few minutes and between ten cents and a couple of dollars. It is a normal session: keep it, or delete it when you are done. It changes no files.</p>
    <div class="q">Looking for</div><div class="from" style="white-space:normal">${esc(query)}</div>
    <div class="row"><button data-k="x">Cancel</button><button class="primary" data-k="go">Open search session</button></div>`, (root, close) => {
    root.querySelector('[data-k=x]').onclick = close;
    root.querySelector('[data-k=go]').onclick = () => { close(); send('digPrompt', { query, candidates: (S.results || []).slice(0, 15).map((r) => r.item.id) }); };
  });
}

/** Session ids in a reply become links that open the session in a new tab. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
function linkSessions(node) {
  const known = new Map(S.sessions.map((x) => [x.id, x]));
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) { UUID_RE.lastIndex = 0; if (UUID_RE.test(t.nodeValue)) hits.push(t); }
  for (const t of hits) {
    if (t.parentElement?.closest('a, pre')) continue;
    const v = t.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of v.matchAll(UUID_RE)) {
      const s = known.get(m[0]);
      if (!s) continue;
      frag.append(v.slice(last, m.index));
      const a = el('a', 'sess-link', esc(m[0]));
      a.href = '#';
      a.title = `Open "${s.title}" in a new tab`;
      a.onclick = (e) => { e.preventDefault(); openFromRail(s, { ctrlKey: true }); };
      frag.append(a);
      last = m.index + m[0].length;
    }
    if (!last) continue;
    frag.append(v.slice(last));
    t.replaceWith(frag);
  }
}

$('new').onclick = () => newConversation(focusedPane());
$('clearView').onclick = () => { S.view = 'all'; renderRail(); };

function paneFolder(p, v) {
  if (v === '__new') { startNewFolder(p.sessionId); return; }
  send('folder', { action: 'move', sessionId: p.sessionId, folderId: v || null });
}

/** The footer line: meaning-index progress while it builds, else the index state. */
function renderIndexState() {
  const building = /%/.test(S.meaningLine || '');
  $('indexState').textContent = building ? S.meaningLine : [S.indexLine, S.meaningLine].filter(Boolean).join(' · ') || 'Loading…';
}

/* ---------- sound ---------- */

function renderSound() {
  const b = $('sound');
  b.textContent = soundOn() ? 'Ding on' : 'Ding off';
  b.classList.toggle('off', !soundOn());
}
$('sound').onclick = () => { setSoundOn(!soundOn()); renderSound(); if (soundOn()) ding('done'); };

/* ---------- theme (theme.js sets it before first paint) ---------- */

const THEME_UI = {
  auto: { label: 'Auto', next: 'light', icon: '<circle cx="8" cy="8" r="5.5"/><path class="i-fill" d="M8 2.5a5.5 5.5 0 0 1 0 11z"/>' },
  light: { label: 'Light', next: 'dark', icon: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>' },
  dark: { label: 'Dark', next: 'auto', icon: '<path class="i-fill" d="M12.8 10.2A5.6 5.6 0 0 1 5.8 3.2a5.6 5.6 0 1 0 7 7z"/>' },
};
function renderTheme() {
  const t = window.apakiTheme;
  const b = $('theme');
  if (!t) { b.hidden = true; return; }
  const ui = THEME_UI[t.get()];
  b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ui.icon}</svg>${ui.label}`;
  b.title = t.get() === 'auto' ? `Theme follows Windows (now ${t.effective()}). Click for ${THEME_UI[ui.next].label.toLowerCase()}.` : `${ui.label} theme. Click for ${THEME_UI[ui.next].label.toLowerCase()}.`;
}
$('theme').onclick = () => window.apakiTheme.set(THEME_UI[window.apakiTheme.get()].next);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderTheme);
window.addEventListener('apaki-theme', renderTheme);
// The webview plays sound only after a user gesture: arm on the first one.
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, arm, { capture: true });
window.addEventListener('resize', closeMenu);

/** A pane came back (turn finished) or needs an answer: ding, and mark it if you are not looking at it. */
function cameBack(p, kind) {
  ding(kind);
  const watching = document.hasFocus() && activeTab() === tabOf(p) && focusedPane() === p;
  if (!watching) { p.unread = true; p.el.classList.add('unread'); }
  renderTabs();
}

/* ---------- voice (local Whisper) ---------- */

// Click a pane's mic to start, click again to stop (2 minutes at most). One
// recording at a time; the text lands in the message box of the pane that
// recorded it. Audio is 16 kHz mono WAV, transcribed on this PC by whisper.cpp.
const VOICE_MAX_MS = 120000;
let rec = null;

function wavFrom(chunks, rate) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 0x7fff, true);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function startVoice(pane) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); } catch (e) { pane.note(`Microphone unavailable: ${e.message}`, 'error'); return; }
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  proc.onaudioprocess = (ev) => chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(ctx.destination);
  const started = Date.now();
  rec = { pane, stream, ctx, proc, chunks, started, timer: setInterval(() => { pane.setStatus(`Listening · ${Math.round((Date.now() - started) / 1000)}s · click the mic to stop`); if (Date.now() - started > VOICE_MAX_MS) stopVoice(); }, 250) };
  pane.$.mic.classList.add('rec');
}

function stopVoice(discard = false) {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearInterval(r.timer);
  r.pane.$.mic.classList.remove('rec');
  r.proc.disconnect();
  r.stream.getTracks().forEach((t) => t.stop());
  const rate = r.ctx.sampleRate;
  r.ctx.close();
  if (discard || !r.chunks.length) { r.pane.setStatus(''); return; }
  r.pane.setStatus('Transcribing…');
  send('transcribe', { paneId: r.pane.id, wav: wavFrom(r.chunks, rate) });
}

function toggleVoice(pane) {
  if (rec) { const same = rec.pane === pane; stopVoice(); if (same) return; }
  startVoice(pane);
}

/* ---------- paste ---------- */

document.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile());
  if (!files.length) return;
  e.preventDefault();
  let pane = S.panes.get(document.activeElement?.closest?.('.pane')?.dataset.pane) || focusedPane();
  if (pane?.isViewer) pane = S.panes.get(pane.sourcePane) || null;
  for (const f of files) await pane?.addImageFile?.(f);
});
// Files dropped outside a pane must not navigate the window away.
document.addEventListener('dragover', (e) => { if (dragKind(e) === 'files') e.preventDefault(); });
document.addEventListener('drop', (e) => { if (dragKind(e) === 'files') e.preventDefault(); });

/* ---------- keyboard ---------- */

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 't') { e.preventDefault(); addTab(); return; }
  if (k === 'w') { e.preventDefault(); const p = focusedPane(); if (p) closePane(p); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    const i = S.tabs.indexOf(activeTab());
    switchTab(S.tabs[(i + (e.shiftKey ? -1 : 1) + S.tabs.length) % S.tabs.length]);
    focusPane(focusedPane());
    return;
  }
  if (/^[1-6]$/.test(e.key)) {
    const id = L.ids(activeTab()?.root)[Number(e.key) - 1];
    if (id) { e.preventDefault(); focusPane(S.panes.get(id)); }
  }
});

/* ---------- sheets (questions, plan approval, billing), one at a time ---------- */

const sheetQueue = [];
let sheetOpen = false;

function sheet(html, wire) {
  if (sheetOpen) { sheetQueue.push([html, wire]); return; }
  sheetOpen = true;
  $('sheet').innerHTML = html;
  $('scrim').hidden = false;
  wire($('sheet'), () => {
    $('scrim').hidden = true;
    sheetOpen = false;
    const next = sheetQueue.shift();
    if (next) sheet(...next);
  });
}

function askSheet(e) {
  const input = e.input || {};
  const pane = S.panes.get(e.paneId);
  const from = pane ? `<div class="from">${esc(pane.title)}</div>` : '';
  const reply = (result) => send('answer', { askId: e.askId, result });
  if (e.toolName === 'ExitPlanMode') {
    sheet(`${from}<h2>Ready to code?</h2><div class="turn-assistant plan">${md(input.plan || '')}</div>
      <div class="row"><button data-k="keep">Keep planning</button><button class="primary" data-k="go">Approve</button></div>`, (root, close) => {
      root.querySelector('[data-k=go]').onclick = () => { close(); reply({ behavior: 'allow', updatedInput: input }); if (pane?.mode === 'plan') pane.setMode('bypassPermissions'); };
      root.querySelector('[data-k=keep]').onclick = () => { close(); reply({ behavior: 'deny', message: 'The user wants to keep planning.' }); };
    });
    return;
  }
  const qs = input.questions || [];
  const picks = qs.map(() => new Set());
  const html = `${from}<h2>Claude has ${qs.length === 1 ? 'a question' : `${qs.length} questions`}</h2>${qs.map((q, qi) => `
    <div class="q">${esc(q.question)}</div>
    ${(q.options || []).map((o, oi) => `<button class="opt" data-q="${qi}" data-o="${oi}">${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`).join('')}
    <input type="text" data-other="${qi}" placeholder="Or type your own answer">`).join('')}
    <div class="row"><button data-k="skip">Skip</button><button class="primary" data-k="ok">Answer</button></div>`;
  sheet(html, (root, close) => {
    root.querySelectorAll('.opt').forEach((b) => {
      b.onclick = () => {
        const qi = Number(b.dataset.q);
        const oi = Number(b.dataset.o);
        if (!qs[qi].multiSelect) { picks[qi].clear(); root.querySelectorAll(`.opt[data-q="${qi}"]`).forEach((x) => x.classList.remove('on')); }
        if (picks[qi].has(oi)) picks[qi].delete(oi); else picks[qi].add(oi);
        b.classList.toggle('on', picks[qi].has(oi));
      };
    });
    root.querySelector('[data-k=ok]').onclick = () => {
      const answers = {};
      qs.forEach((q, qi) => {
        const other = root.querySelector(`[data-other="${qi}"]`).value.trim();
        answers[q.question] = other || [...picks[qi]].map((oi) => q.options[oi].label).join(', ');
      });
      close();
      reply({ behavior: 'allow', updatedInput: { ...input, answers } });
    };
    root.querySelector('[data-k=skip]').onclick = () => { close(); reply({ behavior: 'deny', message: 'The user skipped the question.' }); };
  });
}

function billingSheet(options, paneId) {
  const pane = S.panes.get(paneId);
  const html = `${pane ? `<div class="from">${esc(pane.title)}</div>` : ''}<h2>Billing</h2><div class="note">Following Glass moves this conversation whenever Glass switches Claude between Platform credits and a subscription.</div>
    ${options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o.label)}</button>`).join('')}
    <div class="row"><button data-k="x">Cancel</button></div>`;
  sheet(html, (root, close) => {
    root.querySelectorAll('.opt').forEach((b) => { b.onclick = () => { close(); send('billing', { paneId, value: options[Number(b.dataset.i)].value }); }; });
    root.querySelector('[data-k=x]').onclick = close;
  });
}

/* ---------- saving and restoring the workspace ---------- */

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tabs = S.tabs.map((t) => ({
      focused: t.focused,
      root: L.mapLeaves(t.root, (lf) => {
        const p = S.panes.get(lf.pane);
        if (p?.isViewer) return { type: 'leaf', pane: lf.pane, view: p.saved() };
        return { type: 'leaf', pane: lf.pane, s: p?.sessionId || null, cwd: p?.cwd || '', title: p?.title || '', model: p?.model, effort: p?.effort, mode: p?.mode };
      }),
    }));
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 1, active: S.tabs.findIndex((t) => t.id === S.active), tabs })); } catch { /* not saved */ }
  }, 250);
}

function restore() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { saved = null; }
  const tabs = saved?.v === 1 && Array.isArray(saved.tabs) ? saved.tabs : [];
  for (const st of tabs) {
    const seen = new Set();
    const root = L.mapLeaves(st.root, (lf) => {
      // A viewer comes back showing its artifact's latest revision.
      if (lf.view?.id) return L.leaf(createViewer(lf.view, lf.pane).id);
      // One session per pane, ever: a duplicate in old saved state opens as a new conversation.
      const sid = lf.s && !seen.has(lf.s) ? lf.s : null;
      if (sid) seen.add(sid);
      // The session id is set at once so a save before the engine answers keeps it.
      const p = createPane({ id: lf.pane, sessionId: sid, cwd: lf.cwd, title: lf.title, model: lf.model, effort: lf.effort, mode: lf.mode });
      p.open(sid ? { id: sid, cwd: lf.cwd, title: lf.title } : null, { warm: false });
      return L.leaf(p.id);
    });
    if (!root || !L.valid(root)) continue;
    const t = createTab(root);
    t.focused = L.has(root, st.focused) ? st.focused : L.ids(root)[0];
    layout(t);
  }
  if (!S.tabs.length) { addTab(); return; }
  switchTab(S.tabs[Math.min(Math.max(0, saved?.active ?? 0), S.tabs.length - 1)]);
  focusPane(focusedPane());
}

/* ---------- engine events ---------- */

const PANE_EVENTS = new Set(['locked', 'taken_over', 'opened', 'history', 'session_id', 'sdk', 'result', 'billing', 'commands', 'note', 'error', 'transcript', 'settings', 'artifactContent']);

// Registered before anything is sent: `listen` is async, and events that
// arrive before it resolves are lost (a reload lost restored panes' opens).
await listen('engine', ({ payload: e }) => {
  // Something Claude showed: a card in its conversation, and the viewer beside it.
  if (e.ev === 'artifact' || e.ev === 'openUrl') {
    const p = S.panes.get(e.paneId);
    p?.handle(e);
    if (e.ev === 'artifact') openViewer({ ...e, sourcePane: e.paneId }, { auto: true });
    // openUrl: the built-in browser takes these over; until then the card's button opens the system browser.
    return;
  }
  if (e.paneId && PANE_EVENTS.has(e.ev)) {
    const p = S.panes.get(e.paneId);
    if (!p) return; // a pane closed while its event was on the way
    p.handle(e);
    if (e.ev === 'result') cameBack(p, 'done');
    if (e.ev === 'taken_over') cameBack(p, 'ask');
    if (e.ev === 'opened' || e.ev === 'session_id') { p.renderFolderSelect(S.folders, S.sessions); renderTabs(); renderRailMarks(); save(); }
    return;
  }
  switch (e.ev) {
    case 'ready':
      S.voice = Boolean(e.voice);
      S.defaults.billing = e.billing;
      for (const p of S.panes.values()) p.setVoice(S.voice);
      // The engine restarted: every pane lost its Claude Code process. Reopen
      // each one (without starting Claude Code until its next message).
      if (S.engineLost) {
        S.engineLost = false;
        for (const p of S.panes.values()) {
          // Viewers load again from the new engine's server address.
          if (p.isViewer) { p.engineBack(); continue; }
          p.open(p.sessionId ? { id: p.sessionId, cwd: p.cwd, title: p.title } : null, { warm: false });
        }
      }
      send('sessions');
      break;
    case 'index':
      S.indexLine = e.ok ? `Words index up to date · ${e.stats?.blocks_added ?? 0} new · ${(e.ms / 1000).toFixed(1)}s` : 'Conversation index unavailable; search uses titles only.';
      renderIndexState();
      break;
    case 'meaning':
      // The meaning index (embeddings): its first build takes a few minutes on the GPU.
      if (e.stage === 'loading') S.meaningLine = 'Meaning index: loading the model…';
      else if (e.stage === 'embedding' && e.total) S.meaningLine = e.total > 200 ? `Meaning index ${Math.round((e.done / e.total) * 100)}% · ${e.done.toLocaleString()} of ${e.total.toLocaleString()} passages · ${e.device === 'gpu' ? 'GPU' : 'CPU'}` : '';
      else if (e.stage === 'ready') S.meaningLine = e.result?.ok ? `Meaning index ready · ${(e.result.passages || 0).toLocaleString()} passages` : 'Meaning index unavailable; searching by words';
      renderIndexState();
      break;
    case 'sessions':
      if (e.voice !== undefined) { S.voice = Boolean(e.voice); for (const p of S.panes.values()) p.setVoice(S.voice); }
      S.sessions = e.items; S.folders = e.folders;
      if (e.billing) S.defaults.billing = S.defaults.billing || e.billing;
      for (const p of S.panes.values()) {
        p.renderFolderSelect(S.folders, S.sessions);
        const s = p.sessionId && S.sessions.find((x) => x.id === p.sessionId);
        if (s?.title && p.title === 'New conversation') { p.setTitle(s.title); renderTabs(); }
      }
      renderRail();
      break;
    case 'folders':
      S.folders = e.folders;
      if (S.view !== 'all' && S.view !== 'terminal' && !S.folders.some((f) => f.id === S.view)) S.view = 'all';
      send('sessions');
      break;
    case 'search':
      if (e.query !== S.query || S.ai) break;
      S.results = e.results;
      S.searchTerms = e.terms || null;
      S.lastSearch = { query: e.query, n: e.results.length, ms: e.elapsed, how: e.semantic ? 'words + meaning' : e.deep ? 'words' : 'titles only' };
      S.searchInfo = e.deep ? `Every conversation, subagent and Codex session${e.semantic ? ', matched by words and by meaning' : ''}. Not it? Ask Claude (Ctrl+Enter).` : 'The conversation index is unavailable; matching titles only.';
      renderLens();
      renderRail();
      break;
    case 'askProgress':
      if (e.query !== S.query) break;
      S.asking = e.text;
      renderLens();
      break;
    case 'askSearch':
      if (e.query !== S.query) break;
      S.asking = null;
      if (e.error) { S.ai = null; renderLens(); $('lensInfo').innerHTML = `<b>Claude</b> · ${esc(e.error)}`; break; }
      S.searchTerms = [...(S.searchTerms || []), ...(e.terms || [])];
      S.ai = { summary: `${e.results.length} of ${e.considered} fit · ${e.model} on ${e.billing} · ${(e.ms / 1000).toFixed(1)} s${e.cost != null ? ` · $${e.cost.toFixed(3)}` : ''}` };
      S.results = e.results;
      S.searchInfo = e.note || (e.terms?.length ? `Searched for: ${e.terms.join(' · ')}` : '');
      renderLens();
      renderRail();
      break;
    case 'digReady': {
      // A dedicated search session: a new tab, its first message already written and sent.
      const t = addTab();
      const p = S.panes.get(t.focused);
      if (p) { p.$.input.value = e.prompt; p.autosize(); p.submit(); }
      break;
    }
    case 'open_elsewhere': {
      const p = S.panes.get(e.paneId);
      const other = S.panes.get(e.otherPane);
      if (other) focusPane(other);
      p?.note('That session is already open in another pane.', 'warn');
      break;
    }
    case 'ask': {
      const p = S.panes.get(e.paneId);
      if (p) cameBack(p, 'ask');
      askSheet(e);
      break;
    }
    case 'billingOptions': billingSheet(e.options, e.paneId); break;
    case 'glass': {
      // What Myrlin Glass has Claude Code on right now; updates the moment Glass swaps.
      const g = $('glassState');
      g.innerHTML = e.installed ? `<span class="gl">Glass</span>${esc(e.name)}${e.headroom != null ? `<span class="gh">${Math.round(e.headroom)}% left</span>` : ''}` : '<span class="gl">Glass</span>not installed';
      if (e.changed) { g.classList.remove('flash'); void g.offsetWidth; g.classList.add('flash'); }
      break;
    }
    case 'closed': break;
    case 'note': focusedPane()?.note(e.text, e.tone || ''); break;
    case 'error': focusedPane()?.note(e.message, 'error'); break;
    case 'engine_exit':
      S.engineLost = true;
      for (const p of S.panes.values()) p.engineLost();
      focusedPane()?.note('The engine stopped and is restarting…', 'warn');
      break;
    default: break;
  }
});

/* ---------- window buttons (the OS title bar is off) ---------- */

// Arthur, 2026-10-09: the title bar "needs to not be a separate section -
// should seamlessly be a part of the application". The brand row and the tab
// row are the top of the window (data-tauri-drag-region on their empty space:
// drag moves, double-click maximizes); these are its three buttons.
{
  const win = window.__TAURI__.window.getCurrentWindow();
  const box = $('winctl');
  box.querySelector('[data-w=min]').onclick = () => win.minimize();
  box.querySelector('[data-w=max]').onclick = () => win.toggleMaximize();
  box.querySelector('[data-w=close]').onclick = () => win.close();
  const syncMax = async () => {
    const max = await win.isMaximized().catch(() => false);
    document.body.classList.toggle('maximized', max);
    box.querySelector('[data-w=max]').title = max ? 'Restore' : 'Maximize';
  };
  win.onResized(syncMax);
  syncMax();
}

/* ---------- start ---------- */

renderSound();
renderTheme();
restore();
renderTabs();
// Ask the engine for its state in case it was ready before this page loaded.
send('sessions');
// Sessions open in terminals change on their own: refresh the list now and then.
setInterval(() => { if (![...S.panes.values()].some((p) => p.busy) && !S.query && !S.drag) send('sessions'); }, 15000);

// For apaki/scripts/cdp-check.mjs: the live state, read only.
window.__apaki = { S, L, focusedPane, activeTab, addTab, arrangeGrid, openViewer, viewers, dropSession: (s, edge) => { const t = activeTab(); const target = focusedPane(); dropSession(t, target ? { where: edge === 'center' ? 'center' : 'edge', edge, pane: target } : { where: 'root' }, s); } };
