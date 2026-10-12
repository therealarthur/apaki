/**
 * One live smoke test against the real `codex app-server` on this PC (2026-10-12), skipped unless APAKI_LIVE_CODEX=1.
 *
 * It sends nothing billable and starts no turn and no thread: it starts the process the way Apaki does, reads the model list,
 * the config's permission settings, the thread list and the newest page of one thread's history, and runs the real answers
 * through Apaki's own mapping. It asserts shapes only and prints no conversation text. What it guards: the protocol (the
 * snapshot in apaki/parity) still looks the way codex-client.js, codex-map.js and codex-history.js read it.
 *
 *   APAKI_LIVE_CODEX=1 node --test test/apaki-codex-live.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CodexAppServer, findCodex } from '../apaki/engine/codex-client.js';
import { CodexHistory } from '../apaki/engine/codex-history.js';
import { effortFor, normalizeModels, presetOf, threadRow, turnsToMessages } from '../apaki/engine/codex-map.js';
import { processOverrides } from '../apaki/engine/codex-panes.js';

const live = process.env.APAKI_LIVE_CODEX === '1' && !process.env.APAKI_CODEX_BIN;

test('the real app-server answers initialize, model/list, config/read, thread/list and thread/turns/list in the shapes Apaki reads', { skip: !live && 'set APAKI_LIVE_CODEX=1 to run against the real codex on this PC', timeout: 120000 }, async (t) => {
  const found = findCodex();
  assert.ok(found, 'codex is installed');
  // Started as Apaki starts it, including the -c overrides for its tool server (nothing is written; they are read as config).
  const overrides = processOverrides({ node: process.execPath, mcpScript: 'C:\\x\\apaki-mcp-stdio.mjs', openUrl: 'http://127.0.0.1:1/open', token: 'smoke', shim: null });
  const c = new CodexAppServer({ binary: found, overrides });
  c.on('log', () => {});
  t.after(() => c.stop());
  const init = await c.ensure();
  assert.match(String(init.userAgent), /^myrlin-apaki\/\d+\.\d+\.\d+/);
  assert.equal(typeof init.codexHome, 'string');

  const models = normalizeModels((await c.request('model/list', {})).data);
  assert.ok(models.length >= 1, 'at least one model');
  for (const m of models) { assert.ok(m.id && m.name); assert.ok(m.efforts.length >= 1); assert.ok(m.efforts.every((e) => e.value)); }
  const def = models.find((m) => m.isDefault) || models[0];
  assert.ok(def.efforts.some((e) => e.value === effortFor(def, def.defaultEffort)));

  const cfg = (await c.request('config/read', {})).config;
  assert.ok(['untrusted', 'on-request', 'never', 'on-failure'].includes(cfg.approval_policy) || typeof cfg.approval_policy === 'object' || cfg.approval_policy == null);
  assert.ok(['read-only', 'auto', 'full-access'].includes(presetOf({ approvalPolicy: cfg.approval_policy, sandbox: cfg.sandbox_mode })));
  // The tool server override was accepted as config (the config reflects the process's own overrides).
  assert.ok(cfg.mcp_servers && cfg.mcp_servers.apaki, 'the -c override reached this process');
  assert.equal(cfg.mcp_servers.apaki.command, process.execPath);

  const list = await c.request('thread/list', { limit: 5, sortKey: 'recency_at', sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], useStateDbOnly: true });
  assert.ok(Array.isArray(list.data));
  const rows = list.data.map(threadRow);
  for (const r of rows) { assert.match(r.id, /^codex:[0-9a-f-]{36}$/); assert.ok(r.title); assert.equal(r.codex, true); assert.ok(r.lastModified > 0); }
  if (!rows.length) return;

  const history = new CodexHistory({ request: (m, p) => c.request(m, p) });
  const page = await history.firstPage(list.data[0].id, { limit: 20 });
  assert.equal(page.source, 'codex');
  assert.ok(Array.isArray(page.messages));
  for (const m of page.messages) assert.ok(['user', 'assistant', 'compact', 'notice'].includes(m.type), m.type);
  // Every item of the page maps without throwing, whatever kinds this thread holds.
  const raw = await c.request('thread/turns/list', { threadId: list.data[0].id, limit: 3, itemsView: 'full' });
  assert.ok(Array.isArray(turnsToMessages((raw.data || []).slice().reverse())));
});
