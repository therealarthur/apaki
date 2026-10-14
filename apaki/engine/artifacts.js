/**
 * artifacts.js: where the things Claude shows the user in Myrlin Apaki live.
 *
 * WHY (Arthur, 2026-10-09: artifacts like Codex has, out of the box): Claude
 * running inside Apaki calls the `show` tool of Apaki's own MCP server
 * (apaki-tools.js) with an HTML page, Markdown, an SVG, an image or a local
 * file, and the user sees it in a viewer beside the conversation. This module
 * stores what was shown, with revisions, so the viewer, the transcript cards,
 * a reopened session and (later) the phone can all fetch it again.
 *
 * Layout on disk (root = ~/.claude/latch/artifacts, LATCH_DIR overrides):
 *   _WHY_THIS_IS_HERE.md
 *   <sessionId>/index.json          { version, sessionId, artifacts: { id: record } }
 *   <sessionId>/<id>.<ext>          the current revision
 *   <sessionId>/<id>.r<N>.<ext>     earlier revisions (the newest MAX_REVS kept)
 *
 * A record: { id, sessionId, title, kind, ext, mime, rev, size, source,
 * createdAt, updatedAt, revs: [{ rev, ext, size, at, title }] }. Stored kinds
 * are html, markdown, svg, image, pdf and text; the tool's kind "file" is
 * resolved to one of those from the file's extension, and its file is copied
 * in (a snapshot), so later edits to the original do not change history.
 * Showing the same file again in the same session is a new revision of the
 * same artifact. HTML files get their local images, stylesheets and scripts
 * inlined, because the viewer blocks every load from outside the page.
 *
 * Viewers like ChatGPT's side window (2026-10-13, Arthur: "literally exactly
 * everything chatgpt's window could display and allow the session to do"):
 *   - more stored kinds: sheet (xlsx, xlsm, xlsb, xls), docx (Word) and chart
 *     (a JSON chart spec, apaki/ui/chartspec.js, checked here so Claude hears
 *     what is wrong with it); the show tool takes kind "text" with an optional
 *     `language` hint (stored as the extension: "python" is saved as .py) and
 *     kind "chart". Which viewer draws what is apaki/ui/viewkind.js viewOf.
 *   - each revision says who made it and what it is: revs[].by is 'session'
 *     (a show call) or 'user' (an edit in the viewer, edit() below), revs[].kind
 *     its kind; the record keeps lang, sessionRev (the newest revision the
 *     session made) and readRev (the newest the session read with view_read),
 *     so the session can be told the user edited what it showed.
 *
 * Plain synchronous fs, no dependencies; tests point it at a temp folder.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Shared with the window (pure, no DOM). apaki/ui ships beside the engine in every package (viewkind.js says why).
import { normalizeChart } from '../ui/chartspec.js';
import { EDITABLE_KINDS, extOfLang, normLang } from '../ui/viewkind.js';

export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** Workbooks and Word documents are parsed in the window (SheetJS, mammoth): kept smaller than other files. */
export const MAX_OFFICE_BYTES = 15 * 1024 * 1024;
/** A chart spec is a few lines of JSON; this is far more than any chart needs. */
export const MAX_CHART_BYTES = 2 * 1024 * 1024;
export const MAX_REVS = 20;
const MAX_INLINE_ASSET = 6 * 1024 * 1024;

// text and chart since 2026-10-13 (viewers like ChatGPT's side window); the first six are as they were.
export const SHOW_KINDS = ['html', 'markdown', 'svg', 'image', 'file', 'url', 'text', 'chart'];
/** The kinds a revision can be stored as. */
export const STORED_KINDS = ['html', 'markdown', 'svg', 'image', 'pdf', 'text', 'sheet', 'docx', 'chart'];

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', xhtml: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv; charset=utf-8', tsv: 'text/tab-separated-values; charset=utf-8',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
};
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const KIND_OF_EXT = { html: 'html', htm: 'html', xhtml: 'html', md: 'markdown', markdown: 'markdown', svg: 'svg', pdf: 'pdf' };
/** Office files the viewer draws (2026-10-13): workbooks as tables, Word documents read only. */
const OFFICE_KIND = { xlsx: 'sheet', xlsm: 'sheet', xlsb: 'sheet', xls: 'sheet', docx: 'docx' };

