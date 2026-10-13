#!/usr/bin/env node
/**
 * version.mjs: the one version of Myrlin Apaki and the places that carry a copy of it (2026-10-13).
 *
 * WHY (Arthur, 2026-10-12: "every app keeps in step"): the Windows app, the Mac app, the engine inside both, the
 * iPhone app and the Android project all show a version, and releases (git tag, GitHub Release, the updater's feed)
 * name one. They must never drift. apaki/VERSION is the only file anyone edits by hand, through this script; every other
 * place below is written from it, and `check` (also run by the tests and by the release workflow) fails when any
 * place disagrees.
 *
 *   node apaki/scripts/version.mjs               print the version
 *   node apaki/scripts/version.mjs check         exit 1, naming every place that disagrees
 *   node apaki/scripts/version.mjs set 0.2.0     write it everywhere (refuses when the places already disagree, or
 *                                                when the version is not semver; --force rewrites a mess)
 *   node apaki/scripts/version.mjs ios           the iOS marketing version for this version (x.y.z, no pre-release)
 *   node apaki/scripts/version.mjs tag           the release tag name, v<version>
 *   --root <dir>                                 work on another checkout or a copy (the tests do)
 *
 * The places (each is read and written in place with a narrow pattern, so formatting and line endings stay):
 *   apaki/VERSION                        the source; the engine reads it (engine/app-version.js) for the window's ready
 *                                        event, the phone's hello, Codex and MCP client info
 *   apaki/tauri.conf.json  version       the Windows and macOS apps (installer, .app, updater feed)
 *   apaki/Cargo.toml + Cargo.lock        the Rust crate (Tauri falls back to it; cargo --locked needs the lock to agree)
 *   package.json + package-lock.json     latch, the terminal app that ships in the same engine folder
 *   apaki/mobile/package.json + lock     the Capacitor project
 *   apaki/mobile/ios/App/Signing.xcconfig  MARKETING_VERSION: the iOS version people see. iOS takes up to three numbers, so a
 *                                        pre-release suffix is dropped (0.3.0-rc.1 is 0.3.0 there). The build number
 *                                        (CURRENT_PROJECT_VERSION) is not part of this: every TestFlight upload raises it.
 *   apaki/mobile/android/app/build.gradle  versionName (same x.y.z). versionCode is left to the Android release.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..', '..');

/** Semantic Versioning 2.0.0 (major.minor.patch, optional -pre-release and +build). */
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const isSemver = (v) => typeof v === 'string' && SEMVER.test(v);

/** x.y.z of a version: what iOS and Android can show. */
export const coreOf = (v) => v.replace(/[-+].*$/, '');

/**
 * One place: `read(text)` is the version it holds (null when the pattern is not there) and `write(text, version)` is
 * the text with that version in. `mine(version)` is the version this place should hold for the app version.
 */
function place(file, label, re, { core = false } = {}) {
  const find = (text) => {
    const m = re.exec(text);
    return m ? m[2] : null;
  };
  return {
    file,
    label,
    mine: core ? coreOf : (v) => v,
    read: find,
    // Replaced once; a pattern that matches nothing is a bug in this table and stops the run (set checks first).
    write: (text, v) => text.replace(re, (_m, a, _old, c) => `${a}${v}${c}`),
  };
}

