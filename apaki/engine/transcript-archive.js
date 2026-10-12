/**
 * transcript-archive.js: keeps every Claude Code conversation past Claude Code's own cleanup.
 *
 * WHY (2026-10-11/12): Claude Code deletes transcripts 30 days after they last changed (its cleanupPeriodDays
 * setting, default 30); Arthur's oldest left were from 2026-09-13, so older chats were already gone ("i feel like
 * we missed cahts - how could we have?"). Raising that setting would keep everything on C:, where 30 days alone
 * took 18 GB with 42 GB free. He chose "do what you think is best"; the recommendation was a slim archive on D:
 * that Apaki keeps on its own, without touching Claude Code's settings.
 *
 * What it writes: for each transcript under <claude config>/projects (subagent transcripts included), a gzip of a
 * slim copy at <archive>/claude/<same relative path>.gz. Slim means every line is kept, with image data replaced
 * by a short marker (images are most of the bytes); text, tool calls and tool results stay whole. A manifest
 * (<archive>/manifest.json) remembers each source's size and modified time, so a run only copies what changed.
 * Never deletes anything, in the archive or in Claude Code's folder.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/** Where the archive lives: APAKI_ARCHIVE_DIR, else D:\apaki-archive when a D: drive exists, else ~/.claude/latch/archive. */
export function archiveRoot(env = process.env) {
  if (env.APAKI_ARCHIVE_DIR) return env.APAKI_ARCHIVE_DIR;
  if (process.platform === 'win32' && fs.existsSync('D:\\')) return 'D:\\apaki-archive';
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'latch', 'archive');
}

/** Claude Code's projects folder (CLAUDE_CONFIG_DIR moves it). */
export function projectsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

const IMAGE_MARK = '[image kept out of the archive copy]';

/** One content block with any image data replaced by a marker (recursing into tool results). */
function slimBlock(b) {
  if (!b || typeof b !== 'object') return b;
  if (b.type === 'image' && b.source && typeof b.source === 'object' && typeof b.source.data === 'string') {
    return { ...b, source: { ...b.source, data: IMAGE_MARK, archivedBytes: b.source.data.length } };
  }
  if (Array.isArray(b.content)) return { ...b, content: b.content.map(slimBlock) };
  return b;
}

/** One transcript line, slim: images out, everything else as it was. Lines that are not JSON pass unchanged. */
export function slimLine(line) {
  if (!line.includes('"image"') || !line.includes('"data"')) return line;
  let j;
  try { j = JSON.parse(line); } catch { return line; }
  const c = j?.message?.content;
  if (Array.isArray(c)) j.message.content = c.map(slimBlock);
  if (j?.toolUseResult && typeof j.toolUseResult === 'object' && Array.isArray(j.toolUseResult.content)) j.toolUseResult.content = j.toolUseResult.content.map(slimBlock);
  return JSON.stringify(j);
}

/** Every .jsonl under dir, as paths relative to it. */
function transcripts(dir) {
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

function readManifest(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); } catch { return { v: 1, files: {} }; }
}

function writeManifest(root, m) {
  const file = path.join(root, 'manifest.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m));
  fs.renameSync(tmp, file);
}

/** Copies one transcript to its slim gzip, through a temp file, so a crash never leaves half an archive copy. */
async function archiveOne(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  const rl = readline.createInterface({ input: fs.createReadStream(src, { encoding: 'utf8' }), crlfDelay: Infinity });
  async function* lines() { for await (const line of rl) yield `${slimLine(line)}\n`; }
  await pipeline(Readable.from(lines()), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return fs.statSync(dest).size;
}

/**
 * Archives what is new or changed since the last run. Returns { copied, skipped, failed, bytesIn, bytesOut }.
 * log(line) is told about failures; a failed file is tried again next run.
 */
export async function archiveTranscripts({ from = projectsDir(), root = archiveRoot(), log = () => {} } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const m = readManifest(root);
  m.files ||= {};
  const res = { copied: 0, skipped: 0, failed: 0, bytesIn: 0, bytesOut: 0 };
  let since = 0;
  for (const rel of transcripts(from)) {
    const src = path.join(from, rel);
    let st;
    try { st = fs.statSync(src); } catch { continue; }
    const key = rel.split(path.sep).join('/');
    const had = m.files[key];
    if (had && had.size === st.size && had.mtimeMs === Math.floor(st.mtimeMs)) { res.skipped += 1; continue; }
    try {
      const gz = await archiveOne(src, path.join(root, 'claude', `${rel}.gz`));
      m.files[key] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs), gz, at: new Date().toISOString() };
      res.copied += 1; res.bytesIn += st.size; res.bytesOut += gz;
      since += 1;
      if (since >= 25) { writeManifest(root, m); since = 0; }
    } catch (e) {
      res.failed += 1;
      log(`archive: ${key}: ${e.message || e}`);
    }
  }
  m.lastRun = new Date().toISOString();
  writeManifest(root, m);
  return res;
}
