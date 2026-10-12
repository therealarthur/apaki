/**
 * diff.js: the diff viewer pane (2026-10-12; "View changes" in a worktree's menu, WORKTREES.md build order step 2).
 * Arthur: Codex and Claude's own apps show a review pane for what an agent changed; this is Apaki's, and it opens
 * the same way on the phone page (apaki/ui is shared), where it fills the screen like any viewer.
 *
 * It is a viewer pane (isViewer, like the task and artifact viewers: app.js lays it out, saves it and restores it
 * with the tab). The engine reads the changes (op worktreeDiff, read only): everything since the branch left its
 * base plus what is not committed yet and new files, or only what is not committed. Each file folds open to its
 * patch, drawn with the same colours as the diffs inside a conversation; a big file is cut and says so.
 *
 * It follows the worktree: when the engine reports different numbers for the folder (a commit, an edit, a turn
 * that ended) the pane reads again, so it never shows what is no longer true.
 */

import { esc } from './markdown.js';
import { branchName, patchHtml, plusMinus, statusWord } from './worktree.js';

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ICON_REFRESH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7M13.2 2.6v2.9h-2.9"/></svg>';
/** Files whose patch opens by themselves, and the largest patch that does. */
const OPEN_FILES = 3;
const OPEN_BYTES = 24 * 1024;

/** A file's path as a quiet folder and a name that leads. */
export function splitPath(p) {
  const s = String(p ?? '');
  const i = s.lastIndexOf('/');
  return i < 0 ? { dir: '', name: s } : { dir: s.slice(0, i + 1), name: s.slice(i + 1) };
}

/** What the numbers of a worktree say, so the pane reads again only when they changed. */
export const numbersOf = (wt) => (wt ? [wt.added, wt.removed, wt.files, wt.changed, wt.ahead, wt.head].join('|') : '');

export class DiffPane {
  constructor(id, host, spec = {}) {
    this.id = id;
    this.host = host;
    this.isViewer = true;
    this.isDiff = true;
    this.art = {}; // not an artifact viewer (app.js looks artifacts up by art.id)
    this.spec = { scope: 'base', ...spec };
    this.sessionId = null;
    this.cwd = spec.path || '';
    this.busy = false;
    this.unread = false;
    this.sourcePane = spec.ownerPane || null;
    this.title = 'Changes';
    this.seq = 0;
    this.data = null;
    this.numbers = '';
    this.el = el('section', 'pane viewer diff-viewer');
    this.el.dataset.pane = id;
    this.el.innerHTML = `
      <header class="pane-bar">
        <span class="grip" draggable="true" title="Drag to move this viewer">
          <svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="7" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="7" cy="13" r="1.2"/></svg>
        </span>
        <div class="title-block">
          <h2 class="title"></h2>
          <div class="meta-line"><span class="cwd df-meta"></span></div>
        </div>
        <button class="icon-btn close" title="Close viewer (Ctrl+W)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
      </header>
      <div class="ground df-ground"><div class="df-body"></div></div>`;
    const q = (s) => this.el.querySelector(s);
    this.$ = { title: q('.title'), meta: q('.df-meta'), body: q('.df-body'), ground: q('.df-ground'), grip: q('.grip'), close: q('.close'), input: null };
    this.el.addEventListener('pointerdown', () => host.focus(this), true);
    this.$.close.onclick = () => host.close(this);
    this.$.grip.addEventListener('dragstart', (e) => host.dragPane(this, e));
    this.$.grip.addEventListener('dragend', () => host.dragEnd());
    this.renderHead();
    this.$.body.innerHTML = '<div class="art-loading"><i></i><i></i><i></i></div>';
    this.load();
  }

  /** The pane's title: the branch it shows, and what it is compared with. */
  renderHead() {
    const s = this.spec;
    const d = this.data;
    this.title = s.branch ? `Changes in ${s.branch}` : 'Changes';
    this.$.title.textContent = this.title;
    this.$.title.title = this.title;
    const bits = [];
    if (s.repo) bits.push(s.repo);
    if (d?.ok) {
      bits.push(d.scope === 'head' ? 'not committed yet' : `since ${s.base || d.base || 'its base'}`);
      bits.push(plusMinus(d.added, d.removed) || 'no lines changed');
      bits.push(plural(d.files.length, 'file'));
    }
    this.$.meta.textContent = bits.join('  ·  ');
  }

  /** Reads the changes from the engine (and again whenever it is asked to). */
  async load() {
    const mine = ++this.seq;
    const r = await this.host.wt.ask('worktreeDiff', { path: this.spec.path, scope: this.spec.scope });
    if (mine !== this.seq || this.dead) return;
    this.data = r;
    const f = this.host.wt.forCwd(this.spec.path);
    this.numbers = numbersOf(f?.wt);
    if (f?.wt) { this.spec.branch = branchName(f.wt); this.spec.base = f.wt.base || this.spec.base; }
    this.renderHead();
    this.render();
  }

