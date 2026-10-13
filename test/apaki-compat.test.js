/**
 * apaki-compat.test.js: the minimum-version contract between a PC's Apaki and the phone apps (2026-10-13).
 *
 * The PC says its version and the oldest phone app it works with (hello appVersion, minPhoneApp); a native phone app
 * under that shows "Update the Apaki app", and the PC's Phone sheet says so too. The comparison is what decides, so it is
 * checked closely: semantic versions with pre-releases, an app's one-to-three-part marketing version, and "unknown is not
 * old" for anything that did not say.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP_UPDATE_TITLE, MIN_PHONE_APP, compareVersions, oldAppText, parseVersion, phoneAppState } from '../apaki/remote/compat.js';
import { APP_VERSION } from '../apaki/engine/app-version.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('versions parse: semantic, an app\'s short marketing form, a leading v, build metadata', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseVersion('1.0'), { major: 1, minor: 0, patch: 0, pre: [] }, 'iOS marketing versions have one to three parts');
  assert.deepEqual(parseVersion('7'), { major: 7, minor: 0, patch: 0, pre: [] });
  assert.deepEqual(parseVersion('v0.2.0-ci.1+abc'), { major: 0, minor: 2, patch: 0, pre: ['ci', '1'] });
  for (const bad of ['', 'x', '1.2.3.4', '1..2', '1.2.3-', '1.2.3-a..b', null, undefined, 12, {}]) assert.equal(parseVersion(bad), null, String(bad));
});

test('comparison: numbers by part, not as text', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, '0.10 is newer than 0.9');
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0, 'the short form is the same version');
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
});

test('comparison: a pre-release is older than its release and ordered by the semver rules', () => {
  assert.equal(compareVersions('0.2.0-ci.1', '0.2.0'), -1);
  assert.equal(compareVersions('0.2.0', '0.2.0-ci.1'), 1);
  assert.equal(compareVersions('0.2.0-ci.2', '0.2.0-ci.10'), -1, 'numeric parts numerically');
  assert.equal(compareVersions('0.2.0-alpha', '0.2.0-beta'), -1);
  assert.equal(compareVersions('0.2.0-1', '0.2.0-alpha'), -1, 'numbers sit under words');
  assert.equal(compareVersions('0.2.0-ci', '0.2.0-ci.1'), -1, 'fewer parts first');
  assert.equal(compareVersions('0.2.0+1', '0.2.0+2'), 0, 'build metadata does not count');
  assert.equal(compareVersions('0.2.1-ci.1', '0.2.0'), 1);
});

test('a version that is not one cannot be compared, and is never "old"', () => {
  assert.equal(compareVersions('abc', '1.0.0'), null);
  assert.equal(compareVersions('1.0.0', undefined), null);
  assert.equal(phoneAppState('abc', '1.0.0'), 'unknown');
  assert.equal(phoneAppState('', '1.0.0'), 'unknown');
  assert.equal(phoneAppState('1.0.0', undefined), 'unknown', 'a PC from before this contract says no minimum: nothing is flagged');
  assert.equal(phoneAppState(undefined, '1.0.0'), 'unknown', 'the web page has no app version: nothing is flagged');
});

test('a phone app is old only when it is under the PC\'s minimum', () => {
  assert.equal(phoneAppState('0.1.0', '0.2.0'), 'old');
  assert.equal(phoneAppState('0.2.0', '0.2.0'), 'ok', 'the minimum itself is fine');
  assert.equal(phoneAppState('0.2.1', '0.2.0'), 'ok');
  assert.equal(phoneAppState('1.0', '0.2.0'), 'ok');
  assert.equal(phoneAppState('0.2.0-rc.1', '0.2.0'), 'old', 'a release candidate is under the release');
  assert.equal(phoneAppState('0.9.9', '1.0.0'), 'old');
});

test('the explanation names both versions and the PC', () => {
  const t = oldAppText({ version: '0.1.0', min: '0.3.0', pcVersion: '0.4.0', pcName: 'Desk' });
  assert.equal(t, 'Desk runs Apaki 0.4.0 and needs the Apaki app at 0.3.0 or newer. This phone has 0.1.0.');
  assert.equal(oldAppText({ version: '0.1.0', min: '0.3.0' }), 'This PC needs the Apaki app at 0.3.0 or newer. This phone has 0.1.0.');
  assert.equal(APP_UPDATE_TITLE, 'Update the Apaki app');
});

test('the PC\'s minimum is a real version and never above the PC\'s own', () => {
  assert.ok(parseVersion(MIN_PHONE_APP), `MIN_PHONE_APP "${MIN_PHONE_APP}"`);
  assert.ok(compareVersions(MIN_PHONE_APP, APP_VERSION) <= 0, `MIN_PHONE_APP ${MIN_PHONE_APP} is above this Apaki's own ${APP_VERSION}: no phone app could satisfy it`);
});

test('the phone page ships the contract: compat.js is built into it and boot.js, link.js and the app shell use it', () => {
  assert.match(src('apaki/scripts/build-web.mjs'), /REMOTE_FILES = \['protocol\.js', 'wire\.js', 'compat\.js'\]/);
  assert.match(src('apaki/web/src/boot.js'), /from '\.\/compat\.js'/);
  assert.match(src('apaki/web/src/boot.js'), /phoneAppState\(app\.version, m\.minPhoneApp\) !== 'old'/);
  assert.match(src('apaki/web/src/link.js'), /sendClient\(info\)[\s\S]{0,300}t: 'client'/);
  assert.match(src('apaki/mobile/src/native-shell.js'), /version: String\(facts\.version/);
});

test('the phone page build includes compat.js and the page still builds', async () => {
  const { build } = await import('../apaki/scripts/build-web.mjs');
  const os = await import('node:os');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-compat-web-'));
  try {
    const r = build({ relay: 'wss://relay.example.test', out });
    assert.ok(fs.existsSync(path.join(out, 'compat.js')), 'compat.js is in the built page');
    assert.match(r.version, /^[0-9a-f]{12}$/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
