# apaki/

The app itself: the Tauri window (`src/`), the engine that runs Claude Code (`engine/`), the window's UI (`ui/`),
the phone web client (`web/`), the iPhone and Android apps (`mobile/`), the phone protocol and plans (`remote/`),
the demo harness that records the README's pictures (`demo/`), docs (`docs/`) and build scripts (`scripts/`).

The README is at the repository root: [../README.md](../README.md).

Kimi Code 2.3.1 sessions now use the existing conversation panes, provider choices and search rows through ACP. The main session is fixed to `kimi-code/k3.1-pro` at max effort. Kimi owns its OAuth login and storage. Arthur's portable Windows kit is discovered automatically; `APAKI_KIMI_BIN`, `APAKI_KIMI_NODE` and `KIMI_CODE_HOME` override discovery. See [the Kimi implementation plan](../PLAN-APAKI-KIMI.md) for behavior and current limits.
