/**
 * snapshot.mjs: the "surface snapshot" format of the upstream parity tracker
 * (apaki/parity/PARITY.md; Arthur, 2026-10-11: "keep track of what sessions
 * were involved in integrating and indexing features/etc for claude code,
 * claude desktop, chatgpt app, codex, etc so that we can diff in the future if
 * features are adjusted/added/removed").
 *
 * A snapshot is what one upstream product exposed at one version:
 *   { schema, product, version, extractedAt, meta, counts, items: [{ id, kind, attrs }] }
 * An item id is "<product>:<kind>:<name>", for example
 * "claude-sdk:hook-event:PreToolUse" or "codex:client-request:turn/steer".
 * Items are sorted by id and written one per line, keys sorted, so a git diff
 * of two snapshots reads like the change list. Pure functions only; reading and
 * writing files is in saveSnapshot / loadSnapshots at the bottom.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

/**
 * Kinds that are data-model detail rather than surface somebody builds a
 * feature on. They are kept in snapshots and diffed, but the report lists them
 * only on request (--details) so "unreviewed" stays readable.
 */
export const DETAIL_KINDS = new Set(['type', 'tool-output', 'const']);

/** Short stable hash of any text, for long type strings. */
export const shortHash = (text) => createHash('sha1').update(String(text)).digest('hex').slice(0, 8);

/** Shorten text to n characters with an ellipsis marker the diff can still compare. */
export const clip = (text, n) => (String(text).length > n ? `${String(text).slice(0, n - 3)}...` : String(text));

/** JSON with object keys sorted at every depth (arrays keep their order). */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Plain code unit comparison: the same order on every machine and locale. */
export const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Drop undefined values and empty arrays/objects from attrs so absent and empty read the same. */
export function cleanAttrs(attrs) {
  const out = {};
  for (const k of Object.keys(attrs || {})) {
    const v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
    out[k] = v;
  }
  return out;
}

/** Build one item. Name may contain colons and slashes; the id is product:kind:name. */
export function makeItem(product, kind, name, attrs = {}) {
  return { id: `${product}:${kind}:${name}`, kind, attrs: cleanAttrs(attrs) };
}

/** Split an id into { product, kind, name } on the first two colons. */
export function parseId(id) {
  const a = id.indexOf(':');
  const b = id.indexOf(':', a + 1);
  if (a < 1 || b < 0) return { product: id, kind: '', name: '' };
  return { product: id.slice(0, a), kind: id.slice(a + 1, b), name: id.slice(b + 1) };
}

/**
 * Assemble a snapshot from items. Duplicate ids are a bug in an extractor and
 * throw, so two upstream things never silently share one id.
 */
export function buildSnapshot({ product, version, now, meta = {}, items }) {
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.id)) throw new Error(`duplicate surface id ${it.id}`);
    seen.add(it.id);
  }
  const sorted = [...items].sort(byId);
  const counts = {};
  for (const it of sorted) counts[it.kind] = (counts[it.kind] || 0) + 1;
  return {
    schema: SCHEMA_VERSION,
    product,
    version: String(version),
    extractedAt: (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString().slice(0, 10),
    meta,
    counts: Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]])),
    items: sorted,
  };
}

/** The file text for a snapshot: pretty header, one item per line. */
export function serializeSnapshot(snap) {
  const head = (k) => `  ${JSON.stringify(k)}: ${stableStringify(snap[k])}`;
  const lines = ['schema', 'product', 'version', 'extractedAt', 'meta', 'counts'].map(head);
  const items = snap.items.map((it) => `    ${stableStringify(it)}`).join(',\n');
  return `{\n${lines.join(',\n')},\n  "items": [\n${items}\n  ]\n}\n`;
}

