/**
 * ledger.mjs: the feature ledger of the upstream parity tracker
 * (apaki/parity/features.json, apaki/parity/PARITY.md; Arthur, 2026-10-11:
 * "keep track of what sessions were involved in integrating and indexing
 * features/etc ... so that we can diff in the future ... and make sure we can
 * quickly support those changes", and "make sure we're updating the app
 * alongside the desktop app so all functionality is equal across the board").
 *
 * One entry per feature Apaki supports or plans. Each says which upstream
 * surface ids it depends on (exact ids or ids with * wildcards, see
 * apaki/parity/snapshots), its status per surface (desktop, phone), where it
 * lives, the commits and sessions that built it, and which upstream versions
 * it was last checked against.
 *
 * This file holds the pure logic: validation, id matching, the report diff.mjs
 * prints (needs attention, dangling references, unreviewed ids, phone gaps),
 * and the coverage numbers extract.mjs writes into PARITY.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DETAIL_KINDS, compareVersions, describeChange, parseId } from './snapshot.mjs';

export const PRODUCTS = ['claude-sdk', 'codex', 'claude-desktop', 'chatgpt-desktop', 'apaki'];
export const STATUSES = ['supported', 'partial', 'planned', 'not-applicable'];
export const SURFACE_STATUSES = ['supported', 'partial', 'planned', 'n/a'];
export const SURFACES = ['desktop', 'phone'];

/** The markers around the generated section of PARITY.md. */
export const COVERAGE_START = '[//]: # (parity:coverage:start)';
export const COVERAGE_END = '[//]: # (parity:coverage:end)';

/** Rank used to compare a surface against the desktop: n/a never lags, anything else by completeness. */
const RANK = { supported: 3, partial: 2, planned: 1, 'n/a': 0 };

/** Load features.json from the parity folder (throws on a missing or damaged file). */
export function loadLedger(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'features.json'), 'utf8'));
}

/** The overall status the surfaces imply: all supported, any supported or partial, none yet, or all n/a. */
export function deriveStatus(surfaces) {
  const vals = SURFACES.map((s) => surfaces?.[s]).filter((v) => v && v !== 'n/a');
  if (!vals.length) return 'not-applicable';
  if (vals.every((v) => v === 'supported')) return 'supported';
  if (vals.some((v) => v === 'supported' || v === 'partial')) return 'partial';
  return 'planned';
}

/**
 * Check a ledger object. Returns { errors, warnings } as lists of strings; an
 * error is a shape problem or an inconsistency, a warning is a thin entry.
 */
export function validateLedger(ledger) {
  const errors = [];
  const warnings = [];
  if (!ledger || !Array.isArray(ledger.features)) return { errors: ['features.json has no features array'], warnings };
  const seen = new Set();
  for (const f of ledger.features) {
    const at = `feature ${f?.id ?? '(no id)'}`;
    if (!f || typeof f !== 'object') { errors.push('a feature entry is not an object'); continue; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(f.id || '')) errors.push(`${at}: id must be kebab-case`);
    if (seen.has(f.id)) errors.push(`${at}: duplicate id`);
    seen.add(f.id);
    if (!f.title || typeof f.title !== 'string') errors.push(`${at}: title is required`);
    if (!PRODUCTS.includes(f.product)) errors.push(`${at}: product must be one of ${PRODUCTS.join(', ')}`);
    if (!STATUSES.includes(f.status)) errors.push(`${at}: status must be one of ${STATUSES.join(', ')}`);
    if (!f.surfaces || typeof f.surfaces !== 'object') errors.push(`${at}: surfaces is required ({ desktop, phone })`);
    else {
      for (const s of SURFACES) if (!SURFACE_STATUSES.includes(f.surfaces[s])) errors.push(`${at}: surfaces.${s} must be one of ${SURFACE_STATUSES.join(', ')}`);
      for (const s of Object.keys(f.surfaces)) if (!SURFACES.includes(s)) errors.push(`${at}: unknown surface ${s}`);
      if (STATUSES.includes(f.status) && SURFACES.every((s) => SURFACE_STATUSES.includes(f.surfaces[s])) && deriveStatus(f.surfaces) !== f.status) {
        errors.push(`${at}: status ${f.status} does not match its surfaces (they imply ${deriveStatus(f.surfaces)})`);
      }
    }
    for (const key of ['upstream', 'where', 'commits', 'sessions']) if (!Array.isArray(f[key])) errors.push(`${at}: ${key} must be an array`);
    for (const u of f.upstream || []) {
      const { product, kind } = parseId(String(u));
      if (!product || !kind) errors.push(`${at}: upstream id ${u} is not product:kind:name`);
    }
    for (const c of f.commits || []) if (!/^[0-9a-f]{7,12}$/.test(c)) errors.push(`${at}: commit ${c} is not a short hash`);
    for (const s of f.sessions || []) if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) errors.push(`${at}: session ${s} is not a session id`);
    if (f.verifiedAgainst && typeof f.verifiedAgainst !== 'object') errors.push(`${at}: verifiedAgainst must be an object of product to version`);
    if (typeof f.notes !== 'string') warnings.push(`${at}: notes missing`);
    if ((f.status === 'supported' || f.status === 'partial') && !(f.where || []).length) warnings.push(`${at}: ${f.status} but no where (files)`);
    if (f.status === 'supported' && !(f.commits || []).length) warnings.push(`${at}: supported but no commits`);
    if (f.status !== 'not-applicable' && f.product !== 'apaki' && !(f.upstream || []).length) warnings.push(`${at}: no upstream ids`);
  }
  return { errors, warnings };
}

