# Kimi sessions in Myrlin Apaki

Owner: Astra, GPT 6, taking over this Apaki work for Arthur on 2026-10-24. The Forge coordinator should give this file and PROGRESS.md to the Kimi sessions that previously owned it. This snapshot is the Apaki task only. Glass and storage have separate owners. No message was sent to another session from this host.

## Basis and transport

Read the repository README, Apaki contribution and Windows build docs, Codex integration notes, engine, pane components and Node test harness. No CLAUDE.md, HANDOFF file or AGENTS.md was present in the supplied snapshot. The source baseline is 65a5527756b7e05bf2b24bf4779e13f598bf1737, recorded in BASE_COMMIT.txt. The supplied directory has no Git history, so a local baseline commit preserves the original snapshot for producing and checking the patch.

Use one Kimi Code CLI 2.3.1 ACP child per open Kimi pane. Spawn Node and dist/main.mjs directly, without a command shell. Support APAKI_KIMI_BIN and APAKI_KIMI_NODE overrides, KIMI_CODE_HOME, and Arthur's portable Windows kit as a discovery candidate. No package dependency, credential copy or automatic install is needed. The CLI owns its OAuth login and session files.

ACP uses newline JSON RPC, protocol version 1. It supports session/new, session/load, session/prompt, session/cancel, session/set_config_option, session/set_mode, session/update, session/request_permission and elicitation/create. Its prompt mode prints stream JSON but cannot provide the bidirectional approval and question flow a pane needs. The inspected source is the installed npm package's dist/main.mjs, especially acp-server, sessionIndexSource, replayBuilder and runNativeTurn.

Pass -m kimi-code/k3.1-pro when spawning. The 2.3.1 ACP subcommand does not apply this top level option, so explicitly set config option model to kimi-code/k3.1-pro, then thinking to max before opening completes and before every prompt. Check the returned values. Failure prevents a prompt. Set KIMI_SECONDARY_MODEL=kimi-code/k3.1-pro and KIMI_SECONDARY_EFFORT=high in the child environment. Offer only K3.1 Pro and max in the existing chips. No speed setting, highspeed model or kimi-for-coding fallback.

## Panes and history

Use kind kimi and session IDs prefixed with kimi:. Route through the same open, attach, send, interrupt, answer, close and settings operations as the other panes. Keep one owner per session inside the engine. Honor Kimi's own occupied or stale session errors, without killing or taking over an external process. On a child exit, fail pending requests, drop stale asks and preserve the session ID for reopening. Do not retry a possibly submitted prompt automatically.

Map ACP text and thought chunks to the existing SDK shaped stream events. Map tool calls and results to the existing tool rows and plan updates to TodoWrite. Collect session/load replay as history before emitting opened and history, so it is not mixed into a live turn. Reattach from the adapter's retained messages, with the same history paging and prompt list operations. ACP replays active context, not every precompaction message; disclose that limit.

Read Kimi's session metadata without starting the CLI: sessions/<workspace>/<session>/state.json, with session-meta/state.json as the older fallback. Use title, cwd or workDir, timestamps and archived state. Read the main agent wire log for keyword search, including appended messages and loop content, tools and results. Keep bounded, streaming reads and a change cache. Never scan arbitrary cwd trees or follow session symlinks. Search merges Kimi word matches into the existing search rows, whether the Rust index is available or not. Kimi semantic search and Rust index migration are deferred. Privacy exclusions from Arthur's addendum apply before transcript reads and before opening a Kimi cwd.

## Interaction and settings

Use existing permission cards with the exact option IDs the ACP server offered. Plans and unusual approval options use the existing choice form, preserving their labels and IDs. Advertise elicitation form support for full multi-question and multi-select AskUserQuestion requests. Convert the form schema to existing question cards and validate answers against the declared options. Kimi 2.3.1 does not accept free text for its question option bridge; reject unsupported answers clearly instead of silently substituting one. Declining, stopping, closing or process failure resolves or removes each ask exactly once.

Map the existing mode chip to Kimi's declared modes: default for manual approvals, plan, auto and yolo. Default new panes to manual. Mode changes await ACP confirmation and cannot race a running prompt. Existing queued messages work after a turn. ACP has no in-flight steer operation, so steer reports that the user must queue or stop and send again. Context usage is shown only when ACP reports it. Commands come from available_commands_update.

Use the existing billing chip. Read the kimi account from the existing Glass status snapshot, accepting the provider's live selection and headroom. If Glass has no kimi provider, show Kimi OAuth without a warning. Do not reuse Claude credentials or its billing, keep-warm or account switching operations for Kimi.

## Scope and verification

Reuse existing pane, provider choice, chips, session rows and ask cards. Add no CSS or new layout. No production changes, packaging or installation in this job. No live model or login calls. No subagents.

Kimi console handoff, terminal launching, rename, fork, file export, Apaki browser tool injection, semantic search, background subagent viewers and writable phone access are deferred. Unsupported operations must give a clear result or be disabled, never fall through to Claude. Phone requests must not bypass phone capability restrictions through Kimi's local tools.

Add Node tests with a fake ACP child and invented on-disk sessions. Cover discovery, enforced settings, new and resumed sessions, streaming, approvals, question forms, cancel, stale answers, crashes, duplicate opens, search, metadata privacy, billing fallback and UI routing. Run the existing relevant provider and pane tests, the broad Node suite where dependencies permit, and Rust tests that build on Linux. Keep build caches and test data inside this snapshot. Record unavailable Windows checks, exact coordinator commands, packaging steps, risks and Questions for Opus in out/NOTES.md. Produce out/apaki-kimi.patch and verify it applies to the preserved baseline.
