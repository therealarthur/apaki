# Tabs, panes and the side panel

How Apaki lays out conversations and the things they open (browser pages, artifacts, diffs, task viewers). First written 2026-10-12 for Arthur's redesign request ("its all incredibly messy right now ... make it so that its not confusing"); rewritten 2026-10-13 for the side panel, after he looked at a busy tab and said: "the current way we display the browser is incredibly hectic ... i dont know what browser is connected to what session ... potentially have a dedicated pane that comes out from the right side of the app (that can be minimized and opened, that has all the browsers that are opened". The pure rules live in `apaki/ui/workspace.js` (tested in `test/apaki-workspace.test.js`); `app.js` applies them and `sidepanel.js` draws the panel.

## Words

- **Conversation**: a pane with a Claude Code or Codex session. A tab holds at most 6, and they are the only panes in its layout.
- **Viewer**: something a conversation opened: a browser (each of its pages), an artifact, a diff, a subagent or shell. On the PC viewers live in the tab's **side panel**, never in the pane grid.
- **Source**: the conversation a viewer belongs to (`sourcePane`; a browser's `owner`). A viewer opened from nowhere (a link with no conversation) has none.
- **Group**: one conversation's viewers in the side panel. Viewers whose conversation is closed, or not in this tab, form the group **Other**.

## Tab names

A tab is a workspace, not a session. Its name never changes because you clicked a different pane.

1. A name you gave it (double-click the tab, Enter to keep, Escape to cancel, empty to go back to automatic) always wins.
2. Otherwise the project its conversations share: the repository name for a git folder (a worktree counts as its repository), else the folder's name, "Home" for the home folder.
3. Conversations in two projects: "acme-web · billing"; three or more: "acme-web · billing +1". Conversations that have not picked a folder yet do not count.
4. A tab with only new conversations is "New conversation"; a tab with only viewers takes its first viewer's title.
5. Two tabs that would read the same and each hold one conversation add that conversation's title as quiet secondary text, so eight "claude-latch" tabs are still told apart. The strong name stays the project.

The number beside the name counts conversations, never viewers, and shows from 2. Hover lists every pane and viewer. The phone's tab strip and "On your desktop" show the same names.

## Layouts

New conversations join the layout instead of halving the focused pane. Each tab has an arrangement, applied to its conversations only:

| Arrangement | 1 | 2 | 3 | 4 | 5, 6 |
| - | - | - | - | - | - |
| Auto, wider than tall | full | side by side | one large left, two stacked right | 2x2 | 3 over 3 (5: 3 over 2) |
| Auto, taller than wide | full | stacked | two on top, one below | 2x2 | 2 columns of 3 rows |
| Columns | all side by side | | | | |
| Rows | all stacked | | | | |
| Grid | an even grid, rows and columns chosen by count and shape | | | | |
| Main and stack | the first conversation large, the rest stacked beside it (below it when tall); picking it from the menu makes the focused conversation the first | | | | |

- The main area is what is left of the tab beside its side panel, so the arrangement is chosen for that shape.
- Gutters still resize anything; sizes stay until the arrangement changes.
- Dragging a pane to an edge, or swapping two, makes the tab **Custom**: your tree is kept as you built it, and a new pane then splits the largest pane along its longer side. The layout menu's Auto puts it back.
- Auto re-flows only when the tab's shape flips between wide and tall (or panes come and go), so resizing the window does not undo your gutter drags.
- Old saved workspaces have no arrangement and restore as Custom, exactly as saved (less their viewers, below).
- The layout button in the tab row opens the menu: Auto, Columns, Rows, Grid, Main and stack, with the current one checked.

## The side panel

Every tab has its own side panel, docked to the right edge of the tab's content area, full height, beside the conversations.

- **It holds everything the tab's conversations opened**: Claude's `browser_open`, a `show` (an artifact, or a URL), `vite --open` or Python's `webbrowser` through the BROWSER shim, a link card's Open, View changes, a subagent or shell opened from the Tasks list.
- **The switcher** at its top lists the conversations of the tab that have something open, in layout order, then Other. Each name is in its conversation's accent (the same accent as the link mark in that conversation's header), with a count beside it; the one shown is bold with a line under it. Clicking a name shows its things and focuses that conversation too.
- **It follows focus.** Focusing or clicking a conversation pane switches the panel to that conversation's things. A conversation with nothing open leaves the panel as it was, with a quiet line under the switcher: `"Move image uploads" has nothing open here. Showing "Fix flaky checkout test".` It never goes blank.
- **The entries** under the switcher are that conversation's things as tabs: each browser page is its own tab, then artifacts, then changes, then tasks. Each has its x; a middle click closes it; Delete closes the focused one; Close all (and the ... menu) closes everything of that conversation. The ... menu also closes everything in the panel, or collapses it.
- **The viewer** fills the rest. A browser keeps its own controls (back, forward, reload, the address, + for a new page, open in your browser) above the page. Only the entry on screen is displayed; the others stay alive (a browser's other pages keep running, hidden).
- **Opening by itself**: the first time something opens in a tab, its panel opens (also when a tab that had emptied gets something again). After that, what Claude opens comes to the front only when it belongs to the focused conversation (or the focused conversation has nothing open); otherwise its conversation's name is tinted as new in the switcher, and on the rail when collapsed. What you open yourself (a card's Open, a click) always opens the panel on it. Nothing Claude opens takes the keyboard from the message box.
- **Collapse** (its button, the ... menu, Ctrl+Shift+B, or dragging its edge nearly shut): the panel becomes a slim rail at the right edge with the open button and one square per conversation (its initials and count in its accent). A square opens the panel on that conversation. Ctrl+Shift+B opens it again.
- **Resize**: drag its left edge (in the gap beside it). It starts at 40 percent of the main area (at most 640 px) and keeps 320 px to 1100 px, always leaving the conversations at least 360 px. Double-click the edge for the default. The width, open or collapsed, the group shown and each group's last entry are saved per tab.
- **Linked, visibly**: every conversation that has viewers gets an accent (six hues, chosen per tab so neighbours differ, never the focus periwinkle, the waiting orange or the finished green). The conversation's header carries a small link mark in that accent with its count; clicking it opens the panel on its things (again: the next one). Hovering the mark lights its name in the switcher; hovering a name in the switcher rings the conversation's pane.
- **Closing a conversation** that has viewers asks, from its close button: close it with its viewers, or the conversation only. Kept viewers move to Other, each with a quiet chip with the conversation's name; its click reopens the session. A viewer whose conversation is in another tab (a task opened in a tab of its own) shows a chip that goes there.
- **Moving a conversation** to another tab takes its viewers to that tab's panel.
- With the panel's focus (you clicked into a viewer), Ctrl+W closes the entry on screen, Ctrl+F searches the viewer, Ctrl+L goes to a browser's address.
- Claude's browser tools (`browser_open`, `browser_read`, `browser_click`, `browser_type`, `browser_tabs`, `browser_screenshot`) act on the conversation's browser and its active page. A page already open in a tab is shown again, not opened twice. Picking a page in the panel tells the engine, so Claude acts on the page you see. Never a new Apaki tab for a page.

