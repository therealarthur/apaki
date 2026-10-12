/**
 * Git worktrees in the window and on the phone page (2026-10-12; apaki/ui/worktree.js and diff.js, wired in app.js,
 * pane.js, startfolder.js, index.html, and on the phone in apaki/web/src/pager.js and web.css). The model is pure, so it
 * is tested as it runs; the controller runs against a stand-in for app.js; the wiring is checked the way
 * apaki-phone-ui.test.js checks the phone's: the build ships the new modules, and the files that must call them do.
 *
 *   the model       which worktree a folder is in (deepest wins), the label "fix-checkout +42 -7", trouble words,
 *                   the sidebar rows, the menu and what it dims for a phone without Full access, the branch name
 *                   suggested from a first message, patches read into numbered lines
 *   the controller  answers matched by request id, a refusal arriving as an error, the state the event carries,
 *                   the folded repositories remembered, the tab tooltip
 *   the wiring      the Worktrees view, the branch label, the New worktree switch, the + menu, the diff viewer saved
 *                   and restored with the tab, the phone's nav row, and the phone shows everything the desktop does
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as W from '../apaki/ui/worktree.js';
import { numbersOf, splitPath } from '../apaki/ui/diff.js';
import { build } from '../apaki/scripts/build-web.mjs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const WT = (path, branch, o = {}) => ({ path, head: 'a1c4e7b2', branch, detached: false, bare: false, locked: null, prunable: null, main: false, stats: true, base: 'main', added: 0, removed: 0, files: 0, changed: 0, conflicts: 0, behind: 0, ahead: 0, unpushed: 0, merged: false, upstream: '', aheadUp: 0, behindUp: 0, ...o });
const REPO = {
  id: 'c:/code/acme/.git', name: 'acme', root: 'C:\\code\\acme', base: 'main', branches: ['main', 'fix-checkout'], linked: true,
  worktrees: [
    WT('C:\\code\\acme', 'main', { main: true }),
    WT('C:\\code\\acme\\.claude\\worktrees\\agent-1', 'worktree-agent-1', { added: 5, removed: 1, files: 2, changed: 1, locked: 'claude agent' }),
    WT('C:\\code\\acme.worktrees\\fix-checkout', 'fix-checkout', { added: 42, removed: 7, files: 5, changed: 2, ahead: 3, unpushed: 3 }),
    WT('C:\\code\\acme.worktrees\\old', 'old-feature', { merged: true, ahead: 0 }),
    WT('C:\\code\\acme.worktrees\\late', 'late', { behind: 4, ahead: 1, added: 3 }),
  ],
};
const LONE = { id: 'c:/code/lone/.git', name: 'lone', root: 'C:\\code\\lone', base: '', branches: [], linked: false, light: true, worktrees: [WT('C:\\code\\lone', 'main', { main: true, stats: false })] };
const REPOS = [REPO, LONE];

/* ---------- the model ---------- */

test('which worktree a folder is in: the deepest, written either way round, any drive letter case', () => {
  const f = (cwd) => W.wtFor(REPOS, cwd);
  assert.equal(f('C:\\code\\acme').wt.branch, 'main');
  assert.equal(f('C:/code/acme/src/deep').wt.branch, 'main');
  assert.equal(f('c:\\CODE\\acme.worktrees\\fix-checkout\\apaki').wt.branch, 'fix-checkout');
  assert.equal(f('C:\\code\\acme\\.claude\\worktrees\\agent-1\\x').wt.branch, 'worktree-agent-1', 'a worktree under the main checkout is its own, not the main one');
  assert.equal(f('C:\\code\\acme-other'), null, 'a sibling that shares a prefix is not inside');
  assert.equal(f('C:\\code\\lone').repo.name, 'lone');
  assert.equal(f(''), null);
  assert.equal(f(null), null);
  assert.equal(W.relPath('C:\\code\\acme.worktrees\\fix-checkout\\apaki\\ui', 'C:\\code\\acme.worktrees\\fix-checkout'), 'apaki/ui');
  assert.equal(W.relPath('C:\\code\\acme.worktrees\\fix-checkout', 'C:\\code\\acme.worktrees\\fix-checkout'), '');
  assert.ok(W.isInside('/home/a/b/c', '/home/a/b') && !W.isInside('/home/a/bc', '/home/a/b'));
});

