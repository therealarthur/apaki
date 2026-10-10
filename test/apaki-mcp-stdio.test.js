/**
 * Tests for apaki/engine/apaki-mcp-stdio.mjs, the stdio form of Apaki's show
 * tool (for a later Codex tab): a real MCP client starts it as a child
 * process, calls show, and the artifact lands in the store while the engine's
 * server hears about it on /shown (and web pages on /open) with the pane's
 * token. No model call.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ArtifactStore } from '../apaki/engine/artifacts.js';
import { startOpenServer } from '../apaki/engine/open-server.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apaki', 'engine', 'apaki-mcp-stdio.mjs');

test('the stdio show tool stores the artifact and tells the engine which pane shows it', async () => {
  const latch = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-stdio-'));
  const store = new ArtifactStore({ root: path.join(latch, 'artifacts') });
  const shown = [];
  const opened = [];
  const srv = await startOpenServer({ store, onShown: (paneId, a) => shown.push({ paneId, ...a }), onOpen: (paneId, url) => opened.push({ paneId, url }) });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SCRIPT],
    env: { ...process.env, LATCH_DIR: latch, APAKI_OPEN_URL: srv.openUrl, APAKI_OPEN_TOKEN: srv.paneToken('codex-pane'), APAKI_SESSION_ID: 'codex-thread-1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['show']);
    const r = await client.callTool({ name: 'show', arguments: { title: 'From Codex', kind: 'markdown', content: '# hi' } });
    assert.equal(r.isError, false);
    assert.match(r.content[0].text, /artifact from-codex-[0-9a-f]{4}, rev 1, markdown/);
    for (let i = 0; i < 40 && !shown.length; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(shown.length, 1);
    assert.equal(shown[0].paneId, 'codex-pane');
    assert.equal(shown[0].sessionId, 'codex-thread-1');
    assert.equal(store.get(shown[0].id, { sessionId: 'codex-thread-1' }).buf.toString(), '# hi');
    await client.callTool({ name: 'show', arguments: { title: 'Dev', kind: 'url', url: 'http://localhost:5173/' } });
    for (let i = 0; i < 40 && !opened.length; i++) await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(opened, [{ paneId: 'codex-pane', url: 'http://localhost:5173/' }]);
  } finally {
    await client.close();
    await srv.close();
  }
});
