#!/usr/bin/env node
/**
 * engine.js: Myrlin Apaki's bridge to Claude Code.
 *
 * Started by the Apaki window (apaki/src/main.rs). Reads one JSON command per
 * line on stdin and prints one JSON event per line on stdout. Everything else
 * (logs, Claude Code's stderr) goes to stderr, which the window writes to
 * ~/.claude/latch/apaki-engine.log.
 *
 * It reuses latch's tested pieces instead of new ones:
 *   - SessionRunner (src/runner.js): Claude Code through the Agent SDK,
 *     resumed on the chosen session, so every turn lands in that session and
 *     `claude --resume <id>` continues it on the subscription.
 *   - glassCredential (src/auth.js): billing follows Myrlin Glass both ways,
 *     re-checked before every message.
 *   - the picker data (src/ui/picker.js makeLoader, terminalSessions, folders)
 *     and the deep index (src/deepindex.js, latch-index).
 *
 * Commands (op): sessions, search, open, send, interrupt, answer, model,
 * effort, mode, tune (Ultracode and its size on a Claude pane, summary and speed on a Codex pane; tune.js, 2026-10-13),
 * billing, commands, folder, close, askSearch, digPrompt, queueSet
 * (a pane's queued messages, kept for a window-less host: queue-hold.js),
 * autoCompact ("Auto-compact at": prefs.js). Events (ev): ready, index,
 * sessions, search, opened, history, sdk, result, ask, billing, commands, note,
 * error, open_elsewhere, closed, settings (a pane's model, effort and mode,
 * shown in its message box instead of as notes in the conversation).
 *
 * Panes (2026-10-09, Arthur: tabs and up to 6 split panes, each its own
 * session): every conversation command carries a paneId and every event about
 * a conversation carries it back. Each pane has its own runner (its own Claude
 * Code process), model, effort, mode and billing, so panes work at the same
 * time. One session can be open in one pane only.
 *
 * Phones (Track B, 2026-10-09; remote.js): with phone access on, paired
 * phones send the same commands through the relay, checked against an
 * allowlist (remote-policy.js). Their panes are phone:<deviceId>:<name>, and
 * events about them (and answers to their requests) go to that phone instead
 * of the window. A session open on the desktop and on a phone gets the same
 * "Session in use" card and takeover as one held by another app. Desktop ops:
 * remoteStatus, remoteEnable, remoteDisable, remotePairStart,
 * remotePairCancel, remotePairDecision, remoteDevices, remoteRevoke (ev
 * remote; since 2026-10-11 also remotePhoneDecision, remoteNoticeDismiss).
 * attach re-sends a pane's state without restarting it (a phone that
 * reconnected).
 * Artifacts (2026-10-09, Arthur: like Codex's built-in artifacts, out of the
 * box): every pane's Claude Code gets Apaki's tools at runtime, through SDK
 * options only (apaki-tools.js): the in-process MCP server "apaki" with its
 * show tool, a short appended system prompt, PreToolUse/PostToolUse hooks that
 * turn "open this" shell commands into artifacts, and BROWSER pointing at
 * apaki/bin/apaki-open.cmd with a per-pane token for this engine's localhost
 * server (open-server.js), which also serves artifacts to the viewer.
 *   ev artifact  { paneId, sessionId, id, title, kind, rev, path, src, ext, mime, size, source, revs, via, toolUseId }
 *   ev openUrl   { paneId, sessionId, url, reason, title, toolUseId, browserId? }  (a web page
 *                to open: the conversation draws a link card, the built-in browser shows it)
 *   op artifactGet { id, sessionId?, rev?, content? } -> ev artifactContent (meta, src, and the
 *                content: utf8 for html/markdown/svg/text, base64 for image/pdf)
 *   op artifactList { sessionId } -> ev artifacts { sessionId, items }
 *   op openExternal { url } or { id, sessionId?, rev? } -> the system browser / default app
 * Viewers like ChatGPT's side window (2026-10-13): artifact events and artifactContent also carry lang (a language
 * hint) and by ('session' or 'user'), and every revision its kind and by; workbooks and Word documents come as base64.
 *   op artifactSave { id, sessionId?, rev?, name? } or { data, encoding?, name } -> ev artifactSaved { ok, name, path }
 *                (a revision's file, or a table or chart the viewer exported, into Downloads, shown in Explorer)
 *   op artifactEdit { id, sessionId, sourcePane?, baseRev, content, force? } -> ev artifactEdited { ok, rev | message,
 *                stale } and an artifact event (via 'user-edit') for the conversation: the user's own revision
 *   Both are PC only (remote-policy.js PC_ONLY_OPS).
 *
 * The built-in browser (2026-10-09, Arthur: "a built-in browser like
 * Codex's, driven by Claude, light and fast"): the shell owns the browser
 * (apaki/src/browser.rs, a WebView2 with no bridge to Tauri or this engine);
 * the engine asks it for things over the same pipes (shell-channel.js):
 *   ev shell       { id, cmd, args }   a request for the shell, never shown to the window
 *   op shellReply  { id, ok, result | error }   its answer
 *   op shellHello  { version, features }        the shell's first line
 * With a browser, every pane's Claude Code also gets browser_open, _read,
 * _click, _type, _back, _screenshot and _tabs (browser-tools.js), and web pages
 * from show, caught commands and BROWSER open in that browser.
 * One browser pane per conversation, tabs inside it (2026-10-12, Arthur: "the
 * session that opens a browser should have that window ... and additional tabs
 * should open IN the browser pane"): every shell browser id a pane owns is a tab
 * of its one pane; the tools act on the ACTIVE tab (browser-tools.js).
 *   ev openUrl     gains browserId when the page went to the built-in browser
 *   ev browserActivity { paneId, browserId, action, text }   what Claude just did there
 *   op browserTool { paneId, tool, input } -> ev browserToolResult { ok, text, image? }
 *                  (runs one of Claude's browser tools for a pane: checks, later the phone)
 *   op browserView { paneId, tab? } -> ev browserView { ok, text, state, image, mime, width, height, at, tabs }
 *                  (2026-10-12: one quiet JPEG of the page in the pane's browser, for a phone's Browser view;
 *                  tab is a browser id of that pane's own tabs: it becomes the active tab first, and the desktop
 *                  pane follows through a browserActivity select; tabs is [{ id, title, url, loading, active }] or null)
 *   op browserTab { paneId, browserId }   the person picked a tab in the pane's tab strip: that tab is the one
 *                  Claude's browser tools act on from now on (silent: no event; desktop only, never a phone op)
 *
 * The background host (2026-10-10, Arthur: closing Apaki must not close the
 * Claude sessions that are open; see host.js for the whole design): the
 * Apaki shell runs this file as `engine.js --host`, detached, one per app id.
 * The same JSON lines then travel over an authenticated 127.0.0.1 connection
 * instead of stdin/stdout, and closing the window only disconnects it. Run
 * without --host (tests, scripts), the engine works on stdin/stdout exactly
 * as before and exits when stdin closes.
 *
 * The whole history (2026-10-10, history.js): ev history now carries the
 * newest page of the full conversation, across compactions, read from the
 * transcript (source 'transcript'; the SDK's list is the fallback, source
 * 'sdk'), with compaction markers, thinking text and flags on cut blocks.
 *   ev history     { paneId, sessionId, messages, total, hasMore, first, earlier, compactions, source }
 *   op historyBefore { paneId, sessionId?, before, limit?, all? } -> ev historyPage (same fields, to prepend)
 *   op historyBlock  { paneId, sessionId?, ref } -> ev historyBlock { ref, kind, text | media_type + data }
 * Your prompts, exact (2026-10-12, history.js promptOf): every user message of a page says prompt: { text, images } or
 * false, and the pane draws a bubble for exactly the prompts; pages carry prompts: { before, total }.
 *   op historyPrompts { paneId, sessionId? } -> ev historyPrompts { prompts: [{ id, text, at, images }], total }
 *   op historyBefore   gains until (a message id the page must reach back to)
 *   ev historyCount    { paneId, sessionId, first, prompts: { before, total } }   a Codex thread's count, a moment after its first page
 *
 * Permission prompts (2026-10-12, permissions.js): in Ask permissions and Auto-accept edits Claude Code asks
 * before a tool it does not already allow, and the pane's window (or phone) is asked the same way a question is:
 *   ev ask         gains `permission` (title, displayName, description, decisionReason, blockedPath, mcpServer,
 *                  agentId, toolUseId, defaultToNo, cut, always: { lines } | null) when the ask is a tool call
 *   op answer      result { behavior: 'allow', always? } or { behavior: 'deny', message? } settles it once
 *   ev ask_gone    the call is over (the turn ended, Claude Code cancelled it): drop its card
 *
 * Questions inline (2026-10-12, apaki/ui/askcard.js; Arthur: "when askuserquestion type things come up, it should be
 * shown in the pane and not lock the user from using the app"): the window draws each ask as a card in its pane, and
 * ask_gone says why it went, so that pane can say so in one quiet line:
 *   ev ask_gone    gains why: 'answered' | 'turn' | 'again' | 'stopped' | 'cancelled' | 'taken' | 'resolved' | 'closed',
 *                  and by (who answered: a phone's name or 'the PC'; the window that took the conversation, for 'taken')
 *
 * Codex panes (2026-10-12, codex-panes.js; Arthur: a Codex pane matches OpenAI's Codex app as close to 1:1 as possible):
 * a session id `codex:<thread id>`, or open with kind: 'codex' for a new conversation, makes the pane a Codex one. One
 * `codex app-server` process (codex-client.js) serves them, started when something first needs it. The same ops work
 * on it (open, attach, send, steer, interrupt, answer, model, effort, mode, contextUsage, commands, historyBefore,
 * historyCheck, rename, close); its events are the ones a Claude pane draws, built from the protocol's items by
 * codex-map.js, plus:
 *   op codexModels -> ev codexModels { models: [{ id, name, efforts: [{ value, description }], defaultEffort, isDefault }], defaults, presets, account }
 *   op codexThreads { refresh? } -> ev codexThreads { items }   the Codex threads on this PC as session rows (codex: true)
 *   ev opened      also carries kind: 'codex'
 *   mode           is one of the Codex app's presets: 'read-only' | 'auto' | 'full-access'
 *   ev artifact    via: 'codex-diff' | 'codex-image': a card, no viewer pops up by itself
 * Git worktrees (2026-10-12, worktrees.js and the section "git worktrees" below; design apaki/remote/WORKTREES.md):
 *   op worktrees { cwd?, full?, refresh? } -> ev worktrees { repos: [{ name, base, worktrees: [{ path, branch, added, removed, ahead, behind, ... }] }] }
 *   op worktreeDiff { path, scope? } -> ev worktreeDiff;  op worktreePlan / worktreeRun { kind, ... } -> ev worktreePlan / worktreeResult
 *   op worktreeTerminal { path } (the window only)
 * The session list (2026-10-12, session-info.js and pins.js; Arthur: compact rows like the ChatGPT app, everything else
 * in a menu and a Details sheet):
 *   op sessionInfo { sessionId } -> ev sessionInfo { sessionId, ok, info }   read only: transcript facts, size, live state
 *   op pin { sessionId, pinned } -> ev sessions (rows carry pinned: true)   Pin to top
 *   op exportSession { sessionId, inline? } -> ev exported { ok, name, path | markdown }   Export as Markdown
 *   (Open in a terminal sends op openTerminal { sessionId, kind, paneId? }: console.js and "The console" below)
 *   ev sessions rows also carry model (the last reply's, from the tail last-active.js reads)
 *
 * The console (2026-10-12, console.js; Arthur: "a toggle console that transitions a pane to console for either claude or
 * codex SEAMLESSLY ... should be the authentic tui experience"): a pane flips to `claude --resume <id>` or `codex resume
 * <id>` in a pseudo-terminal (node-pty) the window draws with xterm.js, and back. One writer: the pane's own process is
 * idle and let go first; the pane reads the transcript again when the TUI ends. PC only (remote-policy.js PC_ONLY_OPS).
 *   op consoleOpen   { paneId, cols, rows, command?, wait?, stop? } -> ev console { state, ... } then ev consoleData
 *   op consoleInput  { paneId, data }        keys and pastes, as the terminal sends them
 *   op consoleResize { paneId, cols, rows }
 *   op consoleClose  { paneId, wait?, stop? } the TUI's own quit, then the pane takes the conversation back
 *   op consoleView   { paneId } -> ev consoleView { text, state }   a plain look at the console that holds the conversation
 *                    this pane asked for (the phone's read-only view; the only console op a phone may send)
 *   op openTerminal  { paneId?, sessionId, kind? } the same command in a terminal window on the PC (apaki/bin/apaki-terminal.mjs);
 *                    ev terminal { paneId, sessionId, kind, state: 'opened' | 'closed' | 'error', display?, note? }
 *   ev opened        gains console: true when the pane's conversation is in its console (a window that reloaded)
 *
 *   op hostStatus -> ev host { pid, window, remoteOn, panes, lifecycle }
 *   op hostQuit { whenIdle: true } | { now: true } -> ev hostQuit { ok, pending, waiting }
 *   ev opened from attach also carries running (its Claude Code process is up)
 *                  and turn (any turn runs, also one Claude started by itself)
 *
 * The shared view (2026-10-11, remote.js "The shared view"; Arthur: a phone shows
 * the desktop's panes and swipes between them WITHOUT taking a pane's session
 * over): a phone pane follows a desktop pane instead of opening its session.
 *   op follow { reqId, paneId: <the phone's pane>, desktopPaneId, readOnly } (only from remote.js, after
 *                  checkPhoneCommand) -> to that phone pane only: ev opened { attached: true, follower: true, readOnly,
 *                  busy, turn, running, model, effort, mode, title ... } like attach (no queue: what the window
 *                  typed and has not sent is its own), ev history, the questions waiting (ev ask) and the running tasks.
 *                  After that remote.js sends the phone every event of the desktop pane (FOLLOW_EVENTS) too, and runs
 *                  the phone's send, steer, interrupt, answer, contextUsage and history ops on the desktop pane.
 *                  The desktop pane keeps its one runner: nothing is taken over, no second Claude Code starts.
 *   ev peerMessage { paneId, from, text, images, steered, origin }  a message another window sent into a desktop pane
 *                  (the engine does not echo user messages): from a phone, the window and the other followers draw it;
 *                  from the window, only the phones that follow get it. The sender drew its own (`origin`, never sent on)
 *   ev followers   { paneId, phones: [names] }  (from remote.js) who watches a desktop pane, for the window's "Also on" line
 *   ev ask_gone    now also follows an answer: the first answer, from the window or a phone, drops the other side's sheet
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { forkSession, getSessionInfo, getSessionMessages, renameSession } from '@anthropic-ai/claude-agent-sdk';
import * as archive from './archive.js';
import { ArtifactStore, MAX_BYTES as ARTIFACT_MAX_BYTES, kindOfExt, revKind } from './artifacts.js';
// A download's file name from an artifact's title and extension (2026-10-13; shared with the window, pure).
import { fileNameFor } from '../ui/viewkind.js';
import { createApakiTools } from './apaki-tools.js';
import { createBrowserTools } from './browser-tools.js';
import { createShell } from './shell-channel.js';
import {
  DEFAULT_APP_ID, HostServer, codeStamp, connectHost, createLifecycle, engineStamp, hostFile, latchDir, noteSdkMessage, paneTurnBusy, paneWorking,
  patchWorkspaceLeaves, restoreAsAttach, taskReplay, trackHiddenPanes,
} from './host.js';
import { startOpenServer } from './open-server.js';
// A pane's queued messages, held here so they go out with no window connected (queue-hold.js has the ownership rule).
import { dropHeld, heldView, resetHeld, setHeld, takeForAutoSend } from './queue-hold.js';
// "Auto-compact at" (Settings) and the other few settings the engine keeps (prefs.js).
import { COMPACT_CHOICES, COMPACT_DEFAULT, RELEASE_CHOICES, RELEASE_DEFAULT, compactSettings, loadPrefs, normalizeCompact, normalizeRelease, prefsFile, savePrefs } from './prefs.js';
// Ultracode and the other settings beside effort: the pane's tune, as Claude Code's flag settings (tune.js, 2026-10-13).
import { claudeChange, claudeTune, liveSettings, startSettings } from './tune.js';
import { MODEL_FILE, downloadModel } from './voice-model.js';
// The context meter before a conversation runs: its last call's usage, from the transcript (2026-10-10 night).
import { estimateEvent, lastUsage } from './context-estimate.js';
// The session list's times: the last message, not the file's modified time (2026-10-11).
import { LastActive } from './last-active.js';
// The session list's Details, Pin to top, Export as Markdown and Open in a terminal (2026-10-12).
import * as pins from './pins.js';
import { createCodexList } from './codex-list.js';
import { SESSION_ID_RE, codexMarkdown, diskSize, exportName, findRollout, freePath, historyMarkdown, scanClaude, scanCodex } from './session-info.js';
// Every conversation kept past Claude Code's 30-day cleanup, listed, opened and restored from D: (2026-10-12).
import { archiveRoot, archiveTranscripts, archivedMeta, archivedSessions, openArchived, restoreArchived } from './transcript-archive.js';
// What a phone shows of the desktop's tabs (2026-10-11).
import { desktopTabs } from './desktop-tabs.js';
import { glassView, glassProviderSettings } from './glass.js';
import { KIMI_LOGIN_HINT, providerVisible } from '../ui/glass-providers.js';
import { CLAUDE_DIR, chooseCredential, childEnv, glassCredential, keySections } from '../../src/auth.js';
// Signing in on a fresh install (2026-10-10, see "signing in to Claude" below).
import { liveLogin } from '../../src/auth.js';
import { claudeBinary } from '../../src/launch.js';
// Where Windows, macOS and Linux differ (macOS port, 2026-10-12): voice folder, Glass, reveal, open, sign-in.
import { bundledVoiceDir, glassCli, openCommand, openFolderCommand, openShimName, revealCommand, signInCommand, voiceDir, whisperName } from '../../src/platform.js';
import { codexItem, codexResumeHint, isCodexId } from '../../src/codex.js';
// Codex threads as panes, through one `codex app-server` process (2026-10-12).
import { findCodex } from './codex-client.js';
import { CODEX_SHARED, createCodex, isCodexPane } from './codex-panes.js';
import { findKimi, isKimiId, isKimiPane } from './kimi-client.js';
import { createKimiList } from './kimi-list.js';
import { createKimi } from './kimi-panes.js';
import { threadIdOf } from './codex-map.js';
import { searchHybrid, startIndexServer, updateIndex, updateViaServer } from '../../src/deepindex.js';
import { askSearch, digPrompt } from './asksearch.js';
import * as folders from '../../src/folders.js';
import { filterItems, terminalSessions, transcriptMap } from '../../src/picker.js';
import { bareItem, startLive } from './live.js';
import { agentByToolUse, countSubagents, listShells, listSubagents, readEntries, readText, RUNNING_MS, watchFile } from './tasks.js';
// A session's whole conversation, across compactions, read from its transcript (2026-10-10).
import { HistoryStore, PAGE as HISTORY_PAGE } from './history.js';
import { forwardToClients } from './sdk-forward.js';
import { SessionRunner } from '../../src/runner.js';
import { listSessions, lockInfo, lockStolen, readTail, releaseLock, rememberCreated, setLockApp, takeLock } from '../../src/sessions.js';
import { makeLoader } from '../../src/ui/picker.js';
import { noteRunnerUse, setOn as setWarm, statusText as warmStatus, summary as warmSummary, warmSessions } from '../../src/warm.js';
import { folderStats, listDir, makeDir } from '../../src/places.js';
import { APP_VERSION } from './app-version.js';
import { createRemote } from './remote.js';
// Real permission prompts: the canUseTool every pane gets (2026-10-12).
import { createPermissionGate } from './permissions.js';
import { hashText, parsePhoneId, windowOf } from './remote-policy.js';
// Git worktrees: repositories, branches and change counts, the diff, and the guarded git and gh actions (2026-10-12, worktrees.js).
// Since 2026-10-15 all of their git runs on a worker thread (worktrees-worker.js) behind WorktreeIndexClient: Windows
// creates a process on the thread that asks, and the refresh's git processes held this thread up (84% of a profile).
import { findRepo as wtFindRepo, samePath as wtSame, terminalCommand } from './worktrees.js';
import { WorktreeIndexClient } from './worktrees-client.js';
// The event loop's delay and the processes started, per minute, for host-ctl status and the log (2026-10-15).
import { createPerfMonitor } from './perf.js';
// What a paired phone may make Claude do (2026-10-10, apaki/SECURITY.md 4.4 item 4): enforced on every phone pane below.
import { CAP_PLAN_TEXT, capCanUseTool, capDefaultMode, capModeText, capModes, capPreToolUse, capRunnerOptions, capTuneText, clampMode } from './remote-policy.js';
// The console: a pane's conversation in its real terminal UI, and "Open in terminal" (2026-10-12, console.js).
import crypto from 'node:crypto';
import { DEFAULT_KEY_WORDS } from '../../src/auth.js';
import {
  applyEnv as consoleEnv, claudeCommand, codexCommand, createConsoleControl, createConsoles, ensureDir as consoleDirReady, readHeld, takeBackHeld,
  terminalLaunch, userHasRelayHook,
} from './console.js';

// Locks this engine takes name it, so a blocked terminal window can say who has the session.
setLockApp('apaki');

// stdout is the event channel: nothing else may print there.
console.log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

const DEFAULT_MODEL = process.env.APAKI_MODEL || 'claude-opus-5-5';
const DEFAULT_EFFORT = process.env.APAKI_EFFORT || 'xhigh';
const HISTORY_MESSAGES = 400;
const RESULT_CHARS = 4000;

/** Phone access (remote.js), created once the command handlers exist. */
let remote = null;

// The background host (host.js): events go to the connected window, not stdout.
const HOST_MODE = process.argv.includes('--host');
const HOST_APP_ID = String(process.env.APAKI_APP_ID || DEFAULT_APP_ID);
/** The host's server (host.js HostServer) and lifecycle, in host mode, once start-up is done. */
let host = null;
let lifecycle = null;
// The last of these, for a window that connects later (they are only sent when they change).
const HOST_CACHED = new Set(['index', 'meaning', 'warm', 'worktrees']);
const hostCache = new Map();

if (HOST_MODE) {
  // One host per app id: if one already answers (a window that gave up waiting
  // for a slow start and started another), this one leaves it in charge.
  const other = await connectHost({ file: hostFile(HOST_APP_ID), role: 'control', timeoutMs: 3000 }).catch(() => null);
  if (other && other.ok?.pid !== process.pid) {
    process.stderr.write(`apaki host: another host (pid ${other.ok?.pid}) already serves ${HOST_APP_ID}; this one exits\n`);
    other.close();
    process.exit(0);
  }
}

function emit(ev) {
  // Events for a phone's panes and requests go to that phone only.
  if (remote && remote.route(ev)) return;
  if (HOST_MODE) {
    if (ev && HOST_CACHED.has(ev.ev)) hostCache.set(ev.ev, ev);
    host?.send(ev);
    return;
  }
  process.stdout.write(`${JSON.stringify(ev)}\n`);
}

// Requests to the Apaki shell (the built-in browser), answered on stdin.
const shell = createShell({ emit });
// A host's shell is the window, which comes and goes; what it can do is known up front (main.rs).
if (HOST_MODE) shell.expect(String(process.env.APAKI_SHELL_FEATURES || '').split(',').map((s) => s.trim()).filter(Boolean));

// Session list shared by every pane.
const state = {
  // askId -> { resolve, paneId, toolName, input, at }; a permission prompt (permissions.js) also has kind 'permission', permission and answer
  asks: new Map(),
  items: null,
  byId: new Map(),
  commandsByCwd: new Map(),
  warm: new Set(), // sessions keep-warm is looking after (src/warm.js warmSessions)
  renames: new Map(), // sessionId -> title, written once that session's turn in a pane ends
};

// New panes start from these; the window can pass its own per pane.
// tune (2026-10-13): Ultracode and its workflow size, which the desktop's last pick carries to new desktop panes like its effort.
const defaults = { credential: glassCredential(), model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, mode: 'bypassPermissions', tune: claudeTune(null) };

/** paneId -> { id, runner, sessionId, credential, model, effort, mode, tune, tools, held (queued messages), heldSent, userStopped } */
const panes = new Map();

// Apaki's own settings (prefs.js). autoCompact reaches every Claude Code process started from now on (runner.flagSettings below).
const PREFS_FILE = prefsFile();
let prefs = loadPrefs(PREFS_FILE);

/* ---------- artifacts and "open this" (apaki-tools.js) ---------- */

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The BROWSER shim: apaki-open.cmd on Windows, the shell script apaki-open on macOS and Linux (platform.js openShimName).
const OPEN_SHIM = path.join(ENGINE_ROOT, 'apaki', 'bin', openShimName());
const store = new ArtifactStore();

/** A served address for one revision of an artifact, for the window's viewer. */
const srcOf = (rec, rev) => (openServer ? openServer.artifactUrl(rec, rev) : null);
/** A record's revisions as the window gets them: number, time, title, extension, and (2026-10-13) kind and who made it. */
const revsOut = (rec) => rec.revs.map((r) => ({ rev: r.rev, at: r.at, title: r.title, ext: r.ext, kind: revKind(rec, r), by: r.by || 'session' }));

function artifactEvent(p, rec, meta = {}) {
  return {
    // A Codex pane's id is codex:<thread>; the store keeps it as codex-<thread>, and the window asks for it by the pane's own id (artifactGet).
    ev: 'artifact', paneId: p.id, sessionId: isCodexPane(p) && p.sessionId ? p.sessionId : rec.sessionId, id: rec.id, title: rec.title, kind: rec.kind, rev: rec.rev,
    path: store.fileOf(rec).file, src: srcOf(rec), ext: rec.ext, mime: rec.mime, size: rec.size, source: rec.source,
    revs: revsOut(rec), via: meta.via || 'show', toolUseId: meta.toolUseId || null,
    // 2026-10-13 (viewers like ChatGPT's side window): the language hint, and who made this revision ('user': an edit in the viewer).
    lang: rec.lang || null, by: rec.revs[rec.revs.length - 1]?.by || 'session',
    // A turn's changes or a picture Codex looked at (2026-10-12): a card with a line under the title; the viewer opens when asked.
    ...(meta.sub ? { sub: meta.sub } : {}), ...(meta.open ? { open: true } : {}),
  };
}

