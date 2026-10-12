/**
 * remote-policy.js: what a paired phone may ask the Apaki engine to do, and
 * which engine events it gets back. Pure functions, no I/O, so the rules are
 * tested on their own (test/apaki-remote-bridge.test.js).
 *
 * Track B part 2 (2026-10-09). A phone speaks the same commands the desktop
 * window sends (engine.js ops), but only these, through an explicit
 * allowlist:
 *   sessions, search                         the session list
 *   open, attach, send, interrupt, answer,   its own conversations
 *   model, effort, mode, commands, close
 *   artifactGet                              when the engine has it (artifacts track)
 *   historyBefore, historyBlock              read only: more of a conversation it has open
 *   codexModels, codexThreads                read only (2026-10-12): Codex's models and threads; a Codex pane uses the
 *                                            ops above, with Codex's models, efforts and presets (CODEX_MODES) in them
 *   worktrees, worktreeDiff                  read only: repositories, branches, change counts, diffs (2026-10-12)
 *   worktreePlan, worktreeRun                git and gh on the PC (create, remove, commit, push, pull request,
 *                                            merge); Full access only, folders the PC already lists only
 * Never billing, never the remote* ops (pairing, devices), never voice,
 * folders, Ask Claude or Dig deeper (they write files or spend outside a
 * conversation), and nothing that reaches the shell or the filesystem.
 *
 * Panes: a phone names its panes like the desktop does (p1, pab3...). The
 * engine sees them as phone:<deviceId>:<name>, so a phone can never touch a
 * desktop pane or another phone's pane, and every event about a phone pane
 * goes to that phone only. Request ids get the same prefix so answers to a
 * phone's requests (sessions, search) go back to it and not to the desktop.
 *
 * Note (2026-10-10, apaki/SECURITY.md 1.5): "nothing that reaches the shell
 * or the filesystem" above is about the ops a phone may send. The Claude
 * Code a phone pane runs reaches both, like a desktop pane, unless the
 * phone's capability says otherwise (below).
 *
 * Capabilities (2026-10-10, SECURITY.md 4.4 item 4; Arthur: "its important
 * that we have that secure and private option"): the PC user picks, per
 * phone, what that phone may make Claude do, and the PC enforces it
 * whatever code the phone runs:
 *   full     Claude can run commands and edit files (what every phone could
 *            before; devices paired before this keep it).
 *   noshell  no commands, no file edits, no browser, no tools other
 *            programs added (MCP servers); reading, searching and answering
 *            stay. bypassPermissions is refused.
 *   chat     plan mode only (read-only), mode changes refused, plans cannot
 *            be carried out from the phone.
 * checkPhoneCommand clamps the mode an open asks for (phone pages always
 * ask for one; an older page asks for bypassPermissions) and refuses a mode
 * change the capability does not allow. engine.js applies capRunnerOptions,
 * capCanUseTool and capPreToolUse to every phone pane, so the tools are
 * also refused inside Claude Code, in every permission mode.
 *
 * Permission prompts (2026-10-12, permissions.js): in Ask permissions and
 * Auto-accept edits a tool Claude Code would ask about is asked on the
 * phone, through the same answer op as a question. capCanUseTool refuses
 * what the capability blocks first and hands everything else to that
 * prompt, so a phone answers only for its own panes and only within its
 * access. The answer carries the yes or no (and `always: true`), never
 * rules: the engine applies the SDK's own suggestions, and only for a
 * 'full' phone; a restricted phone's "always" is an allow once.
 */

export const PHONE_PREFIX = 'phone:';

