/**
 * browser-page.js: what Claude reads of a page in Apaki's browser, and the
 * small helpers its clicks and typing use.
 *
 * WHY (2026-10-09, the built-in browser): browser_read gives Claude the page
 * as compact text (title, address, and an accessibility-style outline in
 * which every link, button and field carries a numbered ref) so it can use a
 * page without a screenshot for every step.
 *
 * Two halves:
 *   pageLibrary()   runs INSIDE the page, in an isolated world the engine
 *                   creates through the DevTools protocol (Page.createIsolatedWorld),
 *                   so the page's own scripts can neither see nor change it.
 *                   It installs window.__apaki: collect() walks the DOM into
 *                   a list of nodes, target(ref) and prepType(ref, text) find
 *                   an element again for a click or for typing. Refs stay the
 *                   same for the same element across reads of one document.
 *   formatOutline() runs in the engine and turns collect()'s nodes into the
 *                   text Claude gets, cut to a budget so a huge page never
 *                   floods the conversation (test/apaki-browser-outline.test.js).
 */

export const LIBRARY_VERSION = 3;

/* ---------- inside the page ---------- */

/**
 * Installed in the page's isolated world (serialized with toString, so it
 * must not use anything from this module). Safe to call again: it keeps the
 * refs it already gave out.
 */
