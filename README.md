# claude-latch

`latch` continues Claude Code conversations on Platform (API) credits instead of your subscription.

**Default (in a terminal): a full-screen app** built with Ink, the library Claude Code's own TUI uses.
- **Picker:** a search box, a two-line row per session (title, then age · folder · size · branch, and "open in N windows"), a preview of the first and latest prompts, Ctrl+F to search inside every conversation, Tab for sessions open in a window, Ctrl+A to include headless sessions.
- **Chat:** Claude Code's layout over the Agent SDK. Streamed replies with markdown, `⏺ Tool(args)` lines with `⎿` results, red/green diffs for edits, todo lists, subagent progress under Task, the spinner with time and tokens, a rounded prompt box (`\` or Alt+Enter for new lines, ↑↓ history), Shift+Tab through default / accept edits / plan / bypass, Esc to interrupt, and real dialogs for permissions, AskUserQuestion and plan approval. The last 12 turns of the session show on open.
- **Commands:** the `/` menu lists everything Claude Code has here (about 140: built-ins, your skills, the GSD / superpowers / impeccable plugins, custom commands). Those run in Claude Code. The interactive-only built-ins are done by latch: /help /clear /resume /model /effort /status /cost /mcp /agents /key /reload /exit.
- Tools, MCP servers, hooks, CLAUDE.md and settings load exactly as in Claude Code (`claude_code` system prompt, all setting sources). Questions and plan approval are answered through a PreToolUse hook, because the SDK skips the permission callback in bypass mode.

`--relay` opens the real Claude Code TUI instead. Interactive Claude Code is refused on these credits (`billing_error`) while headless runs are accepted, so in that mode the prompt-relay hook runs each message as a headless `claude -p --resume` on the key, and the reply arrives as a hook notice after the run. `--lite` is the line-based UI, also used for piped input.

## Use

```
npm install
npm link            # puts `latch` on PATH

latch               # searchable picker of all sessions (see below)
latch ground truth  # the picker, already searching for "ground truth"
latch 636fe0ce      # open a session by id prefix
latch -c            # latest session started in this folder
latch -n            # new session in this folder
latch -l            # list recent sessions
latch <id> --dry-run   # print the Claude Code command, folder and billing, then stop
```

Defaults: `--model claude-opus-5-5`, `--effort xhigh`, and `--dangerously-skip-permissions`. Override with `-m`, `-e`, or `--mode acceptEdits|default|plan`. Your PreToolUse hooks still run in skip-permissions mode, so the guards in `~/.claude/settings.json` still block what they block.

## Finding a session

`latch` with no session id opens a full-screen picker. Type to filter: every word must appear in a session's title, first prompt, folder, id or branch, and title matches rank first. **Ctrl+F** searches inside the conversations themselves, only in what was said (your prompts and Claude's replies, at word starts), skipping injected context and tool output; it shows a progress count and a snippet of the matching message. Sessions open in a running Claude Code window are marked `open` (`open ×2` when in two). The bottom pane shows the selected session's id, folder, size, age, first prompt and latest prompt.

Keys: Up/Down (Ctrl+P/N), PgUp/PgDn, **Enter** opens, **Tab** open sessions only, **Ctrl+A** include headless sessions, Ctrl+U clears, Esc clears the search or quits, Ctrl+C quits. Piped input falls back to a numbered list.

**Deep search.** With `index/` built (`cd index && cargo build --release`), typing also searches the `latch-index` full-text index of every transcript on the machine, subagent and workflow runs included: prompts, replies, tool calls and tool output. Results come in relevance order, each labelled with where the match was (`you:`, `claude:`, `tool output:`, `subagent …`). The index updates itself when the picker opens (well under a second after the first build). Without the binary, Ctrl+F scans the files instead.

**Views and folders.** Left/Right switches between **All**, **Open in terminal** and one view per folder. *Open in terminal* imports every session open in a Claude Code terminal window right now, from Claude Code's live records in `~/.claude/sessions`, refreshed every 2 seconds, with the window's name and busy/idle status; those sessions also lead the All view. **Ctrl+G** files the selected session in a folder (or a new one, or out of its folder); a session sits in one folder at a time. In a folder view, **Ctrl+R** renames it and **Ctrl+D** deletes it (its sessions are untouched). Folders live in `~/.claude/latch/folders.json`.

## Billing

First match wins:

