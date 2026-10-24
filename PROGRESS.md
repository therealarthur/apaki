# Apaki Kimi takeover progress

2026-10-24: Astra has taken over the Kimi support task in this snapshot for Arthur. Kimi sessions should treat PLAN-APAKI-KIMI.md as the implementation plan and this file as the handoff status. The Forge coordinator must relay these files; no external session message has been sent.

Read the repository guidance, engine and Codex provider pattern, Windows packaging docs, and installed Kimi Code 2.3.1 source. ACP supports the needed interactive pane operations. Its ACP command ignores the top level model option, requiring explicit model and thinking configuration through ACP before a prompt.

The supplied snapshot had no Git metadata. A local baseline commit now preserves its contents for a unified diff. BASE_COMMIT.txt identifies the coordinator's source commit.

Initial quota check: codex-2 is at 21% used. Stop threshold is 45%. No live Kimi calls, production changes, external writes or subagents.

Plan written before implementation. Next: build the ACP adapter, storage search and existing UI integration, then fake-process tests and patch verification.

Implementation: ACP transport, per-pane adapter, metadata listing and streaming keyword search are in place. Existing provider choices, chips, row menus, history and inline question cards now recognize Kimi. Unsupported operations are blocked from reaching Claude handlers. Phone access is refused pending a proper Kimi tool capability adapter.

Validation so far: 16 Kimi tests pass using invented files and a fake ACP child. npm ci succeeded locally. Cargo is not on PATH. Current quota report is 22% used for codex-2. Next: engine integration tests, regression suite, review and deliverables.

Review completed: duplicate session opens are serialized across pane queues; reconnects retain partial output and pending questions; a new session can be recovered even when the window saved before receiving its ID. Kimi multi-select answers preserve labels containing commas. Closing a pane cannot release another queued turn. Permission and question replies settle once. Main model and max effort are checked before each prompt.

Final Node suite: 939 tests, 930 passed, 3 failed, 6 skipped. All 20 Kimi tests passed. The three failures concern Windows paths in existing Codex attachment and open-target tests. They also fail on the untouched baseline. The first broad run also found source-wiring assertions that needed to recognize Kimi; those were updated and now pass. Test temporary files are inside out, with a Git boundary to prevent repository discovery tests from finding this task's local baseline repository.

Both Rust test commands were attempted and could not start because Cargo is absent. Windows Tauri behavior, packaging, real OAuth sessions and the future Glass Kimi provider have not been exercised here. There were no live Kimi calls. No processes outside the test children were stopped.

Delivery: out/apaki-kimi.patch and out/NOTES.md. The notes contain exact Windows test commands, later packaging and installation steps, remaining risks and Questions for Opus. The coordinator should relay this handoff to the previous Kimi owners; no external session message was sent. Latest quota check before delivery preparation: codex-2 at 25% used, below the 45% stop threshold.

2026-10-24 second patch: preserving the supplied snapshot for a diff against bfdc13f4b3575f7f6f4262a4f1647f5a6bb102bc. Initial codex-2 quota is 27%. No live Kimi calls or subagents. Reading only the supplied invented journal and repository code.

Implementation plan: derive cached titles from bounded journal prefixes; map journal records to existing message blocks; follow held sessions read only using byte offsets; retry ACP only after quiet time and a visible pane check. Reuse existing composer and thinking components. Test with invented journals and a fake ACP held flag, then verify LF and CRLF patch application.

Second patch implementation is present. Titles use a 512 KiB prefix with size and mtime caching. Explicit helper roles use existing row text and details. Held sessions use journal blocks, a disabled composer, incremental reads and visible pane retries after 30 seconds of quiet time. Recovery keeps the journal transcript and discards the duplicate ACP replay. Existing 20 Kimi tests and the first 11 journal tests pass. Next: host recovery integration, broad regression suite and patch checks.

Final regression run: 954 tests, 945 passed, 3 failed, 6 skipped. All 35 Kimi tests pass, including the real host, a fake held ACP session, appended history and recovery after the production 30 second quiet interval. The three failures are the existing Windows path assertions in Codex attachments and open-target parsing; all three reproduce on the untouched supplied snapshot. The generic pane regression was fixed, and the test directory Git boundary was corrected. Quota remains 27% for codex-2.

Preparing out/apaki-kimi-2.patch and out/NOTES-2.md. Patch application is being checked in separate LF and CRLF baseline checkouts inside out. No application packaging or installation, live Kimi calls, external writes or subagents.

Delivery checks passed: Git application check and actual application on LF and CRLF baseline checkouts; all changed files match after line ending normalization. The applied CRLF checkout passes all 14 journal tests. Final artifacts are out/apaki-kimi-2.patch and out/NOTES-2.md. No app packaging or installation was performed.
