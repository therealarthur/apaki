/**
 * codeview.js: code and plain text in the viewer, with line numbers, syntax colours and a wrap switch (2026-10-13).
 *
 * WHY (Arthur, 2026-10-13: viewers like ChatGPT's side window, "art, spreadsheets, real browser, code, etc"): a code
 * file used to be one grey <pre>. Now each line has its number in a gutter (drawn by CSS from data-n, so it is never
 * copied or found by Ctrl+F), colours come from highlight.js (lazy.js loads it the first time), and long lines wrap
 * or scroll as you choose. The text draws at once without colours and gets them a moment later, so a big file never
 * waits on the library. Lines are grouped in blocks the browser skips while they are off screen
 * (content-visibility), which keeps a 100,000 line log as fast as a short file; find (find.js) still reaches them.
 *
 * splitHighlighted() is pure (test/apaki-viewers.test.js): highlight.js output cut into lines with every open <span>
 * closed at a line's end and opened again on the next, so a comment over three lines stays coloured on each.
 */

import { esc } from './markdown.js';
import { highlighter } from './lazy.js';
import { splitLines } from './textdiff.js';

/** Past this many characters a file is shown without colours (highlighting it would hold the window up). */
export const HIGHLIGHT_MAX = 300 * 1024;
/** Lines per block the browser can skip while off screen. */
const BLOCK = 400;

/** highlight.js HTML as one HTML string per line, every line self-contained (its spans closed and reopened). */
export function splitHighlighted(html) {
  const out = [];
  const open = [];
  let line = '';
  const re = /<span[^>]*>|<\/span>|\n|[^<\n]+|</g;
  let m;
  while ((m = re.exec(String(html ?? ''))) !== null) {
    const t = m[0];
    if (t === '\n') {
      out.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else if (t.startsWith('<span')) { open.push(t); line += t; } else if (t === '</span>') { open.pop(); line += t; } else line += t;
  }
  out.push(line + '</span>'.repeat(open.length));
  // A final newline leaves an empty last line: the file has no such line.
  if (out.length > 1 && out[out.length - 1].replace(/<[^>]+>/g, '') === '') out.pop();
  return out;
}

/** The lines as blocks of numbered rows (markup). */
function blocksHtml(lines) {
  const parts = [];
  for (let i = 0; i < lines.length; i += BLOCK) {
    const rows = [];
    const end = Math.min(lines.length, i + BLOCK);
    for (let j = i; j < end; j += 1) rows.push(`<div class="cv-l" data-n="${j + 1}">${lines[j] || '​'}</div>`);
    parts.push(`<div class="cv-b" style="contain-intrinsic-size: auto ${(end - i) * 21}px">${rows.join('')}</div>`);
  }
  return parts.join('');
}

/**
 * Draws `text` into a new element: { el, lines, colored: Promise<boolean> }. grammar: a highlight.js grammar
 * (viewkind.js) or null; wrap: long lines wrap.
 */
export function renderCode(text, { grammar = null, wrap = false } = {}) {
  const src = String(text ?? '');
  const lines = splitLines(src);
  const el = document.createElement('div');
  el.className = `cv${wrap ? ' wrap' : ''}`;
  el.style.setProperty('--cv-gutter', `${Math.max(2, String(lines.length).length) + 1}ch`);
  el.innerHTML = lines.length ? blocksHtml(lines.map((l) => esc(l))) : '<div class="cv-empty">This file is empty.</div>';
  const colored = (async () => {
    if (!grammar || grammar === 'plaintext' || !lines.length || src.length > HIGHLIGHT_MAX) return false;
    const hljs = await highlighter(grammar);
    if (!hljs || !hljs.getLanguage(grammar) || !el.isConnected) return false;
    // Let the plain text paint first; colour in the next quiet moment.
    await new Promise((r) => (window.requestIdleCallback ? window.requestIdleCallback(r, { timeout: 300 }) : setTimeout(r, 30)));
    if (!el.isConnected) return false;
    let html;
    try { html = hljs.highlight(src.replace(/\r\n?/g, '\n'), { language: grammar, ignoreIllegals: true }).value; } catch { return false; }
    const colouredLines = splitHighlighted(html);
    if (colouredLines.length !== lines.length) return false;
    el.innerHTML = blocksHtml(colouredLines);
    el.classList.add('hl');
    return true;
  })();
  return { el, lines: lines.length, colored };
}