/**
 * Files a ledger entry names in `where` that no longer exist under repoRoot
 * (a file moved or was deleted): [{ feature, file }]. exists() is injected so
 * tests need no disk.
 */
export function missingFiles(ledger, exists) {
  const out = [];
  for (const f of ledger.features) for (const file of f.where || []) if (!exists(file)) out.push({ feature: f, file });
  return out;
}

/** A pattern (exact id or with * wildcards) as a RegExp. */
export function patternToRegex(pattern) {
  const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + String(pattern).split('*').map(escape).join('.*') + '$');
}

/** Ids from a list that a feature's upstream patterns match. */
export function matchIds(patterns, ids) {
  const res = (patterns || []).map(patternToRegex);
  return ids.filter((id) => res.some((r) => r.test(id)));
}

/** The product part of an id or pattern. */
export const productOf = (idOrPattern) => parseId(String(idOrPattern)).product;

/** Phone lags desktop: the desktop has it (fully or partly), the phone has less, and the phone is not n/a. */
export function phoneGap(feature) {
  const d = feature.surfaces?.desktop;
  const p = feature.surfaces?.phone;
  if (!d || d === 'planned' || d === 'n/a') return null;
  if (p === 'n/a') return null;
  if ((RANK[p] ?? 0) >= RANK[d]) return null;
  // strict: the desktop has it fully and the phone has none of it yet
  return { desktop: d, phone: p ?? 'missing', strict: d === 'supported' && (p === 'planned' || p == null) };
}

/**
 * The report diff.mjs prints.
 * @param {object} p
 * @param {object} p.ledger parsed features.json
 * @param {Object<string, object>} p.diffs product -> diffSnapshots() result (added, removed, changed) against its baseline
 * @param {Object<string, object>} p.current product -> fresh snapshot
 * @param {boolean} [p.details] include data-model detail kinds in unreviewed
 */
export function buildReport({ ledger, diffs, current, details = false }) {
  const features = ledger.features;
  const needsAttention = [];
  for (const f of features) {
    if (f.status === 'not-applicable') continue;
    const hit = { feature: f, removed: [], changed: [], detail: {} };
    for (const [product, d] of Object.entries(diffs)) {
      const mine = (f.upstream || []).filter((u) => productOf(u) === product);
      if (!mine.length) continue;
      hit.removed.push(...matchIds(mine, d.removed.map((i) => i.id)));
      const changedIds = matchIds(mine, d.changed.map((c) => c.id));
      hit.changed.push(...changedIds);
      for (const c of d.changed) if (changedIds.includes(c.id)) hit.detail[c.id] = c.changes.map(describeChange).join('; ');
    }
    if (hit.removed.length || hit.changed.length) needsAttention.push(hit);
  }
  // A ledger id that matches nothing now is a typo or a removal. A removal is already listed under needs
  // attention, and a not-applicable entry only dismisses ids, so neither is repeated here.
  const dangling = [];
  for (const f of features) {
    if (f.status === 'not-applicable') continue;
    for (const u of f.upstream || []) {
      const snap = current[productOf(u)];
      if (!snap) continue;
      const ids = snap.items.map((i) => i.id);
      if (matchIds([u], ids).length) continue;
      const removed = (diffs[productOf(u)]?.removed || []).map((i) => i.id);
      if (matchIds([u], removed).length) continue;
      dangling.push({ feature: f, pattern: u });
    }
  }
  const allPatterns = features.flatMap((f) => f.upstream || []);
  const unreviewed = {};
  for (const [product, d] of Object.entries(diffs)) {
    for (const item of d.added) {
      if (!details && DETAIL_KINDS.has(item.kind)) continue;
      if (matchIds(allPatterns, [item.id]).length) continue;
      (unreviewed[product] ||= {})[item.kind] ||= [];
      unreviewed[product][item.kind].push(item.id);
    }
  }
  const phoneGaps = [];
  for (const f of features) {
    const g = phoneGap(f);
    if (g) phoneGaps.push({ feature: f, ...g });
  }
  const stale = [];
  for (const f of features) {
    for (const [product, version] of Object.entries(f.verifiedAgainst || {})) {
      const snap = current[product];
      if (snap && compareVersions(version, snap.version) < 0) stale.push({ feature: f, product, verified: version, current: snap.version });
    }
  }
  const attention = needsAttention.length + dangling.length + phoneGaps.filter((g) => g.strict).length;
  return { needsAttention, dangling, unreviewed, phoneGaps, stale, attention };
}

