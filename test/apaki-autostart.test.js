/**
 * apaki-autostart.test.js: Apaki opens when you sign in (2026-10-15, apaki/src/autostart.rs).
 *
 * Arthur, after the PC blue-screened: "apaki didnt automatically start when the computer came back - that needs to be
 * fixed". The shell registers tauri-plugin-autostart with --autostart, turns it on once on the first run (a marker
 * file keeps a later Off), and the Settings sheet shows Open at sign-in on the PC only. These read the sources, since
 * the shell itself only runs inside the built app.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('the shell registers the autostart plugin with --autostart and exposes get and set', () => {
  const main = read('apaki', 'src', 'main.rs');
  assert.match(main, /^mod autostart;$/m);
  assert.match(main, /\.plugin\(tauri_plugin_autostart::Builder::new\(\)\.arg\(autostart::FLAG\)\.build\(\)\)/);
  assert.match(main, /autostart::autostart_get, autostart::autostart_set\]/);
  assert.match(main, /autostart::init\(app\.handle\(\)\);/);
  assert.match(read('apaki', 'Cargo.toml'), /^tauri-plugin-autostart = "2"$/m);
});

test('first run turns it on once; the marker keeps a later Off from Settings', () => {
  const rs = read('apaki', 'src', 'autostart.rs');
  assert.match(rs, /pub const FLAG: &str = "--autostart";/);
  assert.match(rs, /join\("autostart-chosen"\)/);
  // init returns early when the marker exists, before any enable().
  const init = rs.slice(rs.indexOf('pub fn init'), rs.indexOf('pub fn autostart_get'));
  assert.ok(init.indexOf('if m.exists()') < init.indexOf('.enable()'), 'the marker is checked before turning it on');
  // set remembers the choice either way.
  const set = rs.slice(rs.indexOf('pub fn autostart_set'));
  assert.match(set, /remember\(&app, on\)/);
});

test('the Run value is rewritten with the path in quotes after every enable (the path has a space in it)', () => {
  const rs = read('apaki', 'src', 'autostart.rs');
  assert.match(rs, /let value = format!\("\\"\{\}\\" \{FLAG\}", exe\.display\(\)\);/);
  assert.match(rs, /CURRENT_USER\.create\(r"Software\\Microsoft\\Windows\\CurrentVersion\\Run"\)/);
  assert.equal((rs.match(/quote_run_value\(&?app\);/g) || []).length, 2, 'after the first-run enable and after an On from Settings');
  assert.match(read('apaki', 'Cargo.toml'), /^windows-registry = "0\.6"$/m);
});

test('Settings shows Open at sign-in on the PC only, and copes with an older shell', () => {
  const settings = read('apaki', 'ui', 'settings.js');
  assert.match(settings, /autostart = null \}\) \{/);
  assert.match(settings, /\$\{autostart \? `<section class="set-row">/);
  assert.match(settings, /seg\('signin'/);
  assert.match(settings, /signIn = 'n\/a'/, 'an invoke the shell does not know reads as "restart once"');
  const app = read('apaki', 'ui', 'app.js');
  assert.match(app, /autostart: WEB \? null : \{ get: \(\) => invoke\('autostart_get'\), set: \(on\) => invoke\('autostart_set', \{ on \}\) \},/);
});

test('the parity ledger records it as desktop only', () => {
  const j = JSON.parse(read('apaki', 'parity', 'features.json'));
  const f = j.features.find((x) => x.id === 'open-at-sign-in');
  assert.ok(f);
  assert.deepEqual(f.surfaces, { desktop: 'supported', phone: 'n/a' });
});
