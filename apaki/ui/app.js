/**
 * app.js: Myrlin Apaki's window. Talks to the engine (apaki/engine/engine.js)
 * through the Rust shell: `engine_send` sends a command, `engine` events bring
 * everything back. The engine is latch's Claude Code runner, so a turn here is
 * a turn in the Claude Code session itself.
 */

import { esc, md } from './markdown.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

// Images go in at most this many pixels on the long edge (the API's sweet
// spot, and under the 2000 px limit that breaks a session).
const IMAGE_MAX_EDGE = 1568;
const SEARCH_DEBOUNCE_MS = 160;

const S = {
  sessions: [], folders: [], view: 'all', query: '', results: null, searchInfo: '',
  open: null, cwd: '', busy: false, turnStart: 0, attachments: [], commands: [],
  billing: null, model: 'claude-opus-5-5', effort: 'xhigh', mode: 'bypassPermissions',
  streams: new Map(), tools: new Map(), slashSel: 0, seq: 0,
};

function send(op, args = {}) {
  return invoke('engine_send', { msg: { op, reqId: `r${++S.seq}`, ...args } }).catch((e) => note(String(e), 'error'));
}

/* ---------- formatting helpers ---------- */

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const short = (p) => String(p || '').replace(/^C:\\Users\\[^\\]+/i, '~');
const kindLabel = (kind = '', codex = false) => {
  const agent = kind.startsWith('agent-');
  const base = agent ? kind.slice(6) : kind;
  const who = { prompt: 'you', reply: codex ? 'codex' : 'claude', tool: 'tool call', result: 'tool output' }[base] || base;
  return agent ? `subagent ${who}` : who;
};
function highlight(text, query) {
  let h = esc(text || '');
  for (const w of query.toLowerCase().split(/\s+/).filter((x) => x.length > 1)) {
    h = h.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<b>$1</b>');
  }
  return h;
}

/* ---------- rail ---------- */

function viewList() {
  const term = S.sessions.filter((s) => s.terminal).length;
  return [
    { id: 'all', label: 'All', n: S.sessions.length },
    { id: 'terminal', label: 'Open in terminal', n: term },
    ...S.folders.map((f) => ({ id: f.id, label: f.name, n: f.sessions.length, folder: f })),
  ];
}

function inView(s) {
  if (S.view === 'all') return true;
  if (S.view === 'terminal') return Boolean(s.terminal);
  const f = S.folders.find((x) => x.id === S.view);
  return Boolean(f && f.sessions.includes(s.id));
}

function renderRail() {
  const views = $('views');
  views.innerHTML = '';
  for (const v of viewList()) {
    const b = el('button', v.id === S.view ? 'on' : '', `${esc(v.label)}<span class="count">${v.n}</span>`);
    b.onclick = () => { S.view = v.id; renderRail(); };
    if (v.folder) {
      b.oncontextmenu = (e) => {
        e.preventDefault();
        const name = window.prompt(`Rename folder "${v.folder.name}" (leave empty to delete it; sessions stay where they are)`, v.folder.name);
        if (name === null) return;
        if (!name.trim()) { if (window.confirm(`Delete folder "${v.folder.name}"?`)) { send('folder', { action: 'delete', folderId: v.folder.id }); S.view = 'all'; } return; }
        send('folder', { action: 'rename', folderId: v.folder.id, name });
      };
    }
    views.append(b);
  }
  let rows;
  if (S.results) {
    rows = S.results.filter((r) => inView(r.item)).map((r) => ({ ...r.item, kind: r.kind, snippet: r.snippet, hits: r.hits }));
  } else {
    rows = S.sessions.filter(inView).sort((a, b) => (Boolean(b.terminal) - Boolean(a.terminal)) || (b.lastModified - a.lastModified));
  }
  $('searchState').textContent = S.results ? S.searchInfo : '';
  const list = $('sessions');
  list.innerHTML = '';
  const folderName = (id) => S.folders.find((f) => f.id === id)?.name;
  for (const s of rows.slice(0, 400)) {
    const li = el('li', s.id === S.open ? 'on' : '');
    const meta = [
      s.codex ? '<span class="codex">codex · read-only</span>' : '',
      s.terminal ? `<span class="live">terminal${s.terminal.status ? ` · ${esc(s.terminal.status)}` : ''}</span>` : '',
      ago(s.lastModified), esc(short(s.cwd)),
      S.view === 'all' && s.folder ? `▸ ${esc(folderName(s.folder) || '')}` : '',
    ].filter(Boolean).join(' · ');
    li.innerHTML = `<div class="t">${esc(s.title || '(untitled)')}</div><div class="m">${meta}</div>${s.snippet ? `<div class="snip">${esc(kindLabel(s.kind, s.codex))}: ${highlight(s.snippet, S.query)}${s.hits > 1 ? ` <span class="mono">(${s.hits})</span>` : ''}</div>` : ''}`;
    li.onclick = () => openSession(s);
    list.append(li);
  }
  if (!rows.length) list.append(el('li', 'note', S.results ? 'Nothing matches in this view.' : 'No sessions here yet.'));
  renderFolderSelect();
}

