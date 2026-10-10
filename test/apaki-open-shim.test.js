/**
 * Tests for the BROWSER shim Myrlin Apaki gives Claude Code
 * (apaki/bin/apaki-open.cmd + apaki-open.mjs): the URL reaches the engine's
 * /open endpoint with the pane's token, a URL that cmd cut at an unquoted
 * "&" is recovered whole, and the cut-off rest never runs as a command. On
 * Windows it also runs Python's webbrowser for real with BROWSER set. The OS
 * browser fallback is switched off (APAKI_OPEN_NO_FALLBACK), so nothing opens.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ArtifactStore } from '../apaki/engine/artifacts.js';
import { startOpenServer } from '../apaki/engine/open-server.js';
import { fullUrl, startedByCmdC } from '../apaki/bin/apaki-open.mjs';

const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apaki', 'bin', 'apaki-open.cmd');
const win = process.platform === 'win32';

test('fullUrl recovers what cmd cut at "&", and stops at spaces and quotes', () => {
  const line = 'C:\\WINDOWS\\system32\\cmd.exe /c "C:\\x\\apaki-open.cmd http://h/p?a=1&b=2&c=3"';
  assert.equal(fullUrl('http://h/p?a=1', line), 'http://h/p?a=1&b=2&c=3"'.replace(/"$/, ''));
  assert.equal(fullUrl('http://h/p?a=1', 'cmd /c ""x\\apaki-open.cmd" "http://h/p?a=1&b=2""'), 'http://h/p?a=1&b=2');
  assert.equal(fullUrl('http://h/', ''), 'http://h/');
  assert.equal(fullUrl('http://h/', 'C:\\WINDOWS\\system32\\cmd.exe'), 'http://h/');
  assert.equal(startedByCmdC(line), true);
  assert.equal(startedByCmdC('C:\\WINDOWS\\system32\\cmd.exe'), false);
});

async function withServer(fn) {
  const store = new ArtifactStore({ root: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-shim-')), 'artifacts') });
  const got = [];
  const srv = await startOpenServer({ store, onOpen: (paneId, url) => got.push({ paneId, url }) });
  const env = { ...process.env, APAKI_OPEN_URL: srv.openUrl, APAKI_OPEN_TOKEN: srv.paneToken('pane-7'), APAKI_NODE: process.execPath, APAKI_OPEN_NO_FALLBACK: '1' };
  try { await fn({ srv, got, env }); } finally { await srv.close(); }
}

const run = (file, args, opts) => new Promise((resolve) => {
  const c = spawn(file, args, { ...opts, windowsHide: true });
  let out = '';
  let err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, out, err }));
});

test('the shim hands a URL with "&" to the engine whole, and nothing after "&" runs', { skip: !win && 'Windows batch shim' }, async () => {
  await withServer(async ({ got, env }) => {
    // Exactly what CreateProcess does for a .cmd started without quotes (Python's Popen).
    const r = await run('cmd.exe', ['/d', '/c', `${SHIM} http://127.0.0.1:5173/p?a=1&echo=INJECTED&b=2`], { env, windowsVerbatimArguments: true });
    assert.deepEqual(got, [{ paneId: 'pane-7', url: 'http://127.0.0.1:5173/p?a=1&echo=INJECTED&b=2' }]);
    assert.doesNotMatch(r.err + r.out, /not recognized|INJECTED/);
    // Quoted, the way PowerShell Start-Process (npm's open, vite) passes it.
    await run('cmd.exe', ['/d', '/c', `""${SHIM}" "http://localhost:3000/x?y=1&z=2""`], { env, windowsVerbatimArguments: true });
    assert.equal(got[1].url, 'http://localhost:3000/x?y=1&z=2');
  });
});

test('Python webbrowser with BROWSER set opens inside Apaki', { skip: !win && 'Windows batch shim' }, async (t) => {
  const py = await new Promise((r) => execFile('python', ['--version'], { windowsHide: true }, (e) => r(!e)));
  if (!py) { t.skip('python not installed'); return; }
  await withServer(async ({ got, env }) => {
    const r = await run('python', ['-c', "import webbrowser,sys; sys.exit(0 if webbrowser.open('http://127.0.0.1:8888/tree?token=abc&x=1') else 5)"], { env: { ...env, BROWSER: SHIM } });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(got, [{ paneId: 'pane-7', url: 'http://127.0.0.1:8888/tree?token=abc&x=1' }]);
  });
});

test('a wrong token is refused (and with the fallback off, nothing else happens)', { skip: !win && 'Windows batch shim' }, async () => {
  await withServer(async ({ got, env }) => {
    await run('cmd.exe', ['/d', '/c', `${SHIM} http://127.0.0.1:1/`], { env: { ...env, APAKI_OPEN_TOKEN: 'wrong' }, windowsVerbatimArguments: true });
    assert.deepEqual(got, []);
  });
});
