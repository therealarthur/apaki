/**
 * ui/picker.js
 *
 * The session picker screen, laid out like Claude Code's /resume: a search
 * box, a two-line row per session (title, then age · folder · size · branch),
 * and a preview of the selected session's first and latest prompts.
 *
 * Data and search come from ../picker.js (filtering, search inside
 * conversations, live-window detection), so behavior matches the older
 * line-based picker.
 *
 * Keys: type to search · ↑↓ / ctrl+p ctrl+n · pgup pgdn · enter open ·
 * tab sessions open in a window only · ctrl+a include headless sessions ·
 * ctrl+f search inside conversations · ctrl+u clear · esc clear or quit.
 */

import { Box, Text, useInput, useStdout } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { enrichItems, filterItems, hasTypedTurns, lastPrompt, openSessions, searchInside, terminalSessions, terms, toItems, transcriptMap } from '../picker.js';
import { indexBin, kindLabel, searchIndex, updateIndex } from '../deepindex.js';
import * as folderApi from '../folders.js';

// How often the "Open in terminal" group re-reads Claude Code's live records.
const TERMINAL_POLL_MS = 2000;

/** A row for a session that has no transcript entry in the list yet (just opened in a window). */
function placeholderItem(id, rec) {
  const title = `New session${rec?.name ? ` (${rec.name})` : ''}`;
  return {
    id, title, firstPrompt: '', cwd: rec?.cwd || '', branch: '', lastModified: rec?.updatedAt || Date.now(), size: 0,
    file: null, open: 1, titleLower: title.toLowerCase(), hay: [id, title, rec?.cwd || ''].join(' ').toLowerCase(),
  };
}

// Wait this long after the last keystroke before asking the index.
const DEEP_DEBOUNCE_MS = 180;
import { ago, createdSessions, listSessions } from '../sessions.js';
import { h, theme } from './components.js';

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function shortPath(p) {
  return String(p || '').replace(/^C:\\Users\\[^\\]+/i, '~');
}

function cut(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
}

/** Loads picker items once per "include headless" setting. */
export function makeLoader({ loadInfos, files, open } = {}) {
  const fileMap = files || transcriptMap();
  const load = loadInfos || ((programmatic) => listSessions({ limit: 5000, includeProgrammatic: programmatic }));
  const cache = new Map();
  return async (programmatic) => {
    if (!cache.has(programmatic)) {
      let infos = await load(programmatic);
      // The SDK's list leaves out every session whose first entry is headless,
      // which also hid real conversations: ones started with claude -p (or by
      // Workbook, or in latch) and then continued by hand. 2 of 224 hidden
      // sessions on this PC were like that (2026-10-09). Add back any hidden
      // session that has turns typed in Claude Code (cli) or latch (sdk-ts),
      // plus every session latch created; pure automation stays behind Ctrl+A.
      if (!programmatic) {
        const created = createdSessions();
        const have = new Set(infos.map((s) => s.sessionId));
        const extra = (await load(true)).filter((s) => {
          if (have.has(s.sessionId)) return false;
          if (created.has(s.sessionId)) return true;
          const file = fileMap.get(s.sessionId);
          return Boolean(file) && hasTypedTurns(file);
        });
        if (extra.length) infos = [...infos, ...extra].sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
      }
      cache.set(programmatic, toItems(infos, fileMap, open || openSessions()));
    }
    return cache.get(programmatic);
  };
}