/** The tools one pane's Claude Code gets (made once per pane, shared by its restarts). */
function toolsFor(p) {
  if (!p.tools) {
    // The browser tools only where the shell has a browser (not in tests or latch).
    // expects: a background host's window may be closed right now and come back later.
    const browser = shell.expects('browser')
      ? createBrowserTools({ shell, owner: () => p.id, onActivity: (a) => emit({ ev: 'browserActivity', paneId: p.id, ...a }) })
      : null;
    p.tools = createApakiTools({
      store,
      sessionId: () => p.runner?.sessionId || p.sessionId || null,
      cwd: () => p.runner?.cwd || p.codex?.cwd || os.homedir(),
      onArtifact: (rec, meta) => emit(artifactEvent(p, rec, meta)),
      onOpenUrl: (o) => { openPage(p, o); },
      browser,
    });
  }
  return p.tools;
}

/**
 * A web page for a pane's user (show with kind url, a caught "start
 * https://...", BROWSER): into the pane's built-in browser when the shell has
 * one, and in any case an openUrl event so the conversation gets its card.
 */
async function openPage(p, o) {
  const base = { ev: 'openUrl', paneId: p.id, sessionId: p.runner?.sessionId || p.sessionId || null, url: o.url, title: o.title || null, reason: o.reason || 'show', toolUseId: o.toolUseId || null };
  if (shell.has('browser') && /^https?:\/\//i.test(o.url)) {
    try {
      // One browser pane per conversation with tabs inside it (2026-10-12): a tab already showing this address is opened
      // again by id (a reload; the window reveals it), anything else is a new tab of the pane. Without browser tools
      // there is no tab list, so it stays the old "reuse the owner's browser".
      const bt = (() => { try { return toolsFor(p).browser; } catch { return null; } })();
      let same = null;
      if (bt) {
        try { same = (await bt.tabs()).find((t) => sameAddress(t.url, o.url)) || null; } catch { /* no list: a new tab */ }
      }
      const args = same ? { owner: p.id, id: same.id, url: o.url, reason: o.reason || 'show' } : { owner: p.id, url: o.url, hint: bt ? 'tab' : 'reuse', reason: o.reason || 'show' };
      const st = await shell.request('browser.open', args, { timeout: 8000 });
      bt?.adopt(st.id);
      emit({ ...base, browserId: st.id });
      return;
    } catch (e) {
      process.stderr.write(`apaki: the built-in browser did not open ${o.url}: ${e.message}\n`);
    }
  }
  emit(base);
}

