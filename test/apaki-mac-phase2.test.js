/**
 * Tests for the pieces of the macOS port (phase 2, 2026-10-13) that run on any OS: the platform answers for the bundled
 * voice folder and the BROWSER shim, the voice model download (against a local server, checksum kept or discarded), the
 * shell shim apaki-open, and that the browser bridge script (browser_mac_bridge.js) is valid JavaScript that returns
 * the object the Rust side calls.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { downloadModel } from '../apaki/engine/voice-model.js';
import { bundledVoiceDir, openShimName } from '../src/platform.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runs a program without blocking this process (the servers in these tests live in it). */
const run = (file, args, env) => new Promise((resolve) => {
  const c = spawn(file, args, { env });
  let stderr = '';
  c.stderr.on('data', (d) => { stderr += d; });
  c.on('close', (status) => resolve({ status, stderr }));
});

test('the voice folder inside a Mac app is found beside the engine, and only there', () => {
  const app = '/Applications/Myrlin Apaki.app/Contents/Resources';
  assert.equal(bundledVoiceDir(`${app}/engine`, { platform: 'darwin' }), `${app}/voice`);
  // A source checkout, a Windows package and a Linux box have no bundle.
  assert.equal(bundledVoiceDir('/Users/a/Projects/claude-latch', { platform: 'darwin' }), null);
  assert.equal(bundledVoiceDir('/opt/apaki/engine', { platform: 'darwin' }), null);
  assert.equal(bundledVoiceDir(`${app}/engine`, { platform: 'win32' }), null);
  assert.equal(bundledVoiceDir(`${app}/engine`, { platform: 'linux' }), null);
});

test('the BROWSER shim is the batch file on Windows and the shell script elsewhere, and both exist', () => {
  assert.equal(openShimName('win32'), 'apaki-open.cmd');
  assert.equal(openShimName('darwin'), 'apaki-open');
  assert.equal(openShimName('linux'), 'apaki-open');
  for (const n of ['apaki-open.cmd', 'apaki-open', 'apaki-open.mjs']) assert.ok(fs.existsSync(path.join(root, 'apaki', 'bin', n)), n);
  const sh = fs.readFileSync(path.join(root, 'apaki', 'bin', 'apaki-open'), 'utf8');
  assert.ok(sh.startsWith('#!/bin/sh\n'), 'a shell script with LF endings');
  assert.ok(!sh.includes('\r'), 'no carriage returns');
});

async function serve(body, { status = 200 } = {}) {
  const srv = http.createServer((req, res) => { res.writeHead(status, { 'content-length': body.length }); res.end(body); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/m.bin`, close: () => new Promise((r) => srv.close(r)) };
}

test('the voice model is written once its checksum matches, with progress', async () => {
  const body = Buffer.alloc(300000, 7);
  const sum = createHash('sha256').update(body).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-model-'));
  const s = await serve(body);
  try {
    const file = path.join(dir, 'models', 'ggml-base.en.bin');
    const seen = [];
    const r = await downloadModel({ file, url: s.url, sha256: sum, bytes: body.length, onProgress: (got, total) => seen.push([got, total]) });
    assert.equal(r.bytes, body.length);
    assert.deepEqual(fs.readFileSync(file), body);
    assert.ok(!fs.existsSync(`${file}.part`), 'no partial file left');
    assert.equal(seen.at(-1)[0], body.length);
    assert.equal(seen.at(-1)[1], body.length);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a model whose checksum differs is deleted, and a server error leaves nothing', async () => {
  const body = Buffer.alloc(1000, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-model-'));
  const bad = await serve(body);
  const gone = await serve(Buffer.from('no'), { status: 404 });
  try {
    const file = path.join(dir, 'm.bin');
    await assert.rejects(downloadModel({ file, url: bad.url, sha256: 'f'.repeat(64) }), /checksum/);
    assert.ok(!fs.existsSync(file) && !fs.existsSync(`${file}.part`));
    await assert.rejects(downloadModel({ file, url: gone.url, sha256: null }), /404/);
    assert.ok(!fs.existsSync(file));
  } finally { await bad.close(); await gone.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('apaki-open hands a URL whole to the engine (POSIX shells only)', { skip: process.platform === 'win32' && 'a shell script' }, async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => { got.push({ token: req.headers['x-apaki-token'], body: JSON.parse(b) }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = 'http://127.0.0.1:5173/p?a=1&b=2&c=3';
    const r = await run('sh', [path.join(root, 'apaki', 'bin', 'apaki-open'), url], { ...process.env, APAKI_NODE: process.execPath, APAKI_OPEN_URL: `http://127.0.0.1:${srv.address().port}/open`, APAKI_OPEN_TOKEN: 'tok', APAKI_OPEN_NO_FALLBACK: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(got, [{ token: 'tok', body: { url } }]);
  } finally { srv.close(); }
});

test('apaki-open.mjs still runs when it is started through a symlinked folder (/tmp is /private/tmp on a Mac)', { skip: process.platform === 'win32' && 'needs symlinks' }, async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { got.push(JSON.parse(b).url); res.writeHead(200); res.end('ok'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-open-real-'));
  const link = `${real}-link`;
  try {
    fs.copyFileSync(path.join(root, 'apaki', 'bin', 'apaki-open.mjs'), path.join(real, 'apaki-open.mjs'));
    fs.symlinkSync(real, link, 'dir');
    const r = await run(process.execPath, [path.join(link, 'apaki-open.mjs'), 'http://127.0.0.1:5173/a?b=1&c=2'], { ...process.env, APAKI_OPEN_URL: `http://127.0.0.1:${srv.address().port}/open`, APAKI_OPEN_TOKEN: 'tok', APAKI_OPEN_NO_FALLBACK: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(got, ['http://127.0.0.1:5173/a?b=1&c=2']);
  } finally { srv.close(); fs.rmSync(link, { force: true }); fs.rmSync(real, { recursive: true, force: true }); }
});

test('the browser bridge script is valid JavaScript that evaluates to a function returning the bridge', () => {
  const src = fs.readFileSync(path.join(root, 'apaki', 'src', 'browser_mac_bridge.js'), 'utf8');
  // Evaluated the way browser_mac.rs does: `(<file>)()` is the bridge, installed on window.__apakiMac.
  const win = {};
  const make = new Function('window', 'document', `return (${src})`);
  const bridge = make(win, {})();
  assert.equal(bridge.v, 1);
  for (const f of ['mouse', 'insertText', 'key']) assert.equal(typeof bridge[f], 'function', f);
  assert.equal(win.__apakiMac, bridge);
  assert.equal(make(win, {})(), bridge, 'a second call reuses the same object');
});