test('the label: branch and change count, a zero side left out, nothing when nothing changed or it was not read', () => {
  const [main, agent, fix, old, late] = REPO.worktrees;
  assert.equal(W.branchLabel(fix), 'fix-checkout +42 -7');
  assert.equal(W.changeText(late), '+3');
  assert.equal(W.plusMinus(0, 9), '-9');
  assert.equal(W.plusMinus(0, 0), '');
  assert.equal(W.branchLabel(main), 'main');
  assert.equal(W.branchLabel(old), 'old-feature');
  assert.equal(W.changeText({ ...fix, stats: false }), '', 'a light record has no numbers to show');
  assert.equal(W.changeText({ ...fix, approx: true }), '+42 -7+', 'a count that was cut says so');
  assert.equal(W.branchName({ branch: '', head: 'abcdef0123', detached: true }), 'abcdef0 (detached)');
  assert.equal(W.branchName({ branch: '', head: '' }), 'detached');
  assert.match(W.tooltip(REPO, fix), /^fix-checkout\nC:\\code\\acme\.worktrees\\fix-checkout\nFrom main: 3 commits ahead, 0 behind\n\+42 -7 in 5 files, 2 not committed\nRepository acme$/);
  assert.match(W.tooltip(REPO, agent), /Locked: claude agent/);
});

test('colour is for trouble only: conflicts, a folder that is gone, behind the base (never the main checkout)', () => {
  const [main, , fix, , late] = REPO.worktrees;
  assert.equal(W.trouble(fix), '', 'ahead and changed is not trouble');
  assert.equal(W.trouble(late), 'behind 4');
  assert.equal(W.trouble({ ...main, behind: 9 }), '', 'the base is not behind itself');
  assert.equal(W.trouble({ ...fix, conflicts: 1, behind: 3 }), '1 conflict', 'conflicts first');
  assert.equal(W.trouble({ ...fix, conflicts: 3 }), '3 conflicts');
  assert.equal(W.trouble({ ...fix, missing: true }), 'folder gone');
  assert.equal(W.trouble({ ...late, stats: false }), '');
  assert.equal(W.trouble(null), '');
});

test('what stops a removal, in a few words, and which worktrees are offered for cleanup', () => {
  const [main, agent, fix, old, late] = REPO.worktrees;
  assert.equal(W.removeBlocker(main), '', 'the main checkout has no remove item at all');
  assert.equal(W.removeBlocker(agent), 'locked');
  assert.equal(W.removeBlocker(fix), '2 uncommitted files');
  assert.equal(W.removeBlocker({ ...fix, changed: 0 }), '3 unpushed commits');
  assert.equal(W.removeBlocker({ ...fix, changed: 0, unpushed: 1 }), '1 unpushed commit');
  assert.equal(W.removeBlocker({ ...fix, changed: 0, unpushed: null }), 'could not check its commits');
  assert.equal(W.removeBlocker(old), '');
  assert.equal(W.removeBlocker(old, { busy: true }), 'a conversation is open in it');
  assert.deepEqual(W.mergedCandidates(REPOS).map((c) => c.wt.branch), ['old-feature']);
  assert.deepEqual(W.mergedCandidates([{ ...REPO, worktrees: [{ ...old, changed: 1 }, { ...old, locked: 'x' }, { ...old, unpushed: 2 }, { ...old, missing: true }] }]), [], 'dirty, locked, unpushed and missing ones are never offered');
});

