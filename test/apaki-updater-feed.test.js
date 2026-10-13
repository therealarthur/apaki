/**
 * apaki-updater-feed.test.js: the update feed (latest.json) the release workflow publishes (2026-10-13), and the
 * updater settings the apps carry.
 *
 * The feed is what every installed Apaki asks, so its shape is checked closely: one entry per platform with the .sig's
 * text and an address that matches the asset name GitHub will serve, and no half-made feed (an installer without a
 * signature would be refused by every app, so the release must fail instead of publishing it).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildFeed } from '../apaki/scripts/updater-feed.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIGS = { 'Myrlin-Apaki_0.2.0_x64-setup.exe.sig': 'SIG-WIN\n', 'Myrlin-Apaki_0.2.0_aarch64.app.tar.gz.sig': 'SIG-MAC\n' };
const FILES = ['Myrlin-Apaki_0.2.0_x64-setup.exe', 'Myrlin-Apaki_0.2.0_x64-setup.exe.sig', 'Myrlin-Apaki_0.2.0_aarch64.app.tar.gz', 'Myrlin-Apaki_0.2.0_aarch64.app.tar.gz.sig', 'Myrlin-Apaki_0.2.0_aarch64.dmg'];
const url = (n) => `https://example.test/dl/${encodeURIComponent(n)}`;

test('a feed lists Windows and the Mac with their signatures and download addresses', () => {
  const feed = buildFeed({ files: FILES, version: '0.2.0', notes: 'Fixes.', date: '2026-10-13T00:00:00.000Z', url, readSig: (n) => SIGS[n] });
  assert.equal(feed.version, '0.2.0');
  assert.equal(feed.notes, 'Fixes.');
  assert.equal(feed.pub_date, '2026-10-13T00:00:00.000Z');
  assert.deepEqual(Object.keys(feed.platforms).sort(), ['darwin-aarch64', 'darwin-aarch64-app', 'windows-x86_64', 'windows-x86_64-nsis']);
  assert.deepEqual(feed.platforms['windows-x86_64'], { signature: 'SIG-WIN', url: 'https://example.test/dl/Myrlin-Apaki_0.2.0_x64-setup.exe' });
  assert.deepEqual(feed.platforms['darwin-aarch64'], { signature: 'SIG-MAC', url: 'https://example.test/dl/Myrlin-Apaki_0.2.0_aarch64.app.tar.gz' });
  assert.deepEqual(feed.platforms['windows-x86_64-nsis'], feed.platforms['windows-x86_64']);
  assert.ok(!JSON.stringify(feed).includes('.dmg'), 'the .dmg is for people, not for the updater');
});

test('one platform alone is a feed too (a release where only one runner finished is the workflow\'s call, not the feed\'s)', () => {
  const feed = buildFeed({ files: FILES.filter((f) => !f.includes('aarch64')), version: '0.2.0', url, readSig: (n) => SIGS[n] });
  assert.deepEqual(Object.keys(feed.platforms).sort(), ['windows-x86_64', 'windows-x86_64-nsis']);
});

test('an installer without its signature, or an empty one, is an error, never a feed', () => {
  assert.throws(() => buildFeed({ files: FILES.filter((f) => f !== 'Myrlin-Apaki_0.2.0_x64-setup.exe.sig'), version: '0.2.0', url, readSig: (n) => SIGS[n] }), /x64-setup\.exe has no .*\.sig/);
  assert.throws(() => buildFeed({ files: FILES, version: '0.2.0', url, readSig: () => '  \n' }), /\.sig is empty/);
  assert.throws(() => buildFeed({ files: ['notes.txt', 'Myrlin-Apaki_0.2.0_aarch64.dmg'], version: '0.2.0', url, readSig: () => 'x' }), /no installer with a signature/);
});

test('an Intel Mac build gets its own platform and is not mistaken for the Apple Silicon one', () => {
  const files = ['Myrlin-Apaki_0.2.0_x64.app.tar.gz', 'Myrlin-Apaki_0.2.0_x64.app.tar.gz.sig'];
  const feed = buildFeed({ files, version: '0.2.0', url, readSig: () => 'SIG-X64' });
  assert.deepEqual(Object.keys(feed.platforms).sort(), ['darwin-x86_64', 'darwin-x86_64-app']);
});

test('the command line writes latest.json with GitHub release addresses (names encoded)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-feed-'));
  try {
    for (const f of FILES) fs.writeFileSync(path.join(dir, f), SIGS[f] || 'bytes');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'apaki/scripts/updater-feed.mjs'), '--dir', dir, '--version', 'v0.2.0', '--tag', 'v0.2.0', '--repo', 'therealarthur/apaki'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const feed = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    assert.equal(feed.version, '0.2.0', 'a leading v is dropped: the updater compares semantic versions');
    assert.equal(feed.platforms['windows-x86_64'].url, 'https://github.com/therealarthur/apaki/releases/download/v0.2.0/Myrlin-Apaki_0.2.0_x64-setup.exe');
    assert.equal(feed.platforms['windows-x86_64'].signature, 'SIG-WIN');
    const missing = spawnSync(process.execPath, [path.join(ROOT, 'apaki/scripts/updater-feed.mjs'), '--dir', dir], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