// A top-level JSON "version" (two-space indent) and the root package entry of a lock file.
const JSON_TOP = /^(  "version": ")([^"]+)(")/m;
const lockRoot = (name) => new RegExp(`("packages": \\{\\s*"": \\{\\s*"name": "${name}",\\s*"version": ")([^"]+)(")`);

export const PLACES = [
  place('apaki/VERSION', 'apaki/VERSION', /^()([^\r\n]+)(\r?\n?)$/),
  place('apaki/tauri.conf.json', 'apaki/tauri.conf.json version', JSON_TOP),
  place('apaki/Cargo.toml', 'apaki/Cargo.toml [package] version', /^(version = ")([^"]+)(")/m),
  place('apaki/Cargo.lock', 'apaki/Cargo.lock myrlin-apaki', /(\[\[package\]\]\r?\nname = "myrlin-apaki"\r?\nversion = ")([^"]+)(")/),
  place('package.json', 'package.json (latch)', JSON_TOP),
  place('package-lock.json', 'package-lock.json top', JSON_TOP),
  place('package-lock.json', 'package-lock.json root package', lockRoot('claude-latch')),
  place('apaki/mobile/package.json', 'apaki/mobile/package.json', JSON_TOP),
  place('apaki/mobile/package-lock.json', 'apaki/mobile/package-lock.json top', JSON_TOP),
  place('apaki/mobile/package-lock.json', 'apaki/mobile/package-lock.json root package', lockRoot('apaki-mobile')),
  place('apaki/mobile/ios/App/Signing.xcconfig', 'iOS MARKETING_VERSION', /^([ \t]*MARKETING_VERSION[ \t]*=[ \t]*)(\S+)([ \t]*)$/m, { core: true }),
  place('apaki/mobile/android/app/build.gradle', 'Android versionName', /^([ \t]*versionName[ \t]+")([^"]+)(")/m, { core: true }),
];

const readText = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

/** The version in apaki/VERSION. */
export function readVersion(root = DEFAULT_ROOT) {
  return readText(root, 'apaki/VERSION').trim();
}

/**
 * Every place with what it holds against what it should: [{ label, file, have, want, ok }].
 * `have` is null when a place could not be read (missing file or pattern).
 */
export function inspect(root = DEFAULT_ROOT) {
  const version = readVersion(root);
  return PLACES.map((p) => {
    let have = null;
    try { have = p.read(readText(root, p.file)); } catch { have = null; }
    const want = p.mine(version);
    return { label: p.label, file: p.file, have, want, ok: have === want };
  });
}

/** Problems found, as sentences ([] when every place agrees and the version is semver). */
export function check(root = DEFAULT_ROOT) {
  const problems = [];
  let version = null;
  try { version = readVersion(root); } catch (e) { return [`apaki/VERSION cannot be read (${e.message})`]; }
  if (!isSemver(version)) problems.push(`apaki/VERSION says "${version}", which is not a semantic version (major.minor.patch)`);
  for (const r of inspect(root)) {
    if (r.ok) continue;
    problems.push(r.have === null ? `${r.label} (${r.file}): no version found there` : `${r.label} (${r.file}) says ${r.have}, expected ${r.want}`);
  }
  return problems;
}

/**
 * Writes `version` into every place. Refuses a version that is not semver, and refuses when the places already
 * disagree (somebody edited one by hand: look before overwriting) unless `force`. All files are computed before any is
 * written, so a pattern that no longer matches stops the run with nothing changed. Returns the files written.
 */
export function setVersion(version, { root = DEFAULT_ROOT, force = false } = {}) {
  if (!isSemver(version)) throw new Error(`"${version}" is not a semantic version (for example 0.2.0 or 1.0.0-rc.1)`);
  const before = check(root);
  if (before.length && !force) throw new Error(`the places disagree already; fix them or use --force:\n  ${before.join('\n  ')}`);
  const texts = new Map();
  for (const p of PLACES) {
    const text = texts.get(p.file) ?? readText(root, p.file);
    if (p.read(text) === null) throw new Error(`${p.label} (${p.file}): no version found there to replace`);
    texts.set(p.file, p.write(text, p.mine(version)));
  }
  for (const [file, text] of texts) fs.writeFileSync(path.join(root, file), text);
  const after = check(root);
  if (after.length) throw new Error(`written, but the places still disagree:\n  ${after.join('\n  ')}`);
  return [...texts.keys()];
}

function main(argv) {
  const args = [];
  let root = DEFAULT_ROOT;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i] || '');
    else if (argv[i] === '--force') force = true;
    else args.push(argv[i]);
  }
  const cmd = args[0] || 'get';
  const out = (s) => process.stdout.write(`${s}\n`);
  try {
    if (cmd === 'get') out(readVersion(root));
    else if (cmd === 'ios') out(coreOf(readVersion(root)));
    else if (cmd === 'tag') out(`v${readVersion(root)}`);
    else if (cmd === 'check') {
      const problems = check(root);
      if (problems.length) {
        process.stderr.write(`version check failed:\n  ${problems.join('\n  ')}\n`);
        process.exitCode = 1;
      } else out(`all ${PLACES.length} places say ${readVersion(root)}`);
    } else if (cmd === 'set') {
      if (!args[1]) throw new Error('usage: version.mjs set <version>');
      const files = setVersion(args[1].replace(/^v/, ''), { root, force });
      out(`version ${args[1].replace(/^v/, '')} written to ${files.length} files:\n  ${files.join('\n  ')}`);
      out(`next: commit, then tag it: git tag ${`v${args[1].replace(/^v/, '')}`}`);
    } else throw new Error(`unknown command "${cmd}" (get, check, set <version>, ios, tag)`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