/** The same page address, ignoring the #fragment and one trailing slash (openPage reuses a tab already showing it). */
function sameAddress(a, b) {
  const norm = (u) => String(u || '').replace(/#.*$/, '').replace(/\/$/, '');
  return Boolean(a) && Boolean(b) && norm(a) === norm(b);
}

/** BROWSER and friends for a pane's Claude Code, so tools that open a browser open in Apaki. */
function browserEnv(p) {
  if (!openServer || !fs.existsSync(OPEN_SHIM)) return {};
  return { BROWSER: OPEN_SHIM, APAKI_OPEN_URL: openServer.openUrl, APAKI_OPEN_TOKEN: openServer.paneToken(p.id), APAKI_NODE: process.execPath };
}

/** A URL a pane's BROWSER shim handed over: local files become artifacts, pages go to the window. */
function openedByBrowser(paneId, url) {
  // The shared Codex app-server has one token for every thread: the pane whose turn is running gets the link.
  if (paneId === CODEX_SHARED) {
    if (/^file:\/\//i.test(url)) codex.runTool('show', { kind: 'file', path: url }, {}).catch(() => {});
    else codex.openedLink(url);
    return;
  }
  const p = panes.get(paneId);
  if (!p) return;
  if (/^file:\/\//i.test(url)) { toolsFor(p).show({ kind: 'file', path: url }, { via: 'BROWSER' }).catch(() => {}); return; }
  openPage(p, { url, title: null, reason: 'BROWSER', toolUseId: null });
}

/** An artifact the stdio tool server (apaki-mcp-stdio.mjs) stored for a pane: show it like an in-process one. */
function shownByStdio(paneId, { id, sessionId }) {
  const p = paneId === CODEX_SHARED ? codex.pickPane() : panes.get(paneId);
  const rec = p ? store.record(id, sessionId) : null;
  if (rec) emit(artifactEvent(p, rec, { via: 'show' }));
}

/**
 * One of Apaki's tools (show, browser_open...) called by the stdio tool server a Codex process runs (apaki-mcp-stdio.mjs,
 * POST /tool): run for the pane the token belongs to, or for the Codex pane whose turn is running.
 */
async function toolFromStdio(paneId, tool, input, meta) {
  if (paneId === CODEX_SHARED) return codex.runTool(tool, input, meta);
  const p = panes.get(paneId);
  if (!p) return { ok: false, text: 'That conversation is not open in Apaki.' };
  const t = toolsFor(p);
  if (tool === 'show') return t.show(input, { via: 'show' });
  if (tool === 'view_read') return t.viewRead(input);
  return t.browser ? t.browser.call(tool, input) : { ok: false, text: 'This window has no built-in browser.' };
}

let openServer = null;
try { openServer = await startOpenServer({ store, onOpen: openedByBrowser, onShown: shownByStdio, onTool: toolFromStdio }); } catch (e) { process.stderr.write(`apaki: the localhost server did not start (${e.message}); artifacts show without the viewer\n`); }

/*
 * Codex panes (codex-panes.js). The app-server process gets Apaki's tool server and the BROWSER shim through its own
 * command line only (-c overrides, no config file written); one token stands for every Codex thread.
 */
const MCP_SCRIPT = path.join(ENGINE_ROOT, 'apaki', 'engine', 'apaki-mcp-stdio.mjs');
const codex = createCodex({
  emit, asks: state.asks, panes, tools: (p) => toolsFor(p), openPage: (p, o) => { openPage(p, o); },
  shared: () => (openServer && fs.existsSync(MCP_SCRIPT)
    ? { node: process.execPath, mcpScript: MCP_SCRIPT, openUrl: openServer.openUrl, token: openServer.paneToken(CODEX_SHARED), shim: fs.existsSync(OPEN_SHIM) ? OPEN_SHIM : null }
    : null),
  shapeRows: (rows) => { const folderOf = folders.folderOfSessions(); return rows.map((r) => compact(r, null, folderOf)); },
  phoneCap: (paneId) => (parsePhoneId(paneId) ? phoneCap(paneId) : null),
  activity: (p, msg) => paneActivity(p, { q: null }, msg),
  // A turn ended on its own: the saved workspace learns it, and with no window connected the engine sends what was queued.
  turnEnded: (p) => { markAway(p, { busy: false, s: p.sessionId || null, away: { at: new Date().toISOString(), sessionId: p.sessionId || null } }); turnEnded(p); },
  attachDir: () => path.join(latchDir(), 'codex-attachments'),
  log: (line) => process.stderr.write(`apaki: ${line}\n`),
});
// Whether Codex is installed here, so the window offers it; looked up once, without starting anything.
const CODEX_FOUND = Boolean(findCodex());
const KIMI_FOUND = Boolean(findKimi());
const kimiList = createKimiList({ enabled: !process.env.APAKI_NO_KIMI_LIST && (!process.env.LATCH_NO_INDEX || Boolean(process.env.KIMI_CODE_HOME)) });
const kimi = createKimi({
  emit, asks: state.asks, panes, list: kimiList,
  onSession: (p) => { rememberCreated(p.sessionId); markAway(p, { s: p.sessionId }); },
  onRowsChange: () => { if (state.items && listening()) emitSessions(null); },
  activity: (p, msg) => paneActivity(p, { q: null }, msg),
  turnEnded: (p) => { markAway(p, { busy: false, s: p.sessionId || null, away: { at: new Date().toISOString(), sessionId: p.sessionId || null } }); turnEnded(p); },
});

/*
 * Codex threads in the main session list from the start (2026-10-12, codex-list.js; Arthur: Codex sessions integrated
 * exactly like Claude's). Read from the rollout files, read only, without starting the app-server; what was read is kept
 * in latch/codex-list.json so a restart reads only new or changed rollouts. A background pass that changed the rows
 * sends the list again (at most every 2 s, from what is loaded: the Claude list is not read again for it).
 */
let codexListTimer = null;
// Off with APAKI_NO_CODEX_LIST, and with LATCH_NO_INDEX (the switch the engine tests use for "no background reading of
// this PC's conversations": they run with the real home folder).
const codexList = CODEX_FOUND && !process.env.APAKI_NO_CODEX_LIST && !process.env.LATCH_NO_INDEX
  ? createCodexList({
    cacheFile: path.join(latchDir(), 'codex-list.json'),
    // The first pass waits until the engine has started and sent its first list (the kept rows are in that list).
    firstDelayMs: 3000,
    log: (line) => process.stderr.write(`apaki: ${line}\n`),
    onChange: () => {
      if (codexListTimer) return;
      codexListTimer = setTimeout(() => { codexListTimer = null; if (state.items) emitSessions(null); }, 2000);
      codexListTimer.unref?.();
    },
  })
  : null;
/** The Codex rows of the list now: the Codex view's (app-server) rows over the rollouts' (no I/O). */
const codexRowsNow = () => (codexList ? codexList.rows(codex.cachedRows()) : codex.cachedRows());

/** Opens a web page, or a stored artifact's file, outside Apaki (the system browser or default app). */
function openOutside(target) {
  const { cmd, args } = openCommand(process.platform, target);
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function getPane(paneId) {
  const id = String(paneId || 'main');
  let p = panes.get(id);
  if (!p) {
    p = { id, runner: null, sessionId: null, credential: defaults.credential, model: defaults.model, effort: defaults.effort, mode: defaults.mode, tune: claudeTune(defaults.tune) };
    // A phone pane never starts in the desktop's default mode (it starts as bypassPermissions): it starts in the mode its phone's access allows.
    // Nor does it start with the desktop's Ultracode: a phone turns it on for itself (it spends a lot, and only a Full phone may).
    if (parsePhoneId(id)) { p.mode = capDefaultMode(phoneCap(id)); p.tune = claudeTune(null); }
    panes.set(id, p);
  }
  return p;
}

/* ---------- Ultracode and the other settings beside effort (tune.js, 2026-10-13) ---------- */

/** A pane that belongs to a phone below Full access: it gets no workflows at all (tune.js startSettings says why). */
function tuneRestricted(p) {
  return Boolean(parsePhoneId(p.id)) && phoneCap(p.id) !== 'full';
}

/** The pane's tune as its window or phone sees it; `available: false` once Claude Code said it cannot run Ultracode here. */
function tuneView(p) {
  return p.tuneAvailable === false && p.tune?.ultracode ? { ...p.tune, available: false } : p.tune;
}

/** ev settings: a pane's model, effort, mode and tune (Claude: ultracode, size; Codex: summary, speed). */
function paneSettings(p) {
  return { ev: 'settings', paneId: p.id, model: p.model, effort: p.effort, mode: p.mode, tune: tuneView(p) };
}

/**
 * After a change to a running Claude Code: asks what it will really apply (the SDK's get_settings) and says so when
 * Ultracode is on but cannot run (a model that does not support it, Workflows off for this account). A later model that can
 * run it brings it back by itself (measured: ultracodeRequested stays true), so the pane's wish is kept.
 */
async function tuneCheck(p) {
  if (isCodexPane(p) || !p.runner?.running) return;
  // Off: nothing to be unavailable (a stale "cannot run it" flag from before it was switched off goes).
  if (!p.tune?.ultracode) { if (p.tuneAvailable === false) { p.tuneAvailable = true; emit(paneSettings(p)); } return; }
  const a = await p.runner.appliedSettings();
  if (!a) return;
  const ok = !(a.ultracodeRequested && a.ultracodeAvailable === false);
  if (ok === (p.tuneAvailable !== false)) return;
  p.tuneAvailable = ok;
  emit(paneSettings(p));
  if (!ok) emit({ ev: 'note', paneId: p.id, tone: 'warn', text: `Ultracode is on for this conversation but ${p.model || 'this model'} cannot run it here (the model does not support it, or workflows are off for this account), so it waits. A model that can run it picks it up again.` });
}

/* ---------- session list ---------- */

function compact(it, term, folderOf) {
  return {
    id: it.id, title: it.title, firstPrompt: it.firstPrompt || '', cwd: it.cwd || '', branch: it.branch || '',
    lastModified: it.lastModified || 0, size: it.size || 0, codex: Boolean(it.codex), ...(it.kimi ? { kimi: true, kind: 'kimi', kimiArchived: Boolean(it.kimiArchived), ...(it.kimiRole ? { kimiRole: it.kimiRole } : {}) } : {}),
    terminal: term ? { name: term.name, status: term.status, pid: term.pid } : null,
    folder: folderOf.get(it.id)?.id || null,
    // Started headless and never typed in (claude -p, workers, relayed-only windows); shown, and marked.
    headless: Boolean(it.headless), bare: Boolean(it.bare), warm: state.warm.has(it.id),
    subagents: subagentCount(it.id),
    // Archived in Apaki's list (archive.js): hidden from All, In terminals and folders, shown under Archived.
    archived: archive.archived().has(it.id) || Boolean(it.codexArchived) || Boolean(it.kimiArchived),
    // A Codex thread whose rollout sits in ~/.codex/archived_sessions: archived in Codex, so Apaki lists it under Archived too.
    ...(it.codexArchived ? { codexArchived: true } : {}),
    // Claude Code deleted its transcript; Apaki's transcript archive kept a copy (transcript-archive.js, 2026-10-12).
    ...(it.archivedCopy ? { archivedCopy: true, restorable: true } : {}),
    // A turn is running in this engine (a pane here, a phone's pane, or one kept running in the background).
    running: [...panes.values()].some((p) => p.sessionId === it.id && (p.runner?.turnRunning || p.runner?.turnActive || ((isCodexPane(p) || isKimiPane(p)) && p.busy))),
    // Pinned to the top of the list (pins.js), and the model of its last reply when its tail says (last-active.js), 2026-10-12.
    ...(pins.pinned().has(it.id) ? { pinned: true } : {}),
    ...(it.model ? { model: it.model } : {}),
  };
}

/**
 * How many subagents a session has had (tasks.js; files under <session>/subagents).
 *
 * Kept per session (2026-10-15): every row of every list sent asked the disk (two folder reads per session), 220 ms of
 * this thread for 359 sessions on Arthur's PC, again on every list refresh (at most every 10 s while panes work). A
 * session's count is read again when live.js reports its subagents changed (onSubagents below drops it), and at the
 * latest after SUBAGENT_COUNT_MS, spread out so they do not all expire in the same refresh.
 */
const subagentCounts = new Map(); // sessionId -> { n, file, until }
const SUBAGENT_COUNT_MS = 10 * 60 * 1000;
function subagentCount(id) {
  const file = state.files?.get(id);
  if (!file) return 0;
  const hit = subagentCounts.get(id);
  if (hit && hit.file === file && Date.now() < hit.until) return hit.n;
  let n = 0;
  try { n = countSubagents(file); } catch { n = 0; }
  subagentCounts.set(id, { n, file, until: Date.now() + SUBAGENT_COUNT_MS * (0.5 + Math.random()) });
  return n;
}

/**
 * Every Claude Code session on this PC (Arthur, 2026-10-09: "we CANNOT miss
 * anything"). The SDK's default list leaves out sessions that started
 * headless; latch's picker adds back the ones with typed turns, but a window
 * that had relay on from its first message sends every turn through
 * claude -p, so its session looked like automation and was hidden. Now the
 * headless ones are listed too, marked headless, and so is any transcript the
 * SDK's list skips (no prompt yet).
 */
// When each conversation was last really used (last-active.js); cached per transcript version.
const lastActive = new LastActive();

async function loadSessions() {
  const memo = new Map();
  const loadInfos = (programmatic) => {
    if (!memo.has(programmatic)) memo.set(programmatic, listSessions({ limit: 5000, includeProgrammatic: programmatic }));
    return memo.get(programmatic);
  };
  // The transcripts folder is read once per list (2026-10-15): it was read four times, about 22 ms each on Arthur's PC.
  const filesNow = transcriptMap();
  const loader = makeLoader({ loadInfos, files: filesNow });
  const items = await loader(false);
  const shown = new Set(items.map((it) => it.id));
  const term = terminalSessions();
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const it of await loader(true)) if (!byId.has(it.id)) byId.set(it.id, shown.has(it.id) ? it : { ...it, headless: true });
  for (const [id, file] of filesNow) {
    if (byId.has(id)) continue;
    const it = bareItem(id, file);
    if (it) byId.set(id, it);
  }
  // Conversations Claude Code deleted after 30 days but Apaki's archive kept (2026-10-12): listed, marked.
  try {
    const live = filesNow;
    for (const id of archivedNow().keys()) {
      if (byId.has(id) || live.has(id)) continue;
      const meta = archivedMeta(id);
      if (!meta) continue;
      byId.set(id, { id, title: meta.title || (meta.firstPrompt ? meta.firstPrompt.slice(0, 80) : 'Archived conversation'), cwd: meta.cwd || '', lastModified: meta.lastActive || 0, firstPrompt: meta.firstPrompt || '', archivedCopy: true });
      // The no-index search fallback (filterItems) reads hay and titleLower; archived rows lacked them and crashed search (2026-10-24).
      { const row = byId.get(id); row.titleLower = String(row.title || '').toLowerCase(); row.hay = [id, row.title, row.firstPrompt, row.cwd].join(' ').toLowerCase(); }
    }
  } catch (e) { process.stderr.write(`archived sessions: ${e.message || e}\n`); }
  state.byId = byId;
  // Times and order follow the last real message, not the file's modified time (last-active.js, 2026-10-11).
  const files = transcriptMap();
  await lastActive.apply(byId.values(), files).catch((e) => process.stderr.write(`last active: ${e.message || e}\n`));
  state.items = [...byId.values()].sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  state.files = files;
  return term;
}

async function sessions(reqId) {
  const term = await loadSessions();
  await kimiList.refresh();
  emitSessions(reqId, term);
  // Codex threads: a background pass over the rollouts (codex-list.js), at most every 30 s; a change sends the list again.
  codexList?.refresh();
}

/** Sends the session list as last loaded (term: the terminal sessions), with the Codex rows as they are now. */
function emitSessions(reqId, term = terminalSessions()) {
  const folderOf = folders.folderOfSessions();
  const list = state.items.map((it) => compact(it, term.get(it.id)?.[0], folderOf));
  // Open in a terminal right now, even before Claude Code wrote a transcript.
  for (const [id, recs] of term) {
    if (!state.byId.has(id)) list.push(compact({ id, title: `New session (${recs[0].name || 'terminal'})`, cwd: recs[0].cwd, lastModified: recs[0].updatedAt }, recs[0], folderOf));
  }
  // The Codex threads, from the start (2026-10-12, codex-list.js: the rollouts, read only, with the Codex view's rows over
  // them): listed with the rest, marked codex.
  for (const row of codexRowsNow()) list.push(compact(row, null, folderOf));
  for (const row of kimiList.rows()) list.push(compact(row, null, folderOf));
  emit({ ev: 'sessions', reqId, items: list, folders: folders.listFolders(), billing: billingInfo(), voice: voiceReady() });
}

async function search(reqId, query) {
  if (!state.items) await loadSessions();
  const folderOf = folders.folderOfSessions();
  const term = terminalSessions();
  const t0 = Date.now();
  const kimiHits = (await kimiList.search(query)).map((h) => ({ ...h, item: compact(h.item, null, folderOf) }));
  const res = await searchHybrid(query, { limit: 80 });
  if (!res) {
    // No index: the titles and folders of the Claude sessions and of the Codex threads the Codex view has read (2026-10-12).
    const quick = filterItems([...state.items, ...codexSearchRows()], query).map((it) => ({ item: compact(it, term.get(it.id)?.[0], folderOf), kind: null, snippet: '' }));
    emit({ ev: 'search', reqId, query, elapsed: Date.now() - t0, deep: false, results: [...quick, ...kimiHits] });
    return;
  }
  const results = [...kimiHits];
  for (const hit of res.sessions) {
    let it = state.byId.get(hit.session);
    if (!it && isCodexId(hit.session)) it = await codexHitItem(hit);
    if (!it) it = { id: hit.session, title: '(session hidden from the list)', cwd: '', lastModified: Date.parse(hit.latest || '') || 0 };
    results.push({ item: compact(it, term.get(it.id)?.[0], folderOf), kind: hit.kind, snippet: hit.snippet, hits: hit.hits, sources: hit.sources || ['words'] });
  }
  emit({ ev: 'search', reqId, query, elapsed: res.elapsed_ms, total: res.total_hits + kimiHits.length, deep: true, semantic: Boolean(res.semantic), terms: res.terms || null, results });
}

/*
 * Codex threads in search results (2026-10-12, parity audit; CODEX.md): a hit used to become codexItem's row, titled
 * "Codex: <first prompt>" with the rollout file's time, so the same thread read differently in the Codex view (its
 * name, its last message) and in search. A thread the Codex view has listed now shows as that row; any other one gets
 * its first prompt as the title and its last message time from the rollout (last-active.js).
 */
function codexRowsById() { return new Map(codexRowsNow().map((r) => [r.id, r])); }

/** The Codex view's rows, with the fields the quick filter (src/picker.js filterItems) matches on. */
function codexSearchRows() {
  return codexRowsNow().map((r) => ({ ...r, titleLower: String(r.title || '').toLowerCase(), hay: [r.id, r.title, r.firstPrompt, r.cwd].join(' ').toLowerCase() }));
}

/** A search hit on a Codex thread as a list row. */
async function codexHitItem(hit) {
  const row = codexRowsById().get(hit.session);
  if (row) return row;
  const it = codexItem(hit);
  it.title = it.title.replace(/^Codex: /, '');
  const at = hit.file ? await lastActive.lastActive(hit.file).catch(() => null) : null;
  if (at) it.lastModified = at;
  return it;
}

/** A list item for a session the list does not show (hidden headless, Codex). */
function itemFor(id, hit) {
  if (isKimiId(id) && kimiList.get(id)) return kimiList.get(id);
  if (state.byId.get(id)) return state.byId.get(id);
  if (isCodexId(id)) { const row = codexRowsById().get(id); if (row) return row; }
  if (isCodexId(id) && hit) return { ...codexItem(hit), title: codexItem(hit).title.replace(/^Codex: /, '') };
  return { id, title: '(session hidden from the list)', cwd: '', lastModified: Date.parse(hit?.latest || '') || 0 };
}

/**
 * Ask Claude (asksearch.js): billed to the focused pane's account, or to what
 * Glass has live when no pane is focused or the pane follows Glass.
 */
async function askSearchOp(reqId, query, paneId) {
  if (!state.items) await loadSessions();
  const p = paneId ? panes.get(String(paneId)) : null;
  const credential = !p || p.credential.follow ? glassCredential() : p.credential;
  const r = await askSearch({
    query,
    credential,
    items: state.byId,
    makeItem: itemFor,
    progress: (text) => emit({ ev: 'askProgress', reqId, query, text }),
  });
  if (r.error) { emit({ ev: 'askSearch', reqId, query, error: r.error }); return; }
  const folderOf = folders.folderOfSessions();
  const term = terminalSessions();
  const results = r.results.map(({ id, why, hit }) => ({ item: compact(itemFor(id, hit), term.get(id)?.[0], folderOf), why, kind: hit?.kind || null, snippet: hit?.snippet || '' }));
  emit({ ev: 'askSearch', reqId, query, results, terms: r.terms, considered: r.considered, model: r.model, billing: credential.name, cost: r.cost, ms: r.ms, note: r.note });
}

function digPromptOp(reqId, query, candidateIds = []) {
  const candidates = candidateIds.map((id) => state.byId.get(id)).filter(Boolean).map((it) => ({ id: it.id, title: it.title, cwd: it.cwd }));
  emit({ ev: 'digReady', reqId, query, prompt: digPrompt(query, candidates) });
}

/* ---------- one session's details (the list's Details sheet, Export, Open in a terminal; session-info.js) ---------- */

/** The list record of a session (Claude Code, a Codex thread the Codex view read, or a terminal's new session), or null. */
function listItemOf(id) {
  return state.byId?.get(id) || codexRowsNow().find((r) => r.id === id) || null;
}

/**
 * Everything known about one session (op sessionInfo, read only): its list record, what its transcript or rollout says
 * (session-info.js), its size on disk, and what this engine knows live (panes holding it, their model, effort, mode and
 * billing, a terminal window, folder, archive and pin). Fields that cannot be known are left out, never guessed.
 */
async function sessionInfoOf(id) {
  if (!state.items) await loadSessions().catch(() => {});
  const codexId = isCodexId(id);
  const item = listItemOf(id) || {};
  const info = {
    id, provider: codexId ? 'codex' : 'claude', title: item.title || '', firstPrompt: item.firstPrompt || '', cwd: item.cwd || '', branch: item.branch || '',
    lastActive: item.lastModified || 0, fileModified: item.fileModified || 0, size: item.size || 0, headless: Boolean(item.headless),
    archived: archive.archived().has(id) || Boolean(item.codexArchived), codexArchived: Boolean(item.codexArchived), archivedCopy: false,
    pinned: pins.pinned().has(id), folder: null, terminal: [], panes: [], subagents: 0, shells: 0, shellsRunning: 0,
  };
  const f = folders.folderOfSessions().get(id);
  if (f) info.folder = { id: f.id, name: f.name };
  info.terminal = (terminalSessions().get(id) || []).map((t) => ({ name: t.name || '', status: t.status || '', pid: t.pid || null }));
  for (const p of panes.values()) {
    if (p.sessionId !== id) continue;
    const running = Boolean(p.runner?.turnRunning || p.runner?.turnActive || ((isCodexPane(p) || isKimiPane(p)) && p.busy));
    info.panes.push({ where: parsePhoneId(p.id) ? 'phone' : 'desktop', model: p.model || '', effort: p.effort || '', mode: p.mode || '', billing: p.credential?.name || '', running });
  }
  if (codexId) {
    const found = findRollout(id);
    if (found) {
      info.transcript = found.file;
      info.codexArchived = info.codexArchived || found.archived;
      info.archived = info.archived || found.archived;
      info.size = diskSize(found.file, null).size;
      Object.assign(info, pickScan(await scanCodex(found.file).catch(() => null)));
    }
    return info;
  }
  const live = transcriptMap().get(id);
  const file = live || (archivedOnly(id) ? openArchived(id, { cache: ARCHIVE_OPEN_DIR }) : null);
  if (!file) return info;
  info.transcript = live || '';
  info.archivedCopy = !live;
  if (live) {
    const d = diskSize(live, id);
    Object.assign(info, { size: d.size, sideSize: d.side, totalSize: d.total });
    try {
      info.subagents = countSubagents(live);
      const shells = listShells(live);
      info.shells = shells.length;
      info.shellsRunning = shells.filter((s) => s.running).length;
    } catch { /* its side folder is being written */ }
  }
  Object.assign(info, pickScan(await scanClaude(file).catch(() => null)));
  return info;
}

/** The fields of a scan that Details shows (the list record keeps its own title, folder and time when the scan has none). */
function pickScan(s) {
  if (!s) return {};
  const out = {
    created: s.created || 0, prompts: s.prompts, replies: s.replies, toolCalls: s.toolCalls, compactions: s.compactions,
    model: s.model || '', models: s.models || [], version: s.version || '', tokens: s.tokens,
  };
  if (s.lastActive) out.lastActive = s.lastActive;
  if (s.cwd) out.lastCwd = s.cwd;
  if (s.gitBranch) out.gitBranch = s.gitBranch;
  if (s.effort) out.effort = s.effort;
  if (s.customTitle) out.customTitle = s.customTitle;
  if (s.summary) out.summary = s.summary;
  if (s.firstPrompt) out.firstPromptFull = s.firstPrompt;
  if (s.originator) out.originator = s.originator;
  if (s.approval) out.approval = s.approval;
  if (s.sandbox) out.sandbox = s.sandbox;
  return out;
}

/** A session as Markdown (op exportSession): Claude Code's from its built history, a Codex thread's from its rollout. */
async function sessionMarkdown(id) {
  const item = listItemOf(id) || {};
  const meta = { id, title: item.title || '', cwd: item.cwd || '', branch: item.branch || '', lastActive: item.lastModified || 0, model: item.model || '' };
  if (isCodexId(id)) {
    const found = findRollout(id);
    if (!found) return null;
    return codexMarkdown(await fs.promises.readFile(found.file, 'utf8'), meta);
  }
  const h = await historyStore.history(id);
  if (!h || !h.items.length) return null;
  const first = h.items.find((x) => x.at);
  return historyMarkdown(h.items, { ...meta, created: first ? Date.parse(first.at) || 0 : 0 });
}

/** Where a desktop export goes: Downloads, else the home folder. */
function exportDir() {
  const dl = path.join(os.homedir(), 'Downloads');
  try { if (fs.statSync(dl).isDirectory()) return dl; } catch { /* no Downloads folder */ }
  return os.homedir();
}

/**
 * A file name an artifact download may use (op artifactSave): no folders, no characters Windows refuses, not a
 * reserved device name (CON, NUL, COM1...), at most 120 characters, always with an extension.
 */
function saveName(name) {
  let n = String(name || '').split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').trim();
  if (!n) n = 'artifact.txt';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `artifact ${n}`;
  if (n.length > 120) { const ext = path.extname(n).slice(0, 12); n = `${n.slice(0, 120 - ext.length)}${ext}`; }
  return path.extname(n) ? n : `${n}.txt`;
}

/** Shows a file selected in Explorer (or Finder, or its folder on Linux). */
function revealFile(file) {
  const { cmd, args } = revealCommand(process.platform, file);
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref(); } catch { /* nothing to show it with */ }
}

/* ---------- history ---------- */

function cut(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more characters)` : t;
}

/** The saved conversation, trimmed for display: tool output cut, images kept as markers. */
/**
 * When each message was written, by uuid, from the transcript itself (the
 * SDK's messages carry no time). Reads the end of the file, more of it until
 * every wanted uuid is found or the whole file is read.
 */
function timestampsOf(sessionId, uuids) {
  const want = new Set(uuids.filter(Boolean));
  const out = new Map();
  const file = sessionId ? transcriptMap().get(sessionId) : null;
  if (!file || !want.size) return out;
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return out; }
  for (let bytes = 4 * 1024 * 1024; ; bytes *= 4) {
    const text = readTail(file, bytes);
    for (const m of text.matchAll(/"uuid":"([0-9a-f-]{36})","timestamp":"([^"]+)"|"timestamp":"([^"]+)"[^\n]*?"uuid":"([0-9a-f-]{36})"/g)) {
      const id = m[1] || m[4];
      const at = m[2] || m[3];
      if (want.has(id) && !out.has(id)) out.set(id, at);
    }
    if (out.size >= want.size || bytes >= size) break;
  }
  return out;
}

function compactMessages(msgs, sessionId = null) {
  const last = msgs.slice(-HISTORY_MESSAGES);
  const at = timestampsOf(sessionId, last.map((m) => m.uuid));
  return last.map((m) => {
    const content = m.message?.content;
    let c = content;
    if (Array.isArray(content)) {
      c = content.map((b) => {
        if (b.type === 'tool_result') {
          const text = Array.isArray(b.content) ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : String(b.content ?? '');
          return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: Boolean(b.is_error), content: cut(text, RESULT_CHARS) };
        }
        if (b.type === 'image') return { type: 'image_marker' };
        if (b.type === 'thinking' || b.type === 'redacted_thinking') return { type: 'thinking' };
        return b;
      });
    }
    return { type: m.type, uuid: m.uuid, at: at.get(m.uuid) || null, parent_tool_use_id: m.parent_tool_use_id || null, message: { role: m.message?.role, content: c, model: m.message?.model } };
  });
}

/**
 * The whole conversation, not just what follows the last compaction
 * (history.js; Arthur, 2026-10-10: "im not entirely sure if we;re really
 * pulling the FULL transcript of sessions"). Read from the transcript and
 * cached; the SDK's getSessionMessages (above) stays the fallback for a
 * session whose file cannot be read.
 */
// Where an archived conversation is decompressed to be read (transcript-archive.js openArchived).
const ARCHIVE_OPEN_DIR = path.join(latchDir(), 'archive-open');
const historyFileOf = (id) => {
  const known = state.files?.get(id);
  if (known && fs.existsSync(known)) return known;
  // Claude Code deleted it: read the archive copy instead (2026-10-12).
  return transcriptMap().get(id) || openArchived(id, { cache: ARCHIVE_OPEN_DIR }) || null;
};

/*
 * The transcript archive (2026-10-12): runs a minute after the engine starts and every 6 hours, copying only
 * what changed since the last run (the first full run, 8,783 files, took 7 minutes; later runs take seconds).
 * Its list of archived sessions is read at most once a minute for the session list.
 */
let archivedCache = { at: 0, map: new Map() };
function archivedNow() {
  if (Date.now() - archivedCache.at > 60 * 1000) {
    try { archivedCache = { at: Date.now(), map: archivedSessions() }; } catch { archivedCache = { at: Date.now(), map: new Map() }; }
  }
  return archivedCache.map;
}
/** True when a conversation exists only in the archive (its live transcript is gone). */
function archivedOnly(id) {
  return Boolean(id) && !transcriptMap().has(id) && archivedNow().has(id);
}
let archiveRunning = false;
async function runTranscriptArchive() {
  if (archiveRunning || process.env.APAKI_NO_ARCHIVE) return;
  archiveRunning = true;
  try {
    const r = await archiveTranscripts({ log: (line) => process.stderr.write(`${line}\n`) });
    if (r.copied || r.failed) process.stderr.write(`apaki archive: ${r.copied} copied, ${r.failed} failed, ${r.skipped} unchanged (${archiveRoot()})\n`);
    archivedCache.at = 0;
  } catch (e) {
    process.stderr.write(`apaki archive: ${e.message || e}\n`);
  } finally {
    archiveRunning = false;
  }
}
const historyStore = new HistoryStore({ fileOf: historyFileOf, log: (line) => process.stderr.write(`${line}\n`) });

/** Sends a pane its session's newest page of history ({ ev: 'history' }; earlier pages come with historyBefore). */
async function sendHistory(p, sessionId, { refresh = false, reqId = null } = {}) {
  const t0 = Date.now();
  // rev: the transcript's revision as sent, so a pane can later ask whether it drifted (historyCheck).
  const rev = await historyRevOf(sessionId);
  const page = await historyStore.firstPage(sessionId, { limit: HISTORY_PAGE }).catch((e) => { process.stderr.write(`history: ${e.message || e}\n`); return null; });
  if (page) {
    emit({ ev: 'history', reqId, paneId: p.id, sessionId, ...page, rev, ...(refresh ? { refresh: true } : {}), ms: Date.now() - t0 });
    sendContextEstimate(p, sessionId);
    return;
  }
  const msgs = await getSessionMessages(sessionId).catch(() => []);
  emit({ ev: 'history', reqId, paneId: p.id, sessionId, messages: compactMessages(msgs, sessionId), total: msgs.length, source: 'sdk', rev, ...(refresh ? { refresh: true } : {}) });
}

/*
 * No drift (Arthur, 2026-10-11: "when taking over session from another open tab, we need to make sure that when
 * that tab takes over back or is reopened or reloaded that it automatically refreshes to make sure it has the
 * most recent transcript/session data/etc - we need to make sure there is no drift always. Reliably.").
 * Every history carries the transcript's revision (its size and modified time). A pane that is not the one
 * writing the session (taken over, in use elsewhere, or idle while a terminal or a phone went on) asks with
 * historyCheck whenever it comes back into view and before it sends; a different revision sends it the
 * conversation again (history with refresh: true). The pane whose own Claude Code process holds the session
 * is never refreshed this way: its live stream is the newest there is.
 */
async function historyRevOf(sessionId) {
  const file = sessionId ? historyFileOf(sessionId) : null;
  if (!file) return null;
  try {
    const st = await fs.promises.stat(file);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

/* ---------- the open conversations (one per pane) ---------- */

function billingInfo(p) {
  if (isKimiPane(p)) return kimi.billing();
  const c = p ? p.credential : defaults.credential;
  return { name: c.name, source: c.source, follow: Boolean(c.follow), isKey: Boolean(c.key), glassVisible: !c.follow || providerVisible(lastGlassStatus, 'claude') };
}

async function closeRunner(p) {
  if (isKimiPane(p)) { await kimi.close(p); return; }
  // A Codex pane has no Claude Code process: stopping it interrupts a running turn and lets go of the thread (codex-panes.js).
  if (isCodexPane(p)) { await codex.close(p); return; }
  const r = p.runner;
  p.runner = null;
  if (!r) return;
  await r.stop();
  if (p.sessionId) releaseLock(p.sessionId);
}

/**
 * The other pane that already has this session open, if any. A pane whose
 * session was taken from it (no runner, a "Taken over" card) no longer counts.
 */
function paneWith(sessionId, exceptId) {
  // A pane whose conversation is in its console has it too (console.js): its TUI is the writer.
  for (const p of panes.values()) if (p.id !== exceptId && (p.runner || isCodexPane(p) || isKimiPane(p) || consoles.has(p.id)) && p.sessionId && p.sessionId === sessionId) return p;
  return null;
}

/**
 * Who holds a session in another window of this engine (the desktop window or
 * a phone), in the shape lockInfo gives for other apps, for the pane's
 * "Session in use" and "Taken over" cards.
 */
function holderOf(p) {
  // In a pane's console on the PC (2026-10-12): a phone's card says "Open in the console on the PC" and can look at it (consoleView).
  if (consoles.has(p.id)) return { name: 'the console on the PC', app: 'apaki-console', at: consoles.get(p.id)?.startedAt ? new Date(consoles.get(p.id).startedAt).toISOString() : new Date().toISOString(), alive: true };
  const phone = remote?.windowName(p.id) || null;
  return { name: phone ? `${phone} (phone)` : 'Apaki on this PC', app: phone ? 'apaki-phone' : 'apaki', at: p.openedAt || new Date().toISOString(), alive: true };
}

/**
 * A pane in another window of this engine had the session: stop it there
 * (its running turn is interrupted) and tell that window, so the
 * conversation continues only in the pane that took it.
 */
async function takeFrom(other, taker) {
  for (const [id, a] of state.asks) {
    if (a.paneId !== other.id) continue;
    state.asks.delete(id);
    a.resolve({ behavior: 'deny', message: 'The session was taken over in another window.' });
    // Its card goes with it (a permission prompt must not stay up for a call that no longer waits); `by` names the
    // window that took it, so the pane can say where the conversation went (askcard.js goneNote, 2026-10-12).
    emit({ ev: 'ask_gone', askId: id, paneId: other.id, why: 'taken', by: holderOf(taker).name });
  }
  // Its console ends (a turn there is stopped) and does not take the conversation back (console.js).
  await consoleCtl.shut(other, { reopen: false });
  const r = other.runner;
  other.runner = null;
  // Interrupted for the takeover: what it had queued stays unsent, like after a Stop.
  other.userStopped = true;
  // A Codex pane lets go of its thread (an interrupt first, if a turn runs); then it is no longer busy.
  if (isKimiPane(other)) await kimi.close(other);
  else if (isCodexPane(other)) await codex.close(other);
  other.busy = false;
  if (r) {
    if (r.running) await r.interrupt();
    await r.stop();
  }
  emit({ ev: 'taken_over', paneId: other.id, sessionId: other.sessionId, holder: holderOf(taker) });
}

/**
 * The context meter (Arthur, 2026-10-10: "theres no context percentage bar"):
 * asks the pane's Claude Code process how full its context window is (the
 * numbers behind /context, summary detail: no extra API calls) and sends the
 * window { ev: 'context' } with the percentage, the tokens, the window and
 * the biggest categories. Debounced per pane; quiet when no process runs.
 */
// Window sizes measured by the live meter, per model: the estimate below uses them once known.
const windowByModel = new Map();

/** The meter for a conversation with no process yet: its last call's usage, read from the transcript (context-estimate.js). */
async function sendContextEstimate(p, sessionId) {
  if (p.runner) return;
  const ev = estimateEvent(await lastUsage(historyFileOf(sessionId)), windowByModel);
  if (ev && !p.runner && p.sessionId === sessionId) emit({ ev: 'context', paneId: p.id, sessionId, ...ev, autoCompact: null, used: [] });
}

/**
 * The account behind a pane changed (a Glass swap, an API key, a subscription): its context window can be another
 * size for the same model (2026-10-11, Arthur is moving to a subscription), so the remembered window is dropped and
 * the meter measured again.
 */
function billingChanged(p) {
  windowByModel.clear();
  if (p?.runner) contextSoon(p, 2000);
}

function contextSoon(p, ms = 400) {
  clearTimeout(p.contextTimer);
  p.contextTimer = setTimeout(() => sendContext(p).catch(() => {}), ms);
}

async function sendContext(p, reqId = null) {
  const u = await p.runner?.contextUsage?.();
  if (!u) { if (reqId) emit({ ev: 'context', reqId, paneId: p.id, none: true }); return; }
  const used = (u.categories || []).filter((c) => (c.kind ? c.kind === 'used' : !/free|buffer/i.test(c.name)) && !c.isDeferred && c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens).slice(0, 6).map((c) => ({ name: c.name, tokens: c.tokens }));
  const max = u.rawMaxTokens || u.maxTokens || null;
  if (max && (u.model || p.model)) windowByModel.set(u.model || p.model, max);
  // autoCompactThreshold comes in tokens (967000 of a 1M window, measured 2026-10-10): the window shows a percentage.
  const thr = Number(u.autoCompactThreshold);
  const autoPct = Number.isFinite(thr) && thr > 0 ? (thr > 100 && max ? Math.round((100 * thr) / max) : Math.round(thr)) : null;
  emit({
    ev: 'context', reqId, paneId: p.id, sessionId: p.sessionId,
    percentage: Math.round(Number(u.percentage) || 0), totalTokens: u.totalTokens ?? null, maxTokens: max,
    autoCompact: u.isAutoCompactEnabled ? autoPct : false, model: u.model || p.model, used,
  });
}

/**
 * Questions (AskUserQuestion, plan approval) of a pane that no longer wait
 * for anyone: the turn ended, or Claude Code gave up and asked again. Each is
 * settled with no answer and the window drops its card (ask_gone), so a
 * person never answers the same question twice (Arthur, 2026-10-10).
 * `why` goes with ask_gone ('turn' the turn ended, 'again' Claude asked again,
 * 'stopped' the process ended) so the pane can say so in a short line.
 */
function dropStaleAsks(paneId, { olderThanMs = 0, questionsOnly = false, keepSubagents = false, why = 'turn' } = {}) {
  const now = Date.now();
  for (const [id, a] of state.asks) {
    if (a.paneId !== paneId || now - (a.at || 0) < olderThanMs) continue;
    // A permission prompt has no retry that replaces it (the SDK parks it with no deadline): only the end of the turn or a cancel settles it.
    if (questionsOnly && a.kind === 'permission') continue;
    // A background subagent can ask after, or across, the main turn's end: its prompt waits for its own answer or cancel.
    if (keepSubagents && a.kind === 'permission' && a.permission?.agentId) continue;
    state.asks.delete(id);
    a.resolve(null);
    emit({ ev: 'ask_gone', askId: id, paneId, why });
  }
}

/**
 * Opens a session (or a new conversation) in a pane. warm=false defers
 * starting Claude Code to the first message, so restoring six panes at launch
 * does not start six processes.
 */
const kimiOpens = new Map();
async function open(reqId, paneId, sessionId, cwd, opts = {}) {
  if (!isKimiId(sessionId)) return openPane(reqId, paneId, sessionId, cwd, opts);
  // Different pane queues can open the same saved session at once. Reserve it until ownership is established.
  const previous = kimiOpens.get(sessionId) || Promise.resolve();
  let release;
  const reservation = new Promise((resolve) => { release = resolve; });
  kimiOpens.set(sessionId, reservation);
  await previous;
  try { return await openPane(reqId, paneId, sessionId, cwd, opts); }
  finally { release(); if (kimiOpens.get(sessionId) === reservation) kimiOpens.delete(sessionId); }
}

async function openPane(reqId, paneId, sessionId, cwd, opts = {}) {
  const p = getPane(paneId);
  // The pane's conversation is in its console (a window that reloaded or came back): it stays there and shows again.
  // Another conversation asked for: the console ends first, without taking the old one back (console.js).
  if (consoles.has(p.id)) {
    if ((p.sessionId || null) === (sessionId || null)) { await consoleAttach(reqId, p); return; }
    await consoleCtl.shut(p, { reopen: false });
  }
  // Only in the archive: shown from it, and nothing starts until a message restores it (send, 2026-10-12).
  if (archivedOnly(sessionId)) opts = { ...opts, warm: false };
  // A Codex thread, or a new conversation asked to be Codex (2026-10-12): without the codex command the old hint stays.
  const wantKimi = isKimiId(sessionId) || opts.kind === 'kimi';
  if (wantKimi && parsePhoneId(p.id)) throw new Error('Kimi panes are available on the desktop only.');
  if (wantKimi && !KIMI_FOUND) {
    await closeRunner(p);
    await kimi.open(reqId, p, sessionId || null, cwd || null, opts);
    emit({ ev: 'error', reqId, paneId: p.id, message: 'Kimi Code was not found. Configure APAKI_KIMI_BIN and APAKI_KIMI_NODE, then restart the Apaki host.' });
    return;
  }
  if (wantKimi && sessionId && isKimiPane(p) && p.sessionId === sessionId && p.busy) { await kimi.attach(reqId, p); return; }
  const wantCodex = !wantKimi && (isCodexId(sessionId) || opts.kind === 'codex');
  if (wantCodex && !CODEX_FOUND) { emit({ ev: 'note', reqId, paneId: p.id, tone: 'warn', text: sessionId ? `${codexResumeHint(sessionId)} (Codex is not installed on this PC, so Apaki cannot open it.)` : 'Codex is not installed on this PC (no codex command was found). Install it with npm install -g @openai/codex.' }); return; }
  // The same Codex thread already open and working in this pane (a window that came back): it is kept, not restarted.
  if (wantCodex && sessionId && isCodexPane(p) && p.sessionId === sessionId && p.busy) { await codex.attach(reqId, p); return; }
  const other = sessionId ? paneWith(sessionId, p.id) : null;
  if (other && windowOf(other.id) === windowOf(p.id)) { emit({ ev: 'open_elsewhere', reqId, paneId: p.id, sessionId, otherPane: other.id }); return; }
  if (other && !opts.force) {
    // Open in the other window of this engine (the desktop and a phone): the
    // same card as a session held by another app, with Take over here.
    const held = await getSessionInfo(sessionId).catch(() => null);
    // What this pane asked for, so a phone can look at the console that has it (consoleView).
    p.lockedOn = sessionId;
    emit({ ev: 'locked', reqId, paneId: p.id, sessionId, holder: holderOf(other), title: held?.customTitle || held?.summary || null, cwd: cwd || held?.cwd || '' });
    return;
  }
  if (other) await takeFrom(other, p);
  // Open in a terminal window (Open in terminal, console.js): the same "in use" card; Take over here makes that window
  // stop before it writes again, then this pane goes on.
  const termHeld = sessionId ? readHeld(CONSOLE_DIR, sessionId) : null;
  if (termHeld && !opts.force) {
    p.lockedOn = sessionId;
    emit({ ev: 'locked', reqId, paneId: p.id, sessionId, holder: termHeld, title: null, cwd: cwd || termHeld.cwd || '' });
    return;
  }
  if (termHeld) await takeBackHeld(CONSOLE_DIR, sessionId);
  await closeRunner(p);
  if (wantKimi) {
    if ((p.sessionId || null) !== (sessionId || null)) resetHeld(p);
    p.createdHere = false;
    await kimi.open(reqId, p, sessionId || null, cwd || null, opts);
    return;
  }
  if (wantCodex) {
    // Another conversation in this pane: what was queued for the old one no longer applies (as below for Claude).
    if ((p.sessionId || null) !== (sessionId || null)) resetHeld(p);
    p.createdHere = false;
    p.sessionId = sessionId || null;
    // The picks of a Claude pane are not Codex's: only what the window sends for this pane (model, effort, mode) counts.
    await codex.open(reqId, p, sessionId || null, cwd || null, { model: opts.model, effort: opts.effort, mode: opts.mode, tune: opts.tune, force: opts.force });
    return;
  }
  if (opts.model) p.model = opts.model;
  if (opts.effort) p.effort = opts.effort;
  if (opts.mode) p.mode = opts.mode;
  // Ultracode and its size travel with open like the other picks; a Codex pane's tune (summary, speed) reads as the defaults here.
  p.tune = claudeTune(opts.tune !== undefined ? opts.tune : p.tune);
  p.tuneAvailable = true;
  // A phone pane: the mode, tools and permission answers its phone's access allows (remote-policy.js capabilities).
  const capOpts = parsePhoneId(p.id) ? capRunnerOptions(phoneCap(p.id), p.mode) : null;
  if (capOpts) p.mode = capOpts.permissionMode;
  if (tuneRestricted(p)) p.tune = claudeTune({ size: p.tune.size });
  let info = null;
  if (sessionId) {
    // Held by a live latch or another Apaki: the pane offers "Take over here",
    // which comes back as open with force. The old holder is stopped before it
    // writes again (runner.lockGuard there, the relay hook in terminal windows).
    const holder = takeLock(sessionId, { force: Boolean(opts.force) });
    if (holder) {
      info = await getSessionInfo(sessionId).catch(() => null);
      emit({ ev: 'locked', reqId, paneId: p.id, sessionId, holder: lockInfo(sessionId), title: info?.customTitle || info?.summary || null, cwd: cwd || info?.cwd || '' });
      return;
    }
    info = await getSessionInfo(sessionId).catch(() => null);
  }
  // Another conversation in this pane: what was queued for the old one, and a Stop on it, no longer apply.
  if ((p.sessionId || null) !== (sessionId || null)) resetHeld(p);
  p.sessionId = sessionId || null;
  // Set once this pane's new conversation gets its session id (host.js restoreAsAttach).
  p.createdHere = false;
  p.openedAt = new Date().toISOString();
  p.credential = p.credential.follow ? glassCredential() : p.credential;
  const tools = toolsFor(p);
  const permissionGate = createPermissionGate({ paneId: p.id, asks: state.asks, emit, alwaysOk: () => !parsePhoneId(p.id) || phoneCap(p.id) === 'full' });
  const runner = new SessionRunner({
    sessionId: sessionId || null,
    cwd: cwd || info?.cwd || os.homedir(),
    env: childEnv(p.credential.key),
    // Apaki's own tools and "open this" catcher, passed at runtime only.
    mcpServers: tools.mcpServers,
    appendSystemPrompt: tools.appendSystemPrompt,
    // A phone pane also gets the capability hook (it holds in bypassPermissions too) and its tool limits.
    hooks: capOpts ? { ...tools.hooks, PreToolUse: [...(tools.hooks.PreToolUse || []), capPreToolUse(() => phoneCap(p.id))] } : tools.hooks,
    disallowedTools: capOpts?.disallowedTools,
    allowedTools: capOpts?.allowedTools,
    envExtra: browserEnv(p),
    // "Auto-compact at": passed to this process as its own setting (the SDK's `settings`, like claude --settings),
    // read on every start so a change in Settings applies to conversations as they next start; no settings file is written.
    // Ultracode and its size are passed the same way (tune.js startSettings); a phone below Full access gets workflows turned off.
    flagSettings: () => ({ ...(compactSettings(prefs.autoCompact) || {}), ...startSettings(p.tune, { restricted: tuneRestricted(p) }) }),
    model: p.model,
    effort: p.effort,
    permissionMode: p.mode,
    // Tools Claude Code would ask about are asked here (permissions.js): the pane's window or phone answers. A phone's
    // blocked tools are refused first (capCanUseTool), and only a 'full' phone may save an "always allow" rule.
    canUseTool: capOpts ? capCanUseTool(() => phoneCap(p.id), permissionGate) : permissionGate,
    onMessage: (msg) => {
      // A turn cannot end while a question really waits (its tool call is held), so any still open now went stale.
      if (msg?.type === 'result' || msg?.type === 'latch_error') dropStaleAsks(p.id, { keepSubagents: true });
      // Only what windows and phones draw goes out (2026-10-15, sdk-forward.js): subagent traffic and thinking or
      // tool-input deltas were parsed on the window's main thread and thrown away.
      if (forwardToClients(msg)) emit({ ev: 'sdk', paneId: p.id, sessionId: p.sessionId, msg });
      // What the pane is doing (a turn, background tasks), for attach and the host's idle rules (host.js).
      paneActivity(p, runner, msg);
      // The context meter: measured once the process is up, after every turn and after a compaction, and during a
      // turn after each model step (an assistant message), so it moves while Claude works (2026-10-11, Arthur:
      // "make sure that context dynamically is displayed"). contextSoon debounces: at most one measure per 1.5 s.
      if (msg?.type === 'result' || (msg?.type === 'system' && (msg.subtype === 'init' || msg.subtype === 'compact_boundary'))) contextSoon(p);
      else if (msg?.type === 'assistant' && !msg.parent_tool_use_id) contextSoon(p, 1500);
    },
    onStderr: (d) => process.stderr.write(String(d).replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')),
  });
  // The Claude Code process ended (a stop, a restart for another effort or account, a crash): nothing it asked still waits.
  runner.onProcessEnd = () => dropStaleAsks(p.id, { why: 'stopped' });
  // Questions and plan approval go to the window and wait for its answer.
  runner.onInteractiveTool = (toolName, input) => new Promise((resolve) => {
    // Asked again while an earlier one has been open a while: Claude Code gave up on the earlier one (a
    // retry comes a minute or more later; questions asked together arrive within a second), so the window drops it.
    dropStaleAsks(p.id, { olderThanMs: 5000, questionsOnly: true, why: 'again' });
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // toolName and input are kept so attach can ask a reconnected window again.
    state.asks.set(id, { resolve, paneId: p.id, toolName, input, at: Date.now() });
    emit({ ev: 'ask', askId: id, paneId: p.id, toolName, input });
  });
  // A chat-only phone cannot carry out a plan: ExitPlanMode is answered here, before the phone is asked.
  if (capOpts) {
    const ask = runner.onInteractiveTool;
    runner.onInteractiveTool = (toolName, input) => (toolName === 'ExitPlanMode' && phoneCap(p.id) === 'chat' ? Promise.resolve({ behavior: 'deny', message: CAP_PLAN_TEXT }) : ask(toolName, input));
  }
  // A one-line "what it is doing" for running subagents (task_progress summary;
  // a short fork every ~30 s on the subagent's own cache).
  runner.progressSummaries = true;
  runner.onNewSession = (id) => {
    rememberCreated(id);
    p.sessionId = id;
    p.createdHere = true;
    // Made while no window is connected: the saved workspace learns the new session (host mode).
    markAway(p, { s: id });
    takeLock(id, { force: true });
    emit({ ev: 'session_id', paneId: p.id, sessionId: id });
  };
  // Follow Myrlin Glass before every message (see SessionRunner.send).
  runner.authKey = p.credential.key ?? null;
  runner.authCheck = p.credential.follow ? () => { const c = glassCredential(); return { ...c, env: childEnv(c.key) }; } : null;
  runner.onAuthChange = (next) => {
    // The Glass watcher below usually announced this swap already.
    const announced = (p.credential.key ?? null) === (next.key ?? null);
    p.credential = { ...next, follow: true };
    billingChanged(p); emit({ ev: 'billing', paneId: p.id, ...billingInfo(p), note: announced ? undefined : `Myrlin Glass switched Claude to ${next.name}; this conversation continues on it.` });
  };
  // Taken over by another window since: stop instead of forking the conversation.
  runner.lockGuard = () => (p.sessionId ? lockStolen(p.sessionId) : null);
  p.runner = runner;
  // A pane in a folder the lists have no numbers for yet (a new worktree): the branch label follows within a second.
  // Its own worktree is the one looked at again (2026-10-15), not every repository.
  wtSoon(600, runner.cwd);
  emit({ ev: 'opened', tookOver: Boolean(opts.force),  reqId, paneId: p.id, sessionId: p.sessionId, cwd: runner.cwd, title: info?.customTitle || info?.summary || 'New conversation', model: p.model, effort: p.effort, mode: p.mode, tune: tuneView(p), billing: billingInfo(p), terminal: sessionId ? terminalSessions().get(sessionId) || [] : [] });
  // Phones that watch this desktop pane (the shared view) stay on it through a new conversation; the window's pane may be new.
  if (!parsePhoneId(p.id)) remote?.announceFollowers?.(p.id);
  if (opts.warm !== false) runner.start();
  // The whole conversation, newest page first (history.js; the SDK's list when the file cannot be read).
  if (sessionId) await sendHistory(p, sessionId);
}

async function send(reqId, paneId, text, images = []) {
  const p = getPane(paneId);
  // One writer (2026-10-12, console.js): the conversation is in this pane's console, or in a terminal window
  // (Open in terminal). Say so instead of writing over it; the pane's own card offers to take it back.
  if (consoleCtl.active(p.id)) { emit({ ev: 'error', reqId, paneId: p.id, message: 'This conversation is open in this pane\'s console. Switch back to Apaki\'s view (Ctrl+`) to send from here.' }); return; }
  const termHeld = p.sessionId ? readHeld(CONSOLE_DIR, p.sessionId) : null;
  if (termHeld) { emit({ ev: 'taken_over', reqId, paneId: p.id, sessionId: p.sessionId, holder: termHeld }); return; }
  // A Codex thread whose pane let go of it (idle with no window, or taken over and taken back): open it again, then send.
  if (!isKimiPane(p) && isKimiId(p.sessionId)) {
    await open(null, p.id, p.sessionId, null, { warm: false });
    if (!isKimiPane(p)) return;
  }
  if (!isCodexPane(p) && isCodexId(p.sessionId)) {
    await open(null, p.id, p.sessionId, null, { warm: false });
    if (!isCodexPane(p)) return;
  }
  if (isKimiPane(p)) { await kimi.send(reqId, p, text, images); return; }
  if (isCodexPane(p)) { await codex.send(reqId, p, text, images); return; }
  // A conversation only the archive still has goes back where Claude Code keeps it, then continues (2026-10-12).
  if (p.sessionId && archivedOnly(p.sessionId)) {
    const restored = (() => { try { return restoreArchived(p.sessionId); } catch { return null; } })();
    if (restored) {
      archivedCache.at = 0;
      emit({ ev: 'note', paneId: p.id, tone: '', text: 'Restored from Apaki\'s archive (images were not kept); this conversation continues.' });
    }
  }
  if (!p.runner && p.sessionId) {
    // This pane lost its session to a takeover: never start a new one in its place.
    const holder = lockStolen(p.sessionId);
    if (holder) { emit({ ev: 'taken_over', reqId, paneId: p.id, sessionId: p.sessionId, holder }); return; }
    await open(null, p.id, p.sessionId, null, {});
    if (!p.runner) return;
  }
  if (!p.runner) await open(null, p.id, null, null);
  const content = images.length
    ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), ...(text ? [{ type: 'text', text }] : [])]
    : text;
  try {
    p.busy = true;
    const r = await p.runner.send(content);
    p.busy = false;
    emit({ ev: 'result', reqId, paneId: p.id, sessionId: p.sessionId, subtype: r.subtype, isError: Boolean(r.is_error), durationMs: r.duration_ms, usage: r.usage, cost: r.latchTurnCost ?? null, errors: r.errors || null, result: typeof r.result === 'string' ? r.result.slice(0, 2000) : null });
    if (p.sessionId && state.renames.has(p.sessionId)) applyRename(p.sessionId, state.renames.get(p.sessionId), { paneId: p.id }).catch(() => {});
  } catch (e) {
    p.busy = false;
    if (e.code === 'TAKEN_OVER') {
      // Stop this pane's process; the lock is the other window's now.
      const r = p.runner;
      p.runner = null;
      await r?.stop();
      emit({ ev: 'taken_over', reqId, paneId: p.id, sessionId: p.sessionId, holder: e.holder });
      return;
    }
    emit({ ev: 'error', reqId, paneId: p.id, message: e.message || String(e) });
  }
}

