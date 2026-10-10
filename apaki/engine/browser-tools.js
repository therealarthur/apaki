/**
 * browser-tools.js: Claude's tools for Apaki's built-in browser.
 *
 * WHY (Arthur, 2026-10-09: "a built-in browser like Codex's, driven by
 * Claude, light and fast"): Claude can open a page beside the conversation
 * (a dev server it just started, docs, any site), read it as text with
 * numbered refs, click and type through those refs, go back, and look at it.
 * The user watches the same browser.
 *
 * Tools on the in-process "apaki" MCP server (apaki-tools.js adds them):
 *   browser_open {url, paneHint?}  open or reuse this conversation's browser; waits for the load
 *   browser_read {from?, maxChars?} the page as an outline with refs (browser-page.js)
 *   browser_click {ref}            a real mouse click at the element (scrolled into view)
 *   browser_type {ref, text, submit?} replaces a field's text, picks a <select> option, Enter if submit
 *   browser_back                   the previous page
 *   browser_screenshot             PNG of what is in view, at most 1280 px wide
 *
 * Everything goes through the shell (shell-channel.js): browser.open, .nav,
 * .state and .cdp, the last being WebView2's own DevTools protocol channel.
 * Reading and finding elements run in an isolated world (Page.createIsolatedWorld)
 * so the page cannot tamper with them; clicks and keys are trusted input
 * events (Input.dispatchMouseEvent, Input.insertText, Input.dispatchKeyEvent).
 * No remote debugging port, no Playwright, nothing injected into the page's
 * own world.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { DEFAULT_MAX_CHARS, formatOutline, normalizeRef, pageCall } from './browser-page.js';

export const BROWSER_TOOLS = ['browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_back', 'browser_screenshot'];
export const SCREENSHOT_MAX_WIDTH = 1280;
const OPEN_TIMEOUT_MS = 25000;
const SETTLE_QUICK_MS = 450;
const SETTLE_MAX_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const BROWSER_PROMPT = 'Apaki also has a built-in browser beside this conversation that you can use yourself: mcp__apaki__browser_open opens a page (a local dev server or any site), browser_read returns it as text with numbered refs, browser_click and browser_type act on those refs, browser_back goes back, and browser_screenshot shows you how it looks. The user sees the same browser. Use it to check web work you build, instead of asking the user to look.';

/** Width and height of a PNG from its header. */
export function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** The clip and scale that keep a screenshot of the view at most `max` pixels wide. */
export function screenshotClip(view, max = SCREENSHOT_MAX_WIDTH) {
  const w = Math.max(1, Math.round(view.w));
  const h = Math.max(1, Math.round(view.h));
  const dpr = Number(view.dpr) || 1;
  const scale = Math.min(1, max / (w * dpr));
  return { x: Math.max(0, view.x || 0), y: Math.max(0, view.y || 0), width: w, height: h, scale: Math.floor(scale * 1000) / 1000 };
}

const short = (s, n = 70) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const where = (st) => `${st.url}${st.title ? ` ("${short(st.title)}")` : ''}`;

/**
 * @param {object} o
 * @param {ReturnType<import('./shell-channel.js').createShell>} o.shell
 * @param {() => string} o.owner   the pane (conversation) these tools belong to
 * @param {(a: {browserId, action, text}) => void} [o.onActivity]  what Claude just did, for the window
 */
