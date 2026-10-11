#!/usr/bin/env node
/**
 * diff.mjs: `npm run parity:diff`. Compare a fresh extraction of every
 * upstream product with its saved snapshot and print what was added, removed
 * or changed, then which ledger features that touches.
 *
 * Why (Arthur, 2026-10-11): "so that we can diff in the future if features are
 * adjusted/added/removed and make sure we can quickly support those changes",
 * and "make sure we're updating the app alongside the desktop app so all
 * functionality is equal across the board" (hence the phone gaps section).
 *
 * The baseline for a product is the newest saved snapshot OLDER than the fresh
 * version, so `npm run parity:extract` followed by this still shows what an
 * upgrade changed. With no older snapshot it uses the same version (extractor
 * drift only). Exit code is 0 always: it is a report. With --strict it exits 1
 * when something needs attention: a feature whose upstream id was removed or
 * changed, a ledger id that matches nothing, or a feature the desktop fully
 * supports while the phone has nothing yet.
 *
 * Usage: node apaki/parity/diff.mjs [--strict] [--details] [--all] [--backlog] [--only claude-sdk,codex]
 *   --details  include data-model detail kinds (type, tool-output, const)
 *   --all      do not cap long lists
 *   --backlog  also list EVERY upstream id no ledger entry covers (not just new ones)
 *   --only     limit to some products
 */
import fs from 'node:fs';
import path from 'node:path';
import { PARITY_ROOT, REPO_ROOT, collectAll } from './lib/collect.mjs';
import { DETAIL_KINDS, diffSnapshots, loadSnapshots, pickBaseline } from './lib/snapshot.mjs';
import { buildReport, loadLedger, matchIds, missingFiles, validateLedger } from './lib/ledger.mjs';
import { renderProductDiff, renderReport } from './lib/report.mjs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const details = args.includes('--details');
const all = args.includes('--all');
const backlog = args.includes('--backlog');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? String(args[onlyIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
const limit = all ? 0 : 60;

const { snapshots: fresh, notes } = collectAll({ only });
const ledger = loadLedger(PARITY_ROOT);
const { errors } = validateLedger(ledger);

console.log(`Upstream parity report ${new Date().toISOString().slice(0, 10)}`);
for (const n of notes) console.log(`note: ${n}`);
for (const e of errors) console.log(`ledger error: ${e}`);
console.log('');

const diffs = {};
for (const [product, snap] of Object.entries(fresh)) {
  const baseline = pickBaseline(loadSnapshots(PARITY_ROOT, product), snap.version);
  const diff = baseline ? diffSnapshots(baseline, snap) : { added: [], removed: [], changed: [] };
  if (baseline) diffs[product] = diff;
  for (const line of renderProductDiff({ product, fresh: snap, baseline, diff, limit, details })) console.log(line);
}

const report = buildReport({ ledger, diffs, current: fresh, details });
if (backlog) {
  // every current id nobody covers, as if all of it were new
  const patterns = ledger.features.flatMap((f) => f.upstream || []);
  report.unreviewed = {};
  for (const [product, snap] of Object.entries(fresh)) {
    const open = snap.items.filter((i) => (details || !DETAIL_KINDS.has(i.kind)) && !matchIds(patterns, [i.id]).length);
    for (const it of open) ((report.unreviewed[product] ||= {})[it.kind] ||= []).push(it.id);
  }
}
for (const line of renderReport(report, { limit })) console.log(line);

// files the ledger names that are gone (informational; they do not count for --strict)
const gone = missingFiles(ledger, (f) => fs.existsSync(path.join(REPO_ROOT, f)));
if (gone.length) {
  console.log('');
  console.log(`MISSING FILES: ledger "where" paths that no longer exist (${gone.length})`);
  for (const g of gone.slice(0, limit || gone.length)) console.log(`  ${g.feature.id}: ${g.file}`);
}

console.log('');
console.log(`${report.attention} item${report.attention === 1 ? '' : 's'} need attention (${report.needsAttention.length} changed or removed, ${report.dangling.length} dangling, ${report.phoneGaps.filter((g) => g.strict).length} phone gaps behind a supported desktop feature).`);
if (strict && report.attention > 0) process.exitCode = 1;
