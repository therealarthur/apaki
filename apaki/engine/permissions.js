/**
 * permissions.js: real permission prompts for Myrlin Apaki's panes.
 *
 * 2026-10-12 (Arthur: in "Ask permissions" and "Auto-accept edits" a tool Claude
 * Code would normally ask about simply ran). The engine's canUseTool used to
 * return allow for everything, so the Agent SDK's permission callback never
 * reached a person. This file is the callback that does: it holds the tool call,
 * asks the pane's window (or phone) with the same machinery a question or a plan
 * approval uses, and settles the call with what the person chose.
 *
 *   state.asks   askId -> an entry the engine's answer op settles. A permission
 *                entry has kind 'permission', `answer(result)` (a window or phone's
 *                reply: allow, allow with always, deny with a note) and `resolve(r)`
 *                (the engine's own settling: a turn that ended, a pane that closed).
 *   ev ask       { askId, paneId, toolName, input, permission } with `permission`
 *                set (title, displayName, description, decisionReason, blockedPath,
 *                mcpServer, agentId, toolUseId, defaultToNo, cut, always). The
 *                window draws a permission sheet (apaki/ui/permission.js) when it
 *                is there, and the question sheets as before when it is not.
 *   op answer    { askId, result: { behavior: 'allow', always? } | { behavior: 'deny', message? } }
 *   ev ask_gone  { askId, paneId, why }: the call is over (the turn ended, Claude Code
 *                cancelled it: why 'cancelled'); the window drops the card (apaki/ui/askcard.js).
 *
 * "Always allow" applies the permission updates the SDK suggested for this call
 * (CanUseTool options.suggestions) as the result's updatedPermissions, which is how
 * Claude Code saves a rule or a mode ("Yes, and don't ask again"). The window never
 * sends rules: it says `always: true` and the engine uses the SDK's own list, so a
 * window or a phone cannot make Claude Code write a rule the SDK did not offer. A
 * phone below 'full' access (remote-policy.js) may not persist rules at all; its
 * "always" is an allow once and its sheet has no such button (`always: null`).
 *
 * Not asked here: AskUserQuestion and ExitPlanMode. They have their own sheets and are
 * answered from a PreToolUse hook (src/runner.js onInteractiveTool); if the SDK still
 * reaches the callback for one, it is allowed as it always was. Nor Apaki's own show tool
 * (mcp__apaki__show, from the in-process "apaki" server only): it only writes Apaki's own
 * artifact store, and a prompt for every artifact in every folder would make the
 * app's own feature noisy. bypassPermissions never
 * consults canUseTool, and a phone's blocked tools are refused before this runs
 * (remote-policy.js capCanUseTool wraps this callback).
 *
 * Pure apart from the Map and emit it is given, so test/apaki-permissions.test.js
 * checks it without an engine.
 */