/** Engine ops a phone may send. artifactGet only when the engine has that op. */
export const PHONE_OPS = Object.freeze([
  'sessions', 'search',
  'open', 'attach', 'send', 'interrupt', 'answer', 'model', 'effort', 'mode', 'commands', 'close',
  'artifactGet',
  // 2026-10-10: steering a queued message into the running turn (same power as send), and the context meter.
  'steer', 'contextUsage',
  // Not here on purpose (2026-10-10): queueSet and autoCompact. A phone's queue stays in the phone's own pane, so the engine never
  // sends one for a phone (queue-hold.js), and "Auto-compact at" is the PC's setting. A phone's send also never carries `queued`
  // (the cases below keep only the fields each op uses).
  // 2026-10-10 (history.js): read only, the rest of a conversation open in one of this phone's panes:
  // earlier pages, and one cut tool result, thinking block, summary or image in full.
  'historyBefore', 'historyBlock',
  // Whether its conversation moved on elsewhere, so the phone shows no stale transcript (2026-10-11).
  'historyCheck',
  // Codex (2026-10-12, codex-panes.js): its model list (each model's own efforts) for the pickers, and the Codex threads for the
  // Codex view of the list. Both read only; a Codex pane then uses the ops above (open, send, steer, interrupt, answer...).
  'codexModels', 'codexThreads',
  // Git worktrees (2026-10-12, worktrees.js; WORKTREES.md): looking at repositories, branches and diffs is allowed at every
  // access level (the same files are readable through Claude in plan mode); planning or running an action (create, remove,
  // commit, push, pull request, merge) needs Full, like running commands from the phone. Not here on purpose:
  // worktreeTerminal, which opens a window on the PC.
  'worktrees', 'worktreeDiff', 'worktreePlan', 'worktreeRun',
]);

/** What worktreePlan and worktreeRun can be asked to do (worktrees.js KINDS; test/apaki-worktrees-engine.test.js keeps the lists equal). */
export const WORKTREE_KINDS = Object.freeze(['create', 'remove', 'commit', 'push', 'pr', 'merge']);

/** Ops that act on one pane (paneId required). */
const PANE_OPS = new Set(['open', 'attach', 'send', 'interrupt', 'model', 'effort', 'mode', 'commands', 'close', 'steer', 'contextUsage', 'historyBefore', 'historyBlock', 'historyCheck']);

/** Most panes one phone may have open at once (the desktop's limit per tab). */
export const MAX_PHONE_PANES = 6;

/** Events every connected phone gets, besides those for its own panes and requests. */
// desktopTabs (2026-10-11): the desktop's tabs and their panes, so a phone shows them (engine desktop-tabs.js).
// worktrees (2026-10-12): the repositories and worktrees with their change counts (engine worktrees.js), cached for later phones.
export const BROADCAST_EVENTS = new Set(['folders', 'glass', 'index', 'meaning', 'desktopTabs', 'worktrees']);

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODES = ['bypassPermissions', 'acceptEdits', 'plan', 'default'];
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/*
 * Codex panes (2026-10-12). Their model, effort and permissions are Codex's, not Claude's: any model id the app-server
 * lists, any effort a model offers, and the Codex app's three presets. A restricted phone (No shell, Chat only) gets
 * read-only: the sandbox is the PC's enforcement, whatever the phone sends (the engine clamps again in codex-panes.js).
 */
export const CODEX_MODES = ['full-access', 'auto', 'read-only'];
const CODEX_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const CODEX_EFFORT_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const MEDIA_RE = /^[A-Za-z0-9][\w.+-]{0,60}\/[A-Za-z0-9][\w.+-]{0,60}$/;
const MAX_FILES = 4;
const FILE_NAME_RE = /[^\w.\- ()]+/g;
/** The Codex presets a capability allows. */
export function capCodexModes(cap) {
  return cap === 'full' ? [...CODEX_MODES] : ['read-only'];
}

/* ---------- capabilities (what a phone may make Claude do) ---------- */

/** The capabilities, most power first. A device record without one is 'full' (paired before 2026-10-10). */
export const CAPS = Object.freeze(['full', 'noshell', 'chat']);

/** Words for each capability, for the Phone sheet and the notes a phone pane shows. */
export const CAP_LABEL = Object.freeze({ full: 'Full', noshell: 'No shell', chat: 'Chat only' });

/**
 * The capability of a device record: missing means 'full' (older records);
 * anything that is not a known value means 'chat' (fail closed); no record
 * at all (a pane whose phone was removed) means 'chat' too.
 */
export function capOf(device) {
  if (!device) return 'chat';
  const c = device.cap;
  if (c === undefined || c === null || c === '') return 'full';
  return CAPS.includes(c) ? c : 'chat';
}

/** The permission modes a capability allows. */
export function capModes(cap) {
  if (cap === 'full') return [...MODES];
  if (cap === 'noshell') return MODES.filter((m) => m !== 'bypassPermissions');
  return ['plan'];
}

/**
 * The mode a phone pane starts in when it does not ask for one. Never the
 * desktop's default (which starts as bypassPermissions): a phone pane says
 * what it runs in.
 */
export function capDefaultMode(cap) {
  return cap === 'full' || cap === 'noshell' ? 'default' : 'plan';
}

