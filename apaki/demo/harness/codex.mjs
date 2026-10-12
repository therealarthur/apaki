/**
 * codex.mjs: a pretend of Apaki's Codex panes (apaki/engine/codex-panes.js) for the demo harness.
 *
 * WHY (2026-10-12): a Codex pane is the same window with the Codex app's pickers, patches and approvals. This answers the
 * ops a Codex pane sends, from invented data, so the window can be looked at (and its stills made) without Codex:
 * the model list with each model's own efforts, a history with a command, a patch and a plan, and a turn that asks the
 * person before it changes a file. Nothing here reads anything from the machine it runs on.
 *
 * createCodexDemo({ emit, later, nextId, sessions, panes, now }) returns
 *   handle(c, pane)  true when it answered the op (a Codex pane's, or one only Codex has)
 */

import { Turn, TurnAborted } from './turns.mjs';

const MODELS = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => ({ value, description: `${value[0].toUpperCase()}${value.slice(1)} reasoning` })), defaultEffort: 'low', isDefault: true, hidden: false },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', efforts: ['low', 'medium', 'high'].map((value) => ({ value, description: `${value[0].toUpperCase()}${value.slice(1)} reasoning` })), defaultEffort: 'medium', isDefault: false, hidden: false },
];
// The plan windows match the Glass card's Codex account in data.mjs (71 percent left of the 5-hour window).
const ACCOUNT = { name: 'ChatGPT Plus', source: 'codex', follow: false, isKey: false, limits: [{ label: '5-hour', usedPercent: 29, resetsAt: 1790000000 }, { label: 'Weekly', usedPercent: 33, resetsAt: 1790400000 }] };
const COMMANDS = [
  { name: 'compact', description: 'Summarize the conversation to free the context window', argumentHint: '' },
  { name: 'status', description: 'Model, effort, permissions, folder and thread id', argumentHint: '' },
  { name: 'review', description: 'Review the uncommitted changes in this folder', argumentHint: '' },
  { name: 'diff', description: 'Show what this conversation changed in its last turn', argumentHint: '' },
  { name: 'mcp', description: 'List the tool servers this thread can use', argumentHint: '' },
  { name: 'goal', description: 'Set, show or clear the goal Codex keeps working toward', argumentHint: '[what to get done | clear]' },
  { name: 'revert', description: 'Take the last exchange out of this conversation (files stay as they are)', argumentHint: '' },
  { name: 'init', description: 'Have Codex write an AGENTS.md for this folder', argumentHint: '' },
  { name: 'mention', description: 'Attach a file to your next message', argumentHint: '<file>' },
  { name: 'deploy', description: 'Ship the current branch', argumentHint: '', skill: true },
];

const PATCH = [{
  path: 'src/pricing/Table.tsx', kind: 'update',
  diff: '@@ -38,7 +38,9 @@\n   return rows.map((row) => (\n     <tr key={row.id}>\n       <td>{row.name}</td>\n-      <td>{formatPrice(row.cents)}</td>\n+      <td>{formatPrice(row.cents, locale)}</td>\n+      <td>{row.perSeat ? formatPrice(row.cents / seats, locale) : null}</td>\n     </tr>\n   ));',
}];