test('the Worktrees view: repositories with linked worktrees, the main checkout first, conversations nested, "Show more"', () => {
  const s = (id, cwd, ago) => ({ id, title: id, cwd, lastModified: 1000 - ago });
  const sessions = [
    s('a', 'C:\\code\\acme\\src', 1), s('b', 'C:\\code\\acme.worktrees\\fix-checkout', 2), s('c', 'C:\\code\\acme.worktrees\\fix-checkout\\apaki', 3),
    s('d', 'C:\\code\\lone', 4), s('e', 'C:\\elsewhere', 5), ...Array.from({ length: 9 }, (_, i) => s(`m${i}`, 'C:\\code\\acme', 10 + i)),
  ];
  const rows = W.worktreeRows(REPOS, sessions);
  assert.deepEqual(rows.filter((r) => r.k === 'repo').map((r) => r.repo.name), ['acme'], 'a repository with no linked worktree has no place here');
  assert.equal(rows[0].linked, 4);
  const wts = rows.filter((r) => r.k === 'wt');
  assert.equal(wts[0].wt.main, true, 'the main checkout first');
  assert.equal(wts[1].wt.branch, 'fix-checkout', 'then the worktree with the newest conversation');
  const kids = (branch) => rows.filter((r) => r.k === 'kid' && r.wt.branch === branch).map((r) => r.s.id);
  assert.deepEqual(kids('fix-checkout'), ['b', 'c'], 'a conversation in a subfolder belongs to its worktree');
  assert.deepEqual(kids('main'), ['a', 'm0', 'm1', 'm2', 'm3', 'm4'], 'six shown, newest first');
  const more = rows.find((r) => r.k === 'more');
  assert.equal(more.hidden, 4);
  const open = W.worktreeRows(REPOS, sessions, { more: new Set([W.normPath('C:\\code\\acme').toLowerCase()]) });
  assert.equal(open.filter((r) => r.k === 'kid' && r.wt.main).length, 10);
  assert.equal(open.some((r) => r.k === 'more'), false);
  const folded = W.worktreeRows(REPOS, sessions, { folded: new Set([REPO.id]) });
  assert.deepEqual(folded.map((r) => r.k), ['repo'], 'a folded repository shows only its row');
  assert.equal(folded[0].folded, true);
  assert.equal(W.linkedCount(REPOS), 4);
  assert.deepEqual(W.worktreeRows([], sessions), []);
});

test('the menu: everything the desktop lists, dimmed with the reason below Full access, nothing that opens a window on the PC from a phone', () => {
  const [main, , fix, old] = REPO.worktrees;
  const labels = (items) => items.filter((i) => i.value).map((i) => i.value);
  const full = W.menuItems({ repo: REPO, wt: fix });
  assert.deepEqual(labels(full), ['diff', 'new', 'commit', 'push', 'pr', 'merge', 'newwt', 'folder', 'terminal', 'remove']);
  assert.equal(full[0].heading, 'fix-checkout from main');
  const by = (items, v) => items.find((i) => i.value === v);
  assert.equal(by(full, 'diff').hint, '+42 -7 in 5 files');
  assert.equal(by(full, 'commit').hint, '2 files');
  assert.equal(by(full, 'commit').disabled, false);
  assert.match(by(full, 'remove').disabled, /Not now: 2 uncommitted files/);
  assert.equal(by(full, 'remove').hint, '2 uncommitted files');
  assert.equal(by(full, 'remove').danger, true);
  assert.equal(by(W.menuItems({ repo: REPO, wt: old }), 'remove').disabled, false, 'a clean merged worktree can be removed');
  assert.match(by(W.menuItems({ repo: REPO, wt: old }), 'merge').disabled, /Already merged/);
  assert.equal(by(W.menuItems({ repo: REPO, wt: fix, busy: true }), 'remove').hint, 'a conversation is open in it', 'a conversation open in it comes before what is uncommitted');
  assert.equal(labels(W.menuItems({ repo: REPO, wt: main })).includes('remove'), false, 'the main checkout is never offered for removal');
  assert.match(by(W.menuItems({ repo: REPO, wt: main }), 'pr').disabled, /main checkout/);
  // A phone: looking is open, changing is dimmed with the reason, and no windows on the PC.
  const phone = W.menuItems({ repo: REPO, wt: fix, cap: 'noshell', web: true });
  assert.deepEqual(labels(phone), ['diff', 'new', 'commit', 'push', 'pr', 'merge', 'newwt', 'remove']);
  for (const v of ['commit', 'push', 'pr', 'merge', 'newwt', 'remove']) assert.match(by(phone, v).disabled, /allows looking at changes, not changing them/, v);
  assert.equal(by(phone, 'diff').disabled, undefined, 'View changes works at every access level');
  assert.equal(by(phone, 'new').disabled, undefined, 'a new conversation is the phone\'s own business');
  assert.equal(by(W.menuItems({ repo: REPO, wt: fix, cap: 'chat', web: true }), 'commit').disabled.length > 20, true);
});

