/**
 * apaki-version.test.js: Apaki has one version and every place that carries it agrees (2026-10-13).
 *
 * apaki/VERSION is the source; apaki/scripts/version.mjs writes the rest (tauri.conf.json, Cargo, package files, the
 * iOS marketing version, Android) and refuses to when they already disagree. These tests check the repo itself and
 * then run the script on a scratch copy of the files, never on the repo.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, readAppVersion } from '../apaki/engine/app-version.js';
import { DEFAULT_ROOT, PLACES, check, coreOf, inspect, isSemver, readVersion, setVersion } from '../apaki/scripts/version.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apaki', 'scripts', 'version.mjs');

/** A scratch copy of just the files the script touches. */
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-version-'));
  for (const file of new Set(PLACES.map((p) => p.file))) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(DEFAULT_ROOT, file), path.join(root, file));
  }
  return root;
}
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the repo: apaki/VERSION is semver and every place carries it', () => {
  const v = readVersion();
  assert.ok(isSemver(v), `apaki/VERSION says "${v}"`);
  assert.deepEqual(check(), [], 'run: node apaki/scripts/version.mjs set <version>');
  assert.equal(inspect().length, PLACES.length);
});

test('the repo: the places that matter to a release are in the table', () => {
  const files = new Set(PLACES.map((p) => p.file));
  for (const f of ['apaki/VERSION', 'apaki/tauri.conf.json', 'apaki/Cargo.toml', 'apaki/Cargo.lock', 'package.json', 'apaki/mobile/ios/App/Signing.xcconfig', 'apaki/mobile/package.json']) {
    assert.ok(files.has(f), `${f} is not checked`);
  }
});

test('the iOS marketing version is the version without its pre-release (three numbers at most)', () => {
  assert.equal(coreOf('0.2.0'), '0.2.0');
  assert.equal(coreOf('1.0.0-rc.1'), '1.0.0');
  assert.equal(coreOf('1.0.0+7'), '1.0.0');
  const x = fs.readFileSync(path.join(DEFAULT_ROOT, 'apaki/mobile/ios/App/Signing.xcconfig'), 'utf8');
  assert.match(x, new RegExp(`^MARKETING_VERSION = ${coreOf(readVersion()).replace(/\./g, '\\.')}\\s*$`, 'm'));
});

test('the engine reports the version of the VERSION file it runs beside', () => {
  assert.equal(APP_VERSION, readVersion());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-engine-version-'));
  try {
    fs.mkdirSync(path.join(dir, 'apaki', 'engine'), { recursive: true });
    const engine = path.join(dir, 'apaki', 'engine');
    assert.equal(readAppVersion(engine), '0.0.0', 'nothing to read: a version that is plainly not a release');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"3.2.1"}');
    assert.equal(readAppVersion(engine), '3.2.1', 'the package.json beside the engine folder is the fallback');
    fs.writeFileSync(path.join(dir, 'apaki', 'VERSION'), '4.5.6\r\n');
    assert.equal(readAppVersion(engine), '4.5.6', 'VERSION wins, and a Windows line ending is no part of it');
    fs.writeFileSync(path.join(dir, 'apaki', 'VERSION'), 'not a version');
    assert.equal(readAppVersion(engine), '3.2.1', 'junk in VERSION falls back instead of reporting junk');
  } finally { cleanup(dir); }
});

test('set writes every place and keeps each file\'s own formatting', () => {
  const root = scratch();
  try {
    const before = read(root, 'apaki/Cargo.lock');
    const files = setVersion('0.2.0', { root });
    assert.equal(new Set(files).size, new Set(PLACES.map((p) => p.file)).size);
    assert.deepEqual(check(root), []);
    assert.equal(readVersion(root), '0.2.0');
    assert.match(read(root, 'apaki/tauri.conf.json'), /"version": "0\.2\.0"/);
    assert.match(read(root, 'apaki/Cargo.lock'), /name = "myrlin-apaki"\r?\nversion = "0\.2\.0"/);
    assert.match(read(root, 'apaki/mobile/ios/App/Signing.xcconfig'), /^MARKETING_VERSION = 0\.2\.0$/m);
    assert.match(read(root, 'apaki/mobile/android/app/build.gradle'), /versionName "0\.2\.0"/);
    // Only the version moved: the rest of a big lock file is byte for byte what it was.
    const blank = (s) => s.replace(/(name = "myrlin-apaki"\r?\nversion = )"[^"]+"/, '$1"X"');
    assert.equal(blank(read(root, 'apaki/Cargo.lock')), blank(before));
    // The build number of an iOS upload is not the version's business.
    assert.match(read(root, 'apaki/mobile/ios/App/Signing.xcconfig'), /^CURRENT_PROJECT_VERSION = \d+$/m);
  } finally { cleanup(root); }
});