export function PickerScreen({
  loader, initialQuery = '', billing = '', message = '', onPick, onQuit,
  terminals = terminalSessions, folderStore = folderApi,
}) {
  const { stdout } = useStdout();
  const [items, setItems] = useState(null);
  const [query, setQuery] = useState(initialQuery);
  const [sel, setSel] = useState(0);
  const [programmatic, setProgrammatic] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);
  const [inside, setInside] = useState(null);
  const previews = useRef(new Map());

  // Views: All, the sessions open in Claude Code terminal windows (auto-
  // imported from Claude Code's live records, refreshed every 2 s), and one
  // per folder. ←/→ switch; ctrl+g files the selected session in a folder.
  const [view, setView] = useState('all');
  const [folderGen, setFolderGen] = useState(0);
  const folders = useMemo(() => folderStore.listFolders(), [folderGen]);
  const [termMap, setTermMap] = useState(() => terminals());
  // The open dialog lives in a ref as well: keys can arrive faster than
  // renders, and reading the rendered copy dropped typed characters.
  const [modal, setModalState] = useState(null);
  const modalRef = useRef(null);
  const setModal = (m) => { modalRef.current = m; setModalState(m); };
  const [flash, setFlash] = useState('');
  useEffect(() => {
    let sig = JSON.stringify([...termMap]);
    const timer = setInterval(() => {
      const next = terminals();
      const s = JSON.stringify([...next]);
      if (s !== sig) { sig = s; setTermMap(next); }
    }, TERMINAL_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const [enriched, setEnriched] = useState(0);
  useEffect(() => { let live = true; loader(programmatic).then((it) => { if (live) setItems(it); }); return () => { live = false; }; }, [programmatic]);
  // Widen the search to every folder a session ran in and its latest prompts
  // and replies, read in the background; refilter as it goes.
  useEffect(() => {
    if (!items) return undefined;
    const tick = setInterval(() => setEnriched((n) => n + 1), 400);
    const cancel = enrichItems(items, { onDone: () => { clearInterval(tick); setEnriched((n) => n + 1); } });
    return () => { cancel(); clearInterval(tick); };
  }, [items]);
  useEffect(() => () => inside?.cancel?.(), [inside]);

  // Deep search: the latch-index full-text index over every conversation,
  // subagents included, queried as you type. It is brought up to date first
  // (only what changed since last time), then the search reruns.
  const hasIndex = useMemo(() => Boolean(indexBin()), []);
  const [indexGen, setIndexGen] = useState(0);
  const [indexNote, setIndexNote] = useState(hasIndex ? 'updating the conversation index…' : '');
  const [deep, setDeep] = useState(null);
  const [extra, setExtra] = useState(new Map());
  useEffect(() => {
    if (!hasIndex) return undefined;
    let live = true;
    const t0 = Date.now();
    updateIndex().then((r) => {
      if (!live) return;
      setIndexNote(r ? (r.busy ? 'index update already running elsewhere' : `index up to date (${((Date.now() - t0) / 1000).toFixed(1)}s)`) : 'index unavailable; ctrl+f scans files instead');
      setIndexGen((n) => n + 1);
    });
    return () => { live = false; };
  }, [hasIndex]);
  useEffect(() => {
    if (!hasIndex || !items || !terms(query).length) { setDeep(null); return undefined; }
    let live = true;
    const timer = setTimeout(async () => {
      const res = await searchIndex(query);
      if (!live || !res) return;
      const hits = new Map(res.sessions.map((s) => [s.session, s]));
      setDeep({ query, ids: res.sessions.map((s) => s.session), hits, elapsed: res.elapsed_ms, total: res.total_hits });
      // Sessions the normal list hides (started headless, for example).
      const known = new Set(items.map((it) => it.id));
      const missing = res.sessions.map((s) => s.session).filter((id) => !known.has(id) && !extra.has(id));
      if (missing.length) {
        const all = await loader(true);
        if (!live) return;
        setExtra((prev) => {
          const next = new Map(prev);
          for (const it of all) if (missing.includes(it.id)) next.set(it.id, it);
          return next;
        });
      }
    }, DEEP_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [query, items, indexGen, hasIndex]);

  // Sessions open in terminals or filed in folders may be hidden from the
  // normal list (started headless, for example): load those from the full list.
  useEffect(() => {
    if (!items) return undefined;
    const known = new Set(items.map((it) => it.id));
    const wanted = [...termMap.keys(), ...folders.flatMap((f) => f.sessions)].filter((id) => !known.has(id) && !extra.has(id));
    if (!wanted.length) return undefined;
    let live = true;
    loader(true).then((all) => {
      if (!live) return;
      setExtra((prev) => {
        const next = new Map(prev);
        for (const it of all) if (wanted.includes(it.id)) next.set(it.id, it);
        return next;
      });
    });
    return () => { live = false; };
  }, [items, termMap, folders]);

  const folderOf = useMemo(() => {
    const m = new Map();
    for (const f of folders) for (const s of f.sessions) m.set(s, f);
    return m;
  }, [folders]);

  // The sessions this view holds, before the search narrows them.
  const pool = useMemo(() => {
    if (!items) return [];
    const byId = new Map([...extra, ...items.map((it) => [it.id, it])]);
    const termIds = [...termMap.keys()].sort((a, b) => (termMap.get(b)[0]?.updatedAt || 0) - (termMap.get(a)[0]?.updatedAt || 0));
    const termItem = (id) => byId.get(id) || placeholderItem(id, termMap.get(id)?.[0]);
    if (view === 'terminal') return termIds.map(termItem);
    if (view !== 'all') {
      const f = folders.find((x) => x.id === view);
      return f ? f.sessions.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => b.lastModified - a.lastModified) : [];
    }
    const inTerminal = new Set(termIds);
    return [...termIds.map(termItem), ...items.filter((it) => !inTerminal.has(it.id))];
  }, [items, extra, termMap, view, folders]);

  const shown = useMemo(() => {
    if (!items) return [];
    if (deep && deep.query === query && !inside) {
      const byId = new Map([...extra, ...items.map((it) => [it.id, it])]);
      const inView = view === 'all' ? null : new Set(pool.map((it) => it.id));
      const ranked = deep.ids
        .filter((id) => !inView || inView.has(id))
        .map((id) => byId.get(id))
        .filter((it) => it && (!openOnly || it.open));
      const seen = new Set(ranked.map((it) => it.id));
      return [...ranked, ...filterItems(pool, query, { openOnly }).filter((it) => !seen.has(it.id))];
    }
    if (inside && inside.query === query) {
      return pool.filter((it) => inside.hits.has(it.id) && (!openOnly || it.open)).sort((a, b) => b.lastModified - a.lastModified);
    }
    if (!terms(query).length) return pool.filter((it) => !openOnly || it.open);
    return filterItems(pool, query, { openOnly });
  }, [items, pool, query, openOnly, inside, inside?.hits.size, enriched, deep, extra, view]);

  const views = [
    { id: 'all', label: 'All' },
    { id: 'terminal', label: `Open in terminal ${termMap.size}` },
    ...folders.map((f) => ({ id: f.id, label: `${f.name} ${f.sessions.length}` })),
  ];
  const viewIndex = Math.max(0, views.findIndex((v) => v.id === view));
  const currentFolder = folders.find((f) => f.id === view) || null;

  const rows = stdout?.rows || 30;
  const cols = Math.max(50, (stdout?.columns || 100) - 1);
  const visible = Math.max(3, Math.floor((rows - 14) / 2));
  const cur = Math.min(sel, Math.max(0, shown.length - 1));
  const top = Math.max(0, Math.min(cur - Math.floor(visible / 2), shown.length - visible));
  const page = shown.slice(top, top + visible);
  const selected = shown[cur];

  const startInside = () => {
    if (!items || !terms(query).length) return;
    inside?.cancel?.();
    const hits = new Map();
    const state = { query, hits, scanned: 0, total: pool.filter((it) => it.file).length, done: false, cancel: null };
    const bump = () => setInside({ ...state });
    state.cancel = searchInside(pool, query, {
      onHit: (id, snippet) => { hits.set(id, snippet); bump(); },
      onProgress: (n, total) => { state.scanned = n; state.total = total; if (n % 5 === 0 || n === total) bump(); },
      onDone: () => { state.done = true; bump(); },
    });
    setInside({ ...state });
    setSel(0);
  };

  const refreshFolders = (note) => { setFolderGen((n) => n + 1); if (note) setFlash(note); };

  /** ctrl+g: file the selected session in a folder, a new folder, or none. */
  const openMoveDialog = () => {
    if (!selected) return;
    const id = selected.id;
    const now = folderOf.get(id);
    const options = [
      ...folders.map((f) => ({ label: f.name, value: f.id, hint: f.id === now?.id ? 'current' : `${f.sessions.length}` })),
      { label: 'New folder…', value: '__new' },
      ...(now ? [{ label: `Take out of "${now.name}"`, value: '__none' }] : []),
    ];
    setModal({
      kind: 'pick', title: `Move "${cut(selected.title, 50)}" to`, options, sel: 0,
      onPick: (value) => {
        if (value === '__new') {
          setModal({
            kind: 'name', title: 'New folder name', text: '',
            onDone: (name) => {
              const f = folderStore.createFolder(name);
              if (f.error) { setFlash(f.error); return; }
              folderStore.moveToFolder(id, f.id);
              refreshFolders(`Moved to ${f.name}`);
            },
          });
          return;
        }
        setModal(null);
        if (value === '__none') { folderStore.moveToFolder(id, null); refreshFolders(`Taken out of ${now.name}`); return; }
        folderStore.moveToFolder(id, value);
        refreshFolders(`Moved to ${folders.find((f) => f.id === value)?.name || 'folder'}`);
      },
    });
  };

  /** Keys while a folder dialog is open. */
  const modalInput = (input, key) => {
    const modal = modalRef.current;
    if (key.escape || (key.ctrl && input === 'c')) { setModal(null); return; }
    if (modal.kind === 'pick') {
      const n = modal.options.length;
      if (key.upArrow) { setModal({ ...modal, sel: (modal.sel - 1 + n) % n }); return; }
      if (key.downArrow) { setModal({ ...modal, sel: (modal.sel + 1) % n }); return; }
      const digit = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
      if (key.return || (digit >= 0 && digit < n)) modal.onPick(modal.options[digit >= 0 ? digit : modal.sel].value);
      return;
    }
    if (modal.kind === 'name') {
      if (key.return) { const text = modal.text; setModal(null); modal.onDone(text); return; }
      if (key.backspace || key.delete) { setModal({ ...modal, text: modal.text.slice(0, -1) }); return; }
      if (key.ctrl || key.meta || !input) return;
      setModal({ ...modal, text: modal.text + input.replace(/[\r\n]+/g, ' ') });
      return;
    }
    if (modal.kind === 'confirm') {
      if (key.return || input === 'y' || input === 'Y') { setModal(null); modal.onYes(); return; }
      if (input === 'n' || input === 'N') setModal(null);
    }
  };

  useInput((input, key) => {
    if (modalRef.current) { modalInput(input, key); return; }
    if (flash) setFlash('');
    if (key.ctrl && input === 'c') { onQuit(); return; }
    if (key.escape) { if (query) { setQuery(''); setInside(null); setSel(0); } else onQuit(); return; }
    if (key.leftArrow || key.rightArrow) {
      const next = views[(viewIndex + (key.rightArrow ? 1 : -1) + views.length) % views.length];
      setView(next.id); setInside(null); setSel(0);
      return;
    }
    if (key.ctrl && input === 'g') { openMoveDialog(); return; }
    if (key.ctrl && input === 'r' && currentFolder) {
      setModal({
        kind: 'name', title: `Rename folder "${currentFolder.name}"`, text: currentFolder.name,
        onDone: (name) => { const r = folderStore.renameFolder(currentFolder.id, name); refreshFolders(r.error || `Renamed to ${r.name}`); },
      });
      return;
    }
    if (key.ctrl && input === 'd' && currentFolder) {
      setModal({
        kind: 'confirm', title: `Delete folder "${currentFolder.name}"? Its ${currentFolder.sessions.length} session(s) stay where they are. y/n`,
        onYes: () => { folderStore.deleteFolder(currentFolder.id); setView('all'); refreshFolders(`Deleted folder ${currentFolder.name}`); },
      });
      return;
    }
    if (key.return) { if (selected) onPick(selected); return; }
    if (key.upArrow || (key.ctrl && input === 'p')) { setSel(Math.max(0, cur - 1)); return; }
    if (key.downArrow || (key.ctrl && input === 'n')) { setSel(Math.min(shown.length - 1, cur + 1)); return; }
    if (key.pageUp) { setSel(Math.max(0, cur - visible)); return; }
    if (key.pageDown) { setSel(Math.min(shown.length - 1, cur + visible)); return; }
    if (key.tab) { setOpenOnly((v) => !v); setSel(0); return; }
    if (key.ctrl && input === 'a') { setProgrammatic((v) => !v); setItems(null); setInside(null); setSel(0); return; }
    if (key.ctrl && input === 'f') { startInside(); return; }
    if (key.ctrl && input === 'u') { setQuery(''); setInside(null); setSel(0); return; }
    if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); setSel(0); return; }
    if (key.ctrl || key.meta || !input) return;
    setQuery((q) => q + input.replace(/[\r\n]+/g, ' '));
    setSel(0);
  });

  let first = '';
  let latest = '';
  if (selected) {
    first = selected.firstPrompt;
    if (!previews.current.has(selected.id)) previews.current.set(selected.id, selected.recent?.[0] || (selected.file ? lastPrompt(selected.file) : ''));
    latest = previews.current.get(selected.id);
  }

  const count = items ? `${shown.length} of ${pool.length}` : 'loading…';
  let searchState;
  if (inside && inside.query === query) {
    searchState = inside.done ? `searched inside ${inside.total} conversations · ${inside.hits.size} found` : `searching inside conversations ${inside.scanned}/${inside.total}…`;
  } else if (deep && deep.query === query) {
    searchState = `searched every conversation and subagent in ${deep.elapsed} ms · ${deep.ids.length} sessions · ${indexNote}`;
  } else if (hasIndex) {
    searchState = query ? `searching every conversation… · ${indexNote}` : indexNote;
  } else {
    searchState = query ? 'ctrl+f to also search inside conversations' : '';
  }

  return h`<${Box} flexDirection="column" width=${cols}>
    <${Box}>
      <${Box} flexGrow=${1}><${Text}><${Text} color=${theme.brand}>${'✻ '}</${Text}><${Text} bold>latch</${Text}><${Text} color=${theme.dim}>${'  Resume a conversation'}</${Text}></${Text}></${Box}>
      <${Text} color=${theme.dim}>${billing}</${Text}>
    </${Box}>
    <${Box} borderStyle="round" borderColor=${theme.border} paddingX=${1} marginTop=${1}>
      <${Box} flexGrow=${1}><${Text}><${Text} color=${theme.dim}>${'⌕ '}</${Text}>${query}<${Text} inverse>${' '}</${Text}>${!query ? h`<${Text} color=${theme.dim}>${' Search titles, prompts, replies, folders, branch or id'}</${Text}>` : null}</${Text}></${Box}>
      <${Text} color=${theme.dim}>${`${openOnly ? 'open only · ' : ''}${programmatic ? 'incl. headless · ' : ''}${count}`}</${Text}>
    </${Box}>
    <${Box} marginTop=${1}>
      <${Text} wrap="truncate-end">
        ${views.map((v, i) => h`<${Text} key=${v.id}>${i ? h`<${Text} color=${theme.dim}>${'  ·  '}</${Text}>` : '  '}<${Text} bold=${v.id === view} color=${v.id === view ? theme.suggestion : theme.dim} underline=${v.id === view}>${v.label}</${Text}></${Text}>`)}
      </${Text}>
    </${Box}>
    ${message ? h`<${Text} color=${theme.warn}>${`  ${message}`}</${Text}>` : null}
    ${flash ? h`<${Text} color=${theme.ok}>${`  ${flash}`}</${Text}>` : null}
    ${searchState ? h`<${Text} color=${theme.dim}>${`  ${searchState}`}</${Text}>` : null}
    ${modal ? h`<${Box} borderStyle="round" borderColor=${theme.suggestion} paddingX=${1} flexDirection="column" marginTop=${1}>
      <${Text} bold>${modal.title}</${Text}>
      ${modal.kind === 'pick' ? modal.options.map((o, i) => h`<${Text} key=${o.value} color=${i === modal.sel ? theme.suggestion : undefined}>${`${i === modal.sel ? '❯ ' : '  '}${i < 9 ? `${i + 1}. ` : '   '}${o.label}`}${o.hint ? h`<${Text} color=${theme.dim}>${`  ${o.hint}`}</${Text}>` : null}</${Text}>`) : null}
      ${modal.kind === 'name' ? h`<${Text}>${'› '}${modal.text}<${Text} inverse>${' '}</${Text}></${Text}>` : null}
      <${Text} color=${theme.dim}>${modal.kind === 'pick' ? '↑↓ or 1-9 choose · enter confirm · esc cancel' : modal.kind === 'name' ? 'enter save · esc cancel' : 'y yes · n no'}</${Text}>
    </${Box}>` : null}
    <${Box} flexDirection="column" marginTop=${1}>
      ${!items ? h`<${Text} color=${theme.dim}>  Loading sessions…</${Text}>` : null}
      ${items && !shown.length ? h`<${Text} color=${theme.dim}>  No sessions match. ${query && !inside ? 'Press ctrl+f to search inside conversations.' : ''}</${Text}>` : null}
      ${page.map((it, i) => {
    const on = top + i === cur;
    const lastFolder = it.folders && it.folders.length ? it.folders[it.folders.length - 1] : '';
    const moved = lastFolder && lastFolder.toLowerCase() !== String(it.cwd).toLowerCase() ? `→ ${cut(shortPath(lastFolder), 40)}` : '';
    const meta = [ago(Date.now() - it.lastModified), cut(shortPath(it.cwd), 34) + (moved ? ` ${moved}` : ''), fmtSize(it.size), it.branch].filter(Boolean).join(' · ');
    const deepHit = !inside && deep && deep.query === query ? deep.hits.get(it.id) : null;
    const snippet = inside && inside.query === query ? inside.hits.get(it.id)
      : deepHit && deepHit.snippet ? `${kindLabel(deepHit.kind)}: ${deepHit.snippet}${deepHit.hits > 1 ? `  (${deepHit.hits} matches)` : ''}` : null;
    const term = termMap.get(it.id)?.[0];
    const filed = view === 'all' ? folderOf.get(it.id) : null;
    return h`<${Box} key=${it.id} flexDirection="column">
          <${Text} color=${on ? theme.suggestion : undefined} bold=${on} wrap="truncate-end">
            ${`${on ? '❯ ' : '  '}${it.title}`}
            ${term ? h`<${Text} color=${theme.ok}>${`  in terminal${term.name ? ` ${term.name}` : ''}${term.status ? ` (${term.status})` : ''}`}</${Text}>`
    : it.open ? h`<${Text} color=${theme.ok}>${`  open in ${it.open} window${it.open === 1 ? '' : 's'}`}</${Text}>` : null}
            ${filed ? h`<${Text} color=${theme.dim}>${`  ▸ ${filed.name}`}</${Text}>` : null}
          </${Text}>
          <${Text} color=${theme.dim} wrap="truncate-end">${`    ${snippet ? `“${snippet.replace(/\s+/g, ' ')}”` : meta}`}</${Text}>
        </${Box}>`;
  })}
      ${shown.length > visible ? h`<${Text} color=${theme.dim}>${`  ${top + 1}-${Math.min(top + visible, shown.length)} of ${shown.length}`}</${Text}>` : null}
    </${Box}>
    ${selected ? h`<${Box} borderStyle="round" borderColor=${theme.dim} paddingX=${1} flexDirection="column" marginTop=${1}>
      <${Text} wrap="truncate-end"><${Text} color=${theme.dim}>${'First   '}</${Text}>${cut(first, cols * 2) || '(none)'}</${Text}>
      <${Text} wrap="truncate-end"><${Text} color=${theme.dim}>${'Latest  '}</${Text}>${cut(latest, cols * 2) || '(none)'}</${Text}>
      <${Text} color=${theme.dim} wrap="truncate-end">${`${selected.id}  ·  ${shortPath(selected.cwd)}`}</${Text}>
    </${Box}>` : null}
    <${Text} color=${theme.dim} wrap="truncate-end">${`  ↑↓ select · enter open · ←→ views · ctrl+g move to folder${currentFolder ? ' · ctrl+r rename · ctrl+d delete folder' : ''} · tab open only · ctrl+f scan · ctrl+a headless · esc quit`}</${Text}>
  </${Box}>`;
}
