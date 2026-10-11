/**
 * browser-shell.mjs: a pretend of the Rust shell's built-in browser
 * (apaki/src/browser.rs) for the demo harness.
 *
 * The real shell makes a native WebView2 per browser pane and lays it over the
 * pane's body (the pane reports where with the `place` command, in physical
 * pixels). Here the "page" is an iframe in a div that is placed the same way,
 * filled from pages.mjs. The pane code (ui/browser.js) cannot tell the
 * difference: it sends the same commands and gets the same `browser` events
 * (created, state) back.
 *
 *   invoke(cmd, args)   the commands the window sends: open, place, go, nav,
 *                       focus, focusApp, close, list, snapshot, theme
 *   open / type / click / activity / shot   what a turn script calls to make
 *                       Claude "use" the page while the person watches
 */

import { pageFor, shotSvg } from './pages.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LOAD_MS = 520;
const TYPE_MS = 62;

export function createBrowserShell({ emitBrowser, emitEngine }) {
  const pages = new Map();
  let seq = 0;
  let dark = false;

  const stateOf = (p) => ({ url: p.url, title: p.title, loading: p.loading, canGoBack: p.idx > 0, canGoForward: p.idx < p.hist.length - 1, error: null, status: null });
  const push = (p) => emitBrowser({ ev: 'state', id: p.id, ...stateOf(p) });

  function mount(p) {
    const wrap = document.createElement('div');
    wrap.className = 'demo-page';
    wrap.dataset.page = p.id;
    wrap.style.display = 'none';
    const frame = document.createElement('iframe');
    frame.setAttribute('title', 'Page');
    wrap.append(frame);
    document.body.append(wrap);
    p.wrap = wrap;
    p.frame = frame;
  }

  /** Loads an address: the loading light, then the page. */
  async function load(p, url, { record = true } = {}) {
    p.loading = true;
    p.url = url;
    if (record) { p.hist = p.hist.slice(0, p.idx + 1); p.hist.push(url); p.idx = p.hist.length - 1; }
    push(p);
    await wait(LOAD_MS);
    const page = pageFor(url, { dark });
    p.title = page.title;
    p.frame.srcdoc = page.html;
    p.loading = false;
    push(p);
    // The page's document exists a moment after srcdoc is set.
    await wait(120);
  }

  const frameDoc = (p) => p?.frame?.contentDocument || null;

  /** A ring around an element in the page: what Claude is pointing at. */
  function ring(p, el) {
    const doc = frameDoc(p);
    if (!doc || !el) return;
    const r = el.getBoundingClientRect();
    const d = doc.createElement('div');
    d.className = 'ring';
    Object.assign(d.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    doc.body.append(d);
    setTimeout(() => d.remove(), 1200);
  }

  const api = {
    /** Makes a page beside `owner` (a pane id). Resolves with its id once loaded. */
    async open({ id = null, owner = null, url, focus = true, reason = 'card', hint = undefined }) {
      const pid = id || `bd${++seq}`;
      let p = pages.get(pid);
      if (p) { await load(p, url); return pid; }
      p = { id: pid, owner, url, title: '', loading: true, hist: [url], idx: 0 };
      pages.set(pid, p);
      mount(p);
      emitBrowser({ ev: 'created', id: pid, owner, url, focus, hint, state: stateOf(p) });
      await load(p, url, { record: false });
      return pid;
    },

    /** The activity line beside the pane's title ("Claude · click [7]"). */
    activity(id, text) { emitEngine({ ev: 'browserActivity', browserId: id, text }); },

    /** Types into a field of the page, a character at a time. */
    async type(id, selector, text) {
      const p = pages.get(id);
      const el = frameDoc(p)?.querySelector(selector);
      if (!el) return;
      ring(p, el);
      el.classList.add('focus');
      for (const ch of text) {
        el.value += ch;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(TYPE_MS);
      }
      el.classList.remove('focus');
    },

    /** Clicks an element of the page, with the ring first. */
    async click(id, selector) {
      const p = pages.get(id);
      const el = frameDoc(p)?.querySelector(selector);
      if (!el) return;
      ring(p, el);
      await wait(420);
      el.click();
    },

    /** A screenshot Claude "took": an SVG, base64, for the tool result. */
    shot(id) {
      const p = pages.get(id);
      return btoa(shotSvg({ dark: Boolean(p) && dark }));
    },

    /** The commands the window sends (invoke('browser', { cmd, args })). */
    async invoke(cmd, args = {}) {
      const p = pages.get(args.id);
      switch (cmd) {
        case 'open': {
          const id = await api.open({ id: args.id || null, owner: args.owner, url: args.url, focus: args.focus !== false, reason: args.reason });
          return { id };
        }
        case 'place': {
          if (!p) return null;
          const dpr = window.devicePixelRatio || 1;
          Object.assign(p.wrap.style, { left: `${args.x / dpr}px`, top: `${args.y / dpr}px`, width: `${args.w / dpr}px`, height: `${args.h / dpr}px`, display: args.visible ? 'block' : 'none' });
          return null;
        }
        case 'go': if (p) await load(p, args.url); return null;
        case 'nav': {
          if (!p) return null;
          if (args.action === 'back' && p.idx > 0) { p.idx -= 1; await load(p, p.hist[p.idx], { record: false }); }
          if (args.action === 'forward' && p.idx < p.hist.length - 1) { p.idx += 1; await load(p, p.hist[p.idx], { record: false }); }
          if (args.action === 'reload') await load(p, p.url, { record: false });
          return null;
        }
        case 'close': if (p) { p.wrap.remove(); pages.delete(p.id); } return null;
        case 'snapshot': return { dataUrl: null };
        case 'list': return { browsers: [...pages.keys()].map((id) => ({ id })) };
        case 'theme': {
          const next = Boolean(args.dark);
          if (next !== dark) { dark = next; for (const q of pages.values()) if (q.frame.srcdoc) q.frame.srcdoc = pageFor(q.url, { dark }).html; }
          return null;
        }
        default: return null;
      }
    },
  };
  return api;
}