/** Tools with their own sheets (answered by the interactive-tool hook); allowed here as before. */
export const PASS_THROUGH_TOOLS = Object.freeze(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Apaki's own display tool, and (2026-10-13) its read-only view_read (what the user made of an artifact): allowed
 * without a prompt, and only from the in-process server this host registered.
 */
export const OWN_TOOLS = Object.freeze(['mcp__apaki__show', 'mcp__apaki__view_read']);

/** True for a tool of Apaki's own in-process "apaki" server that needs no prompt (the SDK says which server served it). */
export function isOwnTool(toolName, opts) {
  return OWN_TOOLS.includes(toolName) && opts?.mcpServer?.source === 'sdk' && opts.mcpServer.name === 'apaki';
}

const TEXT_MAX = 600;
export const NOTE_MAX = 2000;
// An input string longer than this is cut in the event (the window only draws a preview); the run uses the whole input.
export const INPUT_CUT_CHARS = 12000;
const INPUT_CUT_ITEMS = 40;

/** What Claude is told when the person says no without a note (Claude Code's own wording for a plain reject). */
export const REJECT_TEXT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
/** What a call settled by the engine itself (not by a person) is told. */
export const WITHDRAWN_TEXT = 'The permission request was withdrawn before anyone answered it.';

const SUGGESTION_TYPES = new Set(['addRules', 'replaceRules', 'removeRules', 'setMode', 'addDirectories', 'removeDirectories']);
const DESTINATIONS = new Set(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']);

/** Where a saved rule lives, in words (Claude Code's own settings files). */
export const WHERE = Object.freeze({
  localSettings: 'for this project, kept on this PC',
  projectSettings: 'for this project, shared in .claude/settings.json',
  userSettings: 'for every project',
  session: 'for this session only',
  cliArg: 'for this run only',
});
const MODE_NAMES = Object.freeze({ default: 'Ask permissions', acceptEdits: 'Auto-accept edits', plan: 'Plan mode', bypassPermissions: 'Bypass permissions', dontAsk: 'Do not ask', auto: 'Auto' });

const str = (v, max = TEXT_MAX) => (typeof v === 'string' && v ? v.slice(0, max) : '');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** A note from the person, trimmed and capped; '' when there is none. */
export function cleanNote(note) {
  return typeof note === 'string' ? note.trim().slice(0, NOTE_MAX) : '';
}

/** The message Claude gets for a denial: the plain reject text, or that text with what the person said to do instead. */
export function denyText(note) {
  const n = cleanNote(note);
  if (!n) return REJECT_TEXT;
  return `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n${n}`;
}

/** One rule as Claude Code writes it: Bash(npm test:*), or the bare tool name. */
export function ruleText(rule) {
  const name = str(rule?.toolName, 120);
  if (!name) return '';
  const content = typeof rule.ruleContent === 'string' && rule.ruleContent ? rule.ruleContent.slice(0, 300) : '';
  return content ? `${name}(${content})` : name;
}

/**
 * The SDK's suggested permission updates, kept only when they have a shape the SDK defines
 * (PermissionUpdate); anything else is dropped, so the list applied later is the SDK's own and well formed.
 */
export function cleanSuggestions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (!isObj(s) || !SUGGESTION_TYPES.has(s.type) || !DESTINATIONS.has(s.destination)) continue;
    if ((s.type === 'addRules' || s.type === 'replaceRules' || s.type === 'removeRules') && (!Array.isArray(s.rules) || !s.rules.length || !s.rules.every((r) => isObj(r) && typeof r.toolName === 'string' && r.toolName))) continue;
    if (s.type === 'setMode' && typeof s.mode !== 'string') continue;
    if ((s.type === 'addDirectories' || s.type === 'removeDirectories') && (!Array.isArray(s.directories) || !s.directories.length || !s.directories.every((d) => typeof d === 'string' && d))) continue;
    out.push(clone(s));
  }
  return out;
}

/** What one suggested update does, in a line for the sheet ("Allow Bash(npm test:*) for this project, kept on this PC"). */
export function describeSuggestion(s) {
  const where = WHERE[s?.destination] || '';
  const tail = where ? ` ${where}` : '';
  switch (s?.type) {
    case 'addRules': {
      const verb = s.behavior === 'deny' ? 'Deny' : s.behavior === 'ask' ? 'Ask about' : 'Allow';
      return `${verb} ${s.rules.map(ruleText).filter(Boolean).join(', ')}${tail}`;
    }
    case 'replaceRules': return `Set the ${s.behavior || 'allow'} rules to ${s.rules.map(ruleText).filter(Boolean).join(', ')}${tail}`;
    case 'removeRules': return `Remove ${s.rules.map(ruleText).filter(Boolean).join(', ')}${tail}`;
    case 'setMode': return `Switch to ${MODE_NAMES[s.mode] || s.mode}${tail}`;
    case 'addDirectories': return `Allow access to ${s.directories.join(', ')}${tail}`;
    case 'removeDirectories': return `Stop allowing access to ${s.directories.join(', ')}${tail}`;
    default: return '';
  }
}

/**
 * The input as the event carries it: long strings (a file's whole content, a big edit) cut to a preview, and a
 * very long list (edits) shortened, since the sheet only draws a preview and a phone link carries every byte.
 * `cut` says something was cut. The tool runs with the original input (the gate keeps it).
 */
export function slimInput(input) {
  let cut = false;
  const slim = (v, depth) => {
    if (typeof v === 'string') {
      if (v.length > INPUT_CUT_CHARS) { cut = true; return v.slice(0, INPUT_CUT_CHARS); }
      return v;
    }
    if (depth > 3) return v;
    if (Array.isArray(v)) {
      if (v.length > INPUT_CUT_ITEMS) cut = true;
      return v.slice(0, INPUT_CUT_ITEMS).map((x) => slim(x, depth + 1));
    }
    if (isObj(v)) {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = slim(x, depth + 1);
      return o;
    }
    return v;
  };
  const out = slim(isObj(input) ? input : {}, 0);
  return { input: out, cut };
}

/**
 * What the window needs to draw a permission sheet, from the SDK's options for this call. `alwaysOk` is whether
 * this pane may persist a rule (false for a phone below 'full'). `always` is null when there is no Always allow
 * button: nothing suggested, the SDK said not to offer one, or this pane may not persist rules.
 */