/**
 * A window reconnected (the phone client after a network change or a page
 * reload): sends the pane's state again, and any question still waiting for
 * it, without restarting its Claude Code process, so a running turn keeps
 * running. A pane the engine no longer has (or holds another session) is
 * opened as usual, without starting Claude Code until its next message.
 */
async function attach(reqId, paneId, sessionId, cwd) {
  const p = panes.get(String(paneId));
  // Its conversation is in its console: the pane's state and the console's screen again, the TUI untouched.
  if (p && consoles.has(p.id) && (p.sessionId || null) === (sessionId || null)) { await consoleAttach(reqId, p); return; }
  // A Codex pane that is still here: its state and history again, the server and its turn untouched.
  if (p && isCodexPane(p) && (p.sessionId || null) === (sessionId || null)) { await codex.attach(reqId, p); return; }
  if (!p || !p.runner || (p.sessionId || null) !== (sessionId || null)) { await open(reqId, paneId, sessionId, cwd, { warm: false, kind: isKimiId(sessionId) ? 'kimi' : isCodexId(sessionId) ? 'codex' : undefined }); return; }
  const info = p.sessionId ? await getSessionInfo(p.sessionId).catch(() => null) : null;
  // busy: a message sent here is still running (its result event follows, which clears it in the window);
  // turn: any turn is running, also one Claude started by itself (the window picks that up from its next
  // message_start); running: its Claude Code process is up (a restored pane not started yet attaches too).
  emit({ ev: 'opened', attached: true, busy: Boolean(p.busy), turn: paneTurnBusy(p), running: Boolean(p.runner.running), reqId, paneId: p.id, sessionId: p.sessionId, cwd: p.runner.cwd, title: info?.customTitle || info?.summary || 'New conversation', model: p.model, effort: p.effort, mode: p.mode, tune: tuneView(p), billing: billingInfo(p), terminal: p.sessionId ? terminalSessions().get(p.sessionId) || [] : [],
    // The queue as this engine holds it (queue-hold.js): what is still queued, and the ids it sent while no window was here.
    ...heldView(p) });
  // A window that came back learns which phones watch this pane (the shared view).
  if (!parsePhoneId(p.id)) remote?.announceFollowers?.(p.id);
  if (p.sessionId) await sendHistory(p, p.sessionId);
  for (const [askId, a] of state.asks) if (a.paneId === p.id) emit({ ev: 'ask', askId, paneId: p.id, toolName: a.toolName, input: a.input, ...(a.permission ? { permission: a.permission } : {}) });
  // Subagents and background tasks still running in this process, so the window's Tasks button and panel show them again.
  for (const msg of taskReplay(p)) emit({ ev: 'sdk', paneId: p.id, sessionId: p.sessionId, msg });
}

/**
 * The shared view (2026-10-11): a message went into a desktop pane. The engine does not echo user messages (a window draws its
 * own as it sends), so the other windows of the pane need an event to draw it:
 *   - sent by a phone that follows the pane (c.follower is its name): the window draws it, and so does every other follower;
 *     the phone that sent it drew its own (origin names that phone's pane, remote.js mirror skips it);
 *   - sent by the window (or by this engine's auto-send of a queue): only the phones that follow the pane get it. The window
 *     is not told, so it never draws its own message twice.
 * A phone pane's own messages are nobody's business (no follower is registered for them).
 */
function peerMessage(c, text, images, steered) {
  if (parsePhoneId(String(c.paneId))) return;
  const ev = { ev: 'peerMessage', paneId: String(c.paneId), from: c.follower || 'Desktop', text, images, steered, origin: c.origin || null };
  if (c.follower) emit(ev); else remote?.mirror?.(ev);
}

/**
 * The shared view (2026-10-11): a phone pane starts following a desktop pane. It gets the desktop pane's state the way a window
 * that attaches does (opened with attached, busy, running, model, effort and mode, the newest page of history, the questions that
 * still wait, the running tasks), addressed to the phone's own pane id so remote.js sends it to that phone only. Nothing is
 * opened, taken over or started: the desktop pane keeps its one runner, its lock and its queue. What the window typed and has not
 * sent (its queue, held here for a window-less host) is never part of it. After this, remote.js sends the phone the pane's later
 * events (mirror) and applies the phone's ops to the desktop pane.
 */
async function followState(c) {
  const to = String(c.paneId);
  const p = panes.get(String(c.desktopPaneId || ''));
  // remote.js checked that the pane is a conversation; it may have closed since. The phone pane then hears closed, which also
  // removes it from remote.js's list of followers.
  if (!p || parsePhoneId(p.id)) { emit({ ev: 'closed', reqId: c.reqId, paneId: to }); return; }
  // A Codex pane (2026-10-12): the same state from Codex's side, under the phone's pane id.
  if (isCodexPane(p)) { await codex.attach(c.reqId, p, { paneId: to, readOnly: Boolean(c.readOnly) }); return; }
  const info = p.sessionId ? await getSessionInfo(p.sessionId).catch(() => null) : null;
  emit({
    ev: 'opened', attached: true, follower: true, readOnly: Boolean(c.readOnly), reqId: c.reqId, paneId: to,
    busy: Boolean(p.busy), turn: paneTurnBusy(p), running: Boolean(p.runner?.running),
    sessionId: p.sessionId, cwd: p.runner?.cwd || null, title: info?.customTitle || info?.summary || 'New conversation',
    model: p.model, effort: p.effort, mode: p.mode, tune: tuneView(p), billing: billingInfo(p), terminal: p.sessionId ? terminalSessions().get(p.sessionId) || [] : [],
  });
  // The history and the meter estimate for a conversation with no process: the same helper, named for the phone's pane.
  if (p.sessionId) await sendHistory({ id: to, runner: p.runner, sessionId: p.sessionId }, p.sessionId);
  for (const [askId, a] of state.asks) if (a.paneId === p.id) emit({ ev: 'ask', askId, paneId: to, toolName: a.toolName, input: a.input, ...(a.permission ? { permission: a.permission } : {}), readOnly: Boolean(c.readOnly) });
  for (const msg of taskReplay(p)) emit({ ev: 'sdk', paneId: to, sessionId: p.sessionId, msg });
}

/** Closes a pane: its Claude Code process stops and its session lock is freed. */
async function closePane(reqId, paneId) {
  const p = panes.get(String(paneId));
  if (!p) return;
  if (isKimiPane(p)) p.userStopped = true;
  for (const [id, a] of state.asks) {
    if (a.paneId !== p.id) continue;
    state.asks.delete(id);
    a.resolve({ behavior: 'deny', message: 'The pane was closed.' });
    emit({ ev: 'ask_gone', askId: id, paneId: p.id, why: 'closed' });
  }
  // Its console ends first (a running turn there is stopped), without taking the conversation back.
  await consoleCtl.shut(p, { reopen: false });
  await closeRunner(p);
  openServer?.forget(p.id);
  panes.delete(p.id);
  emit({ ev: 'closed', reqId, paneId: p.id });
}

/* ---------- the console and Open in terminal (console.js, 2026-10-12) ---------- */

// The console's files (settings for --settings, terminal specs, held records), with their note (console.js ensureDir).
const CONSOLE_DIR = path.join(latchDir(), 'console');
const TERMINAL_SCRIPT = path.join(ENGINE_ROOT, 'apaki', 'bin', 'apaki-terminal.mjs');
// The packaged prompt-relay hook, for a pane billed to an API key (see console.js claudeCommand).
const RELAY_HOOK = path.join(ENGINE_ROOT, 'hooks', 'prompt-relay.js');

/** 'codex' for a Codex pane, also one whose thread is let go (a console holds it), else 'claude'. */
const consoleKind = (p) => (isCodexPane(p) || isCodexId(p?.sessionId) ? 'codex' : 'claude');
/** The pane's folder: its runner's, its Codex thread's, or the one it had before its process was let go. */
const paneCwd = (p) => p?.runner?.cwd || p?.codex?.cwd || p?.consoleCwd || null;
/** Runs fn in the pane's queue (after an open or a send in flight) and returns its promise. */
function serialRun(p, fn) {
  const run = (p.queue || Promise.resolve()).then(fn);
  p.queue = run.catch(() => {});
  return run;
}

/** The pane lets go of its conversation so the console or a terminal window is its only writer. */
async function releaseForConsole(p) {
  p.consoleCwd = paneCwd(p) || p.consoleCwd || null;
  if (isCodexPane(p)) {
    // Only what was picked in the pane travels back with it (codex-panes.js threadParams).
    const t = p.codex?.touched || {};
    p.consolePicks = { model: t.model ? p.model : undefined, effort: t.effort ? p.effort : undefined, mode: t.mode ? p.mode : undefined };
    await codex.close(p);
    return;
  }
  await closeRunner(p);
}

/** The pane takes its conversation back after the console or a terminal window: it reads the transcript again. */
async function reopenAfterConsole(p, { kind, sessionId, cwd }) {
  if (kind === 'codex') {
    if (!CODEX_FOUND) return;
    await codex.open(null, p, sessionId || null, cwd || null, { ...(p.consolePicks || {}) });
    return;
  }
  await open(null, p.id, sessionId || null, cwd || null, { warm: false });
}

/** The exact command for a pane's conversation (the console and Open in terminal both run it). */
function consoleCommand(p, { kind, sessionId, newSessionId = null, cwd, holderPid = process.pid }) {
  if (kind === 'codex') {
    return codexCommand({ codex: findCodex(), threadId: sessionId ? threadIdOf(sessionId) : null, model: p?.model || undefined, effort: p?.effort || undefined, mode: p?.mode || undefined, cwd });
  }
  const credential = p ? (p.credential.follow ? glassCredential() : p.credential) : defaults.credential;
  return claudeCommand({
    bin: claudeBinary(), sessionId, newSessionId, model: p?.model || defaults.model, effort: p?.effort || defaults.effort, mode: p?.mode || defaults.mode,
    // The same per-process settings the pane's SDK runs get (runner.flagSettings above).
    flagSettings: compactSettings(prefs.autoCompact),
    credential, hookFile: fs.existsSync(RELAY_HOOK) ? RELAY_HOOK : null, userHook: userHasRelayHook(path.join(CLAUDE_DIR, 'settings.json')),
    holderPid, nodeDir: path.dirname(process.execPath), settingsDir: consoleDirReady(CONSOLE_DIR), defaultKeyWords: DEFAULT_KEY_WORDS,
  });
}

const consoles = createConsoles({ emit, log: (line) => process.stderr.write(`apaki: ${line}\n`) });
const consoleCtl = createConsoleControl({
  emit, consoles, getPane,
  kindOf: consoleKind,
  turnBusy: (p) => (isCodexPane(p) ? Boolean(p.busy) : paneTurnBusy(p)),
  interrupt: async (p) => { p.userStopped = true; if (isCodexPane(p)) await codex.interrupt(p); else await p.runner?.interrupt(); },
  release: releaseForConsole,
  reopen: reopenAfterConsole,
  cwdOf: paneCwd,
  lock: {
    // A terminal window first (Open in terminal), then, for Claude Code, the session lock (latch, another Apaki).
    take: (sessionId, kind) => {
      const held = readHeld(CONSOLE_DIR, sessionId);
      if (held) return held;
      if (kind !== 'claude') return null;
      const pid = takeLock(sessionId, { app: 'apaki-console' });
      return pid ? (lockInfo(sessionId) || { pid }) : null;
    },
    release: (sessionId, kind) => { if (kind === 'claude') releaseLock(sessionId); },
  },
  command: (p, o) => consoleCommand(p, o),
  envFor: (spec) => consoleEnv(childEnv(null), spec),
  serial: (p, fn) => serialRun(p, fn),
  sessionExists: (id) => Boolean(historyFileOf(id)),
  adopt: (p, id) => { rememberCreated(id); p.sessionId = id; p.createdHere = true; markAway(p, { s: id }); emit({ ev: 'session_id', paneId: p.id, sessionId: id }); },
  log: (line) => process.stderr.write(`apaki: ${line}\n`),
});

/** A window came back to a pane whose conversation is in its console: the pane's state, then the console's screen. */
async function consoleAttach(reqId, p) {
  const con = consoles.get(p.id);
  const kind = con?.kind || consoleKind(p);
  const info = kind === 'claude' && p.sessionId ? await getSessionInfo(p.sessionId).catch(() => null) : null;
  emit({
    ev: 'opened', attached: true, console: true, busy: false, turn: false, running: false, reqId, paneId: p.id, sessionId: p.sessionId || null, cwd: con?.cwd || paneCwd(p) || '',
    title: info?.customTitle || info?.summary || p.codexTitle || 'New conversation', model: p.model, effort: p.effort, mode: p.mode,
    billing: kind === 'codex' ? { name: 'Codex', source: 'codex', follow: false, isKey: false } : billingInfo(p), terminal: [], ...(kind === 'codex' ? { kind: 'codex' } : {}),
  });
  if (kind === 'claude' && p.sessionId) await sendHistory(p, p.sessionId);
  consoles.replay(p.id, { reqId });
}

/** Conversations open in a terminal window, watched until it closes: sessionId -> { paneId, kind, cwd, at, seen }. */
const terminalWatch = new Map();
let terminalTimer = null;

/** A terminal window let go of a conversation: the pane that had it reads it again. */
async function terminalClosed(sessionId, w) {
  const p = w.paneId ? panes.get(w.paneId) : null;
  if (p && p.sessionId === sessionId && !p.runner && !isCodexPane(p) && !consoles.has(p.id)) {
    await serialRun(p, () => reopenAfterConsole(p, { kind: w.kind, sessionId, cwd: w.cwd })).catch((e) => process.stderr.write(`apaki: terminal reopen: ${e.message}\n`));
  }
  emit({ ev: 'terminal', paneId: p?.id || null, sessionId, kind: w.kind, state: 'closed' });
}

function watchTerminals() {
  for (const [sid, w] of terminalWatch) {
    if (readHeld(CONSOLE_DIR, sid)) { w.seen = true; continue; }
    // The window may still be opening: it has 20 s to say it has the conversation.
    if (!w.seen && Date.now() - w.at < 20000) continue;
    terminalWatch.delete(sid);
    terminalClosed(sid, w);
  }
  if (!terminalWatch.size && terminalTimer) { clearInterval(terminalTimer); terminalTimer = null; }
}

/**
 * Open in terminal (Arthur, 2026-10-12: "an "open in terminal" button to just open the exact session with all
 * settings/effort/models/etc in a terminal window"): the pane's command (consoleCommand) in a terminal window on this
 * PC, Windows Terminal or PowerShell. The pane that has the conversation lets go of it first; the window's runner
 * (apaki/bin/apaki-terminal.mjs) says it has it, so a send from the pane meanwhile shows "in use" instead of writing
 * over it, and the pane reads the conversation again when the window closes. The sidebar's row menu sends the same op.
 */
