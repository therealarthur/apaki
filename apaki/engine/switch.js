/**
 * switch.js: a pane's conversation switching between Claude Code and Codex, and back.
 *
 * WHY (Arthur, 2026-10-11: "when limits are met, i can click a button that says switch to gpt, and gpt gets a diff of
 * the full transcript ... and then when i want to switch back, i can click a button to migrate/switch to claude code,
 * theres a diff of the transcripts again and then claude code can see not only evereything thats been done, but also
 * the prompts the user sent to the chatgpt controlled convo, the responses, the artifacts, literally everything";
 * 2026-10-12: "integrate the claude codex stuff"; design in apaki/remote/SWITCH.md): both native sessions stay alive
 * and are never translated into each other. A link joins Claude session X and Codex thread Y; each side has a
 * bookmark (a byte offset in the other side's file: how far it has been told), and each switch hands the side taking
 * over what came after its bookmark (handoff.js), with a git checkpoint (checkpoint.js).
 *
 *   Claude to Codex  the same pane becomes a Codex pane on the link's thread (started on the first switch, resumed
 *                    after), and the handoff goes into the thread with thread/inject_items: no turn starts, nothing is
 *                    billed until the person sends their next message. If the server refuses the injection, the
 *                    handoff rides in front of that next message instead.
 *   Codex to Claude  the pane goes back to the original Claude session (resumed through the Agent SDK on the next
 *                    message, as any restored pane), and the handoff rides in front of the person's next message:
 *                    Claude Code has no way to add to a session without a turn.
 * Nothing is sent by the switch itself. The links live in ~/.claude/latch/switch/<id>.json (Apaki's own folder).
 *
 * The pane shows one conversation across the switches (decorateHistory): the side it is on now, the other side's
 * turns read from the ledger, and a line at each switch; every message carries the agent that wrote it.
 *
 *   op switchAgent { paneId, to: 'codex' | 'claude' }  (PC only, like billing: remote-policy.js PC_ONLY_OPS)
 *   ev switching   { paneId, to }                      the switch started (the pane says so while it reads and snapshots)
 *   ev switched    { paneId, sessionId, linkId, from, to, n, injected, pending, checkpoint, counts, text }
 *   ev opened      gains switch: { from, to, linkId } when a switch opened it, and link: { ... } for a linked session
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffBetween, takeCheckpoint } from './checkpoint.js';
import { codexId, threadIdOf, toolResultOf, toolUseOf } from './codex-map.js';
import { AGENT, HANDOFF_END, buildPacket } from './handoff.js';
import { HANDOFF_MARK, codexRollout, isHandoff, readEvents, stripHandoff } from './ledger.js';

/** How much of the other side's file the pane's history reads (its newest part). */
const OTHER_SIDE_BYTES = 6 * 1024 * 1024;
/** The most of the other side's messages one history page shows. */
const OTHER_SIDE_MESSAGES = 240;
const RESULT_CHARS = 4000;

/** Claude's permission modes and the Codex app's presets, each to its nearest on the other side. */
export function codexModeFor(claudeMode) {
  return { bypassPermissions: 'full-access', acceptEdits: 'auto', default: 'auto', plan: 'read-only' }[claudeMode] || 'auto';
}
export function claudeModeFor(codexMode) {
  return { 'full-access': 'bypassPermissions', auto: 'acceptEdits', 'read-only': 'plan' }[codexMode] || 'default';
}

/* ---------- the links ---------- */

const WHY = `# switch

**What:** one small JSON file per conversation that moved between Claude Code and Codex in Myrlin Apaki (the
"Switch to Codex" and "Switch to Claude" actions): which Claude session and which Codex thread it joins, how far each
side has been told about the other (byte offsets), each switch with its git checkpoint ref, and a handoff waiting for
the next message.

**Made by:** Myrlin Apaki (apaki/engine/switch.js), 2026-10-12 onward.

**Safe to delete:** yes. The two conversations themselves stay in Claude Code's and Codex's own files; without these
files a later switch hands over the whole conversation again instead of only what is new, and a waiting handoff is
lost. The git snapshots are refs/apaki/handoff/<n> in each repository (\`git for-each-ref refs/apaki\`).
`;