test('a pre-release version goes everywhere, and iOS and Android get its x.y.z', () => {
  const root = scratch();
  try {
    setVersion('1.0.0-rc.1', { root });
    assert.deepEqual(check(root), []);
    assert.equal(readVersion(root), '1.0.0-rc.1');
    assert.match(read(root, 'apaki/tauri.conf.json'), /"version": "1\.0\.0-rc\.1"/);
    assert.match(read(root, 'apaki/mobile/ios/App/Signing.xcconfig'), /^MARKETING_VERSION = 1\.0\.0$/m);
    assert.match(read(root, 'apaki/mobile/android/app/build.gradle'), /versionName "1\.0\.0"/);
  } finally { cleanup(root); }
});

test('set refuses a version that is not semver, and changes nothing', () => {
  const root = scratch();
  try {
    const keep = read(root, 'apaki/tauri.conf.json');
    for (const bad of ['1.0', 'v1.0.0', '01.2.3', '1.2.3.4', 'latest', '', '1.2.3-']) {
      assert.throws(() => setVersion(bad, { root }), /not a semantic version/, `"${bad}"`);
    }
    assert.equal(read(root, 'apaki/tauri.conf.json'), keep);
  } finally { cleanup(root); }
});

test('set refuses while the places disagree, names the one that does, and --force repairs it', () => {
  const root = scratch();
  try {
    const conf = path.join(root, 'apaki/tauri.conf.json');
    fs.writeFileSync(conf, fs.readFileSync(conf, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
    assert.ok(check(root).some((p) => p.includes('tauri.conf.json') && p.includes('9.9.9')));
    assert.throws(() => setVersion('0.2.0', { root }), /disagree already[\s\S]*tauri\.conf\.json/);
    assert.match(read(root, 'apaki/VERSION'), /^0\.1\.0/, 'nothing was written');
    setVersion('0.2.0', { root, force: true });
    assert.deepEqual(check(root), []);
  } finally { cleanup(root); }
});

test('a place whose version cannot be found stops the whole set before any file is written', () => {
  const root = scratch();
  try {
    const gradle = path.join(root, 'apaki/mobile/android/app/build.gradle');
    fs.writeFileSync(gradle, fs.readFileSync(gradle, 'utf8').replace(/versionName "[^"]+"/, '// no version here'));
    assert.ok(check(root).some((p) => p.includes('Android') && p.includes('no version found')));
    assert.throws(() => setVersion('0.2.0', { root, force: true }), /Android versionName[\s\S]*no version found/);
    assert.match(read(root, 'apaki/VERSION'), /^0\.1\.0/);
    assert.match(read(root, 'apaki/tauri.conf.json'), /"version": "0\.1\.0"/);
  } finally { cleanup(root); }
});

test('the command line: get, check, set, ios and tag, with exit codes', () => {
  const root = scratch();
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--root', root], { encoding: 'utf8' });
  try {
    assert.equal(run('get').stdout.trim(), '0.1.0');
    assert.equal(run('check').status, 0);
    assert.equal(run('set', 'v0.3.0-ci.2').status, 0, 'a leading v is accepted');
    assert.equal(run('get').stdout.trim(), '0.3.0-ci.2');
    assert.equal(run('ios').stdout.trim(), '0.3.0');
    assert.equal(run('tag').stdout.trim(), 'v0.3.0-ci.2');
    const bad = run('set', 'nope');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a semantic version/);
    fs.writeFileSync(path.join(root, 'apaki/VERSION'), '0.9.9\n');
    const off = run('check');
    assert.equal(off.status, 1);
    assert.match(off.stderr, /says 0\.3\.0-ci\.2, expected 0\.9\.9/);
  } finally { cleanup(root); }
});