export function createBrowserTools({ shell, owner, onActivity = () => {} }) {
  const worlds = new Map(); // browser id -> { frameId, loaderId, contextId }
  const req = (cmd, args = {}, opts) => shell.request(`browser.${cmd}`, { owner: owner(), ...args }, opts);
  const activity = (st, action, text) => { try { onActivity({ browserId: st?.id || null, action, text }); } catch { /* the window may be gone */ } };

  async function cdp(method, params = {}, { render = false, timeout = 15000 } = {}) {
    return req('cdp', { method, params, render }, { timeout });
  }

  /** The isolated world for the current document (made again after a navigation). */
  async function world(fresh = false) {
    const tree = await cdp('Page.getFrameTree');
    const frame = tree.result?.frameTree?.frame;
    if (!frame) throw new Error('The browser has no page yet.');
    const have = worlds.get(tree.id);
    if (!fresh && have && have.frameId === frame.id && have.loaderId === frame.loaderId) return { id: tree.id, contextId: have.contextId, loaderId: frame.loaderId };
    const w = await cdp('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'apaki', grantUniveralAccess: false });
    const contextId = w.result?.executionContextId;
    if (!contextId) throw new Error('Could not reach the page.');
    worlds.set(tree.id, { frameId: frame.id, loaderId: frame.loaderId, contextId });
    return { id: tree.id, contextId, loaderId: frame.loaderId };
  }

  /** Runs one page-library call in the isolated world; returns its value and the document it ran in. */
  async function page(fn, ...args) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let w;
      try {
        w = await world(attempt > 0);
        const r = await cdp('Runtime.evaluate', { expression: pageCall(fn, ...args), contextId: w.contextId, returnByValue: true, awaitPromise: true, timeout: 8000 });
        const ex = r.result?.exceptionDetails;
        if (ex) throw new Error(ex.exception?.description?.split('\n')[0] || ex.text || 'the page threw');
        return { value: r.result?.result?.value, loaderId: w.loaderId, id: r.id };
      } catch (e) {
        lastError = e;
        // The document changed under us (a navigation): make the world again once.
        if (!/context|world|frame|Execution/i.test(String(e.message))) throw e;
        if (w) worlds.delete(w.id);
      }
    }
    throw lastError;
  }

  /** Waits for a navigation the last action may have started; returns the state after. */
  async function settle(before) {
    const t0 = Date.now();
    let st = await req('state');
    let saw = Boolean(st.loading);
    while (Date.now() - t0 < SETTLE_MAX_MS) {
      if (st.loading) saw = true;
      if (!st.loading && (saw || Date.now() - t0 >= SETTLE_QUICK_MS)) break;
      await sleep(120);
      st = await req('state');
    }
    return { st, navigated: saw || st.url !== before?.url };
  }

  const STALE = (ref) => `Ref ${ref} is not on the page any more (it changed or went to another page since browser_read). Call browser_read again for fresh refs.`;
  const ok = (text, extra = {}) => ({ ok: true, text, ...extra });
  const fail = (e) => ({ ok: false, text: String(e?.message || e) });

  async function open({ url, paneHint } = {}) {
    try {
      const u = String(url || '').trim();
      if (!/^(https?:\/\/|file:\/\/\/)\S+$/i.test(u)) return fail(`"${u}" is not an http(s) or file:/// address.`);
      const hint = ['new', 'tab'].includes(paneHint) ? paneHint : 'reuse';
      let st;
      try {
        st = await req('open', { url: u, hint, wait: true, reason: 'claude' }, { timeout: OPEN_TIMEOUT_MS });
      } catch (e) {
        if (e.code !== 'TIMEOUT') throw e;
        st = await req('state');
        activity(st, 'open', `Opened ${u}`);
        return ok(`Opened ${u} in Apaki's browser; it is still loading after ${OPEN_TIMEOUT_MS / 1000} s. browser_read reads what has arrived.`);
      }
      activity(st, 'open', `Opened ${short(st.url, 60)}`);
      if (st.error) return { ok: false, text: `Apaki's browser could not load ${u}: ${st.error}. The browser shows its error page.` };
      return ok(`Opened ${where(st)} in Apaki's browser beside this conversation${st.status ? ` (HTTP ${st.status})` : ''}. Call browser_read to read it with refs to click and type into, or browser_screenshot to see it.`);
    } catch (e) { return fail(e); }
  }

  async function read({ from, maxChars } = {}) {
    try {
      const st = await req('state');
      const r = await page('collect', { maxNodes: 6000 });
      const snap = { ...r.value, status: st.status, error: st.error, loading: st.loading };
      activity(st, 'read', 'Read the page');
      return ok(formatOutline(snap, { maxChars: Math.min(40000, Math.max(2000, Number(maxChars) || DEFAULT_MAX_CHARS)), from: Math.max(1, Number(from) || 1) }));
    } catch (e) { return fail(e); }
  }

  async function click({ ref } = {}) {
    try {
      const n = normalizeRef(ref);
      if (!n) return fail(`"${ref}" is not a ref; use a number from browser_read, like 12.`);
      const before = await req('state');
      const t = (await page('target', n, true)).value;
      if (!t || t.stale) return fail(STALE(n));
      let how = '';
      if (t.ok) {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await cdp('Input.dispatchMouseEvent', { type, x: t.x, y: t.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse' });
        }
      } else {
        // Covered by something else, or not on screen: click it the way a script would.
        const r = (await page('clickJs', n)).value;
        if (!r || r.stale) return fail(STALE(n));
        how = t.cover ? ` (it was covered by ${t.cover}, so it was clicked directly)` : ' (it is not visible, so it was clicked directly)';
      }
      const { st, navigated } = await settle(before);
      activity(st, 'click', `Clicked ${short(t.desc, 50)}`);
      return ok(`Clicked [${n}] ${t.desc}${how}. ${navigated ? `Now at ${where(st)}${st.error ? `, which did not load: ${st.error}` : ''}.` : 'The page stayed at the same address.'} Call browser_read to see what changed.`);
    } catch (e) { return fail(e); }
  }

  async function type({ ref, text = '', submit = false } = {}) {
    try {
      const n = normalizeRef(ref);
      if (!n) return fail(`"${ref}" is not a ref; use a number from browser_read, like 12.`);
      const value = String(text ?? '');
      const before = await req('state');
      const p = (await page('prepType', n, value)).value;
      if (!p || p.stale) return fail(STALE(n));
      if (p.error) return fail(`${p.error}${p.options ? ` Options: ${p.options.join(', ')}.` : ''}`);
      if (p.selected) {
        activity(before, 'type', `Picked ${short(p.selected, 40)}`);
        return ok(`Picked "${p.selected}" in [${n}] ${p.desc}.`);
      }
      if (value) await cdp('Input.insertText', { text: value });
      else await keys('Delete', 46);
      if (submit) await keys('Enter', 13, '\r');
      const now = (await page('valueNow', n).catch(() => ({ value: null }))).value;
      const { st, navigated } = submit ? await settle(before) : { st: before, navigated: false };
      activity(st, 'type', `Typed into ${short(p.desc, 44)}`);
      const shown = now && !now.stale ? ` It now reads "${short(now.value, 120)}".` : '';
      const after = submit ? (navigated ? ` Pressed Enter; now at ${where(st)}.` : ' Pressed Enter; the page stayed at the same address.') : '';
      return ok(`Typed into [${n}] ${p.desc}.${shown}${after}`);
    } catch (e) { return fail(e); }
  }

  async function keys(key, code, text) {
    const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async function back() {
    try {
      const st = await req('nav', { action: 'back', wait: true }, { timeout: OPEN_TIMEOUT_MS });
      activity(st, 'back', 'Went back');
      return ok(`Went back to ${where(st)}.`);
    } catch (e) { return fail(e); }
  }

  async function screenshot() {
    try {
      const st = await req('state');
      const view = (await page('view')).value;
      let clip = screenshotClip(view);
      let data = null;
      let size = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const params = { format: 'png', captureBeyondViewport: false, ...(clip.scale < 1 ? { clip } : {}) };
        const r = await cdp('Page.captureScreenshot', params, { render: true, timeout: 20000 });
        data = r.result?.data;
        size = data ? pngSize(Buffer.from(data, 'base64')) : null;
        if (!size || size.w <= SCREENSHOT_MAX_WIDTH) break;
        // Scaled differently than asked: scale down to fit and take it again.
        clip = { ...screenshotClip(view), scale: Math.floor((clip.scale || 1) * (SCREENSHOT_MAX_WIDTH / size.w) * 1000) / 1000 };
      }
      if (!data) return fail('The browser returned no picture.');
      activity(st, 'screenshot', 'Took a screenshot');
      return ok(`Screenshot of ${where(st)}: the part in view, ${size ? `${size.w}x${size.h}` : 'PNG'}.`, { image: data, mimeType: 'image/png', width: size?.w, height: size?.h });
    } catch (e) { return fail(e); }
  }

  const run = { open, read, click, type, back, screenshot };

  /** Runs one tool by its short name (open, read...), for the engine's browserTool op and the MCP tools. */
  async function call(name, input = {}) {
    const f = run[String(name).replace(/^browser_/, '')];
    if (!f) return fail(`There is no browser tool "${name}".`);
    return f(input);
  }

  /** The MCP result for one tool's outcome. */
  const result = (r) => ({
    content: [{ type: 'text', text: r.text }, ...(r.image ? [{ type: 'image', data: r.image, mimeType: r.mimeType || 'image/png' }] : [])],
    isError: !r.ok,
  });

  const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const ACT = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  const refArg = () => z.union([z.number().int(), z.string()]).describe('A ref number from browser_read, like 12.');

  /** The tool definitions for createSdkMcpServer. */
  function sdkTools() {
    return [
      tool('browser_open', 'Open a web page in Apaki\'s built-in browser, beside this conversation, and wait for it to load. Use it to look at a local dev server you started or any site. It reuses this conversation\'s browser unless paneHint is "new" (another browser pane) or "tab" (a new tab). Then use browser_read.', {
        url: z.string().describe('An http(s) address, or file:/// for a local page that needs the network.'),
        paneHint: z.enum(['reuse', 'new', 'tab']).optional().describe('reuse (default), new, or tab'),
      }, async (a) => result(await open(a)), { annotations: { title: 'Open in Apaki\'s browser', ...RO } }),
      tool('browser_read', 'Read the page in Apaki\'s browser as text: title, address, and an outline of headings, text, links, buttons and fields. Each link, button and field has [ref=N] for browser_click and browser_type. Long pages are cut; the end says the from= to read on.', {
        from: z.number().int().min(1).optional().describe('Outline line to start at, to read on after a cut.'),
        maxChars: z.number().int().min(2000).max(40000).optional().describe('Budget for the outline (default 12000).'),
      }, async (a) => result(await read(a)), { annotations: { title: 'Read the page', ...RO } }),
      tool('browser_click', 'Click a link, button or other element in Apaki\'s browser by its ref from browser_read. Waits for a page it opens to load.', {
        ref: refArg(),
      }, async (a) => result(await click(a)), { annotations: { title: 'Click in the page', ...ACT } }),
      tool('browser_type', 'Type into a field in Apaki\'s browser by its ref from browser_read. Replaces what the field holds. For a dropdown (select), text picks the option with that label. submit: true presses Enter after.', {
        ref: refArg(),
        text: z.string().describe('What to type (or the option to pick).'),
        submit: z.boolean().optional().describe('Press Enter after typing.'),
      }, async (a) => result(await type(a)), { annotations: { title: 'Type in the page', ...ACT } }),
      tool('browser_back', 'Go back to the previous page in Apaki\'s browser.', {}, async () => result(await back()), { annotations: { title: 'Back', ...RO } }),
      tool('browser_screenshot', 'See the page in Apaki\'s browser: a PNG of the part in view, at most 1280 px wide.', {}, async () => result(await screenshot()), { annotations: { title: 'Screenshot the page', ...RO } }),
    ];
  }

  return { ...run, call, sdkTools, result, page, world };
}