  /** The engine sent new numbers for the worktrees: read again if this one's changed. */
  repoChanged() {
    if (this.dead) return;
    const f = this.host.wt.forCwd(this.spec.path);
    const now = numbersOf(f?.wt);
    if (!f?.wt || now === this.numbers) return;
    this.numbers = now;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.load(), 400);
  }

  render() {
    const d = this.data;
    const body = this.$.body;
    const top = this.$.ground.scrollTop;
    const f = this.host.wt.forCwd(this.spec.path);
    const scope = this.spec.scope === 'head' ? 'head' : 'base';
    const dirty = Boolean(f?.wt?.changed);
    const bar = `<div class="df-bar">
        <div class="seg" role="radiogroup" aria-label="Which changes">
          <button type="button" role="radio" aria-checked="${scope === 'base'}" class="${scope === 'base' ? 'on' : ''}" data-scope="base">All changes</button>
          <button type="button" role="radio" aria-checked="${scope === 'head'}" class="${scope === 'head' ? 'on' : ''}" data-scope="head">Not committed</button>
        </div>
        <span class="df-gap"></span>
        <button type="button" class="df-btn" data-k="commit"${dirty ? '' : ' disabled'} title="${dirty ? 'Commit what has not been committed' : 'Nothing to commit'}">Commit…</button>
        <button type="button" class="icon-btn df-refresh" data-k="refresh" title="Read the changes again" aria-label="Read the changes again">${ICON_REFRESH}</button>
      </div>`;
    if (!d || d.ok === false) {
      body.innerHTML = `${bar}<div class="df-empty"><b>Could not read the changes</b><span>${esc(d?.error || 'The PC did not answer.')}</span></div>`;
    } else if (!d.files.length) {
      body.innerHTML = `${bar}<div class="df-empty"><b>No changes</b><span>${scope === 'head' ? 'Everything in this worktree is committed.' : `This branch has nothing that ${esc(this.spec.base || d.base || 'its base')} does not have.`}</span></div>`;
    } else {
      const open = d.files.filter((x) => x.patch && x.patch.length <= OPEN_BYTES).slice(0, OPEN_FILES).map((x) => x.path);
      const rows = d.files.map((x, i) => {
        const { dir, name } = splitPath(x.path);
        const n = x.binary ? 'binary' : esc(plusMinus(x.added, x.removed));
        return `<details class="df-file" data-i="${i}"${open.includes(x.path) ? ' open' : ''}><summary><span class="df-s">${esc(statusWord(x.untracked ? 'A' : x.status))}</span><span class="df-p"><span class="df-d">${esc(dir)}</span>${esc(name)}</span><span class="df-n">${n}</span></summary><div class="df-patch"></div></details>`;
      }).join('');
      body.innerHTML = `${bar}<div class="df-files">${rows}</div>${d.truncated ? '<div class="df-note">Some files are too big to show here in full; their counts above are whole.</div>' : ''}`;
      for (const det of body.querySelectorAll('.df-file')) {
        const fill = () => {
          const box = det.querySelector('.df-patch');
          if (box.dataset.done) return;
          box.dataset.done = '1';
          const x = d.files[Number(det.dataset.i)];
          box.innerHTML = x.patch ? `${patchHtml(x.patch)}${x.cut ? '<div class="df-note">The patch is cut here; it is longer.</div>' : ''}` : '<div class="df-note">Too large to show here. Open the file in your editor.</div>';
        };
        if (det.open) fill();
        det.addEventListener('toggle', () => { if (det.open) fill(); });
      }
    }
    body.querySelectorAll('[data-scope]').forEach((b) => {
      b.onclick = () => { if (this.spec.scope === b.dataset.scope) return; this.spec.scope = b.dataset.scope; this.host.changed?.(this); this.load(); };
    });
    body.querySelector('[data-k=refresh]').onclick = () => this.load();
    body.querySelector('[data-k=commit]').onclick = async () => {
      const r = await this.host.wt.actionSheet({ kind: 'commit', path: this.spec.path, from: `${this.spec.branch || ''}${this.spec.repo ? ` · ${this.spec.repo}` : ''}` });
      if (r?.ok) this.load();
    };
    this.$.ground.scrollTop = top;
  }

  /** What the saved workspace keeps (app.js snapshot). */
  saved() {
    return { diff: { path: this.spec.path, scope: this.spec.scope, branch: this.spec.branch, repo: this.spec.repo, base: this.spec.base } };
  }

  // The pane interface app.js uses.
  engineBack() { this.load(); }
  note() {}
  engineLost() {}
  setVoice() {}
  renderFolderSelect() {}
  open() {}

  destroy() {
    this.dead = true;
    clearTimeout(this.reloadTimer);
    this.el.remove();
  }
}

let diffSeq = 0;
export const newDiffViewerId = () => `df${Date.now().toString(36)}${(++diffSeq).toString(36)}`;
