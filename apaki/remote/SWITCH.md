# Switch a conversation between Claude Code and Codex (design, 2026-10-11)

Arthur's request, in session 72e2ddd9 (2026-10-11), verbatim:

> lets think about an abstraction layer where we take any session and all of its data, and create a unified agnostic transcript with all of the data - this way when limits are met, i can click a button that says switch to gpt, and gpt gets a diff of the full transcript we're keeping or something alonge those lines in the format it prefers with EVERYTHING including all guidlines/skills/etc that claude code might have - and then when i want to switch back, i can click a button to migrate/switch to claude code, theres a diff of the transcripts again and then claude code can see not only evereything thats been done, but also the prompts the user sent to the chatgpt controlled convo, the responses, the artifacts, literally everything.

is this feasible? what might this look like?

Arthur, 2026-10-12: "using opus5.5 xhigh (there might be a session that was trying to do this) integrate the claude codex stuff". That session answered with the design below and wrote no code; this file keeps it so the build follows it. Status of the build is at the end.

---

**Yes, it's feasible, and Apaki already does a lot of it.** It reads every Claude transcript, indexes Codex sessions, and follows Glass. I looked at what's on disk: a Codex 0.161 session file records prompts, replies, tool calls and their outputs, reasoning, context compactions, and the settings for each turn. `codex resume <id> [PROMPT]` exists. So both directions can be read, and both can be resumed with new input.

I'd change two things about the idea:

1. **Keep both native sessions alive.** Don't translate the whole conversation into the other model's format on every switch. Codex gets its own thread on the first switch. When you switch back, Claude resumes its original session plus one message describing what happened in Codex. Claude's own history never makes a lossy round trip, and the same goes for GPT.
2. **Make "everything" available, but don't stuff it into the prompt.** Your Claude sessions often run to hundreds of thousands of tokens with auto-compact off, and that won't fit in GPT's context window. The prompt carries a summary plus the recent turns word for word. The full record sits behind a small MCP server that both agents can query.

## What it looks like

```
 ~/.claude/projects/*.jsonl ─┐                      ┌─> Claude: resume <id> + "while you were in Codex: ..."
 (incl. subagents)            ├─> Ledger (one shared ┤
 ~/.codex/sessions/*.jsonl ──┘   append-only record) └─> Codex: resume <thread> + "since you left: ..."
                                   │      ▲
                         Ledger MCP │      │ git checkpoint per switch
                    (search, get event, full tool output, artifacts)
```

- **Ledger:** one shared record of every event, regardless of provider: prompt, reply, reasoning, tool call and result, file change, artifact, compaction, subagent, settings. Each event is tagged with its provider and points back to its source file and line. A "thread" links Claude session X to Codex thread Y.
- **The "diff" you described:** each side keeps a bookmark at the last event it saw. Switching sends it everything after its bookmark: your prompts to the other model, its replies, a list of the tools it used and what came back, and its artifacts.
- **Code state:** take a git checkpoint at each switch, e.g. `refs/apaki/handoff/N`. The handoff then includes the actual code diff, not just the other model's description of its edits, and it catches edits you made by hand in between.
- **Instructions and tools (environment parity):** generate the Codex side from the Claude side:
  - `CLAUDE.md` and the memory index go to Codex's instructions. `~/.codex/AGENTS.md` already mirrors part of them by hand.
  - Skills go to `~/.codex/skills`.
  - MCP servers in `~/.claude.json` go to the `mcp_servers` section of `config.toml`.
  - Claude Code's own system prompt doesn't get ported. Codex has its own; only your layer moves.
- **In Apaki:** a "Switch to GPT" button on the pane, lit when Glass says your Claude accounts are used up. The pane becomes a Codex pane in the same thread, and each turn shows which provider answered it. Apaki would show the conversation from the ledger instead of from either transcript. This needs real Codex tabs, probably driven through `codex app-server`; Apaki only shows Codex sessions read-only today.

## What won't carry over

