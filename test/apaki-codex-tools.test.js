/**
 * Apaki's show and browser tools for Codex (apaki-mcp-stdio.mjs in proxy mode, open-server.js POST /tool,
 * browser-tools.js browserToolSpecs), 2026-10-12.
 *
 * A Codex process gets Apaki's tools as a stdio MCP server it starts itself. In proxy mode that server holds nothing: it lists
 * the tools and forwards every call to the engine's localhost server with the process's token, and the engine runs the call
 * for the pane whose turn is running. A real MCP client starts the real script here; the engine's side is a function.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { ArtifactStore } from '../apaki/engine/artifacts.js';
import { BROWSER_TOOLS, browserToolSpecs, createBrowserTools } from '../apaki/engine/browser-tools.js';
import { startOpenServer } from '../apaki/engine/open-server.js';
import { APAKI_BROWSER_TOOLS } from '../apaki/engine/remote-policy.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apaki', 'engine', 'apaki-mcp-stdio.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-codex-tools-'));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } };

test('the browser tools as specs match the in-process server\'s tools word for word, and the phone policy lists the same names', () => {
  const specs = browserToolSpecs();
  assert.deepEqual(specs.map((s) => s.name), BROWSER_TOOLS);
  const inProcess = createBrowserTools({ shell: { request: async () => ({}) }, owner: () => 'p' }).sdkTools();
  assert.deepEqual(inProcess.map((t) => t.name), specs.map((s) => s.name));
  for (const t of inProcess) {
    const s = specs.find((x) => x.name === t.name);
    assert.equal(s.description, t.description, `${t.name} says the same to both agents`);
    assert.deepEqual(Object.keys(s.shape).sort(), Object.keys(t.inputSchema).sort(), `${t.name} takes the same fields`);
  }
  assert.deepEqual(APAKI_BROWSER_TOOLS, specs.map((s) => `mcp__apaki__${s.name}`), 'a restricted phone is refused exactly these');
});

test('the tool server in proxy mode lists show and the seven browser tools and forwards every call to the engine with the process\'s token', async (t) => {
  const dir = tmp();
  t.after(() => rm(dir));
  const store = new ArtifactStore({ root: path.join(dir, 'artifacts') });
  const seen = [];
  const srv = await startOpenServer({
    store,
    onTool: async (paneId, tool, input, meta) => {
      seen.push({ paneId, tool, input, meta });
      if (tool === 'browser_screenshot') return { ok: true, text: 'Screenshot of x', image: 'iVBORw0KGgo=', mimeType: 'image/png' };
      if (tool === 'browser_read') return { ok: false, text: 'The browser has no page yet.' };
      if (tool === 'browser_back') throw new Error('the pane went away');
      return { ok: true, text: `ok ${tool}` };
    },
  });
  t.after(() => srv.close());
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SCRIPT], stderr: 'pipe',
    env: { ...process.env, LATCH_DIR: dir, APAKI_TOOL_PROXY: '1', APAKI_OPEN_URL: srv.openUrl, APAKI_OPEN_TOKEN: srv.paneToken('codex-shared') },
  });
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ['browser_back', 'browser_click', 'browser_open', 'browser_read', 'browser_screenshot', 'browser_tabs', 'browser_type', 'show']);
  const show = tools.find((x) => x.name === 'show');
  assert.match(show.description, /Show the user something inside Myrlin Apaki/);
  assert.deepEqual(show.inputSchema.required.sort(), ['kind', 'title']);
  assert.equal(show.annotations.readOnlyHint, true, 'Codex does not ask before a tool that only shows');
  const click = tools.find((x) => x.name === 'browser_click');
  assert.ok(click.inputSchema.properties.ref);

  const shown = await client.callTool({ name: 'show', arguments: { title: 'T', kind: 'markdown', content: '# hi' } });
  assert.equal(shown.isError, false);
  assert.equal(shown.content[0].text, 'ok show');
  assert.deepEqual(seen[0], { paneId: 'codex-shared', tool: 'show', input: { title: 'T', kind: 'markdown', content: '# hi' }, meta: seen[0].meta });
  const shot = await client.callTool({ name: 'browser_screenshot', arguments: {} });
  assert.equal(shot.isError, false);
  assert.deepEqual(shot.content.map((c) => c.type), ['text', 'image']);
  assert.equal(shot.content[1].mimeType, 'image/png');
  assert.equal(shot.content[1].data, 'iVBORw0KGgo=');
  const read = await client.callTool({ name: 'browser_read', arguments: {} });
  assert.equal(read.isError, true);
  assert.equal(read.content[0].text, 'The browser has no page yet.');
  const back = await client.callTool({ name: 'browser_back', arguments: {} });
  assert.equal(back.isError, true, 'an engine failure is the tool\'s error, with its words');
  assert.match(back.content[0].text, /the pane went away/);
  const typed = await client.callTool({ name: 'browser_type', arguments: { ref: 12, text: 'hello', submit: true } });
  assert.equal(typed.isError, false);
  assert.deepEqual(seen.find((s) => s.tool === 'browser_type').input, { ref: 12, text: 'hello', submit: true });
  const root = path.join(dir, 'artifacts');
  assert.equal(fs.existsSync(root) ? fs.readdirSync(root).filter((n) => !n.startsWith('_')).length : 0, 0, 'the proxy stores nothing itself');
});

test('without the engine the proxy says so instead of hanging, and the engine refuses a token it did not hand out', async (t) => {
  const dir = tmp();
  t.after(() => rm(dir));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SCRIPT], stderr: 'pipe',
    env: { ...process.env, LATCH_DIR: dir, APAKI_TOOL_PROXY: '1', APAKI_OPEN_URL: 'http://127.0.0.1:9/open', APAKI_OPEN_TOKEN: 'x' },
  });
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const r = await client.callTool({ name: 'show', arguments: { title: 'T', kind: 'markdown', content: '#' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Apaki did not answer/);

  const srv = await startOpenServer({ store: new ArtifactStore({ root: path.join(dir, 'a') }), onTool: async () => ({ ok: true, text: 'x' }) });
  t.after(() => srv.close());
  const url = srv.openUrl.replace(/\/open$/, '/tool');
  const post = (headers, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post({ 'x-apaki-token': 'nope' }, '{"tool":"show"}')).status, 403);
  assert.equal((await post({ 'x-apaki-token': srv.paneToken('p') }, '{"nothing":1}')).status, 400);
  assert.equal((await post({ 'x-apaki-token': srv.paneToken('p') }, 'not json')).status, 400);
  const good = await post({ 'x-apaki-token': srv.paneToken('p') }, '{"tool":"show","input":{"a":1}}');
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { ok: true, text: 'x' });
  assert.equal((await fetch(url)).status, 404, 'GET is not the tool route');
  // A server without a tool handler has no /tool route (the older callers' behaviour).
  const old = await startOpenServer({ store: new ArtifactStore({ root: path.join(dir, 'b') }) });
  t.after(() => old.close());
  assert.equal((await fetch(old.openUrl.replace(/\/open$/, '/tool'), { method: 'POST', headers: { 'x-apaki-token': old.paneToken('p') }, body: '{"tool":"show"}' })).status, 404);
});
