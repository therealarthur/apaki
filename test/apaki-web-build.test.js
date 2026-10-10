/**
 * The phone web client's build (apaki/scripts/build-web.mjs): Apaki's own
 * window plus the phone parts, a page policy that allows one relay only, a
 * service worker listing exactly this build's files, and every import
 * resolving inside the build.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { build } from '../apaki/scripts/build-web.mjs';

test('the web build reuses the window, pins the relay in its CSP, and versions its assets', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-web-test-'));
  try {
    const r = build({ relay: 'wss://relay.example:8443/', out });
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
    assert.match(csp, /connect-src wss:\/\/relay\.example:8443(;|$)/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.ok(!/unsafe-eval/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp));
    assert.ok(html.includes(`src="boot.js?v=${r.version}"`) && !html.includes('src="app.js"'));
    assert.ok(html.includes('id="pairScreen"') && html.includes('id="drawerBtn"') && html.includes('id="pcLine"'));
    assert.ok(html.includes('<body class="web">'));
    for (const f of ['app.js', 'pane.js', 'theme.js', 'app.css', 'web.css', 'boot.js', 'shim.js', 'link.js', 'protocol.js', 'wire.js', 'manifest.webmanifest', 'icons/icon-512.png', 'icons/favicon.svg', 'fonts/Archivo-normal.woff2']) {
      assert.ok(fs.existsSync(path.join(out, f)), f);
    }
    assert.ok(!fs.existsSync(path.join(out, 'phone.js')), 'the desktop Phone sheet stays on the desktop');
    const sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
    assert.ok(sw.includes(`const VERSION = '${r.version}'`));
    const assets = JSON.parse(/const ASSETS = (\[.*\]);/.exec(sw)[1]);
    assert.ok(assets.includes('./boot.js') && assets.includes(`./boot.js?v=${r.version}`) && assets.includes('./'));
    for (const a of assets) if (a !== './') assert.ok(fs.existsSync(path.join(out, a.replace(/^\.\//, '').replace(/\?v=.*$/, ''))), a);
    // The same inputs give the same version; another relay gives another.
    const again = build({ relay: 'wss://relay.example:8443/', out });
    assert.equal(again.version, r.version);
    assert.notEqual(build({ relay: 'wss://other.example', out }).version, r.version);
    assert.throws(() => build({ relay: 'https://relay.example', out }), /ws:\/\/ or wss:\/\//);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
