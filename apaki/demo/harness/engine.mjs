/**
 * engine.mjs: a pretend of Apaki's engine (apaki/engine/engine.js) for the
 * demo harness. It answers the ops the window sends through
 * invoke('engine_send', { msg }) and emits events shaped like the real
 * engine's, from the invented dataset in data.mjs and the scripted turns in
 * turns.mjs. Nothing here touches the machine it runs on.
 *
 * createEngine({ send, browser, preset }) returns
 *   handle(msg)   one window op (sessions, open, send, steer, glassSwap, remote*...)
 *   boot()        the events a fresh engine sends once the window listens
 *   control       what the scene runner drives from outside (window.__demo):
 *                 phoneScan, autoTurn, state
 *
 * `send(ev)` delivers one event to the window (asynchronously).
 */

import {
  buildSessions, buildFolders, buildHistory, buildGlass, buildSubagents, buildAgentLines, handoffMessages,
  CONTEXT, CONTEXT_USED, COMMANDS, PRESETS, ID, DAY, HOUR, MIN,
} from './data.mjs';
import { Turn, TurnAborted, SCRIPTS } from './turns.mjs';
// Codex panes (2026-10-12): the ops a Codex pane sends, answered from invented data.
import { createCodexDemo } from './codex.mjs';
// Git worktrees (2026-10-12): the pretend of the engine's worktree ops, on invented repositories.
import { createWorktrees } from './worktrees.mjs';

const MODEL = 'claude-opus-5-5';
const PAIR_URL = 'https://apaki.myrlin.io/pair#v1.q7T2mK9xRw4LbN8cHf3Yp6Ds5GjV1eAu';

/** What the meaning index "knows": snippets for a few sessions, for search results. */
const SNIPPETS = {
  [ID.flaky]: { kind: 'reply', text: 'The test clicks Pay now, then asserts on the payment confirmation before the order id exists, so it fails about one run in five on a slow runner.', hits: 3 },
  [ID.backfill]: { kind: 'prompt', text: 'Some invoices have no PDF since the renderer was failing for two weeks. Backfill them without hitting the payment provider again.', hits: 2 },
  [ID.invoices]: { kind: 'reply', text: 'Tax is now calculated per invoice by the new API, not per payment line, so totals can differ by a cent on old fixtures.', hits: 1 },
  [ID.uploads]: { kind: 'reply', text: 'Uploads over 25 MB are refused before a URL is signed. The old endpoint stays for the mobile app until 4.2.', hits: 1 },
};

/** Words a person types that the meaning index ties to a session ("meaning" matches). */
const MEANING = [
  { words: ['payment', 'pay', 'checkout', 'confirmation', 'randomly', 'intermittent', 'flaky', 'failing'], ids: [ID.flaky, ID.backfill, ID.invoices] },
  { words: ['upload', 'photo', 'image', 'bucket', 'signed'], ids: [ID.uploads] },
  { words: ['dark', 'theme', 'settings'], ids: [ID.darkmode] },
  { words: ['terraform', 'vpc', 'network', 'staging'], ids: [ID.vpc, ID.creds] },
];

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'was', 'were', 'find', 'about', 'when', 'what', 'from', 'where']);
const tokens = (q) => String(q).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

