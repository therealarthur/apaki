/**
 * docview.js: Word documents (.docx) in the viewer, read only (2026-10-13).
 *
 * WHY (Arthur, 2026-10-13: viewers that show what ChatGPT's side window shows): a report Claude wrote with
 * python-docx, or a spec the user keeps in Word, opens beside the conversation as a page: headings, paragraphs, bold
 * and italic, lists, tables, links and pictures. mammoth (vendor/mammoth, loaded the first time a document opens)
 * turns the file into plain HTML.
 *
 * The document is untrusted, so its HTML is rebuilt rather than trusted (sanitizeDocHtml): it is parsed with
 * DOMParser (which runs nothing), and only a short list of elements and attributes is copied into the page. Links
 * keep only http, https and mailto addresses (the viewer opens them in Apaki's browser), pictures only data:image
 * addresses mammoth made from the file itself. The window's CSP would stop scripts anyway; this keeps out styles,
 * event handlers and odd addresses as well.
 */

import { loadScript } from './lazy.js';

const KEEP = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SUB', 'SUP', 'A', 'UL', 'OL', 'LI',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'IMG', 'BR', 'BLOCKQUOTE', 'PRE', 'CODE', 'SPAN', 'DIV', 'HR', 'CAPTION', 'SMALL']);
/** Elements dropped with everything inside them. */
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'LINK', 'META', 'BASE', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT']);
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;

/** An address a link may keep: http(s) or mailto, or an anchor inside the document. */
export function safeHref(href) {
  const h = String(href ?? '').trim();
  if (/^#[\w.-]{1,120}$/.test(h)) return h;
  try {
    const u = new URL(h);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

/** A picture address a document may keep: a data: URL of a raster or SVG image, within a size cap. */
export function safeImageSrc(src) {
  const s = String(src ?? '');
  if (s.length > MAX_IMAGE_CHARS) return null;
  // An SVG shown through <img> runs no script; EMF and WMF are left out (no browser draws them).
  return /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(s) ? s : null;
}

/**
 * Rebuilds untrusted HTML as a fragment of allowed elements: text everywhere, the elements in KEEP with only id (for
 * anchors), href (safeHref), src and alt (safeImageSrc), colspan and rowspan. Everything else is unwrapped (its text
 * kept) or, for DROP, removed whole.
 */
export function sanitizeDocHtml(html, doc = document) {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${String(html ?? '')}`, 'text/html');
  const out = doc.createDocumentFragment();
  const copy = (from, to) => {
    for (const n of [...from.childNodes]) {
      if (n.nodeType === 3) { to.append(doc.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toUpperCase();
      if (DROP.has(tag)) continue;
      if (!KEEP.has(tag)) { copy(n, to); continue; }
      const e = doc.createElement(tag.toLowerCase());
      if (n.id && /^[\w.-]{1,120}$/.test(n.id)) e.id = `doc-${n.id}`;
      if (tag === 'A') {
        const h = safeHref(n.getAttribute('href'));
        if (h) e.setAttribute('href', h.startsWith('#') ? `#doc-${h.slice(1)}` : h);
      }
      if (tag === 'IMG') {
        const s = safeImageSrc(n.getAttribute('src'));
        if (!s) continue;
        e.setAttribute('src', s);
        e.setAttribute('alt', String(n.getAttribute('alt') || '').slice(0, 300));
        e.setAttribute('loading', 'lazy');
      }
      if (tag === 'TD' || tag === 'TH') {
        for (const a of ['colspan', 'rowspan']) {
          const v = Number(n.getAttribute(a));
          if (Number.isInteger(v) && v > 1 && v < 100) e.setAttribute(a, String(v));
        }
      }
      copy(n, e);
      to.append(e);
    }
  };
  copy(parsed.body, out);
  return out;
}

/** A .docx file (bytes) as a sanitized element, with mammoth's notes about what it could not keep. */
export async function renderDocx(bytes) {
  await loadScript('mammoth/mammoth.browser.min.js');
  const mammoth = window.mammoth;
  if (!mammoth?.convertToHtml) throw new Error('The Word reader did not load.');
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const r = await mammoth.convertToHtml({ arrayBuffer: buf });
  const article = document.createElement('article');
  article.className = 'art-doc docx turn-assistant';
  article.append(sanitizeDocHtml(r.value));
  if (!article.textContent.trim() && !article.querySelector('img')) article.innerHTML = '<p class="docx-empty">This document has no text.</p>';
  const notes = (r.messages || []).filter((m) => m.type === 'warning').map((m) => String(m.message || '')).slice(0, 5);
  return { el: article, notes };
}
