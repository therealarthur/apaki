/**
 * codex-map.js: what the Codex app-server says, in the shapes Apaki's panes already draw.
 *
 * WHY (Arthur, 2026-10-11: a Codex pane should match OpenAI's Codex app, and look native in Apaki): Apaki's pane
 * (apaki/ui/pane.js) draws Claude Code's SDK messages: streamed text, thinking, tool_use blocks with their
 * tool_result, TodoWrite as a checklist, hook and limit notices. Instead of a second renderer, the Codex events are
 * translated into those messages here, so a command run is a Bash line with its output, a plan is the same checklist,
 * history pages the same way and the phone page (which shares the pane code) gets it all without a line of its own.
 * Only what Claude has no word for (a patch with diffs, a Codex approval, the model list) is a Codex-only shape.
 *
 * Everything in this file is pure: plain objects in, plain objects out, no I/O. test/apaki-codex-map.test.js checks
 * it against recorded traffic; codex-panes.js adds the state (which stream is open, which request waits).
 *
 * Item shapes (ThreadItem, measured on real threads, codex-cli 0.161.0, 2026-10-12):
 *   userMessage{content: UserInput[]}  agentMessage{text, phase}  reasoning{summary[], content[]}
 *   commandExecution{command, cwd, status, aggregatedOutput, exitCode, durationMs, commandActions}
 *   fileChange{changes: [{path, kind: {type: add|update|delete, move_path}, diff}], status}
 *   mcpToolCall{server, tool, arguments, status, result: {content[]}, error}  webSearch{query, action, results[]}
 *   dynamicToolCall  imageView{path}  imageGeneration  plan{text}  contextCompaction  subAgentActivity
 *   collabAgentToolCall  functionCallOutput{name, output}  hookPrompt  sleep  enteredReviewMode  exitedReviewMode
 */

import { codexPromptText } from '../../src/codex.js';

export const CODEX_PREFIX = 'codex:';

