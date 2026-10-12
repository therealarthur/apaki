/**
 * find.js: Ctrl+F inside one pane (Arthur, 2026-10-10: "a ctrl+f search for
 * a currently active window/session").
 *
 * A small frosted bar at the top right of the focused pane searches what that
 * pane shows: a conversation's transcript, a subagent or shell viewer, a text
 * artifact (a web page in its sandboxed frame cannot be searched from here).
 * Every match is marked; Enter / Shift+Enter (or F3 / Shift+F3) step through
 * them, the current one scrolled to the middle and any collapsed tool block
 * that holds it opened. Aa matches case. New text (a streaming reply) is
 * searched again as it arrives. Escape closes the bar and clears the marks.
 *
 * openFind(pane) opens it (or selects its text when it is open already).
 */

const DEBOUNCE_MS = 110;
const RESEARCH_MS = 300;

/** The element whose text a pane's find searches. */
function rootOf(pane) {
  return pane.$?.T || pane.$?.body || pane.el.querySelector('.ground');
}

/** Removes every mark under `root`, joining the text back. */
export function clearMarks(root) {
  const marks = root.querySelectorAll('mark.find-hit');
  if (!marks.length) return;
  const parents = new Set();
  for (const m of marks) { parents.add(m.parentNode); m.replaceWith(document.createTextNode(m.textContent)); }
  for (const p of parents) p?.normalize?.();
}

