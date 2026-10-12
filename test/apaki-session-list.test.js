/**
 * The sidebar's session list in the ChatGPT app's manner, folders that open in place, the session menu and Details
 * (2026-10-12; apaki/ui/sessionlist.js, wired in app.js, native.js and web.css). Arthur: "the folders should expand
 * when clicked on and contract when clicked on again ... the sessions listed should be a bit more compact but when
 * selected or right clicked have more information available ... with the accurate timestamp, with the name, showing
 * full name and additional information on hover, and all information available somewhere in details/properties".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  agoText, bytesText, createOpenState, detailLine, detailsHtml, exactTime, folderMenuItems, groupRows, leadHtml, leadOf, modelName, navKey, recencyGroup,
  rowStates, rowTip, sessionFacts, sessionMenuItems, shortTime,
} from '../apaki/ui/sessionlist.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Tuesday 13 October 2026, 10:42 local time (the demo harness's clock).
const NOW = new Date(2026, 9, 13, 10, 42, 0).getTime();
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min, 0).getTime();
// ICU puts a narrow no-break space before AM and PM; the tests read it as a space.
const plain = (s) => String(s).replace(/\s/g, ' ');
const SID = '0e7f4b4e-1111-2222-3333-444455556666';
const values = (items) => items.filter((x) => !x.divider && !x.heading).map((x) => x.value);
const labels = (items) => items.filter((x) => !x.divider && !x.heading).map((x) => x.label);

test('recency groups: Today, Yesterday, Previous 7 days, Previous 30 days, then each month (with the year when it is another)', () => {
  const g = (ms) => recencyGroup(ms, NOW, 'en-US');
  assert.deepEqual(g(at(2026, 10, 13, 0, 1)), { key: 'today', label: 'Today' });
  assert.deepEqual(g(NOW + 5 * 60000), { key: 'today', label: 'Today' }, 'a clock a little ahead is still today');
  assert.deepEqual(g(at(2026, 10, 12, 23, 59)), { key: 'yesterday', label: 'Yesterday' });
  assert.equal(g(at(2026, 10, 6)).key, 'week', 'seven days ago');
  assert.equal(g(at(2026, 10, 6)).label, 'Previous 7 days');
  assert.deepEqual(g(at(2026, 10, 5)), { key: 'month', label: 'Previous 30 days' });
  assert.equal(g(at(2026, 9, 13)).key, 'month', 'thirty days ago');
  assert.deepEqual(g(at(2026, 9, 12)), { key: 'm:2026-09', label: 'September' });
  assert.deepEqual(g(at(2025, 12, 24)), { key: 'm:2025-12', label: 'December 2025' });
  assert.deepEqual(g(0), { key: 'undated', label: 'Earlier' });
});

test('groupRows: Pinned first, then the groups newest first, rows newest first in each', () => {
  const rows = [
    { id: 'old', lastModified: at(2026, 8, 2) },
    { id: 'today2', lastModified: at(2026, 10, 13, 9) },
    { id: 'pin', lastModified: at(2026, 7, 1), pinned: true },
    { id: 'today1', lastModified: at(2026, 10, 13, 10) },
    { id: 'yest', lastModified: at(2026, 10, 12) },
    { id: 'week', lastModified: at(2026, 10, 9) },
    { id: 'aug', lastModified: at(2026, 8, 20) },
  ];
  const groups = groupRows(rows, NOW, { locale: 'en-US' });
  assert.deepEqual(groups.map((x) => x.label), ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'August']);
  assert.deepEqual(groups.map((x) => x.rows.map((r) => r.id)), [['pin'], ['today1', 'today2'], ['yest'], ['week'], ['aug', 'old']]);
  // Without Pinned (the Archived view) a pinned row sits in its time group.
  assert.deepEqual(groupRows(rows, NOW, { pinned: false, locale: 'en-US' }).map((x) => x.label), ['Today', 'Yesterday', 'Previous 7 days', 'August', 'July']);
  assert.deepEqual(groupRows([], NOW), []);
});

test('shortTime: now, minutes, the clock today (and yesterday under Yesterday), weekday and time this week, then the date', () => {
  const t = (ms, o = {}) => plain(shortTime(ms, NOW, { locale: 'en-US', ...o }));
  assert.equal(t(NOW - 20 * 1000), 'now');
  assert.equal(t(NOW - 12 * 60000), '12m');
  assert.equal(t(at(2026, 10, 13, 9, 5)), '9:05 AM');
  assert.equal(t(at(2026, 10, 12, 14, 32)), '2:32 PM', 'under Yesterday the clock says enough');
  assert.equal(t(at(2026, 10, 12, 14, 32), { grouped: false }), 'Mon 2:32 PM', 'a search hit has no heading to lean on');
  assert.equal(t(at(2026, 10, 8, 16, 0)), 'Thu 4:00 PM');
  assert.equal(t(at(2026, 10, 6, 16, 0)), 'Oct 6');
  assert.equal(t(at(2026, 9, 1)), 'Sep 1');
  assert.equal(t(at(2025, 12, 24)), 'Dec 24, 2025');
  assert.equal(t(0), '');
});

test('exact time, ago, bytes and model names', () => {
  const exact = plain(exactTime(at(2026, 10, 12, 14, 32), 'en-US'));
  assert.match(exact, /^Monday, October 12, 2026 at 2:32:00 PM$/);
  assert.equal(exactTime(0), '');
  assert.equal(agoText(NOW - 10 * 1000, NOW), 'just now');
  assert.equal(agoText(NOW - 60 * 1000, NOW), '1 minute ago');
  assert.equal(agoText(NOW - 3 * 3600 * 1000, NOW), '3 hours ago');
  assert.equal(agoText(NOW - 2 * 86400 * 1000, NOW), '2 days ago');
  assert.equal(agoText(NOW - 90 * 86400 * 1000, NOW), '3 months ago');
  assert.equal(agoText(NOW - 800 * 86400 * 1000, NOW), '2 years ago');
  assert.equal(bytesText(0), '');
  assert.equal(bytesText(812), '812 B');
  assert.equal(bytesText(14 * 1024), '14 KB');
  assert.equal(bytesText(2.1 * 1024 * 1024), '2.1 MB');
  assert.equal(bytesText(40 * 1024 * 1024), '40 MB');
  assert.equal(bytesText(1.25 * 1024 ** 3), '1.3 GB');
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(modelName('claude-haiku-4'), 'Haiku 4');
  assert.equal(modelName('claude-opus-5-5[1m]'), 'Opus 5.5 (1M)');
  assert.equal(modelName('gpt-5.5-codex'), 'gpt-5.5-codex');
});

test('row states: working, waiting for an answer, a terminal, Codex, an archived copy; quiet words, never more than they mean', () => {
  const k = (s, live, o) => rowStates(s, live, o).map((x) => x.k);
  assert.deepEqual(k({ id: 'a' }), []);
  assert.deepEqual(k({ id: 'a', running: true }), ['working']);
  assert.deepEqual(k({ id: 'a' }, { runningHere: true }), ['working']);
  assert.deepEqual(k({ id: 'a', running: true }, { waiting: true }), ['waiting'], 'waiting for you says more than working');
  assert.deepEqual(k({ id: 'a', terminal: { name: 'Windows Terminal', status: 'working' } }), ['working', 'terminal']);
  assert.deepEqual(k({ id: 'a', terminal: { name: 'Windows Terminal', status: 'waiting' } }), ['waiting', 'terminal']);
  assert.deepEqual(k({ id: 'a', terminal: { name: 'Windows Terminal', status: 'idle' } }), ['terminal']);
  assert.deepEqual(k({ id: 'codex:x', codex: true, archivedCopy: true }), ['codex', 'archived-copy']);
  assert.deepEqual(k({ id: 'a', pinned: true }), [], 'under Pinned it is already said');
  assert.deepEqual(k({ id: 'a', pinned: true }, {}, { showPinned: true }), ['pinned']);
  assert.match(rowStates({ terminal: { name: 'Windows Terminal', status: 'waiting' } })[1].label, /Open in Windows Terminal, waiting/);
});

test('the leading glyph (Glass\'s list): one per row, the provider\'s mark or the most urgent state, in the provider\'s colour', () => {
  const k = (s, live) => { const l = leadOf(s, live); return `${l.k}/${l.provider}`; };
  assert.equal(k({ id: SID }), 'mark/claude');
  assert.equal(k({ id: 'codex:019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8', codex: true }), 'mark/codex');
  assert.equal(k({ id: SID, running: true }), 'working/claude');
  assert.equal(k({ id: SID, running: true, terminal: { name: 'Windows Terminal', status: 'working' } }), 'working/claude', 'working says more than the terminal');
  assert.equal(k({ id: SID, terminal: { name: 'Windows Terminal', status: 'idle' } }), 'terminal/claude');
  assert.equal(k({ id: SID, running: true }, { waiting: true }), 'waiting/claude', 'waiting for you says the most');
  assert.equal(k({ id: SID, archivedCopy: true }), 'archived-copy/claude');
  assert.equal(k({ id: SID, pinned: true }), 'mark/claude', 'pinned is a quiet mark after the name, not the lead');
  assert.equal(leadOf({ id: SID, running: true }).label, 'Claude Code: Working');
  assert.match(leadHtml({ id: SID }), /^<span class="sr-lead sr-mark is-claude" role="img" aria-label="Claude Code"><svg class="sg sg-claude"/);
  assert.match(leadHtml({ id: 'codex:x', codex: true, running: true }), /class="sr-lead sr-working is-codex"[^>]*><svg class="sg sg-spin"/);
  assert.match(leadHtml({ id: SID }, { waiting: true }), /class="sr-lead sr-waiting is-claude"/);
});

test('the hover card: full name, exact time, folder, branch or worktree, agent, model, size and state', () => {
  const s = { id: SID, title: 'Fix the flaky checkout test in the payments service and the cart', lastModified: at(2026, 10, 13, 9, 5), cwd: 'C:\\acme\\web', branch: 'main', size: 2.1 * 1024 * 1024, model: 'claude-opus-5-5', subagents: 2, terminal: { name: 'Windows Terminal', status: 'working' } };
  const tip = rowTip(s, { now: NOW, locale: 'en-US', folderName: 'Checkout' });
  assert.equal(tip.head, s.title, 'the full name, not the cut one');
  const rows = Object.fromEntries(tip.rows);
  assert.match(plain(rows['Last message']), /^Tuesday, October 13, 2026 at 9:05:00 AM \(2 hours ago\)$/);
  assert.equal(rows.Folder, 'C:\\acme\\web');
  assert.equal(rows.Branch, 'main');
  assert.equal(rows.Agent, 'Claude Code');
  assert.equal(rows.Model, 'Opus 5.5');
  assert.equal(rows.Size, '2.1 MB');
  assert.equal(rows['In folder'], 'Checkout');
  assert.match(rows.State, /Working · Open in Windows Terminal, working · 2 subagents/);
  assert.match(tip.hint, /Right-click: more/);
  const wt = Object.fromEntries(rowTip({ ...s, codex: true }, { now: NOW, branch: 'fix-checkout', worktree: 'C:\\acme\\web.worktrees\\fix' }).rows);
  assert.equal(wt.Worktree, 'fix-checkout · C:\\acme\\web.worktrees\\fix');
  assert.equal(wt.Agent, 'Codex');
  assert.equal(rowTip(s, { web: true }).hint, '', 'no click words on a phone');
  assert.equal(detailLine(s, { shortPath: (p) => p.replace('C:\\acme', '~'), folderName: 'Checkout' }), '~\\web · main · Opus 5.5 · 2.1 MB · in Checkout');
  assert.equal(detailLine({ id: 'x' }), '');
});

test('the session menu covers what a person does with a session, and says why when something cannot apply', () => {
  const s = { id: SID, title: 'Fix the flaky checkout test', cwd: 'C:\\acme\\web' };
  const items = sessionMenuItems(s, { folderName: 'Checkout', shortCwd: '~\\web' });
  assert.equal(items[0].heading, 'Fix the flaky checkout test');
  assert.deepEqual(values(items), ['open', 'split', 'tab', 'here', 'terminal', 'rename', 'pin', 'move', 'fork', 'archive', 'ask', 'export', 'copy-id', 'copy-resume', 'reveal', 'details']);
  assert.deepEqual(labels(items), ['Open', 'Open beside', 'Open in a new tab', 'Open here', 'Open in a terminal', 'Rename…', 'Pin to top', 'Move to folder…', 'Fork into a new conversation', 'Archive', 'Ask Claude about it', 'Export as Markdown', 'Copy session id', 'Copy resume command', 'Show folder in Explorer', 'Details']);
  const hint = (v) => items.find((x) => x.value === v)?.hint;
  assert.equal(hint('split'), 'Shift+click');
  assert.equal(hint('tab'), 'Ctrl+click');
  assert.equal(hint('terminal'), 'claude --resume');
  assert.equal(hint('move'), 'in Checkout');
  assert.equal(hint('details'), 'Alt+Enter');
  assert.equal(hint('rename'), 'F2');
  // Open in a pane here and working: Show it, Open in a terminal with the pane's settings (engine openTerminal), Stop, Close.
  const busy = sessionMenuItems(s, { pane: { busy: true } });
  assert.deepEqual(values(busy).slice(0, 4), ['open', 'terminal', 'stop', 'close']);
  assert.equal(busy.find((x) => x.label === 'Show it')?.value, 'open');
  assert.equal(busy.find((x) => x.value === 'terminal').hint, 'with this pane\'s settings');
  assert.equal(busy.find((x) => x.value === 'stop').hint, 'stop Claude here (Esc)');
  assert.ok(!values(busy).includes('split') && !values(busy).includes('tab'));
  // Running in the background (no pane here): Stop stops its turn; a terminal's own turn is stopped there.
  assert.equal(sessionMenuItems({ ...s, running: true }).find((x) => x.value === 'stop').hint, 'stop its running turn');
  const term = sessionMenuItems({ ...s, terminal: { name: 'Windows Terminal', status: 'working' } }).find((x) => x.label === 'Stop');
  assert.equal(term.value, null);
  assert.match(term.disabled, /stop it there/);
  assert.equal(sessionMenuItems(s).some((x) => x.label === 'Stop'), false, 'nothing running: no Stop');
  // Pinned, archived, Codex, an archived copy, subagents.
  assert.ok(values(sessionMenuItems({ ...s, pinned: true })).includes('unpin'));
  assert.ok(values(sessionMenuItems({ ...s, archived: true })).includes('unarchive'));
  const codex = sessionMenuItems({ id: 'codex:019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8', codex: true, codexArchived: true, title: 'Rate limiter' });
  assert.equal(codex.find((x) => x.value === 'terminal').hint, 'codex resume');
  assert.equal(codex.find((x) => x.value === 'copy-resume').hint, 'codex resume');
  assert.match(codex.find((x) => x.label === 'Archived in Codex').disabled, /Codex app/);
  assert.ok(!values(codex).includes('reveal'), 'no folder: nothing to show');
  const copy = sessionMenuItems({ ...s, archivedCopy: true });
  assert.ok(!values(copy).includes('fork'));
  assert.match(copy.find((x) => x.label === 'Open in a terminal').disabled, /restore it first/);
  assert.equal(sessionMenuItems(s, { subagents: 3 }).find((x) => x.value === 'subs').label, 'Show its subagents (3)');
  assert.equal(sessionMenuItems(s, { subagents: 3, subsOpen: true }).find((x) => x.value === 'subs').label, 'Hide its subagents');
  assert.match(sessionMenuItems(s, { tabFull: true }).find((x) => x.value === 'split').hint, /new tab/);
});

test('the folder menu: open or close, show it alone, and on the PC rename and delete', () => {
  const f = { id: 'ab12cd34', name: 'Checkout' };
  assert.deepEqual(values(folderMenuItems(f)), ['toggle', 'alone', 'rename', 'delete']);
  assert.equal(folderMenuItems(f, { open: true }).find((x) => x.value === 'toggle').label, 'Close');
  assert.equal(folderMenuItems(f, { shownAlone: true }).find((x) => x.value === 'alone').label, 'Show all sessions');
  assert.deepEqual(values(folderMenuItems(f, { web: true })), ['toggle', 'alone'], 'renaming and deleting folders stay on the PC');
});

test('which folders are open: toggled, kept in storage, restored, pruned', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let changes = 0;
  const st = createOpenState(storage, { onChange: () => { changes += 1; } });
  assert.equal(st.isOpen('a'), false);
  assert.equal(st.toggle('a'), true);
  st.set('b', true);
  st.set('b', true);
  assert.deepEqual(JSON.parse(store.get('apaki.folders.open')), ['a', 'b']);
  assert.equal(changes, 2, 'setting what is already set changes nothing');
  assert.equal(st.toggle('a'), false);
  const again = createOpenState(storage);
  assert.deepEqual(again.list(), ['b'], 'it comes back after a restart');
  again.load(['c', 'd', 7]);
  assert.deepEqual(again.list(), ['c', 'd']);
  again.prune(['d', 'e']);
  assert.deepEqual(again.list(), ['d'], 'a deleted folder is forgotten');
  assert.deepEqual(createOpenState({ getItem: () => '{broken' }).list(), []);
  assert.deepEqual(createOpenState(null).list(), []);
});

test('keys: arrows move, Enter or Space opens a session and toggles a folder, Right and Left open and close, menu, details, rename', () => {
  const k = (key, o = {}, mods = {}) => navKey({ key, ...mods }, o);
  assert.deepEqual(k('ArrowDown'), { act: 'move', by: 1 });
  assert.deepEqual(k('ArrowUp'), { act: 'move', by: -1 });
  assert.deepEqual(k('Home'), { act: 'move', by: 'first' });
  assert.deepEqual(k('End'), { act: 'move', by: 'last' });
  assert.deepEqual(k('Enter'), { act: 'open' });
  assert.deepEqual(k(' '), { act: 'open' });
  assert.deepEqual(k('Enter', { kind: 'folder' }), { act: 'toggle' });
  assert.deepEqual(k(' ', { kind: 'folder' }), { act: 'toggle' });
  assert.deepEqual(k('ArrowRight', { kind: 'folder' }), { act: 'expand', by: 1 });
  assert.deepEqual(k('ArrowRight', { kind: 'folder', open: true }), { act: 'move', by: 1 });
  assert.deepEqual(k('ArrowLeft', { kind: 'folder', open: true }), { act: 'collapse' });
  assert.equal(k('ArrowLeft', { kind: 'folder' }), null);
  assert.deepEqual(k('ArrowLeft', { inFolder: true }), { act: 'parent' });
  assert.equal(k('ArrowLeft'), null);
  assert.deepEqual(k('ContextMenu'), { act: 'menu' });
  assert.deepEqual(k('F10', {}, { shiftKey: true }), { act: 'menu' });
  assert.deepEqual(k('Enter', {}, { altKey: true }), { act: 'details' });
  assert.deepEqual(k('F2', { kind: 'folder' }), { act: 'rename' });
  assert.equal(k('a'), null);
  assert.equal(k('ArrowDown', {}, { ctrlKey: true }), null, 'Ctrl+arrows are not the list\'s');
});

test('Details: every fact in sections, the list\'s at once and the engine\'s when they arrive; copy buttons for id, folder, transcript, resume', () => {
  const s = { id: SID, title: 'Fix the flaky checkout test', cwd: 'C:\\acme\\web', branch: 'main', lastModified: at(2026, 10, 13, 9, 5), size: 2048, firstPrompt: 'Why does checkout fail?', subagents: 2, terminal: { name: 'Windows Terminal', status: 'working', pid: 4120 }, pinned: true };
  const pending = sessionFacts(s, null, { now: NOW, locale: 'en-US' });
  assert.equal(pending.reading, true);
  const find = (f, k) => f.sections.flatMap((x) => x.rows).find((r) => r.k === k);
  assert.equal(find(pending, 'Session id').v, SID);
  assert.equal(find(pending, 'Prompts and replies').v, 'Reading…');
  assert.equal(find(pending, 'Pinned').v, 'Yes');
  assert.match(find(pending, 'Terminal').v, /Windows Terminal, working \(pid 4120\)/);
  assert.equal(pending.copies.resume, `cd "C:\\acme\\web" && claude --resume ${SID}`);
  const info = {
    provider: 'claude', created: at(2026, 10, 10, 9), lastActive: at(2026, 10, 13, 9, 5), prompts: 12, replies: 30, toolCalls: 88, compactions: 1,
    model: 'claude-opus-5-5', models: ['claude-sonnet-4-5', 'claude-opus-5-5'], version: '2.1.90', gitBranch: 'fix-checkout', lastCwd: 'C:\\acme\\web\\packages\\cart',
    tokens: { input: 1200, output: 34000, cacheRead: 900000, cacheWrite: 5000 }, size: 4096, sideSize: 1024, totalSize: 5120,
    transcript: `C:\\Users\\me\\.claude\\projects\\C--acme-web\\${SID}.jsonl`, subagents: 3, shells: 2, shellsRunning: 1,
    panes: [{ where: 'phone', model: 'claude-opus-5-5', effort: 'high', mode: 'plan', billing: 'Team plan', running: true }], customTitle: 'Checkout flake',
  };
  const f = sessionFacts(s, info, { now: NOW, locale: 'en-US', folderName: 'Checkout' });
  assert.equal(f.reading, false);
  assert.equal(f.title, 'Checkout flake', 'the name Claude Code saved wins');
  assert.deepEqual(f.sections.map((x) => x.title), ['Conversation', 'Where', 'Activity', 'Model', 'State', 'Size on disk']);
  assert.equal(find(f, 'Agent').v, 'Claude Code 2.1.90');
  assert.equal(find(f, 'First prompt').v, 'Why does checkout fail?');
  assert.equal(find(f, 'Branch').v, 'fix-checkout');
  assert.equal(find(f, 'Last ran in').v, 'C:\\acme\\web\\packages\\cart');
  assert.equal(find(f, 'In folder').v, 'Checkout');
  assert.equal(find(f, 'Transcript').copy, 'transcript');
  assert.match(plain(find(f, 'Started').v), /^Saturday, October 10, 2026 at 9:00:00 AM$/);
  assert.match(plain(find(f, 'Last message').v), /\(2 hours ago\)$/);
  assert.equal(find(f, 'Prompts').v, '12');
  assert.equal(find(f, 'Replies').v, '30');
  assert.equal(find(f, 'Tool calls').v, '88');
  assert.equal(find(f, 'Compactions').v, '1');
  assert.equal(find(f, 'Tokens').v, '34,000 out · 1,200 in · 900,000 cache read · 5,000 cache write');
  assert.equal(find(f, 'Model').v, 'Opus 5.5');
  assert.equal(find(f, 'Models used').v, 'Sonnet 4.5, Opus 5.5');
  assert.equal(find(f, 'Effort').v, 'high');
  assert.equal(find(f, 'Permissions').v, 'Plan mode', 'in the words of the mode picker');
  assert.equal(find(f, 'Listed as').v, 'Fix the flaky checkout test', 'the list\'s name, when Claude Code saved another');
  assert.equal(find(pending, 'Listed as'), undefined);
  assert.equal(find(f, 'Billed to').v, 'Team plan');
  assert.equal(find(f, 'In Apaki').v, 'on a phone, working');
  assert.equal(find(f, 'Subagents').v, '3');
  assert.equal(find(f, 'Background shells').v, '2, 1 running');
  assert.equal(find(f, 'Archived').v, 'No');
  assert.equal(find(f, 'Subagents and tool output').v, '1 KB');
  assert.equal(find(f, 'Total').v, '5 KB');
  assert.equal(f.copies.transcript, info.transcript);
  // A pane here says more than the engine's list of panes: its own model, effort and billing.
  const here = sessionFacts(s, info, { now: NOW, pane: { model: 'claude-sonnet-4-5', effort: 'max', mode: 'acceptEdits', billing: 'API key', busy: false } });
  assert.equal(find(here, 'Model').v, 'Sonnet 4.5');
  assert.equal(find(here, 'In Apaki').v, 'Open in a pane here');
  // The engine could not read it: the list's facts stay, and the reason shows.
  const bad = sessionFacts(s, { error: 'Could not read it: EBUSY' }, { now: NOW });
  assert.equal(bad.error, 'Could not read it: EBUSY');
  assert.equal(find(bad, 'Session id').v, SID);
  // Codex: its rollout, its approvals, codex resume.
  const cx = sessionFacts({ id: 'codex:019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8', codex: true, title: 'Rate limiter', cwd: 'C:\\acme\\api' }, { provider: 'codex', transcript: 'C:\\x\\rollout.jsonl', approval: 'on-request', sandbox: 'workspace-write', effort: 'high', model: 'gpt-5.5-codex', prompts: 1, replies: 1 }, { now: NOW });
  assert.equal(find(cx, 'Rollout').v, 'C:\\x\\rollout.jsonl');
  assert.equal(find(cx, 'Codex approvals').v, 'on-request · workspace-write');
  assert.equal(cx.copies.resume, 'cd "C:\\acme\\api" && codex resume 019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8');
});

test('Details HTML: escaped, copy buttons named by what they copy, Show for the folder on the PC, Export on the PC only', () => {
  const s = { id: SID, title: '<b>Fix</b> "it"', cwd: 'C:\\acme\\web', lastModified: NOW };
  const f = sessionFacts(s, { transcript: 'C:\\t.jsonl', prompts: 1, replies: 1 }, { now: NOW });
  const html = detailsHtml(f);
  assert.match(html, /<h2 class="sd-title">&lt;b&gt;Fix&lt;\/b&gt; &quot;it&quot;<\/h2>/);
  assert.match(html, /data-copy="id"/);
  assert.match(html, /data-copy="cwd"/);
  assert.match(html, /data-copy="transcript"/);
  assert.match(html, /data-copy="resume"/);
  assert.match(html, /data-act="reveal"/);
  assert.match(html, /data-act="export"/);
  assert.match(html, /data-k="x"/);
  const phone = detailsHtml(sessionFacts(s, null, { now: NOW, web: true }), { web: true });
  assert.equal(/data-act="(reveal|export)"/.test(phone), false, 'the phone opens nothing on the PC from here');
  assert.match(phone, /Reading…/);
});

test('wiring: folders open in place, the list is grouped and compact, the menus, Details, the phone', () => {
  const app = read('../apaki/ui/app.js');
  // A folder click opens it in place; the old filter view is in the folder's menu, not on the click.
  assert.match(app, /li\.onclick = \(e\) => \{ if \(e\.detail > 1\) return; toggleFolder\(f\.id\); \};/);
  assert.equal(/li\.onclick = \(\) => \{ S\.view = S\.view === f\.id \? 'all' : f\.id; renderRail\(\); \};/.test(app), false);
  assert.match(app, /requestAnimationFrame\(\(\) => item\.classList\.toggle\('open', next\)\)/);
  assert.match(app, /folderDropTarget\(item, \(sid\) => moveToFolder\(sid, f\.id\)\)/, 'drop a session on an open or closed folder');
  assert.match(app, /foldersOpen: folderOpen\.list\(\)/);
  assert.match(app, /folderOpen\.load\(saved\.rail\.foldersOpen\)/);
  // Rows: grouped by recency, compact, a hover card, the menu from right click, the ... button and the keys.
  assert.match(app, /groupRows\(rows\.slice\(0, 400\), Date\.now\(\), \{ pinned: S\.view !== 'archived' \}\)/);
  assert.match(app, /setTip\(li, rowTip\(s, /);
  assert.match(app, /li\.oncontextmenu = \(e\) => sessionMenu\(s, e, li\);/);
  assert.match(app, /sessionMenu\(s, \{ preventDefault\(\) \{\}, clientX: r\.left, clientY: r\.bottom \}, li\);/);
  assert.match(app, /wireListKeys\(\$\('sessions'\)\);\nwireListKeys\(\$\('folders'\)\);/);
  assert.match(app, /const items = sessionMenuItems\(s, \{/);
  for (const v of ['terminal', 'pin', 'move', 'ask', 'export', 'details', 'subs']) assert.match(app, new RegExp(`v === '${v}'`), v);
  // Open in a terminal sends the console toggle's op (built in another branch): the session, its kind, and its pane here.
  assert.match(app, /send\('openTerminal', \{ sessionId: s\.id, kind: s\.codex \? 'codex' : 'claude', \.\.\.\(pane && !pane\.isViewer \? \{ paneId: pane\.id \} : \{\}\) \}\)/);
  assert.match(app, /send\('pin', \{ sessionId: s\.id, pinned: on \}\)/);
  assert.match(app, /send\('sessionInfo', \{ sessionId: s\.id \}\)/);
  assert.match(app, /case 'sessionInfo':/);
  assert.match(app, /case 'exported':/);
  // The phone's menu: Details, Pin, Ask Claude, Export; still nothing that reaches the PC's screen or another window.
  const phoneMenu = app.slice(app.indexOf('function phoneSessionMenu'), app.indexOf('if (WEB) {\n  // The ... button'));
  assert.match(phoneMenu, /gated\('pin', /);
  assert.match(phoneMenu, /value: 'details', label: 'Details'/);
  assert.match(phoneMenu, /value: 'ask', label: 'Ask Claude about it'/);
  assert.match(phoneMenu, /phoneCan\('exportSession'\)/);
  assert.equal(/stopSession|revealFolder|openExternal|digPrompt|openTerminal|'terminal'/.test(phoneMenu), false, 'no Open in a terminal on the phone');
  const native = read('../apaki/web/src/native.js');
  assert.match(native, /for \(const list of \[\$\('sessions'\), \$\('folders'\)\]\) if \(list\) longPressOn\(list\);/);
  assert.match(native, /closest\?\.\('li\[data-id\], \.folder-row\[data-folder\]'\)/);
  const web = read('../apaki/web/src/web.css');
  assert.match(web, /body\.web\.native \.srow \.sr-line \{ min-height: 48px;/, 'rows a finger tall');
  assert.match(web, /body\.web\.native \.folder-row \{ height: 48px;/);
  // The styles: grid rows for the height (not height itself), reduced motion, no new pixel font sizes, no dot pills.
  const css = read('../apaki/ui/app.css');
  const mine = css.slice(css.indexOf('/* ---------- the session list, compact'));
  assert.match(mine, /\.folder-kids \{ display: grid; grid-template-rows: 0fr; transition: grid-template-rows 200ms/);
  assert.match(mine, /@media \(prefers-reduced-motion: reduce\) \{\n  \.srow \.sr-lead \.arc \{ animation: none; \}/);
  // Glass's list: a soft fill for hover and selection (no borders), a hairline only between groups, provider colours.
  assert.match(mine, /li\.srow\.on,\n:root :is\(\.sessions, \.folder-sess\) li\.srow\.menu-open \{ background: var\(--sl-raise-2\); box-shadow: inset 0 0 0 1px var\(--sl-raise-2\); border: 0; \}/);
  assert.match(mine, /--sl-claude: #d97757;/);
  assert.match(mine, /--sl-codex: #10a37f;/);
  assert.match(mine, /\.sessions li\.sr-group:first-child \{ margin-top: 0; padding-top: 2px; border-top: 0; \}/);
  assert.equal(/font-size:\s*\d+px|font:[^;]*\d+px/.test(mine), false, 'type sizes come from the --fs tokens');
  assert.equal(/transition:[^;]*\b(height|max-height)\b/.test(mine), false, 'no layout property is animated');
  assert.equal(/border-left:\s*[1-9]/.test(mine), false, 'nothing down a left edge');
  for (const f of ['../apaki/ui/sessionlist.js', '../apaki/ui/app.js', '../apaki/ui/app.css', '../apaki/web/src/web.css', '../apaki/web/src/native.js', '../apaki/engine/session-info.js', '../apaki/engine/pins.js']) {
    const text = read(f);
    assert.equal(text.includes(String.fromCharCode(0x2014)) || text.includes(String.fromCharCode(0x2015)), false, `${f} has no em dash`);
  }
});
