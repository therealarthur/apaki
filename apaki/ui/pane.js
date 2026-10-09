/**
 * pane.js: one conversation in Myrlin Apaki. A tab holds up to six panes;
 * each pane is its own Claude Code session with its own transcript, composer,
 * model, effort, permission mode and billing, and its own runner in the
 * engine (every command carries this pane's id).
 *
 * Moved here from the single-conversation app.js (2026-10-09) when Apaki got
 * tabs and split panes; the rendering is the same, now per pane instead of
 * one global transcript.
 *
 * The pane talks to the app through `host`:
 *   send(op, args), focus(pane), close(pane), voice(pane), folder(pane, value),
 *   changed(pane), dragPane(pane, event), defaults, folders(), sessions().
 */

import { esc, md } from './markdown.js';

// Images go in at most this many pixels on the long edge (the API's sweet
// spot, and under the 2000 px limit that breaks a session).
const IMAGE_MAX_EDGE = 1568;

const LOCAL = [
  { name: 'new', description: 'Start a new conversation in this pane' },
  { name: 'model', description: 'Switch model: opus, sonnet, haiku, fable or a full id' },
  { name: 'effort', description: 'Set effort: low, medium, high, xhigh, max' },
  { name: 'mode', description: 'Permission mode: bypassPermissions, acceptEdits, plan, default' },
  { name: 'key', description: 'Billing: follow Glass, subscription, or a vault key' },
  { name: 'folder', description: 'Move this conversation to a folder (name)' },
];
const MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };

export const short = (p) => String(p || '').replace(/^C:\\Users\\[^\\]+/i, '~');

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function toolArgs(name, input = {}) {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? input.skill ?? '';
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  return String(pick).replace(/\s+/g, ' ').slice(0, 160);
}

export class Pane {
  constructor(id, host, settings = {}) {
    this.id = id;
    this.host = host;
    this.sessionId = settings.sessionId || null;
    this.cwd = settings.cwd || '';
    this.title = settings.title || 'New conversation';
    this.model = settings.model || host.defaults.model;
    this.effort = settings.effort || host.defaults.effort;
    this.mode = settings.mode || host.defaults.mode;
    this.billing = host.defaults.billing;
    this.busy = false;
    this.unread = false;
    this.attachments = [];
    this.commands = [];
    this.streams = new Map();
    this.tools = new Map();
    this.slashSel = 0;
    this.curMsg = null;
    this.tick = null;
    this.turnStart = 0;

    this.el = document.getElementById('paneTpl').content.firstElementChild.cloneNode(true);
    this.el.dataset.pane = id;
    const q = (s) => this.el.querySelector(s);
    this.$ = {
      title: q('.title'), cwd: q('.cwd'), T: q('.transcript'), ground: q('.ground'), input: q('textarea'),
      send: q('.send'), status: q('.status'), slash: q('.slash'), attachments: q('.attachments'), composer: q('.composer'),
      file: q('input[type=file]'), mic: q('.mic'), model: q('.model'), effort: q('.effort'), mode: q('.mode'),
      folder: q('.folder'), billing: q('.billing'), close: q('.close'), gear: q('.gear'), grip: q('.grip'),
    };
    this.$.model.value = this.model;
    this.$.effort.value = this.effort;
    this.$.mode.value = this.mode;
    this.setTitle(this.title);
    this.wire();
    this.renderBilling();
    this.showEmpty();
  }

  send(op, args = {}) { return this.host.send(op, { paneId: this.id, ...args }); }

  /* ---------- wiring ---------- */

  wire() {
    const { input } = this.$;
    this.el.addEventListener('pointerdown', () => this.host.focus(this), true);
    this.el.addEventListener('focusin', () => this.host.focus(this));
    input.addEventListener('input', () => { this.autosize(); this.updateSlash(); });
    input.addEventListener('keydown', (e) => this.onKey(e));
    this.$.send.onclick = () => this.submit();
    this.$.file.addEventListener('change', async (e) => { for (const f of e.target.files) await this.addImageFile(f); e.target.value = ''; });
    this.$.mic.onclick = () => this.host.voice(this);
    this.$.model.onchange = (e) => this.setModel(e.target.value);
    this.$.effort.onchange = (e) => this.setEffort(e.target.value);
    this.$.mode.onchange = (e) => this.setMode(e.target.value);
    this.$.folder.onchange = (e) => this.host.folder(this, e.target.value);
    this.$.billing.onclick = () => this.send('billingOptions');
    this.$.close.onclick = () => this.host.close(this);
    this.$.gear.onclick = () => this.el.classList.toggle('show-controls');
    this.$.grip.addEventListener('dragstart', (e) => this.host.dragPane(this, e));
    this.$.grip.addEventListener('dragend', () => this.host.dragEnd());
  }