export function pageLibrary(version) {
  const old = window.__apaki;
  if (old && old.v === version) return old;
  const A = { v: version, seq: old?.seq || 0, ids: old?.ids || new WeakMap(), refs: old?.refs || new Map() };

  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const refOf = (el) => {
    let r = A.ids.get(el);
    if (!r) { r = ++A.seq; A.ids.set(el, r); }
    A.refs.set(r, new WeakRef(el));
    return r;
  };

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE', 'PARAM', 'SOURCE', 'TRACK']);
  const INPUT_ROLE = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', color: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
  };
  const CONTROL = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
  const CONTAINER = new Set(['navigation', 'main', 'complementary', 'form', 'dialog', 'alertdialog', 'banner', 'contentinfo', 'region', 'search', 'article', 'group', 'menu', 'menubar', 'tablist', 'tree', 'radiogroup', 'toolbar', 'listbox', 'tabpanel', 'alert', 'status']);
  const LANDMARK = { NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog', ARTICLE: 'article', FIELDSET: 'group', SEARCH: 'search' };
  const CONTROL_SELECTOR = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable=""], [contenteditable=true], [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [role=textbox], [role=combobox], [role=searchbox], [role=slider]';
  const BLOCK = /^(block|flex|grid|table|list-item|flow-root|table-row|table-cell|table-caption|-webkit-box)/;

  function roleOf(el) {
    const given = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (given && given !== 'presentation' && given !== 'none' && given !== 'generic') return given;
    const t = el.tagName;
    if (t === 'A' || t === 'AREA') return el.hasAttribute('href') ? 'link' : null;
    if (t === 'BUTTON') return 'button';
    if (t === 'INPUT') { const ty = String(el.type || 'text').toLowerCase(); return ty === 'hidden' ? 'hidden' : INPUT_ROLE[ty] || 'textbox'; }
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (t === 'SUMMARY') return 'button';
    if (/^H[1-6]$/.test(t)) return 'heading';
    if (t === 'IMG') return 'img';
    if (t === 'UL' || t === 'OL' || t === 'MENU') return 'list';
    if (t === 'LI') return 'listitem';
    if (t === 'TABLE') return 'table';
    if (t === 'TR') return 'row';
    if (t === 'IFRAME' || t === 'FRAME') return 'iframe';
    if (t === 'VIDEO' || t === 'AUDIO') return t.toLowerCase();
    if (t === 'CANVAS') return 'canvas';
    if (t === 'HEADER' || t === 'FOOTER') return el.parentElement?.closest('article, aside, main, nav, section') ? null : t === 'HEADER' ? 'banner' : 'contentinfo';
    if (t === 'SECTION') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
    if (LANDMARK[t]) return LANDMARK[t];
    if (t.toLowerCase() === 'svg') return el.getAttribute('aria-label') || el.querySelector?.(':scope > title') ? 'img' : 'svg';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return null;
  }

  /** The text of the elements an aria-labelledby names (looked up in el's own shadow root first). */
  const byIds = (ids, el) => {
    const root = el.getRootNode?.();
    return ids.split(/\s+/).map((id) => root?.getElementById?.(id) || document.getElementById(id)).filter(Boolean).map((e) => clean(e.innerText || e.textContent)).join(' ');
  };
  const labelText = (label, control) => { const c = label.cloneNode(true); for (const x of c.querySelectorAll('input, select, textarea, button')) x.remove(); return clean(c.textContent); };
  const shortHref = (el) => { try { const u = new URL(el.href, location.href); return clean(u.pathname.split('/').filter(Boolean).pop() || u.host); } catch { return ''; } };

  function nameOf(el, role) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const n = byIds(lb, el); if (n) return n; }
    const al = clean(el.getAttribute('aria-label'));
    if (al) return al;
    const t = el.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') {
      if (el.labels?.length) { const n = clean([...el.labels].map((l) => labelText(l, el)).join(' ')); if (n) return n; }
      if (t === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value) || (el.type === 'reset' ? 'Reset' : 'Submit');
      if (t === 'INPUT' && el.type === 'image') return clean(el.alt) || 'Submit';
      return clean(el.placeholder) || clean(el.title) || clean(el.getAttribute('name')) || '';
    }
    if (t === 'IMG') return clean(el.alt) || clean(el.title);
    const text = clean(el.innerText ?? el.textContent);
    if (text) return text;
    const img = el.querySelector?.('img[alt]:not([alt=""]), [aria-label]');
    if (img) return clean(img.getAttribute('alt') || img.getAttribute('aria-label'));
    return clean(el.title) || (role === 'link' ? shortHref(el) : '');
  }

  function containerName(el, role) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const n = byIds(lb, el); if (n) return n; }
    const al = clean(el.getAttribute('aria-label'));
    if (al) return al;
    if (el.tagName === 'FIELDSET') return clean(el.querySelector(':scope > legend')?.textContent);
    if (role === 'dialog' || role === 'alertdialog') return clean(el.querySelector('h1, h2, h3')?.textContent);
    if (el.tagName === 'FORM') return clean(el.getAttribute('name'));
    return '';
  }

  function states(el, role) {
    const s = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
      const on = el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true';
      s.push(on ? 'checked' : 'unchecked');
    }
    const ex = el.getAttribute('aria-expanded');
    if (ex) s.push(ex === 'true' ? 'expanded' : 'collapsed');
    else if (el.tagName === 'SUMMARY') s.push(el.parentElement?.open ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') s.push('current');
    if (el.required || el.getAttribute('aria-required') === 'true') s.push('required');
    if (el.readOnly) s.push('readonly');
    if (el.getAttribute('aria-invalid') === 'true') s.push('invalid');
    if (document.activeElement === el) s.push('focused');
    return s;
  }

  function valueOf(el, role) {
    if (el.tagName === 'SELECT') return [...el.selectedOptions].map((x) => clean(x.textContent)).join(', ');
    if (!['textbox', 'searchbox', 'spinbutton', 'combobox', 'slider'].includes(role)) return '';
    if (el.isContentEditable && !('value' in el)) return cut(clean(el.innerText), 200);
    const v = String(el.value ?? el.getAttribute('aria-valuenow') ?? '');
    if (el.type === 'password') return v ? '•'.repeat(Math.min(v.length, 12)) : '';
    return cut(v.replace(/\s+/g, ' '), 200);
  }

  /** A short "role "name"" for messages. */
  function describe(el) {
    const role = roleOf(el) || el.tagName.toLowerCase();
    const n = cut(nameOf(el, role), 60);
    return n ? `${role} "${n}"` : role;
  }

  /**
   * The page as nodes: { d: depth, k: kind, n?: name, r?: ref, v?: value,
   * s?: states, h?: href, l?: level, t?: text, c?: count, o?: options }.
   */
  A.collect = (opts = {}) => {
    const MAX = opts.maxNodes || 5000;
    const nodes = [];
    let truncated = false;
    let buf = '';
    let bufDepth = 0;
    const push = (n) => { if (nodes.length >= MAX) { truncated = true; return false; } nodes.push(n); return true; };
    const flush = () => { const t = clean(buf); buf = ''; if (t) push({ d: bufDepth, k: 'text', t: cut(t, 1200) }); };
    const addText = (s, d) => { if (!buf.trim()) bufDepth = d; buf += s; };

    function control(el, role, d, cs) {
      const n = cut(nameOf(el, role), 160);
      const node = { d, k: role, n, r: refOf(el) };
      const s = states(el, role);
      if (s.length) node.s = s;
      const v = valueOf(el, role);
      if (v) node.v = v;
      if (role === 'link' && el.href) node.h = el.href;
      if (el.tagName === 'SELECT') {
        const o = [...el.options].map((x) => clean(x.textContent)).filter(Boolean);
        node.o = o.slice(0, 12);
        if (o.length > 12) node.c = o.length;
      }
      // A link or button in the middle of a sentence stays in the sentence.
      const inline = cs && !BLOCK.test(cs.display) && (role === 'link' || role === 'button') && buf.trim();
      if (inline) { buf += ` [${role} "${cut(n, 80)}" ref=${node.r}${s.includes('disabled') ? ' disabled' : ''}] `; return; }
      flush();
      push(node);
    }

    function walk(parent, d, controlsOnly) {
      const kids = parent.shadowRoot ? [...parent.shadowRoot.childNodes, ...parent.childNodes] : parent.childNodes;
      for (const c of kids) {
        if (truncated) return;
        if (c.nodeType === 3) { if (!controlsOnly) addText(c.nodeValue, d); continue; }
        if (c.nodeType === 1) visit(c, d, controlsOnly);
        else if (c.nodeType === 11) walk(c, d, controlsOnly);
      }
    }

    function visit(el, d, controlsOnly) {
      const t = el.tagName;
      if (SKIP.has(t)) return;
      if (el.hidden || el.inert || el.getAttribute('aria-hidden') === 'true') return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      const role = roleOf(el);
      if (role === 'hidden') return;
      const formish = t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA';
      // Hidden by visibility or opacity: its children may still show (form
      // controls hidden behind a styled label still get a ref).
      if ((cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') && !formish) { if (cs.opacity !== '0') walk(el, d, controlsOnly); return; }
      if (t === 'BR') { if (!controlsOnly) addText('\n', d); return; }
      // A label's words are already its field's name: only the controls in it are read.
      if (t === 'LABEL' && el.control) { walk(el, d, true); return; }
      const block = BLOCK.test(cs.display);

      // A <select> is one control (multiple or not); an ARIA combobox that wraps its own input is read through the input.
      if (t === 'SELECT' || (role && CONTROL.has(role) && !(role === 'combobox' && t !== 'INPUT' && el.querySelector('input')))) { control(el, role, d, cs); return; }
      if (controlsOnly) { walk(el, d, true); return; }

      if (role === 'heading') {
        flush();
        const l = Number(el.getAttribute('aria-level')) || Number(t[1]) || 2;
        push({ d, k: 'heading', n: cut(nameOf(el, role), 240), l });
        walk(el, d + 1, true);
        return;
      }
      if (role === 'img') { const n = cut(nameOf(el, role), 200); if (n) { flush(); push({ d, k: 'img', n }); } return; }
      if (role === 'svg') return;
      if (role === 'canvas') { flush(); push({ d, k: 'canvas', n: `${el.width}x${el.height}` }); return; }
      if (role === 'video' || role === 'audio') { flush(); push({ d, k: role, n: cut(clean(el.getAttribute('aria-label') || el.title || el.currentSrc || ''), 160), r: refOf(el) }); return; }
      if (role === 'iframe') {
        flush();
        let doc = null;
        try { doc = el.contentDocument; } catch { doc = null; }
        push({ d, k: 'iframe', n: cut(clean(el.title || el.name || el.src), 160), t: doc?.body ? '' : 'its content is from another site and is not read here' });
        if (doc?.body) { walk(doc.body, d + 1, false); flush(); }
        return;
      }
      if (role === 'list' || role === 'table' || role === 'grid' || CONTAINER.has(role)) {
        flush();
        const at = nodes.length;
        const node = { d, k: role === 'grid' ? 'table' : role };
        const n = role === 'table' || role === 'grid' ? clean(el.caption?.textContent || el.getAttribute('aria-label')) : containerName(el, role);
        if (n) node.n = cut(n, 160);
        if (role === 'list') node.c = el.children.length;
        if (role === 'table' || role === 'grid') node.c = el.rows?.length || el.querySelectorAll('[role=row]').length;
        push(node);
        walk(el, d + 1, false);
        flush();
        // An empty container says nothing.
        if (nodes.length === at + 1 && nodes[at] === node) nodes.pop();
        return;
      }
      if (role === 'listitem') {
        flush();
        const at = nodes.length;
        walk(el, d + 1, false);
        flush();
        const kids = nodes.splice(at);
        if (!kids.length) return;
        if (kids.length === 1 && kids[0].k === 'text') { push({ d, k: 'listitem', t: kids[0].t }); return; }
        if (kids.length === 1) { kids[0].d = d; push(kids[0]); return; }
        const first = kids[0].k === 'text' ? kids.shift() : null;
        push({ d, k: 'listitem', t: first?.t || '' });
        for (const k of kids) if (!push(k)) break;
        return;
      }
      if (role === 'row') {
        flush();
        const cells = [...el.children].filter((c) => /^(TD|TH)$/.test(c.tagName) || /cell|header/.test(c.getAttribute('role') || ''));
        push({ d, k: 'row', t: cells.map((c) => cut(clean(c.innerText), 90)).join(' | ') });
        for (const c of cells) walk(c, d + 1, true);
        return;
      }
      // Something clickable without a role (a div with a click handler): the
      // outermost element with a pointer cursor and no real control inside.
      if (!role && (el.hasAttribute('onclick') || (cs.cursor === 'pointer' && el.parentElement && getComputedStyle(el.parentElement).cursor !== 'pointer') || (el.hasAttribute('tabindex') && el.tabIndex >= 0)) && !el.querySelector(CONTROL_SELECTOR)) {
        const n = cut(nameOf(el, null), 120);
        if (n) { flush(); push({ d, k: 'clickable', n, r: refOf(el) }); return; }
      }
      if (block) flush();
      walk(el, d, false);
      if (block) flush();
    }

    if (document.body) walk(document.body, 0, false);
    flush();
    const vv = window.visualViewport;
    const se = document.scrollingElement || document.documentElement;
    return {
      title: document.title || '',
      url: location.href,
      view: { w: innerWidth, h: innerHeight, x: Math.round(vv?.pageLeft ?? scrollX), y: Math.round(vv?.pageTop ?? scrollY), sw: se?.scrollWidth || innerWidth, sh: se?.scrollHeight || innerHeight },
      ready: document.readyState,
      nodes,
      truncated,
    };
  };

  /** The element for a ref, scrolled into view, with the point a real click would hit. */
  A.target = (ref, scroll = true) => {
    const el = A.refs.get(ref)?.deref();
    if (!el || !el.isConnected) return { stale: true };
    if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    // A link that wraps onto two lines has a bounding box whose middle is
    // between the lines, on the paragraph: aim at its largest line fragment.
    const frags = [...el.getClientRects()].filter((q) => q.width >= 1 && q.height >= 1);
    const r = frags.sort((a, b) => b.width * b.height - a.width * a.height)[0] || el.getBoundingClientRect();
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    // Elements in a same-site frame: add the frames' offsets.
    let win = el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const fe = win.frameElement;
      const fr = fe.getBoundingClientRect();
      x += fr.left + fe.clientLeft;
      y += fr.top + fe.clientTop;
      win = win.parent;
    }
    const visible = r.width >= 1 && r.height >= 1 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    const hit = visible ? document.elementFromPoint(x, y) : null;
    // The point must land on the element itself (or its label). An ancestor
    // there (the paragraph around a link) means a real click would miss it,
    // so the tool clicks it directly instead.
    const own = (h) => h && (h === el || el.contains(h) || [...(el.labels || [])].some((l) => l === h || l.contains(h)) || h.closest?.('label')?.control === el);
    const ok = el.ownerDocument === document ? own(hit) : visible;
    return { x: Math.round(x), y: Math.round(y), visible, ok: Boolean(ok), cover: hit && !ok ? describe(hit) : null, desc: describe(el), tag: el.tagName, type: String(el.type || '') };
  };

  /** Clicks a ref the way a script would (for elements a real click cannot reach). */
  A.clickJs = (ref) => {
    const el = A.refs.get(ref)?.deref();
    if (!el || !el.isConnected) return { stale: true };
    el.focus?.({ preventScroll: true });
    el.click();
    return { ok: true, desc: describe(el) };
  };

  /**
   * Gets a field ready for typing: focused, its text selected so typing
   * replaces it. A <select> picks the option instead (by its text or value).
   */
  A.prepType = (ref, text) => {
    let el = A.refs.get(ref)?.deref();
    if (!el || !el.isConnected) return { stale: true };
    const desc = describe(el);
    if (el.tagName === 'SELECT') {
      const want = clean(text).toLowerCase();
      const opts = [...el.options];
      const o = opts.find((x) => clean(x.textContent).toLowerCase() === want) || opts.find((x) => x.value.toLowerCase() === want) || opts.find((x) => clean(x.textContent).toLowerCase().includes(want));
      if (!o) return { error: `${desc} has no option "${text}".`, options: opts.slice(0, 40).map((x) => clean(x.textContent)) };
      el.value = o.value;
      o.selected = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: clean(o.textContent), desc };
    }
    if (el.tagName === 'INPUT' && ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(el.type)) return { error: `${desc} is a ${el.type}, not a text field; use browser_click on it.` };
    const editable = (x) => x.tagName === 'INPUT' || x.tagName === 'TEXTAREA' || x.isContentEditable;
    if (!editable(el)) {
      const inner = el.querySelector('input:not([type=hidden]), textarea, [contenteditable=""], [contenteditable=true]');
      if (!inner) return { error: `${desc} is not a text field.` };
      el = inner;
    }
    if (el.disabled || el.readOnly) return { error: `${desc} is ${el.disabled ? 'disabled' : 'read-only'}.` };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    el.focus();
    if (typeof el.select === 'function') { try { el.select(); } catch { /* some input types cannot select */ } }
    else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    const active = el.ownerDocument.activeElement;
    return { ok: true, desc, focused: active === el || el.contains(active) };
  };

  /** A field's value now (passwords masked), for the report after typing. */
  A.valueNow = (ref) => {
    let el = A.refs.get(ref)?.deref();
    if (!el || !el.isConnected) return { stale: true };
    if (!(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) el = el.querySelector('input:not([type=hidden]), textarea, [contenteditable=""], [contenteditable=true]') || el;
    const role = roleOf(el) || 'textbox';
    return { value: valueOf(el, role === 'combobox' && el.tagName !== 'SELECT' ? 'textbox' : role) };
  };

  A.view = () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, x: window.visualViewport?.pageLeft ?? scrollX, y: window.visualViewport?.pageTop ?? scrollY });

  window.__apaki = A;
  return A;
}

