/**
 * startfolder.js
 *
 * The "Start this conversation in" sheet. Arthur, 2026-10-09: a new
 * conversation starts in the home folder (where a terminal opens); this sheet
 * lets him pick another one from his recent and most used session folders
 * (Claude Code and Codex), browse to any folder on disk, or create one.
 *
 * The engine answers three requests: places (the two lists), listDir (one
 * folder's subfolders, drives, parent) and mkdir (creates one folder, then
 * answers with its listing). See src/places.js.
 *
 * Usage: const ui = folderSheet(pane, { sheet, send, esc, ago }); route the
 * engine's 'places' and 'dir' events to ui.places(e) / ui.dir(e) while it is
 * open (ui.isOpen()).
 */

const shortPath = (p) => String(p || '').replace(/^C:\\Users\\[^\\]+/i, '~');
const SEP = '\\';

export function folderSheet(pane, { sheet, send, esc, ago }) {
  const state = { open: false, cur: null, showHidden: false, root: null, close: null };
  const e$ = (s) => esc(String(s ?? ''));

  const html = `<div class="from">${e$(pane.title)}</div><h2>Start this conversation in</h2>
    <div class="note">Claude Code works in this folder: its CLAUDE.md, settings and relative paths come from here. The folder is fixed once you send the first message.</div>
    <form class="path-go"><input type="text" class="path-in" spellcheck="false" placeholder="Type or paste a folder path"><button type="submit">Go</button></form>
    <div class="places">
      <div class="pl-col"><div class="pl-h">Recent</div><div class="pl-recent"><div class="pl-wait">Loading…</div></div></div>
      <div class="pl-col"><div class="pl-h">Most used</div><div class="pl-used"><div class="pl-wait">Loading…</div></div></div>
    </div>
    <div class="browse">
      <div class="br-top"><div class="crumbs"></div><div class="drives"></div></div>
      <div class="br-list"><div class="pl-wait">Loading…</div></div>
      <div class="br-tools">
        <label class="br-hidden"><input type="checkbox"> Show hidden</label>
        <form class="br-new"><input type="text" placeholder="New folder here" spellcheck="false"><button type="submit">Create</button></form>
      </div>
      <div class="br-err" hidden></div>
    </div>
    <div class="row"><button data-k="x">Cancel</button><button data-k="home">Home</button><button class="primary" data-k="here">Start here</button></div>`;

  const q = (s) => state.root.querySelector(s);
  const go = (p) => send('listDir', { path: p });
  const done = () => { state.open = false; state.close?.(); };
  const pick = (dir) => { done(); pane.setStartFolder(dir); };

  const placeRow = (f) => {
    const meta = [f.claude ? `Claude ${f.claude}` : '', f.codex ? `Codex ${f.codex}` : '', f.last ? ago(f.last) : ''].filter(Boolean);
    return `<button class="opt pl" data-path="${e$(f.path)}" title="${e$(f.path)}"><b>${e$(f.name)}</b><small>${e$(shortPath(f.path))}</small><span class="pl-meta">${meta.map((m) => `<span>${e$(m)}</span>`).join('')}</span></button>`;
  };

  const fillList = (box, list) => {
    box.innerHTML = list.length ? list.map(placeRow).join('') : '<div class="pl-wait">None yet</div>';
    box.querySelectorAll('.pl').forEach((b) => { b.onclick = () => pick(b.dataset.path); });
  };

  const render = () => {
    const cur = state.cur;
    if (!cur) return;
    const parts = cur.path.split(/[\\/]/).filter(Boolean);
    const crumbs = q('.crumbs');
    crumbs.innerHTML = parts.map((p, i) => `<button data-i="${i}">${e$(p)}</button>`).join('<span class="sep">›</span>');
    crumbs.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        let p = parts.slice(0, Number(b.dataset.i) + 1).join(SEP);
        if (/^[A-Za-z]:$/.test(p)) p += SEP;
        go(p);
      };
    });
    const drives = q('.drives');
    drives.innerHTML = (cur.drives || []).map((d) => `<button data-d="${e$(d)}">${e$(d.replace(/[\\/]$/, ''))}</button>`).join('');
    drives.querySelectorAll('button').forEach((b) => { b.onclick = () => go(b.dataset.d); });
    const dirs = (cur.dirs || []).filter((d) => state.showHidden || !d.hidden);
    const list = q('.br-list');
    list.innerHTML = (cur.parent ? '<button class="br-d br-up" title="Up one folder">..</button>' : '')
      + dirs.map((d) => `<button class="br-d${d.hidden ? ' hid' : ''}" data-n="${e$(d.name)}">${e$(d.name)}</button>`).join('')
      + (dirs.length ? '' : `<div class="pl-wait">${cur.error ? '' : 'No folders here'}</div>`);
    list.querySelector('.br-up')?.addEventListener('click', () => go(cur.parent));
    list.querySelectorAll('.br-d[data-n]').forEach((b) => {
      b.onclick = () => go(`${cur.path.replace(/[\\/]+$/, '')}${SEP}${b.dataset.n}`);
    });
    q('.path-in').value = cur.path;
    const here = q('[data-k=here]');
    here.disabled = Boolean(cur.error);
    here.title = `Start in ${cur.path}`;
  };

  sheet(html, (root, close) => {
    state.root = root;
    state.close = close;
    state.open = true;
    q('.path-go').onsubmit = (ev) => { ev.preventDefault(); const v = q('.path-in').value.trim(); if (v) go(v); };
    q('.br-hidden input').onchange = (ev) => { state.showHidden = ev.target.checked; render(); };
    q('.br-new').onsubmit = (ev) => {
      ev.preventDefault();
      const name = q('.br-new input').value.trim();
      if (name && state.cur && !state.cur.error) send('mkdir', { path: state.cur.path, name });
    };
    q('[data-k=x]').onclick = done;
    q('[data-k=home]').onclick = () => pick('');
    q('[data-k=here]').onclick = () => { if (state.cur && !state.cur.error) pick(state.cur.path); };
    send('places');
    go(pane.cwd || '');
  });

  return {
    isOpen: () => state.open,
    places(e) {
      if (!state.open) return;
      fillList(q('.pl-recent'), e.recent || []);
      fillList(q('.pl-used'), e.used || []);
      q('[data-k=home]').title = `Start in ${e.home}`;
    },
    dir(e) {
      if (!state.open) return;
      if (e.created) q('.br-new input').value = '';
      // A path that could not be read keeps the last good listing on screen.
      if (!e.error || !state.cur) state.cur = e;
      const err = q('.br-err');
      // A listing error names the folder it could not open; a create error is about the name.
      err.textContent = !e.error ? '' : e.kind === 'mkdir' ? e.error : `${e.path}: ${e.error}`;
      err.hidden = !e.error;
      render();
    },
  };
}
