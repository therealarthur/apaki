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