/** The links on disk, cached, rewritten one file at a time (write then rename). */
export class LinkStore {
  constructor(dir) { this.dir = dir; this.cache = null; }

  load() {
    if (this.cache) return this.cache;
    this.cache = new Map();
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((f) => /^ln-[\w-]+\.json$/.test(f)); } catch { return this.cache; }
    for (const f of names) {
      try { const l = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); if (l?.id) this.cache.set(l.id, l); } catch { /* a broken file is left alone */ }
    }
    return this.cache;
  }

  get(id) { return id ? this.load().get(id) || null : null; }
  byClaude(sessionId) { if (!sessionId) return null; for (const l of this.load().values()) if (l.claude?.sessionId === sessionId) return l; return null; }
  byCodex(threadId) { if (!threadId) return null; for (const l of this.load().values()) if (l.codex?.threadId === threadId) return l; return null; }
  bySession(sessionId) { return String(sessionId || '').startsWith('codex:') ? this.byCodex(threadIdOf(sessionId)) : this.byClaude(sessionId); }

  save(link) {
    link.updated = new Date().toISOString();
    this.load().set(link.id, link);
    fs.mkdirSync(this.dir, { recursive: true });
    const why = path.join(this.dir, '_WHY_THIS_IS_HERE.md');
    if (!fs.existsSync(why)) { try { fs.writeFileSync(why, WHY); } catch { /* only a note */ } }
    const file = path.join(this.dir, `${link.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(link, null, 1));
    fs.renameSync(tmp, file);
    return link;
  }
}

export function newLink({ cwd = '', claude = null, codex = null } = {}) {
  return {
    id: `ln-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, created: new Date().toISOString(), cwd,
    // pending: a handoff per side still waiting for that side's next message ({ text, n, end }); its bookmark moves when it goes.
    claude, codex, active: null, switches: [], pending: { claude: null, codex: null },
    // seen.codex: how far into Claude's transcript Codex has been told; seen.claude: how far into Codex's rollout Claude has.
    seen: { codex: 0, claude: 0 },
  };
}

/** What a pane and a phone are told about a link (no file paths, no handoff text). */
export function linkView(link) {
  if (!link) return null;
  const last = link.switches.at(-1) || null;
  return {
    linkId: link.id, active: link.active, switches: link.switches.length,
    claude: link.claude?.sessionId || null, codex: link.codex?.threadId ? codexId(link.codex.threadId) : null,
    pending: ['claude', 'codex'].filter((s) => link.pending?.[s]), lastAt: last?.at || null,
  };
}

/* ---------- the other side's turns as pane messages ---------- */