/** The expression that installs the library (if needed) and calls one of its functions. */
export function pageCall(fn, ...args) {
  return `(${pageLibrary.toString()})(${LIBRARY_VERSION}).${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
}

/* ---------- in the engine: the outline Claude reads ---------- */

export const DEFAULT_MAX_CHARS = 12000;
const MARKER = /\[(?:link|button) "[^"]*" ref=\d+(?: disabled)?\]/g;
const LINE_CAP = 400;
const TIGHT_CAP = 160;

const q = (s) => `"${String(s).replace(/"/g, '\'')}"`;

/** Cuts a text line but keeps the refs that were in the cut part. */
export function cutText(t, n) {
  if (t.length <= n) return t;
  const head = t.slice(0, n).replace(/\s+\S*$/, '');
  const kept = head.match(MARKER) || [];
  const all = t.match(MARKER) || [];
  // A marker split by the cut is dropped from the head and listed after it.
  const safeHead = head.replace(/\[(?:link|button) "[^\]]*$/, '').trimEnd();
  const rest = all.slice(kept.length);
  return `${safeHead}…${rest.length ? ` ${rest.join(' ')}` : ''}`;
}

/** Turns an address into what the outline shows: a path on the same site, else the whole address. */
export function shortUrl(href, base) {
  try {
    const u = new URL(href, base);
    const b = base ? new URL(base) : null;
    if (u.protocol === 'javascript:') return 'javascript';
    const s = b && u.origin === b.origin ? `${u.pathname}${u.search}${u.hash}` : u.href;
    return s.length > 100 ? `${s.slice(0, 99)}…` : s;
  } catch {
    return String(href).slice(0, 100);
  }
}

/** One node as one outline line (without its indent). */
export function nodeLine(n, base) {
  const st = n.s?.length ? ` [${n.s.join(', ')}]` : '';
  const ref = n.r != null ? ` [ref=${n.r}]` : '';
  switch (n.k) {
    case 'text': return `text: ${n.t}`;
    case 'heading': return `heading ${q(n.n || '')} [level=${n.l || 2}]`;
    case 'img': return `img ${q(n.n)}`;
    case 'canvas': return `canvas ${n.n} (drawn, not text; use browser_screenshot)`;
    case 'link': return `link ${q(n.n || '')}${ref}${st}${n.h ? ` -> ${shortUrl(n.h, base)}` : ''}`;
    case 'listitem': return n.t ? `listitem: ${n.t}` : 'listitem:';
    case 'list': return `list${n.n ? ` ${q(n.n)}` : ''}${n.c ? ` (${n.c} items)` : ''}:`;
    case 'table': return `table${n.n ? ` ${q(n.n)}` : ''}${n.c ? ` (${n.c} rows)` : ''}:`;
    case 'row': return `row: ${n.t}`;
    case 'iframe': return `iframe ${q(n.n || '')}${n.t ? ` (${n.t})` : ':'}`;
    case 'video': case 'audio': return `${n.k} ${q(n.n || '')}${ref}`;
    default: {
      if (n.r != null) {
        const opts = n.o?.length ? ` (options: ${n.o.join(', ')}${n.c > n.o.length ? `, … ${n.c - n.o.length} more` : ''})` : '';
        return `${n.k} ${q(n.n || '')}${ref}${st}${n.v ? `: ${q(n.v)}` : ''}${opts}`;
      }
      // A container: navigation, form, dialog, region...
      return `${n.k}${n.n ? ` ${q(n.n)}` : ''}:`;
    }
  }
}

/** Where the view is on the page, in words. */
export function viewLine(v) {
  if (!v) return '';
  const pageH = Math.max(v.sh || v.h, v.h);
  if (pageH <= v.h + 4) return `View: ${v.w}x${v.h}; the whole page fits in view.`;
  const pct = Math.round((Math.min(v.y + v.h, pageH) / pageH) * 100);
  const where = v.y <= 4 ? 'the top' : v.y + v.h >= pageH - 4 ? 'the bottom' : `${pct}% down`;
  return `View: ${v.w}x${v.h} at ${where} of a ${pageH}px page (the outline covers the whole page).`;
}

/**
 * The text Claude gets for a page.
 * @param snap   collect()'s result plus optional { error, status, loading } from the browser
 * @param o.maxChars  budget for the outline (default 12000)
 * @param o.from      1-based outline line to start at (to read on after a cut)
 */
export function formatOutline(snap, { maxChars = DEFAULT_MAX_CHARS, from = 1 } = {}) {
  const head = [`Page: ${snap.title || '(no title)'}`, `URL: ${snap.url || ''}`];
  if (snap.status && snap.status >= 400) head.push(`HTTP ${snap.status}`);
  if (snap.error) head.push(`This page did not load: ${snap.error}.`);
  if (snap.loading) head.push('Still loading; this is what has arrived so far.');
  const vl = viewLine(snap.view);
  if (vl) head.push(vl);
  const nodes = Array.isArray(snap.nodes) ? snap.nodes : [];
  if (!nodes.length) {
    head.push('', 'The page has no readable content yet. It may still be loading, or it draws everything itself (a canvas); browser_screenshot shows how it looks.');
    return head.join('\n');
  }
  const minD = Math.min(...nodes.map((n) => n.d || 0));
  const all = nodes.map((n, i) => ({ i: i + 1, d: (n.d || 0) - minD, n, text: n.k === 'text' || n.k === 'listitem' || n.k === 'row' ? null : nodeLine(n, snap.url) }));
  const totalRefs = nodes.filter((n) => n.r != null).length + nodes.reduce((k, n) => k + ((n.t || '').match(MARKER)?.length || 0), 0);
  const start = Math.max(1, Math.min(from, all.length)) - 1;
  let lines = all.slice(start);

  const render = (cap) => lines.map((x) => {
    let s = x.text;
    if (s == null) {
      const n = x.n;
      const t = cutText(n.t || '', cap);
      s = n.k === 'text' ? `text: ${t}` : n.k === 'row' ? `row: ${t}` : t ? `listitem: ${t}` : 'listitem:';
    }
    return { ...x, s: `${'  '.repeat(x.d)}- ${s}` };
  });
  const size = (ls) => ls.reduce((k, x) => k + x.s.length + 1, 0);

  // 1. Long text lines cut to 400 characters, then to 160 if that is not enough.
  let out = render(LINE_CAP);
  if (size(out) > maxChars) out = render(TIGHT_CAP);
  // 2. Runs of plain text: the first line of each run stays, the rest is counted.
  if (size(out) > maxChars) {
    const kept = [];
    for (let k = 0; k < out.length; k++) {
      const x = out[k];
      if (x.n.k !== 'text') { kept.push(x); continue; }
      let j = k;
      while (j + 1 < out.length && out[j + 1].n.k === 'text' && out[j + 1].d === x.d) j++;
      kept.push(x);
      const dropped = out.slice(k + 1, j + 1);
      const refsIn = dropped.flatMap((y) => y.s.match(MARKER) || []);
      if (dropped.length) kept.push({ ...dropped[0], s: `${'  '.repeat(x.d)}- text: … (${dropped.length} more line${dropped.length > 1 ? 's' : ''} of text${refsIn.length ? `, with ${refsIn.join(' ')}` : ''})` });
      k = j;
    }
    out = kept;
  }
  // 3. Still too long: stop at the budget and say how to read on.
  let tail = '';
  if (size(out) > maxChars) {
    let used = 0;
    let k = 0;
    for (; k < out.length; k++) { if (used + out[k].s.length + 1 > maxChars) break; used += out[k].s.length + 1; }
    const rest = out.slice(k);
    const next = rest[0]?.i;
    const refsLeft = rest.filter((x) => x.n.r != null).length + rest.reduce((a, x) => a + ((x.s.match(MARKER) || []).length), 0);
    out = out.slice(0, Math.max(1, k));
    tail = `… the outline stops here: ${all.length - (next || all.length) + 1} more lines${refsLeft ? ` with ${refsLeft} more refs` : ''} below. Call browser_read with from=${next} to read on.`;
  }
  const body = out.map((x) => x.s).join('\n');
  const foot = tail || `${start ? `Lines ${start + 1}-${all.length} of ${all.length}` : `${all.length} lines`}, ${totalRefs} refs. browser_click and browser_type take a ref.`;
  return `${head.join('\n')}\n\n${body}\n\n${foot}`;
}

/** "12", 12, "[12]", "ref=12", "e12" -> 12, or null. */
export function normalizeRef(ref) {
  if (typeof ref === 'number' && Number.isInteger(ref) && ref > 0) return ref;
  const m = String(ref ?? '').match(/^\s*\[?\s*(?:ref\s*=\s*|e)?(\d+)\s*\]?\s*$/i);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}