test('a branch name from the first message: the first meaningful words, kept short, never a taken one', () => {
  assert.equal(W.suggestBranch('Fix the checkout flow bug'), 'fix-checkout-flow-bug');
  assert.equal(W.suggestBranch('Can you please help me add dark mode to the settings screen?'), 'add-dark-mode-settings-screen');
  assert.equal(W.suggestBranch('Look at https://example.com/a/b and fix the login redirect'), 'look-fix-login-redirect');
  assert.equal(W.suggestBranch('   '), 'work');
  assert.equal(W.suggestBranch('???'), 'work');
  assert.ok(W.suggestBranch('Migrate the invoices service to the new tax calculation interface across every region').length <= 36);
  assert.equal(W.suggestBranch('Fix login', ['fix-login']), 'fix-login-2');
  assert.equal(W.suggestBranch('Fix login', ['fix-login', 'fix-login-2']), 'fix-login-3');
  assert.equal(W.suggestBranch('Fix <b>Login</b>'), 'fix-login', 'markup becomes plain words');
});

test('a patch read into numbered lines, and drawn with the text escaped', () => {
  const patch = [
    'diff --git a/a.js b/a.js', 'index 1..2 100644', '--- a/a.js', '+++ b/a.js', '@@ -3,4 +3,5 @@ function f() {',
    ' keep', '-old <b>', '+new & better', '+added', ' tail', '\\ No newline at end of file', '@@ -20 +21 @@', '-x', '+y', '',
  ].join('\n');
  const p = W.parsePatch(patch);
  assert.equal(p.hunks.length, 2);
  assert.deepEqual(p.hunks[0].lines.map((l) => [l.t, l.n]), [['ctx', 3], ['del', 4], ['add', 4], ['add', 5], ['ctx', 6], ['note', '']]);
  assert.deepEqual(p.hunks[1].lines.map((l) => [l.t, l.n, l.text]), [['del', 20, 'x'], ['add', 21, 'y']]);
  const html = W.patchHtml(patch);
  assert.match(html, /^<pre class="diff df-pre">/);
  assert.ok(html.includes('<span class="del" data-n="4">-old &lt;b&gt;</span>') && html.includes('<span class="add" data-n="4">+new &amp; better</span>'));
  assert.ok(!html.includes('<b>'), 'a file\'s own markup never reaches the page as markup');
  assert.match(W.patchHtml('diff --git a/x b/x\nBinary files a/x and b/x differ\n'), /binary file/i);
  assert.match(W.patchHtml('diff --git a/x b/x\nsimilarity index 100%\nrename from x\nrename to y\n'), /No lines changed/);
  assert.equal(W.parsePatch('@@ -1 +1 @@\n' + `+${'x'.repeat(5000)}`).hunks[0].lines[0].text.length, 2000, 'a very long line is cut');
  assert.deepEqual(splitPath('src/ui/app.js'), { dir: 'src/ui/', name: 'app.js' });
  assert.deepEqual(splitPath('README.md'), { dir: '', name: 'README.md' });
  assert.equal(numbersOf(null), '');
  assert.notEqual(numbersOf(WT('p', 'b', { added: 1 })), numbersOf(WT('p', 'b', { added: 2 })), 'the viewer reads again when the numbers move');
});

