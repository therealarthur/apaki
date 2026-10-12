#!/usr/bin/env node
/**
 * ledger-mcp-stdio.mjs: the switch ledger as a stdio MCP server ("apaki_ledger"), for both agents of a conversation
 * that moves between Claude Code and Codex in Myrlin Apaki.
 *
 * WHY (SWITCH.md, 2026-10-12: "The full record sits behind a small MCP server that both agents can query (search, get
 * event, full tool output)"): the handoff text is a summary and the recent turns; this server has the rest, read only.
 * It is given per process and never written into a config file: to a switched Claude pane's own Claude Code process
 * through the Agent SDK's mcpServers (with APAKI_LEDGER_LINK, its link), and to the Codex app-server with
 * `-c mcp_servers.apaki_ledger.*` (one process for every thread, so a call picks its link from the thread id Codex
 * sends in the call's metadata).
 *
 * Environment:
 *   APAKI_LEDGER_DIR       the links (switch.js: ~/.claude/latch/switch)
 *   APAKI_LEDGER_LINK      a fixed link id (a Claude pane's), optional
 *   APAKI_CLAUDE_DIR       where Claude Code keeps its transcripts, skills and CLAUDE.md
 *   APAKI_CODEX_ROLLOUTS   the rollout folders, joined with the path separator
 *
 * Tools: ledger_recent, ledger_search, ledger_event, ledger_tool_output, ledger_links, ledger_skills, ledger_skill,
 * ledger_instructions.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { claudeMdLayers, claudeSkills, memoryIndex } from './codex-env.js';
import { eventAt, eventLine, eventText, filesOf, loadLinks, pickLink, recent, search, threadOfMeta, toolOutput } from './ledger-query.js';

const DIR = process.env.APAKI_LEDGER_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'latch', 'switch');
const FIXED = process.env.APAKI_LEDGER_LINK || null;
const CLAUDE_DIR = process.env.APAKI_CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ROLLOUTS = String(process.env.APAKI_CODEX_ROLLOUTS || '').split(path.delimiter).filter(Boolean);
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const text = (t, isError = false) => ({ content: [{ type: 'text', text: String(t) }], isError });
const linkArg = z.string().optional().describe('Which switched conversation: a link id, a Claude session id or a Codex thread id. Leave it out for this conversation.');
const sideArg = z.enum(['claude', 'codex']).optional().describe('Only Claude\'s side or only Codex\'s side.');

/** The link and its files for a call, or an error result. */
function context(args, extra) {
  const link = pickLink(loadLinks(DIR), { asked: args?.link || null, fixed: FIXED, threadId: threadOfMeta(extra?._meta) });
  if (!link) return { error: text('No switched conversation is recorded yet: the ledger fills when a conversation is switched between Claude Code and Codex in Apaki.', true) };
  return { link, files: filesOf(link, { claudeDir: CLAUDE_DIR, rolloutRoots: ROLLOUTS }) };
}

const server = new McpServer({ name: 'apaki_ledger', version: '0.1.0' });

server.registerTool('ledger_recent', {
  title: 'Newest events of the switched conversation',
  description: 'The newest events (prompts, replies, tool calls and results, commands, file changes) of this conversation on Claude Code\'s side, Codex\'s side, or both, oldest first, one line each with its id for ledger_event.',
  inputSchema: { side: sideArg, limit: z.number().int().min(1).max(200).optional().describe('How many (default 30).'), link: linkArg },
  annotations: READ_ONLY,
}, async (args, extra) => {
  const c = context(args, extra);
  if (c.error) return c.error;
  const evs = await recent(c.files, { side: args.side || null, limit: args.limit || 30 });
  return text(evs.length ? evs.map(eventLine).join('\n') : 'Nothing recorded on that side yet.');
});

server.registerTool('ledger_search', {
  title: 'Search the switched conversation',
  description: 'Finds events on either side of this conversation (Claude Code and Codex) whose text, tool input or output contains all the given words, newest first, one line each with its id for ledger_event. Reads the whole record, also what no handoff carried.',
  inputSchema: { query: z.string().min(1).describe('Words to find (all must appear; case does not matter).'), side: sideArg, limit: z.number().int().min(1).max(100).optional().describe('How many (default 20).'), link: linkArg },
  annotations: READ_ONLY,
}, async (args, extra) => {
  const c = context(args, extra);
  if (c.error) return c.error;
  const evs = await search(c.files, args.query, { side: args.side || null, limit: args.limit || 20 });
  return text(evs.length ? evs.map(eventLine).join('\n') : `Nothing matches "${args.query}".`);
});