  onKey(e) {
    const { slash, input } = this.$;
    if (!slash.hidden) {
      const items = [...slash.children];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.slashSel = (this.slashSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; this.paintSlash(); return; }
      if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && items[this.slashSel]) {
        const name = items[this.slashSel].dataset.name;
        if (e.key === 'Tab' || input.value.trim() !== `/${name}`) { e.preventDefault(); input.value = `/${name} `; this.hideSlash(); return; }
      }
      if (e.key === 'Escape') { this.hideSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submit(); return; }
    if (e.key === 'Escape' && this.busy) { this.send('interrupt'); this.setStatus('Stopping…'); }
  }

  /* ---------- header ---------- */

  setTitle(title) {
    this.title = title || 'New conversation';
    this.$.title.textContent = this.title;
    this.$.title.title = this.title;
  }

  setCwdLine() {
    this.$.cwd.textContent = `${short(this.cwd)}${this.sessionId ? `  ·  ${this.sessionId}` : ''}`;
  }

  renderBilling() {
    const b = this.billing;
    if (!b) return;
    this.$.billing.innerHTML = `${esc(b.name)}<span class="src">${b.follow ? 'via Glass' : esc(b.source)}</span>`;
    this.$.billing.title = `Billing: ${b.name}`;
  }

  renderFolderSelect(folders, sessions) {
    const sel = this.$.folder;
    const cur = sessions.find((s) => s.id === this.sessionId)?.folder || '';
    sel.innerHTML = `<option value="">No folder</option>${folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}<option value="__new">New folder…</option>`;
    sel.value = cur;
    sel.disabled = !this.sessionId;
  }

  setModel(m) { this.model = m; this.$.model.value = m; this.send('model', { model: m }); this.host.changed(this); }
  setEffort(x) { this.effort = x; this.$.effort.value = x; this.send('effort', { effort: x }); this.host.changed(this); }
  setMode(x) { this.mode = x; this.$.mode.value = x; this.send('mode', { mode: x }); this.host.changed(this); }

  /* ---------- open ---------- */

  /** Opens a session here (null for a new conversation). warm=false waits for the first message to start Claude Code. */
  open(s, { warm = true } = {}) {
    const sessionId = s?.id || null;
    if (s?.title) this.setTitle(s.title);
    if (!sessionId) this.setTitle('New conversation');
    this.send('open', { sessionId, cwd: s?.cwd || this.cwd || null, warm, model: this.model, effort: this.effort, mode: this.mode });
  }

  showEmpty() {
    this.$.T.innerHTML = '';
    this.$.T.append(el('div', 'empty', `<img src="hat.svg" alt="" class="empty-mark"><p>New conversation. It becomes a Claude Code session with your first message.</p><p class="hint">Drag a session from the left onto an edge of this pane to split the view, up to six panes per tab. Ctrl+click a session to open it in a new tab.</p>`));
  }

  /* ---------- transcript ---------- */

  scrollDown(force = false) {
    const g = this.$.ground;
    if (force || g.scrollHeight - g.scrollTop - g.clientHeight < 160) g.scrollTop = g.scrollHeight;
  }

  note(text, tone = '') {
    const n = el('div', `note ${tone}`);
    n.textContent = text;
    this.$.T.append(n);
    this.scrollDown();
  }

  clearEmpty() { if (this.$.T.querySelector('.empty')) this.$.T.innerHTML = ''; }