test('the sheet: commands, warnings and blockers are text, a plan that cannot run says why', () => {
  const html = W.planHtml({ summary: 'Merge <x> into main.', commands: ['git merge --no-edit <x>'], warnings: ['2 files are not part of it'], blockers: ['The main checkout has uncommitted changes.'] });
  assert.ok(html.includes('<pre class="wt-cmds">git merge --no-edit &lt;x&gt;</pre>'));
  assert.ok(html.includes('<ul class="wt-warn"><li>2 files are not part of it</li></ul>'));
  assert.ok(html.includes('<ul class="wt-block"><li>The main checkout has uncommitted changes.</li></ul>'));
  assert.ok(html.includes('Merge &lt;x&gt; into main.'));
  assert.equal(W.planHtml(null), '');
  const create = W.formHtml('create', { repo: { branches: ['main', 'dev'], base: 'main' }, data: { branchExists: true } }, { branch: 'a"b', useExisting: false });
  assert.ok(create.includes('value="a&quot;b"') && create.includes('Use the existing branch'), 'a name with a quote cannot break out of its field');
  assert.ok(create.includes('<option value="main" selected>main</option>') && create.includes('<option value="dev">dev</option>'));
  const commit = W.formHtml('commit', { data: { files: [{ path: 'a.txt', status: 'M' }, { path: 'n<1>.txt', status: '?' }], total: 2 } }, { paths: ['a.txt'] });
  assert.ok(commit.includes('1 file of 2'));
  assert.ok(commit.includes('value="a.txt" checked') && !commit.includes('value="n&lt;1&gt;.txt" checked'));
  assert.match(W.formHtml('remove', { data: { branch: 'x', merged: true } }), /data-f="deleteBranch" checked/);
  assert.doesNotMatch(W.formHtml('remove', { data: { branch: 'x', merged: false } }), /checked/);
  assert.match(W.formHtml('pr', { repo: { branches: ['main'], base: 'main' }, data: { suggest: { title: 'Add <login>', body: '- one' } } }), /value="Add &lt;login&gt;"/);
  assert.equal(W.formHtml('push', {}), '');
  assert.deepEqual(Object.keys(W.ACTION_TEXT), ['create', 'remove', 'commit', 'push', 'pr', 'merge']);
  assert.equal(W.statusWord('?'), 'new');
});

test('readForm turns the fields back into the arguments an action sends', () => {
  const field = (f, props) => ({ dataset: { f }, ...props });
  const root = (fields, boxes = []) => ({ querySelector: (sel) => fields.find((x) => `[data-f="${x.dataset.f}"]` === sel) || null, querySelectorAll: () => boxes });
  assert.deepEqual(W.readForm('create', root([field('branch', { value: '  fix-x ' }), field('base', { value: 'main' })])), { branch: 'fix-x', base: 'main' });
  assert.deepEqual(W.readForm('remove', root([field('deleteBranch', { checked: true })])), { deleteBranch: true });
  const boxes = [{ checked: true, value: 'a' }, { checked: false, value: 'b' }];
  assert.deepEqual(W.readForm('commit', root([field('message', { value: 'msg' })], boxes)), { message: 'msg', paths: ['a'] });
  assert.deepEqual(W.readForm('commit', root([field('message', { value: 'msg' })], [{ checked: true, value: 'a' }])), { message: 'msg' }, 'every file ticked: no list, the engine commits all of it');
  assert.deepEqual(W.readForm('pr', root([field('title', { value: ' T ' }), field('body', { value: 'B' }), field('base', { value: 'main' }), field('draft', { checked: false })])), { title: 'T', body: 'B', base: 'main', draft: false });
  assert.deepEqual(W.readForm('merge', root([field('into', { value: 'main' })])), { into: 'main' });
  assert.deepEqual(W.readForm('push', root([])), {});
});

/* ---------- the controller, against a stand-in for app.js ---------- */

function controller(extra = {}) {
  const sent = [];
  const changed = [];
  const sheets = [];
  const app = {
    send: (op, args) => { sent.push({ op, ...args }); },
    sheet: (html, wire) => { sheets.push({ html, wire }); },
    menu: () => {}, web: false, cap: () => 'full', sessions: () => [], openCwds: () => [], openDiff: () => {}, startIn: () => {}, openUrl: () => {}, changed: (o) => changed.push(o || null), note: () => {},
    ...extra,
  };
  return { c: W.initWorktrees(app), sent, changed, sheets };
}