async function openTerminal(c) {
  const reqId = c.reqId || null;
  const asked = c.paneId != null ? panes.get(String(c.paneId)) || null : null;
  const sessionId = c.sessionId || asked?.sessionId || null;
  const kind = c.kind === 'codex' || isCodexId(sessionId) || (asked && !sessionId && consoleKind(asked) === 'codex') ? 'codex' : 'claude';
  const say = (state, extra = {}) => emit({ ev: 'terminal', reqId, paneId: asked?.id || null, sessionId, kind, state, ...extra });
  if (asked && parsePhoneId(asked.id)) { say('error', { note: 'Open in terminal is for the PC.' }); return; }
  if (!sessionId) { say('error', { note: 'Send a message first: a new conversation has nothing to open in a terminal yet.' }); return; }
  // The desktop pane that has this conversation, if any (this one, or the one the sidebar row points at).
  const p = asked && asked.sessionId === sessionId ? asked : [...panes.values()].find((x) => x.sessionId === sessionId && !parsePhoneId(x.id)) || null;
  if (p && consoleCtl.active(p.id)) { say('error', { note: 'This conversation is open in its pane\'s console. Switch that pane back first.' }); return; }
  if (readHeld(CONSOLE_DIR, sessionId)) { say('error', { note: 'This conversation is already open in a terminal window.' }); return; }
  if (p && (isCodexPane(p) ? p.busy : paneTurnBusy(p))) { say('error', { note: `${kind === 'codex' ? 'Codex' : 'Claude'} is working in this conversation. Wait for the turn to end (or stop it), then open it in a terminal.` }); return; }
  // A phone pane, or another app (latch, another Apaki), has it: not opened over it.
  const phonePane = [...panes.values()].find((x) => x.sessionId === sessionId && parsePhoneId(x.id) && (x.runner || isCodexPane(x)));
  if (phonePane) { say('error', { note: `${remote?.windowName(phonePane.id) || 'A phone'} has this conversation open. Close it there first.` }); return; }
  if (kind === 'claude') {
    const h = lockStolen(sessionId);
    if (h) { say('error', { note: `${h.name || 'Another window'} has this conversation open${h.pid ? ` (pid ${h.pid})` : ''}. Close it there first.` }); return; }
  }
  let cwd = (p && paneCwd(p)) || c.cwd || null;
  if (!cwd && kind === 'claude') cwd = (await getSessionInfo(sessionId).catch(() => null))?.cwd || null;
  if (!cwd && kind === 'codex') cwd = codex.cachedRows().find((r) => r.id === sessionId)?.cwd || null;
  if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();
  // One writer: the pane lets go first (it resumes from the transcript afterwards).
  if (p) await serialRun(p, () => releaseForConsole(p));
  // Claude Code's settings come from the pane when one has it, else from Apaki's defaults; the runner holds the lock (holderPid null).
  const spec = consoleCommand(p, { kind, sessionId, cwd, holderPid: null });
  const back = async () => { if (p) await serialRun(p, () => reopenAfterConsole(p, { kind, sessionId, cwd })).catch(() => {}); };
  if (spec.error) { say('error', { note: spec.error }); await back(); return; }
  let specFile;
  try {
    consoleDirReady(CONSOLE_DIR);
    specFile = path.join(CONSOLE_DIR, `terminal-${crypto.randomUUID()}.json`);
    // The environment's changes only, never the environment itself (no secrets on disk).
    fs.writeFileSync(specFile, JSON.stringify({ sessionId, kind, cwd, file: spec.file, args: spec.args, envSet: spec.envSet, envUnset: spec.envUnset, pathPrepend: spec.pathPrepend, note: spec.note, display: spec.display }));
  } catch (e) { say('error', { note: `Could not prepare the terminal: ${e.message}` }); await back(); return; }
  const title = `${kind === 'codex' ? 'Codex' : 'Claude Code'}: ${(p?.codexTitle || state.byId.get(sessionId)?.title || sessionId).slice(0, 60)}`;
  const launch = terminalLaunch(process.platform, { cwd, title, file: process.execPath, args: [TERMINAL_SCRIPT, specFile] });
  const start = (t, fallback) => {
    try {
      const child = spawn(t.cmd, t.args, { cwd: t.cwd || cwd, detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => { if (fallback) start(fallback, null); else say('error', { note: `No terminal could be opened (${t.cmd}).` }); });
      child.unref();
    } catch { if (fallback) start(fallback, null); }
  };
  start(launch, launch.fallback || null);
  terminalWatch.set(sessionId, { paneId: p?.id || null, kind, cwd, at: Date.now(), seen: false });
  if (!terminalTimer) terminalTimer = setInterval(watchTerminals, 1500);
  say('opened', { display: spec.display, note: spec.note || null, tone: spec.tone || 'info' });
}

/* ---------- voice (local Whisper) ---------- */

// whisper.cpp (CPU build) and a free English model, installed next to the app
// (Arthur, 2026-10-09: "local whisper model - something free"). Nothing leaves
// the PC: the window records 16 kHz WAV, this transcribes it.
// Per platform (src/platform.js voiceDir): %LOCALAPPDATA%\Programs\Myrlin Apaki\voice on Windows, ~/Library/Application
// Support/Myrlin Apaki/voice on a Mac. The Mac app carries its own signed whisper.cpp (Metal) in Contents/Resources/voice
// (macOS port phase 2, 2026-10-13; bundledVoiceDir), used when the per-user folder has none; the model is downloaded on
// request into the per-user folder (voice-model.js, op voiceModel).
const VOICE_DIR = voiceDir();
const BUNDLED_VOICE = bundledVoiceDir(ENGINE_ROOT);
/** The whisper-cli to run: the per-user voice folder's, else the app bundle's, else (not installed) the per-user path. */
const whisperBin = () => {
  const own = path.join(VOICE_DIR, 'bin', 'Release', whisperName());
  if (fs.existsSync(own) || !BUNDLED_VOICE) return own;
  const bundled = path.join(BUNDLED_VOICE, 'bin', 'Release', whisperName());
  return fs.existsSync(bundled) ? bundled : own;
};
const WHISPER_MODEL = process.env.APAKI_WHISPER_MODEL || path.join(VOICE_DIR, 'models', MODEL_FILE);
const voiceReady = () => fs.existsSync(whisperBin()) && fs.existsSync(WHISPER_MODEL);
const VOICE_VOCAB = process.env.APAKI_VOICE_VOCAB || 'Myrlin, Myrlin Glass, Myrlin Apaki, Myrlin Forge, Myrlin Jobs, Claude, Claude Code, Codex, Opus, Sonnet, Haiku, Fable, SignalSentry, Pantex, Hytale, Tauri, latch.';

function transcribe(reqId, wavBase64, paneId = null) {
  if (!voiceReady()) { emit({ ev: 'error', reqId, paneId, message: `Voice is not installed (${whisperBin()}).` }); return Promise.resolve(); }
  const file = path.join(os.tmpdir(), `apaki-voice-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(file, Buffer.from(String(wavBase64 || ''), 'base64'));
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '';
    // The vocabulary prompt keeps names Whisper does not know spelled right.
    const child = spawn(whisperBin(), ['-m', WHISPER_MODEL, '-f', file, '-nt', '-np', '-l', 'en', '-t', String(Math.min(8, os.cpus().length)), '--prompt', VOICE_VOCAB], { windowsHide: true });
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { emit({ ev: 'error', reqId, paneId, message: `Whisper failed: ${e.message}` }); });
    child.on('close', () => {
      fs.rm(file, { force: true }, () => {});
      // "Myrlin" sounds exactly like "Merlin"; in Arthur's work it is always Myrlin.
      const text = out.replace(/\[(BLANK_AUDIO|MUSIC|NOISE)\]/gi, '').replace(/\s+/g, ' ').trim().replace(/\bMerlin\b/g, 'Myrlin');
      emit({ ev: 'transcript', reqId, paneId, text, ms: Date.now() - t0 });
      resolve();
    });
  });
}

/**
 * op voiceModel { action: 'status' | 'download' } -> ev voiceModel { state: 'ready' | 'missing' | 'downloading' | 'error', percent?, text }.
 * 'download' fetches the free English model into the voice folder (voice-model.js), one at a time, with a note in the
 * window at the start and the end; when it lands the window gets a fresh ready event so the mic button turns on.
 * The Mac app's menu item "Download Voice Model..." sends it; nothing downloads on its own.
 */
let voiceDownload = null;
function voiceModelOp(c = {}) {
  const status = (state, text, extra = {}) => emit({ ev: 'voiceModel', reqId: c.reqId ?? null, state, text, ...extra });
  if (voiceReady()) { status('ready', 'Voice is ready.'); return Promise.resolve(); }
  if (!fs.existsSync(whisperBin())) { status('error', `There is no speech program to run here (${whisperBin()}), so there is nothing to download a model for.`); return Promise.resolve(); }
  if (c.action !== 'download') { status('missing', `The voice model is not installed (${WHISPER_MODEL}). Apaki menu, Download Voice Model.`); return Promise.resolve(); }
  if (voiceDownload) { status('downloading', 'The voice model is already downloading.'); return voiceDownload; }
  emit({ ev: 'note', tone: 'info', text: 'Downloading the voice model (about 141 MB). The mic button turns on when it is done.' });
  let lastPct = -1;
  voiceDownload = downloadModel({
    file: WHISPER_MODEL,
    onProgress: (got, total) => {
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; status('downloading', `Downloading the voice model, ${pct}%`, { percent: pct }); }
    },
  }).then(() => {
    emit({ ev: 'note', tone: 'info', text: 'The voice model is installed. The mic button is on.' });
    status('ready', 'Voice is ready.');
    // A fresh ready event: the window turns the mic on from it (and asks for the session list again, which is cheap).
    emit({ ev: 'ready', version: APP_VERSION, billing: billingInfo(), model: defaults.model, effort: defaults.effort, mode: defaults.mode, pid: process.pid, voice: voiceReady(), artifacts: Boolean(openServer), codex: CODEX_FOUND, kimi: KIMI_FOUND });
  }).catch((e) => {
    emit({ ev: 'note', tone: 'warn', text: e.message });
    status('error', e.message);
  }).finally(() => { voiceDownload = null; });
  return voiceDownload;
}

/* ---------- git worktrees (worktrees.js; design apaki/remote/WORKTREES.md, 2026-10-12) ---------- */

// Every repository a session or an open pane ran in, with its worktrees: branch, lines changed against the base,
// ahead and behind. Re-read every 30 s while somebody is looking and shortly after a turn ends (files changed);
// Apaki's note of what each worktree was made from lives in ~/.claude/latch/apaki-worktrees.json (WtMeta).
//   op worktrees { cwd?, full?, refresh? } -> ev worktrees { repos } (also sent to every window and phone when it changes)
//   op worktreeDiff { path, scope? } -> ev worktreeDiff { path, branch, base, files: [{ path, status, added, removed, patch }] }
//   op worktreePlan { kind, ...args } -> ev worktreePlan { commands, blockers, warnings, data }: what an action will do, run by nobody
//   op worktreeRun { kind, ...args } -> ev worktreeResult { ok, error, log }: plans again, refuses with a blocker, else runs it
//   op worktreeTerminal { path }: a terminal in the folder (the window only; a phone cannot open windows on the PC)
// kind: create, remove, commit, push, pr, merge. A phone may read (worktrees, worktreeDiff) at any access level and
// plan or run only with Full access (remote-policy.js).
//
// Less often, and off this thread (2026-10-15; measured on Arthur's PC: 4 of 8 panes working, the engine at 93% of a
// core, 84% of a profile in process creation, about 80 git processes in 2 s):
//   - every git process, the file reads that count untracked lines, the diff, plans and actions run on a worker thread
//     (worktrees-client.js, worktrees-worker.js); repoOf and knownPath answer here from the last snapshot;
//   - a turn that ended marks only its own worktree changed (wtSoon with its folder): the next pass reads that
//     repository's list and refs and that worktree, and keeps every other record (before, every repository was read again);
//   - the 30 s refresh looks again at repositories with an open pane or one a window or phone asked about in the last
//     few minutes (WT_ASKED_HOT_MS); any other keeps its record for minutes (worktrees.js COLD_TTL_MS);
//   - looking again costs one status per worktree whose fingerprint did not move (worktrees.js statusPrint).
// APAKI_WT_INLINE=1 runs it on this thread as before (a way back if a worker ever misbehaves).
const wtIndex = new WorktreeIndexClient({ log: (line) => process.stderr.write(`apaki: ${line}\n`), inline: process.env.APAKI_WT_INLINE === '1' });
/** Folders asked about by name (the New worktree sheet's repository), so the next refresh still lists them. */
const wtExtra = new Set();
let wtSent = '';
let wtTimer = null;
let wtChain = Promise.resolve();
/** Folders where a turn ended since the last pass (wtSoon). */
const wtDirty = new Set();
/** Folders a window or phone asked about by name (worktrees with cwd, a diff), and when: their repositories stay hot a while. */
const wtAsked = new Map();
const WT_ASKED_HOT_MS = 3 * 60 * 1000;

/** The folders conversations are open in, desktop and phone. */
const paneCwds = () => [...panes.values()].map((p) => p.runner?.cwd).filter(Boolean);

/** A window or phone asked about this folder: its repository is looked at every refresh for a few minutes. */
function wtAsk(p) {
  if (!p) return;
  wtAsked.delete(p);
  wtAsked.set(p, Date.now());
  if (wtAsked.size > 40) wtAsked.delete(wtAsked.keys().next().value);
}

/** The folders whose repositories get fresh numbers every refresh: every pane's (Claude, Codex, console) and the ones asked about lately. */
function wtHot() {
  const now = Date.now();
  const out = [...panes.values()].map((p) => paneCwd(p)).filter(Boolean);
  for (const [p, at] of wtAsked) if (now - at < WT_ASKED_HOT_MS) out.push(p);
  return out;
}

/**
 * `load`: read the session list first when it is not loaded yet (a window or phone asked; the timer and "a turn ended"
 * never do: reading every session is the heavy part, and the list already comes with the window's own requests).
 */
let wtLoading = null;
async function wtRepos({ force = false, ask = null, full = false, load = false } = {}) {
  if (load && !state.items) await (wtLoading ||= loadSessions().catch(() => {}).finally(() => { wtLoading = null; }));
  if (ask) { wtExtra.add(ask); if (wtExtra.size > 40) wtExtra.delete(wtExtra.values().next().value); wtAsk(ask); }
  const open = paneCwds();
  const cwds = new Set([...(state.items || []).map((it) => it.cwd).filter(Boolean), ...open, ...wtExtra]);
  return wtIndex.snapshot({ cwds: [...cwds], stats: [...open, ...(ask ? [ask] : [])], full: full && ask ? [ask] : [], force, hot: wtHot() });
}

/** Sends the repositories: to whoever asked (reqId), otherwise to everyone, and only when something changed. */
async function sendWorktrees(c = {}) {
  const repos = await wtRepos({ force: c.refresh === true, ask: c.cwd || null, full: c.full === true, load: Boolean(c.reqId) });
  const ev = { ev: 'worktrees', reqId: c.reqId ?? null, repos };
  if (ev.reqId) { emit(ev); return; }
  const h = hashText(JSON.stringify(repos));
  if (h === wtSent) return;
  wtSent = h;
  emit(ev);
}

setInterval(() => { if (listening()) sendWorktrees().catch((e) => process.stderr.write(`apaki: worktrees: ${e.message}\n`)); }, 30 * 1000).unref();

/**
 * A turn ended or a pane opened in `cwd`: files there probably changed, so look again shortly. Only that worktree is
 * marked changed (2026-10-15: this used to forget every repository, so each turn end read them all again).
 */
function wtSoon(ms = 2500, cwd = null) {
  if (cwd) wtDirty.add(cwd);
  if (wtTimer) return;
  wtTimer = setTimeout(() => {
    wtTimer = null;
    const dirty = [...wtDirty];
    wtDirty.clear();
    // The marks reach the worker before the pass that reads them (its messages are handled in order).
    for (const c of dirty) wtIndex.changed(c).catch(() => {});
    if (listening()) sendWorktrees().catch(() => {});
  }, ms);
  wtTimer.unref?.();
}

/** The arguments a plan is made from: only the fields an action uses, whatever else the client sent. */
const wtArgs = (c) => ({
  path: c.path ? String(c.path) : '', branch: c.branch, base: c.base, useExisting: c.useExisting === true, deleteBranch: c.deleteBranch === true,
  message: c.message, paths: Array.isArray(c.paths) ? c.paths : undefined, title: c.title, body: c.body, draft: c.draft === true, into: c.into,
});

async function wtPlanFor(c, run) {
  const kind = String(c.kind || '');
  const where = String(kind === 'create' ? c.repo || c.path || '' : c.path || '');
  // The fresh record and the plan are made on the worker (2026-10-15): reading the repository is a dozen git processes.
  const { repo, plan } = await wtIndex.plan(kind, wtArgs(c), where, { run, openCwds: paneCwds() });
  return { repo, plan, where };
}

/** A plan as the window gets it: no steps (their folders are the engine's business), plus what the sheets need of the repository. */
function planEvent(reqId, plan, repo) {
  const { steps, ...rest } = plan;
  return { ev: 'worktreePlan', reqId, ...rest, repo: repo ? { root: repo.root, name: repo.name, base: repo.base, branches: repo.branches, remote: repo.remote } : null };
}

/**
 * What Apaki remembers after an action: the base a new worktree came from, and forgetting a removed one. Done on the
 * worker since 2026-10-15 (worktrees.js remember), where the notes file is read, so the numbers use the new base at once.
 */
async function wtAfter(plan) {
  await wtIndex.after(plan);
}

const wtDone = (plan, r) => ({
  create: `Made ${plan.data.branch} in its own folder.`,
  remove: 'Removed the worktree.',
  commit: `Committed ${plan.data.files?.length === 1 ? '1 file' : `${plan.data.total || plan.data.files?.length || 0} files`} on ${plan.data.branch || 'HEAD'}.`,
  push: `Pushed ${plan.data.branch}.`,
  pr: r.url ? 'Opened the pull request.' : 'Pushed, and asked GitHub for the pull request.',
  merge: `Merged ${plan.data.branch} into ${plan.data.into}.`,
}[plan.kind] || 'Done.');

/** Runs one action, one at a time: two commits or a commit and a remove in a repository must not interleave. */
function wtRunOp(c) {
  const job = wtChain.then(async () => {
    try {
      const { repo, plan, where } = await wtPlanFor(c, true);
      if (!repo || plan.blockers.length) {
        emit({ ev: 'worktreeResult', reqId: c.reqId, kind: plan.kind, ok: false, error: plan.blockers[0] || 'Nothing to do.', blockers: plan.blockers, commands: plan.commands });
        return;
      }
      const r = await wtIndex.execute(plan);
      if (r.ok) await wtAfter(plan);
      // Only the repository the action ran in is read again (by its main checkout, which a removed worktree cannot take along).
      await wtIndex.invalidate(repo.root || where).catch(() => {});
      emit({ ev: 'worktreeResult', reqId: c.reqId, kind: plan.kind, ok: r.ok, error: r.error || null, log: r.log, url: r.url || null, path: plan.data.path || null, branch: plan.data.branch || null, message: r.ok ? wtDone(plan, r) : null, commands: plan.commands });
      sendWorktrees({}).catch(() => {});
    } catch (e) {
      emit({ ev: 'worktreeResult', reqId: c.reqId, kind: String(c.kind || ''), ok: false, error: e.message || String(e), commands: [] });
    }
  });
  wtChain = job.catch(() => {});
  return job;
}

/* ---------- command loop ---------- */

const handlers = {
  // From the Apaki shell, not the window: its hello, and answers to our requests (shell-channel.js).
  shellHello: (c) => shell.hello(c),
  shellReply: (c) => { shell.reply(c); },
  // One of Claude's browser tools, run for a pane without a model turn (checks; later the phone).
  browserTool: async (c) => {
    const p = getPane(c.paneId);
    const b = toolsFor(p).browser;
    const r = b ? await b.call(String(c.tool || ''), c.input || {}) : { ok: false, text: 'This window has no built-in browser.' };
    emit({ ev: 'browserToolResult', reqId: c.reqId, paneId: p.id, tool: c.tool, ok: r.ok, text: r.text, image: r.image || null, width: r.width || null, height: r.height || null });
  },
  // What a phone sees of the page this pane's Claude opened in the built-in browser (2026-10-12, remote-policy.js
  // browserView): one quiet JPEG of the part in view and the page's address, title and loading state. Read only; the
  // phone refreshes it when a browserActivity line arrives. Only the pane's own browser (the shell finds it by owner).
  // tab: a phone may look at another tab of its own conversation's browser; browser-tools.js checks that it is one of the pane's.
  browserView: async (c) => {
    const p = getPane(c.paneId);
    const b = toolsFor(p).browser;
    const r = b ? await b.view({ tab: typeof c.tab === 'string' ? c.tab : null }) : { ok: false, text: 'This PC has no built-in browser right now.' };
    emit({ ev: 'browserView', reqId: c.reqId, paneId: p.id, ok: Boolean(r.ok), text: r.ok ? '' : String(r.text || ''), state: r.state || null, image: r.image || null, mime: r.mimeType || null, width: r.width || null, height: r.height || null, at: Date.now(), tabs: r.tabs || null });
  },
  // The person picked a tab in the browser pane's tab strip (2026-10-12): Claude's browser tools act on that tab from now on.
  // Silent, and not in remote-policy.js PHONE_OPS: only the desktop window may switch the tool's tab this way.
  browserTab: async (c) => {
    // Only a conversation that is open here (a pick never makes an empty pane record).
    const p = panes.get(String(c.paneId || ''));
    if (p) await toolsFor(p).browser?.select(String(c.browserId || ''));
  },
  transcribe: (c) => transcribe(c.reqId, c.wav, c.paneId || null),
  voiceModel: (c) => voiceModelOp(c),
  sessions: (c) => sessions(c.reqId),
  search: (c) => search(c.reqId, String(c.query || '')),
  askSearch: (c) => askSearchOp(c.reqId, String(c.query || ''), c.paneId || null),
  digPrompt: (c) => digPromptOp(c.reqId, String(c.query || ''), Array.isArray(c.candidates) ? c.candidates : []),
  open: (c) => open(c.reqId, c.paneId, c.sessionId || null, c.cwd || null, { warm: c.warm, model: c.model, effort: c.effort, mode: c.mode, tune: c.tune, force: c.force, kind: c.kind }),
  attach: (c) => attach(c.reqId, c.paneId, c.sessionId || null, c.cwd || null),
  // A phone pane shows a desktop pane (the shared view): remote.js registered it and sends this once, after checkPhoneCommand.
  follow: (c) => followState(c),
  send: (c) => {
    const images = Array.isArray(c.images) ? c.images : [];
    peerMessage(c, String(c.text || ''), images, false);
    return send(c.reqId, c.paneId, String(c.text || ''), images);
  },
  close: (c) => closePane(c.reqId, c.paneId),
  // A Stop: the queue stays unsent after it (queue-hold.js), until the next message is sent.
  interrupt: (c) => { const p = getPane(c.paneId); p.userStopped = true; return isKimiPane(p) ? kimi.interrupt(p) : isCodexPane(p) ? codex.interrupt(p) : p.runner?.interrupt(); },
  // The window's queued messages, kept here so they can go out with no window connected (queue-hold.js).
  // Never for a phone pane: remote-policy.js does not let a phone send it, and phone queues stay window-side.
  queueSet: (c) => {
    const p = panes.get(String(c.paneId || ''));
    if (p && !parsePhoneId(p.id)) setHeld(p, c.items);
  },
  // The context meter on demand (the window asks when a pane comes into view or its meter is clicked).
  contextUsage: async (c) => {
    const p = panes.get(String(c.paneId || ''));
    if (!p) { emit({ ev: 'context', reqId: c.reqId, paneId: c.paneId, none: true }); return; }
    if (isCodexPane(p)) { codex.sendContext(p, c.reqId || null); return; }
    await sendContext(p, c.reqId || null).catch(() => emit({ ev: 'context', reqId: c.reqId, paneId: c.paneId, none: true }));
  },
  // Steer: add a message to the running turn without stopping it (Claude
  // Code takes it in at its next step). If the turn already ended, it goes
  // out as a normal message instead.
  steer: async (c) => {
    const p = getPane(c.paneId);
    if (isCodexPane(p)) { await codex.steer(c, p); return; }
    const images = Array.isArray(c.images) ? c.images : [];
    const text = String(c.text || '');
    const content = images.length
      ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), ...(text ? [{ type: 'text', text }] : [])]
      : text;
    if (p.runner?.steer(content, { busy: Boolean(p.busy) })) {
      // Steered in from another window of this pane (the shared view): it draws it too ("Steered in"); the sender answers below.
      peerMessage(c, text, images, true);
      emit({ ev: 'steered', reqId: c.reqId, paneId: p.id, qid: c.qid });
      return;
    }
    // Why it could not be taken in, in the engine log (2026-10-11: a steer that went out only after the turn ended).
    const r = p.runner;
    process.stderr.write(`apaki: steer missed in pane ${p.id}: runner ${r ? 'yes' : 'none'}, process ${r?.running ? 'up' : 'down'}, pending ${r?.pending?.length ?? 0}, turn ${r?.turnActive ? 'active' : 'idle'}, pane busy ${Boolean(p.busy)}\n`);
    emit({ ev: 'steer_missed', reqId: c.reqId, paneId: p.id, qid: c.qid });
  },
  // A question, plan approval or permission prompt is settled once: the entry leaves the map first, so a second answer finds nothing.
  // A permission prompt turns the reply into the SDK's result itself (permissions.js answer), never trusting rules or input from it.
  answer: (c) => {
    const a = state.asks.get(c.askId);
    state.asks.delete(c.askId);
    if (a?.answer) a.answer(c.result || null); else a?.resolve(c.result || null);
    // The first answer wins (2026-10-11, the shared view): the question may be on screen in the window and on phones that follow
    // its pane, so whoever did not answer has its sheet taken away the way a stale question's is (ask_gone). Nothing extra is sent
    // for a pane nobody else watches, so the window's own answers behave as before.
    // why/by (2026-10-12, askcard.js): the other side's card leaves "Answered on <phone>." or "Answered on the PC."
    if (a && (c.follower || remote?.followerNames?.(a.paneId)?.length)) emit({ ev: 'ask_gone', askId: c.askId, paneId: a.paneId, why: 'answered', by: typeof c.follower === 'string' && c.follower ? c.follower : 'the PC' });
  },
  model: async (c) => {
    const p = getPane(c.paneId);
    // A Codex pane's model is one of Codex's (op codexModels); it never becomes the default for new Claude panes.
    if (isCodexPane(p)) { await codex.setModel(p, String(c.model || '')); return; }
    p.model = c.model; if (!parsePhoneId(p.id)) defaults.model = c.model;
    await p.runner?.setModel(c.model);
    emit(paneSettings(p));
    // A model that cannot run Ultracode (or lacks the effort) changes what the process will really apply: say so (tuneCheck).
    await tuneCheck(p);
  },
  mode: async (c) => {
    const p = getPane(c.paneId);
    // A Codex pane's modes are the Codex app's presets (read-only, auto, full-access); a phone takes those its access allows.
    if (isCodexPane(p)) {
      if (!codex.setMode(p, String(c.mode || '')) && parsePhoneId(p.id)) emit({ ev: 'error', reqId: c.reqId, paneId: p.id, message: capModeText(phoneCap(p.id), c.mode), refused: true });
      return;
    }
    // A phone pane takes only the modes its phone's access allows (remote-policy.js refuses others first; this holds anyway).
    if (parsePhoneId(p.id) && !capModes(phoneCap(p.id)).includes(c.mode)) {
      emit({ ev: 'error', reqId: c.reqId, paneId: p.id, message: capModeText(phoneCap(p.id), c.mode), refused: true });
      emit(paneSettings(p));
      return;
    }
    p.mode = c.mode; if (!parsePhoneId(p.id)) defaults.mode = c.mode;
    await p.runner?.setPermissionMode(c.mode);
    emit(paneSettings(p));
  },
  effort: async (c) => {
    const p = getPane(c.paneId);
    if (isCodexPane(p)) { codex.setEffort(p, String(c.effort || '')); return; }
    const prev = { effort: p.effort, ...claudeTune(p.tune) };
    p.effort = c.effort; if (!parsePhoneId(p.id)) defaults.effort = c.effort;
    if (p.runner?.running) {
      // Live (2026-10-13): the SDK's flag settings take the new level at once, with Ultracode kept on (it would go off on a bare
      // effort change: tune.js liveSettings sends both keys). A Claude Code that will not take the call restarts as it always did.
      const flags = liveSettings(prev, { effort: p.effort, ...claudeTune(p.tune) });
      p.runner.effort = c.effort;
      if (Object.keys(flags).length && !(await p.runner.applyFlags(flags))) await p.runner.restart({ effort: c.effort });
    } else if (p.runner) p.runner.effort = c.effort;
    emit(paneSettings(p));
    await tuneCheck(p);
  },
  // Ultracode and its workflow size (Claude Code), or the reasoning summary and speed (Codex): the settings beside effort.
  // They apply to a running process at once and are kept for the pane and, on the desktop, as the default for new panes.
  tune: async (c) => {
    const p = getPane(c.paneId);
    if (isCodexPane(p)) { codex.setTune(p, c); return; }
    const change = {};
    if ('ultracode' in c) change.ultracode = c.ultracode === true;
    if ('size' in c) change.size = c.size;
    // A phone below Full access never turns workflows on (remote-policy.js refuses first; this holds anyway).
    if (tuneRestricted(p) && change.ultracode === true) {
      emit({ ev: 'error', reqId: c.reqId, paneId: p.id, message: capTuneText(phoneCap(p.id)), refused: true });
      emit(paneSettings(p));
      return;
    }
    const prev = { effort: p.effort, ...claudeTune(p.tune) };
    p.tune = claudeChange(p.tune, change);
    if (!parsePhoneId(p.id)) defaults.tune = claudeTune(p.tune);
    if (p.runner?.running) {
      const flags = liveSettings(prev, { effort: p.effort, ...p.tune });
      if (Object.keys(flags).length && !(await p.runner.applyFlags(flags))) await p.runner.restart({});
    }
    emit(paneSettings(p));
    await tuneCheck(p);
  },
  billing: async (c) => {
    const p = getPane(c.paneId);
    const v = String(c.value || 'glass');
    const next = chooseCredential(v === 'sub' ? { subscription: true } : v === 'glass' ? {} : { keyWords: v });
    if (next.error) { emit({ ev: 'error', reqId: c.reqId, paneId: p.id, message: next.error }); return; }
    p.credential = next;
    defaults.credential = next;
    if (p.runner) {
      p.runner.authKey = next.key ?? null;
      p.runner.authCheck = next.follow ? () => { const g = glassCredential(); return { ...g, env: childEnv(g.key) }; } : null;
      if (p.runner.running) await p.runner.restart({ env: childEnv(next.key) });
      else p.runner.env = childEnv(next.key);
    }
    billingChanged(p); emit({ ev: 'billing', paneId: p.id, ...billingInfo(p) });
  },
  // Where a new conversation starts (ui/startfolder.js, src/places.js).
  // The Codex scan takes ~2 s the first time, so the Claude Code lists go out first.
  places: async (c) => {
    if (!state.items) await loadSessions();
    const claude = state.items.filter((it) => !it.codex);
    if (!state.codexPlaces) {
      emit({ ev: 'places', reqId: c.reqId, ...folderStats(claude, { codex: false, limit: 6 }) });
      await new Promise((r) => setTimeout(r, 30));
    }
    emit({ ev: 'places', reqId: c.reqId, ...folderStats(claude, { limit: 6 }) });
    state.codexPlaces = true;
  },
  listDir: (c) => emit({ ev: 'dir', reqId: c.reqId, ...listDir(c.path || os.homedir()) }),
  mkdir: (c) => {
    const r = makeDir(c.path, c.name);
    emit(r.error ? { ev: 'dir', reqId: c.reqId, ...listDir(c.path), error: r.error, kind: 'mkdir' } : { ev: 'dir', reqId: c.reqId, ...listDir(r.path), created: r.path });
  },
  // /warm on|off|status: keep prompt caches warm between messages (src/warm.js).
  warm: async (c) => {
    const v = String(c.arg || '').trim().toLowerCase();
    const p = c.paneId ? panes.get(String(c.paneId)) : null;
    if (v === 'on' || v === 'off') {
      setWarm(v === 'on');
      // Register this pane's session at once if it already ran a turn on a key.
      if (v === 'on' && p?.runner?.lastResult) noteRunnerUse(p.runner, p.runner.lastResult);
    }
    const text = v && v !== 'on' && v !== 'off' && v !== 'status' ? 'Use /warm on, /warm off or /warm' : await warmStatus();
    emit({ ev: 'note', paneId: c.paneId || null, text });
  },
  // The Settings sheet's keep-warm switch: the state, and on/off without a note in a pane.
  warmState: (c) => {
    if (c.on === true || c.on === false) setWarm(c.on);
    emit({ ev: 'warmState', reqId: c.reqId, ...warmSummary() });
    refreshWarm();
  },
  // The Settings sheet's "Free hidden conversations": minutes a tab can be hidden and idle before its conversation lets go of its
  // Claude Code process (0 is off); read, or set with value. Kept with the other settings. Not a phone op (remote-policy.js).
  releaseHidden: (c) => {
    if (c.value !== undefined) {
      prefs = { ...prefs, releaseHiddenMin: normalizeRelease(c.value) };
      savePrefs(PREFS_FILE, prefs);
    }
    emit({ ev: 'releaseHidden', reqId: c.reqId, value: prefs.releaseHiddenMin, choices: RELEASE_CHOICES, standard: RELEASE_DEFAULT });
  },
  // The Settings sheet's "Auto-compact at": the choice (read, or set with value), kept in ~/.claude/latch/apaki-settings.json.
  // It reaches Claude Code processes as they next start; a conversation already running keeps what it began with.
  autoCompact: (c) => {
    if (c.value !== undefined) {
      prefs = { ...prefs, autoCompact: normalizeCompact(c.value) };
      savePrefs(PREFS_FILE, prefs);
    }
    emit({ ev: 'autoCompact', reqId: c.reqId, value: prefs.autoCompact, choices: COMPACT_CHOICES, standard: COMPACT_DEFAULT });
  },
  /* ---------- subagents, shells, monitors (tasks.js; the window's tasks panel and viewers) ---------- */

  // A session's subagents and shell outputs on disk, for the rail and the tasks panel.
  subagents: (c) => {
    const id = String(c.sessionId || '');
    const file = transcriptMap().get(id);
    const agents = file ? listSubagents(file).map(({ file: _f, ...a }) => a) : [];
    const shells = file ? listShells(file).map(({ file: _f, ...s }) => s) : [];
    emit({ ev: 'subagents', reqId: c.reqId, sessionId: id, agents, shells });
  },
  // Stop one task of a conversation running here (Claude Code's own stop: a task_notification "stopped" follows).
  taskStop: async (c) => {
    const p = getPane(c.paneId);
    if (!p.runner?.q) throw new Error('That conversation is not running here, so its tasks cannot be stopped from Apaki.');
    await p.runner.q.stopTask(String(c.taskId));
  },
  // Ctrl+B: move a foreground subagent or shell to the background so the turn goes on.
  taskBackground: async (c) => {
    const p = getPane(c.paneId);
    if (!p.runner?.q) throw new Error('That conversation is not running here.');
    const ok = await p.runner.q.backgroundTasks(c.toolUseId ? String(c.toolUseId) : undefined);
    if (!ok) emit({ ev: 'note', paneId: p.id, text: 'Nothing to move to the background.' });
  },
  // The end of a running shell's output (the 8 KB /tasks shows), polled by its viewer.
  taskOutput: async (c) => {
    const owner = panes.get(String(c.ownerPane || ''));
    let r = null;
    try { r = owner?.runner?.q ? await owner.runner.q.getTaskOutput(String(c.taskId)) : null; } catch (e) { r = { error: e.message }; }
    emit({ ev: 'taskOutput', paneId: String(c.paneId), taskId: c.taskId, output: r?.output ?? null, error: r?.error || (r ? null : 'not running here') });
  },
  // A viewer following a subagent's transcript as it grows.
  agentWatch: (c) => watchAgent(String(c.paneId), String(c.sessionId || ''), c.agentId ? String(c.agentId) : null, c.toolUseId ? String(c.toolUseId) : null),
  // A viewer following a shell or Monitor output file.
  outputWatch: (c) => watchOutput(String(c.paneId), String(c.sessionId || ''), String(c.taskId || '')),
  unwatch: (c) => unwatchViewer(String(c.paneId)),

  /* ---------- the workspace, saved to disk as well (crash recovery) ---------- */
  saveState: (c) => { saveWorkspace(c.state); sendDesktopTabs(c.state); },
  loadState: (c) => emit({ ev: 'state', reqId: c.reqId, state: loadWorkspace() }),

  // A name for a session, saved the way Claude Code's /rename saves it (a
  // custom-title entry in its transcript), so Claude Code, latch and Apaki
  // all show the same one.
  rename: async (c) => {
    const id = String(c.sessionId || '');
    const title = String(c.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!id || !title) { emit({ ev: 'renamed', reqId: c.reqId, paneId: c.paneId || null, sessionId: id, ok: false, message: 'A name needs some text.' }); return; }
    // A Codex thread is named by Codex itself (thread/name/set), so the Codex app shows the same name.
    if (isCodexId(id)) {
      try { await codex.rename(threadIdOf(id), title); emit({ ev: 'renamed', reqId: c.reqId, paneId: c.paneId || null, sessionId: id, title, ok: true }); } catch (e) { emit({ ev: 'renamed', reqId: c.reqId, paneId: c.paneId || null, sessionId: id, ok: false, message: e.message || String(e) }); }
      return;
    }
    await applyRename(id, title, { reqId: c.reqId, paneId: c.paneId || null });
  },
  // The footer's Glass card: read again now, or switch an account (Arthur picked it, so --user-asked).
  glass: (c) => (c.refresh
    ? new Promise((resolve) => execFile(GLASS_CLI, ['refresh', '--json'], { timeout: 30000, windowsHide: true }, () => resolve())).then(() => glassChanged())
    : glassChanged()),
  glassProviders: async (c) => {
    try {
      const settings = await glassProviderSettings(GLASS_CLI, c, execFile);
      glassReadVersion += 1;
      lastGlassStatus = { ...(lastGlassStatus || {}), ...settings };
      emit({ ev: 'glass_providers', reqId: c.reqId, ok: true, ...settings });
      await glassChanged();
    } catch (error) {
      emit({ ev: 'glass_providers', reqId: c.reqId, ok: false, message: error.message });
    }
  },
  glassSwap: (c) => new Promise((resolve) => {
    const provider = glassProvider(c);
    // No Glass on this PC (2026-10-10): say so instead of "spawn ... ENOENT".
    if (!fs.existsSync(GLASS_CLI)) { emit({ ev: 'glass_swap', reqId: c.reqId, provider, account: c.account, ok: false, message: GLASS_MISSING, detail: '' }); resolve(); return; }
    const args = ['swap', provider, String(c.account || ''), '--reason', 'Picked in Myrlin Apaki', '--requester', 'myrlin-apaki', '--user-asked', '--json'];
    execFile(GLASS_CLI, args, { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = null;
      try { out = JSON.parse(stdout); } catch { out = null; }
      const ok = !err && out?.ok !== false && !out?.error;
      const message = ok ? '' : String(out?.message || out?.error || stderr || err?.message || 'Glass could not switch').trim().split('\n')[0].slice(0, 240);
      emit({ ev: 'glass_swap', reqId: c.reqId, provider, account: c.account, ok, message, detail: out?.message || '' });
      glassChanged().catch(() => {}).finally(resolve);
    });
  }),
  /* ---------- managing Glass accounts from the Glass panel (2026-10-10) ---------- */
  // Rename: a subscription in Workbook (its owner), an API key in Glass. Hide/show: Glass only, nothing deleted.
  glassRename: (c) => glassOp(c, ['rename', glassProvider(c), String(c.account || ''), String(c.name || '').slice(0, 60)]),
  glassHide: (c) => glassOp(c, [c.hidden === false ? 'unhide' : 'hide', glassProvider(c), String(c.account || '')]),
  // Reconnect an account (its email) or add a new one: a browser sign-in a person finishes.
  glassLogin: (c) => c.provider === 'kimi'
    ? emit({ ev: 'glass_op', reqId: c.reqId, op: c.op, provider: 'kimi', ok: true, message: KIMI_LOGIN_HINT })
    : glassOp(c, ['login', glassProvider(c), ...(c.email ? [String(c.email)] : [])]),
  // A Console org's API credits: the keys go to Glass on stdin only, never on a command line.
  glassApiAdd: (c) => glassOp(c, ['api', 'add', '--label', String(c.label || '').trim(), '--credit', String(Number(c.credit) || 200), '--reset-day', String(Number(c.resetDay) || 1)],
    `${String(c.adminKey || '').trim()}\n${String(c.usageKey || '').trim()}\n`),
  glassApiRemove: (c) => glassOp(c, ['api', 'remove', String(c.label || '')]),
  // Signing in to Claude on a PC that has no login yet (2026-10-10, see authStatus / signIn).
  authStatus: (c) => authStatus(c.reqId || null),
  signIn: (c) => signIn(c.reqId || null, Boolean(c.console)),
  billingOptions: (c) => emit({
    ev: 'billingOptions', reqId: c.reqId, paneId: c.paneId || null,
    options: [
      { label: 'Follow Myrlin Glass', value: 'glass' },
      { label: 'Subscription (live login)', value: 'sub' },
      ...keySections().map((s) => { const label = s.heading.replace(/\s+-\s+added\s+\S+\s*$/i, '').replace(/^Anthropic API Key\s*\((.*)\)$/i, '$1'); return { label, value: label }; }),
    ],
  }),
  // Codex (2026-10-12, codex-panes.js): the model list with each model's own efforts and the account line (model/list),
  // and the Codex threads on this PC for the list's Codex view (thread/list). Both start the app-server on first use.
  codexModels: (c) => codex.models(c.reqId || null),
  // A file this Codex pane changed, in the viewer (the patch line's file name; codex-panes.js openFile checks the path).
  codexOpenFile: async (c) => {
    const p = panes.get(String(c.paneId || ''));
    if (p && isCodexPane(p)) await codex.openFile(c, p);
  },
  codexThreads: async (c) => { await codex.list({ refresh: c.refresh === true, reqId: c.reqId || null }); },
  // Commands come from a running Claude Code process. A pane that has not
  // started yet (restored, waiting for its first message) gets the list last
  // seen for its folder instead of starting a process just for the menu.
  commands: async (c) => {
    const p = getPane(c.paneId);
    const shape = (list) => list.map((x) => ({ name: x.name, description: x.description || '', argumentHint: x.argumentHint || '' }));
    if (isCodexPane(p)) { emit({ ev: 'commands', reqId: c.reqId, paneId: p.id, commands: await codex.commandsFor(p).catch(() => codex.commands()) }); return; }
    if (!p.runner) { emit({ ev: 'commands', reqId: c.reqId, paneId: p.id, commands: [] }); return; }
    if (!p.runner.running) {
      const cached = state.commandsByCwd.get(p.runner.cwd) || [...state.commandsByCwd.values()][0] || [];
      emit({ ev: 'commands', reqId: c.reqId, paneId: p.id, commands: cached, cached: true });
      return;
    }
    // The runner is kept here: a takeover can stop the pane while this waits.
    const runner = p.runner;
    const list = shape(await runner.supportedCommands().catch(() => []));
    if (list.length) state.commandsByCwd.set(runner.cwd, list);
    emit({ ev: 'commands', reqId: c.reqId, paneId: p.id, commands: list });
  },
  // One artifact revision for the viewer and (later) the phone: its record, a
  // served address, and the content unless content:false (the viewer loads
  // html, images and pdf from src and only needs the text of markdown and code).
  artifactGet: (c) => {
    const got = store.get(c.id, { sessionId: c.sessionId || null, rev: c.rev ?? null });
    if (!got) { emit({ ev: 'artifactContent', reqId: c.reqId, paneId: c.paneId || null, id: c.id, sessionId: c.sessionId || null, error: 'This artifact is no longer on this PC.' }); return; }
    const rec = got.record;
    // The revision's own kind (2026-10-13: each revision records it; older records fall back to the extension).
    const kind = got.kind || (got.rev === rec.rev ? rec.kind : kindOfExt(got.ext));
    // Workbooks and Word documents are bytes too (2026-10-13), drawn in the window from base64 (SheetJS, mammoth).
    const binary = kind === 'image' || kind === 'pdf' || kind === 'sheet' || kind === 'docx';
    // content: 'text' = only what the viewer draws itself (text, and since 2026-10-13 workbooks and Word documents);
    // false = never; default = always (the phone). Images and PDFs load from src on the desktop.
    const want = c.content === 'text' ? (kind !== 'image' && kind !== 'pdf') : c.content !== false;
    emit({
      ev: 'artifactContent', reqId: c.reqId, paneId: c.paneId || null, id: rec.id, sessionId: rec.sessionId, title: (rec.revs.find((r) => r.rev === got.rev) || rec).title,
      kind, ext: got.ext, mime: got.mime, rev: got.rev, latest: rec.rev, size: got.buf.length, src: srcOf(rec, got.rev), path: got.file, source: rec.source,
      revs: revsOut(rec), lang: got.lang || null, by: got.by || 'session',
      ...(want ? { encoding: binary ? 'base64' : 'utf8', content: binary ? got.buf.toString('base64') : got.buf.toString('utf8') } : {}),
    });
  },
  // Download (2026-10-13, the viewer's toolbar): one revision's file, or what the viewer made of it (a filtered table as
  // CSV, a chart as PNG or SVG: data + encoding + name), saved in Downloads under a free name and shown in Explorer, like
  // Export as Markdown. PC only (remote-policy.js PC_ONLY_OPS): a phone saves on the phone, never a file on the PC.
  artifactSave: async (c) => {
    const base = { ev: 'artifactSaved', reqId: c.reqId || null, paneId: c.paneId || null };
    try {
      let buf;
      let name;
      if (typeof c.data === 'string') {
        buf = c.encoding === 'base64' ? Buffer.from(c.data, 'base64') : Buffer.from(c.data, 'utf8');
        name = String(c.name || 'artifact.txt');
      } else {
        const got = store.get(c.id, { sessionId: c.sessionId || null, rev: c.rev ?? null });
        if (!got) throw new Error('This artifact is no longer on this PC.');
        buf = got.buf;
        name = c.name ? String(c.name) : fileNameFor({ title: (got.record.revs.find((r) => r.rev === got.rev) || got.record).title, ext: got.ext });
      }
      if (buf.length > ARTIFACT_MAX_BYTES) throw new Error('It is too big to save from here.');
      const file = freePath(exportDir(), saveName(name));
      await fs.promises.writeFile(file, buf);
      emit({ ...base, ok: true, name: path.basename(file), path: file });
      revealFile(file);
    } catch (e) {
      emit({ ...base, ok: false, message: `Could not save it: ${e.message || e}` });
    }
  },
  // Edit and send back (2026-10-13, the canvas): the user's version of a Markdown or text artifact becomes a new revision
  // marked as theirs (store.edit). The conversation that showed it gets the artifact event (its card says "Edited by
  // you"); the session reads it with view_read and hears about it with the user's next message (apaki-tools.js). Nothing
  // is sent to the session by itself. PC only (remote-policy.js PC_ONLY_OPS says why a phone may not).
  artifactEdit: (c) => {
    const base = { ev: 'artifactEdited', reqId: c.reqId || null, paneId: c.paneId || null, id: c.id || null };
    try {
      const sid = String(c.sessionId || '');
      if (!sid) throw new Error('This artifact has no conversation.');
      const rec = store.edit(sid, c.id, { content: c.content, baseRev: Number.isInteger(c.baseRev) ? c.baseRev : null, force: c.force === true });
      emit({ ...base, ok: true, rev: rec.rev, sessionId: rec.sessionId });
      // The conversation's pane draws the card (pane.js onArtifact); the viewer shows the new revision.
      const owner = panes.get(String(c.sourcePane || '')) || { id: String(c.sourcePane || c.paneId || '') };
      emit(artifactEvent(owner, rec, { via: 'user-edit' }));
    } catch (e) {
      emit({ ...base, ok: false, message: e.message || String(e), stale: e.code === 'stale', rev: e.rev ?? null });
    }
  },
  artifactList: (c) => emit({
    ev: 'artifacts', reqId: c.reqId, sessionId: c.sessionId || null,
    items: c.sessionId ? store.list(c.sessionId).map((r) => ({ id: r.id, title: r.title, kind: r.kind, rev: r.rev, ext: r.ext, size: r.size, updatedAt: r.updatedAt, src: srcOf(r) })) : [],
  }),
  // Did this pane's conversation move on without it? historyCheck { paneId, sessionId, rev } -> history with
  // refresh: true when the transcript changed, then historyChecked { fresh } either way (the pane may wait on it
  // before a send). Read only; a phone may ask for its own panes (remote-policy.js).
  historyCheck: async (c) => {
    const p = panes.get(String(c.paneId || ''));
    if (p && isCodexPane(p)) { await codex.historyCheck(c, p); return; }
    const base = { ev: 'historyChecked', reqId: c.reqId || null, paneId: c.paneId || null };
    const sessionId = p?.sessionId || null;
    if (!p || !sessionId || (c.sessionId && c.sessionId !== sessionId)) { emit({ ...base, sessionId: c.sessionId || null, fresh: true }); return; }
    // The pane that holds the session writes it: its stream is the newest there is.
    if (p.runner && p.runner.running) { emit({ ...base, sessionId, fresh: true }); return; }
    const rev = await historyRevOf(sessionId);
    if (!rev || rev === c.rev) { emit({ ...base, sessionId, fresh: true }); return; }
    await sendHistory(p, sessionId, { refresh: true });
    emit({ ...base, sessionId, fresh: false, rev });
  },
  /* ---------- the rest of a conversation's history (history.js, 2026-10-10) ---------- */
  // Read only, and only the session open in that pane (whatever session the command names), so a
  // phone can page through its own conversations and nothing else (remote-policy.js allows both).
  // historyBefore { paneId, sessionId?, before, limit?, all? } -> historyPage { messages, total, hasMore, first, earlier }
  historyBefore: async (c) => {
    const p = panes.get(String(c.paneId || ''));
    if (p && isCodexPane(p)) { await codex.historyBefore(c, p); return; }
    const base = { ev: 'historyPage', reqId: c.reqId || null, paneId: c.paneId || null, before: c.before || null };
    if (!p?.sessionId || (c.sessionId && c.sessionId !== p.sessionId)) { emit({ ...base, sessionId: c.sessionId || null, error: 'That conversation is not open in this pane.' }); return; }
    if (!c.before) { emit({ ...base, sessionId: p.sessionId, error: 'Which message to load before is missing.' }); return; }
    const limit = Math.min(5000, Math.max(1, Math.floor(Number(c.limit)) || HISTORY_PAGE));
    // until: a prompt picked in the pane's list that is not loaded yet; the page reaches back to it (2026-10-12).
    const page = await historyStore.pageBefore(p.sessionId, String(c.before), { limit, all: c.all === true, until: typeof c.until === 'string' ? c.until : null }).catch(() => null);
    if (!page) { emit({ ...base, sessionId: p.sessionId, error: 'The rest of this conversation cannot be read from its transcript.' }); return; }
    emit({ ...base, sessionId: p.sessionId, ...page });
  },
  // Every prompt you typed in the conversation open in a pane, oldest first (2026-10-12, the pin's list of your prompts;
  // history.js promptOf decides what a prompt is, the same rule the pane draws by). Read only, like historyBefore.
  // historyPrompts { paneId, sessionId? } -> historyPrompts { prompts: [{ id, text, at, images }], total } | { error }
  historyPrompts: async (c) => {
    const p = panes.get(String(c.paneId || ''));
    if (p && isCodexPane(p)) { await codex.prompts(c, p); return; }
    const base = { ev: 'historyPrompts', reqId: c.reqId || null, paneId: c.paneId || null };
    if (!p?.sessionId || (c.sessionId && c.sessionId !== p.sessionId)) { emit({ ...base, sessionId: c.sessionId || null, error: 'That conversation is not open in this pane.' }); return; }
    const r = await historyStore.prompts(p.sessionId).catch(() => null);
    if (!r) { emit({ ...base, sessionId: p.sessionId, error: 'The prompts of this conversation cannot be read from its transcript.' }); return; }
    emit({ ...base, sessionId: p.sessionId, ...r });
  },
  // One cut tool result, thinking block, summary or image in full, from its own line of the transcript.
  // historyBlock { paneId, sessionId?, ref } -> historyBlock { ref, kind: 'text', text, length, cut } | { kind: 'image', media_type, data, bytes } | { error }
  historyBlock: async (c) => {
    const p = panes.get(String(c.paneId || ''));
    const base = { ev: 'historyBlock', reqId: c.reqId || null, paneId: c.paneId || null, ref: c.ref || null };
    // Codex pages carry every block whole (codex-map.js cuts output at 20,000 characters, with no reference to fetch more).
    if (p && isCodexPane(p)) { emit({ ...base, sessionId: p.sessionId, error: 'That part of a Codex conversation is already shown whole.' }); return; }
    if (!p?.sessionId || (c.sessionId && c.sessionId !== p.sessionId)) { emit({ ...base, sessionId: c.sessionId || null, error: 'That conversation is not open in this pane.' }); return; }
    const r = await historyStore.block(p.sessionId, c.ref).catch((e) => ({ error: e.message || String(e) }));
    emit({ ...base, sessionId: p.sessionId, ...r });
  },
  openExternal: (c) => {
    if (c.url) {
      if (!/^https?:\/\/[^\s"'<>]+$/i.test(String(c.url))) { emit({ ev: 'error', reqId: c.reqId, paneId: c.paneId || null, message: `Not a web address: ${c.url}` }); return; }
      openOutside(String(c.url));
      return;
    }
    const got = c.id ? store.get(c.id, { sessionId: c.sessionId || null, rev: c.rev ?? null }) : null;
    if (got) openOutside(got.file);
  },
  /* ---------- the session list's right-click menu (2026-10-10) ---------- */
  // Arthur: right-click a session to "stop" it "among other things (think of what codex and claude
  // desktop would let you do)". Stop any turn this engine runs for a session, wherever its pane is.
  stopSession: (c) => {
    let n = 0;
    for (const p of panes.values()) {
      if (isKimiPane(p) && p.sessionId === c.sessionId && p.busy) { p.userStopped = true; kimi.interrupt(p); n += 1; continue; }
      if (isCodexPane(p) && p.sessionId === c.sessionId && p.busy) { p.userStopped = true; codex.interrupt(p); n += 1; continue; }
      if (p.sessionId !== c.sessionId || !(p.runner?.turnRunning || p.runner?.turnActive)) continue;
      p.userStopped = true;
      p.runner.interrupt();
      n += 1;
    }
    emit({ ev: 'note', paneId: null, reqId: c.reqId, text: n ? 'Stopping it.' : 'Nothing of it is running in Apaki.' });
  },
  // Fork: a new session with this one's conversation so far (fresh ids; the original is untouched).
  forkSession: async (c) => {
    try {
      const r = isCodexId(c.sessionId) ? { sessionId: await codex.fork(threadIdOf(c.sessionId)) } : await forkSession(String(c.sessionId));
      emit({ ev: 'forked', reqId: c.reqId, from: c.sessionId, sessionId: r.sessionId });
      await sessions(null);
    } catch (e) {
      emit({ ev: 'error', reqId: c.reqId, paneId: null, message: `Could not fork it: ${e.message || e}` });
    }
  },
  // Archive: hidden from Apaki's lists, nothing deleted (archive.js); archived: false brings it back.
  archive: async (c) => {
    archive.setArchived(c.sessionId, c.archived !== false);
    await sessions(c.reqId || null);
  },
  // The session's folder in Explorer (or Finder, or the file manager).
  revealFolder: (c) => {
    const dir = String(c.cwd || '');
    let ok = false;
    try { ok = Boolean(dir) && fs.statSync(dir).isDirectory(); } catch { ok = false; }
    if (!ok) { emit({ ev: 'note', paneId: null, reqId: c.reqId, text: 'That folder is not there any more.' }); return; }
    const { cmd, args } = openFolderCommand(process.platform, dir);
    try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref(); } catch { /* nothing to open it with */ }
  },
  /* ---------- the session list's Details, Pin to top, Export and Open in a terminal (2026-10-12, session-info.js) ---------- */
  // Everything known about one session, read only (a phone may ask at every access level: remote-policy.js).
  sessionInfo: async (c) => {
    const id = String(c.sessionId || '');
    if (!SESSION_ID_RE.test(id)) { emit({ ev: 'sessionInfo', reqId: c.reqId, sessionId: id, ok: false, message: 'That is not a session id.' }); return; }
    try {
      emit({ ev: 'sessionInfo', reqId: c.reqId, sessionId: id, ok: true, info: await sessionInfoOf(id) });
    } catch (e) {
      emit({ ev: 'sessionInfo', reqId: c.reqId, sessionId: id, ok: false, message: `Could not read it: ${e.message || e}` });
    }
  },
  // Pinned sessions show under Pinned at the top of the list (pins.js); pinned: false unpins.
  pin: async (c) => {
    pins.setPinned(String(c.sessionId || ''), c.pinned !== false);
    await sessions(c.reqId || null);
  },
  // The conversation as a Markdown file in Downloads, shown in Explorer; inline (a phone) sends the text back instead.
  exportSession: async (c) => {
    const id = String(c.sessionId || '');
    const item = listItemOf(id) || {};
    const name = exportName(item.title || item.firstPrompt || 'Conversation', id);
    let markdown = null;
    try { markdown = SESSION_ID_RE.test(id) ? await sessionMarkdown(id) : null; } catch (e) { process.stderr.write(`export ${id}: ${e.message || e}\n`); }
    if (!markdown) { emit({ ev: 'exported', reqId: c.reqId, sessionId: id, ok: false, message: 'There is nothing to export: its transcript is not on this PC.' }); return; }
    if (c.inline) { emit({ ev: 'exported', reqId: c.reqId, sessionId: id, ok: true, name, markdown }); return; }
    try {
      const file = freePath(exportDir(), name);
      await fs.promises.writeFile(file, markdown, 'utf8');
      emit({ ev: 'exported', reqId: c.reqId, sessionId: id, ok: true, name: path.basename(file), path: file });
      revealFile(file);
    } catch (e) {
      emit({ ev: 'exported', reqId: c.reqId, sessionId: id, ok: false, message: `Could not save it: ${e.message || e}` });
    }
  },
  // Open in a terminal is the engine op openTerminal { sessionId, kind, paneId? }, built with the console toggle (another
  // branch, reconciled at merge): it opens the exact session in a terminal window with the pane's settings.
  folder: async (c) => {
    if (c.action === 'create') { const f = folders.createFolder(c.name); if (!f.error && c.sessionId) folders.moveToFolder(c.sessionId, f.id); }
    if (c.action === 'move') folders.moveToFolder(c.sessionId, c.folderId || null);
    if (c.action === 'rename') folders.renameFolder(c.folderId, c.name);
    if (c.action === 'delete') folders.deleteFolder(c.folderId);
    emit({ ev: 'folders', folders: folders.listFolders() });
  },
  // Git worktrees (see the section above). A phone may send the first four, checked by remote-policy.js against its access.
  worktrees: (c) => sendWorktrees(c),
  worktreeDiff: async (c) => {
    // Someone is looking at this worktree's changes: its repository stays hot a while (2026-10-15).
    if (c.path) wtAsk(String(c.path));
    const found = c.path ? await wtIndex.recordFor(String(c.path)) : null;
    if (!found || !found.wt) { emit({ ev: 'worktreeDiff', reqId: c.reqId, ok: false, path: String(c.path || ''), error: 'That folder is not a git worktree.' }); return; }
    // The diff's git and its reads of new files run on the worktree worker too.
    const d = await wtIndex.diff(found.top, { base: found.wt.base || found.rec.base || '', scope: c.scope === 'head' ? 'head' : 'base' });
    emit({ ev: 'worktreeDiff', reqId: c.reqId, path: found.top, branch: found.wt.branch || '', repo: found.rec.name, ...d });
  },
  worktreePlan: async (c) => {
    const { repo, plan } = await wtPlanFor(c, false);
    emit(planEvent(c.reqId, plan, repo));
  },
  worktreeRun: (c) => wtRunOp(c),
  // A terminal in the folder, on this PC: the window only (a phone has no business opening windows here).
  worktreeTerminal: (c) => {
    const dir = String(c.path || '');
    const info = dir ? wtFindRepo(dir) : null;
    if (!info || !wtSame(info.top, dir)) { emit({ ev: 'note', paneId: null, reqId: c.reqId, text: 'That folder is not a git worktree.' }); return; }
    const start = (t, fallback) => {
      try {
        const child = spawn(t.cmd, t.args, { cwd: t.cwd || info.top, detached: true, stdio: 'ignore', windowsHide: false });
        child.on('error', () => { if (fallback) start(fallback, null); });
        child.unref();
      } catch { if (fallback) start(fallback, null); }
    };
    const t = terminalCommand(process.platform, info.top);
    start(t, t.fallback);
  },
  // Phone access (remote.js): from the desktop window only. A phone's
  // commands never reach these: remote-policy.js does not allow them.
  remoteStatus: (c) => remote.op(c),
  remoteDevices: (c) => remote.op(c),
  remoteEnable: (c) => remote.op(c),
  remoteDisable: (c) => remote.op(c),
  remotePairStart: (c) => remote.op(c),
  remotePairCancel: (c) => remote.op(c),
  remotePairDecision: (c) => remote.op(c),
  remoteRevoke: (c) => remote.op(c),
  // A paired phone's lifetime (forever, 30, 7 or 1 days), and Start over when the saved keys cannot be opened (2026-10-10).
  remoteDeviceLifetime: (c) => remote.op(c),
  remoteReset: (c) => remote.op(c),
  // Private or Connected, a phone's access (Full, No shell, Chat only), and the answer to an account-link held for the PC (2026-10-10).
  remoteMode: (c) => remote.op(c),
  remoteDeviceCap: (c) => remote.op(c),
  remoteLinkDecision: (c) => remote.op(c),
  // Allow, Block or Forget one phone key behind an Apaki account, and dismiss a "New phone connected" line (2026-10-11, ENROLL.md).
  // Window only, like every remote* op: remote-policy.js never lists them for a phone.
  remotePhoneDecision: (c) => remote.op(c),
  remoteNoticeDismiss: (c) => remote.op(c),
  // The background host (host.js): its state, and exit once idle (an update) or now. Desktop only:
  // remote-policy.js does not allow them for phones.
  hostStatus: (c) => emit(hostControl({ ...c, op: 'hostStatus' })),
  hostQuit: (c) => emit(hostControl(c)),
  // The console and Open in terminal (2026-10-12, console.js and the section above): the desktop window only, except
  // consoleView, a read-only look a phone may take (remote-policy.js).
  consoleOpen: (c) => (parsePhoneId(String(c.paneId || '')) ? undefined : consoleCtl.open(c)),
  consoleInput: (c) => { consoleCtl.input(c); },
  consoleResize: (c) => { consoleCtl.resize(c); },
  consoleClose: (c) => consoleCtl.close(c),
  consoleView: (c) => {
    const p = getPane(c.paneId);
    const sid = p.sessionId || p.lockedOn || null;
    const con = consoles.get(p.id) || consoles.bySession(sid);
    const v = con ? consoles.view(con.paneId, 40) : null;
    emit({ ev: 'consoleView', reqId: c.reqId || null, paneId: p.id, sessionId: sid, state: v ? v.state : 'none', text: v ? v.text : '', at: Date.now() });
  },
  openTerminal: (c) => openTerminal(c),
};

const SERIAL_OPS = new Set(['open', 'attach', 'send', 'close', 'model', 'mode', 'effort', 'tune', 'billing']);

/** Runs one command, from the window (stdin) or from a phone (remote.js, already checked). */
async function dispatch(c) {
  let h = handlers[c.op];
  const kp = panes.get(String(c.paneId || ''));
  const kimiTarget = isKimiPane(kp) || isKimiId(c.sessionId) || c.kind === 'kimi';
  if (kimiTarget && (c.follower || parsePhoneId(c.paneId))) { emit({ ev: 'error', reqId: c.reqId, paneId: c.paneId, message: 'Kimi panes are available on the desktop only.', refused: true }); return; }
  if (kimiTarget) {
    // Keep unsupported Kimi operations away from Claude credentials, transcripts and console commands.
    const allowed = new Set(['open', 'attach', 'send', 'interrupt', 'answer', 'close', 'queueSet', 'folder', 'pin', 'archive', 'sessionInfo', 'stopSession', 'model', 'effort', 'mode', 'contextUsage', 'commands', 'historyBefore', 'historyCheck', 'historyPrompts', 'steer', 'billingOptions']);
    if (!allowed.has(c.op)) { emit({ ev: 'error', reqId: c.reqId, paneId: c.paneId, busy: Boolean(kp?.busy), message: `The ${c.op} operation is not supported for Kimi panes yet.` }); return; }
    if (c.op === 'sessionInfo') h = async () => {
      await kimiList.refresh();
      const row = kimiList.get(c.sessionId);
      emit({ ev: 'sessionInfo', reqId: c.reqId, sessionId: c.sessionId, ok: Boolean(row), info: row ? { ...row, provider: 'kimi', transcript: row.file, transcriptSize: row.size, archived: row.kimiArchived } : null });
    };
    else if (isKimiPane(kp) && !['open', 'send', 'interrupt', 'answer', 'close', 'queueSet', 'folder', 'pin', 'archive', 'stopSession'].includes(c.op)) h = async () => {
      if (c.op === 'attach' && (c.sessionId || null) !== (kp.sessionId || null)) return attach(c.reqId, c.paneId, c.sessionId || null, c.cwd || null);
      await kimi.handle(c, kp);
    };
  }
  if (!h) { emit({ ev: 'error', reqId: c.reqId, message: `unknown op ${c.op}` }); return; }
  // A send or steer takes its queued messages out of this engine's copy at once, before it waits its turn in the
  // pane's chain below: the copy must never still hold what a window is sending (queue-hold.js, no double send).
  // `queued` only comes from the desktop window; remote-policy.js strips it from a phone's send.
  // A phone following this desktop pane (c.follower, set by remote.js) has no queue here: its qid is its own, and must never
  // match, and so drop, an id in the window's queue.
  if ((c.op === 'send' || c.op === 'steer') && c.paneId != null) {
    const hp = panes.get(String(c.paneId));
    if (hp) {
      if (!c.follower) dropHeld(hp, c.op === 'steer' ? [c.qid] : c.queued);
      // A new message after a Stop: the queue goes out after this turn again.
      if (c.op === 'send') hp.userStopped = false;
    }
  }
  const run = async () => { try { await h(c); } catch (e) { emit({ ev: 'error', reqId: c.reqId, paneId: c.paneId, ...(isKimiPane(kp) ? { busy: Boolean(kp.busy) } : {}), message: e.message || String(e) }); } };
  // A pane's opens, sends, closes and setting changes run one after another.
  // Without this, a message sent while the pane was still switching
  // conversations started a second runner and its turn landed in a new
  // session (found in the 2026-10-09 smoke test). interrupt and answer must
  // not wait: the running turn is what they act on.
  if (c.paneId && SERIAL_OPS.has(c.op)) {
    const p = getPane(c.paneId);
    // attach to a pane whose process is up only sends its state again, so it
    // runs at once: queued, it waited behind the running send until the turn
    // ended, and behind a question it was meant to ask again for good
    // (2026-10-10, found re-attaching to the background host mid-turn). An
    // attach that falls back to open stays in the queue.
    if (c.op === 'attach' && (p.runner || isKimiPane(p)) && (p.sessionId || null) === (c.sessionId || null)) { await run(); return; }
    p.queue = (p.queue || Promise.resolve()).then(run);
    return;
  }
  await run();
}

/** The panes of one phone (phone:<deviceId>:...). */
const phonePanes = (deviceId) => [...panes.keys()].filter((id) => parsePhoneId(id)?.deviceId === deviceId);

/** A phone pane's access (remote.js capFor): 'chat', the narrowest, while phone access is not set up or the phone is gone. */
function phoneCap(paneId) {
  return remote?.capFor?.(paneId) || 'chat';
}

/**
 * A phone's access changed on the PC: each of its panes takes the mode it
 * may use now; an idle running one restarts with the new tool limits (a
 * busy one keeps its stricter or looser list until it is reopened, while
 * the hook and canUseTool apply the new access at once).
 */
async function capChanged(deviceId) {
  for (const id of phonePanes(deviceId)) {
    const p = panes.get(id);
    if (!p) continue;
    // A Codex pane takes the presets the access allows (codex-panes.js recap); it has no Claude Code process to restart.
    if (isCodexPane(p)) { codex.recap(p); continue; }
    const o = capRunnerOptions(phoneCap(id), p.mode);
    p.mode = clampMode(phoneCap(id), p.mode);
    // Below Full access: Ultracode goes off and workflows are turned off (a restart below reads that; a busy process is told now).
    const restricted = tuneRestricted(p);
    if (restricted) p.tune = claudeTune({ size: p.tune?.size });
    if (p.runner) {
      Object.assign(p.runner, { disallowedTools: o.disallowedTools, allowedTools: o.allowedTools });
      if (p.runner.running && !p.busy && !paneTurnBusy(p)) await p.runner.restart({ permissionMode: p.mode }).catch(() => {});
      else {
        await p.runner.setPermissionMode(p.mode).catch(() => {});
        if (restricted) await p.runner.applyFlags(startSettings(p.tune, { restricted: true }));
      }
    }
    emit(paneSettings(p));
  }
}

remote = createRemote({
  emit,
  dispatch: (c) => dispatch(c),
  // voice: whether this PC has Whisper, so a phone shows its mic (op transcribe, 2026-10-12); it was always false here.
  readyEvent: () => ({ ev: 'ready', version: APP_VERSION, billing: billingInfo(), model: defaults.model, effort: defaults.effort, mode: defaults.mode, pid: process.pid, voice: voiceReady(), codex: CODEX_FOUND, kimi: KIMI_FOUND }),
  engine: {
    hasOp: (op) => typeof handlers[op] === 'function',
    paneExists: (id) => panes.has(id),
    paneCount: (deviceId) => phonePanes(deviceId).length,
    phonePanes,
    paneInfo: (id) => { const p = panes.get(id); return p ? { sessionId: p.sessionId, running: Boolean(p.runner) || isCodexPane(p) || isKimiPane(p), busy: Boolean(p.busy), model: p.model, effort: p.effort, mode: p.mode, tune: tuneView(p), kind: isKimiPane(p) ? 'kimi' : isCodexPane(p) ? 'codex' : 'claude' } : null; },
    // Whether a pane runs a Codex thread: its model, effort and mode are Codex's (remote-policy.js checks them against that).
    paneKind: (id) => (isKimiPane(panes.get(id)) ? 'kimi' : isCodexPane(panes.get(id)) ? 'codex' : 'claude'),
    capChanged: (deviceId) => { capChanged(deviceId).catch((e) => process.stderr.write(`apaki: applying a phone's access: ${e.message}
`)); },
    askPane: (askId) => state.asks.get(askId)?.paneId || null,
    // A folder some listed session ran in, or a worktree (or a folder in one) of a repository the engine lists (2026-10-12).
    knownCwd: (cwd) => Boolean(state.items?.some((it) => it.cwd === cwd)) || wtIndex.knownPath(cwd),
    phoneSessions: (deviceId) => phonePanes(deviceId).map((id) => panes.get(id)?.sessionId).filter(Boolean),
    // What a phone may follow (the shared view, 2026-10-11): a desktop conversation pane this engine holds. The window's own saved
    // layout says when an id is a viewer, browser or task pane instead; anything else, or a phone pane, is not there.
    desktopPane: (id) => {
      if (typeof id !== 'string' || parsePhoneId(id)) return null;
      const kind = desktopKinds.get(id);
      if (kind && kind !== 'session') return kind;
      return panes.has(id) ? 'conversation' : null;
    },
  },
});

// The window's commands: on stdin, or in host mode from the connected window (startHostMode below;
// a host's stdin is empty and must not end it).
let rl = null;
if (!HOST_MODE) {
  rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let c;
    try { c = JSON.parse(line); } catch { return; }
    await dispatch(c);
  });
  rl.on('close', () => { shutdown('stdin closed'); });
}

let shuttingDown = null;
/**
 * Saves what is pending, stops phone access and every Claude Code process,
 * and exits: stdin closed (the window that started a stdio engine went away),
 * or the host's lifecycle decided so (host.js: idle with no window, or a quit).
 */
function shutdown(reason = 'stdin closed') {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    // A host stops taking connections and forgets its address first, so a window opening now starts a fresh host.
    if (host) { lifecycle?.stop(); host.close(); process.stderr.write(`apaki host: exiting (${reason})\n`); }
    if (workspaceTimer) { clearTimeout(workspaceTimer); workspaceTimer = null; if (workspacePending) { try { fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(workspacePending)); } catch { /* exiting */ } } }
    remote?.stop();
    fs.unwatchFile(LIVE_LOGIN);
    // Asked to stop now: running turns are interrupted, as closing the window did before the host.
    if (reason === 'quit-now') for (const p of panes.values()) if (p.runner?.running && paneTurnBusy(p)) await p.runner.interrupt();
    // Consoles quit the way a person quits them (console.js), before the engine goes.
    await consoles.shutdown().catch(() => {});
    await Promise.all([...panes.values()].map((p) => closeRunner(p)));
    await kimi.shutdown();
    await codex.shutdown();
    // The worktree worker and the delay monitor (2026-10-15).
    try { perf.stop(); await wtIndex.close(); } catch { /* not started yet, or already gone */ }
    process.exit(0);
  })();
  return shuttingDown;
}

/* ---------- task viewers: subagent transcripts and shell output, live ---------- */

// viewerId -> stop(); a viewer watches one file at a time.
const viewerWatch = new Map();

function unwatchViewer(id) {
  const stop = viewerWatch.get(id);
  viewerWatch.delete(id);
  try { stop?.(); } catch { /* gone */ }
}

/**
 * Sends a subagent's transcript to its viewer, then every line it adds. One
 * opened the moment it started may have no file yet: looked for again every
 * second for 30 s.
 */
function watchAgent(viewer, sessionId, agentId, toolUseId) {
  unwatchViewer(viewer);
  let tries = 0;
  let timer = null;
  let stopFile = null;
  const find = () => {
    const file = transcriptMap().get(sessionId);
    if (!file) return null;
    return agentId ? listSubagents(file).find((a) => a.id === agentId) || null : agentByToolUse(file, toolUseId);
  };
  const start = (a) => {
    let next = 0;
    const meta = { id: a.id, type: a.type, description: a.description, model: a.model, workflow: a.workflow, startedAt: a.startedAt, toolUseId: a.toolUseId };
    const push = (reset) => {
      let r;
      try { r = readEntries(a.file, next); } catch { return; }
      next = r.next;
      let lastAt = 0;
      try { lastAt = fs.statSync(a.file).mtimeMs; } catch { /* gone */ }
      if (reset || r.entries.length) emit({ ev: 'agentLines', paneId: viewer, reset, entries: r.entries, agent: meta, running: Date.now() - lastAt < RUNNING_MS, lastAt });
    };
    push(true);
    stopFile = watchFile(a.file, () => push(false));
  };
  const attempt = () => {
    const a = find();
    if (a) { start(a); return; }
    if (++tries > 30) { emit({ ev: 'agentLines', paneId: viewer, reset: true, missing: true, entries: [] }); return; }
    timer = setTimeout(attempt, 1000);
  };
  viewerWatch.set(viewer, () => { clearTimeout(timer); stopFile?.(); });
  attempt();
}

/** Sends the end of a shell or Monitor output file to its viewer, then what it appends. */
function watchOutput(viewer, sessionId, taskId) {
  unwatchViewer(viewer);
  let tries = 0;
  let timer = null;
  let stopFile = null;
  const attempt = () => {
    const file = transcriptMap().get(sessionId);
    const sh = file ? listShells(file).find((x) => x.id === taskId) : null;
    if (!sh) {
      if (++tries > 30) { emit({ ev: 'outputText', paneId: viewer, reset: true, missing: true, text: '' }); return; }
      timer = setTimeout(attempt, 1000);
      return;
    }
    let next = null;
    const push = (reset) => {
      let r;
      try { r = readText(sh.file, next); } catch { return; }
      next = r.next;
      let lastAt = 0;
      try { lastAt = fs.statSync(sh.file).mtimeMs; } catch { /* gone */ }
      if (reset || r.text) emit({ ev: 'outputText', paneId: viewer, reset, text: r.text, cut: Boolean(r.cut), running: Date.now() - lastAt < RUNNING_MS, lastAt });
    };
    push(true);
    stopFile = watchFile(sh.file, () => push(false));
  };
  viewerWatch.set(viewer, () => { clearTimeout(timer); stopFile?.(); });
  attempt();
}

/* ---------- the workspace on disk ---------- */

// The window keeps its workspace in localStorage and sends it here too, so a
// crash (or a lost WebView profile) still reopens every tab, pane, draft and
// queued message. Written at most once a second, atomically.
// One file per app identifier (the shell passes APAKI_APP_ID): a dev build's
// test layout must never become the installed app's "newer" workspace.
const APP_ID = String(process.env.APAKI_APP_ID || 'io.myrlin.apaki');
const WORKSPACE_FILE = path.join(CLAUDE_DIR, 'latch', APP_ID === 'io.myrlin.apaki' ? 'apaki-workspace.json' : `apaki-workspace.${APP_ID.replace(/[^\w.-]/g, '_')}.json`);
let workspacePending = null;
let workspaceTimer = null;
function saveWorkspace(st) {
  if (!st || typeof st !== 'object') return;
  workspacePending = st;
  if (workspaceTimer) return;
  workspaceTimer = setTimeout(() => {
    workspaceTimer = null;
    const data = workspacePending;
    workspacePending = null;
    try {
      fs.mkdirSync(path.dirname(WORKSPACE_FILE), { recursive: true });
      const tmp = `${WORKSPACE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, WORKSPACE_FILE);
    } catch (e) { process.stderr.write(`apaki: workspace not saved (${e.message})\n`); }
  }, 1000);
}
// The desktop's tabs as phones see them (desktop-tabs.js, 2026-10-11): sent when they change, and once at start
// from the saved workspace, so a phone sees them even while the window is closed (remote.js caches the last one).
let lastDesktopTabs = '';
// When each pane of a tab that is not showing was last shown (the window's workspace says which tab is active), by the window's
// pane id: what "Free hidden conversations" waits on (host.js planIdle hiddenSince). A pane in the active tab has no entry.
const hiddenSince = new Map();
/** Updates hiddenSince from the window's tabs (host.js trackHiddenPanes). */
function noteHiddenPanes(tabs, now = Date.now()) {
  trackHiddenPanes(hiddenSince, tabs, now);
}
// What each pane of the window is (desktop-tabs.js kind: session, browser, task, viewer), by the window's pane id, so a phone is
// told "not a conversation" for a viewer instead of "not open" (the shared view, 2026-10-11; engine.desktopPane).
let desktopKinds = new Map();
function sendDesktopTabs(st) {
  if (!st || typeof st !== 'object') return;
  const tabs = desktopTabs(st);
  desktopKinds = new Map(tabs.flatMap((t) => t.panes).filter((p) => p.paneId).map((p) => [p.paneId, p.kind]));
  noteHiddenPanes(tabs);
  const key = JSON.stringify(tabs);
  if (key === lastDesktopTabs) return;
  lastDesktopTabs = key;
  emit({ ev: 'desktopTabs', tabs, at: Date.now() });
}

