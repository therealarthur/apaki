/** Read Kimi metadata and search main-agent journals locally. Never read credentials or walk a session's cwd. */
import fs from 'node:fs';
import path from 'node:path';
import { kimiHome, kimiSessionId } from './kimi-client.js';

import { kimiExcluded, kimiRegular as regular } from './kimi-files.js';
import { readKimiTitle } from './kimi-journal.js';
export { kimiExcluded } from './kimi-files.js';

async function json(file, root) {
  const st = await regular(file, root);
  if (!st || st.size > 1024 * 1024) return null;
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
}
const time = (v) => Number.isFinite(v) ? v : Date.parse(v || '') || 0;
const dirs = async (dir) => (await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []))
  .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !kimiExcluded(e.name)).map((e) => e.name);
const wordsOf = (v) => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(wordsOf).filter(Boolean).join('\n');
  if (!v || typeof v !== 'object') return '';
  return [v.text, v.thinking, v.content, v.output, v.arguments, v.command, v.file_path, v.path].map(wordsOf).filter(Boolean).join('\n');
};
export function wireText(record) {
  if (record?.type === 'context.append_message') return wordsOf(record.message?.content);
  if (record?.type !== 'context.append_loop_event') return '';
  const e = record.event;
  if (e?.type === 'content.part') return wordsOf(e.part);
  if (e?.type === 'tool.call') return [e.name, wordsOf(e.args)].filter(Boolean).join(' ');
  if (e?.type === 'tool.result') return wordsOf(e.result?.output);
  return '';
}

/** Bounded line framing, including a partial final write. Oversized records are skipped, not accumulated. */
async function* lines(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let buf = '', skipping = false;
  try {
    for await (const data of stream) {
      buf += data;
      let at;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        if (!skipping && line.length <= 2 * 1024 * 1024) yield line;
        skipping = false;
      }
      if (buf.length > 2 * 1024 * 1024) { buf = ''; skipping = true; }
    }
    if (buf && !skipping) yield buf;
  } finally { stream.destroy(); }
}

export function createKimiList({ home = kimiHome(), enabled = true, ttlMs = 10000 } = {}) {
  const root = path.resolve(home, 'sessions');
  let rows = [], byId = new Map(), refreshed = 0, loading = null;
  const hitCache = new Map(), titleCache = new Map();
  async function scan() {
    const found = [];
    const rootStat = await fs.promises.lstat(root).catch(() => null);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || kimiExcluded(root)) return found;
    for (const workspace of await dirs(root)) {
      for (const id of await dirs(path.join(root, workspace))) {
        try { kimiSessionId(id); } catch { continue; }
        const dir = path.join(root, workspace, id);
        const meta = await json(path.join(dir, 'state.json'), root) || await json(path.join(dir, 'session-meta', 'state.json'), root);
        if (!meta || typeof meta !== 'object') continue;
        const cwd = meta.cwd || meta.workDir || meta.custom?.cwd || '';
        if (!cwd || typeof cwd !== 'string' || kimiExcluded(cwd)) continue;
        const wire = path.join(dir, 'agents', 'main', 'wire.jsonl');
        const stat = await regular(wire, root);
        const stamp = stat ? `${stat.size}:${stat.mtimeMs}` : '';
        let derived = titleCache.get(wire);
        if (stat && derived?.stamp !== stamp) {
          derived = { stamp, ...await readKimiTitle(wire, root).catch(() => ({})) };
          titleCache.set(wire, derived);
        }
        if (!stat) { titleCache.delete(wire); derived = null; }
        const savedTitle = typeof meta.title === 'string' ? meta.title.replace(/\s+/g, ' ').trim() : '';
        const title = (savedTitle || derived?.title || 'Kimi conversation').slice(0, 240);
        found.push({
          id: `kimi:${id}`, kimi: true, kind: 'kimi', title, cwd, firstPrompt: derived?.firstPrompt || '',
          ...(derived?.role ? { kimiRole: derived.role } : {}),
          lastModified: time(meta.updatedAt) || stat?.mtimeMs || time(meta.createdAt), createdAt: time(meta.createdAt),
          size: stat?.size || 0, kimiArchived: meta.archived === true,
          file: stat ? wire : null, stamp,
        });
      }
    }
    const files = new Set(found.map((r) => r.file));
    for (const file of titleCache.keys()) if (!files.has(file)) titleCache.delete(file);
    if (titleCache.size > 1000) titleCache.clear();
    return found.sort((a, b) => b.lastModified - a.lastModified);
  }
  async function refresh(force = false) {
    if (!enabled) return rows;
    if (loading) return loading;
    if (!force && refreshed && Date.now() - refreshed < ttlMs) return rows;
    loading = scan().then((next) => {
      rows = next; byId = new Map(rows.map((r) => [r.id, r])); refreshed = Date.now();
      if (hitCache.size > 1000) hitCache.clear();
      return rows;
    }).finally(() => { loading = null; });
    return loading;
  }
  async function search(query, limit = 80) {
    await refresh();
    const terms = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const result = [];
    const matches = (s) => terms.every((t) => s.toLowerCase().includes(t));
    for (const row of rows) {
      let snippet = '', hits = 0;
      if (matches([row.title, row.firstPrompt, row.cwd, row.id].join(' '))) { snippet = row.firstPrompt || row.title; hits = 1; }
      if (row.file) {
        const st = await regular(row.file, root);
        const key = `${row.id}:${st?.mtimeMs}:${st?.size}:${terms.join(' ')}`;
        let hit = hitCache.get(key);
        if (!hit && st) {
          hit = { snippet: '', hits: 0 };
          try {
            for await (const line of lines(row.file)) {
              let record;
              try { record = JSON.parse(line); } catch { continue; }
              const text = wireText(record);
              if (!text || !matches(text)) continue;
              hit.hits += 1;
              if (!hit.snippet) {
                const at = Math.max(0, text.toLowerCase().indexOf(terms[0]) - 60);
                hit.snippet = text.slice(at, at + 260).replace(/\s+/g, ' ');
              }
            }
          } catch { /* A session can disappear while its list refreshes. */ }
          hitCache.set(key, hit);
        }
        if (hit?.hits) { snippet = hit.snippet; hits += hit.hits; }
      }
      if (hits) result.push({ item: row, snippet, kind: 'message', hits, sources: ['words'] });
      if (result.length >= limit) break;
    }
    return result;
  }
  return { refresh, search, rows: () => rows, get: (id) => byId.get(id) || null, home, root };
}
