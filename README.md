# claude-latch

`latch` opens a Claude Code conversation in the real Claude Code TUI and bills its messages to an Anthropic API key (Platform credits) instead of your subscription. You pick the session (or start a new one) and the key; latch launches Claude Code resumed on that session, with Opus 5.5, xhigh effort and permissions skipped.

Interactive Claude Code is refused on these credits (`billing_error`, "Credit balance is too low"), while headless Claude Code on the same key is accepted. So the window runs on your normal login, and the prompt-relay hook (`~/.claude/hooks/prompt-relay.js`) runs each message as a headless `claude -p --resume <this session>` on the key. Replies come back into the window laid out like Claude Code (tool lines, then the reply, then a footer with time, cache and cost), and every turn lands in the same session.

`latch --lite` keeps latch's own lighter UI over the Claude Agent SDK (see below).

## Use

```
npm install
npm link            # puts `latch` on PATH

latch               # pick from recent sessions (all folders)
latch 636fe0ce      # open a session by id prefix
latch -c            # latest session started in this folder
latch -n            # new session in this folder
latch -l            # list recent sessions
latch <id> --dry-run   # print the Claude Code command, folder and billing, then stop
```

Defaults: `--model claude-opus-5-5`, `--effort xhigh`, and `--dangerously-skip-permissions`. Override with `-m`, `-e`, or `--mode acceptEdits|default|plan`. Your PreToolUse hooks still run in skip-permissions mode, so the guards in `~/.claude/settings.json` still block what they block.

## Billing

First match wins:

1. `--sub`: the live Claude Code login, whatever it is.
2. `--key <words>`: the `Anthropic API Key (...)` section of `~/.claude/credentials.md` whose heading contains the words.
3. The live login, when Myrlin Glass has switched it to an API key.
4. The default vault key (`LATCH_DEFAULT_KEY`, else "Arthur's Org").

latch never gives the window itself an API key; any inherited `ANTHROPIC_API_KEY` (this PC has a Machine-scope corporate one) is removed. It sets `PROMPT_RELAY_FORCE=1` and `PROMPT_RELAY_KEY_WORDS` on the window, and the relay hook bills each headless run to that key. `--sub` skips the relay and lets the window answer on your subscription.

Limits of the relayed window: a reply appears when its run finishes (no live streaming), and a headless run cannot stop for questions or approvals, so the model asks in its reply instead. Window commands (`/status`, `/model`, `/resume`...) stay local; other slash commands and skills are relayed.

## One window per session

A Claude Code window keeps its conversation in memory, so two windows on one session fork it. latch warns when the session changed in the last two minutes, and only one latch can hold a session at a time (`--force` takes it over). To go back to your subscription, exit and run `claude --resume <id>`.

## Lite mode

`latch --lite` runs its own readline UI over the Agent SDK instead of the Claude Code TUI: streamed markdown, one line per tool call and result, inline approvals, a per-turn footer with cache and cost. Before each message it checks whether anything else wrote to the session and reloads from disk first. `/help` lists its commands (`/model`, `/mode`, `/effort`, `/key`, `/reload`, `/session`, `/exit`); other `/` commands go to Claude Code. Piped input works for scripted runs.

## Files

- `bin/latch.js`: arguments, session picker, the launch or lite wiring.
- `src/launch.js`: starting the native Claude Code binary with the session, flags and key.
- `src/auth.js`: credential choice and the child environment.
- `src/sessions.js`: transcript facts and the owner lock.
- `src/runner.js`, `src/tui.js`, `src/render.js`: lite mode.

Runtime files live in `~/.claude/latch/`: `locks/` (one file per attached session) and `latch.log` (lite mode's Claude Code stderr, keys masked).

## Test

`npm test` runs the unit tests: rendering, credential choice and env scrub, transcript parsing, lock, outside-change detection, Claude Code arguments, key-approval lookup.
