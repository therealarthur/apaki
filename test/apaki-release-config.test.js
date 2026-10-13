/**
 * apaki-release-config.test.js: the release pipeline's settings agree with each other (2026-10-13).
 *
 * Nothing here builds anything. It reads the files a release depends on and checks the things that, if they drifted,
 * would only show up on release day: the updater's public key and address in tauri.conf.json, the plugin being compiled
 * in, the Windows and macOS bundle settings, the NSIS template matching the Tauri the build installs, and the release
 * workflow's guards (drafts only, nothing outside GitHub touched by a -ci test tag).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const json = (f) => JSON.parse(read(f));

test('the updater: https feed on GitHub Releases, a minisign public key, signed versions only, passive Windows installs', () => {
  const u = json('apaki/tauri.conf.json').plugins?.updater;
  assert.ok(u, 'plugins.updater is configured');
  assert.deepEqual(u.endpoints, ['https://github.com/therealarthur/apaki/releases/latest/download/latest.json']);
  const pub = Buffer.from(u.pubkey, 'base64').toString('utf8');
  assert.match(pub, /^untrusted comment: minisign public key: [0-9A-F]{16}\nRW[A-Za-z0-9+/=]{54,}\n?$/, 'pubkey is the base64 of a minisign public key file');
  assert.equal(u.requireSignedVersion, true, 'an old signed build cannot be replayed as a new version');
  assert.equal(u.windows?.installMode, 'passive');
  // The key in the config is the one the signing secret goes with: the tool printed it once, and the credentials file holds the pair.
  assert.ok(!/PRIVATE|secret key/i.test(read('apaki/tauri.conf.json')), 'no private key text in the config');
});

test('the updater is compiled in and started, with the window script and the three commands the page uses', () => {
  const cargo = read('apaki/Cargo.toml');
  assert.match(cargo, /^tauri-plugin-updater = /m);
  const main = read('apaki/src/main.rs');
  assert.match(main, /^mod updater;/m);
  assert.match(main, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(main, /\.plugin\(updater::plugin\(\)\)/);
  assert.match(main, /updater::init\(/);
  for (const cmd of ['update_status', 'update_check', 'update_install']) {
    assert.match(main, new RegExp(`updater::${cmd}`), `${cmd} is registered`);
    assert.match(read('apaki/src/updater.rs'), new RegExp(`pub (async )?fn ${cmd}\\(`));
  }
  const js = read('apaki/src/updater.js');
  for (const cmd of ['update_status', 'update_install']) assert.match(js, new RegExp(`'${cmd}'`));
  assert.match(js, /'apaki-update'/);
  assert.match(read('apaki/src/updater.rs'), /"apaki-update"/);
  // A status pill with a dot is banned in this app's UI.
  assert.ok(!/border-radius:\s*999|\.dot\b|pulse|blink/i.test(js), 'the update card has no dot pill');
});

test('update artifacts are opt-in (a local build has no signing key), and both platforms can ask for them', () => {
  const conf = json('apaki/tauri.updater.conf.json');
  assert.equal(conf.bundle.createUpdaterArtifacts, true);
  assert.ok(!('createUpdaterArtifacts' in (json('apaki/tauri.conf.json').bundle || {})), 'not in the main config: it would fail every build without the key');
  assert.match(read('apaki/scripts/package-apaki-win.ps1'), /tauri\.updater\.conf\.json/);
  assert.match(read('apaki/scripts/package-apaki-mac.sh'), /tauri\.updater\.conf\.json/);
});

test('Windows bundle: NSIS for the current user with the hooks and template that exist, and the resources the app looks for', () => {
  const conf = json('apaki/tauri.windows.bundle.conf.json');
  assert.deepEqual(conf.bundle.targets, ['nsis']);
  assert.equal(conf.bundle.windows.nsis.installMode, 'currentUser');
  for (const key of ['template', 'installerHooks']) {
    const file = conf.bundle.windows.nsis[key];
    assert.ok(fs.existsSync(path.join(ROOT, 'apaki', file)), `${key} ${file} exists`);
  }
  // main.rs looks for <exe dir>\engine and <exe dir>\node\node.exe.
  assert.deepEqual(Object.values(conf.bundle.resources).sort(), ['bin', 'engine', 'node']);
  assert.match(read('apaki/.gitignore') + read('.gitignore'), /apaki\/build-win\//);
});

test('the NSIS template is Tauri\'s own for the Tauri the build installs, with the install folder the app has always used', () => {
  const tpl = read('apaki/nsis/installer.nsi');
  const from = /TEMPLATE-FROM: tauri-cli (\d+\.\d+\.\d+)/.exec(tpl)?.[1];
  assert.ok(from, 'the template says which Tauri release it comes from');
  // package-apaki-win.ps1 and package-apaki-mac.sh install the CLI at the version of the tauri crate in Cargo.lock.
  const lock = read('apaki/Cargo.lock').replace(/\r/g, '');
  const tauriVersion = /\[\[package\]\]\nname = "tauri"\nversion = "([^"]+)"/.exec(lock)?.[1];
  assert.equal(from, tauriVersion, `the template is from tauri-cli ${from} but the build installs the CLI ${tauriVersion}: fetch the template of that release (see the template's header)`);
  assert.match(tpl, /StrCpy \$INSTDIR "\$LOCALAPPDATA\\Programs\\\$\{PRODUCTNAME\}"/);
  assert.ok(!/StrCpy \$INSTDIR "\$LOCALAPPDATA\\\$\{PRODUCTNAME\}"/.test(tpl), 'the stock default is gone');
  assert.match(tpl, /\{\{#if installer_hooks\}\}/, 'the hooks are still wired in');
});

test('the NSIS hooks cover the four moments and call a script that is shipped with the installer', () => {
  const hooks = read('apaki/nsis/hooks.nsh');
  for (const m of ['NSIS_HOOK_PREINSTALL', 'NSIS_HOOK_POSTINSTALL', 'NSIS_HOOK_PREUNINSTALL', 'NSIS_HOOK_POSTUNINSTALL']) assert.match(hooks, new RegExp(`!macro ${m}`));
  assert.ok(fs.existsSync(path.join(ROOT, 'apaki/nsis/apaki-installer.ps1')));
  const ps = read('apaki/nsis/apaki-installer.ps1');
  for (const action of ['pre-install', 'post-install', 'login-status', 'sign-in', 'pre-uninstall']) {
    assert.match(ps, new RegExp(`'${action}'`), `the script handles ${action}`);
    assert.match(hooks, new RegExp(`-Action ${action}`), `the hooks run ${action}`);
  }
  // The handoff goes through the engine's own control script, never a process-name kill.
  assert.match(ps, /host-ctl\.js/);
  assert.ok(!/taskkill|Stop-Process\s+-Name|Get-Process[^\n]*\|\s*Stop-Process/i.test(ps), 'nothing is killed by name');
});

test('the packaging scripts carry node-pty for their own platform only and check that it loads', () => {
  const win = read('apaki/scripts/package-apaki-win.ps1');
  assert.match(win, /prebuilds\\win32-x64\\conpty\.node/);
  assert.match(win, /node-pty loads with the packaged Node/);
  const mac = read('apaki/scripts/package-apaki-mac.sh');
  assert.match(mac, /prebuilds\/darwin-\$node_arch\/pty\.node/);
  assert.match(mac, /spawn-helper/);
  assert.match(mac, /node-pty loads with the packaged Node/);
  for (const f of [win, mac]) assert.match(f, /apaki\/VERSION|apaki\\VERSION/, 'the packaged engine gets the version file');
});

test('the release workflow: tags only, drafts only, and a -ci test tag changes nothing outside GitHub', () => {
  const y = read('.github/workflows/release.yml').replace(/\r/g, '');
  assert.match(y, /on:\n  push:\n    tags:\n      - 'v\*'/);
  assert.ok(!/workflow_dispatch|pull_request|branches:/.test(y.split('\njobs:')[0].replace(/^#.*$/gm, '')), 'only a version tag starts a release');
  assert.match(y, /gh release create "\$TAG" --draft/);
  assert.ok(!/--draft=false|gh release edit[^\n]*--draft=false|--latest/.test(y), 'it never publishes');
  assert.match(y, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-ci\\\.\[0-9\]\+\$/, 'the -ci tag pattern');
  // Everything that changes something outside GitHub waits for a real tag.
  for (const job of ['phone-page', 'ios']) {
    const block = y.split(new RegExp(`\\n  ${job}:\\n`))[1]?.split(/\n  [a-z-]+:\n/)[0] || '';
    assert.match(block, /if: needs\.meta\.outputs\.test != 'true'/, `${job} is skipped for a -ci tag`);
  }
  // The tag must be the app's version; the version places must agree; the build uses the signing secrets.
  assert.match(y, /version\.mjs check/);
  assert.match(y, /"\$tag" != "v\$version"|\$tag" != "v\$version"/);
  for (const s of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) assert.match(y, new RegExp(`secrets\\.${s}\\b`));
  assert.match(y, /uses: \.\/\.github\/workflows\/ios-testflight\.yml/);
  assert.match(y, /npx wrangler deploy --env=""/);
  assert.match(y, /apaki\/scripts\/smoke-win-installer\.ps1/);
});

test('the TestFlight workflow can be called by the release and sends its build number to the named branch', () => {
  const y = read('.github/workflows/ios-testflight.yml').replace(/\r/g, '');
  assert.match(y, /workflow_dispatch:/);
  assert.match(y, /workflow_call:/);
  assert.match(y, /build_number_branch:/);
  assert.match(y, /APAKI_BUILD_NUMBER_BRANCH: \$\{\{ inputs\.build_number_branch \}\}/);
  assert.match(read('apaki/mobile/scripts/ios-testflight.sh'), /APAKI_BUILD_NUMBER_BRANCH/);
});

test('the smoke test of the installer refuses to install anywhere but a CI runner', () => {
  const ps = read('apaki/scripts/smoke-win-installer.ps1');
  assert.match(ps, /\$env:GITHUB_ACTIONS -ne 'true'\) \{ throw/);
});
