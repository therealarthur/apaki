/**
 * apaki-tools.js: what Claude Code gets when it runs inside Myrlin Apaki.
 *
 * WHY (Arthur, 2026-10-09: "like Codex's built-in artifacts, Claude running
 * inside Apaki can show the user things in Apaki itself, out of the box"):
 * nothing is installed or written to the user's settings. Everything is
 * passed at runtime through Agent SDK options, per pane, by the Apaki engine
 * only (latch's terminal app does not get them):
 *
 *   mcpServers   an in-process MCP server "apaki" (createSdkMcpServer) with
 *                one tool, `show` (mcp__apaki__show): HTML, Markdown, SVG,
 *                images and local files go to Apaki's viewer, web pages to
 *                its built-in browser (the openUrl event; a link card where
 *                the shell has no browser).
 *   systemPrompt one short paragraph appended to Claude Code's own prompt
 *                saying the tool exists and to use it instead of start /
 *                Start-Process / open.
 *   hooks        PreToolUse on Bash and PowerShell: a command whose purpose
 *                is to open a URL or a file in the OS (open-catch.js) is
 *                denied with "Opened in Apaki instead: ..." and shown in
 *                Apaki; in a longer command only the open step is cut out,
 *                and a file it opens is shown after the command ran
 *                (PostToolUse), since the command usually builds it.
 *   browser      (2026-10-09, when the Apaki shell has its built-in browser)
 *                six more tools on the same server, browser_open, _read,
 *                _click, _type, _back and _screenshot (browser-tools.js),
 *                and a sentence in the system prompt saying they exist. Web
 *                pages from show and from caught commands then open in that
 *                browser instead of a link card only.
 *
 * createApakiTools() returns those three plus show(), preToolUse() and
 * postToolUse() for tests (test/apaki-tools.test.js).
 *
 * Viewers like ChatGPT's side window (2026-10-13, Arthur: "literally exactly
 * everything chatgpt's window could display and allow the session to do"):
 *   show         also takes kind "text" with an optional `language` (code with
 *                syntax colours; csv and tsv as tables; json as a table or a
 *                tree) and kind "chart" (a small JSON spec, apaki/ui/chartspec.js);
 *                kind "file" also opens spreadsheets (xlsx, xls) and Word
 *                documents (docx).
 *   view_read    the other half of the canvas: the user can edit Markdown, text
 *                and code in the viewer, which saves a revision marked as theirs.
 *                view_read returns an artifact's current content and whether the
 *                user edited it since the session last showed or read it (no id:
 *                the list of this conversation's artifacts). Read only.
 *   UserPromptSubmit  a hook that adds one line of context to the user's own next
 *                message when they edited something this session showed, so the
 *                session knows to call view_read. It sends nothing by itself.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { APP_VERSION } from './app-version.js';
import { SHOW_KINDS } from './artifacts.js';
import { analyzeCommand } from './open-catch.js';
import { BROWSER_PROMPT } from './browser-tools.js';

export const SHOW_TOOL = 'mcp__apaki__show';
export const VIEW_READ_TOOL = 'mcp__apaki__view_read';
const PENDING_TTL_MS = 30 * 60 * 1000;
/** The most text view_read returns in one call; a longer artifact says so and how much was left out. */
export const VIEW_READ_MAX_CHARS = 120000;

export const APAKI_SYSTEM_PROMPT = `You are running inside Myrlin Apaki, a desktop app for Claude Code; the user reads this conversation there. When you want the user to see something (an HTML page or small app, a chart, an SVG diagram, an image, a Markdown report, code, a table of data, a PDF, a spreadsheet, a Word document or any other local file, or a web page such as a dev server), call the ${SHOW_TOOL} tool: it opens in Apaki beside this conversation. Do not open things with start, Start-Process, explorer, open, xdg-open or python -m webbrowser; Apaki redirects those anyway. Shown pages run sandboxed without network access, so inline their CSS, scripts and images (data: URLs). For a simple chart use kind "chart" with a JSON spec instead of writing a page. To revise something you showed, call ${SHOW_TOOL} again with its id. The user can edit Markdown, text and code you showed; call ${VIEW_READ_TOOL} with its id to read their version before you change it.`;