function renderFolderSelect() {
  const sel = $('folder');
  const cur = S.sessions.find((s) => s.id === S.open)?.folder || '';
  sel.innerHTML = `<option value="">No folder</option>${S.folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}<option value="__new">New folder…</option>`;
  sel.value = cur;
  sel.disabled = !S.open;
}

let searchTimer = null;
$('q').addEventListener('input', (e) => {
  S.query = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!S.query) { S.results = null; renderRail(); return; }
  searchTimer = setTimeout(() => send('search', { query: S.query }), SEARCH_DEBOUNCE_MS);
});
$('q').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; S.query = ''; S.results = null; renderRail(); } });

/* ---------- transcript ---------- */

const T = () => $('transcript');
function scrollDown(force = false) {
  const g = document.querySelector('.ground');
  if (force || g.scrollHeight - g.scrollTop - g.clientHeight < 160) g.scrollTop = g.scrollHeight;
}
function note(text, tone = '') { const n = el('div', `note ${tone}`); n.textContent = text; T().append(n); scrollDown(); }

function addUser(text, images = []) {
  const u = el('div', 'turn-user');
  if (images.length) {
    const box = el('div', 'imgs');
    for (const im of images) { if (im.url) { const i = el('img'); i.src = im.url; box.append(i); } else box.append(el('span', 'img-marker', '[image]')); }
    u.append(box);
  }
  u.append(document.createTextNode(text));
  T().append(u);
  scrollDown(true);
}

function addAssistant(text) {
  if (!text || !text.trim()) return null;
  const a = el('div', 'turn-assistant', md(text));
  T().append(a);
  scrollDown();
  return a;
}

function toolArgs(name, input = {}) {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? input.skill ?? '';
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  return String(pick).replace(/\s+/g, ' ').slice(0, 160);
}

function addTool(block) {
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
  T().append(d);
  S.tools.set(block.id, d);
  scrollDown();
}

function toolResult(id, content, isError) {
  const d = S.tools.get(id);
  if (!d) return;
  const text = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : String(content ?? '');
  const lines = text.split('\n').filter((l) => l.trim());
  d.classList.add(isError ? 'err' : 'ok');
  d.querySelector('.sum').textContent = lines.length ? `${lines[0].slice(0, 200)}${lines.length > 1 ? `  … +${lines.length - 1} lines` : ''}` : '(no output)';
  const pre = el('pre');
  pre.textContent = text.slice(0, 20000);
  d.append(pre);
}

function renderBlocks(role, content, { images } = {}) {
  if (typeof content === 'string') { if (role === 'user') addUser(content, images); else addAssistant(content); return; }
  if (!Array.isArray(content)) return;
  if (role === 'user') {
    const texts = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    const imgs = content.filter((b) => b.type === 'image' || b.type === 'image_marker');
    if ((texts && !/^<(command-|local-command-|task-notification)/.test(texts)) || imgs.length) addUser(texts, imgs.map(() => ({})));
    for (const b of content) if (b.type === 'tool_result') toolResult(b.tool_use_id, b.content, b.is_error);
    return;
  }
  for (const b of content) {
    if (b.type === 'text') addAssistant(b.text);
    else if (b.type === 'tool_use') addTool(b);
  }
}