export const mimeOf = (ext) => MIME[String(ext || '').toLowerCase()] || 'text/plain; charset=utf-8';
/** The stored kind of a file extension: html, markdown, svg, pdf, image, sheet, docx or text. */
export const kindOfExt = (ext) => KIND_OF_EXT[String(ext || '').toLowerCase()] || OFFICE_KIND[String(ext || '').toLowerCase()] || (IMAGE_EXT.has(String(ext || '').toLowerCase()) ? 'image' : 'text');
/** The kind of one revision of a record (older records have no kind per revision: the latest is the record's, earlier ones go by extension). */
export const revKind = (rec, r) => (r?.kind && STORED_KINDS.includes(r.kind) ? r.kind : r && r.rev === rec.rev ? rec.kind : kindOfExt(r?.ext));
const extOf = (p) => { const m = String(p || '').match(/\.([A-Za-z0-9]{1,10})$/); return m ? m[1].toLowerCase() : ''; };
const safeExt = (e) => (/^[a-z0-9]{1,10}$/.test(e) ? e : 'txt');

/** The artifacts folder: ~/.claude/latch/artifacts unless LATCH_DIR (or CLAUDE_CONFIG_DIR) says otherwise. */
export function artifactsRoot(env = process.env) {
  const claude = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(env.LATCH_DIR || path.join(claude, 'latch'), 'artifacts');
}

/** Session folder names: ids are uuids, anything else is made safe. */
export function safeSession(id) {
  const s = String(id || '').trim();
  return /^[A-Za-z0-9-]{1,80}$/.test(s) ? s : (s.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unsaved');
}

/** Artifact ids: lowercase words and digits joined by dashes, at most 48 characters. */
export function safeId(id) {
  return String(id || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
}

function slug(title) {
  return safeId(title).split('-').slice(0, 5).join('-').slice(0, 32).replace(/-+$/g, '') || 'artifact';
}

/** Image type from its first bytes (png, jpg, gif, webp, bmp, ico, avif), or null. */
export function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'ico';
  if (buf.toString('latin1', 4, 12) === 'ftypavif') return 'avif';
  return null;
}

/** True when the bytes look like text (no NUL in the first 8 KB). */
const looksText = (buf) => !buf.subarray(0, 8192).includes(0);

/** The office format the bytes are, by their first bytes: 'zip' (xlsx, xlsm, xlsb, docx), 'cfb' (an old xls) or null. */
export function sniffOffice(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'cfb';
  return null;
}

/**
 * Checks an office file before it is stored: the right container for its extension and not too big. Excel can also
 * save a sheet as HTML or XML with an .xls name; SheetJS reads those too, so an .xls only needs to be one or the other.
 */
function checkOffice(kind, ext, buf, name) {
  if (buf.length > MAX_OFFICE_BYTES) throw new Error(`${name} is ${(buf.length / 1048576).toFixed(1)} MB; Apaki shows ${kind === 'docx' ? 'Word documents' : 'workbooks'} up to ${MAX_OFFICE_BYTES / 1048576} MB.`);
  const box = sniffOffice(buf);
  if (ext === 'xls' ? !(box || looksText(buf)) : box !== 'zip') throw new Error(`${name} is not a ${kind === 'docx' ? 'Word document (.docx)' : `${ext.toUpperCase()} workbook`}.`);
}

/** A chart spec as stored: checked (chartspec.js), then as indented JSON. Throws with what to fix, for Claude. */
function chartBytes(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_CHART_BYTES) throw new Error(`The chart spec is over ${MAX_CHART_BYTES / 1048576} MB; send fewer points (at most 50,000).`);
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`The chart spec is not valid JSON: ${String(e.message || e).slice(0, 160)}`); }
  const r = normalizeChart(raw);
  if (!r.ok) throw new Error(`The chart spec has problems: ${r.errors.join(' ')} A chart is { "type": "line" | "bar" | "area" | "scatter" | "pie", "title", "labels": [...], "series": [{ "name", "data": [numbers] }] }.`);
  return Buffer.from(JSON.stringify(raw, null, 1), 'utf8');
}

/**
 * Inlines the local files an HTML page loads (img/source/video/audio src as
 * data: URLs, <link rel=stylesheet> as <style>, <script src> as inline
 * <script>), so the page still works in the viewer, which loads nothing from
 * outside the page. Remote and data: references are left as they are.
 */