test('the controller: the engine\'s state is kept, answers are matched by request id, a refusal arrives as an error', async () => {
  const { c, sent, changed } = controller();
  assert.equal(c.hasData(), false);
  assert.equal(c.handle({ ev: 'worktrees', reqId: null, repos: REPOS }), true);
  assert.equal(c.hasData(), true);
  assert.equal(changed.length, 1, 'the window redraws what shows the repositories');
  assert.equal(c.count(), 4);
  assert.equal(c.forCwd('C:\\code\\acme.worktrees\\fix-checkout\\x').wt.branch, 'fix-checkout');
  assert.equal(c.inLinked('C:\\code\\acme'), true);
  assert.equal(c.inLinked('C:\\code\\lone'), false);
  assert.equal(c.tabNote(['C:\\code\\acme.worktrees\\fix-checkout', 'C:\\code\\acme.worktrees\\fix-checkout\\sub']), 'fix-checkout · acme (worktree)');
  assert.equal(c.tabNote(['C:\\code\\acme', 'C:\\code\\acme']), 'main · acme');
  assert.equal(c.tabNote(['C:\\code\\acme', 'C:\\code\\acme.worktrees\\fix-checkout']), '', 'two worktrees in one tab: nothing to say');
  assert.equal(c.tabNote(['C:\\nowhere']), '');
  assert.equal(c.tabNote([]), '');

  const p = c.ask('worktreeDiff', { path: 'C:\\code\\acme' });
  const reqId = sent.at(-1).reqId;
  assert.match(reqId, /^w[0-9a-z]+$/, 'its own request id: the engine and the phone policy accept it');
  assert.equal(sent.at(-1).op, 'worktreeDiff');
  assert.equal(c.handle({ ev: 'worktreeDiff', reqId, ok: true, files: [] }), true);
  assert.deepEqual(await p, { ev: 'worktreeDiff', reqId, ok: true, files: [] });

  const refused = c.ask('worktreeRun', { kind: 'commit' });
  const rid = sent.at(-1).reqId;
  assert.equal(c.handle({ ev: 'error', reqId: rid, message: 'This phone is set to No shell on the PC.', refused: true }), true, 'the refusal does not become a note in some conversation');
  assert.deepEqual(await refused, { ok: false, error: 'This phone is set to No shell on the PC.', refused: true });

  const slow = await c.ask('worktrees', {}, { ms: 15 });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /did not answer/);
  assert.equal(c.handle({ ev: 'error', reqId: 'nobody-asked', message: 'x' }), false, 'an error that is not an answer is the window\'s to show');
  assert.equal(c.handle({ ev: 'worktreeResult', reqId: 'late' }), true, 'a late answer is dropped quietly');

  // A refresh that was asked for also updates the state.
  const asked = c.ask('worktrees', { refresh: true });
  c.handle({ ev: 'worktrees', reqId: sent.at(-1).reqId, repos: [LONE] });
  assert.equal((await asked).repos.length, 1);
  assert.equal(c.count(), 0, 'the state follows the newest event');
});

test('the controller: folded repositories are remembered, the Worktrees rows follow the state', () => {
  const { c } = controller();
  c.handle({ ev: 'worktrees', repos: REPOS });
  c.setFolded([REPO.id, 5]);
  assert.deepEqual(c.foldedList(), [REPO.id, 5]);
  assert.deepEqual(c.rows([]).map((r) => r.k), ['repo']);
  c.setFolded(null);
  assert.deepEqual(c.foldedList(), []);
  assert.equal(c.rows([]).filter((r) => r.k === 'wt').length, 5);
});

