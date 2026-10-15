# Apaki demo harness

Runs Myrlin Apaki's real desktop window (`apaki/ui`, unchanged) in an ordinary browser on invented demo data, and records it: stills and short clips for the product page at apaki.myrlin.io.

Nothing here reads anything from the machine it runs on. The sessions, folders, conversations, Glass accounts, paired phones and web pages are made up (a fictional team at "Acme", folders like `acme-web` and `billing-service`, a session called "Fix flaky checkout test"). Keep it that way: no real titles, paths, names, emails or accounts in `harness/data.mjs`, `turns.mjs` or `pages.mjs`. `demo.test.mjs` checks for the obvious ones.

## Run it

```
node apaki/demo/capture.mjs
```

That renders every scene, light and dark, as PNG stills and as WebM and MP4 clips into `D:\apaki-media` (Windows) or `~/apaki-media`. It starts a short-lived static server on 127.0.0.1 and stops it when it is done, runs Chromium headless in a temporary profile (never your own browser), and needs ffmpeg for the clips.

Arguments are `key=value`:

| Argument | Meaning |
| - | - |
| `scene=steer,phone-pair` | only these scenes (default: all; `list=1` prints them) |
| `theme=light` or `theme=dark` | one theme (default: both) |
| `stills=0` or `video=0` | skip one kind |
| `out=<folder>` | output folder (default `D:\apaki-media`, or `$APAKI_MEDIA_DIR`) |
| `keep=1` | keep Playwright's raw recordings in `<out>/video/raw` |
| `playwright=<folder>` | a folder with `node_modules/playwright` (default: this repo's, then `~/.claude/mcp/playwright`) |
| `chromium=<exe>` | a Chromium or headless shell (default: Playwright's own, else the newest in its cache) |
| `ffmpeg=<exe>` | ffmpeg (default: `$FFMPEG`, then `ffmpeg` on the PATH, then the `ffmpeg-static` package) |
| `tune=<name>` | x264's tune for the close-up clips (default `animation`; `none` for no tune) |

Output layout:

```
apaki-media/
  _WHY_THIS_IS_HERE.md
  manifest.json                    every file with size, duration, scene, theme
  stills/<scene>-<theme>.png       the scene's hero shot (2880x1800, 1440x900 at 2x)
  stills/<scene>-<label>-<theme>.png   its other moments
  video/<scene>-<theme>.webm       VP9, 1440x900, 30 fps, under 4 MB, 8 to 14 s
  video/<scene>-<theme>.mp4        H.264, same
  crops/<name>-<theme>.mp4         a close-up clip (below): H.264, 30 fps, 2x pixels, under 1.5 MB
  crops/<name>-<theme>.png         its poster still, cropped the same way (the hero's moment)
  crops/<name>-<label>-<theme>.png the scene's other moments, cropped
```

Each clip is cut to the scene (the setup before `begin()` is trimmed) and re-encoded at rising CRF values until it is under 4 MB.

To look at the harness by hand instead:

```
node apaki/demo/server.mjs port=8765
```

then open `http://127.0.0.1:8765/desktop.html?ws=steer&theme=dark`. For the phone client at 390x844: `http://127.0.0.1:8765/phone.html?ws=phone&theme=light`; `ws=phone-browser` makes the first conversation play a visit to the demo shop as the real engine reports it (Browser tool lines and activity), so the phone's Browser button and view can be tried (the engine answers `browserView` with a drawn picture, and `forkSession` with a copy). Query string: `ws=<workspace>` (a name from `PRESETS` in `harness/data.mjs`), `theme=light|dark|auto`, `cursor=0` hides the pointer overlay, `seed=` and `now=` override the dice and the clock. It is a working window: type, send, steer, open the Glass panel.

The viewers (2026-10-13): `desktop.html?ws=viewers&tab=<n>` opens one tab per kind of artifact, each a conversation with its viewer beside it: 0 code, 1 a 100,000 row CSV, 2 a line chart, 3 a spreadsheet with two sheets, 4 a Word document, 5 a JSON tree, 6 JSON records, 7 a Markdown note with a revision the user edited (Changes, Edit and Save work), 8 to 11 bar, stacked area, scatter and pie charts, 12 an SVG. The artifacts are invented in `harness/artifacts.mjs` (the spreadsheet and the document are built as real zip files in memory), and the pretend engine answers `artifactGet`, `artifactEdit` and `artifactSave` the way the real one does. On the phone page, open a conversation and call `__apaki.openViewer({ sessionId, id, title, kind, sourcePane })` with one of those ids.

## The scenes

| Scene | What it shows | Stills |
| - | - | - |
| `sessions` | The sidebar: folders, sessions working in terminals (green "terminal, working"), Codex sessions with their hexagon mark (they open in panes since 2026-10-12), a session's right-click menu, a session opening in a new tab. | `overview` (hero), `menu`, `opened` |
| `search` | A vague question typed into the search box finds the right session by meaning ("by meaning" marks), then Ctrl+Enter asks Claude, which reads the best matches and says why each fits. | `results` (hero), `picks` |
| `steer` | Claude is mid-turn. Enter queues a message (a "Queued" card with Steer); Ctrl+Enter steers another into the running turn ("Steered in"). A subagent runs (Agent line, lit Tasks button), the edit lands, the test runs ten times. | `queued`, `steered` (hero) |
| `glass-swap` | The Myrlin Glass card at the bottom of the sidebar: open the panel, switch Claude to another subscription, then to an API key. The usage bars, the API key tag and the composer's billing chip follow. | `panel` (hero), `team`, `key` |
| `browser` | Ask Claude to try the checkout page: a browser pane opens beside the conversation, Claude types and clicks in it ("Claude, type [3]" above the page), and the page shows the bug. | `browsing` (hero), `reproduced` |
| `phone-pair` | The Phone sheet: Pair a phone, the QR code with its countdown, the phone that scanned it asks to connect (the code on both screens), Allow, and it shows as connected. | `qr` (hero), `approve`, `paired` |
| `split` | Three tabs, then three working sessions shift-clicked into split panes, all streaming at once, the Even grid button, and Ctrl+B to hide the sidebar for room. | `four`, `grid` (hero) |
| `phone` | The phone client (`phone.html`, at 390x844 with touch): the sessions list as home, a conversation slides in, a message is typed and sent, and Claude's reply streams back. The pointer is drawn as a touch. Clips are 390x844 (Playwright records CSS pixels); stills are 780x1688. | `list`, `working`, `reply` (hero) |
| `handoff` | Paired (below): three sessions in one tab on the PC, sidebar folded; the phone opens the left one from On your desktop, gets Session in use, takes it over and asks for the fix. At that moment the PC pane says the phone took it, and on its next look at the transcript (every 5 s, as the real pane does) it shows the phone's message and Claude's reply above that card. | PC `followed` (hero); phone `list`, `reply` (hero) |
| `worktrees` | Git worktrees (2026-10-12): the sidebar on its Worktrees view, the pane's branch label (fix-flaky-checkout +11 -2), its menu, and View changes opening the diff viewer beside the conversation, on the invented repositories of `harness/worktrees.mjs`. | `list`, `menu`, `diff` (hero) |
| `history` | A long transcript: thinking, tool calls, a diff, a subagent, a table, and what Claude Code says itself (a blocked prompt, an API retry, a Stop hook, a usage warning), up to the compaction with its summary. | `summary`, `system-lines` (hero), `diff`, `compaction` |

Close-ups (2026-10-12, for the home page) are scenes that reuse a scene above and are recorded at 2x and cropped (next section):

| Scene | From | Crop (CSS px of the 1440x900 window) | Encoded width | What it shows |
| - | - | - | - | - |
| `hero-pane` | `handoff` | `{8, 46, 710, 846}` | 1200 | The desktop pane the phone takes over; its phone half is `hero-phone` (the whole 390x844 page, 600 wide). Starts 0.8 s in. Poster: `followed` (PC), `reply` (phone). The takeover is the scene's `taken over` moment, printed in seconds into the clip. |
| `glass-card` | `glass-swap` | `{4, 132, 470, 728}` | 784 | The Glass panel over the sidebar, the Glass card under it, and the hover tooltip beside Use. Since the live account shows its 5-hour and weekly rings the panel is taller (its top at y 142 while "Claude switched." shows), so the crop starts at y 132 (2026-10-13). Poster: `team`. |
| `steer-line` | `steer` (own run) | `{452, 644, 896, 248}` | 1520 | The Running line, the Queued card with Steer, the composer with its settings line, and (new ending) the pointer resting on the context meter until its tooltip shows. Poster: `steered`; `meter` also saved. |
| `worktree-diff` | `worktrees` | `{360, 44, 1080, 484}` | 1530 | The branch label, its menu, and the diff viewer opening on the right. Poster: `diff`. |
| `search-meaning` | `search` | `{0, 104, 352, 634}` | 704 | The search box, the results marked "by meaning", Ask Claude's picks. Poster: `picks`. |
| `browser-pane` | `browser` (own run) | `{896, 44, 538, 704}` | 840 | The browser pane with its "Claude, type [3]" line; the prompt is sent and the pane opened in the setup, so the clip starts with the page there. Poster: `browsing`. |
| `pair-sheet` | `phone-pair` (own run) | `{402, 204, 636, 292}` | 1120 | The sheet's QR card, then the "wants to connect" card with its code, Deny and Allow, in the same place. The sheet is opened in the setup. Phone half `pair-phone`: the whole page, 520 wide. Posters: `approve`, `code`. |
| `sessions-list` | `sessions` (own run) | `{0, 318, 352, 396}` | 704 | A still only: the SESSIONS header and its one-line rows down to the Glass card, with a working, a waiting and a Codex row (2026-10-13; the list is not scrolled). |
| `codex-pair` | its own run on the `codex` preset | `{361, 548, 1072, 344}` | 2000 | Claude Code and Codex side by side (2026-10-13): the bottom of a Codex pane and a Claude pane in one tab. A message goes to each; Codex asks before it applies its patch (Approve once, Approve for this session, Deny) while Claude reads and writes; Approve once, and Codex answers. Both composers show their own model, effort, mode and account. Poster: `asks`; `answered` also saved. |
| `panes` | `split` | each `.stage.on .pane` | none (2x pixels) | Stills only: the grid's panes one by one, `pane-a` to `pane-d` (top to bottom, left to right). |

Paired scenes (2026-10-12): `handoff` and `phone-pair` also run a phone page (`pair` in `scenes.mjs`) beside the desktop one, both recorded at once and cut at the same instant, so the clips loop in step. The phone's files are `<scene>-phone-<label>-<theme>.png` and `<scene>-phone-<theme>.mp4`. In `phone-pair` the phone shows its Connect screen, then the same six digits as the PC, then the PC's sessions. The phone runs on its real `shim.js`, with `follow` off: a phone that only watches a desktop pane is planned on the PC side, not built, so no recording shows it.

The scenes are in `scenes.mjs`. A scene is `run(s)` with a small director: `s.begin()` marks where the clip starts (everything before it is setup and is cut), then `s.click(...)`, `s.type(...)`, `s.press('Control+Enter')`, `s.scrollTo(...)`, `s.waitFor(...)`, `s.pause(ms)` and `s.still('label')`. The pointer glides on an eased arc with real mouse events, typing runs at about 55 ms a key with small swings, and the rhythm repeats from run to run (seeded). `scenes.mjs` can be used on its own: `runScene(page, 'steer')` on any Playwright page that has the harness open.

## How it works

`apaki/ui` talks to the engine only through `window.__TAURI__` (`invoke`, `listen`, window calls). The harness supplies that and nothing else:

| File | Role |
| - | - |
| `phone.html`, `harness/phone-boot.mjs` | The phone client (2026-10-12): the same UI with the phone's own parts from `apaki/web/src` (web.css, native.js, pager.js, desktop.js), composed by the server the way `build-web.mjs` builds the phone page, and started the way `boot.js` starts it once a PC is connected. |
| `site-media.mjs`, `brand-images.mjs` | Turn a capture into the site's media (`relay/site/assets/media`: the close-up MP4 clips with their WebP posters and the still crops from `crops/`; the older full-window set with `legacy=1`) and the README's (`apaki/docs/media`: WebP stills, animated WebP loops), and draw the wordmark and the link preview. |
| `desktop.html` | The page template. The server fills in the head and body of `apaki/ui/index.html` at request time, so the demo always shows the UI as it is now. Nothing from `apaki/ui` is copied. |
| `server.mjs` | Serves `/ui/` (read only), `/harness/` and the composed `/desktop.html`. `startServer()` for scripts. |
| `harness/shim.mjs` | Installs `window.__TAURI__`, a fixed clock (10:42 on Tuesday 13 October 2026, ticking) and a seeded `Math.random`, so pictures repeat. Exposes `window.__demo` for the scene runner. Unknown shell APIs answer with a harmless no-op, so a new window call in the UI does not break it. |
| `harness/engine.mjs` | A pretend engine. Answers the window's ops (`sessions`, `open`, `send`, `steer`, `glassSwap`, `remote*`, `search`, `askSearch`, `subagents`, `agentWatch`...) with events shaped like the real engine's. |
| `harness/turns.mjs` | Scripted Claude turns: streamed text, tool calls and results, subagent tasks, steer points, system lines. Which script a session plays is set by the workspace preset. |
| `harness/data.mjs` | The invented dataset and the named starting workspaces (`PRESETS`). Node safe. |
| `harness/load.mjs`, `perf.mjs` | The `load` workspace (hundreds of sessions, 26 repositories, long transcripts, five panes working) and the driver that measures the window in it (2026-10-15; see Measuring the window under load). |
| `harness/browser-shell.mjs`, `harness/pages.mjs` | A pretend of the shell's built-in browser: the page is an iframe laid over the pane's body, placed by the same `place` command the real shell gets. The pages are a fictional shop. |
| `harness/cursor.mjs`, `harness/demo.css` | The on-screen pointer and click ripple, because a browser recording has none. |
| `scenes.mjs`, `capture.mjs` | The scenes and the Playwright and ffmpeg runner. |

A starting workspace is delivered the way the real window gets its saved one (the `loadState` op), so each scene starts with the tabs, panes and sidebar width it needs. The sidebar starts at 352 px: at the default 312 px the real UI cuts the "Sessions" heading to "SESSIO...".

To add a scene: add a preset to `PRESETS` if it needs its own workspace, add a script to `turns.mjs` if Claude should do something new, then add an entry to `SCENES` in `scenes.mjs`. Run it with `scene=<name> theme=light` and look at the stills.

## Close-up clips: the 2x screencast recorder

Playwright's `recordVideo` and a plain CDP screencast give CSS-pixel frames (1440x900) even with a device scale factor of 2, so a crop of a normal clip is soft on a 2x screen. A scene that has a `crop` in `scenes.mjs` is recorded another way (`recordCrop` in `capture.mjs`):

1. A Chromium of its own is started with the `force-device-scale-factor` switch set to 2 (written with its two leading hyphens in `capture.mjs`, built there so no source file holds a double hyphen), and the page opens in a context at 1440x900, device scale 2 (the phone page at 390x844, touch, so 780x1688 frames). Since 2026-10-13 `capture.mjs` keeps one browser running at a time: it closes the plain one (stills, full-window clips) before it starts this one, and the other way round.
2. A CDP screencast (`Page.startScreencast`, JPEG at quality 90, up to 2880x1800) writes every frame to a temporary folder, stamped with the time it arrived. Chrome sends a frame only when the page changes, so each frame is acknowledged at once and written without waiting.
3. The clip is cut at the scene's `begin()` (`result.beganAt`, 0.1 s early; `clipFrom` starts later, `clipSeconds` caps it) and ends where the scene ends. ffmpeg's concat demuxer lays the frames out with their real durations; the filter crops to the scene's rectangle (CSS pixels times two), scales down to `maxWidth` if that is narrower (never up), converts the JPEG frames (full range, BT.601) through RGB to limited range BT.709 and tags the clip so (swscale cannot convert the matrix yuv to yuv; the colours were checked against the source pixels), makes a constant 30 fps and encodes H.264 (preset slow, tune animation, yuv420p, faststart, no audio; compared at 100% the text is as crisp as without the tune, and the file about 15% smaller). The CRF starts at 20 and steps up only to get under 1.5 MB; past 23 `capture.mjs` says so and the scene's clip should be made shorter instead (`clipFrom`, `clipSeconds`, a shorter run).
4. A paired close-up (`hero-pane`, `pair-sheet`) records the phone page the same way, cut at the same instant to the same length. A scene whose timing slips on a busy machine past the longest clip it may be (its `maxSeconds`, 14 s unless set) is recorded again, up to three times.
5. The still of each moment is `page.screenshot({ clip })` on the device-scale-2 context, which is already sharp. `heroOnly` scenes keep just the hero's. A scene with `crop: { each, names, at }` takes one picture per matching element (`panes`).

A scene's `maxWidth` is 2x the widest the page shows it. The page's idea of the size is in `site-media.mjs` through the encoded sizes: the poster is made at exactly the clip's pixel size.

The frames lag the page: a change reaches a frame 0.3 to 0.7 s later on a busy machine (software rendering and JPEG encoding at 2880x1800; it was measured with a flipping marker, about 6 frames a second while a scene runs). So the clip is not cut on arrival times. A 12x12 px marker in the window's top left corner (outside every crop; `startScreencast` with `sync`) flips red and green every 1.2 s on a known clock, `frameLag()` reads its colour out of every frame with one ffmpeg run and pairs each change with its flip, and the cut is made where the page was: the start is moved later and the end waited for (the page is kept alive 3.2 s after the scene) by the lag measured at that moment. The phone page has no marker; it is cut with the desktop's lag. `capture.mjs` prints the lag it found for each clip. A scene that has to be on a certain screen at the start still waits a beat before `begin()` (see `browser-pane`).

## From a capture to the site

```
node apaki/demo/capture.mjs ffmpeg=<exe>
node apaki/demo/site-media.mjs ffmpeg=<exe>      # relay/site/assets/media and apaki/docs/media
node apaki/demo/site-media.mjs ffmpeg=<exe> docs=0   # the site only
node apaki/demo/site-media.mjs ffmpeg=<exe> docs=0 only=glass-card,codex-pair   # only these close-ups
node apaki/demo/brand-images.mjs ffmpeg=<exe>    # docs/media/wordmark-*.png and relay/site/assets/og.jpg
```

ffmpeg needs libx264 and libwebp (the `ffmpeg-static` package has both). Since 2026-10-12 the site gets the close-ups from `crops/`: each clip's MP4 copied as captured, and its poster as WebP (quality 90, `-preset text`) at exactly the clip's pixel size, light and dark: `hero-pane`, `hero-phone`, `glass-card`, `steer-line`, `worktree-diff`, `search-meaning`, `browser-pane`, `pair-sheet`, `pair-phone`, `codex-pair` (`<name>-<theme>.mp4` and `.webp`), plus the still crops `sessions-list` (704 wide) and `pane-a` to `pane-d` (at their own 2x pixels) as `<name>-<theme>.webp`. `legacy=1` also writes the older set: the full-window clips with their 1200 and 2000 px posters, the phone's stills and the `search-hits` crop. Nothing is ever deleted from `relay/site/assets/media`; the page's author removes files it no longer points at.

## Measuring the window under load (2026-10-15)

The report was "our apaki app gets kind of laggy with multiple tabs and panes running at the same time - it doesnt stay sharp". The `load` workspace is a window that busy, on invented data (`harness/load.mjs`): five tabs, thirteen conversations, five of them working at once (three in the tab on screen), each turn streamed the way the Agent SDK sends it (thinking and tool input deltas, text, tool calls with long output, a subagent whose own traffic comes through), two panes with 2400 messages and four with the first 300 of 3000, the side panel with three viewers, about 640 sessions in the list and 26 repositories whose numbers move every 2 to 3 seconds (a `worktrees` event each time), the list again every 10 seconds. Look at it with `desktop.html?ws=load`.

```
node apaki/demo/perf.mjs
node apaki/demo/perf.mjs seconds=60 warm=10 label=after out=<folder>
node apaki/demo/perf.mjs ui=<a copy of an older apaki/ui> label=before
```

It starts the server and one headless Chromium (1440x900, device scale 1), waits for the workspace to come back, lets the load run `warm` seconds, then types into the focused composer, a key every 250 ms, for `seconds`, and prints:

| Number | What it is |
| - | - |
| `startup` | time until every pane drew its history, and the long tasks meanwhile |
| `measured.busyPct` | share of the main thread spent in tasks while typing (CDP `TaskDuration`), with script, layout and style shares; `harnessPct` is the pretend engine's own share (it runs on the page's thread here, the real one does not) |
| `inputP50Ms`, `inputP95Ms` | time from a key press to the next frame after it |
| `longTasksPerMin`, `worstLongTaskMs` | tasks over 50 ms |
| `watching` | the same load for `watch` seconds (default 15) with no one typing |
| `loadAll` | the worst stall while a paged conversation's 2700 earlier messages come in |
| `tabSwitch` | the worst stall as each tab comes forward |
| `memory` | JS heap, DOM nodes and listeners at the end |
| `windowLog` | the lines the page wrote for apaki-window.log (a stall, a busy minute) |

Then the functions with the most self time, and Apaki's own by total time. `trace=1` adds a timeline trace of the typing stretch (main thread time by event, style and layout by what forced them, the longest tasks and what filled them); `trace=switch` traces the tab switches instead. `out=` also writes `<label>.json` and `<label>.cpuprofile` (open it in DevTools). `ui=` serves another copy of `apaki/ui` on the same harness, for a before and after. Runs differ by a few points from one to the next; compare runs of 60 seconds, twice each.

## What it cannot fake yet

- Native OS chrome. The window has no title bar frame here; the UI's own minimize, maximize and close buttons show, but nothing outside the window. Put the clips in a device frame on the page if you want one.
- Real page content in the browser pane. It shows one fictional shop (cart, checkout) and a "nothing here" page for any other address.
- Dictation, image paste and drag and drop between panes (a recording could drive these, but no scene does yet), the folder chooser sheet for a new conversation (the engine answers `places` and `listDir` with nothing), the sign-in card and billing sheet beyond the Glass panel, artifacts that a scripted turn shows live (the viewers preset opens them from a saved workspace instead), HTML and PDF artifacts (they need the engine's localhost server), shells and monitors.
- Sound. The ding plays nothing in a recording.
- Search is a small table of "meanings" for the demo sessions, not an index: only the example questions in `harness/engine.mjs` find things by meaning.
- The recorder captures about 25 frames a second; clips are converted to 30 fps by repeating frames, so very fast motion is not smoother than the source. The close-ups' screencast sends a frame only when the page changes (15 to 20 a second while it moves), so the same holds there.

The Playwright recorder cannot be paced by the page, so a clip's length is the scene's real running time. A scene that drifts outside 8 to 14 seconds is reported by `capture.mjs`.