/** `mode` when the capability allows it, else the capability's default mode. */
export function clampMode(cap, mode) {
  return capModes(cap).includes(mode) ? mode : capDefaultMode(cap);
}

/**
 * Apaki's own browser tools (apaki/engine/browser-tools.js BROWSER_TOOLS, on
 * the "apaki" MCP server). Listed here so this file stays free of imports;
 * test/apaki-remote-caps.test.js checks the two lists agree.
 */
export const APAKI_BROWSER_TOOLS = Object.freeze(['browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_back', 'browser_screenshot'].map((t) => `mcp__apaki__${t}`));

/** Tools a 'noshell' or 'chat' phone pane never gets: commands, file edits, Apaki's browser. */
export const CAP_BLOCKED_TOOLS = Object.freeze(['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', ...APAKI_BROWSER_TOOLS]);

/** The one MCP tool a restricted phone pane keeps: Apaki's show, which writes only Apaki's own store. */
const CAP_KEPT_MCP = new Set(['mcp__apaki__show']);

/**
 * Search tools a restricted pane is given by name: a native Claude Code build
 * may search through Bash instead of Grep and Glob (Agent SDK sdk.d.ts,
 * `tools`), and Bash is gone there. Both only read.
 */
export const CAP_SEARCH_TOOLS = Object.freeze(['Grep', 'Glob']);

/**
 * True when a phone with this capability may not use the tool. For
 * 'noshell' and 'chat': the blocked list, and every MCP tool but Apaki's
 * show (an MCP server from the user's settings can do anything, a shell
 * included).
 */
export function capBlocksTool(cap, name) {
  if (cap === 'full') return false;
  const n = String(name || '');
  if (CAP_BLOCKED_TOOLS.includes(n)) return true;
  return n.startsWith('mcp__') && !CAP_KEPT_MCP.has(n);
}

/** Why a tool was refused, for Claude (it reads this) and the person on the phone. */
export function capDeniedText(cap, name) {
  return `This phone is set to ${CAP_LABEL[cap] || cap} on the PC, so Claude may not use ${String(name || 'that tool').slice(0, 80)} from it. Answer in text instead; the person can change the phone's access in Apaki's Phone sheet on the PC.`;
}

/** What a chat-only phone pane says when Claude asks to carry out a plan. */
export const CAP_PLAN_TEXT = 'This phone is set to Chat only on the PC, so plans cannot be carried out from it. Keep planning, or present the plan as text; the person can carry it out on the PC.';

/** Why a mode change was refused. */
export function capModeText(cap, mode) {
  if (cap === 'chat') return 'This phone is set to Chat only on the PC, so it stays in plan mode.';
  return `This phone is set to ${CAP_LABEL[cap] || cap} on the PC, so it cannot use ${mode === 'bypassPermissions' ? 'Bypass permissions' : String(mode).slice(0, 40)}.`;
}

/** Why a worktree action was refused for a phone below Full access (the PC owner can change it in the Phone sheet). */
export function capWorktreeText(cap) {
  return `This phone is set to ${CAP_LABEL[cap] || cap} on the PC, so it can look at worktrees and their changes but not create, commit, push, merge or remove them. The person can change the phone's access in Apaki's Phone sheet on the PC.`;
}

/** The line a restricted phone pane shows when it opens (null for 'full', whose mode chip says enough). */
export function capNote(cap) {
  if (cap === 'noshell') return 'This phone is set to No shell on the PC: Claude can read, search and answer here, but cannot run commands, edit files, use the browser or use tools other programs added.';
  if (cap === 'chat') return 'This phone is set to Chat only on the PC: plan mode, read-only. Claude cannot run commands or change anything from here.';
  return null;
}

/**
 * The SessionRunner options a phone pane gets for its capability (engine.js
 * open): the mode it may use, the tools it may not (removed from Claude's
 * context; per the Agent SDK this also blocks the harness's own direct
 * calls), and the search tools it is given by name.
 */
export function capRunnerOptions(cap, mode) {
  const out = { permissionMode: clampMode(cap, mode) };
  if (cap !== 'full') {
    out.disallowedTools = [...CAP_BLOCKED_TOOLS];
    out.allowedTools = [...CAP_SEARCH_TOOLS];
  }
  return out;
}

/**
 * A canUseTool for a phone pane: refuses what the capability blocks (and,
 * for 'chat', carrying out a plan), otherwise answers like `base`.
 * `getCap` is read on every call, so a change on the PC applies at once.
 */