function loadWorkspace() {
  try { return JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8')); } catch { return null; }
}

/* ---------- renames ---------- */

/**
 * Writes a session's name. A running Claude Code process writes its own
 * in-memory name back into the transcript after its turns (one renamed
 * session on this PC had the same custom-title entry 155 times), so a pane of
 * ours holding the session is stopped first (it resumes with the new name at
 * its next message, no API call). If one of them is mid-turn the name is
 * written when that turn ends. A terminal window cannot be reached: when it
 * holds a session that already had a name, the note says to /rename there too.
 */
async function applyRename(id, title, { reqId = null, paneId = null } = {}) {
  const holders = [...panes.values()].filter((x) => x.sessionId === id && x.runner?.running);
  if (holders.some((x) => x.runner.turnRunning)) {
    state.renames.set(id, title);
    emit({ ev: 'renamed', reqId, paneId, sessionId: id, title, ok: true, pending: true });
    return;
  }
  state.renames.delete(id);
  const before = await getSessionInfo(id).catch(() => null);
  for (const x of holders) await x.runner.stop().catch(() => {});
  try {
    await renameSession(id, title);
  } catch (e) {
    emit({ ev: 'renamed', reqId, paneId, sessionId: id, ok: false, message: e.message || String(e) });
    return;
  }
  const it = state.byId.get(id);
  if (it) it.title = title;
  const terminal = terminalSessions().get(id);
  const note = terminal?.length && before?.customTitle && before.customTitle !== title
    ? `Renamed. It is also open in a terminal window (${terminal.map((t) => t.name || t.pid).join(', ')}) that still has it as "${before.customTitle}": run /rename ${title} there too, or that window puts its old name back after its next turn.`
    : '';
  emit({ ev: 'renamed', reqId, paneId, sessionId: id, title, ok: true, note });
}

/* ---------- live session list and keep-warm marks ---------- */

// The list follows Claude Code as it happens (live.js): terminal windows
// opening and closing at once, new or changed transcripts within seconds.
let listBusy = false;
async function refreshList() {
  if (listBusy) return;
  // A host with no window and no phone connected has nobody to show the list to; whoever connects asks for it.
  if (!listening()) return;
  listBusy = true;
  try { await sessions(null); } catch { /* the next change tries again */ } finally { listBusy = false; }
}
startLive({
  liveDir: path.join(CLAUDE_DIR, 'sessions'),
  projectsDir: path.join(CLAUDE_DIR, 'projects'),
  terminals: () => terminalSessions(),
  onTerminals: (map) => {
    const out = {};
    for (const [id, recs] of map) out[id] = { name: recs[0].name, status: recs[0].status, pid: recs[0].pid, cwd: recs[0].cwd, updatedAt: recs[0].updatedAt };
    emit({ ev: 'terminals', terminals: out });
    refreshList();
  },
  onChange: () => refreshList(),
  // A session's subagents changed on disk: the rail's count and an open list follow.
  onSubagents: (sessionId) => {
    // The list's kept count goes too (subagentCount reads it again on the next list).
    subagentCounts.delete(sessionId);
    const file = transcriptMap().get(sessionId);
    emit({ ev: 'subagentsChanged', sessionId, count: file ? countSubagents(file) : 0 });
  },
});

/** Which sessions keep-warm is looking after; the window draws a moving border on them. */
function refreshWarm() {
  let next = [];
  try { next = warmSessions(); } catch { next = []; }
  const same = next.length === state.warm.size && next.every((id) => state.warm.has(id));
  if (same) return;
  state.warm = new Set(next);
  emit({ ev: 'warm', sessions: next });
}
setInterval(refreshWarm, 30 * 1000).unref();
setTimeout(refreshWarm, 2000).unref();

/* ---------- Myrlin Glass, live ---------- */

// Apaki follows Glass as it happens (Arthur, 2026-10-09: "meant to integrate
// with and dynamically respond to choices made in myrlin glass"). Glass swaps
// Claude Code's login by rewriting ~/.claude/.credentials.json; the engine
// watches that file, and on a change every pane that follows Glass shows its
// new billing at once (its runner restarts on the new login with its next
// message, see SessionRunner.send). The account's label and plan come from
// `glass status`, asynchronously, so the engine never waits on Glass.
const LIVE_LOGIN = process.env.LATCH_LIVE_LOGIN_FILE || path.join(CLAUDE_DIR, '.credentials.json');
// Per platform (src/platform.js): the same Windows path as before; on a Mac the usual app and command-line places.
const GLASS_CLI = glassCli();
let glassSeen = null;
let glassReadVersion = 0;
let lastGlassStatus = null;
// Fresh installs (2026-10-10): what the window says when Glass is missing, or runs without Workbook.
// macOS port (2026-10-12): Myrlin Glass is a Windows widget today; Apaki runs without it.
const GLASS_MISSING = process.platform === 'darwin'
  ? 'Myrlin Glass is not installed on this Mac (Glass is a Windows app for now). Apaki works without it; sign in with Claude Code instead.'
  : 'Myrlin Glass is not installed. Run the Myrlin Apaki installer again to add it.';

const glassProvider = (c) => (c.provider === 'kimi' ? 'kimi' : c.provider === 'codex' ? 'codex' : 'claude');

/**
 * Runs one Glass command for the Glass panel and reports it as glass_op
 * { reqId, op, ok, message }, then reads Glass again so the panel shows the
 * result. `input` goes to its stdin (API keys; never logged, never echoed).
 */
function glassOp(c, args, input = null) {
  return new Promise((resolve) => {
    // No Glass on this PC (2026-10-10): say so instead of "spawn ... ENOENT".
    if (!fs.existsSync(GLASS_CLI)) { emit({ ev: 'glass_op', reqId: c.reqId, op: c.op, provider: glassProvider(c), ok: false, message: GLASS_MISSING }); resolve(); return; }
    const child = execFile(GLASS_CLI, [...args, '--json'], { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = null;
      try { out = JSON.parse(stdout); } catch { out = null; }
      const ok = !err && out?.ok !== false && !out?.error;
      const said = out?.message || out?.error || String(stderr || '').replace(/^glass:\s*/m, '') || err?.message || '';
      emit({ ev: 'glass_op', reqId: c.reqId, op: c.op, provider: glassProvider(c), ok, message: String(said).trim().split('\n')[0].slice(0, 300) });
      glassChanged().catch(() => {}).finally(resolve);
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

/** Glass's full status (all providers, their accounts, API credit orgs), or null. */
function glassStatus() {
  return new Promise((resolve) => {
    if (!fs.existsSync(GLASS_CLI)) { resolve(null); return; }
    execFile(GLASS_CLI, ['status', '--json'], { timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

async function glassChanged() {
  const version = ++glassReadVersion;
  const c = glassCredential();
  const id = `${c.source}:${c.key ? c.key.slice(-12) : ''}`;
  const fresh = await glassStatus();
  if (version !== glassReadVersion) return;
  const status = fresh || lastGlassStatus;
  lastGlassStatus = status;
  kimi.updateBilling(status);
  const view = glassView(status);
  const account = view?.claude ? { label: view.claude.name, plan: view.claude.plan, headroom: view.claude.headroom } : null;
  const name = c.key ? (view?.claude?.isKey ? view.claude.name : c.name) : account?.label ? `${account.label} (${account.plan || 'subscription'})` : c.name;
  const changed = glassSeen !== null && glassSeen !== id;
  glassSeen = id;
  const next = { ...c, name };
  if (defaults.credential.follow) defaults.credential = next;
  for (const p of panes.values()) {
    if (isKimiPane(p)) continue;
    if (!p.credential.follow) continue;
    const moved = (p.credential.key ?? null) !== (next.key ?? null);
    p.credential = next;
    if (changed || moved) billingChanged(p); emit({ ev: 'billing', paneId: p.id, ...billingInfo(p), note: moved ? `Myrlin Glass switched Claude to ${name}; the next message here uses it.` : undefined });
  }
  emit({ ev: 'glass', installed: fs.existsSync(GLASS_CLI), name, source: c.source, plan: account?.plan || null, headroom: account?.headroom ?? null, changed, isKey: Boolean(c.key), claude: view?.claude || null, codex: view?.codex || null, kimi: view?.kimi || null, visibleProviders: view?.visibleProviders ?? null, knownProviders: view?.knownProviders ?? null, lists: view?.lists || null, mode: view?.mode || null });
}

fs.watchFile(LIVE_LOGIN, { interval: 1500 }, () => { glassChanged().catch(() => {}); });
glassChanged().catch(() => {});
// Usage numbers move without a login change; Glass keeps them, this only reads them.
// Only while a window or phone listens (2026-10-15): with nobody to show it to, the minute's `glass status` process is
// skipped; a login change still runs it (the watch above), and a window that connects reads Glass at once.
setInterval(() => { if (listening()) glassChanged().catch(() => {}); }, 60 * 1000).unref();

/* ---------- signing in to Claude (fresh installs, 2026-10-10) ---------- */

// A PC that only has Myrlin Apaki has no Claude Code login, and the Agent SDK
// cannot run /login, so the first message used to end in "Not logged in" with
// no way forward (seen in a clean-profile run, 2026-10-10). Apaki's own Claude
// Code (the binary the SDK ships, src/launch.js claudeBinary) signs in with
// `claude auth login` in a console window of its own, where the person finishes
// the browser sign-in; Claude Code writes its login files itself, Apaki never does.
//   op authStatus { reqId }           -> ev auth { reqId, loggedIn, method, email, org, plan, viaKey }
//   op signIn { reqId, console? }     -> ev auth_signin { reqId, ok, message }; ev auth follows
//                                        once the login file appears (console: Console API billing)

function authStatus(reqId = null) {
  return new Promise((resolve) => {
    // A key Glass made live counts as signed in (Claude Code bills it without a claude.ai login).
    const viaKey = liveLogin().kind === 'key';
    const bin = claudeBinary();
    if (!bin) { emit({ ev: 'auth', reqId, loggedIn: viaKey, method: viaKey ? 'key' : 'unknown', viaKey, error: 'Claude Code was not found' }); resolve(); return; }
    // `auth status` exits 1 when signed out but still prints its JSON.
    execFile(bin, ['auth', 'status', '--json'], { timeout: 20000, windowsHide: true, env: childEnv(null) }, (err, stdout) => {
      let s = null;
      try { s = JSON.parse(stdout); } catch { s = null; }
      emit({
        ev: 'auth', reqId, loggedIn: Boolean(s?.loggedIn) || viaKey, method: s?.authMethod || (viaKey ? 'key' : 'none'),
        email: s?.email || null, org: s?.orgName || null, plan: s?.subscriptionType || null, viaKey,
        error: s ? undefined : String(err?.message || 'no answer from Claude Code').split('\n')[0].slice(0, 200),
      });
      resolve();
    });
  });
}

function signIn(reqId = null, consoleBilling = false) {
  const bin = claudeBinary();
  if (!bin) { emit({ ev: 'auth_signin', reqId, ok: false, message: 'Claude Code was not found, so Apaki cannot open the sign-in.' }); return; }
  // Windows: a console window of its own; macOS: a new Terminal window (src/platform.js signInCommand); elsewhere the person is told what to run.
  const plan = signInCommand(process.platform, bin, { consoleBilling, comspec: process.env.ComSpec || 'cmd.exe' });
  if (!plan) { emit({ ev: 'auth_signin', reqId, ok: false, message: `Run this in a terminal to sign in: "${bin}" auth login` }); return; }
  const env = childEnv(null);
  delete env.PROMPT_RELAY_CHILD;
  delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
  // `start` gives the sign-in a console window of its own (the engine has none);
  // with /s, cmd keeps the quoted path intact. The path is ours (no quotes in it).
  try {
    const child = spawn(plan.cmd, plan.args, { env, stdio: 'ignore', windowsHide: true, ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    child.on('error', (e) => emit({ ev: 'auth_signin', reqId, ok: false, message: `Could not open the sign-in: ${e.message}` }));
    child.unref();
    emit({ ev: 'auth_signin', reqId, ok: true, message: 'Finish signing in in the window that opened. Apaki picks the login up as soon as Claude Code saves it.' });
  } catch (e) {
    emit({ ev: 'auth_signin', reqId, ok: false, message: `Could not open the sign-in: ${e.message}` });
  }
}

// The login file appears (or changes) when a sign-in finishes: tell the window.
let authTimer = null;
fs.watchFile(LIVE_LOGIN, { interval: 1500 }, () => {
  clearTimeout(authTimer);
  authTimer = setTimeout(() => { authStatus(null).catch(() => {}); }, 800);
});
setTimeout(() => { authStatus(null).catch(() => {}); }, 1500).unref();

emit({ ev: 'ready', version: APP_VERSION, billing: billingInfo(), model: defaults.model, effort: defaults.effort, mode: defaults.mode, pid: process.pid, voice: voiceReady(), artifacts: Boolean(openServer), codex: CODEX_FOUND, kimi: KIMI_FOUND });
// The transcript archive: a minute after start, then every 6 hours (2026-10-12).
setTimeout(() => { runTranscriptArchive(); }, 60 * 1000).unref();
setInterval(() => { runTranscriptArchive(); }, 6 * 60 * 60 * 1000).unref();
// The desktop's tabs from the saved workspace, so a phone sees them before the window sends any (or with it closed).
sendDesktopTabs(loadWorkspace());
// Keep the conversation indexes current in the background. The index server
// (latch-index serve) holds the keyword index, the meaning index and the
// embedding model open for searches, and updates both: keyword first (under a
// second), then meaning (the first build takes a few minutes on the GPU).
const UPDATE_EVERY_MS = 3 * 60 * 1000;
let indexStarted = Date.now();
const indexServer = startIndexServer({
  onEvent: (j) => {
    if (j.ev === 'keyword') emit({ ev: 'index', ok: Boolean(j.result?.ok), ms: Date.now() - indexStarted, stats: j.result });
    if (j.ev === 'semantic') emit({ ev: 'meaning', stage: j.stage, done: j.done ?? null, total: j.total ?? null, device: j.device || j.result?.device || null, result: j.result || null });
  },
});
async function refreshIndexes() {
  indexStarted = Date.now();
  if (indexServer && (await updateViaServer())) return;
  const r = await updateIndex();
  emit({ ev: 'index', ok: Boolean(r), ms: Date.now() - indexStarted, stats: r });
}
refreshIndexes();
setInterval(() => { refreshIndexes().catch(() => {}); }, UPDATE_EVERY_MS).unref();

/* ---------- how responsive this thread is (perf.js, 2026-10-15) ---------- */

// The event loop's delay (p50, p99, max) and the processes started, per minute: host-ctl status shows them (hostControl
// below, field perf), and a minute with p99 over 200 ms leaves a line in the engine log. The worktree worker's git
// processes are counted with the ones this thread starts.
const perf = createPerfMonitor({ log: (line) => process.stderr.write(`${line}\n`), workerSpawns: () => wtIndex.spawns });

/* ---------- the background host (host.js; Arthur 2026-10-10: sessions outlive the window) ---------- */

/** How many questions wait in one pane. */
function asksOf(paneId) {
  let n = 0;
  for (const a of state.asks.values()) if (a.paneId === paneId) n += 1;
  return n;
}

/** A paired phone is connected right now (remote.js). */
function phoneConnected() {
  for (const c of remote?.conns?.values?.() || []) if (c.open) return true;
  return false;
}

/** Someone receives list updates: always on stdin/stdout; for a host, a window or a phone. */
function listening() {
  return !HOST_MODE || Boolean(host?.window) || phoneConnected();
}

/**
 * One SDK message of a pane's runner: what the pane is doing (a turn, its
 * tasks; host.js noteSdkMessage), and in host mode a turn that ended with no
 * window connected is written into the saved workspace, so the window that
 * comes back knows it finished instead of saying it was cut off.
 */
function paneActivity(p, runner, msg) {
  if (p.runner && p.runner !== runner) return; // a runner this pane already replaced
  noteSdkMessage(p, msg, { q: runner.q || null });
  if (msg?.type === 'result') markAway(p, { busy: false, s: p.sessionId || null, away: { at: new Date().toISOString(), sessionId: p.sessionId || null } });
  // The turn's worktree is looked at again shortly; only its repository is read (2026-10-15).
  if (msg?.type === 'result' && !msg.parent_tool_use_id) { turnEnded(p); wtSoon(2500, paneCwd(p)); }
}

/**
 * A pane's turn ended on its own (a result; a Stop is skipped inside
 * takeForAutoSend). With NO window connected the engine owns the queue: it
 * sends what the window had queued as the next message, joined as pane.js
 * flushQueue joins it. With a window connected the window flushes and this
 * does nothing (see queue-hold.js for the rule). The send goes through
 * dispatch, so it waits in the pane's chain behind the send that just ended
 * (its result event and p.busy = false come first) and emits the usual events.
 */
function turnEnded(p) {
  const plan = takeForAutoSend(p, { windowConnected: !HOST_MODE || Boolean(host?.window), phone: Boolean(parsePhoneId(p.id)) });
  if (!plan) return;
  // The saved workspace: working again, and what was queued has gone out (a later window must not restore it).
  markAway(p, { busy: true, queue: [] });
  dispatch({ op: 'send', reqId: null, paneId: p.id, text: plan.text, images: plan.images, queued: plan.ids }).catch(() => {});
}

/** Patches a desktop pane's leaves in the saved workspace while no window is connected (host mode only). */
function markAway(p, patch) {
  if (!HOST_MODE || host?.window || parsePhoneId(p.id)) return;
  const next = patchWorkspaceLeaves(workspacePending || loadWorkspace(), p.id, patch);
  if (!next) return;
  // Written at once (it includes any save still pending): a window may open any moment and read the file.
  if (workspaceTimer) { clearTimeout(workspaceTimer); workspaceTimer = null; }
  workspacePending = null;
  try {
    fs.mkdirSync(path.dirname(WORKSPACE_FILE), { recursive: true });
    const tmpFile = `${WORKSPACE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(next));
    fs.renameSync(tmpFile, WORKSPACE_FILE);
  } catch (e) { process.stderr.write(`apaki host: workspace not updated (${e.message})\n`); }
}

/** The lines of the connected window: restored panes still running here are taken over (attach), not restarted. */
async function windowLine(line) {
  let c;
  try { c = JSON.parse(line); } catch { return; }
  if (!c || typeof c !== 'object') return;
  const p = c.paneId != null ? panes.get(String(c.paneId)) : null;
  await dispatch(restoreAsAttach(c, p) || c);
}

function hostWindowConnected(conn) {
  lifecycle?.windowConnected();
  const desk = [...panes.values()].filter((p) => !parsePhoneId(p.id));
  conn.send({
    ev: 'ready', version: APP_VERSION, billing: billingInfo(), model: defaults.model, effort: defaults.effort, mode: defaults.mode, pid: process.pid, voice: voiceReady(), artifacts: Boolean(openServer), codex: CODEX_FOUND, kimi: KIMI_FOUND,
    host: { pid: process.pid, startedAt: host?.startedAt || null, panes: desk.length, running: desk.filter((p) => p.runner?.running).length, working: desk.filter((p) => paneWorking(p)).length },
  });
  // What changed while no window was connected: the index lines and keep-warm marks as last sent, Glass read now.
  for (const ev of hostCache.values()) conn.send(ev);
  glassChanged().catch(() => {});
}

function hostWindowGone() {
  // The browser lives in the window: its requests fail now and work again with the next window.
  shell.goodbye('The Apaki window closed.');
  // Desktop task viewers follow files for a window that is gone; a window that comes back asks again.
  for (const id of [...viewerWatch.keys()]) if (!parsePhoneId(id)) unwatchViewer(id);
  lifecycle?.windowGone();
}

/** What the lifecycle (host.js planIdle) looks at. */
function hostView() {
  return {
    remoteOn: Boolean(remote?.state?.enabled),
    panes: [...panes.values()].map((p) => ({
      // A console (console.js) counts as open and running, and as working while a turn runs in its TUI.
      id: p.id, sessionId: p.sessionId || null, phone: Boolean(parsePhoneId(p.id)), open: Boolean(p.runner) || isCodexPane(p) || isKimiPane(p) || consoles.has(p.id), running: Boolean(p.runner?.running) || (isCodexPane(p) && Boolean(p.busy)) || consoles.has(p.id),
      busy: paneTurnBusy(p) || consoles.busy(p.id), working: paneWorking(p) || consoles.busy(p.id), tasks: p.bgTasks?.size || 0, asks: asksOf(p.id), lastActiveAt: p.lastActiveAt || 0,
      // The window's tab that holds this pane is not showing, since when (hiddenDesktopPanes); a Codex pane is never released for it.
      // A pane in its console is never released for it either (its TUI holds the conversation): it counts as a Codex one here.
      hiddenSince: hiddenSince.get(p.id) || 0, codex: isCodexPane(p) || isKimiPane(p) || consoles.has(p.id),
    })),
  };
}

/**
 * Closes an idle pane's Claude Code process and frees its session lock (no
 * window for a while, or a quit). The pane itself stays, so a window that
 * comes back reopens it from disk. Runs in the pane's queue so it never
 * interleaves with an open or attach from a window that is just coming back.
 */
function closeIdlePane(id, why = 'idle') {
  const p = panes.get(id);
  if (!p) return;
  p.queue = (p.queue || Promise.resolve()).then(async () => {
    // With a window connected only a pane whose tab is hidden closes ("Free hidden conversations"), and it is checked again here:
    // the window may have shown the tab, or the pane started a turn, since the host decided.
    const stillHidden = why === 'hidden' && hiddenSince.has(p.id) && prefs.releaseHiddenMin > 0 && !isCodexPane(p) && Boolean(p.runner?.running);
    if ((host?.window && !lifecycle?.status().quit && !stillHidden) || paneWorking(p) || asksOf(p.id)) return;
    await closeRunner(p);
    p.inTurn = false;
    if (stillHidden) process.stderr.write(`apaki host: freed the Claude Code process of hidden pane ${id}
`);
  }).catch((e) => process.stderr.write(`apaki host: closing pane ${id}: ${e.message}\n`));
}

/** hostStatus and hostQuit, from the window or a control connection (the installer). */
function hostControl(c = {}) {
  const reqId = c.reqId ?? null;
  if (!lifecycle) return { ev: c.op === 'hostQuit' ? 'hostQuit' : 'host', reqId, ok: false, host: false, message: 'This engine is not running as a background host.' };
  if (c.op === 'hostQuit') {
    if (c.now === true) {
      // Answer first, then stop everything.
      setTimeout(() => lifecycle.requestQuit({ now: true, by: String(c.by || 'a request') }), 50);
      return { ev: 'hostQuit', reqId, ok: true, now: true, pending: false };
    }
    lifecycle.requestQuit({ by: String(c.by || 'a request') });
    const plan = lifecycle.tick();
    return { ev: 'hostQuit', reqId, ok: true, pending: !lifecycle.exiting, waiting: plan?.waiting || [] };
  }
  const st = lifecycle.status();
  return {
    ev: 'host', reqId, ok: true, host: true, app: HOST_APP_ID, pid: process.pid, startedAt: host?.startedAt || null, window: Boolean(host?.window),
    remoteOn: Boolean(remote?.state?.enabled), quit: st.quit, exiting: st.exiting, idleCloseMs: st.idleCloseMs, exitGraceMs: st.exitGraceMs, panes: hostView().panes,
    // 2026-10-15: the event loop's delay and the processes started per minute (perf.js), and where worktrees are read.
    perf: { ...perf.status(), worktrees: { mode: wtIndex.mode, gitSpawns: wtIndex.spawns } },
  };
}

/** Starts listening for windows (host mode): the address and token go to the host file (host.js). */
async function startHostMode() {
  host = new HostServer({
    appId: HOST_APP_ID,
    file: hostFile(HOST_APP_ID),
    root: ENGINE_ROOT,
    stamp: engineStamp(fileURLToPath(import.meta.url)),
    onConnect: hostWindowConnected,
    onLine: (line) => { windowLine(line).catch((e) => process.stderr.write(`apaki host: ${e.message}\n`)); },
    onGone: hostWindowGone,
    control: (c) => hostControl(c),
  });
  // Everything this host loaded from disk; a newer build copied in under it (an update installed while Apaki is
  // open) makes the host move to it once idle (host.js codeStamp, 2026-10-12).
  const codePaths = [
    path.join(ENGINE_ROOT, 'apaki', 'engine'), path.join(ENGINE_ROOT, 'apaki', 'remote'),
    path.join(ENGINE_ROOT, 'apaki', 'scripts', 'build-web.mjs'), path.join(ENGINE_ROOT, 'apaki', 'web', 'src'),
    path.join(ENGINE_ROOT, 'src'), path.join(ENGINE_ROOT, 'src', 'ui'),
  ];
  const startedCode = codeStamp(codePaths);
  lifecycle = createLifecycle({
    view: hostView,
    closeIdle: closeIdlePane,
    // Minutes hidden and idle before a tab's conversation lets go of its Claude Code process (Settings, prefs.js releaseHiddenMin).
    // (APAKI_HOST_HIDE_MS shortens it for tests, only while the setting is on, like APAKI_HOST_IDLE_MS.)
    hideCloseMs: () => ((prefs.releaseHiddenMin || 0) > 0 && Number(process.env.APAKI_HOST_HIDE_MS) > 0 ? Number(process.env.APAKI_HOST_HIDE_MS) : (prefs.releaseHiddenMin || 0) * 60 * 1000),
    codeChanged: () => codeStamp(codePaths) !== startedCode,
    exit: (reason) => {
      // The window hears why first, so it says "updating" rather than "lost the engine" while it reconnects.
      if (reason === 'update') { emit({ ev: 'engineRestarting', why: 'update' }); setTimeout(() => shutdown(reason), 150); return; }
      shutdown(reason);
    },
    log: (line) => process.stderr.write(`apaki host: ${line}\n`),
  });
  await host.start();
  process.stderr.write(`apaki host: ${HOST_APP_ID} listening (pid ${process.pid})\n`);
}

if (HOST_MODE) {
  try {
    await startHostMode();
  } catch (e) {
    process.stderr.write(`apaki host: could not start (${e.message})\n`);
    process.exit(1);
  }
}
