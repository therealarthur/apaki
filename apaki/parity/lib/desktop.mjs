/**
 * desktop.mjs: the "claude-desktop" and "chatgpt-desktop" products of the
 * upstream parity tracker (apaki/parity/PARITY.md; Arthur, 2026-10-11).
 *
 * Neither app has a machine readable surface, so a snapshot of them is two
 * things: the installed version, and the hand kept feature inventory in
 * apaki/parity/manual/<product>.md (one bullet per feature). The version comes
 * from the package folder NAME only (a Windows Store package is named
 * "<Name>_<version>_<arch>__<publisherId>"); no app data is read and no app is
 * opened or closed. C:\Program Files\WindowsApps cannot be listed without
 * elevation, so the package manager's own registration list (Get-AppxPackage,
 * names and versions only) stands in for the folder listing, and
 * %LOCALAPPDATA%\AnthropicClaude\app-<version> (the older Squirrel install)
 * is checked by folder name too.
 *
 * Pure parts: parsePackageFullName, parseInventory, extractDesktop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSnapshot, makeItem } from './snapshot.mjs';

/** Which installed package names belong to which product. */
export const DESKTOP_PRODUCTS = {
  'claude-desktop': { packages: [/^Claude$/i, /^AnthropicClaude$/i, /^Anthropic\.Claude/i], squirrel: 'AnthropicClaude' },
  // OpenAI folded the Codex app into the ChatGPT desktop app (market research, 2026-10-11); the package on this PC is still named OpenAI.Codex
  'chatgpt-desktop': { packages: [/^OpenAI\.Codex$/i, /^OpenAI\.ChatGPT/i, /^OpenAI\.ChatGPT-Desktop$/i], squirrel: null },
};

/** "Claude_2.31226.1.0_x64__pzs8sxrjxfjjc" -> { name, version, arch, publisherId } or null. */
export function parsePackageFullName(full) {
  const m = /^([A-Za-z0-9.-]+?)_(\d+(?:\.\d+)+)_([A-Za-z0-9]+)_[A-Za-z0-9]*_([a-z0-9]+)$/.exec(String(full).trim());
  return m ? { name: m[1], version: m[2], arch: m[3], publisherId: m[4] } : null;
}

/** Names of the installed Store packages: the folder list when readable, else Get-AppxPackage's full names. */
export function listPackageNames() {
  if (process.platform !== 'win32') return { names: [], source: 'not-windows' };
  const dir = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');
  try {
    return { names: fs.readdirSync(dir), source: 'WindowsApps folder names' };
  } catch { /* access denied without elevation, expected */ }
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-AppxPackage | ForEach-Object { $_.PackageFullName }'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.status !== 0) return { names: [], source: 'unavailable' };
  return { names: r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), source: 'Get-AppxPackage names' };
}

/** Find the installed version of a product from package names: [{ version, package, arch, source }] newest first. */
export function findInstalled(product, names, localAppDataNames = []) {
  const cfg = DESKTOP_PRODUCTS[product];
  const out = [];
  for (const n of names) {
    const p = parsePackageFullName(n);
    if (p && cfg.packages.some((re) => re.test(p.name))) out.push({ version: p.version, package: p.name, arch: p.arch });
  }
  for (const n of localAppDataNames) {
    const m = cfg.squirrel && /^app-(\d+(?:\.\d+)+)$/.exec(n);
    if (m) out.push({ version: m[1], package: cfg.squirrel, arch: undefined });
  }
  return out.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }));
}

/**
 * Bullets of a manual inventory file: "- `slug`: text" under "## Group" headings.
 * Returns [{ slug, text, group }]. Lines that do not match are ignored (notes,
 * TODO lists), so the file stays free text around the inventory.
 */
export function parseInventory(md) {
  const out = [];
  let group = '';
  for (const raw of String(md).replace(/\r/g, '').split('\n')) {
    const h = /^#{2,3}\s+(.*\S)\s*$/.exec(raw);
    if (h) { group = h[1].trim(); continue; }
    const m = /^-\s+`([a-z0-9][a-z0-9/_-]*)`:\s*(.+\S)\s*$/.exec(raw);
    if (m) out.push({ slug: m[1], text: m[2].trim(), group });
  }
  return out;
}

/**
 * Snapshot of a desktop product: the version found (or "unknown") and the
 * inventory items. A product with no inventory and no version still yields a
 * snapshot so the report says so.
 */
export function extractDesktop({ product, installed, inventoryMd, now }) {
  const found = installed && installed[0];
  const items = parseInventory(inventoryMd || '').map((f) => makeItem(product, 'feature', f.slug, { title: f.text, group: f.group }));
  return buildSnapshot({
    product,
    version: found ? found.version : 'unknown',
    now,
    meta: found ? { package: found.package, arch: found.arch, inventoryFile: `manual/${product}.md` } : { inventoryFile: `manual/${product}.md`, note: 'no installed version found' },
    items,
  });
}

/** Gather installed versions and the manual file for one desktop product. */
export function collectDesktop(root, product, now = new Date()) {
  const { names, source } = listPackageNames();
  let local = [];
  try { if (process.env.LOCALAPPDATA) local = fs.readdirSync(path.join(process.env.LOCALAPPDATA, 'AnthropicClaude')); } catch { /* not installed that way */ }
  const installed = findInstalled(product, names, local);
  const file = path.join(root, 'manual', `${product}.md`);
  const inventoryMd = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const notes = [];
  if (!installed.length) notes.push(`${product}: no installed version found (looked at ${source})`);
  else notes.push(`${product}: version ${installed[0].version} from ${source}`);
  if (!inventoryMd) notes.push(`${product}: manual/${product}.md is missing`);
  return { snapshot: extractDesktop({ product, installed, inventoryMd, now }), notes };
}