  addUser(text, images = []) {
    this.clearEmpty();
    const u = el('div', 'turn-user');
    if (images.length) {
      const box = el('div', 'imgs');
      for (const im of images) { if (im.url) { const i = el('img'); i.src = im.url; box.append(i); } else box.append(el('span', 'img-marker', '[image]')); }
      u.append(box);
    }
    u.append(document.createTextNode(text));
    this.$.T.append(u);
    this.scrollDown(true);
  }

  addAssistant(text) {
    if (!text || !text.trim()) return null;
    const a = el('div', 'turn-assistant', md(text));
    this.$.T.append(a);
    this.scrollDown();
    return a;
  }

  addTool(block) {
    const d = el('details', 'tool');
    const label = block.name === 'Task' ? 'Agent' : block.name;
    d.innerHTML = `<summary><span class="dot">⏺</span><span class="name">${esc(label)}</span><span class="args">(${esc(toolArgs(block.name, block.input))})</span></summary><div class="sum">running…</div>`;
    if ((block.name === 'Edit' || block.name === 'MultiEdit') && block.input) {
      const edits = block.input.edits || [{ old_string: block.input.old_string, new_string: block.input.new_string }];
      const diff = edits.map((e) => `${String(e.old_string || '').split('\n').map((l) => `<span class="del">- ${esc(l)}</span>`).join('')}${String(e.new_string || '').split('\n').map((l) => `<span class="add">+ ${esc(l)}</span>`).join('')}`).join('');
      d.append(el('pre', 'diff', diff));
    } else if (block.input && (block.name === 'Write' || block.name === 'Bash' || block.name === 'PowerShell')) {
      d.append(el('pre', '', esc(block.input.content || block.input.command || '')));
    }
    this.$.T.append(d);
    this.tools.set(block.id, d);
    this.scrollDown();
  }

  toolResult(id, content, isError) {
    const d = this.tools.get(id);
    if (!d) return;
    const text = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : String(content ?? '');
    const lines = text.split('\n').filter((l) => l.trim());
    d.classList.add(isError ? 'err' : 'ok');
    d.querySelector('.sum').textContent = lines.length ? `${lines[0].slice(0, 200)}${lines.length > 1 ? `  … +${lines.length - 1} lines` : ''}` : '(no output)';
    const pre = el('pre');
    pre.textContent = text.slice(0, 20000);
    d.append(pre);
  }

  renderBlocks(role, content, { images } = {}) {
    if (typeof content === 'string') { if (role === 'user') this.addUser(content, images); else this.addAssistant(content); return; }
    if (!Array.isArray(content)) return;
    if (role === 'user') {
      const texts = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      const imgs = content.filter((b) => b.type === 'image' || b.type === 'image_marker');
      if ((texts && !/^<(command-|local-command-|task-notification)/.test(texts)) || imgs.length) this.addUser(texts, imgs.map(() => ({})));
      for (const b of content) if (b.type === 'tool_result') this.toolResult(b.tool_use_id, b.content, b.is_error);
      return;
    }
    for (const b of content) {
      if (b.type === 'text') this.addAssistant(b.text);
      else if (b.type === 'tool_use') this.addTool(b);
    }
  }

  renderHistory(messages, total) {
    this.$.T.innerHTML = '';
    this.tools.clear();
    if (total > messages.length) this.note(`Showing the latest ${messages.length} of ${total} messages. The whole conversation is in the session.`);
    for (const m of messages) {
      if (m.parent_tool_use_id) continue; // subagent traffic
      if (m.type !== 'user' && m.type !== 'assistant') continue;
      const c = m.message?.content;
      if (m.type === 'user' && typeof c === 'string' && (/^\s*<(command-|local-command-|system-reminder)/.test(c))) continue;
      this.renderBlocks(m.type, c);
    }
    this.scrollDown(true);
  }

  /* ---------- live SDK messages ---------- */

