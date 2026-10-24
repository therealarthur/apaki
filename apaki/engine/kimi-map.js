/** ACP updates and requests translated to Apaki's existing conversation and question shapes. */
import { providerVisible } from '../ui/glass-providers.js';

export const KIMI_MODES = ['default', 'plan', 'auto', 'yolo'];
export const acpText = (content) => (Array.isArray(content) ? content : []).map((c) => {
  if (c.type === 'content') return c.content?.text || '';
  if (c.type === 'diff') return `${c.path || ''}\nBefore:\n${c.oldText || ''}\nAfter:\n${c.newText || ''}`;
  return c.text || '';
}).filter(Boolean).join('\n');

export function kimiBilling(status) {
  const account = status?.accounts?.find((a) => a.provider === 'kimi' && a.active);
  if (!account) return { name: 'Kimi OAuth', source: 'kimi', follow: false, isKey: false, headroom: null };
  return {
    name: String(account.label || account.email?.split('@')[0] || 'Kimi OAuth'), source: 'kimi', follow: true, isKey: false,
    headroom: Number.isFinite(account.headroom) ? account.headroom : null, glassVisible: providerVisible(status, 'kimi'),
  };
}

const answersOf = (answer) => answer?.behavior === 'allow' ? answer.updatedInput?.answers || {} : null;
function choiceQuestion(question, labels, multiSelect = false) {
  return { question, header: 'Kimi', multiSelect, other: false, options: labels.map((label) => ({ label, description: '' })) };
}

/** Preserve opaque ACP permission IDs. Never infer approval from arbitrary form text. */
export function permissionAsk(params) {
  const options = (params.options || []).filter((o) => typeof o.optionId === 'string' && typeof o.name === 'string');
  if (!options.length) throw new Error('Kimi offered no permission choices.');
  const tool = params.toolCall || {};
  const description = acpText(tool.content).slice(0, 12000);
  const counts = (kind) => options.filter((o) => o.kind === kind);
  const canonical = counts('allow_once').length === 1 && counts('allow_always').length <= 1
    && counts('reject_once').length === 1 && options.every((o) => ['allow_once', 'allow_always', 'reject_once'].includes(o.kind))
    && !options.some((o) => /^(?:q\d+_|plan_)/.test(o.optionId));
  if (canonical) {
    const once = counts('allow_once')[0], always = counts('allow_always')[0], deny = counts('reject_once')[0];
    return {
      toolName: tool.title || 'Kimi tool', input: { description },
      permission: {
        title: tool.title || 'Kimi tool', displayName: tool.title || 'Kimi tool', description, defaultToNo: true,
        toolUseId: tool.toolCallId, always: always ? { lines: [always.name] } : null,
        labels: { once: once.name, always: always?.name || '', deny: deny.name },
      },
      reply(answer) {
        if (!answer) return { outcome: { outcome: 'cancelled' } };
        const selected = answer.behavior === 'allow' ? answer.always ? always : once : deny;
        if (!selected) throw new Error('Kimi did not offer that permission choice.');
        return { outcome: { outcome: 'selected', optionId: selected.optionId } };
      },
      cancelled: { outcome: { outcome: 'cancelled' } },
    };
  }
  const question = [tool.title || 'Kimi choice', description].filter(Boolean).join('\n');
  const labels = options.map((o, i) => options.filter((v) => v.name === o.name).length > 1 ? `${o.name} (${i + 1})` : o.name);
  return {
    toolName: 'AskUserQuestion', input: { questions: [choiceQuestion(question, labels)] },
    reply(answer) {
      const given = answersOf(answer);
      if (!given) return { outcome: { outcome: 'cancelled' } };
      const index = labels.indexOf(given[question]);
      if (index < 0) throw new Error('Choose one of the options Kimi offered. Free text is not supported by this Kimi ACP question.');
      return { outcome: { outcome: 'selected', optionId: options[index].optionId } };
    },
    cancelled: { outcome: { outcome: 'cancelled' } },
  };
}

export function elicitationAsk(params) {
  if (params.mode !== 'form' || params.requestedSchema?.type !== 'object') throw new Error('This Kimi question form is not supported.');
  const fields = Object.entries(params.requestedSchema.properties || {});
  if (!fields.length || fields.length > 20) throw new Error('This Kimi question form is empty or too large.');
  const questions = fields.map(([key, field], i) => {
    const multi = field.type === 'array';
    const list = multi ? field.items?.anyOf : field.oneOf;
    if ((!multi && field.type !== 'string') || !Array.isArray(list) || !list.length || list.some((v) => typeof v.const !== 'string')) throw new Error('Kimi sent a question field Apaki cannot represent.');
    const question = `${field.title || key}${fields.some(([k, f], j) => j !== i && (f.title || k) === (field.title || key)) ? ` (${key})` : ''}${field.description ? `\n${field.description}` : ''}`;
    return { ...choiceQuestion(question, list.map((v) => v.const), multi), header: field.title || key, options: list.map((v) => ({ label: v.const, description: v.description || '' })) };
  });
  return {
    toolName: 'AskUserQuestion', input: { questions, message: String(params.message || '') }, cancelled: { action: 'cancel' },
    reply(answer) {
      const given = answersOf(answer);
      if (!given) return { action: 'decline' };
      const content = {};
      questions.forEach((q, i) => {
        const value = given[q.question];
        const allowed = q.options.map((o) => o.label);
        if (q.multiSelect) {
          // Existing ask cards join selected labels with a comma and a space.
          const selected = Array.isArray(value) ? value : allowed.filter((v) => String(value || '').split(', ').includes(v));
          if (!selected.length || selected.some((v) => !allowed.includes(v)) || (!Array.isArray(value) && selected.join(', ') !== value)) throw new Error('Choose the options Kimi offered; free text is not supported by this Kimi ACP question.');
          content[fields[i][0]] = selected;
        } else {
          if (!allowed.includes(value)) throw new Error('Choose one of the options Kimi offered; free text is not supported by this Kimi ACP question.');
          content[fields[i][0]] = value;
        }
      });
      return { action: 'accept', content };
    },
  };
}