/** Compare two version strings numerically by dotted segment ("0.161.0" < "0.162.0" < "0.162.10"). */
export function compareVersions(a, b) {
  const seg = (v) => String(v).split(/[.+-]/).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  const x = seg(a);
  const y = seg(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}

/** A version safe to use as a file name. */
export const versionFile = (version) => `${String(version).replace(/[^A-Za-z0-9._+-]/g, '_')}.json`;

/** Where a product's snapshots live. */
export const snapshotDir = (root, product) => path.join(root, 'snapshots', product);

/** Write a snapshot to <root>/snapshots/<product>/<version>.json. Returns the path. */
export function saveSnapshot(root, snap) {
  const dir = snapshotDir(root, snap.product);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, versionFile(snap.version));
  fs.writeFileSync(file, serializeSnapshot(snap));
  return file;
}

/** All saved snapshots of a product, oldest version first. */
export function loadSnapshots(root, product) {
  const dir = snapshotDir(root, product);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* a damaged file is skipped, the diff says nothing for it */ }
  }
  return out.sort((a, b) => compareVersions(a.version, b.version));
}

/** Products that have a snapshots folder. */
export function savedProducts(root) {
  const dir = path.join(root, 'snapshots');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/**
 * Pick the baseline to compare a fresh extraction against: the newest saved
 * snapshot OLDER than the fresh version, so "extract then diff" still shows
 * what the upgrade changed; with none older, the same version (which shows
 * only extractor drift); with none at all, null.
 */
export function pickBaseline(saved, freshVersion) {
  const older = saved.filter((s) => compareVersions(s.version, freshVersion) < 0);
  if (older.length) return older[older.length - 1];
  const same = saved.find((s) => compareVersions(s.version, freshVersion) === 0);
  return same || null;
}

/**
 * Diff two snapshots by item id. "changed" means the same id with different
 * attrs; each change lists the attr keys that differ, with before and after.
 */
export function diffSnapshots(before, after) {
  const a = new Map((before?.items || []).map((i) => [i.id, i]));
  const b = new Map((after?.items || []).map((i) => [i.id, i]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, item] of b) {
    if (!a.has(id)) { added.push(item); continue; }
    const old = a.get(id);
    if (stableStringify(old.attrs) !== stableStringify(item.attrs)) {
      const keys = [...new Set([...Object.keys(old.attrs), ...Object.keys(item.attrs)])].sort();
      const changes = keys
        .filter((k) => stableStringify(old.attrs[k]) !== stableStringify(item.attrs[k]))
        .map((k) => ({ key: k, before: old.attrs[k], after: item.attrs[k] }));
      changed.push({ id, kind: item.kind, before: old.attrs, after: item.attrs, changes });
    }
  }
  for (const [id, item] of a) if (!b.has(id)) removed.push(item);
  added.sort(byId);
  removed.sort(byId);
  changed.sort(byId);
  return { added, removed, changed };
}

/** One attr change as a short human line ("fields: +tag, -foo" for lists, "a -> b" otherwise). */
export function describeChange(c) {
  const fmt = (v) => (v === undefined ? '(none)' : typeof v === 'string' ? v : stableStringify(v));
  const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (plain(c.before) && plain(c.after)) {
    // an object attr (enums: { level: [...] }): one line per key that differs
    const keys = [...new Set([...Object.keys(c.before), ...Object.keys(c.after)])].sort();
    return keys
      .filter((k) => stableStringify(c.before[k]) !== stableStringify(c.after[k]))
      .map((k) => describeChange({ key: `${c.key}.${k}`, before: c.before[k], after: c.after[k] }))
      .join('; ');
  }
  if (Array.isArray(c.before) && Array.isArray(c.after)) {
    const plus = c.after.filter((x) => !c.before.includes(x));
    const minus = c.before.filter((x) => !c.after.includes(x));
    return `${c.key}: ${[...plus.map((x) => `+${x}`), ...minus.map((x) => `-${x}`)].join(', ') || 'reordered'}`;
  }
  return `${c.key}: ${clip(fmt(c.before), 80)} -> ${clip(fmt(c.after), 80)}`;
}
