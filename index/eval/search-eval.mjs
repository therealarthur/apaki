#!/usr/bin/env node
/**
 * search-eval.mjs: how well latch-index finds sessions, on questions whose
 * answer is known. Prints, per question, where the expected session ranks
 * with the old keyword search and with words + meaning (hybrid), and the top
 * results for the open questions (no known answer) so they can be judged by
 * eye. Run after changing ranking:  node index/eval/search-eval.mjs
 *
 * The expected ids are Arthur's sessions on this PC (2026-10-09); edit CASES
 * when they are deleted. Nothing here writes anything.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLoader } from '../../src/ui/picker.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = path.join(root, 'index', 'target', 'release', process.platform === 'win32' ? 'latch-index.exe' : 'latch-index');

const CASES = [
  { q: 'the hook that sends my messages through claude -p and relays them', want: 'c6e7b179' },
  { q: 'walk detector ground truth drafter', want: 'a3995f97' },
  { q: 'audi r8 model for hytale', want: 'f3655a55' },
  { q: 'find the chat where we redesigned the myrlin jobs landing page to get more engagement', want: null },
  { q: 'i want to find a conversation/session that was involved in forge.myrlin.io, specifically the marketing and growth related sessions', want: null },
  { q: 'minecraft mod port to a newer version', want: null },
];

const items = await makeLoader()(true);
const titles = new Map(items.map((it) => [it.id, `${it.title} · ${String(it.cwd || '').replace(/^C:\\Users\\[^\\]+/i, '~')}`]));
const run = (args) => JSON.parse(execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim().split('\n').pop());
const rankOf = (list, want) => { const i = list.findIndex((s) => s.session.startsWith(want)); return i < 0 ? 'missing' : `#${i + 1}`; };

for (const c of CASES) {
  const words = c.q.split(/\s+/);
  const old = run(['search', ...words, '--limit', '40']);
  const hy = run(['hybrid', ...words]);
  console.log(`\n${c.q}`);
  console.log(`  terms ${JSON.stringify(hy.terms)} · ${hy.elapsed_ms} ms`);
  if (c.want) console.log(`  expected ${c.want}: old ${rankOf(old.sessions, c.want)}, hybrid ${rankOf(hy.sessions, c.want)}`);
  for (const s of hy.sessions.slice(0, c.want ? 3 : 8)) {
    const r = s.ranks || {};
    console.log(`   - ${(titles.get(s.session) || s.session).slice(0, 80)} [${s.sources.join('+')} w#${r.words ?? '-'}/${r.coverage ?? '-'} m#${r.meaning ?? '-'}]`);
  }
}
