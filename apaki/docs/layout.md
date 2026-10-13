# Tabs, panes and viewers

How Apaki lays out conversations and the things they open (browser, artifacts, diffs, task viewers). Written 2026-10-12 for Arthur's redesign request: "its all incredibly messy right now ... make it so that its not confusing". The pure rules live in `apaki/ui/workspace.js` (tested in `test/apaki-workspace.test.js`); `app.js` applies them.

## Words

- **Conversation**: a pane with a Claude Code or Codex session. A tab holds at most 6.
- **Viewer**: a pane that shows something a conversation opened: the browser, an artifact, a diff, a subagent or shell. Viewers do not count toward the 6 (10 panes of any kind per tab).
- **Source**: the conversation a viewer belongs to (`sourcePane`). A viewer opened from nowhere (a link with no conversation) has none.

## Tab names

A tab is a workspace, not a session. Its name never changes because you clicked a different pane.

1. A name you gave it (double-click the tab, Enter to keep, Escape to cancel, empty to go back to automatic) always wins.
2. Otherwise the project its conversations share: the repository name for a git folder (a worktree counts as its repository), else the folder's name, "Home" for the home folder.
3. Conversations in two projects: "acme-web · billing"; three or more: "acme-web · billing +1". Conversations that have not picked a folder yet do not count.
4. A tab with only new conversations is "New conversation"; a tab with only viewers takes its first viewer's title.
5. Two tabs that would read the same and each hold one conversation add that conversation's title as quiet secondary text, so eight "claude-latch" tabs are still told apart. The strong name stays the project.

The number beside the name counts conversations, never viewers, and shows from 2. Hover lists every pane. The phone's tab strip and "On your desktop" show the same names.

## Layouts

New panes join the layout instead of halving the focused pane. Each tab has an arrangement:

| Arrangement | 1 | 2 | 3 | 4 | 5, 6 |
| - | - | - | - | - | - |
| Auto, wider than tall | full | side by side | one large left, two stacked right | 2x2 | 3 over 3 (5: 3 over 2) |
| Auto, taller than wide | full | stacked | two on top, one below | 2x2 | 2 columns of 3 rows |
| Columns | all side by side | | | | |
| Rows | all stacked | | | | |
| Grid | an even grid, rows and columns chosen by count and shape | | | | |
| Main and stack | the first conversation large, the rest stacked beside it (below it when tall); picking it from the menu makes the focused conversation the first | | | | |

The unit of a layout is a **group**: one conversation and its viewers. Groups are arranged as above; inside its cell a group puts the conversation first and its viewers beside it (a row when the cell is wide, a column when tall) at a 60/40 share, several viewers stacked in the 40.

- Gutters still resize anything; sizes stay until the arrangement changes.
- Dragging a pane to an edge, or swapping two, makes the tab **Custom**: your tree is kept as you built it, and a new pane then splits the largest pane along its longer side. The layout menu's Auto puts it back.
- Auto re-flows only when the tab's shape flips between wide and tall (or panes come and go), so resizing the window does not undo your gutter drags.
- Old saved workspaces have no arrangement and restore as Custom, exactly as saved.
- The layout button in the tab row (it replaces "Even grid") opens the menu: Auto, Columns, Rows, Grid, Main and stack, with the current one checked.

## Viewers

- A viewer opens beside the conversation that drives it, in that conversation's group, at the smaller share.
- One viewer of each kind per conversation: a second artifact, diff or task from the same conversation reuses that viewer's place. The browser is one pane per conversation: every page the conversation opens (Claude's `browser_open`, a `show` with a URL, `vite --open` or Python's `webbrowser` through the BROWSER shim, a link card's Open) becomes a tab inside it. A page already open in a tab is shown again instead of opened twice. Claude reads, clicks and types in the active tab; `browser_tabs` lists and switches them. Never a new Apaki tab, never a second browser pane for the same conversation.
- Linked, visibly: every conversation that has viewers gets an accent (six hues, chosen per tab so neighbours differ, never the focus periwinkle, the waiting orange or the finished green). The viewer's header carries a link chip with the conversation's name in that accent; the conversation's header carries a small link mark in the same accent with the count of its viewers. Hovering either outlines the other; clicking the chip goes to the conversation, clicking the mark to its viewers in turn.
- Closing a conversation that has viewers asks, from its close button: close it with its viewers, or the conversation only. A viewer whose conversation is gone keeps a quiet chip with the name; its click reopens the session.

## Going to an open conversation

Clicking a session in the sidebar (or the session menu's Open) when it is open anywhere goes there: its tab comes forward (a maximized pane there is restored first if it is another pane), the pane takes focus, its row scrolls into view, and the pane flashes briefly. Only a session that is not open opens, in the active tab as before.

## Maximize

Any pane can fill the whole window: the button beside its close button, a double click on its header's empty space (a double click on the title still renames), or Ctrl+Shift+Enter. The sidebar and tab row step aside; the window buttons stay. Restore (the same three) puts it back in its exact place, size and split, because the tab's tree is never touched: the pane is only drawn above it. The other panes keep running. Each tab remembers its own maximized pane; switching tabs shows the other tab as it is. The phone has nothing to maximize: a pane there is already the whole screen.

## Keyboard

Ctrl+1..6 focus a pane (restoring a maximized one first), Ctrl+Tab and Ctrl+Shift+Tab switch tabs, Ctrl+W closes the focused pane (the same question for a conversation with viewers), Ctrl+Shift+Enter maximizes or restores.

## Design rules held

No status pill with a dot, no accent stripes down the left of anything, app.css type tokens only, colour only where it says something (the accents say "these belong together"), motion 150 to 250 ms and none with reduced motion.