export const SHOW_DESCRIPTION = `Show the user something inside Myrlin Apaki, in a viewer beside this conversation (or, for web pages, Apaki's browser). Use it whenever the user should look at a result: an HTML page or interactive demo, a chart, an SVG diagram, an image, a Markdown document, code, a table, a PDF, spreadsheet, Word document or other local file, or a URL such as a local dev server. Prefer it over opening a browser or file with a shell command.
- kind "html": content is a complete HTML document. It runs sandboxed with no network: inline all CSS and JS, use data: URLs for images.
- kind "markdown": content is Markdown. The user can edit it in the viewer.
- kind "text": content is code or plain text, shown with line numbers; set language (python, typescript, rust, sql, bash, json, yaml...) for syntax colours. language "csv" or "tsv" shows a sortable, filterable table; "json" shows a table for an array of records, else a collapsible tree. The user can edit it in the viewer.
- kind "chart": content is a JSON chart spec: {"type": "line"|"bar"|"area"|"scatter"|"pie", "title": "...", "labels": ["Jan","Feb"], "series": [{"name": "2026", "data": [3, 5]}], "x": {"label": "..."}, "y": {"label": "...", "prefix": "$", "suffix": "%"}, "stacked": false, "horizontal": false}. data may also be [x, y] pairs (numbers or ISO dates) or, for a pie, [{"label": "A", "value": 3}]. At most 8 series.
- kind "svg": content is SVG markup.
- kind "image": path to an image file, or content as base64 or a data: URL.
- kind "file": path to a local file (html, md, svg, png/jpg/gif/webp, pdf, xlsx/xls, docx, csv, json, code, txt...). It is copied, so show it again after changing it.
- kind "url": url (or content) is an http(s) address; it opens in Apaki's browser.
Pass id to update something you already showed: the user sees the new revision in place. Leave id out to show something new. The result tells you the id.`;

export const VIEW_READ_DESCRIPTION = `Read something you showed the user in Apaki (with ${SHOW_TOOL}), as it is now. The user can edit Markdown, text and code in Apaki's viewer; each edit is a new revision marked as theirs. Call this with the artifact's id before changing something the user may have edited (or when they say they edited it), then pass the same id to ${SHOW_TOOL} to update it. It returns the content and whether the user edited it since you last showed or read it. Without an id it lists this conversation's artifacts.`;

/** The text Claude gets back for a stored artifact. */
export function artifactResultText(rec, { updated = false } = {}) {
  const what = `artifact ${rec.id}, rev ${rec.rev}, ${rec.kind}`;
  if (updated || rec.rev > 1) return `Updated "${rec.title}" in Apaki (${what}); the user sees the new revision now. Call show with id "${rec.id}" again to change it further.`;
  return `Showing "${rec.title}" to the user in Apaki (${what}). They can see it beside this conversation now. To change it, call show again with id "${rec.id}"; leave id out to show something new.`;
}

