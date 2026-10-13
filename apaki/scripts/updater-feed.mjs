#!/usr/bin/env node
/**
 * updater-feed.mjs: makes latest.json, the update feed Myrlin Apaki's updater reads from GitHub Releases (2026-10-13).
 *
 * WHY: Tauri's updater asks one URL, https://github.com/<owner>/<repo>/releases/latest/download/latest.json, which
 * says the newest version and, per platform, where its signed update is and the signature (from the .sig file the
 * bundler wrote). The release workflow builds the Windows and the macOS app on separate runners, so this script
 * puts the two halves together. It does not talk to GitHub: it reads the finished files and writes the JSON.
 *
 *   node apaki/scripts/updater-feed.mjs --dir <folder with the build files> --version 0.2.0 --tag v0.2.0 \
 *        --repo therealarthur/apaki [--notes <file>] [--out latest.json] [--date <ISO date>]
 *
 * What it looks for in the folder (the names the packaging scripts leave, with dashes instead of spaces, which is what
 * GitHub makes of a space in an asset name anyway, so the address in the feed is the address the file ends up at):
 *   Windows  *_x64-setup.exe + .sig         -> windows-x86_64
 *   macOS    *_aarch64.app.tar.gz + .sig    -> darwin-aarch64
 *            *_x64.app.tar.gz + .sig        -> darwin-x86_64
 * A platform with its installer but no .sig is an error (an unsigned update would be refused by every app anyway), and
 * a feed with no platform at all is an error. Each platform is listed under the plain key and, for the Tauri
 * updater's per-bundle lookup, a second key (-nsis for Windows, -app for macOS).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The platform keys and file patterns the feed knows. */
export const PLATFORMS = [
  { key: 'windows-x86_64', extra: 'windows-x86_64-nsis', match: /_x64-setup\.exe$/ },
  { key: 'darwin-aarch64', extra: 'darwin-aarch64-app', match: /_aarch64\.app\.tar\.gz$/ },
  { key: 'darwin-x86_64', extra: 'darwin-x86_64-app', match: /_x64\.app\.tar\.gz$/ },
];

/**
 * The feed object for the files in `files` (names only; `readSig(name)` returns the text of "<name>.sig").
 * `url(name)` is the public download address of a file.
 */
export function buildFeed({ files, version, notes = '', date = new Date().toISOString(), url, readSig }) {
  const platforms = {};
  const problems = [];
  for (const p of PLATFORMS) {
    const hit = files.find((f) => p.match.test(f));
    if (!hit) continue;
    if (!files.includes(`${hit}.sig`)) { problems.push(`${hit} has no ${hit}.sig next to it`); continue; }
    const signature = readSig(`${hit}.sig`).trim();
    if (!signature) { problems.push(`${hit}.sig is empty`); continue; }
    const entry = { signature, url: url(hit) };
    platforms[p.key] = entry;
    platforms[p.extra] = entry;
  }
  if (problems.length) throw new Error(`the update feed cannot be made: ${problems.join('; ')}`);
  if (!Object.keys(platforms).length) throw new Error('the update feed cannot be made: no installer with a signature was found (expected *-setup.exe and/or *.app.tar.gz, each with a .sig)');
  return { version, notes, pub_date: date, platforms };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  for (const need of ['dir', 'version', 'tag', 'repo']) if (!o[need]) { process.stderr.write(`usage: updater-feed.mjs --dir <folder> --version <x.y.z> --tag <vX.Y.Z> --repo <owner/name> [--notes <file>] [--out latest.json]\nmissing --${need}\n`); process.exit(2); }
  const dir = path.resolve(o.dir);
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const feed = buildFeed({
    files,
    version: o.version.replace(/^v/, ''),
    notes: o.notes ? fs.readFileSync(path.resolve(o.notes), 'utf8').trim() : '',
    date: o.date || undefined,
    url: (name) => `https://github.com/${o.repo}/releases/download/${encodeURIComponent(o.tag)}/${encodeURIComponent(name)}`,
    readSig: (name) => fs.readFileSync(path.join(dir, name), 'utf8'),
  });
  const out = path.resolve(o.out || path.join(dir, 'latest.json'));
  fs.writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);
  process.stdout.write(`wrote ${out}: version ${feed.version}, platforms ${Object.keys(feed.platforms).filter((k) => !/-(nsis|app)$/.test(k)).join(', ')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