test('an action sheet opens at once and says what it is for; nothing is asked of the PC until it is wired', () => {
  const { c, sent, sheets } = controller();
  c.handle({ ev: 'worktrees', repos: REPOS });
  c.actionSheet({ kind: 'merge', path: 'C:\\code\\acme.worktrees\\fix-checkout', from: 'fix-checkout · acme' });
  c.actionSheet({ kind: 'create', repo: 'C:\\code\\acme', from: 'acme', note: 'The branch name comes from your message.', go: 'Create it and send' });
  assert.equal(sheets.length, 2);
  assert.match(sheets[0].html, /<h2>Merge<\/h2>/);
  assert.match(sheets[0].html, /fix-checkout · acme/);
  assert.match(sheets[0].html, /data-k="go" disabled>Merge</, 'the button waits for the plan');
  assert.match(sheets[1].html, /<h2>New worktree<\/h2>/);
  assert.match(sheets[1].html, /The branch name comes from your message\./);
  assert.match(sheets[1].html, /Create it and send/);
  assert.equal(sent.length, 0);
});

/* ---------- the wiring: the window, the phone, the build ---------- */

test('the web build ships the worktree modules and the phone page has what the desktop has', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-wt-ui-'));
  after(() => fs.rmSync(out, { recursive: true, force: true }));
  build({ relay: 'wss://apaki.myrlin.io', out });
  for (const f of ['worktree.js', 'diff.js']) assert.ok(fs.existsSync(path.join(out, f)), `the web build ships ${f}`);
  const css = fs.readFileSync(path.join(out, 'web.css'), 'utf8');
  assert.match(css, /body\.web \.wt-acts \{ position: static;[^}]*opacity: 1;/, 'no hover on a phone: the row\'s actions are always there');
  assert.match(css, /\.cn-wt:not\(:empty\) ~ \.cn-cwd \{ display: none; \}/);
  const pager = read('../apaki/web/src/pager.js');
  assert.match(pager, /class="cn-wt"><\/span>/, 'the nav row has a slot for the branch label');
  assert.match(pager, /el\?\.querySelector\('\.pane-bar \.wt-btn'\)/, 'it mirrors the visible pane\'s label');
  assert.match(pager, /press\('\.pane-bar \.wt-btn'\)\(\)/, 'and a tap presses the real button, so the menu is the pane\'s own');
  // The desktop and the phone run the same app.js: nothing in the worktree code is desktop only except what opens a window on the PC.
  const app = read('../apaki/ui/app.js');
  assert.match(app, /web: WEB,/);
  assert.match(app, /if \(WEB\) window\.open\(url, '_blank', 'noopener,noreferrer'\); else openUrlHere\(url\)/, 'a pull request opens in the phone\'s own browser');
  assert.match(app, /cap: \(\) => \(WEB \? \(window\.__apakiLink\?\.cap\?\.\(\) \|\| 'full'\) : 'full'\)/, 'the phone\'s access decides what the menu offers');
});