export function inlineLocalAssets(html, baseDir) {
  let budget = MAX_BYTES;
  const local = (ref) => {
    const r = String(ref || '').trim();
    if (!r || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(r)) return null;
    let p = r.replace(/[?#].*$/, '');
    try { p = decodeURIComponent(p); } catch { /* as is */ }
    // A root-relative "/assets/x.js" (a built site) means the page's own folder.
    const full = path.resolve(baseDir, p.replace(/^\/+/, ''));
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_INLINE_ASSET || st.size > budget) return null;
      budget -= st.size;
      return { full, buf: fs.readFileSync(full) };
    } catch { return null; }
  };
  let out = String(html);
  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    const f = local(href);
    return f ? `<style>\n${f.buf.toString('utf8').replace(/<\/style/gi, '<\\/style')}\n</style>` : tag;
  });
  out = out.replace(/<script\b([^>]*)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>\s*<\/script>/gi, (tag, a, _q, src, b) => {
    const f = local(src);
    if (!f) return tag;
    const attrs = `${a}${b}`.replace(/\s+(?:defer|async|crossorigin(?:\s*=\s*(["']).*?\1)?|integrity\s*=\s*(["']).*?\2)/gi, '').trimEnd();
    return `<script${attrs}>\n${f.buf.toString('utf8').replace(/<\/script/gi, '<\\/script')}\n</script>`;
  });
  out = out.replace(/(<(?:img|source|video|audio|input)\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (all, pre, q, src) => {
    const f = local(src);
    if (!f) return all;
    return `${pre}${q}data:${mimeOf(extOf(f.full)).split(';')[0]};base64,${f.buf.toString('base64')}${q}`;
  });
  return out;
}

const README = `# artifacts

**What:** things Claude showed you inside Myrlin Apaki (HTML pages, Markdown, SVG, images,
code, tables, charts, copies of local files such as spreadsheets and Word documents), one
folder per Claude Code session, each with an index.json and every revision (\`<id>.<ext>\`
is the current one, \`<id>.r<N>.<ext>\` the earlier ones, including the ones you edited in
the viewer).

**Who / when:** written by Myrlin Apaki's engine (apaki/engine/artifacts.js in the
claude-latch repo) whenever Claude calls its \`show\` tool or Apaki catches an "open this"
command. Added 2026-10-09 by Claude Code (Opus 5.5) for Arthur.

**Safe to delete?** Yes, any time Apaki is closed (or a single session folder at any time).
Only the artifact cards in old conversations lose their content; the conversations
themselves are untouched. Nothing here holds a secret unless Claude put one in a page.

**Related:** ~/.claude/latch/_WHY_THIS_IS_HERE.md; sessions are in ~/.claude/projects.
`;

export class ArtifactStore {
  constructor({ root = artifactsRoot(), maxRevs = MAX_REVS } = {}) {
    this.root = root;
    this.maxRevs = maxRevs;
  }

  ensureRoot() {
    fs.mkdirSync(this.root, { recursive: true });
    const note = path.join(this.root, '_WHY_THIS_IS_HERE.md');
    if (!fs.existsSync(note)) { try { fs.writeFileSync(note, README); } catch { /* best effort */ } }
  }

  dir(sessionId) { return path.join(this.root, safeSession(sessionId)); }

  readIndex(sessionId) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir(sessionId), 'index.json'), 'utf8'));
      if (j && typeof j.artifacts === 'object') return j;
    } catch { /* none yet */ }
    return { version: 1, sessionId: safeSession(sessionId), artifacts: {} };
  }

  writeIndex(sessionId, idx) {
    const file = path.join(this.dir(sessionId), 'index.json');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 1));
    fs.renameSync(tmp, file);
  }

  /** The file holding revision `rev` of a record (the current one when rev is the latest). */
  fileOf(rec, rev = rec.rev) {
    const r = rec.revs.find((x) => x.rev === Number(rev)) || rec.revs[rec.revs.length - 1];
    const name = r.rev === rec.rev ? `${rec.id}.${r.ext}` : `${rec.id}.r${r.rev}.${r.ext}`;
    return { file: path.join(this.dir(rec.sessionId), name), name, ext: r.ext, rev: r.rev, size: r.size };
  }

  /**
   * Turns the tool's input into bytes to store: { kind, ext, buf, source, lang }.
   * Throws an Error with a message meant for Claude when the input cannot be shown.
   * input.language (2026-10-13) is a hint for text: a language Apaki knows becomes the extension ("python" -> .py,
   * "csv" -> .csv, so a table); any other short name is kept as lang for the viewer's label.
   */
  resolve(input, { cwd = process.cwd() } = {}) {
    let kind = String(input.kind || '').toLowerCase();
    const content = input.content;
    let source = null;
    let buf = null;
    let ext = '';
    const hint = String(input.language ?? '').trim().toLowerCase();
    const known = normLang(hint);
    const lang = known || (/^[a-z0-9][a-z0-9+#._-]{0,23}$/.test(hint) ? hint : null);
    let p = input.path ? String(input.path) : '';
    if (p && /^file:\/\//i.test(p)) { p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, process.platform === 'win32' ? '' : '/')); }
    if (!kind) kind = p ? 'file' : /^\s*<svg[\s>]/i.test(String(content || '')) ? 'svg' : /^\s*(<!doctype|<html|<)/i.test(String(content || '')) ? 'html' : 'markdown';
    if (kind === 'url') throw new Error('kind "url" is opened, not stored');
    if (!SHOW_KINDS.includes(kind)) throw new Error(`Unknown kind "${input.kind}". Use one of: ${SHOW_KINDS.join(', ')}.`);
    if (p) {
      const full = path.resolve(cwd, p.replace(/^~(?=$|[\\/])/, os.homedir()));
      let st;
      try { st = fs.statSync(full); } catch { throw new Error(`File not found: ${full}`); }
      if (!st.isFile()) throw new Error(`Not a file: ${full}`);
      if (st.size > MAX_BYTES) throw new Error(`${full} is ${(st.size / 1048576).toFixed(1)} MB; Apaki shows files up to ${MAX_BYTES / 1048576} MB.`);
      buf = fs.readFileSync(full);
      source = full;
      ext = extOf(full);
      if (kind === 'file') {
        const img = sniffImage(buf);
        if (KIND_OF_EXT[ext]) kind = KIND_OF_EXT[ext];
        else if (OFFICE_KIND[ext]) kind = OFFICE_KIND[ext];
        else if (IMAGE_EXT.has(ext) || img) { kind = 'image'; ext = img || ext; }
        else if (looksText(buf) && buf.length <= MAX_TEXT_BYTES) kind = 'text';
        else throw new Error(`${path.basename(full)} is not something Apaki can show (HTML, Markdown, SVG, images, PDF, spreadsheets (xlsx, xls), Word documents (docx) and text files are).`);
      }
      // kind "text" with a path (2026-10-13): any text file, drawn as code, a table or JSON by its extension or language.
      if (kind === 'text' && (!looksText(buf) || buf.length > MAX_TEXT_BYTES)) throw new Error(`${path.basename(full)} is not a text file Apaki can show (text up to ${MAX_TEXT_BYTES / 1048576} MB). Use kind "file" for images, PDFs, spreadsheets and Word documents.`);
      if (kind === 'chart') buf = chartBytes(buf.toString('utf8'));
      if (kind === 'sheet' || kind === 'docx') checkOffice(kind, ext, buf, path.basename(full));
      if (kind === 'html') buf = Buffer.from(inlineLocalAssets(buf.toString('utf8'), path.dirname(full)), 'utf8');
    } else {
      if (content === undefined || content === null || content === '') throw new Error('Give either content (the page, Markdown, SVG or image data) or path (a local file).');
      if (kind === 'file') throw new Error('kind "file" needs a path.');
      const text = String(content);
      if (kind === 'image') {
        const m = text.match(/^data:([\w/+.-]+)?(;base64)?,(.*)$/s);
        buf = m ? (m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8')) : Buffer.from(text.replace(/\s+/g, ''), 'base64');
        if (m?.[1] === 'image/svg+xml' || /^\s*<svg[\s>]/i.test(buf.toString('utf8', 0, 200))) kind = 'svg';
        else {
          const img = sniffImage(buf);
          if (!img) throw new Error('The image content is not PNG, JPEG, GIF, WebP, BMP, ICO or AVIF data (base64 or a data: URL).');
          ext = img;
        }
      } else if (kind === 'chart') {
        buf = chartBytes(text);
      } else {
        buf = Buffer.from(text, 'utf8');
      }
      if (kind === 'text' && buf.length > MAX_TEXT_BYTES) throw new Error(`The text is ${(buf.length / 1048576).toFixed(1)} MB; Apaki shows text up to ${MAX_TEXT_BYTES / 1048576} MB.`);
      if (buf.length > MAX_BYTES) throw new Error(`The content is ${(buf.length / 1048576).toFixed(1)} MB; the most is ${MAX_BYTES / 1048576} MB.`);
    }
    if (kind === 'html') ext = 'html';
    if (kind === 'markdown') ext = 'md';
    if (kind === 'svg') ext = 'svg';
    if (kind === 'pdf') ext = 'pdf';
    if (kind === 'chart') ext = 'json';
    // A language hint Apaki knows names the file ("python" is stored as .py); otherwise the file's own extension.
    if (kind === 'text') ext = safeExt((known && extOfLang(known)) || ext || 'txt');
    return { kind, ext, buf, source, lang: kind === 'text' ? lang : null };
  }

  /**
   * Stores a new artifact, or a new revision of `input.id` (or of the
   * artifact already made from the same file in this session). Returns the record.
   */
  show(sessionId, input = {}, { cwd = process.cwd(), now = Date.now() } = {}) {
    const { kind, ext, buf, source, lang } = this.resolve(input, { cwd });
    this.ensureRoot();
    const sid = safeSession(sessionId);
    fs.mkdirSync(this.dir(sid), { recursive: true });
    const idx = this.readIndex(sid);
    const title = String(input.title || '').trim().slice(0, 200) || (source ? path.basename(source) : kind === 'markdown' ? 'Notes' : kind === 'chart' ? 'Chart' : 'Artifact');
    let id = safeId(input.id);
    // "index" would put a .json artifact on top of index.json.
    if (id === 'index') id = 'index-page';
    if (!id && source) id = Object.values(idx.artifacts).find((a) => a.source && path.resolve(a.source) === path.resolve(source))?.id || '';
    if (!id) {
      do id = `${slug(title)}-${crypto.randomBytes(2).toString('hex')}`; while (idx.artifacts[id]);
    }
    const prev = idx.artifacts[id];
    const rec = this.writeRevision(sid, idx, id, prev, { kind, ext, buf, title, by: 'session', lang, source, now });
    // The newest revision the session itself made: an edit of the user's after it is news to the session (view_read).
    rec.sessionRev = rec.rev;
    this.writeIndex(sid, idx);
    return rec;
  }

  /**
   * Writes revision prev.rev + 1 (or 1) of artifact `id` into the session folder and the index object (not yet
   * saved): the current file becomes an earlier revision, the oldest beyond maxRevs go. Returns the new record.
   */
  writeRevision(sid, idx, id, prev, { kind, ext, buf, title, by, lang = null, source = null, now = Date.now() }) {
    const rev = prev ? prev.rev + 1 : 1;
    if (prev) {
      // The current file becomes an earlier revision; the oldest beyond MAX_REVS go.
      const cur = this.fileOf(prev);
      try { fs.renameSync(cur.file, path.join(this.dir(sid), `${id}.r${prev.rev}.${cur.ext}`)); } catch { /* missing: keep going */ }
    }
    fs.writeFileSync(path.join(this.dir(sid), `${id}.${ext}`), buf);
    const revs = [...(prev?.revs || []), { rev, ext, size: buf.length, at: now, title, kind, by, ...(lang ? { lang } : {}) }];
    while (revs.length > this.maxRevs) {
      const old = revs.shift();
      fs.rmSync(path.join(this.dir(sid), `${id}.r${old.rev}.${old.ext}`), { force: true });
    }
    const rec = {
      id, sessionId: sid, title, kind, ext, mime: mimeOf(ext), rev, size: buf.length,
      source: source || prev?.source || null, createdAt: prev?.createdAt || now, updatedAt: now, revs,
      lang: lang || null, sessionRev: prev?.sessionRev ?? (prev ? prev.rev : 0), readRev: prev?.readRev ?? 0, noticedRev: prev?.noticedRev ?? 0,
    };
    idx.artifacts[id] = rec;
    return rec;
  }

  /**
   * The user's edit of a text artifact in the viewer (2026-10-13, canvas): a new revision marked by: 'user'. Only
   * markdown and text (code, CSV, JSON...) are editable. baseRev is the revision the edit started from: when the
   * session has made a newer one since, the edit is refused with code 'stale' unless `force` (the viewer asks first).
   * Returns the record. Throws an Error with a message for the person.
   */
  edit(sessionId, id, { content, baseRev = null, force = false, title = null, now = Date.now() } = {}) {
    const sid = safeSession(sessionId);
    const idx = this.readIndex(sid);
    const prev = idx.artifacts[safeId(id)];
    if (!prev) throw new Error('This artifact is no longer on this PC.');
    if (!EDITABLE_KINDS.includes(prev.kind)) throw new Error(`A ${prev.kind} artifact cannot be edited here; Markdown and text can.`);
    if (typeof content !== 'string') throw new Error('Nothing to save.');
    const buf = Buffer.from(content, 'utf8');
    if (buf.length > MAX_TEXT_BYTES) throw new Error(`The text is ${(buf.length / 1048576).toFixed(1)} MB; the most is ${MAX_TEXT_BYTES / 1048576} MB.`);
    if (!force && baseRev !== null && Number(baseRev) !== prev.rev) {
      throw Object.assign(new Error(`It changed while you were editing: rev ${prev.rev} is newer than the rev ${baseRev} you started from.`), { code: 'stale', rev: prev.rev });
    }
    const cur = this.fileOf(prev);
    let same = false;
    try { same = fs.readFileSync(cur.file).equals(buf); } catch { /* the file is gone: write it */ }
    if (same) return prev;
    const rec = this.writeRevision(sid, idx, prev.id, prev, { kind: prev.kind, ext: prev.ext, buf, title: String(title || '').trim().slice(0, 200) || prev.title, by: 'user', lang: prev.lang || null, now });
    this.writeIndex(sid, idx);
    return rec;
  }

  /**
   * The user's revisions the session has not seen yet: newer than both the last one it showed and the last one it
   * read with view_read. [{ rev, at }] oldest first.
   */
  userEdits(rec) {
    if (!rec) return [];
    const seen = Math.max(rec.sessionRev ?? 0, rec.readRev ?? 0);
    return (rec.revs || []).filter((r) => r.by === 'user' && r.rev > seen).map((r) => ({ rev: r.rev, at: r.at }));
  }

  /** Remembers that the session read revision `rev` (view_read) or was told about edits up to it (noticedRev). */
  mark(sessionId, id, { readRev = null, noticedRev = null } = {}) {
    const sid = safeSession(sessionId);
    const idx = this.readIndex(sid);
    const rec = idx.artifacts[safeId(id)];
    if (!rec) return null;
    if (readRev !== null) rec.readRev = Math.max(rec.readRev ?? 0, Number(readRev) || 0);
    if (noticedRev !== null) rec.noticedRev = Math.max(rec.noticedRev ?? 0, Number(noticedRev) || 0);
    this.writeIndex(sid, idx);
    return rec;
  }

  /** The record of artifact `id` (in `sessionId`, or found across sessions), or null. */
  record(id, sessionId = null) {
    const aid = safeId(id);
    if (!aid) return null;
    if (sessionId) return this.readIndex(sessionId).artifacts[aid] || null;
    const sid = this.findSession(aid);
    return sid ? this.readIndex(sid).artifacts[aid] : null;
  }

  /** The session that holds artifact `id`, looking through every session folder. */
  findSession(id) {
    const aid = safeId(id);
    let names = [];
    try { names = fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; }
    for (const n of names) if (this.readIndex(n).artifacts[aid]) return n;
    return null;
  }

  /**
   * One revision of an artifact with its bytes: { record, rev, ext, mime, file, buf, kind, by, lang }.
   * rev defaults to the latest. Null when it does not exist. by is 'session' or 'user' (an edit in the viewer).
   */
  get(id, { sessionId = null, rev = null } = {}) {
    const rec = this.record(id, sessionId);
    if (!rec) return null;
    const f = this.fileOf(rec, rev ?? rec.rev);
    let buf;
    try { buf = fs.readFileSync(f.file); } catch { return null; }
    const r = rec.revs.find((x) => x.rev === f.rev) || null;
    return { record: rec, rev: f.rev, ext: f.ext, mime: mimeOf(f.ext), file: f.file, name: f.name, buf, kind: revKind(rec, r), by: r?.by || 'session', lang: r?.lang || (f.rev === rec.rev ? rec.lang || null : null) };
  }

  /** Every artifact of a session, newest first. */
  list(sessionId) {
    return Object.values(this.readIndex(sessionId).artifacts).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Resolves a served file name (`<id>.<ext>` or `<id>.r<N>.<ext>`) inside a
   * session folder to a path, refusing anything that could leave the folder.
   */
  servedFile(sessionId, name) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(String(sessionId || '')) || !/^[a-z0-9-]{1,48}(?:\.r\d{1,6})?\.[a-z0-9]{1,10}$/.test(String(name || ''))) return null;
    if (/^index\./.test(name)) return null;
    const file = path.join(this.root, sessionId, name);
    if (path.dirname(file) !== path.join(this.root, sessionId)) return null;
    return fs.existsSync(file) ? file : null;
  }
}
