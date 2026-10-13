/**
 * app-version.js: the version of this Myrlin Apaki, read from apaki/VERSION (2026-10-13).
 *
 * WHY: one source of truth for the app's version (apaki/scripts/version.mjs keeps every other place in step and a
 * test checks they agree). The engine reports it in the window's ready event, in the phone's hello (with the oldest
 * phone app it supports, apaki/remote/compat.js), to Codex as its client version and to MCP clients.
 *
 * The file travels with the engine in every package (the packaging scripts copy apaki/VERSION to engine/apaki/VERSION),
 * so the version an engine reports is the version of the files it runs, including after a self-swap onto new files.
 * If the file is missing (a stripped copy), the package.json beside the engine's root is the fallback, then '0.0.0'.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The version in `file` (a one-line VERSION file), or null. */
function fromVersionFile(file) {
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    return SEMVER.test(v) ? v : null;
  } catch { return null; }
}

/** The "version" in a package.json, or null. */
function fromPackageJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    return typeof v === 'string' && SEMVER.test(v) ? v : null;
  } catch { return null; }
}

/** Reads the version for an engine whose files are in `dir` (apaki/engine): apaki/VERSION, else the root package.json. */
export function readAppVersion(dir = HERE) {
  return fromVersionFile(path.join(dir, '..', 'VERSION')) || fromPackageJson(path.join(dir, '..', '..', 'package.json')) || '0.0.0';
}

/** This app's version, for example "0.2.0". */
export const APP_VERSION = readAppVersion();
