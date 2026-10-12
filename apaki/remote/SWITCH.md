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

Not built yet (2026-10-12).
