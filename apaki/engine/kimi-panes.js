/** Kimi panes use ACP and the same events as Claude panes. No credential files are read here. */
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { KimiClient, KIMI_MODEL, KIMI_EFFORT, isKimiPane, kimiSessionId } from './kimi-client.js';
import { kimiExcluded } from './kimi-list.js';
import { KIMI_MODES, KimiTranscript, permissionAsk, elicitationAsk, kimiBilling } from './kimi-map.js';
import { KimiJournalReader, KimiJournalTranscript } from './kimi-journal.js';
import { heldView } from './queue-hold.js';

const READ_ONLY = 'This session is running in another Kimi process and is shown read only. Sending will be enabled when it becomes available.';
export function mayBeHeld(error) {
  const codes = [error?.code, error?.data?.code, error?.data?.type, error?.data?.error?.code];
  return (error?.kimiLoad && Number(error.code) === -32603) || codes.includes('session.busy');
}
function openError(error) {
  const message = String(error?.message || '').trim();
  return !message || /^internal error[.!]?$/i.test(message)
    ? 'Kimi could not open the conversation because its ACP service failed. Check the Kimi CLI status and reopen this pane.'
    : `Kimi could not open the conversation: ${message}`;
}

export function createKimi({ emit, asks, panes, list, turnEnded = () => {}, activity = () => {}, onSession = () => {}, onRowsChange = () => {}, clientFactory = (opts) => new KimiClient(opts), cancelMs = 5000, followMs = 1000, now = Date.now } = {}) {
  let billing = kimiBilling(null);
  const event = (p, ev, data = {}) => emit({ ev, paneId: p.id, sessionId: p.sessionId, ...data });
  const settings = (p) => event(p, 'settings', { kind: 'kimi', model: p.model, effort: p.effort, mode: p.mode, tune: {}, readOnly: Boolean(p.kimi?.readOnly), readOnlyReason: p.kimi?.readOnly ? READ_ONLY : '' });
  const note = (p, text, tone = 'warn') => event(p, 'note', { text, tone });
  function clearAsks(p, why) {
    for (const [id, a] of asks) if (a.paneId === p.id && a.kimi) {
      asks.delete(id); a.resolve();
      event(p, 'ask_gone', { askId: id, why });
    }
  }
  function finish(p, cx, error = null, stopReason = 'end_turn') {
    if (p.kimi !== cx || !cx.turn) return;
    if (error && /^internal error[.!]?$/i.test(String(error.message).trim())) error = new Error('Kimi could not continue because its ACP service failed. Reopen this pane; the last prompt was not retried.');
    const turn = cx.turn; cx.turn = null;
    clearTimeout(cx.cancelTimer); cx.cancelTimer = null;
    cx.transcript.flush();
    clearAsks(p, error ? 'cancelled' : stopReason === 'cancelled' ? 'stopped' : 'turn');
    p.busy = false; p.inTurn = false;
    if (error || stopReason === 'cancelled') p.userStopped = true;
    event(p, 'result', {
      reqId: turn.reqId, kimi: true, subtype: error ? 'error_during_execution' : 'success', isError: Boolean(error),
      result: error?.message || null, errors: error ? [error.message] : [], durationMs: Date.now() - turn.at,
      usage: {}, cost: null, stopReason,
    });
    list.refresh(true).then(onRowsChange).catch(() => {});
    if (!cx.closing) turnEnded(p);
  }
  function onRequest(p, cx, id, method, params) {
    const client = cx.client;
    if (!cx.turn || cx.closing || params.sessionId !== cx.rawId) {
      if (method === 'session/request_permission') client.respond(id, { outcome: { outcome: 'cancelled' } });
      else if (method === 'elicitation/create') client.respond(id, { action: 'cancel' });
      else client.reject(id, -32601, 'Apaki does not implement this ACP client method.');
      return;
    }
    let ask;
    try {
      if (method === 'session/request_permission') ask = permissionAsk(params);
      else if (method === 'elicitation/create') ask = elicitationAsk(params);
      else { client.reject(id, -32601, 'Apaki does not implement this ACP client method.'); return; }
    } catch (e) { client.reject(id, -32602, e.message); return; }
    const askId = `kimi-ask-${randomUUID()}`;
    const entry = {
      kimi: true, paneId: p.id, toolName: ask.toolName, input: ask.input, permission: ask.permission, at: Date.now(), settled: false,
      answer(answer) {
        if (entry.settled) return;
        let response;
        try { response = ask.reply(answer); } catch (e) { note(p, `${e.message} The question was declined.`); response = ask.cancelled; }
        entry.settled = true; asks.delete(askId);
        client.respond(id, response);
        event(p, 'ask_gone', { askId, why: 'answered' });
      },
      resolve() { if (entry.settled) return; entry.settled = true; asks.delete(askId); client.respond(id, ask.cancelled); },
    };
    asks.set(askId, entry);
    event(p, 'ask', { askId, toolName: ask.toolName, input: ask.input, ...(ask.permission ? { permission: ask.permission } : {}) });
  }
  function onUpdate(p, cx, method, params) {
    if (p.kimi !== cx || cx.closing || method !== 'session/update' || params.sessionId !== cx.rawId) return;
    const u = params.update || {};
    if (cx.replay) { cx.replay.update(u); return; }
    switch (u.sessionUpdate) {
      case 'available_commands_update':
        cx.commands = (u.availableCommands || []).filter((c) => typeof c.name === 'string').map((c) => ({ name: c.name, description: String(c.description || ''), argumentHint: c.input?.hint || '' }));
        event(p, 'commands', { commands: cx.commands });
        break;
      case 'current_mode_update':
        if (KIMI_MODES.includes(u.currentModeId)) { p.mode = u.currentModeId; settings(p); }
        break;
      case 'session_info_update':
        if (typeof u.title === 'string' && u.title) { cx.title = u.title; event(p, 'renamed', { title: u.title, ok: true }); }
        break;
      case 'usage_update':
        if (Number.isFinite(u.used) && Number.isFinite(u.size) && u.size > 0) {
          cx.context = { totalTokens: u.used, maxTokens: u.size, percentage: 100 * u.used / u.size };
          event(p, 'context', cx.context);
        }
        break;
      default: cx.transcript.update(u);
    }
  }
  async function enforce(p, cx) {
    for (const [configId, value] of [['model', KIMI_MODEL], ['thinking', KIMI_EFFORT]]) {
      const r = await cx.client.request('session/set_config_option', { sessionId: cx.rawId, configId, value });
      if (!r?.configOptions?.some((c) => c.id === configId && c.currentValue === value)) throw new Error(`Kimi did not confirm ${configId} ${value}. No prompt was sent.`);
    }
    p.model = KIMI_MODEL; p.effort = KIMI_EFFORT;
    settings(p);
  }
  async function load(p, cx, { recover = false } = {}) {
    if (cx.loaded && !cx.client.closed) return;
    if (cx.failed) throw new Error('Reopen this Kimi pane before sending again. Its previous prompt was not retried.');
    const client = cx.client = clientFactory({ cwd: cx.cwd });
    if (recover) cx.replay = new KimiTranscript();
    client.on('request', (id, method, params) => { if (cx.client === client) onRequest(p, cx, id, method, params); });
    client.on('notification', (method, params) => { if (cx.client === client) onUpdate(p, cx, method, params); });
    client.on('gone', (e) => {
      if (cx.client !== client || !cx.loaded || cx.readOnly) return;
      cx.failed = true; cx.loaded = false;
      clearAsks(p, 'cancelled');
      if (!cx.closing && p.kimi === cx) { if (cx.turn) finish(p, cx, e); else event(p, 'error', { message: e.message }); }
    });
    await client.start();
    if (cx.closing) throw new Error('Kimi pane closed.');
    const resumed = Boolean(cx.rawId);
    let result;
    try {
      result = await client.request(resumed ? 'session/load' : 'session/new', { ...(resumed ? { sessionId: cx.rawId } : {}), cwd: cx.cwd, mcpServers: [] });
    } catch (error) { error.kimiLoad = resumed; throw error; }
    if (cx.closing) throw new Error('Kimi pane closed.');
    if (!resumed) {
      cx.rawId = kimiSessionId(result?.sessionId);
      p.sessionId = `kimi:${cx.rawId}`;
      p.createdHere = true;
      onSession(p);
      event(p, 'session_id');
    }
    (cx.replay || cx.transcript).flush();
    await enforce(p, cx);
    await client.request('session/set_mode', { sessionId: cx.rawId, modeId: p.mode });
    cx.loaded = true;
    cx.replay = null;
    if (!recover) cx.transcript.live = true;
  }
  function transcript(p, cx) {
    return new KimiTranscript((msg) => {
      // Journal messages already carry complete blocks; the existing renderer folds their thinking.
      if (cx.readOnly && msg.type === 'stream_event') return;
      if (cx.closing || p.kimi !== cx) return;
      event(p, 'sdk', { msg });
      if (!cx.readOnly) activity(p, msg);
    });
  }
  async function stopClient(cx) {
    const client = cx.client;
    cx.client = null; cx.replay = null; cx.loaded = false;
    await client?.stop();
  }
  async function readJournal(p, cx, opts) {
    const read = await cx.reader.read(opts);
    cx.transcript.flush();
    if (read.bytes || read.reset || cx.lastGrowth === undefined) cx.lastGrowth = now();
    if (read.reset) note(p, 'Kimi replaced or shortened its journal. The history already shown is kept.', 'dim');
    return read;
  }
  function follow(p, cx, visible = false) {
    if (cx.closing || p.kimi !== cx || !cx.readOnly) return Promise.resolve();
    if (cx.followWork) return visible ? cx.followWork.then(() => follow(p, cx, true)) : cx.followWork;
    cx.followWork = (async () => {
      const read = await readJournal(p, cx);
      if (cx.closing || !visible || read.more || read.bytes || cx.retryBlocked
        || now() - cx.lastGrowth < 30000 || now() - cx.lastAttempt < 30000) return;
      cx.lastAttempt = now();
      try {
        await load(p, cx, { recover: true });
        // Successful loading holds the session here. Finish the final journal write before enabling sends.
        let tail;
        do { tail = await readJournal(p, cx, { final: true }); } while (tail.more && !cx.closing);
        if (cx.closing) return;
        cx.readOnly = false;
        clearInterval(cx.followTimer);
        settings(p);
        note(p, 'Kimi is available here now. You can continue the conversation.', 'dim');
      } catch (error) {
        await stopClient(cx);
        if (cx.closing) return;
        if (!mayBeHeld(error)) {
          cx.retryBlocked = true;
          event(p, 'error', { message: `${openError(error)} The journal remains read only. Reopen the pane to retry.` });
        }
      }
    })().catch((error) => {
      if (!cx.closing && !cx.journalError) {
        cx.journalError = true;
        event(p, 'error', { message: `Kimi journal following paused: ${error.message} Reopen the pane to retry.` });
        clearInterval(cx.followTimer);
      }
    }).finally(() => { cx.followWork = null; });
    return cx.followWork;
  }
  async function open(reqId, p, sessionId, cwd, opts = {}) {
    await list.refresh();
    const row = sessionId ? list.get(sessionId) : null;
    // A supplied cwd must never override a resumed session's metadata.
    const folder = row?.cwd || cwd || os.homedir();
    p.kind = 'kimi'; p.runner = null; p.busy = false; p.inTurn = false; p.userStopped = false;
    p.model = KIMI_MODEL; p.effort = KIMI_EFFORT; p.mode = KIMI_MODES.includes(opts.mode) ? opts.mode : 'default'; p.tune = {};
    p.sessionId = sessionId || null; p.cwd = folder; p.createdHere = false; p.openedAt = new Date().toISOString();
    const cx = p.kimi = { readOnly: false, lastAttempt: now(), rawId: null, cwd: folder, title: row?.title || 'New conversation', commands: [], turn: null, loaded: false, failed: false };
    cx.transcript = transcript(p, cx);
    try {
      if (kimiExcluded(folder)) throw new Error('This folder is excluded by the owner.');
      if (sessionId && !row) throw new Error('Kimi session metadata was not found in the configured KIMI_CODE_HOME, or the session is excluded. Refresh the list and check the Kimi home.');
      if (row?.kimiArchived) throw new Error('This session is archived in Kimi. Unarchive it in Kimi before continuing.');
      if (sessionId) { cx.rawId = kimiSessionId(sessionId); await load(p, cx); }
    }
    catch (e) {
      await stopClient(cx);
      if (mayBeHeld(e) && row) {
        try {
          cx.readOnly = true;
          cx.transcript = transcript(p, cx);
          cx.journal = new KimiJournalTranscript(cx.transcript);
          cx.reader = new KimiJournalReader(row.file, list.root, (r) => cx.journal.consume(r));
          await readJournal(p, cx, { maxBytes: 8 * 1024 * 1024 });
          await attach(reqId, p, false);
          cx.transcript.live = true;
          cx.followTimer = setInterval(() => follow(p, cx), followMs);
          cx.followTimer.unref();
          return;
        } catch (journalError) {
          e = new Error(`The session may be in use, but Apaki could not read its journal. ${journalError.message}`);
        }
      }
      cx.failed = true;
      await attach(reqId, p);
      event(p, 'error', { reqId, message: openError(e) });
      return;
    }
    await attach(reqId, p, false);
    if (sessionId) note(p, 'Kimi ACP shows its current context. Keyword search also reads older main-agent journal text.', 'dim');
  }
  async function attach(reqId, p, attached = true) {
    const cx = p.kimi;
    cx.transcript.flush();
    event(p, 'opened', {
      reqId, kind: 'kimi', attached, cwd: cx.cwd, title: cx.title, model: p.model, effort: p.effort, mode: p.mode,
      readOnly: Boolean(cx.readOnly), readOnlyReason: cx.readOnly ? READ_ONLY : '',
      billing, terminal: [], busy: Boolean(p.busy), turn: Boolean(p.busy), running: Boolean(cx.loaded), queue: heldView(p), tune: {},
    });
    event(p, 'history', { ...cx.transcript.page(), reqId });
    for (const [askId, a] of asks) if (a.kimi && a.paneId === p.id) event(p, 'ask', { askId, toolName: a.toolName, input: a.input, ...(a.permission ? { permission: a.permission } : {}) });
    event(p, 'commands', { commands: cx.commands });
    if (cx.readOnly) note(p, READ_ONLY, 'dim');
  }
  async function send(reqId, p, text, images = []) {
    const cx = p.kimi;
    if (cx.readOnly) { event(p, 'error', { reqId, message: READ_ONLY, busy: false }); return; }
    if (p.busy) { event(p, 'error', { reqId, message: 'Kimi is working. Queue the message or stop the turn first.' }); return; }
    p.busy = true; p.inTurn = true;
    cx.turn = { reqId, at: Date.now() };
    try {
      const content = [];
      if (String(text).trim()) content.push({ type: 'text', text: String(text) });
      for (const im of images) {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(im.media_type) || typeof im.data !== 'string' || im.data.length > 24 * 1024 * 1024) throw new Error('Kimi accepts PNG, JPEG, GIF or WebP images up to 18 MB.');
        content.push({ type: 'image', mimeType: im.media_type, data: im.data });
      }
      if (!content.length) { finish(p, cx); return; }
      await load(p, cx);
      await enforce(p, cx);
      if (!cx.turn || p.userStopped || cx.closing) { finish(p, cx, null, 'cancelled'); return; }
      if (images.length && cx.client.capabilities.promptCapabilities?.image !== true) throw new Error('This Kimi ACP server does not accept images.');
      cx.transcript.user(content.map((c) => c.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } } : c));
      // session/prompt answers at turn end. Keep dispatch free for Stop, Close and reconnects while it runs.
      cx.client.request('session/prompt', { sessionId: cx.rawId, prompt: content }, 0)
        .then((r) => finish(p, cx, null, r?.stopReason || 'end_turn'), (e) => finish(p, cx, e));
    } catch (e) { finish(p, cx, e); }
  }
  async function interrupt(p) {
    const cx = p.kimi;
    p.userStopped = true;
    clearAsks(p, 'stopped');
    if (!cx?.turn) return;
    if (cx.rawId && !cx.client?.closed) {
      try { cx.client?.notify('session/cancel', { sessionId: cx.rawId }); } catch { /* Exit also settles the turn. */ }
    }
    if (!cx.cancelTimer) cx.cancelTimer = setTimeout(() => {
      finish(p, cx, new Error('Kimi did not stop in time. Its ACP child was closed; reopen the pane before continuing.'));
      cx.client?.stop().catch(() => {});
    }, cancelMs);
    cx.cancelTimer?.unref();
  }
  async function close(p) {
    const cx = p.kimi;
    if (!cx) return;
    cx.closing = true;
    p.userStopped = true;
    clearAsks(p, 'closed');
    clearTimeout(cx.cancelTimer);
    clearInterval(cx.followTimer);
    if (cx.loaded && cx.client && !cx.client.closed && cx.rawId) {
      try { cx.client.notify('session/cancel', { sessionId: cx.rawId }); } catch { /* Already gone. */ }
      await cx.client.request('session/close', { sessionId: cx.rawId }, 2000).catch(() => {});
    }
    await stopClient(cx);
    await cx.followWork;
    p.busy = false; p.inTurn = false; p.kimi = null; p.kind = null;
  }
  async function setting(p, op, value) {
    const cx = p.kimi;
    try {
      if (cx.readOnly) throw new Error(READ_ONLY);
      if (op === 'model' && value !== KIMI_MODEL) throw new Error('Kimi panes use kimi-code/k3.1-pro.');
      if (op === 'effort' && value !== KIMI_EFFORT) throw new Error('Kimi main sessions use max effort.');
      if (op === 'mode') {
        if (!KIMI_MODES.includes(value)) throw new Error('Unknown Kimi permission mode.');
        if (p.busy) throw new Error('Stop Kimi or wait for its turn before changing permissions.');
        if (cx.loaded) await cx.client.request('session/set_mode', { sessionId: cx.rawId, modeId: value });
        p.mode = value;
      }
    } finally { settings(p); }
  }
  async function handle(c, p) {
    const cx = p.kimi;
    if (c.sessionId && c.sessionId !== p.sessionId) throw new Error('That Kimi conversation is not open in this pane.');
    switch (c.op) {
      case 'attach': await attach(c.reqId, p); return true;
      case 'model': case 'effort': case 'mode': await setting(p, c.op, c[c.op]); return true;
      case 'contextUsage': event(p, 'context', { reqId: c.reqId, ...(cx.context || { none: true }) }); return true;
      case 'commands': event(p, 'commands', { reqId: c.reqId, commands: cx.commands }); return true;
      case 'historyBefore': event(p, 'historyPage', { reqId: c.reqId, ...cx.transcript.page(c) }); return true;
      case 'historyCheck':
        if (cx.readOnly) await follow(p, cx, c.visible === true);
        event(p, 'historyChecked', { reqId: c.reqId, fresh: true }); return true;
      case 'historyPrompts': {
        const prompts = cx.transcript.messages.filter((m) => m.prompt).map((m) => ({ id: m.uuid, at: m.at, ...m.prompt }));
        event(p, 'historyPrompts', { reqId: c.reqId, prompts, total: prompts.length }); return true;
      }
      case 'steer': event(p, 'steer_missed', { reqId: c.reqId, qid: c.qid }); note(p, 'Kimi ACP cannot steer a running turn. Queue the message, or stop and send again.'); return true;
      case 'billingOptions': event(p, 'billing', billing); note(p, 'Kimi uses its CLI OAuth login. Myrlin Glass reports that account when its Kimi provider is available.', 'dim'); return true;
      default: return false;
    }
  }
  return {
    open, attach, send, interrupt, close, handle,
    billing: () => billing,
    updateBilling(status) { billing = kimiBilling(status); for (const p of panes.values()) if (isKimiPane(p)) event(p, 'billing', billing); },
    async shutdown() { for (const p of panes.values()) if (isKimiPane(p)) await close(p); },
  };
}