const clipText = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n)}\n[... cut; the whole output is in the ledger]` : String(s || ''));

/**
 * Ledger events as the messages a pane's history draws (the shapes history.js and codex-map.js already give), each
 * tagged with its agent. Codex's exec calls give way to its command and patch items, as in the handoff.
 */
export function eventsToMessages(events, agent) {
  const list = Array.isArray(events) ? events : [];
  const hasItems = list.some((e) => e.kind === 'command' || e.kind === 'file_change');
  const exec = new Set(['exec', 'shell', 'exec_command', 'local_shell', 'shell_command', 'unified_exec', 'write_stdin', 'apply_patch']);
  const hidden = new Set();
  const out = [];
  const msg = (type, e, content) => ({ type, uuid: e.id, at: e.at, agent, message: { role: type, content } });
  for (const e of list) {
    switch (e.kind) {
      case 'prompt': if (e.text || e.images) out.push(msg('user', e, [...(e.text ? [{ type: 'text', text: e.text }] : []), ...Array.from({ length: e.images || 0 }, () => ({ type: 'image_marker' }))])); break;
      case 'reply': out.push(msg('assistant', e, [{ type: 'text', text: e.text }])); break;
      case 'reasoning': out.push(msg('assistant', e, [{ type: 'thinking', thinking: e.text }])); break;
      case 'tool_call': {
        if (hasItems && e.side === 'codex' && exec.has(e.tool)) { hidden.add(e.callId); break; }
        const name = e.side === 'codex' ? (e.tool.includes('.') ? `mcp__${e.tool.replace('.', '__')}` : e.tool) : e.tool;
        out.push(msg('assistant', e, [{ type: 'tool_use', id: e.callId || e.id, name, input: e.input && typeof e.input === 'object' ? e.input : { input: String(e.input ?? '') } }]));
        break;
      }
      case 'tool_result':
        if (hidden.has(e.callId)) break;
        out.push(msg('user', e, [{ type: 'tool_result', tool_use_id: e.callId, content: clipText(e.output, RESULT_CHARS), is_error: Boolean(e.isError) }]));
        break;
      case 'command': {
        const item = { type: 'commandExecution', id: e.callId || e.id, command: e.command, aggregatedOutput: clipText(e.output, RESULT_CHARS), exitCode: e.exitCode, status: e.exitCode != null && e.exitCode !== 0 ? 'failed' : 'completed' };
        out.push(msg('assistant', e, [toolUseOf(item)]));
        out.push({ ...msg('user', e, [toolResultOf(item)]), uuid: `${e.id}:r` });
        break;
      }
      case 'file_change': {
        const item = { type: 'fileChange', id: e.callId || e.id, status: 'completed', changes: (e.changes || []).map((c) => ({ path: c.path, kind: { type: c.type || 'update' }, diff: '' })) };
        out.push(msg('assistant', e, [toolUseOf(item)]));
        out.push({ ...msg('user', e, [toolResultOf(item)]), uuid: `${e.id}:r` });
        break;
      }
      case 'compaction':
        // Claude Code writes a boundary and then its summary: one marker for the pair.
        if (e.side === 'claude' && e.text) break;
        out.push({ type: 'compact', uuid: e.id, at: e.at, agent, trigger: 'auto', preTokens: 0, postTokens: 0, summary: null });
        break;
      default: break;
    }
  }
  return out;
}

/** The line a pane shows where a switch happened. */
export function switchNotice(sw) {
  const to = AGENT[sw.to] || sw.to;
  const from = AGENT[sw.from] || sw.from;
  const bits = [];
  if (sw.counts) bits.push(sw.counts.turns ? `${sw.counts.turns} turn${sw.counts.turns === 1 ? '' : 's'} from ${from}` : `nothing new from ${from}`);
  if (sw.checkpoint?.ref) bits.push(`code checkpoint ${sw.checkpoint.ref.replace('refs/apaki/handoff/', '#')}`);
  const how = sw.to === 'codex' ? (sw.injected ? 'it has read the handoff' : 'it reads the handoff with your next message') : 'it reads the handoff with your next message';
  return { type: 'notice', uuid: `switch-${sw.n}-${sw.at}`, at: sw.at, agent: null, switch: { n: sw.n, from: sw.from, to: sw.to }, notice: { text: `Switched to ${to}: ${how}${bits.length ? ` (${bits.join(', ')})` : ''}.`, tone: 'dim', label: 'Switch' } };
}

/** A history message with Apaki's handoff in it: only the person's words stay (the switch line says what was handed over). */
function stripMessage(m) {
  const c = m?.message?.content;
  if (m?.type !== 'user' || !c) return m;
  if (typeof c === 'string') return isHandoff(c) ? { ...m, message: { ...m.message, content: stripHandoff(c) } } : m;
  if (!Array.isArray(c) || !c.some((b) => b?.type === 'text' && isHandoff(b.text))) return m;
  return { ...m, message: { ...m.message, content: c.map((b) => (b?.type === 'text' && isHandoff(b.text) ? { ...b, text: stripHandoff(b.text) } : b)).filter((b) => b.type !== 'text' || b.text) } };
}

const timeOf = (m) => { const t = Date.parse(m?.at || ''); return Number.isFinite(t) ? t : null; };

/**
 * One history page for a linked conversation: this side's page with the handoffs taken out, the other side's messages
 * (newest part, only those not older than the page's first message when more pages wait above it), and a line per
 * switch, in time order. Every message carries agent: 'claude' | 'codex' (notices null).
 */
export function mergeHistory({ page, side, other = [], switches = [] }) {
  const own = (page.messages || []).map((m) => ({ ...stripMessage(m), agent: m.agent || side }));
  const firstAt = own.length ? timeOf(own[0]) : null;
  const keep = (m) => !page.hasMore || firstAt == null || (timeOf(m) != null && timeOf(m) >= firstAt);
  const extra = [...other.filter(keep).slice(-OTHER_SIDE_MESSAGES), ...switches.map(switchNotice).filter(keep)];
  if (!extra.length) return { ...page, messages: own };
  // A stable merge by time: messages without a time stay where their neighbours put them.
  const all = [...own.map((m, i) => ({ m, i, t: timeOf(m) })), ...extra.map((m, i) => ({ m, i: own.length + i, t: timeOf(m) }))];
  let last = 0;
  for (const x of all.slice(0, own.length)) { if (x.t == null) x.t = last; else last = x.t; }
  for (const x of all.slice(own.length)) if (x.t == null) x.t = last;
  all.sort((a, b) => a.t - b.t || a.i - b.i);
  return { ...page, messages: all.map((x) => x.m), total: (page.total || own.length) + extra.length, linked: true };
}

/* ---------- the switch ---------- */

/**
 * @param {object} env
 * @param {(ev: object) => void} env.emit
 * @param {object} env.codex                      codex-panes.js: isCodexPane, ensureThread, inject, rpc
 * @param {(reqId, paneId, sessionId, cwd, opts) => Promise} env.openPane   engine open()
 * @param {(p) => boolean} env.busy               a turn runs in the pane
 * @param {(p) => string} env.cwdOf               the pane's folder
 * @param {(sessionId) => (string|null)} env.claudeFile
 * @param {() => string[]} env.codexRoots         where rollouts are (codex-rollouts.js rolloutRoots)
 * @param {() => object} env.claudeDefaults       { model, effort, mode } for a Claude pane with no saved picks
 * @param {(sessionId) => object[]} [env.artifacts]  a session's artifacts (ArtifactStore.list)
 * @param {() => boolean} [env.codexFound]
 * @param {() => boolean} [env.ledgerTools]       the ledger tool server is offered to the agents
 * @param {string} env.dir                        where the links live
 * @param {(line: string) => void} [env.log]
 */
export function createSwitch(env) {
  const { emit, codex } = env;
  const log = env.log || (() => {});
  const links = new LinkStore(env.dir);
  const note = (p, text, tone = '') => emit({ ev: 'note', paneId: p.id, tone, text });

  /** The link a pane's conversation belongs to: the one it switched with, or the one its session is in. */
  function linkOf(p) {
    const byPane = links.get(p?.switchLink);
    if (byPane) return byPane;
    if (!p?.sessionId) return null;
    return links.bySession(p.sessionId);
  }

  /** A Codex thread's rollout file: the path the server reports, else the newest-first scan of the rollout folders. */
  async function rolloutOf(threadId) {
    try {
      const r = await codex.rpc('thread/read', { threadId, includeTurns: false });
      const f = r?.thread?.path;
      if (f && fs.existsSync(f)) return f;
    } catch { /* the scan below */ }
    return codexRollout(threadId, env.codexRoots?.() || []);
  }

  /** Artifacts the giving side showed since `since` (ms). */
  function artifactsSince(sessionId, since) {
    try {
      return (env.artifacts?.(sessionId) || []).filter((a) => (a.updatedAt || a.createdAt || 0) >= since).map((a) => ({ id: a.id, title: a.title, kind: a.kind, path: a.source || null }));
    } catch { return []; }
  }

  /** The snapshot and the diff since the link's last one (the last commit for the first). */
  async function snapshot(link, cwd, n, label) {
    const cp = await takeCheckpoint(cwd, { message: `Apaki handoff ${n}: ${label}` }).catch((e) => ({ ok: false, reason: e.message }));
    if (!cp.ok) return { cp: null, diff: null, note: cp.skipped ? 'the folder is not in a git repository' : `the git snapshot failed (${cp.reason})` };
    const prev = [...link.switches].reverse().find((s) => s.checkpoint?.root && s.checkpoint.root === cp.root)?.checkpoint || null;
    const diff = await diffBetween(cp.root, prev?.commit || cp.head, cp.commit, { baseHead: prev?.head || null, toHead: cp.head });
    return { cp, diff, prevRef: prev?.ref || null, note: null };
  }

  function finish(p, link, sw, packet) {
    if (!link.switches.includes(sw)) link.switches.push(sw);
    links.save(link);
    emit({ ev: 'switched', paneId: p.id, sessionId: p.sessionId || null, linkId: link.id, from: sw.from, to: sw.to, n: sw.n, injected: Boolean(sw.injected), pending: link.pending?.[sw.to] ? sw.to : null, checkpoint: sw.checkpoint?.ref || null, counts: sw.counts, text: switchNotice(sw).notice.text, link: linkView(link), chars: packet.text.length });
  }

  async function guarded(p, to, fn) {
    if (p.switching) { note(p, 'A switch is already under way here.'); return; }
    if (env.busy(p)) { note(p, `${p.kind === 'codex' ? 'Codex' : 'Claude'} is working here. Wait for this turn to end (or stop it), then switch.`, 'warn'); return; }
    p.switching = true;
    emit({ ev: 'switching', paneId: p.id, to });
    try { await fn(); } catch (e) {
      log(`switch to ${to}: ${e.stack || e.message}`);
      emit({ ev: 'error', paneId: p.id, message: `The switch to ${AGENT[to]} did not finish: ${e.message || e}` });
    } finally { p.switching = false; }
  }

  /** Claude to Codex. */
  async function toCodex(reqId, p) {
    if (codex.isCodexPane(p)) { note(p, 'This conversation is on Codex already.'); return; }
    if (env.codexFound && !env.codexFound()) { note(p, 'Codex is not installed on this PC (no codex command was found). Install it with npm install -g @openai/codex.', 'warn'); return; }
    await guarded(p, 'codex', async () => {
      const cwd = env.cwdOf(p) || os.homedir();
      const sessionId = p.sessionId || null;
      // A conversation with nothing in it yet simply becomes a Codex one.
      if (!sessionId) { await env.openPane(reqId, p.id, null, cwd, { kind: 'codex', mode: codexModeFor(p.mode), switch: { from: 'claude', to: 'codex', fresh: true } }); return; }
      const link = links.byClaude(sessionId) || newLink({ cwd, claude: { sessionId } });
      const n = link.switches.length + 1;
      const file = env.claudeFile(sessionId);
      const read = file ? await readEvents('claude', file, { from: link.seen.codex || 0 }) : { events: [], end: 0, skipped: 0, stats: { title: '' } };
      const since = link.switches.at(-1)?.at ? Date.parse(link.switches.at(-1).at) : 0;
      const snap = await snapshot(link, cwd, n, 'Claude to Codex');
      const first = !link.codex?.threadId;
      const packet = buildPacket({
        from: 'claude', to: 'codex', events: read.events, first, n, cwd, title: read.stats?.title || '', skipped: read.skipped,
        diff: snap.diff, checkpoint: snap.cp ? { ref: snap.cp.ref, prevRef: snap.prevRef, base: snap.prevRef ? null : 'HEAD' } : null, checkpointNote: snap.note,
        artifacts: artifactsSince(sessionId, since), delivery: 'inject', ledgerTools: Boolean(env.ledgerTools?.()),
      });
      // Claude's own picks come back with it.
      link.claude = { ...(link.claude || {}), sessionId, settings: { model: p.model, effort: p.effort, mode: p.mode } };
      link.cwd = cwd;
      // Known before the thread starts, so its developer instructions say it is a switched conversation.
      links.save(link);
      p.switchLink = link.id;
      const keepMode = link.codex?.settings?.mode || codexModeFor(p.mode);
      await env.openPane(reqId, p.id, link.codex?.threadId ? codexId(link.codex.threadId) : null, cwd, { kind: 'codex', mode: keepMode, model: link.codex?.settings?.model, effort: link.codex?.settings?.effort, switch: { from: 'claude', to: 'codex', linkId: link.id, n } });
      if (!codex.isCodexPane(p)) throw new Error('Codex did not open in this pane');
      await codex.ensureThread(p);
      const threadId = p.codex.threadId;
      let injected = false;
      try {
        await codex.inject(p, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: packet.text }] }]);
        injected = true;
      } catch (e) { log(`switch: thread/inject_items refused (${e.message}); the handoff goes with the next message`); }
      link.codex = { ...(link.codex || {}), threadId, file: (p.codex.path && fs.existsSync(p.codex.path) ? p.codex.path : null) || await rolloutOf(threadId) };
      // Injected: Codex has it in its thread now. Otherwise it waits for the next message, and the bookmark moves then.
      link.pending = { ...(link.pending || {}), codex: injected ? null : { text: packet.text, n, end: read.end } };
      if (injected) link.seen.codex = read.end;
      link.active = 'codex';
      finish(p, link, { n, at: new Date().toISOString(), from: 'claude', to: 'codex', injected, counts: packet.counts, checkpoint: snap.cp ? { ref: snap.cp.ref, commit: snap.cp.commit, head: snap.cp.head, root: snap.cp.root } : null }, packet);
    });
  }

  /** Codex back to Claude (or on to a new Claude session for a conversation that began in Codex). */
  async function toClaude(reqId, p) {
    if (!codex.isCodexPane(p)) { note(p, 'This conversation is on Claude already.'); return; }
    await guarded(p, 'claude', async () => {
      const cwd = p.codex?.cwd || env.cwdOf(p) || os.homedir();
      const threadId = p.codex?.threadId || null;
      const defaults = env.claudeDefaults();
      if (!threadId) { await env.openPane(reqId, p.id, null, cwd, { ...defaults, mode: claudeModeFor(p.mode), switch: { from: 'codex', to: 'claude', fresh: true } }); return; }
      const link = links.byCodex(threadId) || newLink({ cwd, codex: { threadId } });
      const n = link.switches.length + 1;
      const file = await rolloutOf(threadId);
      const read = file ? await readEvents('codex', file, { from: link.seen.claude || 0 }) : { events: [], end: 0, skipped: 0, stats: {} };
      const since = link.switches.at(-1)?.at ? Date.parse(link.switches.at(-1).at) : 0;
      const snap = await snapshot(link, cwd, n, 'Codex to Claude');
      const first = !link.claude?.sessionId;
      const packet = buildPacket({
        from: 'codex', to: 'claude', events: read.events, first, n, cwd, title: p.codexTitle || '', skipped: read.skipped,
        diff: snap.diff, checkpoint: snap.cp ? { ref: snap.cp.ref, prevRef: snap.prevRef, base: snap.prevRef ? null : 'HEAD' } : null, checkpointNote: snap.note,
        artifacts: artifactsSince(p.sessionId, since), delivery: 'prepend', ledgerTools: Boolean(env.ledgerTools?.()),
      });
      link.codex = { ...(link.codex || {}), threadId, file, settings: { model: p.model, effort: p.effort, mode: p.mode } };
      // It waits for the next message to Claude (built again from the same bookmark if another switch comes first).
      link.pending = { ...(link.pending || {}), claude: { text: packet.text, n, end: read.end } };
      link.cwd = cwd;
      link.active = 'claude';
      links.save(link);
      p.switchLink = link.id;
      const s = link.claude?.settings || {};
      // Recorded before the pane opens, so the history it sends already has this switch's line.
      const rec = { n, at: new Date().toISOString(), from: 'codex', to: 'claude', injected: false, counts: packet.counts, checkpoint: snap.cp ? { ref: snap.cp.ref, commit: snap.cp.commit, head: snap.cp.head, root: snap.cp.root } : null };
      link.switches.push(rec);
      links.save(link);
      await env.openPane(reqId, p.id, link.claude?.sessionId || null, cwd, {
        warm: false, model: s.model || defaults.model, effort: s.effort || defaults.effort, mode: s.mode || claudeModeFor(p.mode), switch: { from: 'codex', to: 'claude', linkId: link.id, n },
      });
      finish(p, link, rec, packet);
    });
  }

  /** op switchAgent. */
  async function switchPane(reqId, p, to) {
    if (to === 'codex') return toCodex(reqId, p);
    if (to === 'claude') return toClaude(reqId, p);
    note(p, 'Switch to what? Codex or Claude.', 'warn');
    return undefined;
  }

  /* ---------- the waiting handoff ---------- */

  /** The handoff waiting for this pane's next message on its current side, or null. */
  function pendingFor(p, side) {
    const link = linkOf(p);
    const pend = link?.pending?.[side];
    if (!pend) return null;
    // Only the conversation the link knows on that side (a pane that moved on to another session gets nothing).
    if (side === 'claude' && link.claude?.sessionId && p.sessionId && link.claude.sessionId !== p.sessionId) return null;
    if (side === 'codex' && p.codex?.threadId && link.codex?.threadId && link.codex.threadId !== p.codex.threadId) return null;
    return pend.text;
  }

  /** The waiting handoff went out with a message. */
  function delivered(p, side) {
    const link = linkOf(p);
    const pend = link?.pending?.[side];
    if (!pend) return;
    // The side has it now: its bookmark moves to where the handoff ended.
    if (side === 'claude') link.seen.claude = Math.max(link.seen.claude || 0, pend.end || 0);
    else link.seen.codex = Math.max(link.seen.codex || 0, pend.end || 0);
    link.pending = { ...link.pending, [side]: null };
    links.save(link);
  }

  /** A Claude session started in a pane that switched from a Codex-born conversation: the link learns it. */
  function claudeSessionStarted(p, sessionId) {
    const link = links.get(p.switchLink);
    if (!link || link.claude?.sessionId) return;
    link.claude = { ...(link.claude || {}), sessionId };
    links.save(link);
  }

  /** A Codex thread started for a pane on its link (the first switch from Claude): the link learns it. */
  function codexThreadStarted(p, threadId) {
    const link = links.get(p.switchLink);
    if (!link || link.codex?.threadId) return;
    link.codex = { ...(link.codex || {}), threadId };
    links.save(link);
  }

  /** The developer instructions a switched Codex thread gets on top of Apaki's own (env.parity adds the user's rules). */
  function codexInstructions(p) {
    const link = linkOf(p);
    if (!link) return '';
    return 'This conversation moves between Claude Code and you inside Myrlin Apaki: the user can switch it to Claude and back. When it does, a message starting with "[Apaki handoff]" tells the agent taking over what happened since it last saw the conversation; treat that as a record of earlier work, not as a new request. The apaki_ledger tool server holds the full record of both sides.';
  }

  /* ---------- the pane's one conversation ---------- */

  /** The other side's newest messages for a linked conversation, read from its file. */
  async function otherSide(link, side) {
    const other = side === 'claude' ? 'codex' : 'claude';
    let file = null;
    if (other === 'claude') file = link.claude?.sessionId ? env.claudeFile(link.claude.sessionId) : null;
    else file = link.codex?.file && fs.existsSync(link.codex.file) ? link.codex.file : (link.codex?.threadId ? codexRollout(link.codex.threadId, env.codexRoots?.() || []) : null);
    if (!file) return [];
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return []; }
    const r = await readEvents(other, file, { from: Math.max(0, size - OTHER_SIDE_BYTES), maxBytes: OTHER_SIDE_BYTES });
    return eventsToMessages(r.events, other);
  }

  /**
   * A history page for a pane (ev history or historyPage): for a linked conversation, the one view across switches
   * (mergeHistory) on a first page, the handoff text taken out of any page; anything else unchanged.
   */
  async function decorateHistory(p, sessionId, page, { first = true } = {}) {
    if (!page || !Array.isArray(page.messages)) return page;
    const side = String(sessionId || '').startsWith('codex:') ? 'codex' : 'claude';
    const link = links.bySession(sessionId) || (p ? links.get(p.switchLink) : null);
    if (!link) {
      // Never linked, but a handoff may still be in it (a link file deleted): only the person's words show.
      return page.messages.some((m) => m?.type === 'user' && JSON.stringify(m.message?.content || '').includes(HANDOFF_MARK)) ? { ...page, messages: page.messages.map(stripMessage) } : page;
    }
    if (!first) return { ...page, messages: page.messages.map((m) => ({ ...stripMessage(m), agent: m.agent || side })), link: linkView(link) };
    let other = [];
    try { other = await otherSide(link, side); } catch (e) { log(`switch history: ${e.message}`); }
    return { ...mergeHistory({ page, side, other, switches: link.switches }), link: linkView(link) };
  }

  /** What the window is told about a session's link (opened, sessions), or null. */
  function status(sessionId) { return linkView(links.bySession(sessionId)); }

  return { switchPane, toCodex, toClaude, pendingFor, delivered, claudeSessionStarted, codexThreadStarted, codexInstructions, decorateHistory, status, linkOf, links, HANDOFF_END };
}
