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
 *
 * Worktrees (2026-10-12, apaki/remote/WORKTREES.md): with `wt` (worktree.js initWorktrees) the sheet opens on a
 * switch, This folder or New worktree. New worktree picks a repository and a base branch; the pane then starts in a
 * worktree it makes on its first message (Pane.setPendingWorktree, worktree.js makeFor), the branch named from that
 * message. On the phone page (`web`) the folder browser is not available (a phone cannot list the PC's disks), so
 * This folder lists the folders the PC already knows (`known()`), and New worktree works as on the desktop.
 */

const shortPath = (p) => String(p || '').replace(/^C:\\Users\\[^\\]+/i, '~');
const SEP = '\\';

export function folderSheet(pane, { sheet, send, esc, ago, web = false, wt = null, mode = 'folder', known = () => [] }) {
  const state = { open: false, cur: null, showHidden: false, root: null, close: null, mode: wt && mode === 'worktree' ? 'worktree' : 'folder' };
  const e$ = (s) => esc(String(s ?? ''));

  // Where the conversation starts: the desktop browses the PC's folders; the phone picks among the folders the PC knows.
  const folderPart = web
    ? `<div class="note">Claude Code works in this folder: its CLAUDE.md, settings and relative paths come from here. The folder is fixed once you send the first message.</div>
    <div class="places sf-known"><div class="pl-col"><div class="pl-h">Folders on the PC</div><div class="pl-recent"><div class="pl-wait">None yet</div></div></div></div>`
    : `<div class="note">Claude Code works in this folder: its CLAUDE.md, settings and relative paths come from here. The folder is fixed once you send the first message.</div>
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
    </div>`;
  const worktreePart = `<div class="note">Claude works on its own branch in its own folder, so it never touches your other checkouts. When you send the first message, Apaki suggests a branch name from it and shows the command it will run; nothing is created before that.</div>
    <label class="wt-f"><span>Repository</span><select data-f="repo"></select></label>
    <label class="wt-f"><span>Start from</span><select data-f="base"></select></label>
    <div class="wt-none sf-wt-info" aria-live="polite"></div>`;
  const html = `<div class="from">${e$(pane.title)}</div><h2>Start this conversation in</h2>
    ${wt ? `<div class="seg wt-mode" role="radiogroup" aria-label="Where it starts"><button type="button" role="radio" data-mode="folder">This folder</button><button type="button" role="radio" data-mode="worktree">New worktree</button></div>` : ''}
    <div class="sf-folder">${folderPart}</div>
    ${wt ? `<div class="sf-worktree" hidden>${worktreePart}</div>` : ''}
    <div class="row"><button data-k="x">Cancel</button><button data-k="home" data-for="folder">Home</button><button class="primary" data-k="here" data-for="folder">Start here</button>${wt ? '<button class="primary" data-k="wt" data-for="worktree" hidden>Use a new worktree</button>' : ''}</div>`;

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

  /** The phone's This folder: the folders the PC already knows, as rows to tap. */
  const fillKnown = () => {
    const list = known().map((k) => ({ path: k.path, name: k.name, last: k.last, claude: k.claude }));
    fillList(q('.sf-known .pl-recent'), list);
  };

  /* ---------- New worktree: a repository and a base branch ---------- */

  const wtRepos = () => wt?.repos() || [];
  const repoSel = () => q('[data-f=repo]');
  const baseSel = () => q('[data-f=base]');
  const chosenRepo = () => wtRepos().find((r) => r.id === repoSel()?.value) || null;

  /** The base branches of the chosen repository; the default one first and selected. */
  const fillBases = () => {
    const r = chosenRepo();
    const sel = baseSel();
    const info = q('.sf-wt-info');
    if (!r) { sel.innerHTML = ''; return; }
    const branches = r.branches?.length ? r.branches : (r.base ? [r.base] : []);
    const list = [...new Set([r.base, ...branches].filter(Boolean))];
    sel.innerHTML = list.map((b) => `<option value="${e$(b)}"${b === r.base ? ' selected' : ''}>${e$(b)}</option>`).join('');
    info.textContent = r.light && !r.base ? 'Reading the branches…' : '';
  };

  /** Lists the repositories the PC knows (plus the folder being browsed), then reads the chosen one in full for its branches. */
  const loadRepos = async () => {
    const sel = repoSel();
    const here = state.cur?.path || pane.cwd || '';
    // The folder the sheet is looking at may be a repository the PC has not listed yet: asking about it lists it.
    if (here && !web) await wt.ask('worktrees', { cwd: here, full: true });
    if (!state.open) return;
    const repos = wtRepos();
    const f = here ? wt.forCwd(here) : null;
    sel.innerHTML = repos.map((r) => `<option value="${e$(r.id)}">${e$(r.name)}</option>`).join('');
    if (f) sel.value = f.repo.id;
    q('[data-k=wt]').disabled = !repos.length;
    q('.sf-wt-info').textContent = repos.length ? '' : 'No git repository is known yet. Start a conversation in a repository folder first, or choose one under This folder.';
    if (!repos.length) { baseSel().innerHTML = ''; return; }
    fillBases();
    const r = chosenRepo();
    // A repository the PC listed without its branches is read in full once it is chosen.
    if (r && !r.branches?.length) { await wt.ask('worktrees', { cwd: r.root, full: true }); if (state.open) { sel.value = r.id; fillBases(); } }
  };

  const setMode = (m) => {
    state.mode = m;
    const root = state.root;
    root.querySelectorAll('.wt-mode button').forEach((b) => { const on = b.dataset.mode === m; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    q('.sf-folder').hidden = m !== 'folder';
    q('.sf-worktree').hidden = m !== 'worktree';
    root.querySelectorAll('.row [data-for]').forEach((b) => { b.hidden = b.dataset.for !== m || (web && b.dataset.k === 'here'); });
    if (m === 'worktree') loadRepos().catch(() => {});
  };

  sheet(html, (root, close) => {
    state.root = root;
    state.close = close;
    state.open = true;
    if (!web) {
      q('.path-go').onsubmit = (ev) => { ev.preventDefault(); const v = q('.path-in').value.trim(); if (v) go(v); };
      q('.br-hidden input').onchange = (ev) => { state.showHidden = ev.target.checked; render(); };
      q('.br-new').onsubmit = (ev) => {
        ev.preventDefault();
        const name = q('.br-new input').value.trim();
        if (name && state.cur && !state.cur.error) send('mkdir', { path: state.cur.path, name });
      };
    }
    q('[data-k=x]').onclick = done;
    q('[data-k=home]').onclick = () => pick('');
    q('[data-k=here]').onclick = () => { if (state.cur && !state.cur.error) pick(state.cur.path); };
    if (wt) {
      root.querySelectorAll('.wt-mode button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
      repoSel().onchange = () => { fillBases(); const r = chosenRepo(); if (r && !r.branches?.length) loadRepos().catch(() => {}); };
      q('[data-k=wt]').onclick = () => {
        const r = chosenRepo();
        if (!r) return;
        done();
        pane.setPendingWorktree({ repo: r.root || r.worktrees[0].path, name: r.name, base: baseSel().value || r.base || '' });
      };
      setMode(state.mode);
    }
    // The phone cannot browse the PC's disks: it taps one of the folders the PC knows, which starts there at once.
    if (web) { q('[data-k=here]').hidden = true; fillKnown(); } else { send('places'); go(pane.cwd || ''); }
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