  onSdk(msg) {
    if (msg.parent_tool_use_id) return;
    const T = this.$.T;
    if (msg.type === 'stream_event') {
      const ev = msg.event || {};
      if (ev.type === 'message_start') this.curMsg = ev.message?.id;
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
        this.clearEmpty();
        const a = el('div', 'turn-assistant streaming');
        T.append(a);
        this.streams.set(`${this.curMsg}:${ev.index}`, a);
      }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') this.setStatus('Thinking…');
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        const a = this.streams.get(`${this.curMsg}:${ev.index}`);
        if (a) { a.textContent += ev.delta.text; this.scrollDown(); }
      }
      return;
    }
    if (msg.type === 'assistant') {
      const id = msg.message?.id;
      (msg.message?.content || []).forEach((b, i) => {
        // The SDK can send each block of a message on its own (index 0), while
        // the stream numbered it after a thinking block; so fall back to the
        // oldest open stream of the same message, or the reply is drawn twice.
        let key = `${id}:${i}`;
        if (!this.streams.has(key)) key = [...this.streams.keys()].find((k) => k.startsWith(`${id}:`)) || key;
        const live = this.streams.get(key);
        if (b.type === 'text') {
          if (live) { live.classList.remove('streaming'); live.innerHTML = md(b.text); this.streams.delete(key); } else this.addAssistant(b.text);
        } else if (b.type === 'tool_use') {
          this.addTool(b);
        }
      });
      if (msg.error) this.note(String(msg.error), 'error');
      return;
    }
    if (msg.type === 'user') {
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const b of content) if (b.type === 'tool_result') this.toolResult(b.tool_use_id, b.content, b.is_error);
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') this.note('Conversation compacted.');
  }

  /* ---------- status, busy state ---------- */

  setStatus(text) { this.$.status.textContent = text; }

  setBusy(on) {
    this.busy = on;
    this.$.send.textContent = on ? 'Stop' : 'Send';
    this.$.send.classList.toggle('stop', on);
    this.el.classList.toggle('busy', on);
    clearInterval(this.tick);
    if (on) {
      this.turnStart = Date.now();
      this.tick = setInterval(() => this.setStatus(`Working · ${Math.round((Date.now() - this.turnStart) / 1000)}s · esc to stop`), 500);
      this.setStatus('Working…');
    }
    this.host.changed(this);
  }

  /* ---------- send ---------- */

  localCommand(text) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'new': case 'clear': this.host.newConversation(this); return true;
      case 'model': if (arg) this.setModel(MODELS[arg] || arg); else this.note(`Model: ${this.model}`); return true;
      case 'effort': if (arg) this.setEffort(arg); else this.note(`Effort: ${this.effort}`); return true;
      case 'mode': if (arg) this.setMode(arg); else this.note(`Mode: ${this.mode}`); return true;
      case 'key': this.send('billingOptions'); return true;
      case 'folder': if (arg && this.sessionId) this.send('folder', { action: 'create', name: arg, sessionId: this.sessionId }); return true;
      default: return false;
    }
  }

  submit() {
    if (this.busy) { this.send('interrupt'); this.setStatus('Stopping…'); return; }
    const { input } = this.$;
    const text = input.value.trim();
    if (!text && !this.attachments.length) return;
    this.hideSlash();
    if (text.startsWith('/') && !this.attachments.length && this.localCommand(text)) { input.value = ''; this.autosize(); return; }
    const images = this.attachments.map(({ media_type, data }) => ({ media_type, data }));
    this.addUser(text, this.attachments);
    this.attachments = [];
    this.renderAttachments();
    input.value = '';
    this.autosize();
    this.setBusy(true);
    this.send('send', { text, images });
  }

  /* ---------- composer ---------- */

  autosize() {
    const { input } = this.$;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, this.el.clientHeight * 0.4 || window.innerHeight * 0.4)}px`;
  }

  updateSlash() {
    const v = this.$.input.value;
    const m = v.match(/^\/(\S*)$/);
    if (!m) { this.hideSlash(); return; }
    const q = m[1].toLowerCase();
    const all = [...LOCAL, ...this.commands.filter((c) => !LOCAL.some((l) => l.name === c.name))];
    const hits = all.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1)).slice(0, 40);
    const ul = this.$.slash;
    ul.innerHTML = '';
    for (const c of hits) {
      const li = el('li', '', `<span class="n">/${esc(c.name)}</span><span class="d">${esc(c.description || '')}</span>`);
      li.dataset.name = c.name;
      li.onmousedown = (e) => { e.preventDefault(); this.$.input.value = `/${c.name} `; this.hideSlash(); this.$.input.focus(); };
      ul.append(li);
    }
    ul.hidden = !hits.length;
    this.slashSel = 0;
    this.paintSlash();
  }

  paintSlash() { [...this.$.slash.children].forEach((li, i) => li.classList.toggle('on', i === this.slashSel)); }

  hideSlash() { this.$.slash.hidden = true; }

  /* ---------- images ---------- */

  async addImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const type = file.type === 'image/png' && w * h < 1200 * 1200 ? 'image/png' : 'image/jpeg';
    const url = canvas.toDataURL(type, 0.9);
    this.attachments.push({ media_type: type, data: url.split(',')[1], url, w, h });
    this.renderAttachments();
  }

  renderAttachments() {
    const box = this.$.attachments;
    box.innerHTML = '';
    this.attachments.forEach((a, i) => {
      const c = el('div', 'chip', `<img src="${a.url}" alt=""><span class="dim">${a.w}×${a.h}</span>`);
      const x = el('button', '', '×');
      x.title = 'Remove';
      x.onclick = () => { this.attachments.splice(i, 1); this.renderAttachments(); };
      c.append(x);
      box.append(c);
    });
  }

  setVoice(available) {
    this.$.mic.disabled = !available;
    this.$.mic.title = available ? 'Dictate (local Whisper): click to start, click again to stop' : 'Voice needs whisper.cpp in Programs\\Myrlin Apaki\\voice';
  }

  /* ---------- engine events for this pane ---------- */

  handle(e) {
    switch (e.ev) {
      case 'opened':
        this.sessionId = e.sessionId; this.cwd = e.cwd; this.billing = e.billing;
        this.streams.clear(); this.tools.clear();
        this.setTitle(e.title || 'New conversation');
        this.setCwdLine();
        this.renderBilling();
        if (e.sessionId) this.$.T.innerHTML = '';
        else this.showEmpty();
        if (e.terminal?.length) this.note(`This session is also open in a Claude Code terminal window (${e.terminal.map((t) => t.name).join(', ')}). Stop typing there while you work here; that window must /resume to see these turns.`, 'warn');
        this.send('commands');
        this.host.changed(this);
        break;
      case 'history': if (e.sessionId === this.sessionId) this.renderHistory(e.messages, e.total); break;
      case 'session_id': this.sessionId = e.sessionId; this.setCwdLine(); this.host.changed(this); break;
      case 'sdk': this.onSdk(e.msg); break;
      case 'result': {
        this.setBusy(false);
        const u = e.usage || {};
        const k = (n) => `${((n || 0) / 1000).toFixed(1)}k`;
        const foot = [`${((e.durationMs || 0) / 1000).toFixed(1)}s`, `${k(u.cache_read_input_tokens)} cached`, `${k(u.cache_creation_input_tokens)} new`, e.cost != null ? `$${e.cost.toFixed(3)}` : null, this.billing?.name].filter(Boolean).join(' · ');
        this.$.T.append(el('div', 'foot', esc(foot)));
        if (e.isError) this.note(e.result || (e.errors || []).join('; ') || e.subtype, 'error');
        this.setStatus('');
        this.scrollDown();
        if (!this.commands.length) this.send('commands');
        break;
      }
      case 'billing': this.billing = e; this.renderBilling(); if (e.note) this.note(e.note); break;
      case 'commands': this.commands = e.commands || []; break;
      case 'note': this.note(e.text, e.tone || ''); break;
      case 'error': this.setBusy(false); this.setStatus(''); this.note(e.message, 'error'); break;
      case 'transcript': {
        if (!this.busy) this.setStatus(e.text ? `Transcribed in ${(e.ms / 1000).toFixed(1)}s` : 'Heard nothing');
        const { input } = this.$;
        if (e.text) { input.value = input.value ? `${input.value.replace(/\s*$/, '')} ${e.text}` : e.text; this.autosize(); input.focus(); }
        break;
      }
      default: break;
    }
  }

  /** Called when the engine restarted: every Claude Code process is gone. */
  engineLost() {
    if (this.busy) { this.setBusy(false); this.note('The engine stopped and is restarting; send your message again.', 'warn'); }
    this.setStatus('');
  }

  destroy() {
    clearInterval(this.tick);
    this.el.remove();
  }
}
