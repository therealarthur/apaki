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
import { filterItems, lastPrompt, openSessions, searchInside, terms, toItems, transcriptMap } from '../picker.js';
import { ago, listSessions } from '../sessions.js';
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
    if (!cache.has(programmatic)) cache.set(programmatic, toItems(await load(programmatic), fileMap, open || openSessions()));
    return cache.get(programmatic);
  };
}

export function PickerScreen({ loader, initialQuery = '', billing = '', message = '', onPick, onQuit }) {
  const { stdout } = useStdout();
  const [items, setItems] = useState(null);
  const [query, setQuery] = useState(initialQuery);
  const [sel, setSel] = useState(0);
  const [programmatic, setProgrammatic] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);
  const [inside, setInside] = useState(null);
  const previews = useRef(new Map());

  useEffect(() => { let live = true; loader(programmatic).then((it) => { if (live) setItems(it); }); return () => { live = false; }; }, [programmatic]);
  useEffect(() => () => inside?.cancel?.(), [inside]);

  const shown = useMemo(() => {
    if (!items) return [];
    if (inside && inside.query === query) {
      return items.filter((it) => inside.hits.has(it.id) && (!openOnly || it.open)).sort((a, b) => b.lastModified - a.lastModified);
    }
    return filterItems(items, query, { openOnly });
  }, [items, query, openOnly, inside, inside?.hits.size]);

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
    const state = { query, hits, scanned: 0, total: items.filter((it) => it.file).length, done: false, cancel: null };
    const bump = () => setInside({ ...state });
    state.cancel = searchInside(items, query, {
      onHit: (id, snippet) => { hits.set(id, snippet); bump(); },
      onProgress: (n, total) => { state.scanned = n; state.total = total; if (n % 5 === 0 || n === total) bump(); },
      onDone: () => { state.done = true; bump(); },
    });
    setInside({ ...state });
    setSel(0);
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { onQuit(); return; }
    if (key.escape) { if (query) { setQuery(''); setInside(null); setSel(0); } else onQuit(); return; }
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
    if (!previews.current.has(selected.id)) previews.current.set(selected.id, selected.file ? lastPrompt(selected.file) : '');
    latest = previews.current.get(selected.id);
  }

  const count = items ? `${shown.length} of ${items.length}` : 'loading…';
  const searchState = inside && inside.query === query
    ? (inside.done ? `searched inside ${inside.total} conversations · ${inside.hits.size} found` : `searching inside conversations ${inside.scanned}/${inside.total}…`)
    : (query ? 'ctrl+f to also search inside conversations' : '');

  return h`<${Box} flexDirection="column" width=${cols}>
    <${Box}>
      <${Box} flexGrow=${1}><${Text}><${Text} color=${theme.brand}>${'✻ '}</${Text}><${Text} bold>latch</${Text}><${Text} color=${theme.dim}>${'  Resume a conversation'}</${Text}></${Text}></${Box}>
      <${Text} color=${theme.dim}>${billing}</${Text}>
    </${Box}>
    <${Box} borderStyle="round" borderColor=${theme.border} paddingX=${1} marginTop=${1}>
      <${Box} flexGrow=${1}><${Text}><${Text} color=${theme.dim}>${'⌕ '}</${Text}>${query}<${Text} inverse>${' '}</${Text}>${!query ? h`<${Text} color=${theme.dim}>${' Search sessions by title, prompt, folder, branch or id'}</${Text}>` : null}</${Text}></${Box}>
      <${Text} color=${theme.dim}>${`${openOnly ? 'open only · ' : ''}${programmatic ? 'incl. headless · ' : ''}${count}`}</${Text}>
    </${Box}>
    ${message ? h`<${Text} color=${theme.warn}>${`  ${message}`}</${Text}>` : null}
    ${searchState ? h`<${Text} color=${theme.dim}>${`  ${searchState}`}</${Text}>` : null}
    <${Box} flexDirection="column" marginTop=${1}>
      ${!items ? h`<${Text} color=${theme.dim}>  Loading sessions…</${Text}>` : null}
      ${items && !shown.length ? h`<${Text} color=${theme.dim}>  No sessions match. ${query && !inside ? 'Press ctrl+f to search inside conversations.' : ''}</${Text}>` : null}
      ${page.map((it, i) => {
    const on = top + i === cur;
    const meta = [ago(Date.now() - it.lastModified), cut(shortPath(it.cwd), 34), fmtSize(it.size), it.branch].filter(Boolean).join(' · ');
    const snippet = inside && inside.query === query ? inside.hits.get(it.id) : null;
    return h`<${Box} key=${it.id} flexDirection="column">
          <${Text} color=${on ? theme.suggestion : undefined} bold=${on} wrap="truncate-end">
            ${`${on ? '❯ ' : '  '}${it.title}`}
            ${it.open ? h`<${Text} color=${theme.ok}>${`  open in ${it.open} window${it.open === 1 ? '' : 's'}`}</${Text}>` : null}
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
    <${Text} color=${theme.dim}>${'  ↑↓ select · enter open · tab open-in-window only · ctrl+f search inside · ctrl+a headless · esc quit'}</${Text}>
  </${Box}>`;
}