/** Keep the replay and live stream in one representation, with stable IDs within the open pane. */
export class KimiTranscript {
  constructor(emitSdk = () => {}) { this.emitSdk = emitSdk; this.messages = []; this.tools = new Map(); this.serial = 0; this.current = null; this.live = false; }
  next() { return `kimi-message-${++this.serial}`; }
  emit(msg) { if (this.live) this.emitSdk({ ...msg, kimi: true }); }
  add(role, content, { id = this.next(), prompt = false } = {}) {
    const msg = { type: role, uuid: id, at: new Date().toISOString(), prompt, message: { id, role, content } };
    this.messages.push(msg);
    this.emit(msg);
    return msg;
  }
  flush() {
    if (!this.current) return;
    const { id, content } = this.current;
    this.current = null;
    this.add('assistant', content, { id });
  }
  user(content, { emit = false } = {}) {
    this.flush();
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const msg = { type: 'user', uuid: this.next(), at: new Date().toISOString(), prompt: { text, images: content.filter((c) => c.type === 'image').length }, message: { role: 'user', content } };
    this.messages.push(msg);
    if (emit) this.emit(msg);
  }
  update(u) {
    const type = u.sessionUpdate;
    if (type === 'user_message_chunk') { this.user([u.content]); return; }
    if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
      if (u.content?.type !== 'text') return;
      const thinking = type === 'agent_thought_chunk';
      if (!this.current) {
        this.current = { id: this.next(), content: [] };
        this.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: this.current.id } } });
      }
      const content = this.current.content;
      let block = content.at(-1);
      const blockType = thinking ? 'thinking' : 'text';
      if (block?.type !== blockType) {
        block = thinking ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
        content.push(block);
        this.emit({ type: 'stream_event', event: { type: 'content_block_start', index: content.length - 1, content_block: { ...block } } });
      }
      block[thinking ? 'thinking' : 'text'] += u.content.text;
      this.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: content.length - 1, delta: thinking ? { type: 'thinking_delta', thinking: u.content.text } : { type: 'text_delta', text: u.content.text } } });
      return;
    }
    if (type === 'tool_call' || type === 'tool_call_update') {
      this.flush();
      const id = String(u.toolCallId || 'unknown');
      let tool = this.tools.get(id);
      if (!tool) {
        tool = { ...u, done: false };
        this.tools.set(id, tool);
        this.add('assistant', [{ type: 'tool_use', id, name: u.title || u.kind || 'Kimi tool', input: typeof u.rawInput === 'object' && u.rawInput ? u.rawInput : { description: acpText(u.content) } }]);
      } else Object.assign(tool, u);
      const output = acpText(tool.content);
      if (['completed', 'failed'].includes(tool.status) && !tool.done) {
        tool.done = true;
        this.add('user', [{ type: 'tool_result', tool_use_id: id, content: output || (tool.rawOutput ? JSON.stringify(tool.rawOutput) : tool.status), is_error: tool.status === 'failed' }]);
      } else if (output && !tool.done) this.emit({ type: 'system', subtype: 'tool_output', tool_use_id: id, text: output });
      return;
    }
    if (type === 'plan') {
      this.flush();
      this.add('assistant', [{ type: 'tool_use', id: this.next(), name: 'TodoWrite', input: { todos: (u.entries || []).map((e) => ({ content: e.content, activeForm: '', status: e.status })) } }]);
    }
  }
  page({ before, limit = 300, all = false, until } = {}) {
    const messages = this.messages;
    let end = before ? messages.findIndex((m) => m.uuid === before) : messages.length;
    if (end < 0) end = 0;
    let start = Math.max(0, end - (all ? 5000 : Math.min(5000, Math.max(1, Number(limit) || 300))));
    if (until) { const i = messages.findIndex((m) => m.uuid === until); if (i >= 0 && i < end) start = Math.min(start, i); }
    return {
      messages: messages.slice(start, end), total: messages.length, hasMore: start > 0, first: messages[start]?.uuid || null,
      earlier: start, compactions: 0, source: 'kimi', prompts: { before: messages.slice(0, start).filter((m) => m.prompt).length, total: messages.filter((m) => m.prompt).length },
    };
  }
}