export function capCanUseTool(getCap, base) {
  return async (name, input, extra) => {
    const cap = getCap();
    if (capBlocksTool(cap, name) || (cap === 'chat' && name === 'ExitPlanMode')) return { behavior: 'deny', message: name === 'ExitPlanMode' ? CAP_PLAN_TEXT : capDeniedText(cap, name) };
    return base(name, input, extra);
  };
}

/**
 * A PreToolUse hook matcher (every tool) that denies what the capability
 * blocks. Hooks run in every permission mode, bypassPermissions included
 * (src/runner.js), so this holds where canUseTool is never asked.
 */
export function capPreToolUse(getCap) {
  return {
    hooks: [async (input) => {
      const cap = getCap();
      if (!capBlocksTool(cap, input?.tool_name)) return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: capDeniedText(cap, input.tool_name) } };
    }],
  };
}

const LOCAL_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const REQ_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{22}$/;
// A Codex thread is codex:<id> (2026-10-12); everything else is a bare id.
const SESSION_RE = /^(?:codex:)?[A-Za-z0-9-]{8,80}$/;
const MODEL_RE = /^claude-[a-z0-9.-]{1,60}$/;
const MAX_TEXT = 200_000;
const MAX_QUERY = 500;
const MAX_IMAGES = 8;
const MAX_IMAGE_B64 = 8 * 1024 * 1024;
// historyBefore and historyBlock (history.js): a message uuid, a block reference (the same form as
// history.js REF_RE; kept here so this file stays free of imports) and the largest page.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(\d{1,5}|s)(?::\d{1,5})?$/i;
const MAX_HISTORY_PAGE = 5000;
// worktreePlan and worktreeRun: the longest folder, branch name, commit message, pull request description and file list a phone may send.
const MAX_PATH_CHARS = 1024;
const MAX_BRANCH = 120;
const MAX_COMMIT_MESSAGE = 5000;
const MAX_PR_BODY = 20000;
const MAX_COMMIT_PATHS = 200;

/** The engine pane id of a phone's pane. */
export function phonePaneId(deviceId, local) {
  return `${PHONE_PREFIX}${deviceId}:${local}`;
}

/** Splits phone:<deviceId>:<local> (a pane or request id); null for anything else. */
export function parsePhoneId(id) {
  if (typeof id !== 'string' || !id.startsWith(PHONE_PREFIX)) return null;
  const rest = id.slice(PHONE_PREFIX.length);
  const i = rest.indexOf(':');
  if (i < 0) return null;
  const deviceId = rest.slice(0, i);
  const local = rest.slice(i + 1);
  if (!DEVICE_RE.test(deviceId) || !local) return null;
  return { deviceId, local };
}

/** True for a pane id that belongs to a phone. */
export const isPhonePane = (id) => parsePhoneId(id) !== null;

