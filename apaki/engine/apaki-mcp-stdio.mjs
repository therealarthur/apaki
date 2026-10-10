#!/usr/bin/env node
/**
 * apaki-mcp-stdio.mjs: Apaki's `show` tool as a stdio MCP server, for agents
 * that cannot take an in-process server: a later Codex tab in Myrlin Apaki.
 *
 * WHY (Arthur, 2026-10-09: artifacts like Codex has, for every agent Apaki
 * runs): Claude Code gets the tool in process (apaki-tools.js). Codex takes
 * MCP servers as commands, and Apaki will wire this one at runtime only, with
 * no config file written:
 *   codex -c mcp_servers.apaki.command="<node>" -c 'mcp_servers.apaki.args=["<this file>"]'
 *         -c mcp_servers.apaki.env.APAKI_OPEN_URL=... (and the other variables below)
 * (not wired yet; the Codex tab is a later piece of work).
 *
 * Same tool, same store, same results as the in-process server: it writes the
 * artifact into ~/.claude/latch/artifacts/<APAKI_SESSION_ID>/ and tells the
 * running engine, which shows it in the pane:
 *   APAKI_OPEN_URL    http://127.0.0.1:<port>/open of the engine (its /shown sits next to it)
 *   APAKI_OPEN_TOKEN  the pane's token
 *   APAKI_SESSION_ID  the session folder to store under (default "codex")
 * Without them it still stores, and says the user can open it from Apaki.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ArtifactStore } from './artifacts.js';
import { SHOW_DESCRIPTION, createApakiTools, showShape } from './apaki-tools.js';

const openUrl = process.env.APAKI_OPEN_URL || '';
const token = process.env.APAKI_OPEN_TOKEN || '';
const post = async (route, body) => {
  if (!openUrl || !token) return false;
  try {
    const r = await fetch(openUrl.replace(/\/open$/, route), { method: 'POST', headers: { 'content-type': 'application/json', 'x-apaki-token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
};

const tools = createApakiTools({
  store: new ArtifactStore(),
  sessionId: () => process.env.APAKI_SESSION_ID || 'codex',
  cwd: () => process.cwd(),
  onArtifact: (rec) => { post('/shown', { sessionId: rec.sessionId, id: rec.id }); },
  onOpenUrl: (o) => { post('/open', { url: o.url }); },
});

const server = new McpServer({ name: 'apaki', version: '0.1.0' });
server.registerTool('show', { title: 'Show in Apaki', description: SHOW_DESCRIPTION, inputSchema: showShape() }, async (args) => {
  const r = await tools.show(args, { via: 'show' });
  return { content: [{ type: 'text', text: r.text }], isError: !r.ok };
});
await server.connect(new StdioServerTransport());