The browser page is a native WebView2 window (a WKWebView on a Mac, `macos.md`) laid over the panel's content area: the window reports the content area's bounds to the shell (`place`), shows only the page on screen and hides the others (they stay alive). While a menu or a sheet covers it, a picture of the page stands in.

### Old saved workspaces

Workspaces saved before the panel kept viewers as leaves of the layout tree. On restore (`workspace.js migrateViewers`, after `foldBrowsers`):

- each viewer leaf moves into the side panel of the tab that holds its conversation (a browser's owner, a viewer's sourcePane, a task's or a diff's ownerPane), even when it was in another tab;
- one whose conversation is in no tab stays in the tab it was in, under Other, with the chip that reopens the session;
- the trees keep only conversations: a tab with an arrangement is laid out again; a Custom tree gives each viewer's space to its neighbours;
- a tab left with nothing goes; a focus or maximize on a viewer goes to its conversation;
- the panel of a tab that received viewers starts open on its focused conversation.

## Going to an open conversation

Clicking a session in the sidebar (or the session menu's Open) when it is open anywhere goes there: its tab comes forward (a maximized pane there is restored first if it is another pane), the pane takes focus (and the side panel follows), its row scrolls into view, and the pane flashes briefly. Only a session that is not open opens, in the active tab as before.

## Maximize

Any conversation can fill the main area up to the side panel ("so that you can kind of focus on that session and its pane"): the button beside its close button, a double click on its header's empty space (a double click on the title still renames), or Ctrl+Shift+Enter. The sidebar steps aside; the tab row, the window buttons and the side panel stay, and the panel shows the maximized conversation's things. From there:

- **Restore**: the same button, the double click, or Ctrl+Shift+Enter put it back in its exact place, size and split, because the tab's tree is never touched (the pane is only drawn above it).
- **The other conversations**: previous and next in the maximized header ("2 of 3") move the maximized view to them without restoring; Ctrl+1..6 do the same.
- **The panel**: collapse it (Ctrl+Shift+B) for the whole width, or close its entries.

The other panes keep running. Each tab remembers its own maximized pane; switching tabs shows the other tab as it is. Viewers are not maximized (they are in the panel). The phone has nothing to maximize: a pane there is already the whole screen.

## Keyboard

Ctrl+1..6 focus a conversation (maximized: move the maximized view to it), Ctrl+Tab and Ctrl+Shift+Tab switch tabs, Ctrl+W closes the focused pane (the same question for a conversation with viewers; with the panel's focus, the entry on screen), Ctrl+Shift+Enter maximizes or restores, Ctrl+B hides the sidebar, Ctrl+Shift+B opens or collapses the side panel (also from inside a browser page).

## The phone

The phone shows one pane at a time and has no side panel. Its pager pages through a tab's conversations with each conversation's viewers right after it, then the viewers of Other, and each viewer page says whose it is ("for ..."), as before. "On your desktop" lists the PC's viewers under their conversation (`engine/desktop-tabs.js`, from the tab's `items`).

## Design rules held

No status pill with a dot, no accent stripes down the left of anything (the switcher's line is under the name; the panel's resize edge is a gutter in the gap, like the sidebar's), app.css type tokens only, colour only where it says something (the accents say "these belong together"), motion 150 to 200 ms (the panel's content fades in over 170 ms when it opens; no layout property animates) and none with reduced motion.
