/**
 * Tests for apaki/mobile/scripts/build-app.mjs: the page the Apaki app
 * ships. It must be the phone web client from this commit, start the app
 * entry, connect to nothing by itself (strict CSP), swap only the modules
 * it says it swaps (with the same exports), and never carry the demo PC
 * unless asked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_CSP, APP_FILES, buildApp } from '../scripts/build-app.mjs';
import { exportNames } from '../src/codec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(here, '..', '..', 'web', 'src');

function stubCore(dir) {
  const f = path.join(dir, 'capacitor-core.js');
  fs.writeFileSync(f, 'export const Capacitor = {}; export const registerPlugin = () => ({});\n');
  return f;
}

function withBuild(opts, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-app-test-'));
  try {
    const out = path.join(tmp, 'www');
    const r = buildApp({ ...opts, out, core: stubCore(tmp) });
    fn(r, out);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('the app page: entry script, strict CSP, app files, swapped store and scanner, no PWA parts, no demo', () => {
  withBuild({}, (r, out) => {
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, new RegExp(`<script type="module" src="app/entry.js\\?v=${r.version}"></script>`));
    assert.doesNotMatch(html, /src="boot\.js/);
    assert.ok(html.includes(`content="${APP_CSP}"`));
    assert.match(APP_CSP, /connect-src 'self';/);
    assert.doesNotMatch(APP_CSP, /wss:|https:|unsafe-eval/);
    assert.equal((html.match(/Content-Security-Policy/g) || []).length, 1);
    assert.match(html, /app\/mobile\.css/);
    assert.doesNotMatch(html, /manifest\.webmanifest/);
    assert.ok(!fs.existsSync(path.join(out, 'sw.js')));
    for (const f of APP_FILES) assert.ok(fs.existsSync(path.join(out, 'app', f)), f);
    assert.ok(fs.existsSync(path.join(out, 'app', 'vendor', 'capacitor-core.js')));
    assert.ok(!fs.existsSync(path.join(out, 'app', 'demo')), 'no pretend PC in a normal build');
    assert.match(fs.readFileSync(path.join(out, 'app', 'build.js'), 'utf8'), /"demo":false/);
    assert.equal(r.build.demo, false);

    const store = fs.readFileSync(path.join(out, 'store.js'), 'utf8');
    assert.match(store, /from '\.\/app\/native-store\.js'/);
    for (const name of exportNames(fs.readFileSync(path.join(WEB_SRC, 'store.js'), 'utf8'))) assert.ok(exportNames(store).includes(name), name);
    assert.ok(exportNames(store).includes('newDevice'));
    assert.match(fs.readFileSync(path.join(out, 'scan.js'), 'utf8'), /scan-native\.js/);
    // The connection itself is the web client's own.
    assert.equal(fs.readFileSync(path.join(out, 'link.js'), 'utf8'), fs.readFileSync(path.join(WEB_SRC, 'link.js'), 'utf8').replace(/\r\n/g, '\n'));
    assert.match(fs.readFileSync(path.join(out, 'boot.js'), 'utf8'), /store\.newDevice/);
  });
});

test('a demo build swaps in the pretend PC and says so', () => {
  withBuild({ demo: true }, (r, out) => {
    assert.equal(r.build.demo, true);
    assert.match(fs.readFileSync(path.join(out, 'link.js'), 'utf8'), /demo-link\.js/);
    assert.match(fs.readFileSync(path.join(out, 'store.js'), 'utf8'), /demo-store\.js/);
    assert.ok(fs.existsSync(path.join(out, 'app', 'demo', 'demo-setup.js')));
    assert.match(fs.readFileSync(path.join(out, 'app', 'build.js'), 'utf8'), /"demo":true/);
  });
});