function renderHistory(messages, total) {
  T().innerHTML = '';
  S.tools.clear();
  if (total > messages.length) note(`Showing the latest ${messages.length} of ${total} messages. The whole conversation is in the session.`);
  for (const m of messages) {
    if (m.parent_tool_use_id) continue; // subagent traffic
    if (m.type !== 'user' && m.type !== 'assistant') continue;
    const c = m.message?.content;
    if (m.type === 'user' && typeof c === 'string' && (/^\s*<(command-|local-command-|system-reminder)/.test(c))) continue;
    renderBlocks(m.type, c);
  }
  scrollDown(true);
}

/* ---------- live SDK messages ---------- */

function onSdk(msg) {
  if (msg.parent_tool_use_id) return;
  if (msg.type === 'stream_event') {
    const ev = msg.event || {};
    if (ev.type === 'message_start') S.curMsg = ev.message?.id;
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
      const a = el('div', 'turn-assistant streaming');
      T().append(a);
      S.streams.set(`${S.curMsg}:${ev.index}`, a);
    }
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') setStatus('Thinking…');
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      const a = S.streams.get(`${S.curMsg}:${ev.index}`);
      if (a) { a.textContent += ev.delta.text; scrollDown(); }
    }
    return;
  }
  if (msg.type === 'assistant') {
    const id = msg.message?.id;
    const content = msg.message?.content || [];
    content.forEach((b, i) => {
      const live = S.streams.get(`${id}:${i}`);
      if (b.type === 'text') {
        if (live) { live.classList.remove('streaming'); live.innerHTML = md(b.text); S.streams.delete(`${id}:${i}`); } else addAssistant(b.text);
      } else if (b.type === 'tool_use') {
        addTool(b);
      }
    });
    if (msg.error) note(String(msg.error), 'error');
    return;
  }
  if (msg.type === 'user') {
    const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
    for (const b of content) if (b.type === 'tool_result') toolResult(b.tool_use_id, b.content, b.is_error);
    return;
  }
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') note('Conversation compacted.');
}

/* ---------- status, busy state ---------- */

let tick = null;
function setStatus(text) { $('status').textContent = text; }
function setBusy(on) {
  S.busy = on;
  $('sendBtn').textContent = on ? 'Stop' : 'Send';
  $('sendBtn').classList.toggle('stop', on);
  clearInterval(tick);
  if (on) {
    S.turnStart = Date.now();
    tick = setInterval(() => setStatus(`Working · ${Math.round((Date.now() - S.turnStart) / 1000)}s · esc to stop`), 500);
    setStatus('Working…');
  }
}

/* ---------- open / send ---------- */

function openSession(s) {
  if (s.codex) { send('open', { sessionId: s.id }); return; }
  if (S.busy) { note('Wait for the current turn to finish, or press Stop.', 'warn'); return; }
  send('open', { sessionId: s.id, cwd: s.cwd || null });
}

$('new').onclick = () => {
  if (S.busy) return;
  const cur = S.sessions.find((s) => s.id === S.open);
  send('open', { sessionId: null, cwd: cur?.cwd || null });
};

const LOCAL = [
  { name: 'new', description: 'Start a new conversation' },
  { name: 'model', description: 'Switch model: opus, sonnet, haiku, fable or a full id' },
  { name: 'effort', description: 'Set effort: low, medium, high, xhigh, max' },
  { name: 'mode', description: 'Permission mode: bypassPermissions, acceptEdits, plan, default' },
  { name: 'key', description: 'Billing: follow Glass, subscription, or a vault key' },
  { name: 'folder', description: 'Move this conversation to a folder (name)' },
];
const MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };

