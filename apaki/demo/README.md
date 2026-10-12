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

Output layout:

```
apaki-media/
  _WHY_THIS_IS_HERE.md
  manifest.json                    every file with size, duration, scene, theme
  stills/<scene>-<theme>.png       the scene's hero shot (2880x1800, 1440x900 at 2x)
  stills/<scene>-<label>-<theme>.png   its other moments
  video/<scene>-<theme>.webm       VP9, 1440x900, 30 fps, under 4 MB, 8 to 14 s
  video/<scene>-<theme>.mp4        H.264, same
```

Each clip is cut to the scene (the setup before `begin()` is trimmed) and re-encoded at rising CRF values until it is under 4 MB.

To look at the harness by hand instead:

```
node apaki/demo/server.mjs port=8765
```

then open `http://127.0.0.1:8765/desktop.html?ws=steer&theme=dark`. For the phone client at 390x844: `http://127.0.0.1:8765/phone.html?ws=phone&theme=light`; `ws=phone-browser` makes the first conversation play a visit to the demo shop as the real engine reports it (Browser tool lines and activity), so the phone's Browser button and view can be tried (the engine answers `browserView` with a drawn picture, and `forkSession` with a copy). Query string: `ws=<workspace>` (a name from `PRESETS` in `harness/data.mjs`), `theme=light|dark|auto`, `cursor=0` hides the pointer overlay, `seed=` and `now=` override the dice and the clock. It is a working window: type, send, steer, open the Glass panel.

## The scenes

| Scene | What it shows | Stills |
| - | - | - |
| `sessions` | The sidebar: folders, sessions working in terminals (green "terminal, working"), Codex sessions marked "codex, read-only", a session's right-click menu, a session opening in a new tab. | `overview` (hero), `menu`, `opened` |
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

Paired scenes (2026-10-12): `handoff` and `phone-pair` also run a phone page (`pair` in `scenes.mjs`) beside the desktop one, both recorded at once and cut at the same instant, so the clips loop in step. The phone's files are `<scene>-phone-<label>-<theme>.png` and `<scene>-phone-<theme>.mp4`. In `phone-pair` the phone shows its Connect screen, then the same six digits as the PC, then the PC's sessions. The phone runs on its real `shim.js`, with `follow` off: a phone that only watches a desktop pane is planned on the PC side, not built, so no recording shows it.

The scenes are in `scenes.mjs`. A scene is `run(s)` with a small director: `s.begin()` marks where the clip starts (everything before it is setup and is cut), then `s.click(...)`, `s.type(...)`, `s.press('Control+Enter')`, `s.scrollTo(...)`, `s.waitFor(...)`, `s.pause(ms)` and `s.still('label')`. The pointer glides on an eased arc with real mouse events, typing runs at about 55 ms a key with small swings, and the rhythm repeats from run to run (seeded). `scenes.mjs` can be used on its own: `runScene(page, 'steer')` on any Playwright page that has the harness open.

## How it works

`apaki/ui` talks to the engine only through `window.__TAURI__` (`invoke`, `listen`, window calls). The harness supplies that and nothing else:

| File | Role |
| - | - |
| `phone.html`, `harness/phone-boot.mjs` | The phone client (2026-10-12): the same UI with the phone's own parts from `apaki/web/src` (web.css, native.js, pager.js, desktop.js), composed by the server the way `build-web.mjs` builds the phone page, and started the way `boot.js` starts it once a PC is connected. |
| `site-media.mjs`, `brand-images.mjs` | Turn a capture into the site's media (`relay/site/assets/media`: MP4 clips, WebP posters at 1200 and 2000 px, crops) and the README's (`apaki/docs/media`: WebP stills, animated WebP loops), and draw the wordmark and the link preview. |
| `desktop.html` | The page template. The server fills in the head and body of `apaki/ui/index.html` at request time, so the demo always shows the UI as it is now. Nothing from `apaki/ui` is copied. |
| `server.mjs` | Serves `/ui/` (read only), `/harness/` and the composed `/desktop.html`. `startServer()` for scripts. |
| `harness/shim.mjs` | Installs `window.__TAURI__`, a fixed clock (10:42 on Tuesday 13 October 2026, ticking) and a seeded `Math.random`, so pictures repeat. Exposes `window.__demo` for the scene runner. Unknown shell APIs answer with a harmless no-op, so a new window call in the UI does not break it. |
| `harness/engine.mjs` | A pretend engine. Answers the window's ops (`sessions`, `open`, `send`, `steer`, `glassSwap`, `remote*`, `search`, `askSearch`, `subagents`, `agentWatch`...) with events shaped like the real engine's. |
| `harness/turns.mjs` | Scripted Claude turns: streamed text, tool calls and results, subagent tasks, steer points, system lines. Which script a session plays is set by the workspace preset. |
| `harness/data.mjs` | The invented dataset and the named starting workspaces (`PRESETS`). Node safe. |
| `harness/browser-shell.mjs`, `harness/pages.mjs` | A pretend of the shell's built-in browser: the page is an iframe laid over the pane's body, placed by the same `place` command the real shell gets. The pages are a fictional shop. |
| `harness/cursor.mjs`, `harness/demo.css` | The on-screen pointer and click ripple, because a browser recording has none. |
| `scenes.mjs`, `capture.mjs` | The scenes and the Playwright and ffmpeg runner. |

A starting workspace is delivered the way the real window gets its saved one (the `loadState` op), so each scene starts with the tabs, panes and sidebar width it needs. The sidebar starts at 352 px: at the default 312 px the real UI cuts the "Sessions" heading to "SESSIO...".

To add a scene: add a preset to `PRESETS` if it needs its own workspace, add a script to `turns.mjs` if Claude should do something new, then add an entry to `SCENES` in `scenes.mjs`. Run it with `scene=<name> theme=light` and look at the stills.

## From a capture to the site

```
node apaki/demo/capture.mjs ffmpeg=<exe>
node apaki/demo/site-media.mjs ffmpeg=<exe>      # relay/site/assets/media and apaki/docs/media
node apaki/demo/brand-images.mjs ffmpeg=<exe>    # docs/media/wordmark-*.png and relay/site/assets/og.jpg
```

ffmpeg needs libx264 and libwebp (the `ffmpeg-static` package has both). The site uses each clip's MP4 as captured, the hero still of each scene as its poster, and the phone scene's `list` and `reply` stills.

## What it cannot fake yet

- Native OS chrome. The window has no title bar frame here; the UI's own minimize, maximize and close buttons show, but nothing outside the window. Put the clips in a device frame on the page if you want one.
- Real page content in the browser pane. It shows one fictional shop (cart, checkout) and a "nothing here" page for any other address.
- Dictation, image paste and drag and drop between panes (a recording could drive these, but no scene does yet), the folder chooser sheet for a new conversation (the engine answers `places` and `listDir` with nothing), the sign-in card and billing sheet beyond the Glass panel, artifacts (`show`), shells and monitors.
- Sound. The ding plays nothing in a recording.
- Search is a small table of "meanings" for the demo sessions, not an index: only the example questions in `harness/engine.mjs` find things by meaning.
- The recorder captures about 25 frames a second; clips are converted to 30 fps by repeating frames, so very fast motion is not smoother than the source.

The Playwright recorder cannot be paced by the page, so a clip's length is the scene's real running time. A scene that drifts outside 8 to 14 seconds is reported by `capture.mjs`.
