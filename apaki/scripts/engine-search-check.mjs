#!/usr/bin/env node
/**
 * engine-search-check.mjs: drives a scratch Apaki engine (no window) through
 * the search ops and prints what the UI would get: the words + meaning search,
 * then Ask Claude (billed to the live login, about a cent), then the Dig
 * deeper prompt. Usage: node apaki/scripts/engine-search-check.mjs "<question>"
 * Opens no session and writes nothing except the index updates the engine
 * always runs.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const question = process.argv.slice(2).join(' ') || 'i want to find a conversation/session that was involved in forge.myrlin.io, specifically the marketing and growth related sessions';
const env = { ...process.env, LATCH_INDEX_BIN: path.join(root, 'index', 'target', 'release', 'latch-index.exe') };
delete env.PROMPT_RELAY_CHILD;
const engine = spawn(process.execPath, [path.join(root, 'apaki', 'engine', 'engine.js')], { cwd: root, env, stdio: ['pipe', 'pipe', 'ignore'] });
const sendOp = (o) => engine.stdin.write(`${JSON.stringify(o)}\n`);
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let step = 0;

readline.createInterface({ input: engine.stdout }).on('line', (line) => {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.ev === 'ready') { sendOp({ op: 'sessions', reqId: 's' }); return; }
  if (e.ev === 'sessions' && step === 0) {
    step = 1;
    // Give the index server a moment to load its query model.
    setTimeout(() => sendOp({ op: 'search', reqId: 'q1', query: question }), 2500);
    return;
  }
  if (e.ev === 'search' && step === 1) {
    step = 2;
    console.log(`[${at()}] words+meaning: ${e.results.length} sessions in ${e.elapsed} ms (semantic ${e.semantic}, terms ${JSON.stringify(e.terms)})`);
    for (const r of e.results.slice(0, 6)) console.log(`   - ${r.item.title.slice(0, 70)} [${(r.sources || []).join('+')}]`);
    sendOp({ op: 'askSearch', reqId: 'a1', query: question });
    return;
  }
  if (e.ev === 'askProgress') { console.log(`[${at()}] ${e.text}`); return; }
  if (e.ev === 'askSearch') {
    if (e.error) console.log(`[${at()}] Ask Claude failed: ${e.error}`);
    else {
      console.log(`[${at()}] Claude kept ${e.results.length} of ${e.considered} · ${e.model} on ${e.billing} · ${(e.ms / 1000).toFixed(1)} s · ${e.cost != null ? `$${e.cost.toFixed(4)}` : 'cost n/a'}`);
      console.log(`   searched: ${JSON.stringify(e.terms)}${e.note ? `\n   note: ${e.note}` : ''}`);
      for (const r of e.results) console.log(`   - ${r.item.title.slice(0, 60)} · ${r.item.id.slice(0, 13)}\n       ${r.why}`);
    }
    sendOp({ op: 'digPrompt', reqId: 'd1', query: question, candidates: [] });
    return;
  }
  if (e.ev === 'digReady') {
    console.log(`[${at()}] dig prompt (${e.prompt.length} chars):\n${e.prompt.split('\n').slice(0, 6).join('\n')}\n   …`);
    engine.stdin.end();
    setTimeout(() => process.exit(0), 1500);
  }
});
setTimeout(() => { console.log('timed out'); engine.kill(); process.exit(1); }, 180000);