function localCommand(text) {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case 'new': case 'clear': $('new').click(); return true;
    case 'model': if (arg) setModel(MODELS[arg] || arg); else note(`Model: ${S.model}`); return true;
    case 'effort': if (arg) setEffort(arg); else note(`Effort: ${S.effort}`); return true;
    case 'mode': if (arg) setMode(arg); else note(`Mode: ${S.mode}`); return true;
    case 'key': openBilling(); return true;
    case 'folder': if (arg && S.open) send('folder', { action: 'create', name: arg, sessionId: S.open }); return true;
    default: return false;
  }
}

function submit() {
  if (S.busy) { send('interrupt'); setStatus('Stopping…'); return; }
  const input = $('input');
  const text = input.value.trim();
  if (!text && !S.attachments.length) return;
  hideSlash();
  if (text.startsWith('/') && !S.attachments.length && localCommand(text)) { input.value = ''; autosize(); return; }
  const images = S.attachments.map(({ media_type, data }) => ({ media_type, data }));
  if (T().querySelector('.empty')) T().innerHTML = '';
  addUser(text, S.attachments);
  S.attachments = [];
  renderAttachments();
  input.value = '';
  autosize();
  setBusy(true);
  send('send', { text, images });
}

/* ---------- composer ---------- */

const input = $('input');
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`; }
input.addEventListener('input', () => { autosize(); updateSlash(); });
input.addEventListener('keydown', (e) => {
  const slash = $('slash');
  if (!slash.hidden) {
    const items = [...slash.children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); S.slashSel = (S.slashSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paintSlash(); return; }
    if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && items[S.slashSel]) {
      const name = items[S.slashSel].dataset.name;
      if (e.key === 'Tab' || input.value.trim() !== `/${name}`) { e.preventDefault(); input.value = `/${name} `; hideSlash(); return; }
    }
    if (e.key === 'Escape') { hideSlash(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
  if (e.key === 'Escape' && S.busy) { send('interrupt'); setStatus('Stopping…'); }
});
$('sendBtn').onclick = submit;

function updateSlash() {
  const v = input.value;
  const m = v.match(/^\/(\S*)$/);
  if (!m) { hideSlash(); return; }
  const q = m[1].toLowerCase();
  const all = [...LOCAL, ...S.commands.filter((c) => !LOCAL.some((l) => l.name === c.name))];
  const hits = all.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1)).slice(0, 40);
  const ul = $('slash');
  ul.innerHTML = '';
  for (const c of hits) {
    const li = el('li', '', `<span class="n">/${esc(c.name)}</span><span class="d">${esc(c.description || '')}</span>`);
    li.dataset.name = c.name;
    li.onmousedown = (e) => { e.preventDefault(); input.value = `/${c.name} `; hideSlash(); input.focus(); };
    ul.append(li);
  }
  ul.hidden = !hits.length;
  S.slashSel = 0;
  paintSlash();
}
function paintSlash() { [...$('slash').children].forEach((li, i) => li.classList.toggle('on', i === S.slashSel)); }
function hideSlash() { $('slash').hidden = true; }

/* ---------- images ---------- */

async function addImageFile(file) {
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
  S.attachments.push({ media_type: type, data: url.split(',')[1], url, w, h });
  renderAttachments();
}

function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  S.attachments.forEach((a, i) => {
    const c = el('div', 'chip', `<img src="${a.url}" alt=""><span class="dim">${a.w}×${a.h}</span>`);
    const x = el('button', '', '×');
    x.title = 'Remove';
    x.onclick = () => { S.attachments.splice(i, 1); renderAttachments(); };
    c.append(x);
    box.append(c);
  });
}

$('file').addEventListener('change', async (e) => { for (const f of e.target.files) await addImageFile(f); e.target.value = ''; });
document.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile());
  if (files.length) { e.preventDefault(); for (const f of files) await addImageFile(f); }
});
const composer = $('composer');
document.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('drop'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) composer.classList.remove('drop'); });
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  composer.classList.remove('drop');
  for (const f of e.dataTransfer?.files || []) await addImageFile(f);
});

/* ---------- header controls ---------- */

function setModel(m) { S.model = m; $('model').value = m; send('model', { model: m }); }
function setEffort(x) { S.effort = x; $('effort').value = x; send('effort', { effort: x }); }
function setMode(x) { S.mode = x; $('mode').value = x; send('mode', { mode: x }); }
$('model').onchange = (e) => setModel(e.target.value);
$('effort').onchange = (e) => setEffort(e.target.value);
$('mode').onchange = (e) => setMode(e.target.value);
$('folder').onchange = (e) => {
  const v = e.target.value;
  if (v === '__new') {
    const name = window.prompt('New folder name');
    if (name && name.trim()) send('folder', { action: 'create', name, sessionId: S.open });
    renderFolderSelect();
    return;
  }
  send('folder', { action: 'move', sessionId: S.open, folderId: v || null });
};

function renderBilling() {
  const b = S.billing;
  if (!b) return;
  $('billing').innerHTML = `${esc(b.name)}<span class="src">${b.follow ? 'via Glass' : b.source}</span>`;
}
$('billing').onclick = () => openBilling();
function openBilling() { send('billingOptions'); }

/* ---------- sheets ---------- */

function sheet(html, wire) {
  $('sheet').innerHTML = html;
  $('scrim').hidden = false;
  wire($('sheet'), () => { $('scrim').hidden = true; });
}

function askSheet(e) {
  const input = e.input || {};
  const reply = (result) => send('answer', { askId: e.askId, result });
  if (e.toolName === 'ExitPlanMode') {
    sheet(`<h2>Ready to code?</h2><div class="turn-assistant plan">${md(input.plan || '')}</div>
      <div class="row"><button data-k="keep">Keep planning</button><button class="primary" data-k="go">Approve</button></div>`, (root, close) => {
      root.querySelector('[data-k=go]').onclick = () => { close(); reply({ behavior: 'allow', updatedInput: input }); if (S.mode === 'plan') setMode('bypassPermissions'); };
      root.querySelector('[data-k=keep]').onclick = () => { close(); reply({ behavior: 'deny', message: 'The user wants to keep planning.' }); };
    });
    return;
  }
  const qs = input.questions || [];
  const picks = qs.map(() => new Set());
  const html = `<h2>Claude has ${qs.length === 1 ? 'a question' : `${qs.length} questions`}</h2>${qs.map((q, qi) => `
    <div class="q">${esc(q.question)}</div>
    ${(q.options || []).map((o, oi) => `<button class="opt" data-q="${qi}" data-o="${oi}">${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`).join('')}
    <input type="text" data-other="${qi}" placeholder="Or type your own answer">`).join('')}
    <div class="row"><button data-k="skip">Skip</button><button class="primary" data-k="ok">Answer</button></div>`;
  sheet(html, (root, close) => {
    root.querySelectorAll('.opt').forEach((b) => {
      b.onclick = () => {
        const qi = Number(b.dataset.q);
        const oi = Number(b.dataset.o);
        if (!qs[qi].multiSelect) { picks[qi].clear(); root.querySelectorAll(`.opt[data-q="${qi}"]`).forEach((x) => x.classList.remove('on')); }
        if (picks[qi].has(oi)) picks[qi].delete(oi); else picks[qi].add(oi);
        b.classList.toggle('on', picks[qi].has(oi));
      };
    });
    root.querySelector('[data-k=ok]').onclick = () => {
      const answers = {};
      qs.forEach((q, qi) => {
        const other = root.querySelector(`[data-other="${qi}"]`).value.trim();
        answers[q.question] = other || [...picks[qi]].map((oi) => q.options[oi].label).join(', ');
      });
      close();
      reply({ behavior: 'allow', updatedInput: { ...input, answers } });
    };
    root.querySelector('[data-k=skip]').onclick = () => { close(); reply({ behavior: 'deny', message: 'The user skipped the question.' }); };
  });
}

function billingSheet(options) {
  const html = `<h2>Billing</h2><div class="note">Following Glass moves this conversation whenever Glass switches Claude between Platform credits and a subscription.</div>
    ${options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o.label)}</button>`).join('')}
    <div class="row"><button data-k="x">Cancel</button></div>`;
  sheet(html, (root, close) => {
    root.querySelectorAll('.opt').forEach((b) => { b.onclick = () => { close(); send('billing', { value: options[Number(b.dataset.i)].value }); }; });
    root.querySelector('[data-k=x]').onclick = close;
  });
}