// Not conversation text, so never a match: the Load earlier bar, Show all and image buttons, and the
// preview beside a collapsed Thinking (its words are in the body, which would count them twice).
/** Marks every match of `q` under `root`; returns the marks in document order. */
export function markMatches(root, q, matchCase = false) {
  clearMarks(root);
  if (!q) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.find-bar, script, style, textarea, .hist-more, .show-all, .img-ph, .th-peek') ? NodeFilter.FILTER_REJECT : n.nodeValue && n.nodeValue.length >= q.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const needle = matchCase ? q : q.toLowerCase();
  const hits = [];
  for (const node of nodes) {
    const text = node.nodeValue;
    const hay = matchCase ? text : text.toLowerCase();
    let i = hay.indexOf(needle);
    if (i < 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (i >= 0) {
      if (i > last) frag.append(text.slice(last, i));
      const m = document.createElement('mark');
      m.className = 'find-hit';
      m.textContent = text.slice(i, i + q.length);
      frag.append(m);
      hits.push(m);
      last = i + q.length;
      i = hay.indexOf(needle, last);
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return hits;
}

const ICON = {
  find: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.4"/><path d="m10.4 10.4 3.4 3.4"/></svg>',
  up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
};

export function openFind(pane) {
  if (!pane?.el) return;
  if (pane.find) { pane.find.focus(); return; }
  const root = rootOf(pane);
  if (!root) return;
  const bar = document.createElement('div');
  bar.className = 'find-bar';
  // enterkeyhint and the off switches are for a phone's keyboard (2026-10-12): a Search key that steps to the next match.
  bar.innerHTML = `<span class="fb-i">${ICON.find}</span><input type="text" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" enterkeyhint="search" placeholder="Find in ${pane.isTask ? 'this task' : pane.isDiff ? 'these changes' : pane.isViewer ? 'this artifact' : 'this conversation'}" aria-label="Find"><span class="fb-n" aria-live="polite"></span>
    <button class="fb-case" title="Match case" aria-pressed="false">Aa</button><button class="fb-prev" title="Previous (Shift+Enter)">${ICON.up}</button><button class="fb-next" title="Next (Enter)">${ICON.down}</button><button class="fb-x" title="Close (Esc)">${ICON.close}</button>
    <div class="fb-note" hidden></div>`;
  pane.el.append(bar);
  pane.el.classList.add('finding');
  const input = bar.querySelector('input');
  const count = bar.querySelector('.fb-n');
  const note = bar.querySelector('.fb-note');
  let hits = [];
  let cur = -1;
  let matchCase = false;
  let busy = false;
  let timer = null;
  let lastQ = '';

  const show = (scroll = true) => {
    hits.forEach((m, i) => m.classList.toggle('cur', i === cur));
    count.textContent = !input.value ? '' : hits.length ? `${cur + 1} of ${hits.length}` : 'No matches';
    bar.classList.toggle('none', Boolean(input.value) && !hits.length);
    const m = hits[cur];
    if (!m || !scroll) return;
    for (let d = m.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
    m.scrollIntoView({ block: 'center', behavior: 'auto' });
  };
  const run = ({ keep = false } = {}) => {
    const q = input.value;
    const before = hits[cur];
    const at = before ? cur : 0;
    busy = true;
    try { hits = markMatches(root, q, matchCase); } finally { busy = false; }
    // Typing a new search starts at the first match below where you are reading.
    if (!keep || q !== lastQ) {
      const g = pane.$?.ground || root;
      const top = g.getBoundingClientRect?.().top || 0;
      const below = hits.findIndex((m) => m.getBoundingClientRect().top >= top);
      cur = hits.length ? (below >= 0 ? below : 0) : -1;
    } else cur = hits.length ? Math.min(at, hits.length - 1) : -1;
    lastQ = q;
    const cut = pane.historyCut;
    note.hidden = !cut;
    pane.el.classList.toggle('find-cut', Boolean(cut));
    if (cut && cut.paged && pane.loadAllHistory) {
      // The rest of the conversation can be loaded (engine history.js): offer to, then search all of it.
      note.innerHTML = `<span>Searching the ${cut.shown.toLocaleString()} loaded of ${cut.total.toLocaleString()} messages.</span> <button class="fb-all" type="button">Search all</button>`;
    } else if (cut) note.textContent = `Searching the latest ${cut.shown.toLocaleString()} of ${cut.total.toLocaleString()} messages (the ones loaded here).`;
    show(!keep);
  };
  const step = (d) => {
    if (!hits.length) return;
    cur = (cur + d + hits.length) % hits.length;
    show();
  };
  const close = () => {
    clearTimeout(timer);
    observer.disconnect();
    busy = true;
    try { clearMarks(root); } finally { busy = false; }
    bar.remove();
    pane.el.classList.remove('finding', 'find-cut');
    pane.find = null;
    // Not on the phone (2026-10-12): the message box would take the keyboard right back after Done.
    if (!document.body.classList.contains('native')) pane.$?.input?.focus({ preventScroll: true });
  };

  // New text while the bar is open (a reply streaming in): search it too, keeping your place.
  const observer = new MutationObserver(() => {
    if (busy || !input.value) return;
    clearTimeout(timer);
    timer = setTimeout(() => run({ keep: true }), RESEARCH_MS);
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(), DEBOUNCE_MS); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'F3') { e.preventDefault(); if (input.value !== lastQ) run(); else step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); input.select(); }
  });
  bar.querySelector('.fb-next').onclick = () => step(1);
  bar.querySelector('.fb-prev').onclick = () => step(-1);
  bar.querySelector('.fb-x').onclick = close;
  const caseBtn = bar.querySelector('.fb-case');
  caseBtn.onclick = () => { matchCase = !matchCase; caseBtn.classList.toggle('on', matchCase); caseBtn.setAttribute('aria-pressed', String(matchCase)); run(); input.focus(); };
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  // Previous, Next and Aa keep the keyboard on the search box (2026-10-12): on a phone a tap on a button would drop it
  // after every step; on a desktop it keeps typing where it was.
  for (const b of bar.querySelectorAll('button')) b.addEventListener('mousedown', (e) => e.preventDefault());
  // Search all: load the whole conversation first, then search it from the first match below.
  note.addEventListener('click', async (e) => {
    if (!e.target.closest('.fb-all')) return;
    note.textContent = 'Loading the whole conversation…';
    await pane.loadAllHistory();
    if (!pane.find) return;
    run();
    input.focus();
  });

  // Text already selected in the pane becomes the search.
  const sel = window.getSelection?.()?.toString().trim();
  if (sel && sel.length < 120 && !sel.includes('\n') && root.contains(window.getSelection().anchorNode)) input.value = sel;
  pane.find = { focus: () => { input.focus(); input.select(); }, close, step };
  input.focus();
  input.select();
  if (input.value) run();
}

/** F3 / Shift+F3 with the bar closed opens it; with it open, steps. */
export function findStep(pane, d) {
  if (!pane) return;
  if (!pane.find) { openFind(pane); return; }
  pane.find.step(d);
}
