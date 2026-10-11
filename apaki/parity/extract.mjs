#!/usr/bin/env node
/**
 * extract.mjs: `npm run parity:extract`. Run every upstream extractor, save
 * the surface snapshots to apaki/parity/snapshots/<product>/<version>.json,
 * and rewrite the generated coverage section of PARITY.md (between the
 * parity:coverage markers).
 *
 * Why (Arthur, 2026-10-11): "keep track of what sessions were involved in
 * integrating and indexing features/etc for claude code, claude desktop,
 * chatgpt app, codex, etc so that we can diff in the future".
 *
 * Usage: node apaki/parity/extract.mjs [--only claude-sdk,codex] [--dry]
 *   --only  limit to some products (claude-sdk, codex, claude-desktop, chatgpt-desktop)
 *   --dry   print what would be saved; write nothing
 * Re-running at the same version overwrites that version's file. A new
 * version adds a new file, so the old one stays for `npm run parity:diff`.
 * Never reads credential files; never opens or closes the desktop apps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PARITY_ROOT, collectAll } from './lib/collect.mjs';
import { saveSnapshot, loadSnapshots, savedProducts } from './lib/snapshot.mjs';
import { COVERAGE_END, COVERAGE_START, loadLedger, renderCoverageMarkdown, replaceBetween, summarizeCoverage, validateLedger } from './lib/ledger.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? String(args[onlyIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
const now = new Date();

const { snapshots, notes } = collectAll({ only, now });
const rel = (f) => path.relative(process.cwd(), f) || f;

for (const [product, snap] of Object.entries(snapshots)) {
  const kinds = Object.entries(snap.counts).map(([k, n]) => `${k} ${n}`).join(', ');
  if (dry) console.log(`${product} ${snap.version}: ${snap.items.length} items (${kinds}) [dry run, not saved]`);
  else console.log(`${product} ${snap.version}: ${snap.items.length} items (${kinds}) -> ${rel(saveSnapshot(PARITY_ROOT, snap))}`);
}
for (const n of notes) console.log(`note: ${n}`);

if (!dry) {
  const latest = savedProducts(PARITY_ROOT).map((p) => loadSnapshots(PARITY_ROOT, p).pop()).filter(Boolean);
  const ledger = loadLedger(PARITY_ROOT);
  const { errors, warnings } = validateLedger(ledger);
  for (const e of errors) console.log(`ledger error: ${e}`);
  for (const w of warnings) console.log(`ledger warning: ${w}`);
  const summary = summarizeCoverage({ ledger, snapshots: latest });
  const file = path.join(PARITY_ROOT, 'PARITY.md');
  const md = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const body = renderCoverageMarkdown(summary, { date: now.toISOString().slice(0, 10), notes });
  fs.writeFileSync(file, replaceBetween(md, COVERAGE_START, COVERAGE_END, body));
  console.log(`coverage summary written to ${rel(file)}`);
}