/** Pulls { id, rev } back out of a show result or a hook's denial text (history cards use it). */
export function parseArtifactRef(text) {
  const m = String(text || '').match(/\bartifact ([a-z0-9-]{1,48}), rev (\d+)/);
  return m ? { id: m[1], rev: Number(m[2]) } : null;
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

/** The show tool's input schema (a zod raw shape), shared by the in-process and the stdio server. */
export function showShape() {
  return {
    title: z.string().describe('A short title for it, shown above it.'),
    kind: z.enum(SHOW_KINDS).describe('html | markdown | text | chart | svg | image | file | url'),
    content: z.string().optional().describe('The thing itself: an HTML document, Markdown, code or text, a chart spec as JSON text, SVG markup, base64 or data: URL image data, or the URL for kind url.'),
    path: z.string().optional().describe('A local file to show (absolute, or relative to the working directory).'),
    url: z.string().optional().describe('For kind url: the http(s) address.'),
    id: z.string().optional().describe('The id of something you showed before, to update it in place.'),
    // 2026-10-13: optional, so every older call still validates.
    language: z.string().optional().describe('For kind text (or a text file): the language for syntax colours, e.g. python, typescript, tsx, rust, go, sql, bash, powershell, json, yaml, toml, html, css, diff; csv or tsv for a table.'),
  };
}

/** The view_read tool's input schema (2026-10-13), shared by the in-process and the stdio server. */
export function viewReadShape() {
  return {
    id: z.string().optional().describe('The artifact id show returned. Leave it out to list this conversation\'s artifacts.'),
    rev: z.number().int().positive().optional().describe('An earlier revision to read; the newest by default.'),
  };
}

const ago = (at, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

/** What view_read says about the user's edits of a record: '' when there are none the session has not seen. */
export function editsText(store, rec, now = Date.now()) {
  const edits = store.userEdits(rec);
  if (!edits.length) return '';
  const last = edits[edits.length - 1];
  const yours = Math.max(rec.sessionRev ?? 0, 0);
  return `The user edited it in Apaki after you last ${rec.readRev > yours ? 'read' : 'showed'} it: ${edits.length === 1 ? `rev ${last.rev} is theirs` : `revs ${edits.map((e) => e.rev).join(', ')} are theirs`} (${ago(last.at, now)}).`;
}

/**
 * @param {object} o
 * @param {import('./artifacts.js').ArtifactStore} o.store
 * @param {() => string|null} o.sessionId   the pane's session right now
 * @param {() => string} o.cwd              the pane's working directory
 * @param {(rec, meta) => void} o.onArtifact  a stored artifact to show (meta: { via, toolUseId })
 * @param {(o: { url, title, reason, toolUseId }) => void} o.onOpenUrl  a web page to open
 * @param {ReturnType<import('./browser-tools.js').createBrowserTools>|null} [o.browser]  Claude's browser tools, when the shell has a browser
 */
export function createApakiTools({ store, sessionId = () => null, cwd = () => process.cwd(), onArtifact = () => {}, onOpenUrl = () => {}, home = os.homedir(), env = process.env, browser = null } = {}) {
  const pending = new Map(); // toolUseId -> { files, at, cwd }

  /** Shows one thing. Returns { ok, text, record?, url? }; never throws. */
  async function show(input = {}, meta = {}) {
    try {
      const kind = String(input.kind || '').toLowerCase();
      const raw = String(input.url || (kind === 'url' ? input.content || input.path || '' : '')).trim();
      if (kind === 'url' || (!kind && input.url)) {
        if (/^file:\/\//i.test(raw)) return show({ ...input, kind: 'file', path: raw, url: undefined }, meta);
        if (!/^https?:\/\/[^\s"'<>]+$/i.test(raw)) return { ok: false, text: `"${raw}" is not an http(s) URL. For a local file use kind "file" with its path.` };
        onOpenUrl({ url: raw, title: String(input.title || '').trim() || null, reason: meta.via || 'show', toolUseId: meta.toolUseId || null });
        if (browser) return { ok: true, url: raw, text: `Opened ${raw} for the user in Apaki's browser beside this conversation. To read or use the page yourself, call browser_read (browser_open reloads it). Do not open it again with a shell command.` };
        return { ok: true, url: raw, text: `Opened ${raw} for the user in Apaki (a link card in this conversation; it opens in their browser). Do not open it again with a shell command.` };
      }
      const before = input.id ? store.record(input.id, sessionId() || 'unsaved') : null;
      // Edits of the user's this call replaces (2026-10-13): said in the result, so they are not dropped unknowingly.
      const unseen = before && typeof store.userEdits === 'function' ? store.userEdits(before) : [];
      const rec = store.show(sessionId() || 'unsaved', input, { cwd: meta.cwd || cwd() });
      onArtifact(rec, { via: meta.via || 'show', toolUseId: meta.toolUseId || null });
      const note = unseen.length ? ` Note: the user had edited it in Apaki (rev ${unseen[unseen.length - 1].rev}) and you had not read their version; your revision is now the newest. If you meant to keep their changes, call view_read with rev ${unseen[unseen.length - 1].rev} and show a merged version.` : '';
      return { ok: true, record: rec, text: artifactResultText(rec, { updated: Boolean(before) }) + note };
    } catch (e) {
      return { ok: false, text: `Apaki could not show that: ${e.message || e}` };
    }
  }

  /**
   * view_read (2026-10-13): an artifact of this conversation as it is now, with who made its newest revision; no id
   * lists them. Returns { ok, text }; never throws. Reading marks the revision read, so the next answer about edits
   * counts from here.
   */
  async function viewRead(input = {}) {
    try {
      const sid = sessionId() || 'unsaved';
      if (!input.id) {
        const list = store.list(sid);
        if (!list.length) return { ok: true, text: 'You have not shown anything in Apaki in this conversation yet.' };
        const lines = list.slice(0, 60).map((r) => {
          const edits = store.userEdits(r);
          return `- ${r.id}: "${r.title}" (${r.kind}${r.lang ? `, ${r.lang}` : ''}, rev ${r.rev})${edits.length ? `, edited by the user in rev ${edits[edits.length - 1].rev}` : ''}`;
        });
        return { ok: true, text: `Artifacts you showed in this conversation, newest first:\n${lines.join('\n')}\nCall view_read with an id to read one.` };
      }
      const rec = store.record(input.id, sid);
      if (!rec) return { ok: false, text: `There is no artifact "${String(input.id).slice(0, 60)}" in this conversation. Call view_read without an id to list them.` };
      const got = store.get(rec.id, { sessionId: sid, rev: input.rev ?? null });
      if (!got) return { ok: false, text: `Revision ${input.rev} of "${rec.title}" is no longer kept (Apaki keeps the newest revisions).` };
      const latest = got.rev === rec.rev;
      const edits = latest ? editsText(store, rec) : '';
      const head = `"${rec.title}" (artifact ${rec.id}, ${got.kind}${got.lang ? `, ${got.lang}` : ''}), rev ${got.rev} of ${rec.rev}, made by ${got.by === 'user' ? 'the user (edited in Apaki)' : 'you'}.${edits ? ` ${edits}` : ''}`;
      if (latest) store.mark(sid, rec.id, { readRev: rec.rev, noticedRev: rec.rev });
      if (['image', 'pdf', 'sheet', 'docx'].includes(got.kind)) {
        return { ok: true, text: `${head}\nIt is a ${got.kind === 'sheet' ? 'spreadsheet' : got.kind === 'docx' ? 'Word document' : got.kind} (${got.ext}, ${got.buf.length} bytes), so its text is not shown here. Its file is ${got.file}${rec.source ? ` (a copy of ${rec.source})` : ''}.` };
      }
      let body = got.buf.toString('utf8');
      let cut = '';
      if (body.length > VIEW_READ_MAX_CHARS) { cut = `\n[... ${body.length - VIEW_READ_MAX_CHARS} more characters not shown; the whole file is ${got.file}]`; body = body.slice(0, VIEW_READ_MAX_CHARS); }
      return { ok: true, text: `${head}\nContent:\n${body}${cut}` };
    } catch (e) {
      return { ok: false, text: `Apaki could not read that: ${e.message || e}` };
    }
  }

  /**
   * UserPromptSubmit (2026-10-13): when the user edited something this session showed and the session has neither
   * read it nor been told yet, one line of context rides along with the user's own message. Nothing is sent by itself.
   */
  async function userPromptSubmit() {
    try {
      const sid = sessionId();
      if (!sid || typeof store.list !== 'function') return {};
      const news = store.list(sid).filter((r) => store.userEdits(r).some((e) => e.rev > (r.noticedRev ?? 0))).slice(0, 5);
      if (!news.length) return {};
      for (const r of news) store.mark(sid, r.id, { noticedRev: r.rev });
      const what = news.map((r) => `"${r.title}" (id ${r.id}, now rev ${r.rev})`).join(', ');
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `Apaki: the user edited ${what} in the viewer since you last showed ${news.length === 1 ? 'it' : 'them'}. Call ${VIEW_READ_TOOL} with the id to read their version before you change it.` } };
    } catch {
      return {};
    }
  }

  /** Hands one caught open to Apaki; returns a short line saying what happened. */
  async function deliver(m, toolUseId, dir) {
    if (m.kind === 'url') {
      onOpenUrl({ url: m.target, title: null, reason: m.via, toolUseId: toolUseId || null });
      return m.target;
    }
    const r = await show({ kind: 'file', path: m.target, title: path.basename(m.target) }, { via: m.via, toolUseId, cwd: dir });
    return r.ok ? `${m.target} (artifact ${r.record.id}, rev ${r.record.rev})` : `${m.target} could not be shown: ${r.text.replace(/^Apaki could not show that: /, '')}`;
  }

  async function preToolUse(input = {}, toolUseId) {
    const name = input.tool_name;
    if (name !== 'Bash' && name !== 'PowerShell') return {};
    const command = input.tool_input?.command;
    if (typeof command !== 'string' || !command.trim()) return {};
    const dir = input.cwd || cwd();
    const a = analyzeCommand(command, { shell: name === 'PowerShell' ? 'powershell' : 'bash', cwd: dir, home, env });
    if (!a.matches.length) return {};
    if (a.pure) {
      const done = [];
      for (const m of a.matches) done.push(await deliver(m, toolUseId, dir));
      return deny(`Opened in Apaki instead: ${done.join('; ')}. The user can see it in Apaki now; do not open it again with a shell command (use ${SHOW_TOOL} next time).`);
    }
    if (a.rewritten) {
      // Pages now (a dev server may never return), files once the command ran.
      const urls = a.matches.filter((m) => m.kind === 'url');
      const files = a.matches.filter((m) => m.kind === 'file');
      const shown = [];
      for (const m of urls) shown.push(await deliver(m, toolUseId, dir));
      for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL_MS) pending.delete(k);
      if (files.length && toolUseId) pending.set(toolUseId, { files, at: Date.now(), cwd: dir });
      const note = [shown.length ? `Opened in Apaki instead: ${shown.join('; ')}.` : '', files.length ? `Apaki shows ${files.map((f) => f.target).join(', ')} after the command finishes.` : ''].filter(Boolean).join(' ');
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...input.tool_input, command: a.rewritten },
          additionalContext: `${note} The open step was removed from the command so nothing pops over Apaki.`,
        },
      };
    }
    const targets = a.matches.map((m) => m.target).join(', ');
    return deny(`Apaki stopped this command because it opens ${targets} in the operating system, which would cover the app. Run it again without the open step, then call ${SHOW_TOOL} (path for a file, kind "url" for a web page) to show it to the user.`);
  }

  async function postToolUse(input = {}, toolUseId) {
    const job = toolUseId && pending.get(toolUseId);
    if (!job) return {};
    pending.delete(toolUseId);
    const done = [];
    for (const f of job.files) if (fs.existsSync(f.target)) done.push(await deliver(f, toolUseId, job.cwd));
    if (!done.length) return {};
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Opened in Apaki instead: ${done.join('; ')}. The user can see it there now.` } };
  }

  const shape = showShape();
  const readShape = viewReadShape();

  const mcpServer = () => createSdkMcpServer({
    name: 'apaki',
    version: APP_VERSION,
    // Small tools, always in the prompt: deferred behind tool search, the
    // system prompt's pointer to them would be a dead end.
    alwaysLoad: true,
    tools: [
      tool('show', SHOW_DESCRIPTION, shape, async (args, extra) => {
        const toolUseId = extra?._meta?.['claudecode/toolUseId'] || null;
        const r = await show(args, { via: 'show', toolUseId });
        return { content: [{ type: 'text', text: r.text }], isError: !r.ok };
      // Read-only for the user's files (it writes only Apaki's own store), so
      // plan mode can still show a diagram or a mockup.
      }, { annotations: { title: 'Show in Apaki', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } }),
      // The canvas's other half (2026-10-13): what the user made of something this conversation showed. Read only.
      tool('view_read', VIEW_READ_DESCRIPTION, readShape, async (args) => {
        const r = await viewRead(args);
        return { content: [{ type: 'text', text: r.text }], isError: !r.ok };
      }, { annotations: { title: 'Read from Apaki', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }),
      // The built-in browser's tools, when the shell has one (browser-tools.js).
      ...(browser ? browser.sdkTools() : []),
    ],
  });

  return {
    // A fresh server instance on every Claude Code start (an MCP server object
    // serves one connection), hence a function SessionRunner calls.
    mcpServers: () => ({ apaki: mcpServer() }),
    appendSystemPrompt: browser ? `${APAKI_SYSTEM_PROMPT} ${BROWSER_PROMPT}` : APAKI_SYSTEM_PROMPT,
    hooks: {
      PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [preToolUse] }],
      PostToolUse: [{ matcher: 'Bash|PowerShell', hooks: [postToolUse] }],
      UserPromptSubmit: [{ hooks: [userPromptSubmit] }],
    },
    show,
    viewRead,
    preToolUse,
    postToolUse,
    userPromptSubmit,
    mcpServer,
    browser,
  };
}
