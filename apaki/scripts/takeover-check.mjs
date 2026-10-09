#!/usr/bin/env node
/**
 * takeover-check.mjs: the "Take over here" flow end to end, on a throwaway
 * session id (no real session is touched):
 *   1. a stand-in "latch terminal window" process takes the session lock;
 *   2. Apaki's lock attempt reports it as held;
 *   3. the relay hook lets that window's own prompts through;
 *   4. Apaki forces the takeover; the lock records who it was taken from;
 *   5. the hook now blocks that window (and an old window without
 *      LATCH_LOCK_PID), and the old holder's lockStolen() sees the new owner.
 * Uses the real lock folder (~/.claude/latch/locks) and the real hook
 * (~/.claude/hooks/prompt-relay.js); removes its lock file at the end.
 */

import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockInfo, lockStolen, releaseLock, setLockApp, takeLock } from '../../src/sessions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sid = `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
const hook = path.join(os.homedir(), '.claude', 'hooks', 'prompt-relay.js');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

// 1. The stand-in terminal latch: takes the lock as "latch-relay" and waits.
const holderCode = `import(${JSON.stringify(`file:///${path.join(root, 'src', 'sessions.js').replace(/\\/g, '/')}`)}).then((s) => { s.setLockApp('latch-relay'); console.log(s.takeLock(${JSON.stringify(sid)}) === null ? 'held' : 'refused'); setTimeout(() => {}, 120000); });`;
const holder = spawn(process.execPath, ['-e', holderCode], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => holder.stdout.once('data', r));

// The hook must never relay this test prompt: a scratch relay state folder
// (relay off), and none of the relay switches a latch window passes on. The
// first version of this check inherited PROMPT_RELAY_FORCE from the window it
// ran in and relayed "hello there" for real (2026-10-09).
const relayState = path.join(os.tmpdir(), `apaki-takeover-relay-${process.pid}`);
const runHook = (env) => {
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sid, transcript_path: '', cwd: os.homedir(), prompt: 'hello there' });
  const e = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ATTENDED: '1', PROMPT_RELAY_STATE_DIR: relayState, PROMPT_RELAY_LIVE_LOGIN_FILE: path.join(relayState, 'no-login.json'), ...env };
  for (const k of ['PROMPT_RELAY_CHILD', 'PROMPT_RELAY_FORCE', 'PROMPT_RELAY_KEY_WORDS', 'ANTHROPIC_API_KEY']) delete e[k];
  if (!env.LATCH_LOCK_PID) delete e.LATCH_LOCK_PID;
  const r = spawnSync(process.execPath, [hook], { input, env: e, encoding: 'utf8' });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
};

try {
  setLockApp('apaki');
  // 2. Held by the terminal latch.
  const held = takeLock(sid);
  check('Apaki sees the session as held', held === holder.pid, `holder pid ${held}`);
  check('the lock names a terminal window', lockInfo(sid)?.app === 'latch-relay' && lockInfo(sid)?.alive === true);

  // 3. The window's own prompts pass.
  const own = runHook({ LATCH_LOCK_PID: String(holder.pid) });
  check('the holding window can still type', own.decision !== 'block', own.reason ? own.reason.split('\n')[0] : '');

  // 4. Force the takeover.
  check('forced takeover succeeds', takeLock(sid, { force: true }) === null);
  const after = lockInfo(sid);
  check('the lock records who it was taken from', after?.app === 'apaki' && after?.takenFrom?.pid === holder.pid && after?.takenFrom?.app === 'latch-relay');

  // 5. The old window is blocked, an old-style window too, and the old holder knows.
  const blocked = runHook({ LATCH_LOCK_PID: String(holder.pid) });
  check('the old window is blocked', blocked.decision === 'block' && /Myrlin Apaki took this session over/.test(blocked.reason || ''), (blocked.reason || '').split('\n')[0]);
  const oldStyle = runHook({});
  check('a window latch did not open is blocked too', oldStyle.decision === 'block');
  check('the old holder sees it lost the session', lockStolen(sid, holder.pid)?.pid === process.pid);
  check('the new holder still owns it', lockStolen(sid) === null);
} finally {
  holder.kill();
  releaseLock(sid);
  (await import('node:fs')).rmSync(relayState, { recursive: true, force: true });
}
check('lock file removed', lockInfo(sid) === null);
process.exit(results.every((r) => r.ok) ? 0 : 1);