test('the window: Worktrees view, branch label, New worktree, + menu, tab tooltip, the diff viewer saved with the tab', () => {
  const app = read('../apaki/ui/app.js');
  // The Worktrees filter joins All and In terminals; its rows are the controller's.
  assert.match(app, /\{ id: 'worktrees', label: 'Worktrees', n: wtc\.count\(\) \}/);
  assert.match(app, /if \(S\.view === 'worktrees'\) return wtc\.inLinked\(s\.cwd\);/);
  assert.match(app, /wtc\.rows\(S\.sessions\.filter\(\(s\) => !s\.archived\)\)\.map\(\(r\) => \(r\.k === 'kid' \? \{ \.\.\.r\.s, wtKid: true \} : \{ wtRow: r \}\)\)/);
  assert.match(app, /if \(s\.wtRow\) \{ list\.append\(wtc\.rowEl\(s\.wtRow, \{ focusedCwd \}\)\); continue; \}/);
  assert.match(app, /S\.view !== 'worktrees' && !S\.folders\.some/, 'a folders event does not throw the view back to All');
  // The engine's state and its answers reach the controller before anything else sees the event; the list is asked for at start and on ready.
  assert.match(app, /await listen\('engine', \(\{ payload: e \}\) => \{\n[^\n]*\n  if \(wtc\.handle\(e\)\) return;/);
  assert.equal((app.match(/send\('worktrees'\);/g) || []).length, 2);
  // Every branch label, diff viewer and tab tooltip follows the state.
  assert.match(app, /if \(p\.isDiff\) p\.repoChanged\(\);\n    else if \(!p\.isViewer\) p\.setCwdLine\(\);/);
  assert.match(app, /const onBranch = wtc\.tabNote\(/);
  // The + menu and a new conversation in a worktree.
  assert.match(app, /plus\.oncontextmenu = /);
  assert.match(app, /label: 'New tab in a new worktree'/);
  assert.match(app, /function newConversation\(p, o = \{\}\)/);
  assert.match(app, /startIn: \(path\) => newConversation\(focusedPane\(\), \{ cwd: path \}\)/);
  // The viewer is saved with the tab and comes back reading its worktree again; folded repositories are saved with the rail.
  assert.match(app, /if \(lf\.view\?\.diff\) return L\.leaf\(createDiffViewer\(lf\.view\.diff, lf\.pane\)\.id\);/);
  assert.match(app, /wtFolded: wtc\.foldedList\(\)/);
  assert.match(app, /wtc\.setFolded\(saved\.rail\.wtFolded\)/);
  // The Starts in sheet gets the switch, on the phone too (it cannot browse the PC's disks).
  assert.match(app, /folderSheet\(p, \{ sheet, send, esc, ago, web: WEB, wt: wtc, mode: opts\.mode, known: knownFolders \}\)/);
  const pane = read('../apaki/ui/pane.js');
  assert.match(pane, /this\.\$\.wt\.onclick = \(\) => this\.host\.worktreeMenu\?\.\(this, this\.\$\.wt\);/);
  assert.match(pane, /const f = this\.pendingWorktree \? null : \(this\.host\.worktreeFor\?\.\(this\) \|\| null\);/);
  assert.match(pane, /this\.host\.makeWorktree\?\.\(this, text\)/, 'the first message of a conversation in a new worktree makes it first');
  assert.match(pane, /setStartFolder\(dir\) \{\n    if \(this\.sessionId \|\| this\.busy\) return;\n    this\.pendingWorktree = null;/);
  const html = read('../apaki/ui/index.html');
  assert.match(html, /<button class="wt-btn" hidden><\/button><span class="cwd"><\/span>/);
  const start = read('../apaki/ui/startfolder.js');
  assert.match(start, /data-mode="folder">This folder<\/button><button type="button" role="radio" data-mode="worktree">New worktree/);
  assert.match(start, /pane\.setPendingWorktree\(\{ repo: r\.root \|\| r\.worktrees\[0\]\.path/);
  const diff = read('../apaki/ui/diff.js');
  assert.match(diff, /this\.isViewer = true;\n    this\.isDiff = true;/);
  assert.match(diff, /saved\(\) \{\n    return \{ diff: /);
});

test('the design rules hold in the CSS: no px font sizes in the window\'s block, no stripe down a row, no status dot', () => {
  const css = read('../apaki/ui/app.css');
  // The worktrees block only: it ends where the next section (the tooltips, tooltip.js) begins.
  const start = css.indexOf('(2026-10-12; worktree.js, diff.js');
  const end = css.indexOf('/* ---------- tooltips (tooltip.js', start);
  const block = css.slice(start, end === -1 ? undefined : end);
  assert.ok(block.length > 2000);
  assert.deepEqual([...block.matchAll(/font(-size)?:[^;]*?\d+(\.\d+)?px/g)].map((m) => m[0]), [], 'the type tokens only (fs-micro, fs-small, fs-body)');
  assert.doesNotMatch(block, /border-left|box-shadow: inset [1-9]/, 'a nested conversation is indented, never striped');
  assert.doesNotMatch(block, /border-radius: 50%|\.wt-dot|status-dot/, 'no dot indicator');
  // Colour is for trouble: the action colour appears only on the trouble words and blockers.
  const uses = [...block.matchAll(/([^{}]+)\{[^}]*action-strong[^}]*\}/g)].map((m) => m[1].trim());
  assert.deepEqual(uses, ['.wt-btn .wt-t, .cn-wtb .wt-t', '.wt-row .wt-tr', '.sheet ul.wt-block li']);
});