/* ---------- engine events ---------- */

listen('engine', ({ payload: e }) => {
  switch (e.ev) {
    case 'ready':
      S.billing = e.billing; S.model = e.model; S.effort = e.effort;
      $('model').value = S.model; $('effort').value = S.effort; $('mode').value = S.mode;
      renderBilling();
      send('sessions');
      break;
    case 'index':
      $('indexState').textContent = e.ok ? `Index up to date · ${e.stats?.blocks_added ?? 0} new blocks · ${(e.ms / 1000).toFixed(1)}s` : 'Conversation index unavailable; search uses titles only.';
      break;
    case 'sessions':
      S.sessions = e.items; S.folders = e.folders; S.billing = e.billing || S.billing;
      renderBilling();
      renderRail();
      break;
    case 'folders':
      S.folders = e.folders;
      send('sessions');
      break;
    case 'search':
      if (e.query !== S.query) break;
      S.results = e.results;
      S.searchInfo = e.deep ? `${e.results.length} sessions · every conversation, subagent and Codex session searched in ${e.elapsed} ms` : `${e.results.length} sessions by title (index unavailable)`;
      renderRail();
      break;
    case 'opened': {
      S.open = e.sessionId; S.cwd = e.cwd; S.billing = e.billing;
      S.streams.clear(); S.tools.clear();
      $('title').textContent = e.title || 'New conversation';
      $('cwd').textContent = `${short(e.cwd)}${e.sessionId ? `  ·  ${e.sessionId}` : ''}`;
      renderBilling();
      T().innerHTML = '';
      if (!e.sessionId) note('New conversation. It becomes a Claude Code session with your first message.');
      if (e.terminal?.length) note(`This session is also open in a Claude Code terminal window (${e.terminal.map((t) => t.name).join(', ')}). Stop typing there while you work here; that window must /resume to see these turns.`, 'warn');
      renderRail();
      send('commands');
      input.focus();
      break;
    }
    case 'history': if (e.sessionId === S.open) renderHistory(e.messages, e.total); break;
    case 'session_id': S.open = e.sessionId; $('cwd').textContent = `${short(S.cwd)}  ·  ${e.sessionId}`; break;
    case 'sdk': onSdk(e.msg); break;
    case 'result': {
      setBusy(false);
      const u = e.usage || {};
      const k = (n) => `${((n || 0) / 1000).toFixed(1)}k`;
      const foot = [`${((e.durationMs || 0) / 1000).toFixed(1)}s`, `${k(u.cache_read_input_tokens)} cached`, `${k(u.cache_creation_input_tokens)} new`, e.cost != null ? `$${e.cost.toFixed(3)}` : null, S.billing?.name].filter(Boolean).join(' · ');
      T().append(el('div', 'foot', esc(foot)));
      if (e.isError) note(e.result || (e.errors || []).join('; ') || e.subtype, 'error');
      setStatus('');
      scrollDown();
      break;
    }
    case 'ask': askSheet(e); break;
    case 'billing': S.billing = e; renderBilling(); if (e.note) note(e.note); break;
    case 'billingOptions': billingSheet(e.options); break;
    case 'commands': S.commands = e.commands || []; break;
    case 'note': note(e.text, e.tone || ''); break;
    case 'error': setBusy(false); setStatus(''); note(e.message, 'error'); break;
    case 'engine_exit': setBusy(false); note('The engine stopped and is restarting…', 'warn'); break;
    default: break;
  }
});

// Ask the engine for its state in case it was ready before this page loaded.
send('sessions');
// Sessions open in terminals change on their own: refresh the list now and then.
setInterval(() => { if (!S.busy && !S.query) send('sessions'); }, 15000);
