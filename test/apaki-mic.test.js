/**
 * apaki-mic.test.js: the mic button in the prompt box works on the PC (2026-10-17).
 *
 * Arthur: "the audio button (where you use mic) doesnt work in the prompt box". The window's request for the
 * microphone waited on a WebView2 permission prompt that Apaki's frameless window never showed. The shell now answers
 * it for Apaki's own page only, and the page says what to check if the microphone still does not answer. These read
 * the sources, since the shell runs only inside the built app.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('the shell allows the microphone for Apaki\'s own page only, and leaves every other request to WebView2', () => {
  const rs = read('apaki', 'src', 'browser.rs');
  assert.match(rs, /wv\.add_PermissionRequested\(/);
  assert.match(rs, /if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE \{/);
  assert.match(rs, /if is_app_origin\(&origin\) \{\s*let _ = a\.SetState\(COREWEBVIEW2_PERMISSION_STATE_ALLOW\);/);
  // Only the app's own origins; an artifact frame (127.0.0.1) or any other page is not on the list.
  const fn = rs.slice(rs.indexOf('fn is_app_origin'), rs.indexOf('fn is_app_origin') + 500);
  assert.match(fn, /"http:\/\/tauri\.localhost\/"/);
  assert.doesNotMatch(fn, /127\.0\.0\.1|localhost:/);
  assert.equal((rs.match(/SetState\(COREWEBVIEW2_PERMISSION_STATE_ALLOW\)/g) || []).length, 1, 'nothing else is allowed');
});

test('the page says what to check when the microphone does not answer or is refused, instead of doing nothing', () => {
  const app = read('apaki', 'ui', 'app.js');
  const fn = app.slice(app.indexOf('async function startVoice'), app.indexOf('function stopVoice'));
  assert.match(fn, /const slow = setTimeout\(/);
  assert.match(fn, /clearTimeout\(slow\);/);
  assert.match(fn, /NotAllowedError/);
  assert.match(app, /const MIC_SETTINGS = /);
});