- **GPT's reasoning is encrypted** (`encrypted_content`), so Claude only sees GPT's reasoning summaries. Claude's thinking text can go to GPT.
- **The model that takes over reads a record; it doesn't share the other model's working memory.** How good the handoff is depends on the packet, and the recent turns sent word for word matter most.
- **Tool names differ** (Edit/Bash vs apply_patch/shell). The handoff should describe the other side's tool calls as plain text ("edited x.ts +12 -3, ran tests, 2 failed"), not replay them as native calls.
- **Hooks have no 1:1 equivalent in Codex.** The `taskkill` guard would need Codex's approval and sandbox rules; the em dash rule just becomes a written instruction.
- **Neither transcript format is documented**, and Codex 0.161 already has new event types. The readers need to tolerate unknown types and need tests built from saved sample transcripts.
- **"GPT" here means Codex.** Anything you type on chatgpt.com never reaches disk, so it can't be captured.
- **Shipping it to other people** runs into the Agent SDK terms already in your notes. It's fine for your own use.

**Build order:**
1. Ledger and the two transcript readers, read-only. They can be tested on sessions you already have.
2. Handoff packet, git checkpoint, and the Claude-to-Codex switch.
3. Ledger MCP server.
4. Return path: Claude resumes with the Codex delta.
5. Generating the Codex instructions, skills and MCP config from the Claude side.
6. The unified pane in Apaki.

Steps 1 and 2 alone give you a working "switch to GPT". Want me to start on them in the claude-latch repo?

---

## Build status

EXPERIMENTAL, parked (2026-10-12). Arthur, the same day: "the switch to codex functionality is experimental and
should not be focused on right now". What exists lives on the branch `apaki-switch` only and is not merged. No
switch control is shown anywhere in the window or on the phone; the engine op exists for tests.

Built and tested (engine side, against the fake app-server; no real turn on any account):

- Step 1, ledger and readers: `apaki/engine/ledger.js` reads a Claude transcript and a Codex rollout (0.161 shapes and
  older ones) into the same events, by byte offset, read only, unknown line types counted and skipped. Checked by
  hand on real files (counts only): no unknown types, 30 to 120 ms per file. Test: `apaki-ledger`.
- Step 2, handoff and checkpoint: `handoff.js` (summary, recent turns word for word within a budget, the other
  side's tools as plain text, artifacts, the real diff); `checkpoint.js` (temporary GIT_INDEX_FILE, commit-tree,
  refs/apaki/handoff/<n>; never touches the working tree, index, HEAD, branches or stash; skipped outside git).
  Tests: `apaki-handoff`, `apaki-checkpoint`.
- Step 2, Claude to Codex: `switch.js` and op `switchAgent { paneId, to }`. The same pane becomes a Codex pane on the
  link's thread (started, or resumed on later switches) and the handoff goes in with `thread/inject_items` (no turn,
  nothing billed); a server without it gets the handoff in front of the next message. Links in
  ~/.claude/latch/switch. Test: `apaki-switch-e2e`.
- Step 4, the return path: back to the original Claude session; the handoff (everything since Claude's bookmark)
  rides in front of the next message, once; the bookmark moves when it goes out.
- Step 3, ledger MCP server: `ledger-mcp-stdio.mjs` (ledger_recent, _search, _event, _tool_output, _links, _skills,
  _skill, _instructions), passed per process (Codex: `-c mcp_servers.apaki_ledger.*`; a switched Claude pane: SDK
  mcpServers). Not covered by its own test yet.
- Step 5, environment parity without writing ~/.codex: `codex-env.js` (Claude's MCP servers as `-c` overrides with
  secrets in the process environment, the CLAUDE.md layers in compact form as the switched thread's developer
  instructions, skills through the ledger server). Not covered by its own test yet.
- Step 6, one view: a switched pane's history shows both sides with a line at each switch, each message tagged with
  its agent (engine side only; the window does not draw the agent tags yet).

Not built: any window or phone UI (button, menu item, header, lit state from Glass), remote-policy entry for
switchAgent, parity ledger entries. Open questions for Arthur before it resumes: whether Claude's MCP servers should
reach every Codex thread (they would, per process) or only switched ones (per thread `config` exists in the
app-server schema but is untested); and whether a switch should ever be allowed from a phone.
