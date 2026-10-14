#!/usr/bin/env node
/**
 * apaki-mcp-stdio.mjs: Apaki's tools as a stdio MCP server, for agents that cannot take an in-process server: the
 * Codex process a Codex pane in Myrlin Apaki runs.
 *
 * WHY (Arthur, 2026-10-09: artifacts like Codex has, for every agent Apaki runs; 2026-10-12: "make sure codex/chatgpt
 * sessions have the same knowledge of opening a browser/viewer in myrlin apaki as it does in codex/chatgpt app"):
 * Claude Code gets the tools in process (apaki-tools.js). Codex takes MCP servers as commands, and Apaki gives it this
 * one at runtime only, on the app-server's own command line (codex-panes.js processOverrides: -c mcp_servers.apaki.*),
 * with no config file written. Because it is a process-wide setting it reaches every thread, resumed ones included.
 *
 * Two modes, by environment:
 *   APAKI_TOOL_PROXY=1 (what a Codex pane sets)   the tools are show plus browser_open, _read, _click, _type, _back and
 *       _screenshot, and every call is forwarded to the running engine (POST /tool on APAKI_OPEN_URL's server, with
 *       APAKI_OPEN_TOKEN): the engine runs it for the Codex pane whose turn is running, so the viewer, the browser and
 *       the cards are the pane's own. Nothing is stored here. Since 2026-10-13 view_read too (the user's edits of what was
 *       shown), forwarded the same way.
 *   otherwise (kept for tests and for a stand-alone run)   show (and view_read, which reads the same folder): show writes the artifact into
 *       ~/.claude/latch/artifacts/<APAKI_SESSION_ID>/ and tells the engine on /shown (and web pages on /open):
 *         APAKI_OPEN_URL    http://127.0.0.1:<port>/open of the engine (its /shown and /tool sit next to it)
 *         APAKI_OPEN_TOKEN  the pane's token
 *         APAKI_SESSION_ID  the session folder to store under (default "codex")
 *       Without them it still stores, and says the user can open it from Apaki.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { APP_VERSION } from './app-version.js';
import { ArtifactStore } from './artifacts.js';
import { SHOW_DESCRIPTION, VIEW_READ_DESCRIPTION, createApakiTools, showShape, viewReadShape } from './apaki-tools.js';
import { browserToolSpecs } from './browser-tools.js';

const openUrl = process.env.APAKI_OPEN_URL || '';
const token = process.env.APAKI_OPEN_TOKEN || '';
const proxy = process.env.APAKI_TOOL_PROXY === '1' && Boolean(openUrl) && Boolean(token);
const post = async (route, body, { timeoutMs = 4000, json = false } = {}) => {
  if (!openUrl || !token) return json ? null : false;
  try {
    const r = await fetch(openUrl.replace(/\/open$/, route), { method: 'POST', headers: { 'content-type': 'application/json', 'x-apaki-token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return json ? (r.ok ? await r.json() : null) : r.ok;
  } catch { return json ? null : false; }
};

const server = new McpServer({ name: 'apaki', version: APP_VERSION });

/** An MCP result from the engine's { ok, text, image?, mimeType? }. */
const asResult = (r) => ({
  content: [{ type: 'text', text: r ? r.text : 'Apaki did not answer. Is the Apaki window still running?' }, ...(r?.image ? [{ type: 'image', data: r.image, mimeType: r.mimeType || 'image/png' }] : [])],
  isError: !r?.ok,
});

if (proxy) {
  // Every call runs in the engine. The browser tools wait for pages to load, so the timeout is long.
  const forward = (tool) => async (args, extra) => asResult(await post('/tool', { tool, input: args || {}, meta: extra?._meta || {} }, { timeoutMs: 110000, json: true }));
  server.registerTool('show', { title: 'Show in Apaki', description: SHOW_DESCRIPTION, inputSchema: showShape(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, forward('show'));
  // 2026-10-13: what the user made of an artifact (their edits in the viewer), read in the engine for the pane.
  server.registerTool('view_read', { title: 'Read from Apaki', description: VIEW_READ_DESCRIPTION, inputSchema: viewReadShape(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, forward('view_read'));
  for (const s of browserToolSpecs()) server.registerTool(s.name, { title: s.annotations.title, description: s.description, inputSchema: s.shape, annotations: s.annotations }, forward(s.name));
} else {
  const tools = createApakiTools({
    store: new ArtifactStore(),
    sessionId: () => process.env.APAKI_SESSION_ID || 'codex',
    cwd: () => process.cwd(),
    onArtifact: (rec) => { post('/shown', { sessionId: rec.sessionId, id: rec.id }); },
    onOpenUrl: (o) => { post('/open', { url: o.url }); },
  });
  server.registerTool('show', { title: 'Show in Apaki', description: SHOW_DESCRIPTION, inputSchema: showShape() }, async (args) => {
    const r = await tools.show(args, { via: 'show' });
    return { content: [{ type: 'text', text: r.text }], isError: !r.ok };
  });
  server.registerTool('view_read', { title: 'Read from Apaki', description: VIEW_READ_DESCRIPTION, inputSchema: viewReadShape() }, async (args) => {
    const r = await tools.viewRead(args);
    return { content: [{ type: 'text', text: r.text }], isError: !r.ok };
  });
}
await server.connect(new StdioServerTransport());