/** The window a pane belongs to: 'desktop', or phone:<deviceId>. */
export function windowOf(paneId) {
  const p = parsePhoneId(paneId);
  return p ? `${PHONE_PREFIX}${p.deviceId}` : 'desktop';
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (error, cmd) => ({ ok: false, error, reqId: typeof cmd?.reqId === 'string' ? cmd.reqId.slice(0, 64) : null, paneId: typeof cmd?.paneId === 'string' ? cmd.paneId.slice(0, 40) : null });

/**
 * Checks one command from a phone and rewrites it for the engine: only the
 * fields the op uses are kept, ids get the phone's prefix.
 *
 * @param {object} cmd  what the phone sent ({ op, reqId, paneId, ... })
 * @param {object} ctx
 * @param {string} ctx.deviceId
 * @param {(op: string) => boolean} [ctx.hasOp]  the engine has this op (artifactGet)
 * @param {(paneId: string) => boolean} [ctx.paneExists]
 * @param {(deviceId: string) => number} [ctx.paneCount]  panes this phone has in the engine
 * @param {(askId: string) => (string|null)} [ctx.askPane]  the pane a pending question belongs to
 * @param {(cwd: string) => boolean} [ctx.knownCwd]  a folder some listed session ran in, or a worktree the engine lists (worktrees.js)
 * @param {(deviceId: string) => string[]} [ctx.phoneSessions]  sessions open in this phone's panes
 * @param {(paneId: string) => ('codex'|'claude')} [ctx.paneKind]  what a pane runs (2026-10-12): a Codex pane takes Codex's models, efforts and presets, and files
 * @param {string} [ctx.cap]  the phone's capability (CAPS); absent means 'full' (callers from before capabilities)
 * @returns {{ok: true, cmd: object} | {ok: false, error: string, reqId: string|null, paneId: string|null}}
 */
export function checkPhoneCommand(cmd, ctx) {
  const { deviceId } = ctx;
  const cap = ctx.cap === undefined ? 'full' : (CAPS.includes(ctx.cap) ? ctx.cap : 'chat');
  if (!isObj(cmd)) return fail('A command must be an object.', null);
  const op = cmd.op;
  if (typeof op !== 'string' || !PHONE_OPS.includes(op)) return fail(`"${String(op).slice(0, 40)}" is not available from a phone.`, cmd);
  if (op === 'artifactGet' && !(ctx.hasOp?.(op))) return fail('Artifacts are not available on this PC.', cmd);
  if (cmd.reqId !== undefined && cmd.reqId !== null && (typeof cmd.reqId !== 'string' || !REQ_ID_RE.test(cmd.reqId))) return fail('Bad request id.', null);
  const out = { op };
  if (cmd.reqId) out.reqId = phonePaneId(deviceId, cmd.reqId);

  let paneId = null;
  if (PANE_OPS.has(op) || (op === 'artifactGet' && cmd.paneId != null)) {
    if (typeof cmd.paneId !== 'string' || !LOCAL_ID_RE.test(cmd.paneId)) return fail('Bad pane id.', cmd);
    paneId = phonePaneId(deviceId, cmd.paneId);
    out.paneId = paneId;
    const exists = ctx.paneExists ? ctx.paneExists(paneId) : true;
    if (op === 'open' || op === 'attach') {
      if (!exists && (ctx.paneCount?.(deviceId) ?? 0) >= MAX_PHONE_PANES) return fail(`A phone can have ${MAX_PHONE_PANES} conversations open at once. Close one first.`, cmd);
    } else if (!exists && op !== 'close') {
      return fail('That pane is not open on the PC.', cmd);
    }
  }

  // What this pane runs, for the ops that carry a model, an effort, a mode or files.
  const codexPane = paneId !== null && ctx.paneKind?.(paneId) === 'codex';

  switch (op) {
    case 'sessions':
      break;
    case 'codexModels':
      break;
    case 'codexThreads':
      if (cmd.refresh !== undefined) out.refresh = cmd.refresh === true;
      break;
    case 'search':
      if (typeof cmd.query !== 'string') return fail('A search needs a query.', cmd);
      out.query = cmd.query.slice(0, MAX_QUERY);
      break;
    case 'open':
    case 'attach': {
      const sid = cmd.sessionId ?? null;
      if (sid !== null && (typeof sid !== 'string' || !SESSION_RE.test(sid))) return fail('Bad session id.', cmd);
      out.sessionId = sid;
      // A phone does not choose folders on the PC: a session runs where it
      // always ran (the engine reads it from the session), and a new
      // conversation starts in a folder some listed session already uses, or
      // in the home folder.
      out.cwd = typeof cmd.cwd === 'string' && cmd.cwd && ctx.knownCwd?.(cmd.cwd) ? cmd.cwd : null;
      if (op === 'open') {
        if (cmd.warm !== undefined) out.warm = cmd.warm !== false;
        if (cmd.force !== undefined) out.force = cmd.force === true;
        // A Codex conversation: a codex: session, or a new one asked to be (kind). Its picks are Codex's.
        const codexOpen = cmd.kind === 'codex' || (typeof sid === 'string' && sid.startsWith('codex:'));
        if (codexOpen) out.kind = 'codex';
        if (cmd.model != null) { if (!(codexOpen ? CODEX_MODEL_RE : MODEL_RE).test(String(cmd.model))) return fail('Unknown model.', cmd); out.model = cmd.model; }
        if (cmd.effort != null) { if (!(codexOpen ? CODEX_EFFORT_RE.test(String(cmd.effort)) : EFFORTS.includes(cmd.effort))) return fail('Unknown effort.', cmd); out.effort = cmd.effort; }
        // Clamped, not refused: every phone page asks for a mode on open (an older one always for
        // bypassPermissions), and refusing would leave a restricted phone unable to open anything.
        if (cmd.mode != null) {
          if (codexOpen) { if (!CODEX_MODES.includes(cmd.mode)) return fail('Unknown permission mode.', cmd); out.mode = capCodexModes(cap).includes(cmd.mode) ? cmd.mode : capCodexModes(cap)[0]; }
          else { if (!MODES.includes(cmd.mode)) return fail('Unknown permission mode.', cmd); out.mode = clampMode(cap, cmd.mode); }
        }
      }
      break;
    }
    case 'steer':
      // The window's own id for the steered message comes back on steered / steer_missed.
      if (typeof cmd.qid !== 'string' || !LOCAL_ID_RE.test(cmd.qid)) return fail('Bad message id.', cmd);
      out.qid = cmd.qid;
      // falls through: the text and images are checked like a sent message
    case 'send': {
      if (cmd.text != null && typeof cmd.text !== 'string') return fail('Bad message.', cmd);
      const text = String(cmd.text ?? '');
      if (text.length > MAX_TEXT) return fail('That message is too long.', cmd);
      const images = cmd.images ?? [];
      if (!Array.isArray(images) || images.length > MAX_IMAGES) return fail(`At most ${MAX_IMAGES} images per message.`, cmd);
      const clean = [];
      let files = 0;
      for (const im of images) {
        // A Codex pane also takes other files (2026-10-12): up to MAX_FILES, saved by the engine where Codex can read them.
        if (codexPane && isObj(im) && !IMAGE_TYPES.has(im.media_type) && MEDIA_RE.test(String(im.media_type || 'application/octet-stream')) && typeof im.data === 'string' && im.data.length <= MAX_IMAGE_B64 && /^[A-Za-z0-9+/=]+$/.test(im.data)) {
          if (++files > MAX_FILES) return fail(`At most ${MAX_FILES} files per message.`, cmd);
          clean.push({ media_type: String(im.media_type || 'application/octet-stream'), data: im.data, name: String(im.name || 'file').replace(FILE_NAME_RE, '_').slice(0, 120) });
          continue;
        }
        if (!isObj(im) || !IMAGE_TYPES.has(im.media_type) || typeof im.data !== 'string' || im.data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(im.data)) return fail(codexPane ? 'A file could not be sent (at most 6 MB).' : 'An image could not be sent (PNG, JPEG, GIF or WebP, at most 6 MB).', cmd);
        clean.push({ media_type: im.media_type, data: im.data });
      }
      if (!text.trim() && !clean.length) return fail('Nothing to send.', cmd);
      out.text = text;
      out.images = clean;
      break;
    }
    case 'interrupt':
    case 'commands':
    case 'close':
    case 'contextUsage':
      break;
    case 'answer': {
      if (typeof cmd.askId !== 'string' || cmd.askId.length > 80) return fail('Bad question id.', cmd);
      const owner = ctx.askPane?.(cmd.askId) ?? null;
      if (!owner || windowOf(owner) !== `${PHONE_PREFIX}${deviceId}`) return fail('That question belongs to another window.', cmd);
      const r = cmd.result;
      if (r !== null && r !== undefined) {
        if (!isObj(r) || (r.behavior !== 'allow' && r.behavior !== 'deny')) return fail('Bad answer.', cmd);
        out.result = { behavior: r.behavior };
        if (r.behavior === 'allow' && isObj(r.updatedInput)) out.result.updatedInput = r.updatedInput;
        // "Always allow" on a permission prompt (2026-10-12, permissions.js): only the yes, never rules. The engine applies the
        // SDK's own suggestions for that call, and only when this phone's access may save a rule (full).
        if (r.behavior === 'allow' && r.always === true) out.result.always = true;
        if (typeof r.message === 'string') out.result.message = r.message.slice(0, 2000);
      } else {
        out.result = null;
      }
      out.askId = cmd.askId;
      break;
    }
    case 'model':
      if (!(codexPane ? CODEX_MODEL_RE : MODEL_RE).test(String(cmd.model))) return fail('Unknown model.', cmd);
      out.model = cmd.model;
      break;
    case 'effort':
      if (!(codexPane ? CODEX_EFFORT_RE.test(String(cmd.effort)) : EFFORTS.includes(cmd.effort))) return fail('Unknown effort.', cmd);
      out.effort = cmd.effort;
      break;
    case 'mode':
      // A Codex pane takes the Codex app's presets; only a Full phone may leave read-only (the PC's sandbox is what enforces it).
      if (codexPane) {
        if (!CODEX_MODES.includes(cmd.mode)) return fail('Unknown permission mode.', cmd);
        if (!capCodexModes(cap).includes(cmd.mode)) return fail(`This phone is set to ${CAP_LABEL[cap] || cap} on the PC, so it stays read-only.`, cmd);
        out.mode = cmd.mode;
        break;
      }
      if (!MODES.includes(cmd.mode)) return fail('Unknown permission mode.', cmd);
      // The capability decides (chat: plan only; noshell: no bypassPermissions).
      if (!capModes(cap).includes(cmd.mode)) return fail(capModeText(cap, cmd.mode), cmd);
      out.mode = cmd.mode;
      break;
    case 'artifactGet': {
      // Only artifacts of sessions this phone has open.
      if (typeof cmd.id !== 'string' || cmd.id.length > 120) return fail('Bad artifact id.', cmd);
      const sid = cmd.sessionId;
      if (typeof sid !== 'string' || !(ctx.phoneSessions?.(deviceId) || []).includes(sid)) return fail('Open the conversation that made this artifact first.', cmd);
      out.id = cmd.id;
      out.sessionId = sid;
      if (Number.isInteger(cmd.rev)) out.rev = cmd.rev;
      if (cmd.content !== undefined) out.content = Boolean(cmd.content);
      break;
    }
    case 'historyBefore':
    case 'historyBlock': {
      // Read only. The pane must be this phone's and open (checked above); the engine reads only the
      // session open in that pane, and a session id, when sent, must be one this phone has open.
      const sid = cmd.sessionId ?? null;
      if (sid !== null && (typeof sid !== 'string' || !SESSION_RE.test(sid) || !(ctx.phoneSessions?.(deviceId) || []).includes(sid))) return fail('Open that conversation first.', cmd);
      if (sid) out.sessionId = sid;
      if (op === 'historyBefore') {
        if (typeof cmd.before !== 'string' || !UUID_RE.test(cmd.before)) return fail('Bad message id.', cmd);
        out.before = cmd.before;
        if (cmd.limit != null) { if (!Number.isInteger(cmd.limit) || cmd.limit < 1 || cmd.limit > MAX_HISTORY_PAGE) return fail('Bad page size.', cmd); out.limit = cmd.limit; }
        if (cmd.all !== undefined) out.all = cmd.all === true;
      } else {
        if (typeof cmd.ref !== 'string' || !HISTORY_REF_RE.test(cmd.ref)) return fail('Bad message part.', cmd);
        out.ref = cmd.ref;
      }
      break;
    }
    case 'worktrees': {
      // Which folder the phone is looking at: one the PC already knows (a session's folder or a worktree), else the whole list.
      out.cwd = typeof cmd.cwd === 'string' && cmd.cwd.length <= MAX_PATH_CHARS && ctx.knownCwd?.(cmd.cwd) ? cmd.cwd : null;
      if (cmd.full === true && out.cwd) out.full = true;
      if (cmd.refresh === true) out.refresh = true;
      break;
    }
    case 'worktreeDiff': {
      // Read only, and only a folder the PC already lists: a phone cannot point git at an arbitrary path.
      if (typeof cmd.path !== 'string' || cmd.path.length > MAX_PATH_CHARS || !ctx.knownCwd?.(cmd.path)) return fail('That folder is not one of the PC\'s worktrees.', cmd);
      out.path = cmd.path;
      out.scope = cmd.scope === 'head' ? 'head' : 'base';
      break;
    }
    case 'worktreePlan':
    case 'worktreeRun': {
      // Running git on the PC is the shell-level power Full access gives; No shell and Chat only get a plain refusal.
      if (cap !== 'full') return fail(capWorktreeText(cap), cmd);
      if (!WORKTREE_KINDS.includes(cmd.kind)) return fail('That worktree action does not exist.', cmd);
      const where = cmd.kind === 'create' ? cmd.repo : cmd.path;
      if (typeof where !== 'string' || where.length > MAX_PATH_CHARS || !ctx.knownCwd?.(where)) return fail('That folder is not one of the PC\'s worktrees.', cmd);
      out.kind = cmd.kind;
      if (cmd.kind === 'create') out.repo = where; else out.path = where;
      const text = (v, max, what, { required = false } = {}) => {
        if (v == null || v === '') return required ? `Missing ${what}.` : null;
        return typeof v === 'string' && v.length <= max ? null : `Bad ${what}.`;
      };
      let bad = null;
      if (cmd.kind === 'create') {
        bad = text(cmd.branch, MAX_BRANCH, 'branch name', { required: true }) || text(cmd.base, MAX_BRANCH, 'base branch');
        out.branch = cmd.branch; out.base = cmd.base || undefined; out.useExisting = cmd.useExisting === true;
      } else if (cmd.kind === 'remove') {
        out.deleteBranch = cmd.deleteBranch === true;
      } else if (cmd.kind === 'commit') {
        bad = text(cmd.message, MAX_COMMIT_MESSAGE, 'commit message');
        out.message = cmd.message || '';
        if (cmd.paths != null) {
          if (!Array.isArray(cmd.paths) || cmd.paths.length > MAX_COMMIT_PATHS || cmd.paths.some((x) => typeof x !== 'string' || x.length > MAX_PATH_CHARS)) bad = 'Bad file list.';
          else out.paths = cmd.paths;
        }
      } else if (cmd.kind === 'pr') {
        bad = text(cmd.title, 300, 'title') || text(cmd.body, MAX_PR_BODY, 'description') || text(cmd.base, MAX_BRANCH, 'base branch');
        out.title = cmd.title || ''; out.body = cmd.body || ''; out.base = cmd.base || undefined; out.draft = cmd.draft === true;
      } else if (cmd.kind === 'merge') {
        bad = text(cmd.into, MAX_BRANCH, 'branch to merge into');
        out.into = cmd.into || undefined;
      }
      if (bad) return fail(bad, cmd);
      break;
    }
    case 'historyCheck': {
      // Read only, like historyBefore: whether this phone's own pane shows the newest transcript (2026-10-11).
      const sid = cmd.sessionId ?? null;
      if (sid !== null && (typeof sid !== 'string' || !SESSION_RE.test(sid) || !(ctx.phoneSessions?.(deviceId) || []).includes(sid))) return fail('Open that conversation first.', cmd);
      if (sid) out.sessionId = sid;
      if (cmd.rev != null) { if (typeof cmd.rev !== 'string' || !/^\d{1,15}:\d{1,16}$/.test(cmd.rev)) return fail('Bad revision.', cmd); out.rev = cmd.rev; }
      break;
    }
    default:
      return fail('Not available from a phone.', cmd);
  }
  return { ok: true, cmd: out };
}

/**
 * Where an engine event goes. Returns { deviceId, ev } with the phone's own
 * ids put back when the event is about a phone's pane or answers a phone's
 * request (only that phone gets it, the desktop does not), else null (the
 * desktop gets it; BROADCAST_EVENTS also go to every connected phone).
 */
export function routeEvent(ev) {
  if (!isObj(ev)) return null;
  const byPane = parsePhoneId(ev.paneId);
  const byReq = parsePhoneId(ev.reqId);
  const deviceId = byPane?.deviceId || byReq?.deviceId;
  if (!deviceId) return null;
  const out = { ...ev };
  if (byPane) out.paneId = byPane.deviceId === deviceId ? byPane.local : null;
  if (byReq) out.reqId = byReq.deviceId === deviceId ? byReq.local : null;
  if (typeof ev.otherPane === 'string') {
    const other = parsePhoneId(ev.otherPane);
    out.otherPane = other && other.deviceId === deviceId ? other.local : null;
  }
  return { deviceId, ev: out };
}

const FIRST_PROMPT_CHARS = 200;
const trimItem = (it) => (it && typeof it.firstPrompt === 'string' && it.firstPrompt.length > FIRST_PROMPT_CHARS ? { ...it, firstPrompt: it.firstPrompt.slice(0, FIRST_PROMPT_CHARS) } : it);

/**
 * An event as a phone should see it: voice off (dictation is the phone
 * keyboard's job; the PC's Whisper is not reachable from a phone), and the
 * session list trimmed to what the phone shows.
 */
export function phoneView(ev) {
  if (!isObj(ev)) return ev;
  let out = ev;
  if ('voice' in ev) out = { ...out, voice: false };
  if (ev.ev === 'sessions' && Array.isArray(ev.items)) out = { ...out, items: ev.items.map(trimItem) };
  if ((ev.ev === 'search' || ev.ev === 'askSearch') && Array.isArray(ev.results)) out = { ...out, results: ev.results.map((r) => (r && r.item ? { ...r, item: trimItem(r.item) } : r)) };
  if (ev.ev === 'codexThreads' && Array.isArray(ev.items)) out = { ...out, items: ev.items.map(trimItem) };
  return out;
}

/** A small fast hash (FNV-1a, 32 bit) of a string: the session list is sent again only when it changed. */
export function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