server.registerTool('ledger_event', {
  title: 'One event in full',
  description: 'One event of the switched conversation in full, by its id (like claude@1234 or codex@5678#1, from ledger_recent or ledger_search): the whole prompt or reply, the tool input, the output.',
  inputSchema: { id: z.string().describe('The event id.'), link: linkArg },
  annotations: READ_ONLY,
}, async (args, extra) => {
  const c = context(args, extra);
  if (c.error) return c.error;
  const evs = await eventAt(c.files, args.id);
  if (!evs.length) return text(`No event ${args.id} in this conversation.`, true);
  return text(eventText(evs[0]));
});

server.registerTool('ledger_tool_output', {
  title: 'A tool call\'s whole output',
  description: 'The whole output of one tool call or command of the switched conversation, by its call id (or the id of its event), a page at a time.',
  inputSchema: { callId: z.string().optional(), id: z.string().optional().describe('An event id of the call or its result.'), start: z.number().int().min(0).optional().describe('Character to start at (default 0).'), length: z.number().int().min(1000).max(200000).optional(), link: linkArg },
  annotations: READ_ONLY,
}, async (args, extra) => {
  const c = context(args, extra);
  if (c.error) return c.error;
  const r = await toolOutput(c.files, { callId: args.callId || null, id: args.id || null, start: args.start || 0, length: args.length || 50000 });
  if (!r.found) return text('No output found for that call.', true);
  return text(`${r.text}${r.next != null ? `\n\n[characters ${r.start} to ${r.next} of ${r.total}; ask again with start ${r.next} for more]` : ''}`);
});

server.registerTool('ledger_links', {
  title: 'Switched conversations',
  description: 'The conversations that moved between Claude Code and Codex in Apaki: their ids, which side is active, and each switch.',
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => {
  const links = loadLinks(DIR);
  if (!links.length) return text('None yet.');
  return text(links.slice(0, 30).map((l) => `${l.id}: Claude ${l.claude?.sessionId || '(none yet)'}, Codex ${l.codex?.threadId || '(none yet)'}, now on ${l.active || '?'}, ${l.switches?.length || 0} switch(es), folder ${l.cwd || '?'}${(l.switches || []).map((s) => `\n  ${s.n}. ${s.at} ${s.from} to ${s.to}${s.checkpoint?.ref ? ` (${s.checkpoint.ref})` : ''}`).join('')}`).join('\n'));
});

server.registerTool('ledger_skills', {
  title: 'The user\'s Claude Code skills',
  description: 'Lists the skills the user set up for Claude Code (name and what each is for). Read one with ledger_skill when the task matches it, and follow it as Claude would.',
  inputSchema: { link: linkArg },
  annotations: READ_ONLY,
}, async (args, extra) => {
  const c = context(args, extra);
  const skills = claudeSkills({ claudeDir: CLAUDE_DIR, cwd: c.link?.cwd || null });
  return text(skills.length ? skills.map((s) => `${s.name}${s.scope === 'project' ? ' (this project)' : ''}: ${s.description || '(no description)'}`).join('\n') : 'No Claude Code skills on this PC.');
});

server.registerTool('ledger_skill', {
  title: 'Read one Claude Code skill',
  description: 'The full text of one of the user\'s Claude Code skills, by name (from ledger_skills).',
  inputSchema: { name: z.string().min(1), link: linkArg },
  annotations: READ_ONLY,
}, async (args, extra) => {
  const c = context(args, extra);
  const s = claudeSkills({ claudeDir: CLAUDE_DIR, cwd: c.link?.cwd || null }).find((x) => x.name.toLowerCase() === String(args.name).toLowerCase());
  if (!s) return text(`No skill named ${args.name}.`, true);
  let body = '';
  try { body = fs.readFileSync(s.path, 'utf8'); } catch (e) { return text(`Could not read ${s.path}: ${e.message}`, true); }
  return text(`${s.path}\n\n${body.length > 60000 ? `${body.slice(0, 60000)}\n[... cut]` : body}`);
});

server.registerTool('ledger_instructions', {
  title: 'The user\'s working rules in full',
  description: 'The user\'s Claude Code instruction files in full (every CLAUDE.md that applies to this conversation\'s folder, broadest first), or with which: "memory" the memory index Claude keeps for the folder.',
  inputSchema: { which: z.enum(['rules', 'memory']).optional(), link: linkArg },
  annotations: READ_ONLY,
}, async (args, extra) => {
  const c = context(args, extra);
  const cwd = c.link?.cwd || os.homedir();
  if (args.which === 'memory') {
    const f = memoryIndex(cwd, { claudeDir: CLAUDE_DIR });
    if (!f) return text('Claude keeps no memory index for this folder.');
    return text(`${f}\n\n${fs.readFileSync(f, 'utf8').slice(0, 80000)}`);
  }
  const files = claudeMdLayers(cwd, { claudeDir: CLAUDE_DIR });
  if (!files.length) return text('No CLAUDE.md applies to this folder.');
  return text(files.map((f) => { let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch { t = '(unreadable)'; } return `===== ${f} =====\n${t.slice(0, 60000)}`; }).join('\n\n'));
});

await server.connect(new StdioServerTransport());