export function permissionPayload(opts = {}, { alwaysOk = true, cut = false } = {}) {
  const sug = cleanSuggestions(opts.suggestions);
  const lines = sug.map(describeSuggestion).filter(Boolean);
  const offer = Boolean(alwaysOk) && !opts.suppressAlwaysAllowRule && sug.length > 0 && lines.length > 0;
  const mcp = isObj(opts.mcpServer) ? { name: str(opts.mcpServer.name, 80), source: str(opts.mcpServer.source, 40) } : null;
  return {
    title: str(opts.title, 300), displayName: str(opts.displayName, 120), description: str(opts.description, 400),
    decisionReason: str(opts.decisionReason, 400), blockedPath: str(opts.blockedPath, 400), mcpServer: mcp,
    toolUseId: str(opts.toolUseID, 80), agentId: str(opts.agentID, 80),
    defaultToNo: Boolean(opts.defaultToNo), cut: Boolean(cut), always: offer ? { lines } : null,
  };
}

/**
 * The SDK's PermissionResult for a reply from a window or phone. Allow once sends the call's own input; Always
 * allow also sends the SDK's suggestions as updatedPermissions (when this pane may); a deny carries the note
 * as Claude's message. Anything that is not an allow or a deny (null, junk) denies: a call is never allowed by
 * an unreadable answer. The reply's own updatedInput or rules are ignored.
 */
export function permissionResult(answer, { input, suggestions = [], alwaysOk = true, toolUseId = '' } = {}) {
  const id = toolUseId ? { toolUseID: toolUseId } : {};
  if (isObj(answer) && answer.behavior === 'allow') {
    const out = { behavior: 'allow', updatedInput: input, ...id, decisionClassification: 'user_temporary' };
    if (answer.always === true && alwaysOk && suggestions.length) {
      out.updatedPermissions = suggestions.map(clone);
      out.decisionClassification = 'user_permanent';
    }
    return out;
  }
  if (isObj(answer) && answer.behavior === 'deny') return { behavior: 'deny', message: denyText(answer.message), ...id, decisionClassification: 'user_reject' };
  return { behavior: 'deny', message: WITHDRAWN_TEXT, ...id };
}

/** A result the engine settles a call with itself: a denial with its own message, never an allow. */
function engineResult(r, toolUseId) {
  const id = toolUseId ? { toolUseID: toolUseId } : {};
  const message = isObj(r) && typeof r.message === 'string' && r.message ? r.message.slice(0, NOTE_MAX) : WITHDRAWN_TEXT;
  return { behavior: 'deny', message, ...id };
}

const defaultId = () => `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * The canUseTool for one pane. `asks` is the engine's state.asks Map and `emit` its event sender.
 *
 * @param {object} o
 * @param {string} o.paneId
 * @param {Map} o.asks
 * @param {(ev: object) => void} o.emit
 * @param {() => boolean} [o.alwaysOk]  whether this pane may persist rules, read on each call and again on the answer
 * @param {() => string} [o.newId]
 * @param {() => number} [o.now]
 * @returns {(toolName: string, input: object, opts?: object) => Promise<object>}
 */
export function createPermissionGate({ paneId, asks, emit, alwaysOk = () => true, newId = defaultId, now = Date.now }) {
  return function canUseTool(toolName, input, opts = {}) {
    const original = isObj(input) ? input : {};
    if (PASS_THROUGH_TOOLS.includes(toolName) || isOwnTool(toolName, opts)) return Promise.resolve({ behavior: 'allow', updatedInput: original });
    const toolUseId = str(opts?.toolUseID, 80);
    const signal = opts?.signal;
    if (signal?.aborted) return Promise.resolve(engineResult(null, toolUseId));
    return new Promise((resolve) => {
      const id = newId();
      const suggestions = cleanSuggestions(opts?.suggestions);
      const { input: shown, cut } = slimInput(original);
      const permission = permissionPayload(opts, { alwaysOk: alwaysOk(), cut });
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.('abort', onAbort);
        if (asks.get(id) === entry) asks.delete(id);
        resolve(result);
      };
      const onAbort = () => {
        // Claude Code cancelled the call (a Stop, or it was settled elsewhere): nobody waits, so the sheet goes.
        const had = asks.get(id) === entry;
        finish(engineResult(null, toolUseId));
        if (had) emit({ ev: 'ask_gone', askId: id, paneId, why: 'cancelled' });
      };
      const entry = {
        kind: 'permission',
        paneId, toolName, input: shown, permission, at: now(), suggestions,
        // The engine settling it (a turn that ended, a pane closed or taken over): a denial, never an allow.
        resolve: (r) => finish(engineResult(r, toolUseId)),
        // A reply from the window or a phone.
        answer: (r) => finish(permissionResult(r, { input: original, suggestions, alwaysOk: Boolean(alwaysOk()), toolUseId })),
      };
      asks.set(id, entry);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      emit({ ev: 'ask', askId: id, paneId, toolName, input: shown, permission });
    });
  };
}