1. `--sub`: the live Claude Code login, whatever it is.
2. `--key <words>`: the `Anthropic API Key (...)` section of `~/.claude/credentials.md` whose heading contains the words.
3. The live login, when Myrlin Glass has switched it to an API key.
4. The default vault key (`LATCH_DEFAULT_KEY`, else "Arthur's Org").

latch never gives the window itself an API key; any inherited `ANTHROPIC_API_KEY` (this PC has a Machine-scope corporate one) is removed. It sets `PROMPT_RELAY_FORCE=1` and `PROMPT_RELAY_KEY_WORDS` on the window, and the relay hook bills each headless run to that key. `--sub` skips the relay and lets the window answer on your subscription.

Limits of the relayed window: a reply appears when its run finishes (no live streaming), and a headless run cannot stop for questions or approvals, so the model asks in its reply instead. Window commands (`/status`, `/model`, `/resume`...) stay local; other slash commands and skills are relayed. `/model` and `/effort` picked in the window apply to the relayed turns that follow.

## One window per session

A Claude Code window keeps its conversation in memory, so two windows on one session fork it. latch warns when the session changed in the last two minutes, and only one latch can hold a session at a time (`--force` takes it over). To go back to your subscription, exit and run `claude --resume <id>`.

## Lite mode

`latch --lite` runs its own readline UI over the Agent SDK instead of the Claude Code TUI: streamed markdown, one line per tool call and result, inline approvals, a per-turn footer with cache and cost. Before each message it checks whether anything else wrote to the session and reloads from disk first. `/help` lists its commands (`/model`, `/mode`, `/effort`, `/key`, `/reload`, `/session`, `/exit`); other `/` commands go to Claude Code. Piped input works for scripted runs.

## Files

- `bin/latch.js`: arguments, the launch or lite wiring.
- `src/picker.js`: the searchable session picker.
- `src/launch.js`: starting the native Claude Code binary with the session, flags and key.
- `src/auth.js`: credential choice and the child environment.
- `src/sessions.js`: transcript facts and the owner lock.
- `src/runner.js`, `src/tui.js`, `src/render.js`: lite mode.

Runtime files live in `~/.claude/latch/`: `locks/` (one file per attached session) and `latch.log` (lite mode's Claude Code stderr, keys masked).

## Artifacts in Myrlin Apaki

Claude running inside Apaki (the desktop app in `apaki/`) can show the user things in Apaki itself, with nothing installed or written to any settings file. The Apaki engine passes everything per pane through Agent SDK options (latch's own runner passes none of them):

- An in-process MCP server `apaki` with one tool, `show` (`mcp__apaki__show`): `html`, `markdown`, `svg`, `image`, `file` (any local html, md, image, pdf, text or code file) or `url`. Pass `id` again to update it; every show is a revision. Stored in `~/.claude/latch/artifacts/<session>/` (`apaki/engine/artifacts.js`).
- A short paragraph appended to Claude Code's system prompt saying the tool exists.
- PreToolUse / PostToolUse hooks on Bash and PowerShell (`apaki/engine/open-catch.js`, `apaki-tools.js`): `start x.html`, `Start-Process http://...`, `explorer`, `open`, `xdg-open`, `python -m webbrowser`, `rundll32 url.dll` and friends are denied with "Opened in Apaki instead: ..." and shown in Apaki; in a longer command only the open step is cut out. `npm start`, `Start-Sleep`, starting programs and git are left alone.
- `BROWSER` pointing at `apaki/bin/apaki-open.cmd`, which hands URLs to the engine's 127.0.0.1 server (random port, a token per pane), so `vite --open`, Python's webbrowser and gh open in Apaki too.

The window shows artifacts in a viewer pane beside the conversation (a sandboxed iframe for HTML: scripts, forms and alerts only, never same-origin, served with a CSP that blocks all network) and a card in the transcript, rebuilt from history when a session is reopened. Web pages get a link card for now. `apaki/engine/apaki-mcp-stdio.mjs` is the same tools (show and the browser tools) as a stdio server: the Codex process a Codex pane runs gets it through `-c mcp_servers.apaki.*` on its own command line, and it forwards every call to the engine. No-cost check of the viewer: `node apaki/scripts/cdp-artifacts.mjs <out-prefix> <cdp port>`.

## Test

`npm test` runs the unit tests: rendering, credential choice and env scrub, transcript parsing, lock, outside-change detection, Claude Code arguments, key-approval lookup, and for Apaki the layout tree, the "open this" matcher, the artifact store and server, the show tool through a real MCP client, the hooks, the BROWSER shim and the stdio tool server.