/** Coverage numbers: per product items and how many a ledger entry covers, ledger counts by status and surface. */
export function summarizeCoverage({ ledger, snapshots }) {
  const patterns = ledger.features.flatMap((f) => f.upstream || []);
  const products = {};
  for (const snap of snapshots) {
    const ids = snap.items.map((i) => i.id);
    const covered = new Set(matchIds(patterns, ids));
    const byKind = {};
    for (const it of snap.items) {
      const k = (byKind[it.kind] ||= { total: 0, covered: 0 });
      k.total++;
      if (covered.has(it.id)) k.covered++;
    }
    const primary = snap.items.filter((i) => !DETAIL_KINDS.has(i.kind));
    products[snap.product] = {
      version: snap.version,
      total: snap.items.length,
      covered: covered.size,
      primaryTotal: primary.length,
      primaryCovered: primary.filter((i) => covered.has(i.id)).length,
      byKind,
    };
  }
  const byStatus = {};
  const bySurface = { desktop: {}, phone: {} };
  const byProduct = {};
  for (const f of ledger.features) {
    byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    for (const s of SURFACES) bySurface[s][f.surfaces?.[s]] = (bySurface[s][f.surfaces?.[s]] || 0) + 1;
    byProduct[f.product] = (byProduct[f.product] || 0) + 1;
  }
  const gaps = ledger.features.map(phoneGap).filter(Boolean);
  return { products, features: ledger.features.length, byStatus, bySurface, byProduct, phoneGaps: gaps.length, phoneGapsStrict: gaps.filter((g) => g.strict).length };
}

const fmtCounts = (obj, order) => order.filter((k) => obj[k]).map((k) => `${k} ${obj[k]}`).join(', ') || 'none';

/** Markdown for the generated section of PARITY.md. */
export function renderCoverageMarkdown(summary, { date, notes = [] } = {}) {
  const lines = [];
  lines.push(`Generated by \`npm run parity:extract\`${date ? ` on ${date}` : ''}. Do not edit between the markers; edit features.json and re-run.`);
  lines.push('');
  lines.push('### Surface snapshots');
  lines.push('');
  lines.push('| Product | Version | Surface ids | Covered by a ledger entry | Primary ids covered |');
  lines.push('|---|---|---|---|---|');
  for (const [product, p] of Object.entries(summary.products)) {
    lines.push(`| ${product} | ${p.version} | ${p.total} | ${p.covered} | ${p.primaryCovered} of ${p.primaryTotal} |`);
  }
  lines.push('');
  lines.push('Covered means at least one ledger entry names the id (exactly or by a * pattern). "Primary" leaves out data-model detail kinds (type, tool-output, const).');
  lines.push('');
  for (const [product, p] of Object.entries(summary.products)) {
    if (!p.total) continue;
    lines.push(`${product} ${p.version} by kind: ${Object.keys(p.byKind).sort().map((k) => `${k} ${p.byKind[k].covered}/${p.byKind[k].total}`).join(', ')}`);
    lines.push('');
  }
  lines.push('### Feature ledger');
  lines.push('');
  lines.push(`${summary.features} features. By status: ${fmtCounts(summary.byStatus, STATUSES)}. By product: ${fmtCounts(summary.byProduct, PRODUCTS)}.`);
  lines.push('');
  lines.push('| Surface | supported | partial | planned | n/a |');
  lines.push('|---|---|---|---|---|');
  for (const s of SURFACES) lines.push(`| ${s} | ${SURFACE_STATUSES.map((v) => summary.bySurface[s][v] || 0).join(' | ')} |`);
  lines.push('');
  lines.push(`Phone gaps (phone has less than the desktop): ${summary.phoneGaps}, of which ${summary.phoneGapsStrict} are desktop supported with nothing on the phone yet (\`--strict\` counts those).`);
  if (notes.length) {
    lines.push('');
    lines.push('### Last extraction notes');
    lines.push('');
    for (const n of notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

/** Replace the text between two marker lines (markers kept). Appends the block when the markers are absent. */
export function replaceBetween(text, start, end, body) {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  const block = `${start}\n${body}\n${end}`;
  if (a === -1 || b === -1 || b < a) return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
  return `${text.slice(0, a)}${block}${text.slice(b + end.length)}`;
}
