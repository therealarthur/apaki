# Worktrees in Apaki: design and build plan (2026-10-11)

Arthur, 2026-10-11: "The best approach to AI development is using git
worktrees to tackle multiple features simultaneously." Make worktrees easy to
see and navigate for sessions, without crowding the screen, where people who
already work this way expect them, and "make sure we're upating the app
alongside the desktop app so all functionality is equal across the board".

Precedent: the Codex app (Local / Worktree choice per thread), Conductor,
Superset, Emdash and Claude desktop all start a task in a worktree, list work
by repository and branch, and offer diff, commit, PR and cleanup from there.
Claude Code itself has EnterWorktree / ExitWorktree tools.

## Where it shows

1. Starting a conversation: the "Starts in" sheet gets This folder or New
   worktree. A new worktree gets a branch name suggested from the first
   message (editable) and a base branch (default the repo's default branch).
   Location follows Claude Code's own worktree convention when it has one;
   otherwise a sibling folder `<repo>.worktrees/<branch>` so the repo needs
   no .gitignore change.
2. Sidebar: folder groups become repo-aware. A repo row opens to its
   worktrees (the main checkout first, then branches); conversations nest
   under their worktree. A worktree row shows two things only: the branch
   name and a change count (+added, removed lines vs its base). Color only
   for trouble (conflicts, behind the base). A "Worktrees" filter joins All
   and In terminals.
3. Pane header: the folder line becomes a branch label, for example
   "fix-checkout +42 -7", with a worktree glyph when it is not the main
   checkout. Its menu: View changes (a diff viewer pane), Commit, Push, Open
   PR (gh), Merge into base, Open folder, Open terminal, Remove worktree
   (refused with uncommitted or unpushed work, with the reason).
4. Tabs: a tab whose panes share one worktree shows that branch in its
   tooltip; the + menu adds "New tab in a new worktree".
5. Cleanup: merged branches are offered for removal in one prompt.
6. Detection: `git worktree list --porcelain` per repo (cached, refreshed on
   change and every 30 s), each session's working folder mapped to its
   worktree, and EnterWorktree tool uses in a transcript move the session to
   that worktree. Codex threads the same way (CODEX.md).

## Phone, equal to the desktop

The list groups by repo and worktree with the same labels; the pane's nav
bar shows the branch label; View changes opens the diff viewer full screen;
the actions follow the phone's access level (No shell and Chat only cannot
commit, merge or remove). New conversations on the phone offer New worktree
too.

## Safety

Every git action runs in the engine with the user's own git and gh, shows
what it will do first (the command and the diff), and never discards work:
remove refuses dirty or unpushed worktrees; merge stops on conflicts and
says so. Nothing runs on a phone's request unless its access level allows
shell-level actions.

## Build order

1. Engine: worktree detection, diff stats, create, remove (guarded); tests
   on temp repos. 2. Desktop UI: sheet option, sidebar grouping and filter,
   pane branch label and menu, diff viewer. 3. Phone UI for the same, through
   the phone policy. 4. Commit, push, PR, merge flows. 5. Codex threads.

## Status (2026-10-12): steps 1 to 4 are built, step 5 is not

Engine (`apaki/engine/worktrees.js`, ops in `engine.js`): detection from files
(no git process for a repository without linked worktrees), the numbers per
worktree, create, remove, commit, push, pull request and merge, each as a plan
(the exact commands, warnings, blockers) that the engine makes again when it
runs. Window and phone (`apaki/ui/worktree.js`, `diff.js`, `app.js`,
`pane.js`, `startfolder.js`; the phone's nav row in `apaki/web/src/pager.js`):
the Worktrees filter, the branch label and menu, the action sheets, Starts in
with New worktree, the + menu and tab tooltip, the diff viewer, the cleanup
prompt. Tests: `test/apaki-worktrees.test.js` (temp repositories),
`apaki-worktrees-engine.test.js` (end to end and the phone policy),
`apaki-worktrees-ui.test.js`. Ledger entries: `apaki/parity/features.json`
(`worktree-*`).

Cost (2026-10-15): all of the git (and the reads of new files) runs on a worker
thread (`worktrees-worker.js`, `worktrees-client.js`), so process creation never
holds up the engine's thread. A turn that ends marks only its own worktree; the
30 s refresh looks again at repositories with an open pane or one asked about in
the last 3 minutes, the others every 5 minutes; a worktree whose status and refs
did not move keeps its numbers after one `git status`. Tests:
`test/apaki-worktrees-perf.test.js`; benchmark: `apaki/scripts/worktree-bench.mjs`.

Choices the design left open:

- A worktree row's click starts a conversation in it; hover (always, on the
  phone) shows New conversation here and the menu. A zero side of the count is
  left out ("+12", not "+12 -0").
- Counts are against the branch's base: the repository's default branch, or the
  base a worktree Apaki made came from (Apaki's own note in
  `~/.claude/latch/apaki-worktrees.json`, never in the repository's config).
  New files count by their lines.
- "Merged" means the branch is inside its base and had work of its own; a branch
  made a moment ago is not offered for cleanup.
- Merge goes into the base's own checkout (it must be checked out and clean),
  after `git merge-tree` shows there is no conflict; nothing is pushed or
  deleted. A pull request pushes first (shown), then `gh pr create`; Apaki never
  force-pushes and never passes the force flag to remove.
- A phone may read at every access level (the list, the diff) and plan or run
  actions only with Full access; a phone can only name folders the PC already
  lists, and create never takes a place to put the folder.
- The `worktrees` event is a broadcast (every window and phone, cached for later
  ones) and is also the answer to `worktrees` requests.

Not built: EnterWorktree tool uses in a transcript moving the session to that
worktree (no transcript with a real use was found to check the format against),
and step 5, Codex threads.
