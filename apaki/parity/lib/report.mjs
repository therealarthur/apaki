/**
 * report.mjs: turn the numbers of ledger.buildReport() and snapshot diffs into
 * the text `npm run parity:diff` prints (apaki/parity/PARITY.md, 2026-10-11).
 * Pure: takes data, returns lines.
 */
import { DETAIL_KINDS, describeChange } from './snapshot.mjs';

/** Lines for one product's diff: counts, then added, removed and changed ids. */
export function renderProductDiff({ product, fresh, baseline, diff, limit = 60, details = false }) {
  const keep = (it) => details || !DETAIL_KINDS.has(it.kind);
  const added = diff.added.filter(keep);
  const removed = diff.removed.filter(keep);
  const changed = diff.changed.filter(keep);
  const hidden = diff.added.length + diff.removed.length + diff.changed.length - added.length - removed.length - changed.length;
  const lines = [];
  const base = baseline ? `${baseline.version} (saved ${baseline.extractedAt})` : 'none saved';
  const ccv = fresh.meta?.claudeCodeVersion ? `, Claude Code ${fresh.meta.claudeCodeVersion}` : '';
  lines.push(`${product}: fresh ${fresh.version}${ccv} vs saved ${base}`);
  if (!baseline) {
    lines.push('  no saved snapshot to compare with; run npm run parity:extract to save this one');
    return lines;
  }
  lines.push(`  added ${added.length}, removed ${removed.length}, changed ${changed.length}${hidden ? ` (${hidden} data-model detail changes hidden, use --details)` : ''}`);
  const cap = (list, fmt, sign) => {
    const shown = limit > 0 ? list.slice(0, limit) : list;
    for (const x of shown) lines.push(`  ${sign} ${fmt(x)}`);
    if (shown.length < list.length) lines.push(`  ${sign} ... and ${list.length - shown.length} more (use --all)`);
  };
  cap(added, (x) => x.id, '+');
  cap(removed, (x) => x.id, '-');
  cap(changed, (x) => `${x.id}  [${x.changes.map(describeChange).join('; ')}]`, '~');
  return lines;
}

/** Lines for the needs-attention, dangling, unreviewed, phone-gap and stale sections. */
export function renderReport(report, { limit = 60 } = {}) {
  const lines = [];
  const head = (title, n) => { lines.push(''); lines.push(`${title} (${n})`); };

  head('NEEDS ATTENTION: ledger features whose upstream ids were removed or changed', report.needsAttention.length);
  for (const h of report.needsAttention) {
    lines.push(`  ${h.feature.id} [${h.feature.status}] ${h.feature.title}`);
    for (const id of h.removed) lines.push(`      removed  ${id}`);
    for (const id of h.changed) lines.push(`      changed  ${id}${h.detail?.[id] ? `  [${h.detail[id]}]` : ''}`);
  }

  head('DANGLING: ledger upstream ids that match nothing in the fresh extraction', report.dangling.length);
  for (const d of report.dangling) lines.push(`  ${d.feature.id}: ${d.pattern}`);

  const unreviewedCount = Object.values(report.unreviewed).reduce((n, kinds) => n + Object.values(kinds).reduce((m, l) => m + l.length, 0), 0);
  head('UNREVIEWED: new upstream ids no ledger entry covers', unreviewedCount);
  for (const [product, kinds] of Object.entries(report.unreviewed)) {
    for (const [kind, ids] of Object.entries(kinds)) {
      lines.push(`  ${product} ${kind} (${ids.length})`);
      const shown = limit > 0 ? ids.slice(0, limit) : ids;
      for (const id of shown) lines.push(`      ${id}`);
      if (shown.length < ids.length) lines.push(`      ... and ${ids.length - shown.length} more (use --all)`);
    }
  }

  head('PHONE GAPS: features where the phone has less than the desktop', report.phoneGaps.length);
  for (const g of report.phoneGaps) {
    lines.push(`  ${g.feature.id}: desktop ${g.desktop}, phone ${g.phone}${g.strict ? '  (counts for --strict)' : ''}`);
  }

  if (report.stale.length) {
    head('RE-VERIFY: features last checked against an older upstream version', report.stale.length);
    const by = {};
    for (const s of report.stale) (by[`${s.product} ${s.verified} -> ${s.current}`] ||= []).push(s.feature.id);
    for (const [k, ids] of Object.entries(by)) lines.push(`  ${k}: ${ids.length} features`);
  }
  return lines;
}
