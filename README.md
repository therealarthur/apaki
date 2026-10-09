# claude-latch

`latch` continues a Claude Code conversation in a terminal UI billed to an Anthropic API key. It uses Claude Code's own tools, settings, `CLAUDE.md`, hooks and MCP servers, through the Claude Agent SDK, and writes every turn into the same session file. `claude --resume <id>` picks the conversation up afterwards, latch's turns included.

## Use

```
npm install
npm link            # puts `latch` on PATH

latch               # pick from recent sessions
latch 636fe0ce      # continue a session by id prefix
latch -c            # latest session started in this folder
latch -n            # new session in this folder
latch -l            # list recent sessions
```

In the UI: Enter sends, a line ending in `\` continues, pastes arrive as one message, messages typed during a turn are queued. Esc or Ctrl+C interrupts a turn; Ctrl+C twice or Ctrl+D exits. `/help` lists the local commands (`/model`, `/mode`, `/effort`, `/key`, `/reload`, `/session`, `/exit`). Other `/` commands, such as `/compact`, go to Claude Code.

Tool calls that need approval are asked inline: `y`, `n`, `a` (always allow that tool for this run), or type a reason to deny with it.

## Billing

First match wins:

1. `--sub`: the live Claude Code login, whatever it is.
2. `--key <words>`: the `Anthropic API Key (...)` section of `~/.claude/credentials.md` whose heading contains the words.
3. The live login, when Myrlin Glass has switched it to an API key.
4. The default vault key (`LATCH_DEFAULT_KEY`, else "Arthur's Org").

The child process gets exactly one auth source. Any inherited `ANTHROPIC_API_KEY` (this PC has a Machine-scope corporate one) is removed first. `/key <words>` or `/key sub` switches mid-session.

Each turn's footer shows time, tokens read from cache, new tokens, and that turn's cost. The first turn after attaching writes the conversation to cache on that key; later turns read it.

## One owner at a time

An open Claude Code window keeps its conversation in memory and does not see latch's turns, so:

- Stop typing in the window while latch has the session. When you go back, run `claude --resume <id>` (latch prints it on exit), or `/resume` in the window.
- Before each message latch checks whether anything else added a message to the session. If so, it reloads from disk first and says so.
- Only one latch can attach to a session (`--force` takes it over from another).

## Files

- `bin/latch.js`: arguments, session picker, header, wiring.
- `src/runner.js`: the Claude Code process (streaming input, interrupt, reload on outside change, per-turn cost).
- `src/tui.js`: the readline UI, rendering of SDK messages, approvals, local commands.
- `src/render.js`: line-by-line markdown rendering for the terminal.
- `src/auth.js`: credential choice and the child environment.
- `src/sessions.js`: transcript facts and the owner lock.

Runtime files live in `~/.claude/latch/`: `locks/` (one file per attached session) and `latch.log` (the Claude Code process's stderr, keys masked).

## Test

`npm test` runs the unit tests (rendering, credential choice and env scrub, transcript parsing, lock, outside-change detection).
