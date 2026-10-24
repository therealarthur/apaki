/** Kimi protocol 1.5 journals. Read only, bounded IO, no CLI or credential access. */
import { StringDecoder } from 'node:string_decoder';
import { openKimiFile } from './kimi-files.js';

export const TITLE_BYTES = 512 * 1024;
export const JOURNAL_BYTES = 1024 * 1024;
const LINE_BYTES = 2 * 1024 * 1024;
const main = (r) => !r?.agentId || r.agentId === 'main';
const blocks = (v) => typeof v === 'string' ? [{ type: 'text', text: v }] : Array.isArray(v) ? v : [];
const clean = (text) => String(text || '').replace(/<system-reminder\b[^>]*>[\s\S]*?(?:<\/system-reminder\s*>|$)/gi, '').trim();
export const promptText = (v) => blocks(v).filter((b) => b?.type === 'text').map((b) => clean(b.text)).filter(Boolean).join('\n');
const originKind = (r) => String(r.origin?.kind || '').toLowerCase().replaceAll('_', '-');
const userOrigin = (r) => !r.origin || ['user', 'agent-file'].includes(originKind(r));
const oneLine = (text, max) => Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, max).join('');

/** Roles must be explicit metadata. Never infer a helper from prompt words or a tool it calls. */
function journalRole(r) {
  if (!main(r)) return '';
  if (r.type === 'turn.prompt' && (originKind(r) === 'agent-file' || r.origin?.agentFile || r.origin?.agent_file)) return 'Agent file';
  if (!['metadata', 'profile.bind', 'runtime.set_binding', 'turn.prompt'].includes(r.type)) return '';
  const values = [r.role, r.agentRole, r.profileName, r.origin?.role];
  if (values.includes('builder')) return 'Builder';
  if (values.includes('subagent')) return 'Subagent';
  return '';
}

export async function readKimiTitle(file, root) {
  const { handle, stat } = await openKimiFile(file, root);
  try {
    const buffer = Buffer.alloc(Math.min(TITLE_BYTES, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (bytesRead < stat.size) lines.pop();
    let firstPrompt = '', role = '', firstTurn = false, mirror = null, allowed = true;
    for (const line of lines) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r || !main(r)) continue;
      if (r.type !== 'turn.prompt' || !firstTurn) role ||= journalRole(r);
      if (r.type === 'turn.prompt') {
        allowed = userOrigin(r);
        mirror = promptText(r.input);
        if (allowed) firstPrompt ||= mirror;
        if (allowed && mirror) firstTurn = true;
      } else if (r.type === 'context.append_message' && r.message?.role === 'user') {
        const text = promptText(r.message.content);
        if (text && (text !== mirror || allowed)) { firstPrompt ||= text; firstTurn = true; }
      }
    }
    return { title: oneLine(firstPrompt, 120), firstPrompt: oneLine(firstPrompt, 500), role };
  } finally { await handle.close(); }
}

/** One cursor per pane. A partial UTF8 character or JSON record waits for its next write. */
export class KimiJournalReader {
  constructor(file, root, consume) {
    this.file = file; this.root = root; this.consume = consume;
    this.offset = 0; this.identity = null; this.resetBuffer();
  }
  resetBuffer() { this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.skipping = false; }
  line(line) {
    if (Buffer.byteLength(line) > LINE_BYTES) return;
    let record; try { record = JSON.parse(line); } catch { return; }
    if (record && typeof record === 'object') this.consume(record);
  }
  feed(data) {
    this.buffer += this.decoder.write(data);
    let at;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (!this.skipping) this.line(line);
      this.skipping = false;
    }
    if (Buffer.byteLength(this.buffer) > LINE_BYTES) { this.buffer = ''; this.skipping = true; }
  }
  async read({ maxBytes = JOURNAL_BYTES, final = false } = {}) {
    const { handle, stat } = await openKimiFile(this.file, this.root);
    try {
      const identity = `${stat.dev}:${stat.ino}`;
      const reset = this.identity !== null && (identity !== this.identity || stat.size < this.offset);
      if (reset) { this.offset = 0; this.resetBuffer(); }
      this.identity = identity;
      const end = Math.min(stat.size, this.offset + maxBytes);
      const buffer = Buffer.alloc(Math.min(64 * 1024, end - this.offset));
      let bytes = 0;
      while (this.offset < end) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead; bytes += bytesRead;
        this.feed(buffer.subarray(0, bytesRead));
      }
      const more = this.offset < stat.size;
      if (final && !more) {
        this.buffer += this.decoder.end();
        if (!this.skipping && this.buffer) this.line(this.buffer);
        this.resetBuffer();
      }
      return { bytes, more, reset, size: stat.size };
    } finally { await handle.close(); }
  }
}

const outputText = (value) => typeof value === 'string' ? value : blocks(value).map((b) => b.text || '').filter(Boolean).join('\n');

/** Ignore mirrored context records when the same turn already supplied loop events. */
export class KimiJournalTranscript {
  constructor(transcript) { this.transcript = transcript; this.mirror = null; this.loop = false; this.calls = new Map(); }
  consume(r) {
    if (!main(r)) return;
    const t = this.transcript;
    if (r.type === 'turn.prompt') {
      this.loop = false;
      this.mirror = promptText(r.input);
      if (userOrigin(r) && this.mirror) t.user([{ type: 'text', text: this.mirror }], { emit: true });
      return;
    }
    if (r.type === 'context.append_message') {
      const m = r.message;
      if (m?.role === 'user') {
        const text = promptText(m.content);
        if (text && text === this.mirror) { this.mirror = null; return; }
        if (text) { this.loop = false; t.user([{ type: 'text', text }], { emit: true }); }
      } else if (m?.role === 'assistant' && !this.loop) {
        for (const part of blocks(m.content)) this.part(part);
        for (const call of m.tool_calls || []) {
          let args = call.function?.arguments || {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { arguments: args }; } }
          t.update({ sessionUpdate: 'tool_call', toolCallId: call.id, title: call.function?.name, rawInput: args });
        }
        t.flush();
      } else if (m?.role === 'tool') this.result(m.tool_call_id, m.content, m.is_error);
      return;
    }
    if (r.type === 'turn.ended' || r.type === 'agent.turn.ended') { t.flush(); this.mirror = null; return; }
    if (r.type !== 'context.append_loop_event') return;
    const e = r.event;
    if (!e) return;
    if (e.type === 'content.part') { this.loop = true; this.part(e.part); }
    if (e.type === 'tool.call') {
      this.loop = true;
      const id = e.toolCallId || e.uuid;
      if (e.uuid) this.calls.set(e.uuid, id);
      t.update({ sessionUpdate: 'tool_call', toolCallId: id, title: e.name, rawInput: e.args });
    }
    if (e.type === 'tool.result') this.result(e.toolCallId || this.calls.get(e.parentUuid), e.result?.output, e.result?.isError || e.result?.is_error);
    if (e.type === 'step.end') t.flush();
  }
  part(part) {
    if (!part) return;
    const thinking = part.type === 'think' || part.type === 'thinking';
    const text = thinking ? part.think || part.thinking : part.type === 'text' ? part.text : '';
    if (text) this.transcript.update({ sessionUpdate: thinking ? 'agent_thought_chunk' : 'agent_message_chunk', content: { type: 'text', text } });
  }
  result(id, output, failed) {
    if (!id) return;
    this.transcript.update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: failed ? 'failed' : 'completed', content: [{ type: 'text', text: outputText(output) }] });
  }
}