/** `codex:<thread id>`, the id Apaki's lists, panes and search use for a Codex thread. */
export const codexId = (threadId) => `${CODEX_PREFIX}${threadId}`;
/** The thread id inside a `codex:` id (or the id itself when it has no prefix). */
export const threadIdOf = (id) => String(id || '').replace(/^codex:/, '');
export const isCodexSessionId = (id) => String(id || '').startsWith(CODEX_PREFIX);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}\n... (${t.length - n} more characters)` : t; };
export const iso = (sec) => (Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null);

/* ---------- approval and sandbox presets (the Codex app's own three) ---------- */

/**
 * The Codex app's permission presets, in the order its picker lists them:
 *   read-only    reads files; asks before it edits or reaches the network
 *   auto         edits inside the workspace; asks for anything outside it
 *   full-access  runs everything without asking (danger-full-access, approvals never): Arthur's "bypass session"
 * `sandbox` is the thread/start and thread/resume form (SandboxMode), `sandboxPolicy` the turn/start form.
 */
export const PRESETS = Object.freeze({
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
  'full-access': { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } },
});
export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));
export const DEFAULT_PRESET = 'auto';

export const isPreset = (m) => Object.prototype.hasOwnProperty.call(PRESETS, m);

/** The sandbox as a mode name, whether the server sent a SandboxMode string or a SandboxPolicy object. */
function sandboxName(sandbox) {
  const t = isObj(sandbox) ? sandbox.type : sandbox;
  if (t === 'dangerFullAccess' || t === 'danger-full-access') return 'danger-full-access';
  if (t === 'readOnly' || t === 'read-only') return 'read-only';
  if (t === 'workspaceWrite' || t === 'workspace-write') return 'workspace-write';
  return t ? String(t) : '';
}

/**
 * The preset a thread's settings amount to. Anything that is not clearly read-only or full access reads as auto, the
 * Codex app's middle preset (an external sandbox, a granular approval policy).
 */
export function presetOf({ approvalPolicy, sandbox } = {}) {
  const sb = sandboxName(sandbox);
  if (sb === 'danger-full-access') return 'full-access';
  if (sb === 'read-only') return 'read-only';
  return 'auto';
}

/** What a phone's access allows for Codex: Full and No shell/Chat only (no commands or edits) map to presets. */
export function capPresets(cap) {
  if (cap === 'full' || cap === undefined) return [...PRESET_NAMES];
  return ['read-only'];
}

/** The preset the access allows: `mode` itself, else the strongest one it does allow. */
export function clampPreset(cap, mode) {
  const ok = capPresets(cap);
  return ok.includes(mode) ? mode : ok[ok.length - 1];
}

/** thread/start and thread/resume fields for a preset. A restricted access never asks (it could not approve a command from the phone anyway). */
export function threadPermissions(mode, { restricted = false } = {}) {
  const p = PRESETS[isPreset(mode) ? mode : DEFAULT_PRESET];
  return { approvalPolicy: restricted ? 'never' : p.approvalPolicy, sandbox: p.sandbox };
}

/** turn/start fields for a preset (they apply to this turn and the ones after). */
export function turnPermissions(mode, { restricted = false } = {}) {
  const p = PRESETS[isPreset(mode) ? mode : DEFAULT_PRESET];
  return { approvalPolicy: restricted ? 'never' : p.approvalPolicy, sandboxPolicy: { ...p.sandboxPolicy } };
}

/* ---------- models and efforts ---------- */

const FALLBACK_EFFORTS = ['low', 'medium', 'high'];

/**
 * model/list rows as the pane's pickers use them: { id, name, description, efforts: [{ value, description }],
 * defaultEffort, isDefault, hidden }. The efforts are the model's own (they differ per model).
 */
export function normalizeModels(data) {
  const out = [];
  for (const m of Array.isArray(data) ? data : []) {
    if (!isObj(m) || !str(m.model || m.id)) continue;
    const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
      .map((e) => (isObj(e) ? { value: str(e.reasoningEffort), description: str(e.description) } : { value: str(e), description: '' }))
      .filter((e) => e.value);
    out.push({
      id: str(m.model || m.id), name: str(m.displayName) || str(m.model || m.id), description: str(m.description),
      efforts: efforts.length ? efforts : FALLBACK_EFFORTS.map((value) => ({ value, description: '' })),
      defaultEffort: str(m.defaultReasoningEffort) || efforts[0]?.value || 'medium', isDefault: Boolean(m.isDefault), hidden: Boolean(m.hidden),
    });
  }
  return out;
}

/** The effort a model takes: `effort` when the model offers it, else the model's default, else the first it lists. */
export function effortFor(model, effort) {
  const list = model?.efforts?.map((e) => e.value) || [];
  if (list.includes(effort)) return effort;
  return model?.defaultEffort && list.includes(model.defaultEffort) ? model.defaultEffort : list[0] || effort || 'medium';
}

/* ---------- threads in the lists ---------- */

/** A thread's title: its name, else the words its first message really held (Codex wraps prompts in tags), else a plain default. */
export function threadTitle(t) {
  const name = str(t?.name).replace(/\s+/g, ' ').trim();
  if (name) return name.slice(0, 200);
  const prompt = codexPromptText(str(t?.preview));
  return prompt ? prompt.slice(0, 140) : 'Codex conversation';
}

/** A thread as a row of the session list (the shape engine.js compact() gives a Claude session, plus codex: true). */
export function threadRow(t) {
  const sec = t.recencyAt || t.updatedAt || t.createdAt || 0;
  return {
    id: codexId(t.id), title: threadTitle(t), firstPrompt: codexPromptText(str(t.preview)).slice(0, 200), cwd: str(t.cwd), branch: str(t.gitInfo?.branch),
    lastModified: sec * 1000, size: 0, codex: true, source: str(t.originator) || str(t.source),
  };
}

/* ---------- commands, and what Codex writes about itself ---------- */

/**
 * The command a person would type: the shell wrapper Codex puts around it (powershell.exe -Command "...",
 * bash -lc '...') comes off when it matches one of the common shapes exactly; anything else is shown as sent.
 */
export function plainCommand(command) {
  const c = str(command).trim();
  // powershell.exe, with any flags (a flag may take a word: -ExecutionPolicy Bypass) before -Command.
  let m = /^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+(?:\s+[^-\s]\S*)?\s+)*?-Command\s+(.+)$/is.exec(c);
  if (m) return unwrap(m[1]);
  m = /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh)\s+-l?c\s+(.+)$/is.exec(c);
  if (m) return unwrap(m[1]);
  return c;
}
function unwrap(s) {
  const t = s.trim();
  const q = t[0];
  if ((q === '"' || q === "'") && t.endsWith(q) && t.length >= 2) return t.slice(1, -1).replace(q === '"' ? /\\"/g : /'\\''/g, q);
  return t;
}
const shellName = (command) => (/^"?(?:[^"\s]*[\\/])?(?:powershell|pwsh)\b/i.test(str(command).trim()) ? 'PowerShell' : 'Bash');

/* ---------- items to messages ---------- */

const HIDDEN_ITEMS = new Set(['sleep', 'hookPrompt']);

/** Text of a UserInput list, and how many pictures it held. */
export function userInputText(content) {
  const list = Array.isArray(content) ? content : [];
  const text = list.filter((c) => c?.type === 'text').map((c) => str(c.text)).join('\n').trim();
  const images = list.filter((c) => c?.type === 'image' || c?.type === 'localImage').length;
  const files = list.filter((c) => c?.type === 'mention' || c?.type === 'skill').map((c) => str(c.name || c.path)).filter(Boolean);
  return { text, images, files };
}

/** FunctionCallOutput bodies: a string, or a list of content items. */
function bodyText(body) {
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) return body.map((c) => (typeof c === 'string' ? c : str(c?.text) || (c?.image_url || c?.imageUrl ? '[image]' : ''))).filter(Boolean).join('\n');
  if (isObj(body)) return str(body.text) || bodyText(body.content) || '';
  return '';
}

/** MCP tool result content: text and pictures in the shape the pane already draws (tool_result content). */
function mcpContent(result, error) {
  if (error?.message) return String(error.message);
  const parts = Array.isArray(result?.content) ? result.content : [];
  const out = [];
  for (const c of parts) {
    if (c?.type === 'text') out.push({ type: 'text', text: str(c.text) });
    else if (c?.type === 'image' && typeof c.data === 'string') out.push({ type: 'image', data: c.data, mimeType: str(c.mimeType) || 'image/png' });
    else if (c?.type === 'resource' && c.resource?.text) out.push({ type: 'text', text: str(c.resource.text) });
  }
  if (!out.length && result?.structuredContent) out.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
  return out.length ? out : '';
}

/** A web search's result lines (title and address), capped. */
function searchText(item) {
  const rows = (Array.isArray(item.results) ? item.results : []).filter((r) => r && (r.title || r.url)).slice(0, 8).map((r) => `${str(r.title) || str(r.url)}${r.url && r.title ? ` - ${r.url}` : ''}`);
  const q = item.action?.type === 'openPage' ? `Opened ${str(item.action.url)}` : item.action?.type === 'findInPage' ? `Looked for "${str(item.action.pattern)}" in ${str(item.action.url)}` : '';
  return [q, ...rows].filter(Boolean).join('\n');
}

const changeKind = (k) => (isObj(k) ? str(k.type) : str(k)) || 'update';

/** The changes of a fileChange item, trimmed to what the pane and the sheets draw. */
export function patchChanges(item) {
  return (Array.isArray(item?.changes) ? item.changes : []).map((c) => ({
    path: str(c?.path), kind: changeKind(c?.kind), ...(isObj(c?.kind) && c.kind.move_path ? { move_path: str(c.kind.move_path) } : {}), diff: str(c?.diff),
  }));
}

/**
 * The tool_use block a ThreadItem stands for (null for items that are not tool calls). The pane draws it as a line
 * with the command or arguments; its result follows as a tool_result with the same id.
 */
export function toolUseOf(item) {
  if (!isObj(item)) return null;
  const id = str(item.id);
  switch (item.type) {
    case 'commandExecution': return { type: 'tool_use', id, name: shellName(item.command), input: { command: plainCommand(item.command), ...(item.cwd ? { cwd: str(item.cwd) } : {}) } };
    case 'fileChange': return { type: 'tool_use', id, name: 'ApplyPatch', input: { changes: patchChanges(item) } };
    case 'mcpToolCall': return { type: 'tool_use', id, name: `mcp__${str(item.server)}__${str(item.tool)}`, input: isObj(item.arguments) ? item.arguments : {} };
    case 'dynamicToolCall': return { type: 'tool_use', id, name: item.namespace ? `${item.namespace}__${str(item.tool)}` : str(item.tool), input: isObj(item.arguments) ? item.arguments : {} };
    case 'webSearch': return { type: 'tool_use', id, name: 'WebSearch', input: { query: str(item.query) || str(item.action?.query) || str(item.action?.url) } };
    case 'imageView': return { type: 'tool_use', id, name: 'ViewImage', input: { file_path: str(item.path) } };
    case 'imageGeneration': return { type: 'tool_use', id, name: 'ImageGeneration', input: { prompt: str(item.revisedPrompt) } };
    case 'collabAgentToolCall': return { type: 'tool_use', id, name: 'Subagent', input: { description: clip(str(item.prompt) || str(item.tool), 160) } };
    case 'subAgentActivity': return { type: 'tool_use', id, name: 'Subagent', input: { description: `${str(item.kind)} ${str(item.agentPath)}`.trim() } };
    case 'functionCallOutput': return { type: 'tool_use', id, name: item.namespace ? `${item.namespace}__${str(item.name)}` : str(item.name) || 'tool', input: {} };
    case 'enteredReviewMode': return { type: 'tool_use', id, name: 'Review', input: { description: str(item.review) } };
    default: return null;
  }
}

const OUTPUT_CHARS = 20000;

/**
 * The tool_result block for a finished (or failed) item, or null while it is still running. is_error marks a failed
 * command (non-zero exit), a declined or failed patch, a failed tool call.
 */
export function toolResultOf(item) {
  if (!isObj(item)) return null;
  const id = str(item.id);
  const done = (content, isError = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error: isError });
  switch (item.type) {
    case 'commandExecution': {
      if (item.status === 'inProgress') return null;
      const out = str(item.aggregatedOutput);
      const code = Number.isFinite(item.exitCode) ? item.exitCode : null;
      const bad = item.status === 'failed' || item.status === 'declined' || (code !== null && code !== 0);
      const tail = item.status === 'declined' ? 'Declined: this command did not run.' : bad && code !== null ? `(exit code ${code})` : '';
      return done(clip([out.replace(/\s+$/, ''), tail].filter(Boolean).join('\n'), OUTPUT_CHARS), bad);
    }
    case 'fileChange': {
      if (item.status === 'inProgress') return null;
      const n = Array.isArray(item.changes) ? item.changes.length : 0;
      if (item.status === 'declined') return done('Declined: no files were changed.', true);
      if (item.status === 'failed') return done('The patch could not be applied.', true);
      return done(`Changed ${n} file${n === 1 ? '' : 's'}.`);
    }
    case 'mcpToolCall': {
      if (item.status === 'inProgress') return null;
      return done(mcpContent(item.result, item.error), item.status === 'failed' || Boolean(item.error));
    }
    case 'dynamicToolCall': {
      if (item.status === 'inProgress') return null;
      return done((Array.isArray(item.contentItems) ? item.contentItems : []).map((c) => str(c.text) || (c.imageUrl ? '[image]' : '')).filter(Boolean).join('\n'), item.status === 'failed' || item.success === false);
    }
    case 'webSearch': return done(searchText(item) || `Searched for "${str(item.query)}"`);
    case 'imageView': return done('Looked at the image.');
    case 'imageGeneration': return done(str(item.savedPath) ? `Saved to ${item.savedPath}` : str(item.status) || 'Generated an image.', Boolean(item.failure));
    case 'collabAgentToolCall': return done(Object.entries(item.agentsStates || {}).map(([k, v]) => `${k}: ${str(v?.status) || str(v)}`).join('\n') || str(item.status));
    case 'subAgentActivity': return done(`${str(item.kind)} ${str(item.agentPath)}`.trim());
    case 'functionCallOutput': return done(bodyText(item.output));
    case 'exitedReviewMode': return done(str(item.review));
    default: return null;
  }
}

/** A reasoning item's summary as one text (the Codex app shows the summary, not the raw chain of thought). */
export function reasoningText(item) {
  const s = (Array.isArray(item?.summary) ? item.summary : []).map(str).filter(Boolean);
  if (s.length) return s.join('\n\n');
  return (Array.isArray(item?.content) ? item.content : []).map(str).filter(Boolean).join('\n\n');
}

/**
 * Turns -> the messages a pane's history draws (the same shape engine history.js sends for a Claude transcript),
 * oldest first: user / assistant messages with text, thinking and tool_use blocks, tool results as user messages
 * with tool_result blocks, compaction markers and the notices a turn's end implies.
 *
 * @param {object[]} turns  oldest first, each with items[] (itemsView full)
 * @returns {object[]}
 */
export function turnsToMessages(turns) {
  const out = [];
  for (const turn of Array.isArray(turns) ? turns : []) {
    const at = iso(turn.startedAt || turn.completedAt);
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (HIDDEN_ITEMS.has(item.type)) continue;
      const id = str(item.id) || `${turn.id}:${out.length}`;
      switch (item.type) {
        case 'userMessage': {
          const u = userInputText(item.content);
          const blocks = [];
          if (u.text) blocks.push({ type: 'text', text: u.text });
          for (let i = 0; i < u.images; i++) blocks.push({ type: 'image_marker' });
          if (u.files.length) blocks.push({ type: 'text', text: u.files.map((f) => `[file: ${f}]`).join('\n') });
          if (blocks.length) out.push({ type: 'user', uuid: id, at, message: { role: 'user', content: blocks } });
          break;
        }
        case 'agentMessage':
          if (str(item.text).trim()) out.push({ type: 'assistant', uuid: id, at, message: { role: 'assistant', content: [{ type: 'text', text: item.text }] } });
          break;
        case 'plan':
          if (str(item.text).trim()) out.push({ type: 'assistant', uuid: id, at, message: { role: 'assistant', content: [{ type: 'text', text: item.text }] } });
          break;
        case 'reasoning': {
          const t = reasoningText(item);
          if (t) out.push({ type: 'assistant', uuid: id, at, message: { role: 'assistant', content: [{ type: 'thinking', thinking: t }] } });
          break;
        }
        case 'contextCompaction':
          out.push({ type: 'compact', uuid: id, at, trigger: 'auto', preTokens: 0, postTokens: 0, summary: null });
          break;
        default: {
          const use = toolUseOf(item);
          if (!use) break;
          out.push({ type: 'assistant', uuid: id, at, message: { role: 'assistant', content: [use] } });
          const res = toolResultOf(item);
          if (res) out.push({ type: 'user', uuid: `${id}:r`, at, message: { role: 'user', content: [res] } });
        }
      }
    }
    if (turn.status === 'failed' && turn.error?.message) out.push({ type: 'notice', uuid: `${turn.id}:err`, at, notice: { text: friendlyError(turn.error), tone: 'error', label: '' } });
    else if (turn.status === 'interrupted') out.push({ type: 'notice', uuid: `${turn.id}:int`, at, notice: { text: 'Interrupted.', tone: 'dim', label: '' } });
  }
  return out;
}

/* ---------- live events -> SDK-shaped messages ---------- */

/** A stream event the pane's onSdk understands. */
export const streamEvent = (event) => ({ type: 'stream_event', event });
export const messageStart = (turnId) => streamEvent({ type: 'message_start', message: { id: turnId } });
export const textStart = (index) => streamEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
export const textDelta = (index, text) => streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
/** A finished assistant message (the pane replaces the streamed text with the final one). */
export const assistantMessage = (turnId, content) => ({ type: 'assistant', message: { id: turnId, role: 'assistant', content }, codex: true });
export const toolResultMessage = (blocks) => ({ type: 'user', message: { role: 'user', content: blocks } });
/** A system line (notices.js draws it): level warning, info. */
export const informational = (content, level = 'warning') => ({ type: 'system', subtype: 'informational', content, level });
/** Output of a running command, as far as it has come (the pane keeps the newest part). */
export const toolOutput = (toolUseId, text) => ({ type: 'system', subtype: 'tool_output', tool_use_id: toolUseId, text });

const PLAN_STATUS = { pending: 'pending', inProgress: 'in_progress', in_progress: 'in_progress', completed: 'completed' };

/** turn/plan/updated as a TodoWrite call: the pane draws it as the same checklist Claude's plans use. */
export function todoWriteOf(id, plan) {
  const todos = (Array.isArray(plan) ? plan : []).map((s) => ({ content: str(s?.step), activeForm: '', status: PLAN_STATUS[s?.status] || 'pending' })).filter((t) => t.content);
  return { type: 'tool_use', id, name: 'TodoWrite', input: { todos } };
}

/* ---------- errors and notices ---------- */

const ERROR_TEXT = {
  usageLimitExceeded: 'You have reached your Codex usage limit.',
  rateLimitExceeded: 'Codex is rate limited right now.',
  contextWindowExceeded: 'This conversation no longer fits the model\'s context window. Compact it, or start a new one.',
  unauthorized: 'Codex is not signed in, or the sign-in expired. Sign in again in the Codex app or with codex login.',
  serverOverloaded: 'The model is overloaded right now. Try again in a moment.',
  sandboxError: 'The sandbox stopped a command.',
};

/** A turn error as one readable sentence (the server's own message, after a plain one for the codes people meet). */
export function friendlyError(err) {
  const msg = str(err?.message).trim();
  const info = err?.codexErrorInfo;
  const code = typeof info === 'string' ? info : isObj(info) ? Object.keys(info)[0] : '';
  const plain = ERROR_TEXT[code];
  if (plain && msg && !msg.toLowerCase().includes(plain.slice(0, 20).toLowerCase())) return `${plain} ${msg}`.trim();
  return msg || plain || 'The turn failed.';
}

/** The notice for a model reroute. */
export function rerouteMessage(n) {
  return informational(`Codex switched this turn from ${str(n.fromModel)} to ${str(n.toModel)}${n.reason === 'highRiskCyberActivity' ? ' because the request looked like high-risk cyber activity' : ''}.`);
}

/**
 * A hook run as the SDK message notices.js already draws, or null when a Claude Code user would not have seen it
 * (a quiet success). A failed or blocked hook reads like Claude Code's: "<event> hook failed: <why>".
 */
export function hookMessage(run) {
  if (!isObj(run)) return null;
  const entries = (Array.isArray(run.entries) ? run.entries : []).map((e) => ({ kind: str(e?.kind), text: str(e?.text) })).filter((e) => e.text);
  const text = entries.map((e) => e.text).join('\n');
  const name = str(run.eventName) || 'Hook';
  if (run.status === 'failed') return { type: 'system', subtype: 'hook_response', hook_name: name, hook_event: name, outcome: 'error', exit_code: 1, stderr: text || str(run.statusMessage), stdout: '' };
  if (run.status === 'blocked') return { type: 'system', subtype: 'hook_response', hook_name: name, hook_event: name, outcome: 'error', exit_code: 2, stderr: text || str(run.statusMessage), stdout: '' };
  if (run.status === 'stopped') return { type: 'system', subtype: 'hook_response', hook_name: name, hook_event: name, outcome: 'cancelled', stderr: text, stdout: '' };
  const loud = entries.filter((e) => e.kind === 'warning' || e.kind === 'error' || e.kind === 'feedback' || e.kind === 'stop');
  if (run.status === 'completed' && loud.length) return informational(`${name} hook: ${loud.map((e) => e.text).join(' ')}`, 'warning');
  return null;
}

/**
 * account/rateLimits/updated as the SDK's rate_limit_event, so the usage warnings read the same as Claude's. A window
 * becomes five_hour or seven_day by its length; at 80 percent it warns, at 100 (or when the server says it was
 * reached) it is rejected. Returns [] when nothing is worth saying.
 */
export function limitEvents(snapshot) {
  const out = [];
  const reached = Boolean(snapshot?.rateLimitReachedType);
  for (const w of [snapshot?.primary, snapshot?.secondary]) {
    if (!isObj(w) || !Number.isFinite(w.usedPercent)) continue;
    const mins = Number(w.windowDurationMins) || 0;
    const type = mins && mins <= 360 ? 'five_hour' : 'seven_day';
    const status = w.usedPercent >= 100 || (reached && w.usedPercent >= 90) ? 'rejected' : w.usedPercent >= 80 ? 'allowed_warning' : null;
    if (!status) continue;
    out.push({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: type, utilization: w.usedPercent, resetsAt: w.resetsAt || null } });
  }
  return out;
}

/* ---------- the context meter ---------- */

/**
 * thread/tokenUsage/updated as the pane's context event: how full the model's window is after the last call, and where
 * the tokens went. `last` is the latest call (what is in the window now); `total` is the whole thread's spend.
 * No window size (the server did not say) gives no percentage, and the meter stays hidden.
 */
export function contextFromUsage(usage, { model = null, threadId = null } = {}) {
  const last = usage?.last || {};
  const win = Number(usage?.modelContextWindow) || null;
  const total = Number(last.totalTokens) || 0;
  const cached = Number(last.cachedInputTokens) || 0;
  const input = Number(last.inputTokens) || 0;
  const reasoning = Number(last.reasoningOutputTokens) || 0;
  const output = Math.max(0, (Number(last.outputTokens) || 0) - reasoning);
  const used = [
    { name: 'Input', tokens: Math.max(0, input - cached) },
    { name: 'Cached input', tokens: cached },
    { name: 'Output', tokens: output },
    { name: 'Reasoning', tokens: reasoning },
  ].filter((u) => u.tokens > 0);
  return { percentage: win && total ? Math.min(100, Math.round((100 * total) / win)) : null, totalTokens: total || null, maxTokens: win, autoCompact: null, model, sessionId: threadId ? codexId(threadId) : null, used, codex: true };
}

/* ---------- what is sent to the model ---------- */

const IMAGE_TYPES = /^image\/(?:png|jpeg|gif|webp)$/;

/**
 * The UserInput list for turn/start and turn/steer: the text, pictures as data URLs, and other files as mentions of
 * the paths they were saved to (the caller saves them; `files` is [{ name, path }]).
 */
export function turnInput(text, images = [], files = []) {
  const input = [];
  const t = String(text ?? '');
  if (t.trim()) input.push({ type: 'text', text: t, text_elements: [] });
  for (const im of images) {
    if (im && IMAGE_TYPES.test(String(im.media_type)) && typeof im.data === 'string') input.push({ type: 'image', url: `data:${im.media_type};base64,${im.data}` });
  }
  for (const f of files) if (f?.path) input.push({ type: 'mention', name: str(f.name) || 'file', path: f.path });
  return input;
}

/* ---------- questions and approvals ---------- */

const APPROVE_LABELS = Object.freeze({ once: 'Approve once', always: 'Approve for this session', deny: 'Deny' });

const titleCase = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/**
 * item/tool/requestUserInput as the `ask` Apaki already draws for Claude's AskUserQuestion: the same sheet (options,
 * a typed answer), so a Codex question looks and works like Claude's. Questions are keyed by their text in the sheet's
 * reply; `ids` maps text back to Codex's question id.
 */
export function questionAsk(params) {
  const qs = (Array.isArray(params?.questions) ? params.questions : []).filter(isObj);
  const ids = new Map();
  const questions = qs.map((q, i) => {
    const text = str(q.question) || `Question ${i + 1}`;
    const key = ids.has(text) ? `${text} (${i + 1})` : text;
    ids.set(key, str(q.id) || String(i));
    return {
      question: key, header: str(q.header), multiSelect: false, secret: Boolean(q.isSecret), other: q.isOther !== false,
      options: (Array.isArray(q.options) ? q.options : []).map((o) => ({ label: str(o?.label), description: str(o?.description) })).filter((o) => o.label),
    };
  });
  return { toolName: 'AskUserQuestion', input: { questions }, ids };
}

/** The reply to item/tool/requestUserInput for a sheet answer ({ behavior, updatedInput: { answers } }) or a skip. */
export function questionReply(ask, answer) {
  const answers = {};
  const given = answer?.behavior === 'allow' ? answer.updatedInput?.answers : null;
  for (const [text, id] of ask.ids) {
    const v = isObj(given) ? String(given[text] ?? '').trim() : '';
    answers[id] = { answers: v ? [v] : [] };
  }
  return { answers };
}

/** Command lines the "approve for this session" button would save, in words. */
function commandRule(params) {
  const amend = Array.isArray(params.proposedExecpolicyAmendment) ? params.proposedExecpolicyAmendment : [];
  return amend.length ? `Approve commands that start with "${amend.join(' ')}" from now on` : 'Approve this command for the rest of this session';
}

const decisionsOf = (params) => (Array.isArray(params?.availableDecisions) && params.availableDecisions.length ? params.availableDecisions : null);
const decisionName = (d) => (typeof d === 'string' ? d : isObj(d) ? Object.keys(d)[0] : '');

function perm(p) {
  return {
    title: '', displayName: '', description: '', decisionReason: '', blockedPath: '', mcpServer: null, toolUseId: '', agentId: '',
    defaultToNo: false, cut: false, always: null, labels: { ...APPROVE_LABELS }, codex: true, ...p,
  };
}

/** Writes in words (for the permissions request sheet). */
function permissionRows(permissions) {
  const rows = [];
  const fs = permissions?.fileSystem;
  if (fs) {
    const read = [...(fs.read || []), ...(fs.entries || []).filter((e) => /read/i.test(JSON.stringify(e.access ?? e.mode ?? ''))).map((e) => e.path || '')].filter(Boolean);
    const write = [...(fs.write || []), ...(fs.entries || []).filter((e) => /write/i.test(JSON.stringify(e.access ?? e.mode ?? ''))).map((e) => e.path || '')].filter(Boolean);
    if (read.length) rows.push(['Read access', read.join(', ')]);
    if (write.length) rows.push(['Write access', write.join(', ')]);
    if (!read.length && !write.length) rows.push(['File access', JSON.stringify(fs).slice(0, 300)]);
  }
  if (permissions?.network) rows.push(['Network', permissions.network.enabled === false ? 'off' : 'on']);
  return rows;
}

/**
 * A Codex approval request as an `ask` event body: { kind, toolName, input, permission } for the permission sheet
 * (apaki/ui/permission.js), with Codex's own button words (Approve once, Approve for this session, Deny). `item` is
 * the item the request is about when the engine has seen it (a file change's diffs come from there).
 *
 * kind: 'command' | 'fileChange' | 'permissions' | 'execCommand' | 'applyPatch' | 'elicitation' | 'url'
 */
export function approvalAsk(method, params, { item = null } = {}) {
  const p = isObj(params) ? params : {};
  const reason = str(p.reason);
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const can = decisionsOf(p);
      const names = can ? can.map(decisionName) : null;
      const session = !names || names.includes('acceptForSession');
      const amend = names ? names.includes('acceptWithExecpolicyAmendment') : false;
      const net = isObj(p.networkApprovalContext);
      const cmd = str(p.command) || str(item?.command);
      return {
        kind: 'command', toolName: shellName(cmd),
        input: { command: cmd, ...(reason ? { description: reason } : {}) },
        permission: perm({
          title: net ? 'Allow network access?' : 'Run this command?', displayName: net ? 'Network' : shellName(cmd), description: str(p.cwd) ? `In ${str(p.cwd)}` : '',
          decisionReason: reason, toolUseId: str(p.itemId),
          always: session || amend ? { lines: [session ? 'Approve this command for the rest of this session' : commandRule(p)] } : null,
        }),
        decisions: { session, amend },
      };
    }
    case 'item/fileChange/requestApproval': {
      const changes = item ? patchChanges(item) : [];
      return {
        kind: 'fileChange', toolName: 'ApplyPatch', input: { changes },
        permission: perm({
          title: 'Apply these changes?', displayName: 'Edit files', description: p.grantRoot ? `Also allows writing under ${str(p.grantRoot)} for the rest of this session` : '',
          decisionReason: reason, toolUseId: str(p.itemId), always: { lines: [p.grantRoot ? `Allow edits under ${str(p.grantRoot)} for the rest of this session` : 'Approve edits for the rest of this session'] },
        }),
      };
    }
    case 'item/permissions/requestApproval':
      return {
        kind: 'permissions', toolName: 'Permissions', input: { rows: permissionRows(p.permissions), cwd: str(p.cwd) },
        permission: perm({ title: 'Grant more access?', displayName: 'Permissions', description: str(p.cwd) ? `In ${str(p.cwd)}` : '', decisionReason: reason, toolUseId: str(p.itemId), always: { lines: ['Keep this access for the rest of this session'] } }),
      };
    case 'execCommandApproval': {
      const cmd = Array.isArray(p.command) ? p.command.join(' ') : str(p.command);
      return {
        kind: 'execCommand', toolName: shellName(cmd), input: { command: plainCommand(cmd), ...(reason ? { description: reason } : {}) },
        permission: perm({ title: 'Run this command?', displayName: shellName(cmd), description: str(p.cwd) ? `In ${str(p.cwd)}` : '', decisionReason: reason, toolUseId: str(p.callId), always: { lines: ['Approve this command for the rest of this session'] } }),
      };
    }
    case 'applyPatchApproval': {
      const changes = Object.entries(isObj(p.fileChanges) ? p.fileChanges : {}).map(([path, c]) => ({ path, kind: str(c?.type) || 'update', diff: str(c?.unified_diff) || str(c?.content) }));
      return {
        kind: 'applyPatch', toolName: 'ApplyPatch', input: { changes },
        permission: perm({ title: 'Apply these changes?', displayName: 'Edit files', decisionReason: reason, toolUseId: str(p.callId), always: { lines: ['Approve edits for the rest of this session'] } }),
      };
    }
    default:
      return null;
  }
}

/**
 * The JSON-RPC result for an approval request, from the sheet's reply ({ behavior: 'allow', always? } or deny).
 * An unreadable reply denies: a request is never approved by accident.
 */
export function approvalReply(ask, answer) {
  const allow = isObj(answer) && answer.behavior === 'allow';
  const always = allow && answer.always === true;
  switch (ask.kind) {
    case 'command': {
      if (!allow) return { decision: 'decline' };
      if (!always) return { decision: 'accept' };
      if (ask.decisions?.session !== false) return { decision: 'acceptForSession' };
      return { decision: 'accept' };
    }
    case 'fileChange': return { decision: !allow ? 'decline' : always ? 'acceptForSession' : 'accept' };
    case 'permissions': return allow ? { permissions: ask.requested || {}, scope: always ? 'session' : 'turn' } : { permissions: {}, scope: 'turn' };
    case 'execCommand': case 'applyPatch': return { decision: !allow ? 'denied' : always ? 'approved_for_session' : 'approved' };
    default: return { decision: 'decline' };
  }
}

/**
 * mcpServer/elicitation/request. A tool-call approval (Codex marks it in _meta) is a permission sheet; a form becomes
 * the question sheet (one question per field); a link asks first, then opens in Apaki's browser. Anything Apaki does
 * not understand is declined, never left waiting.
 */
export function elicitationAsk(params) {
  const p = isObj(params) ? params : {};
  const meta = isObj(p._meta) ? p._meta : {};
  const server = str(p.serverName);
  if (str(meta.codex_approval_kind) === 'mcp_tool_call') {
    const tool = str(meta.tool_title);
    const persist = Array.isArray(meta.persist) ? meta.persist.map(String) : meta.persist ? [String(meta.persist)] : [];
    return {
      kind: 'mcpApproval', toolName: `mcp__${server}__${tool || 'tool'}`, input: isObj(meta.tool_params) ? meta.tool_params : {},
      persist,
      permission: perm({
        title: str(p.message) || `Let ${server} run ${tool || 'a tool'}?`, displayName: tool || 'Tool', description: server ? `From the ${server} tool server` : '', mcpServer: server ? { name: server, source: 'codex' } : null,
        always: persist.includes('session') || persist.includes('always') ? { lines: [persist.includes('session') ? `Let ${server} run this for the rest of this session` : `Always let ${server} run this`] } : null,
      }),
    };
  }
  if (p.mode === 'url' && /^https?:\/\//i.test(str(p.url))) {
    return {
      kind: 'url', toolName: 'Open page', input: { url: str(p.url) },
      permission: perm({ title: str(p.message) || 'Open this page?', displayName: 'Open page', description: server ? `Asked by ${server}` : '', labels: { once: 'Open it', always: 'Open it', deny: 'Not now' } }),
    };
  }
  if ((p.mode === 'form' || p.mode === 'openai/form' || p.mode === 'openaiForm') && isObj(p.requestedSchema)) {
    const props = isObj(p.requestedSchema.properties) ? p.requestedSchema.properties : {};
    const required = new Set(Array.isArray(p.requestedSchema.required) ? p.requestedSchema.required : []);
    const keys = new Map();
    const questions = Object.entries(props).slice(0, 12).map(([name, spec]) => {
      const s = isObj(spec) ? spec : {};
      const label = str(s.title) || titleCase(name);
      const q = `${label}${required.has(name) ? '' : ' (optional)'}${str(s.description) ? `: ${str(s.description)}` : ''}`;
      keys.set(q, { name, type: str(s.type) });
      const options = Array.isArray(s.enum) ? s.enum.map((v, i) => ({ label: String(v), description: Array.isArray(s.enumNames) ? str(s.enumNames[i]) : '' }))
        : s.type === 'boolean' ? [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] : [];
      return { question: q, header: label, multiSelect: false, options, other: !options.length || Boolean(s.type === 'string') };
    });
    if (questions.length) return { kind: 'form', toolName: 'AskUserQuestion', input: { questions, message: str(p.message) }, keys };
  }
  return null;
}

/** The JSON-RPC result for an elicitation. */
export function elicitationReply(ask, answer) {
  const allow = isObj(answer) && answer.behavior === 'allow';
  if (ask.kind === 'mcpApproval') {
    if (!allow) return { action: 'decline', content: null, _meta: null };
    const persist = answer.always === true ? (ask.persist.includes('session') ? 'session' : ask.persist.includes('always') ? 'always' : null) : null;
    return { action: 'accept', content: null, _meta: persist ? { persist } : null };
  }
  if (ask.kind === 'url') return { action: allow ? 'accept' : 'decline', content: null, _meta: null };
  if (ask.kind === 'form') {
    if (!allow) return { action: 'decline', content: null, _meta: null };
    const given = isObj(answer.updatedInput?.answers) ? answer.updatedInput.answers : {};
    const content = {};
    for (const [q, spec] of ask.keys) {
      const raw = String(given[q] ?? '').trim();
      if (!raw) continue;
      content[spec.name] = spec.type === 'boolean' ? /^(yes|true|1)$/i.test(raw) : spec.type === 'number' || spec.type === 'integer' ? (Number.isFinite(Number(raw)) ? Number(raw) : raw) : raw;
    }
    return { action: 'accept', content, _meta: null };
  }
  return { action: 'decline', content: null, _meta: null };
}
