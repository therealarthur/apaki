/** Fake Kimi Code 2.3.1 ACP process. Invented sessions only, no network or login. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const home = process.env.KIMI_CODE_HOME;
if (!home || !process.env.FAKE_KIMI_LOG) process.exit(9);
const log = (entry) => fs.appendFileSync(process.env.FAKE_KIMI_LOG, `${JSON.stringify(entry)}\n`);
log({ argv: process.argv.slice(2), model: process.env.KIMI_SECONDARY_MODEL, effort: process.env.KIMI_SECONDARY_EFFORT });
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const reply = (id, result = {}) => send({ id, result });
const fail = (id, code, message, data) => send({ id, error: { code, message, ...(data ? { data } : {}) } });
const sessions = new Map();
const prompts = new Map();
const pending = new Map();
let nextAsk = 100;
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const text = (id, text, type = 'agent_message_chunk') => update(id, { sessionUpdate: type, content: { type: 'text', text } });
const dir = (id) => path.join(home, 'sessions', 'fixture-workspace', id);
const persist = (s) => {
  fs.mkdirSync(path.join(dir(s.id), 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir(s.id), 'state.json'), JSON.stringify({ cwd: s.cwd, title: 'Invented Kimi session', createdAt: 1700000000000, updatedAt: Date.now() }));
};
const options = (s) => [
  { id: 'model', type: 'select', currentValue: s.model, options: [{ value: 'kimi-code/k3.1-pro', name: 'K3.1 Pro' }] },
  { id: 'thinking', type: 'select', currentValue: s.thinking, options: [{ value: 'max', name: 'Max' }] },
];
function done(s, id, reason = 'end_turn') {
  prompts.delete(s.id);
  update(s.id, { sessionUpdate: 'usage_update', used: 1200, size: 256000 });
  reply(id, { stopReason: reason });
}
function ask(s, method, params, after) {
  const id = ++nextAsk;
  pending.set(id, after);
  send({ id, method, params: { sessionId: s.id, ...params } });
}
async function input(m) {
  log({ in: m });
  if (!m.method) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  const p = m.params || {};
  const s = sessions.get(p.sessionId);
  switch (m.method) {
    case 'initialize':
      if (process.env.FAKE_KIMI_START === 'init-error') { fail(m.id, -32603, 'Internal error'); return; }
      if (process.env.FAKE_KIMI_START === 'timeout') return;
      if (process.env.FAKE_KIMI_START === 'bad') { process.stdout.write('bad json\n'); return; }
      reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { close: {} } } }); return;
    case 'session/new': {
      const session = { id: randomUUID(), cwd: p.cwd, model: 'other', thinking: 'low' };
      sessions.set(session.id, session); persist(session);
      reply(m.id, { sessionId: session.id, configOptions: options(session), modes: { currentModeId: 'default' } });
      setTimeout(() => update(session.id, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'status', description: 'Session status' }, { name: 'compact', description: 'Compact context' }] }), 0);
      return;
    }
    case 'session/load': {
      if (process.env.FAKE_KIMI_LOAD_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_KIMI_LOAD_DELAY)));
      if (fs.existsSync(path.join(dir(p.sessionId), 'held'))) {
        if (process.env.FAKE_KIMI_HELD === 'busy') fail(m.id, -32001, 'Session busy', { code: 'session.busy' });
        else fail(m.id, -32603, 'Internal error');
        return;
      }
      if (process.env.FAKE_KIMI_START === 'load-error') { fail(m.id, -32602, 'Internal error'); return; }
      if (process.env.FAKE_KIMI_START === 'auth') { fail(m.id, -32000, 'Authentication required'); return; }
      const session = { id: p.sessionId, cwd: p.cwd, model: 'other', thinking: 'low' };
      sessions.set(session.id, session);
      text(session.id, 'Invented previous prompt', 'user_message_chunk');
      text(session.id, 'Invented previous answer');
      reply(m.id, { configOptions: options(session), modes: { currentModeId: 'default' } }); return;
    }
    case 'session/set_config_option':
      if (!s) { fail(m.id, -32602, 'No session'); return; }
      s[p.configId] = p.value;
      if (process.env.FAKE_KIMI_START === 'wrong-effort' && p.configId === 'thinking') s.thinking = 'high';
      update(s.id, { sessionUpdate: 'config_option_update', configOptions: options(s) });
      reply(m.id, { configOptions: options(s) }); return;
    case 'session/set_mode':
      update(s.id, { sessionUpdate: 'current_mode_update', currentModeId: p.modeId }); reply(m.id); return;
    case 'session/prompt': {
      if (s.model !== 'kimi-code/k3.1-pro' || s.thinking !== 'max') { fail(m.id, -32602, 'Wrong enforced settings'); return; }
      const body = p.prompt.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      fs.appendFileSync(path.join(dir(s.id), 'agents', 'main', 'wire.jsonl'), `${JSON.stringify({ type: 'context.append_message', time: Date.now(), message: { role: 'user', content: [{ type: 'text', text: body }] } })}\n`);
      prompts.set(s.id, { id: m.id, body });
      if (body === 'crash') { process.exit(7); return; }
      if (body === 'occupied') { fail(m.id, -32600, 'Session is occupied by another client.'); return; }
      text(s.id, 'Invented reasoning', 'agent_thought_chunk');
      text(s.id, 'Hello '); text(s.id, 'from Kimi.');
      if (body === 'hang' || body === 'ignore-cancel') return;
      if (body === 'approve') {
        update(s.id, { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Bash', status: 'pending', rawInput: { command: 'printf fixture' } });
        ask(s, 'session/request_permission', { toolCall: { toolCallId: 'tool-1', title: 'Bash', content: [{ type: 'content', content: { type: 'text', text: 'printf fixture' } }] }, options: [
          { optionId: 'opaque-once', name: 'Approve once', kind: 'allow_once' },
          { optionId: 'opaque-always', name: 'Approve for this session', kind: 'allow_always' },
          { optionId: 'opaque-no', name: 'Reject', kind: 'reject_once' },
        ] }, (answer) => {
          update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(answer.result) } }] });
          done(s, m.id);
        }); return;
      }
      if (body === 'question') {
        ask(s, 'elicitation/create', { toolCallId: 'question-1', mode: 'form', message: 'Pick invented options', requestedSchema: { type: 'object', required: ['q0', 'q1'], properties: {
          q0: { type: 'string', title: 'Color', oneOf: [{ const: 'Blue', title: 'Blue' }, { const: 'Green', title: 'Green' }] },
          q1: { type: 'array', title: 'Parts', items: { anyOf: [{ const: 'A' }, { const: 'B' }] }, minItems: 1 },
        } } }, (answer) => { text(s.id, JSON.stringify(answer.result)); done(s, m.id); }); return;
      }
      if (body === 'plan') update(s.id, { sessionUpdate: 'plan', entries: [{ content: 'Invented step', priority: 'high', status: 'completed' }] });
      if (body === 'reverse') ask(s, 'terminal/create', { command: 'must never execute' }, () => done(s, m.id));
      else done(s, m.id);
      return;
    }
    case 'session/cancel': {
      const current = prompts.get(p.sessionId);
      if (current?.body === 'ignore-cancel') return;
      if (current) done(s, current.id, 'cancelled');
      return;
    }
    case 'session/close': sessions.delete(p.sessionId); reply(m.id); return;
    default: fail(m.id, -32601, 'Unsupported fake method');
  }
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { try { input(JSON.parse(line)).catch(() => process.exit(8)); } catch { process.exit(8); } });
rl.on('close', () => process.exit(0));