export function createCodexDemo({ emit, later, nextId, sessions, panes, now }) {
  const mine = new Set();
  const waits = new Map(); // ask id -> resolve(result)
  const isMine = (id) => mine.has(id);

  const info = (pane) => pane.codex || (pane.codex = { model: 'gpt-6.1-sol', effort: 'low', mode: 'auto' });

  function opened(c, attached) {
    const row = sessions.find((x) => x.id === c.sessionId) || null;
    const pane = panes.get(c.paneId) || { id: c.paneId, ctxAdd: 0, turn: null };
    pane.sessionId = row?.id || null;
    pane.cwd = row?.cwd || c.cwd || '';
    pane.isCodex = true;
    panes.set(pane.id, pane);
    mine.add(pane.id);
    const cx = info(pane);
    cx.model = c.model || cx.model;
    cx.effort = c.effort || cx.effort;
    cx.mode = c.mode || cx.mode;
    later(50, { ev: 'opened', reqId: c.reqId, paneId: pane.id, sessionId: pane.sessionId, cwd: pane.cwd, title: row?.title || 'New conversation', kind: 'codex', model: cx.model, effort: cx.effort, mode: cx.mode, billing: ACCOUNT, terminal: [], ...(attached ? { attached: true, busy: Boolean(pane.turn) } : {}) });
    if (row) later(130, { ev: 'history', paneId: pane.id, sessionId: row.id, source: 'codex', messages: history(), total: 9, first: 'turn-1', hasMore: false, earlier: 0, countless: false });
    later(220, context(pane));
  }

  const context = (pane, reqId = null) => ({ ev: 'context', reqId, paneId: pane.id, sessionId: pane.sessionId, percentage: 21 + (pane.ctxAdd || 0), totalTokens: 54_000 + (pane.ctxAdd || 0) * 2_600, maxTokens: 258_400, autoCompact: null, model: info(pane).model, used: [{ name: 'Input', tokens: 9_200 }, { name: 'Cached input', tokens: 41_000 }, { name: 'Output', tokens: 3_100 }, { name: 'Reasoning', tokens: 700 }], codex: true });

  function history() {
    const at = new Date(now() - 40 * 60_000).toISOString();
    const use = (id, name, input) => ({ type: 'assistant', uuid: id, at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    const res = (id, content, is_error = false) => ({ type: 'user', uuid: `${id}:r`, at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
    return [
      { type: 'user', uuid: 'u1', at, message: { role: 'user', content: [{ type: 'text', text: 'Show the per seat price in the pricing table, and format it for the locale.' }] } },
      { type: 'assistant', uuid: 'r1', at, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'The table formats cents in one place. The locale is already a prop one level up, so the per seat cell can reuse formatPrice.' }] } },
      use('c1', 'Bash', { command: 'rg -n "formatPrice" src' }),
      res('c1', 'src/pricing/Table.tsx:41:      <td>{formatPrice(row.cents)}</td>\nsrc/pricing/format.ts:3:export function formatPrice(cents: number, locale = "en-US") {'),
      use('p1', 'ApplyPatch', { changes: PATCH }),
      res('p1', 'Changed 1 file.'),
      use('c2', 'Bash', { command: 'npm test pricing' }),
      res('c2', 'PASS src/pricing/Table.test.tsx\n  Table\n    ok shows the per seat price (12 ms)\n\nTests: 4 passed, 4 total'),
      { type: 'assistant', uuid: 'a1', at, message: { role: 'assistant', content: [{ type: 'text', text: 'The pricing table now shows the per seat price next to the plan price, both formatted with the locale. `npm test pricing` passes (4 tests).' }] } },
    ];
  }

  /** A turn: reasoning, a command with output, a plan, a patch that asks first (unless full access), and the answer. */
  async function turn(pane, text) {
    const cx = info(pane);
    const t = new Turn({ emit: (ev) => emit(ev), nextId, contextSoon: () => {} }, { paneId: pane.id, sessionId: pane.sessionId, text });
    pane.turn = t;
    const started = performance.now();
    try {
      await t.think(900);
      t.sdk({ type: 'assistant', codex: true, message: { id: t.msgId, role: 'assistant', content: [{ type: 'thinking', thinking: 'I will look for where the cell is built before changing anything, then keep the edit inside that component.' }] } });
      t.sdk({ type: 'assistant', codex: true, message: { id: t.msgId, role: 'assistant', content: [{ type: 'tool_use', id: 'plan-1', name: 'TodoWrite', input: { todos: [{ content: 'Find the price cell', status: 'completed', activeForm: '' }, { content: 'Add the per seat column', status: 'in_progress', activeForm: '' }, { content: 'Run the pricing tests', status: 'pending', activeForm: '' }] } }] } });
      const id = nextId('exec');
      t.begin();
      t.sdk({ type: 'assistant', message: { id: t.msgId, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'rg -n "perSeat" src' } }] } });
      await t.sleep(300);
      t.sdk({ type: 'system', subtype: 'tool_output', tool_use_id: id, text: 'src/pricing/Table.tsx:42:  row.perSeat' });
      await t.sleep(500);
      t.sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'src/pricing/Table.tsx:42:  row.perSeat\nsrc/pricing/plans.ts:11:  perSeat: true,', is_error: false }] } });
      const pid = nextId('patch');
      t.begin();
      t.sdk({ type: 'assistant', message: { id: t.msgId, content: [{ type: 'tool_use', id: pid, name: 'ApplyPatch', input: { changes: PATCH } }] } });
      if (cx.mode !== 'full-access') {
        const askId = nextId('ask');
        emit({ ev: 'ask', askId, paneId: pane.id, toolName: 'ApplyPatch', input: { changes: PATCH }, permission: { title: 'Apply these changes?', displayName: 'Edit files', description: '', decisionReason: 'Edits need your OK in this mode', blockedPath: '', mcpServer: null, toolUseId: pid, agentId: '', defaultToNo: false, cut: false, always: { lines: ['Approve edits for the rest of this session'] }, labels: { once: 'Approve once', always: 'Approve for this session', deny: 'Deny' }, codex: true } });
        const r = await new Promise((resolve) => { waits.set(askId, resolve); });
        waits.delete(askId);
        const ok = r?.behavior === 'allow';
        t.sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: pid, content: ok ? 'Changed 1 file.' : 'Declined: no files were changed.', is_error: !ok }] } });
        await t.say(ok ? 'The per seat column is in. I have not run the tests yet; say the word and I will.' : 'Understood, I left the file as it was. I can describe the change instead if that helps.');
      } else {
        await t.sleep(400);
        t.sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: pid, content: 'Changed 1 file.', is_error: false }] } });
        await t.say('The per seat column is in `src/pricing/Table.tsx`, formatted with the locale prop. I have not run the tests yet.');
      }
      pane.ctxAdd = (pane.ctxAdd || 0) + 3;
      emit({ ev: 'result', paneId: pane.id, sessionId: pane.sessionId, subtype: 'success', isError: false, durationMs: Math.round(performance.now() - started), usage: {}, cost: null, codex: true, tokens: 54_000 + pane.ctxAdd * 2_600 });
      later(200, context(pane));
    } catch (e) {
      if (e instanceof TurnAborted) emit({ ev: 'result', paneId: pane.id, subtype: 'error_during_execution', isError: false, durationMs: 0, usage: {}, cost: null, codex: true, interrupted: true });
      else console.error('demo codex turn failed', e);
    } finally {
      if (pane.turn === t) pane.turn = null;
    }
  }

  function handle(c, pane) {
    const codexOpen = (c.op === 'open' || c.op === 'attach') && (c.kind === 'codex' || sessions.find((x) => x.id === c.sessionId)?.codex);
    if (c.op === 'codexModels') { later(120, { ev: 'codexModels', reqId: c.reqId, models: MODELS, defaults: { model: 'gpt-6.1-sol', effort: 'low', mode: 'auto' }, presets: ['read-only', 'auto', 'full-access'], account: ACCOUNT }); return true; }
    if (c.op === 'codexThreads') { later(120, { ev: 'codexThreads', reqId: c.reqId, items: sessions.filter((s) => s.codex).map((s) => ({ ...s })) }); return true; }
    if (codexOpen) { opened(c, c.op === 'attach'); return true; }
    if (c.op === 'answer' && waits.has(c.askId)) { waits.get(c.askId)(c.result); return true; }
    if (!pane || !isMine(pane.id)) return false;
    const cx = info(pane);
    switch (c.op) {
      case 'send': {
        if (!pane.sessionId) {
          pane.sessionId = `codex:${nextId('thread')}`;
          emit({ ev: 'session_id', paneId: pane.id, sessionId: pane.sessionId });
        }
        turn(pane, c.text || '');
        return true;
      }
      case 'model': cx.model = c.model; if (!MODELS.find((m) => m.id === c.model)?.efforts.some((e) => e.value === cx.effort)) cx.effort = MODELS.find((m) => m.id === c.model)?.defaultEffort || cx.effort; later(30, { ev: 'settings', paneId: pane.id, model: cx.model, effort: cx.effort, mode: cx.mode }); return true;
      case 'effort': cx.effort = c.effort; later(30, { ev: 'settings', paneId: pane.id, model: cx.model, effort: cx.effort, mode: cx.mode }); return true;
      case 'mode': cx.mode = c.mode; later(30, { ev: 'settings', paneId: pane.id, model: cx.model, effort: cx.effort, mode: cx.mode }); return true;
      case 'commands': later(40, { ev: 'commands', reqId: c.reqId, paneId: pane.id, commands: COMMANDS }); return true;
      case 'contextUsage': later(80, context(pane, c.reqId)); return true;
      case 'interrupt': pane.turn?.abort(); return true;
      case 'close': pane.turn?.abort(); mine.delete(pane.id); panes.delete(pane.id); later(20, { ev: 'closed', paneId: pane.id }); return true;
      default: return false;
    }
  }

  return { handle };
}