export function createEngine({ send, browser, preset = 'base', now = () => Date.now() }) {
  const NOW = now();
  const iso = (ms) => new Date(ms).toISOString();
  let idSeq = 0;
  const nextId = (prefix) => `${prefix}_demo_${String(++idSeq).padStart(3, '0')}`;

  let sessions = buildSessions(NOW);
  let folders = buildFolders(NOW);
  const start = (PRESETS[preset] || PRESETS.base)();
  const worktrees = createWorktrees({ emit: (ev) => send(ev), later: (ms, ev) => setTimeout(() => send(ev), ms), now, enabled: Boolean(start.worktrees) });
  // The worktrees preset moves a few conversations into worktrees of the invented repositories.
  if (start.worktrees) sessions = worktrees.remap(sessions, ID);
  const scripts = new Map(Object.entries(start.scripts || {}).map(([k, v]) => [k, [...v]]));
  const sends = new Map(); // session id -> messages sent so far (picks the next script)
  const panes = new Map(); // pane id -> { id, sessionId, cwd, turn, ctxAdd }
  const agents = new Map(); // tool use id -> a live subagent, for its viewer
  let glass = buildGlass(NOW);
  let listening = false;

  const later = (ms, ev) => setTimeout(() => send(ev), ms);
  const emit = (ev) => send(ev);
  const codexDemo = createCodexDemo({ emit, later, nextId, sessions, panes, now });

  /* billing, Glass */

  const liveClaude = () => glass.claude.find((a) => a.active);
  const billing = () => {
    const a = liveClaude();
    return a.isKey ? { name: a.name, source: 'key', follow: true, isKey: true } : { name: `${a.name} (${a.plan})`, source: 'oauth', follow: true, isKey: false };
  };

  function glassEvent(changed = false) {
    const live = liveClaude();
    return {
      ev: 'glass', installed: true, name: billing().name, source: billing().source, plan: live.plan, headroom: live.headroom, changed, isKey: live.isKey,
      claude: live, codex: glass.codex.find((a) => a.active) || null, lists: { claude: glass.claude, codex: glass.codex },
      mode: { lite: false, swapsEnabled: true, swapsReason: null, signInReason: null, note: null },
    };
  }

  function glassSwap(c) {
    const list = c.provider === 'codex' ? glass.codex : glass.claude;
    const target = list.find((a) => a.id === c.account);
    if (!target) { later(300, { ev: 'glass_swap', provider: c.provider, ok: false, message: 'Glass does not know that account.' }); return; }
    // Glass takes a moment to swap the login, then every pane that follows it shows the new billing.
    setTimeout(() => {
      for (const a of list) a.active = a.id === target.id;
      const b = billing();
      if (c.provider !== 'codex') {
        for (const p of panes.values()) emit({ ev: 'billing', paneId: p.id, ...b, note: `Myrlin Glass switched Claude to ${b.name}; the next message here uses it.` });
      }
      emit(glassEvent(true));
      emit({ ev: 'glass_swap', provider: c.provider === 'codex' ? 'codex' : 'claude', ok: true, message: `${target.name} is live.` });
    }, 1300);
  }

  /* sessions */

  const sessionList = () => sessions.slice().sort((x, y) => y.lastModified - x.lastModified).map((s) => ({ ...s }));
  const sendSessions = (reqId = null, delay = 60) => later(delay, { ev: 'sessions', reqId, items: sessionList(), folders, billing: billing(), voice: false });

  function terminalsEvent() {
    const terminals = {};
    for (const s of sessions) if (s.terminal) terminals[s.id] = { name: s.terminal.name, status: s.terminal.status, pid: s.terminal.pid, cwd: s.cwd, updatedAt: s.lastModified };
    return { ev: 'terminals', terminals };
  }

  /*
   * Sessions held in another window of the engine (2026-10-12, the handoff): on the phone, the desktop holds
   * "Fix flaky checkout test", so opening it there answers locked with Take over here, and a forced open takes
   * it (opened with tookOver), as engine.js open does. On the desktop, a session a phone took keeps growing in
   * its transcript (grown: how many handoff messages are written), and its pane follows with historyCheck.
   */
  const held = new Map(Object.entries(start.held || {}));
  const grown = new Map();
  const revOf = (sessionId) => `r${grown.get(sessionId) || 0}`;
  const historyOf = (sessionId) => {
    const h = buildHistory(sessionId, NOW);
    const more = grown.get(sessionId) ? handoffMessages(now(), grown.get(sessionId)) : [];
    return { ...h, messages: [...h.messages, ...more] };
  };

  function openPane(c, attached = false) {
    const s = sessions.find((x) => x.id === c.sessionId) || null;
    if (s && held.has(s.id) && !c.force && !attached) {
      const h = held.get(s.id);
      later(60, { ev: 'locked', reqId: c.reqId, paneId: c.paneId, sessionId: s.id, holder: { name: h.name, app: h.app || 'apaki', at: new Date(now() - 4 * MIN).toISOString(), alive: true }, title: s.title, cwd: s.cwd });
      return;
    }
    const tookOver = Boolean(s && held.has(s.id) && c.force);
    if (tookOver) held.delete(s.id);
    const pane = panes.get(c.paneId) || { id: c.paneId, ctxAdd: 0, turn: null };
    pane.sessionId = s?.id || null;
    pane.cwd = s?.cwd || c.cwd || '';
    panes.set(pane.id, pane);
    later(50, {
      ev: 'opened', reqId: c.reqId, paneId: pane.id, sessionId: pane.sessionId, cwd: pane.cwd, title: s?.title || 'New conversation',
      model: c.model || MODEL, effort: c.effort || 'high', mode: c.mode || 'acceptEdits', billing: billing(), terminal: [],
      ...(attached ? { attached: true, busy: Boolean(pane.turn) } : {}),
      ...(tookOver ? { tookOver: true } : {}),
    });
    if (!s) return;
    const h = historyOf(s.id);
    if (h.earlier) {
      later(120, { ev: 'history', paneId: pane.id, sessionId: s.id, messages: h.messages, total: h.total, source: 'transcript', first: h.earlierCount, hasMore: true, earlier: h.earlierCount, rev: revOf(s.id) });
    } else {
      later(120, { ev: 'history', paneId: pane.id, sessionId: s.id, messages: h.messages, total: h.messages.length, rev: revOf(s.id) });
    }
  }

  /** historyCheck { paneId, sessionId, rev }: the transcript moved on, so the conversation comes again (refresh). */
  function historyCheck(c) {
    const rev = revOf(c.sessionId);
    // A pane that has no revision yet is still waiting for the history its open sent: nothing to refresh.
    const fresh = Boolean(c.sessionId) && Boolean(c.rev) && c.rev !== rev;
    if (fresh) {
      const h = historyOf(c.sessionId);
      const paging = h.earlier ? { total: h.total, source: 'transcript', first: h.earlierCount, hasMore: true, earlier: h.earlierCount } : { total: h.messages.length };
      later(80, { ev: 'history', paneId: c.paneId, sessionId: c.sessionId, messages: h.messages, ...paging, rev, refresh: true });
    }
    later(fresh ? 100 : 40, { ev: 'historyChecked', reqId: c.reqId || null, paneId: c.paneId || null, fresh });
  }

  function contextEvent(pane, reqId = null) {
    if (!pane.sessionId && !pane.turn) return { ev: 'context', reqId, paneId: pane.id, none: true };
    const base = CONTEXT[pane.sessionId] || { percentage: 18, totalTokens: 36_000 };
    const pct = Math.min(96, base.percentage + (pane.ctxAdd || 0));
    return {
      ev: 'context', reqId, paneId: pane.id, sessionId: pane.sessionId, percentage: pct, totalTokens: Math.round(pct * 2000), maxTokens: 200_000, autoCompact: 92, model: MODEL, used: CONTEXT_USED,
    };
  }

  /* turns */

  const host = {
    emit,
    nextId,
    browser,
    /** The task tool registers its subagent so the viewer opened from its tool line can show what it did. */
    registerAgent(toolUseId, spec) { agents.set(toolUseId, spec); },
    contextSoon(paneId, fraction = 0.03) {
      const p = panes.get(paneId);
      if (!p) return;
      p.ctxAdd = (p.ctxAdd || 0) + Math.round(fraction * 100);
      later(260, contextEvent(p));
    },
  };

  /** Picks the script for a session's next turn: its own list in order, then the generic one. */
  function scriptFor(sessionId) {
    const n = sends.get(sessionId) || 0;
    sends.set(sessionId, n + 1);
    return (scripts.get(sessionId) || [])[n] || 'generic';
  }

  async function runTurn(pane, name, text, auto = false) {
    const t = new Turn(host, { paneId: pane.id, sessionId: pane.sessionId, text, auto });
    pane.turn = t;
    try {
      await (SCRIPTS[name] || SCRIPTS.generic)(t);
    } catch (e) {
      if (e instanceof TurnAborted) emit({ ev: 'result', paneId: pane.id, subtype: 'interrupted', durationMs: 0, usage: {}, cost: null });
      else console.error('demo turn failed', name, e);
    } finally {
      if (pane.turn === t) pane.turn = null;
    }
  }

  function send_(c) {
    const pane = panes.get(c.paneId);
    if (!pane) return;
    if (!pane.sessionId) {
      // A new conversation: the first message makes its session, named from the message.
      const id = nextId('session').replace('_demo_', '-demo-');
      pane.sessionId = id;
      sessions.unshift({ id, title: String(c.text || 'New conversation').slice(0, 60), firstPrompt: c.text || '', cwd: pane.cwd || 'C:\\Users\\dev', branch: 'main', lastModified: now(), size: 1000, codex: false, terminal: null, folder: null, headless: false, bare: false, warm: false, subagents: 0, archived: false, running: true });
      emit({ ev: 'session_id', paneId: pane.id, sessionId: id });
      sendSessions(null, 200);
    }
    runTurn(pane, scriptFor(pane.sessionId), c.text || '');
  }

  /* search */

  function search(c) {
    const terms = tokens(c.query);
    const hit = new Map();
    for (const m of MEANING) {
      if (!terms.some((t) => m.words.includes(t))) continue;
      m.ids.forEach((id, i) => hit.set(id, Math.max(hit.get(id) || 0, 10 - i)));
    }
    for (const s of sessions) {
      const hay = `${s.title} ${s.firstPrompt}`.toLowerCase();
      const n = terms.filter((t) => hay.includes(t)).length;
      if (n) hit.set(s.id, (hit.get(s.id) || 0) + n * 4);
    }
    const results = [...hit.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => {
      const item = sessions.find((s) => s.id === id);
      const sn = SNIPPETS[id];
      const byWords = terms.some((t) => `${item.title} ${item.firstPrompt}`.toLowerCase().includes(t));
      return { item: { ...item }, kind: sn?.kind || null, snippet: sn?.text || '', hits: sn?.hits || 0, sources: byWords ? ['words', 'meaning'] : ['meaning'] };
    }).filter((r) => r.item);
    later(140, { ev: 'search', reqId: c.reqId, query: c.query, elapsed: 38, deep: true, semantic: true, terms, results });
  }

  function askSearch(c) {
    const terms = tokens(c.query);
    const why = {
      [ID.flaky]: 'Finds the race: the confirmation banner shows before the order id arrives, which is the intermittent checkout failure.',
      [ID.backfill]: 'Related failure on the same payment flow, but about missing invoice PDFs, not the checkout page.',
    };
    const results = [ID.flaky, ID.backfill].map((id) => {
      const item = sessions.find((s) => s.id === id);
      const sn = SNIPPETS[id];
      return { item: { ...item }, kind: sn?.kind || 'reply', snippet: sn?.text || '', hits: sn?.hits || 1, why: why[id], sources: ['meaning'] };
    });
    later(0, { ev: 'askProgress', query: c.query, text: 'Claude is reading your question…' });
    later(900, { ev: 'askProgress', query: c.query, text: 'Searching: checkout confirmation, flaky end to end test, race condition' });
    later(1800, { ev: 'askProgress', query: c.query, text: 'Reading the 8 best matches…' });
    later(2800, { ev: 'askSearch', query: c.query, results, considered: 24, model: 'Haiku 5.5', billing: billing().name, ms: 2810, cost: 0.004, terms, note: 'Searched for: checkout confirmation · flaky end to end test · race condition' });
  }

  /* phone access */

  const remote = {
    enabled: true, state: 'online', error: null, retryInMs: null, relay: 'apaki.myrlin.io', relayConfigured: true, web: 'https://apaki.myrlin.io/',
    page: { state: 'ok', version: '0.9.4', url: 'https://apaki.myrlin.io/', at: iso(NOW - 12 * MIN), text: 'The phone page is the published build (0.9.4), checked 10:30 AM.', canSkip: false },
    pcName: 'Studio PC', protection: 'dpapi', keysProblem: null, recovered: false, lifetimes: [30, 7, 1], mode: 'connected', caps: ['full', 'noshell', 'chat'], pageAlarm: null, lastRecheck: iso(NOW - 12 * MIN),
    devices: [
      { id: 'dev-1', name: "Sam's iPhone 15", pairedAt: iso(NOW - 12 * DAY), lastSeen: iso(NOW - 2 * HOUR), expiresAt: null, connected: false, panes: 0, cap: 'full' },
      { id: 'dev-2', name: 'Pixel 9 Pro', pairedAt: iso(NOW - 30 * DAY), lastSeen: iso(NOW - 3 * DAY), expiresAt: iso(NOW + 4 * DAY), connected: false, panes: 0, cap: 'noshell' },
    ],
    pairing: null, request: null, linkRequest: null, phoneRequest: null, notices: [],
  };
  let pairTimer = null;
  const remoteEvent = (extra = {}) => ({ ev: 'remote', ...JSON.parse(JSON.stringify(remote)), ...extra });

  function remoteOp(c) {
    switch (c.op) {
      case 'remoteStatus': break;
      case 'remoteEnable': remote.enabled = true; remote.state = 'online'; break;
      case 'remoteDisable': remote.enabled = false; remote.state = 'off'; remote.pairing = null; remote.request = null; break;
      case 'remotePairStart':
        remote.request = null;
        remote.pairing = { url: PAIR_URL, exp: Math.floor(now() / 1000) + 120, unchecked: Boolean(c.unchecked) };
        clearTimeout(pairTimer);
        pairTimer = setTimeout(() => { remote.pairing = null; emit(remoteEvent()); }, 120_000);
        break;
      case 'remotePairCancel': clearTimeout(pairTimer); remote.pairing = null; remote.request = null; break;
      case 'remotePairDecision': {
        const req = remote.request;
        remote.request = null;
        if (!c.approve || !req) break;
        remote.devices.push({ id: req.id, name: req.name, pairedAt: iso(now()), lastSeen: iso(now()), expiresAt: c.lifetime ? iso(now() + c.lifetime * DAY) : null, connected: true, panes: 1, cap: c.cap || 'full' });
        emit(remoteEvent({ paired: { name: req.name } }));
        return;
      }
      case 'remoteRevoke': remote.devices = remote.devices.filter((d) => d.id !== c.deviceId); break;
      case 'remoteMode': remote.mode = c.mode === 'private' ? 'private' : 'connected'; break;
      case 'remoteDeviceCap': { const d = remote.devices.find((x) => x.id === c.deviceId); if (d) d.cap = c.cap; break; }
      case 'remoteDeviceLifetime': { const d = remote.devices.find((x) => x.id === c.deviceId); if (d) d.expiresAt = c.lifetime ? iso(now() + c.lifetime * DAY) : null; break; }
      case 'remoteNoticeDismiss': remote.notices = remote.notices.filter((n) => n.id !== c.id); break;
      default: break;
    }
    emit(remoteEvent());
  }

  /* the ops */

  function handle(c) {
    if (!c || typeof c.op !== 'string') return;
    if (c.op.startsWith('remote')) { remoteOp(c); return; }
    const pane = panes.get(c.paneId);
    // A Codex pane's ops (and the two only Codex has) are answered there; the workspace starts with Codex only in the codex preset.
    if (codexDemo.handle(c, pane)) return;
    if (worktrees.handle(c)) return;
    switch (c.op) {
      case 'sessions': sendSessions(c.reqId); break;
      case 'loadState': later(10, { ev: 'state', state: { v: 1, savedAt: now() + 5000, active: start.active || 0, tabs: start.tabs, rail: start.rail, win: null } }); break;
      case 'saveState': break;
      case 'open': openPane(c); break;
      case 'attach': openPane(c, true); break;
      case 'close': pane?.turn?.abort(); panes.delete(c.paneId); later(20, { ev: 'closed', paneId: c.paneId }); break;
      case 'commands': later(40, { ev: 'commands', reqId: c.reqId, paneId: c.paneId, commands: COMMANDS }); break;
      case 'contextUsage': if (pane) later(120, contextEvent(pane, c.reqId)); break;
      case 'send': send_(c); break;
      case 'steer': if (pane?.turn) pane.turn.steers.push({ qid: c.qid, text: c.text }); else later(40, { ev: 'steer_missed', paneId: c.paneId, qid: c.qid }); break;
      case 'queueSet': break;
      case 'interrupt': pane?.turn?.abort(); break;
      case 'model': later(30, { ev: 'settings', paneId: c.paneId, model: c.model }); break;
      case 'effort': later(30, { ev: 'settings', paneId: c.paneId, effort: c.effort }); break;
      case 'mode': later(30, { ev: 'settings', paneId: c.paneId, mode: c.mode }); break;
      case 'historyBefore': {
        const h = buildHistory(c.sessionId, NOW);
        later(450, { ev: 'historyPage', paneId: c.paneId, sessionId: c.sessionId, before: c.before, first: 0, hasMore: false, earlier: 0, total: h.total || 0, messages: h.earlier || [] });
        break;
      }
      case 'historyCheck': historyCheck(c); break;
      case 'search': search(c); break;
      case 'askSearch': askSearch(c); break;
      case 'glass': later(80, glassEvent(false)); break;
      case 'glassSwap': glassSwap(c); break;
      case 'glassRename': case 'glassHide': case 'glassLogin': case 'glassApiAdd': case 'glassApiRemove':
        later(300, { ev: 'glass_op', reqId: c.reqId, op: c.op, provider: c.provider || 'claude', ok: true, message: 'Done.' });
        break;
      case 'warmState': later(60, { ev: 'warmState', reqId: c.reqId, on: true, hours: 24, dailyCapUsd: 5, spentToday: 0.42, sessions: 2, keeper: true, ttl: '1h', verdict: null }); break;
      case 'autoCompact': later(60, { ev: 'autoCompact', reqId: c.reqId, value: 'off', choices: ['off', 200000, 300000, 500000, 'default'], standard: 967000 }); break;
      case 'subagents': later(180, { ev: 'subagents', reqId: c.reqId, sessionId: c.sessionId, ...buildSubagents(c.sessionId, NOW) }); break;
      case 'agentWatch': agentWatch(c); break;
      case 'outputWatch': later(60, { ev: 'outputText', paneId: c.paneId, missing: true }); break;
      case 'rename': {
        const s = sessions.find((x) => x.id === c.sessionId);
        if (s) s.title = c.title;
        later(60, { ev: 'renamed', reqId: c.reqId, ok: true, sessionId: c.sessionId, title: c.title, paneId: c.paneId });
        break;
      }
      case 'archive': { const s = sessions.find((x) => x.id === c.sessionId); if (s) s.archived = Boolean(c.archived); sendSessions(); break; }
      case 'folder': folderOp(c); break;
      case 'billingOptions':
        later(80, { ev: 'billingOptions', paneId: c.paneId, options: [{ label: 'Follow Myrlin Glass', value: { follow: true } }, ...glass.claude.map((a) => ({ label: a.isKey ? `${a.name} (API key)` : `${a.name} (${a.plan})`, value: { account: a.id } }))] });
        break;
      case 'billing': later(40, { ev: 'billing', paneId: c.paneId, ...billing() }); break;
      default: break;
    }
  }

  function agentWatch(c) {
    const live = c.toolUseId ? agents.get(c.toolUseId) : null;
    const disk = buildSubagents(c.sessionId, NOW).agents.find((a) => a.id === c.agentId || a.toolUseId === c.toolUseId);
    let entries;
    let info;
    if (disk) {
      entries = buildAgentLines(disk.id, NOW);
      info = disk;
    } else if (live) {
      entries = [{ type: 'user', message: { content: live.prompt || live.description } }];
      (live.steps || []).forEach((st, i) => {
        entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_sub_${i}`, name: st.tool, input: { description: st.summary } }] } });
        entries.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_sub_${i}`, content: st.summary, is_error: false }] } });
      });
      entries.push({ type: 'assistant', message: { content: [{ type: 'text', text: live.summary }] } });
      info = { id: c.toolUseId, description: live.description, type: live.subagentType || 'Explore', model: 'claude-haiku-5-5' };
    } else {
      entries = buildAgentLines('agent-u1', NOW);
      info = { id: c.agentId || 'agent-u1', description: 'Check which clients still call the old upload endpoint', type: 'Explore', model: 'claude-haiku-5-5' };
    }
    later(260, { ev: 'agentLines', paneId: c.paneId, sessionId: c.sessionId, reset: true, entries, running: false, lastAt: NOW, agent: info });
  }

  function folderOp(c) {
    if (c.action === 'create') {
      const f = { id: `f-${nextId('f')}`, name: c.name, sessions: c.sessionId ? [c.sessionId] : [], createdAt: iso(now()) };
      folders = [...folders, f];
      const s = sessions.find((x) => x.id === c.sessionId);
      if (s) s.folder = f.id;
    } else if (c.action === 'rename') {
      folders = folders.map((f) => (f.id === c.folderId ? { ...f, name: c.name } : f));
    } else if (c.action === 'delete') {
      folders = folders.filter((f) => f.id !== c.folderId);
      for (const s of sessions) if (s.folder === c.folderId) s.folder = null;
    } else if (c.action === 'move') {
      folders = folders.map((f) => ({ ...f, sessions: f.sessions.filter((id) => id !== c.sessionId) }));
      if (c.folderId) folders = folders.map((f) => (f.id === c.folderId ? { ...f, sessions: [...f.sessions, c.sessionId] } : f));
      const s = sessions.find((x) => x.id === c.sessionId);
      if (s) s.folder = c.folderId || null;
    }
    later(20, { ev: 'folders', folders });
  }

  /* the first events */

  /** What a fresh engine sends once the window listens. */
  function boot() {
    if (listening) return;
    listening = true;
    later(30, { ev: 'ready', billing: billing(), voice: false, model: MODEL, ...(start.codex ? { codex: true } : {}) });
    later(90, { ev: 'index', ok: true, stats: { blocks_added: 3 }, ms: 410 });
    later(120, { ev: 'meaning', stage: 'ready', result: { ok: true, passages: 31_408 } });
    later(160, glassEvent(false));
    later(190, terminalsEvent());
    later(220, { ev: 'auth', loggedIn: true, method: 'oauth', email: null, org: null, plan: 'max', viaKey: false });
    later(250, { ev: 'warm', sessions: sessions.filter((s) => s.warm).map((s) => s.id) });
    // A phone hears the desktop's tabs (engine desktop-tabs.js), for "On your desktop" on its list.
    if (start.desktopTabs) later(280, { ev: 'desktopTabs', tabs: start.desktopTabs });
  }

  /** What the scene runner drives from outside (window.__demo). */
  const control = {
    /** A phone scanned the pairing code: the approval card appears. */
    phoneScan(name = "Maya's iPhone 16") {
      clearTimeout(pairTimer);
      remote.pairing = null;
      remote.request = { sas: '482913', name, id: 'dev-new' };
      emit(remoteEvent());
    },
    /** Claude starts a turn by itself in whatever pane has this session open (the pane shows it working). */
    autoTurn(sessionId, script) {
      const pane = [...panes.values()].find((p) => p.sessionId === sessionId);
      if (pane && !pane.turn) runTurn(pane, script || scriptFor(sessionId), '', true);
    },
    /**
     * A phone took this session over (2026-10-12, the handoff): the desktop pane that had it says so, as engine.js
     * takeFrom does, and from then on follows the transcript (historyCheck).
     */
    takenBy(sessionId, name = "Maya's iPhone 16") {
      const pane = [...panes.values()].find((p) => p.sessionId === sessionId);
      if (!pane) return false;
      pane.turn?.abort();
      emit({ ev: 'taken_over', paneId: pane.id, sessionId, holder: { name: `${name} (phone)`, app: 'apaki-phone', at: new Date(now()).toISOString(), alive: true } });
      return true;
    },
    /** Claude Code on the phone wrote this many of the handoff's messages to the transcript so far (data.mjs). */
    transcriptGrew(sessionId, count) { grown.set(sessionId, count); },
    /** Which panes are open and what they run (for the scene runner to wait on). */
    state() { return { panes: [...panes.values()].map((p) => ({ id: p.id, sessionId: p.sessionId, busy: Boolean(p.turn) })) }; },
  };

  return { handle, boot, control };
}
