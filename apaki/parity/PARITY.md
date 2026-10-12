# Upstream parity tracker for Myrlin Apaki

Written 2026-10-11 by Claude Code (Sonnet 5.5). Arthur, 2026-10-11: "we also need
to keep track of what sessions were involved in integrating and indexing
features/etc for claude code, claude desktop, chatgpt app, codex, etc so that we
can diff in the future if features are adjusted/added/removed and make sure we
can quickly support those changes". And, the same day: "make sure we're updating
the app alongside the desktop app so all functionality is equal across the board"
(hence a status per surface, desktop and phone, on every feature).

Apaki sits on Claude Code (through the Agent SDK) and is adding Codex (through
`codex app-server`), and it is measured against Claude Desktop and the ChatGPT
desktop app. All four change without notice. This folder answers three questions
quickly: what does each upstream product expose today, what changed since we last
looked, and which Apaki features does that touch.

## What is here

| Path | What it is |
|---|---|
| `snapshots/<product>/<version>.json` | What a product exposed at one version, one item per line, sorted by id. Written by `npm run parity:extract`. Never edited by hand. |
| `features.json` | The ledger: one entry per feature Apaki supports or plans, with the upstream ids it depends on, a status per surface, files, commits, sessions and the versions it was last checked against. Edited by hand. |
| `manual/claude-desktop.md`, `manual/chatgpt-desktop.md` | Hand kept feature inventories for the two apps that have no machine readable surface. Each bullet becomes a surface item. |
| `extract.mjs` (`npm run parity:extract`) | Runs the extractors, saves snapshots, rewrites the coverage section at the bottom of this file. |
| `diff.mjs` (`npm run parity:diff`) | Compares a fresh extraction with the saved snapshots and prints the report. Always exits 0; `--strict` exits 1 when something needs attention. |
| `lib/` | The extractors and the pure logic (dts reader, claude-sdk, codex, desktop, snapshot, ledger, report). Tests: `test/apaki-parity.test.js`. |

## Products and surface ids

An id is `<product>:<kind>:<name>`. The name can hold colons and slashes. Examples:
`claude-sdk:message:system/informational`, `claude-sdk:option:includeHookEvents`,
`claude-sdk:setting:autoCompactEnabled`, `claude-sdk:hook-event:PreToolUse`,
`codex:client-request:turn/steer`, `codex:server-request:item/tool/requestUserInput`,
`codex:notification:thread/tokenUsage/updated`, `codex:cli:app-server`,
`claude-desktop:feature:side-chat`.

| Product | Version is | Source | Kinds |
|---|---|---|---|
| `claude-sdk` | the `@anthropic-ai/claude-agent-sdk` package version (the bundled Claude Code version is in `meta.claudeCodeVersion`) | `sdk.d.ts` and `sdk-tools.d.ts` read as text (no TypeScript dependency); `claude.exe --version` and `--help`; the settings schema inside the binary | `message` (every SDKMessage arm by type/subtype), `option` (query options), `setting` (settings keys, from the types and the binary), `hook-event`, `permission-mode`, `control-request`, `query-method`, `export` (functions, classes, consts), `enum` (named string unions), `tool-input`, `tool-output`, `cli-flag`, `cli-command` |
| `codex` | `codex --version` | `codex app-server generate-json-schema` (run twice, plain and `--experimental`, into a temp folder that is deleted afterwards) and `codex --help`, `codex app-server --help` | `client-request`, `server-request`, `notification`, `client-notification`, `item-type`, `input-item`, `enum`, `type`, `cli`, `cli-flag` |
| `claude-desktop`, `chatgpt-desktop` | the installed package version, read from the package name only | `manual/<product>.md` bullets | `feature` |
| `apaki` | not a snapshot product | used only as a ledger `product` for features with no single upstream | none |

Each item has `attrs` that the diff compares: field lists (`name?` marks optional),
value lists for enums, type text for options and settings, parameter lists for
Codex methods. Codex items that only the `--experimental` generation lists carry
`experimental: true`; params only it lists are in `experimentalParams`. The
`type`, `tool-output` and `const` kinds are data-model detail: they are saved and
diffed, but the report shows them only with `--details`.

The settings come from two places on purpose. The published `Settings` interface
omits the settings marked `@internal`; the binary carries the whole schema as
minified JavaScript, so a `setting` item says `source: types+binary`, `types` or
`binary`.

## After upgrading the Claude Agent SDK, Claude Code or Codex

1. Upgrade the usual way (for the SDK, `npm install @anthropic-ai/claude-agent-sdk@<version>` in the repo; for Codex, however you update it, for example `codex update`). Nothing here installs anything.
2. `npm run parity:extract` saves `snapshots/<product>/<new version>.json` next to the old one and refreshes the coverage numbers below. Check the item counts it prints.
3. `npm run parity:diff` compares the fresh extraction with the newest saved snapshot older than it, and prints:
   - added, removed and changed ids per product;
   - NEEDS ATTENTION: ledger features whose upstream ids were removed or changed;
   - DANGLING: ledger ids that match nothing now (a typo or a removal);
   - UNREVIEWED: new ids no ledger entry covers, grouped by product and kind;
   - PHONE GAPS: features where the phone has less than the desktop;
   - RE-VERIFY: features last checked against an older upstream version;
   - MISSING FILES: `where` paths that no longer exist.
4. Work the list. For each new id decide: Apaki should support it (add or extend a ledger entry, status `planned`), it does not apply (add the id to a `not-applicable` entry so it stops being unreviewed), or it is already covered (add the id or a `*` pattern to that entry's `upstream`). For each changed or removed id, open the feature, read its `notes`, fix the code or the entry.
5. When a feature has been checked against the new version, bump its `verifiedAgainst`, add the commit hashes and the session id, and commit `features.json` with the snapshot.

`node apaki/parity/diff.mjs --strict` (the same report) exits 1 if anything under NEEDS ATTENTION or DANGLING is open, or if a phone gap counts (below). Other flags: `--backlog` also lists every id no entry covers, not only the new ones; `--details` includes the data-model kinds; `--all` lifts the 60 line cap; `--only claude-sdk,codex` limits the products. The same flags work on `node apaki/parity/extract.mjs` where they apply (`--only`, and `--dry` to print without saving).

To refresh the desktop apps: edit `manual/<product>.md` (bullets, and the version note at the top), then `npm run parity:extract`. The installed version is read from the package name (`Get-AppxPackage` names, because `C:\Program Files\WindowsApps` cannot be listed without elevation); no app data is read and the apps are never opened or closed.

## The ledger (features.json)

One object per feature. Edit it by hand and keep it sorted the way it reads.

| Field | Meaning |
|---|---|
| `id` | Kebab case, unique. |
| `title` | One line, what a user gets. |
| `product` | `claude-sdk`, `codex`, `claude-desktop`, `chatgpt-desktop`, or `apaki` for features that belong to Apaki itself. |
| `upstream` | Surface ids the feature depends on. Exact ids or `*` wildcards (`codex:notification:item/commandExecution/*`). Include every id whose change could break or extend the feature. May be empty for Apaki-only features. |
| `status` | Overall: `supported`, `partial`, `planned` or `not-applicable`. Must agree with `surfaces`: all non n/a surfaces supported is `supported`; any supported or partial is `partial`; none yet is `planned`; all n/a is `not-applicable`. The checks reject a mismatch. |
| `surfaces` | `{ "desktop": ..., "phone": ... }`, each `supported`, `partial`, `planned` or `n/a`. Phone means the phone web page and the iOS app, which share `apaki/web` and `apaki/ui`. Use `n/a` only when the surface cannot or should not have the feature, and say why in `notes`. |
| `where` | Files that implement it and the tests that cover it. |
| `commits` | Short hashes (`git log --format=%h`) that built it. These are the durable record. |
| `sessions` | Claude Code session ids that did the work (see the warning below). |
| `verifiedAgainst` | `{ "<product>": "<version>" }`: the upstream versions the ids were last checked against. |
| `notes` | What it does, what it depends on that is not an upstream id (transcript formats, files Claude Code writes), known gaps, and any decision for Arthur. |

Phone gaps: a feature lags on the phone when the desktop is `supported` or `partial`, the phone has less, and the phone is not `n/a`. All of those are listed under PHONE GAPS. Only the ones where the desktop is `supported` and the phone is `planned` (nothing there yet) count for `--strict`; a `partial` phone is listed but does not fail the check.

### Recording a new feature

1. Add an entry to `features.json` when you start the work: status and surfaces `planned`, the `upstream` ids it will use (look them up in the newest snapshot, for example `grep "turn/steer" snapshots/codex/*.json`), `where` the code will live.
2. When it lands, set the surfaces, add the commit hashes and the session id, set `verifiedAgainst` to the current versions (the extract output prints them), and write the notes.
3. Run `npm run parity:diff`. DANGLING means an id is misspelled; UNREVIEWED shows nothing you just added.
4. `npm test` runs the ledger checks (`test/apaki-parity.test.js`): shape, status against surfaces, ids in the saved snapshots for entries verified against the newest version.

For work split over several sessions, list every session id. Subagent work belongs to the parent session's id (subagent transcripts are under `<session id>/subagents/` in the same project folder).

### Sessions and commits

Session ids point at transcripts under `~/.claude/projects/<project folder>/<session id>.jsonl`. Claude Code deletes transcripts older than `cleanupPeriodDays` (30 days by default) unless they are archived elsewhere, so a session id can stop resolving. Commits are the durable reference: every entry should carry the commits, and the session id is a pointer for as long as the transcript lives. If a session matters, copy its transcript somewhere safe before the 30 days pass.

The git log has no per-commit session notes (checked 2026-10-11 over the 97 commits then in the log), so every Apaki feature from 2026-10-09 to 2026-10-11 carries the one session id the work was done in, `c6e7b179-2ed4-4ae5-afac-7845f0c7b029`, and its subagents. Work started later by other sessions should name its own id.

## What the extractors cannot see

- Behavior. A snapshot lists what exists, not how it acts: a changed default, a new rule in a permission check or a different retry policy leave every id unchanged. The `notes` of a feature name those dependencies; re-test them after an upgrade (`npm test`, then the live checks the notes mention).
- Anything the SDK does not type: the transcript line format, the `~/.claude/sessions` live records, the Codex rollout files. Apaki reads those directly (`apaki/engine/history.js`, `last-active.js`, `src/sessions.js`, `index/`). A change there shows up as a failing test, not in a diff.
- Claude Desktop and the ChatGPT app have no surface to extract: only the hand kept inventories and the installed version. Read their release notes and issue trackers; never open or close the apps for this.
- `claude-sdk` reads the binary for the Windows x64 build; on another platform the settings schema is read from the binary of that platform if the package is installed there.
- Codex `--experimental` items are marked, not hidden: the Apaki plan uses some of them (`thread/queue/*`, `thread/settings/update`), which the plain schema omits.

## Files that are never read

No credential file is read by any of this: not `~/.codex/auth.json`, not `~/.claude/.credentials.json`, not `~/.claude.json`, not any `credentials.md`. The binary is run only with `--version` and `--help`.

## Coverage (generated)

[//]: # (parity:coverage:start)
Generated by `npm run parity:extract` on 2026-10-12. Do not edit between the markers; edit features.json and re-run.

### Surface snapshots

| Product | Version | Surface ids | Covered by a ledger entry | Primary ids covered |
|---|---|---|---|---|
| chatgpt-desktop | 26.1002.7124.0 | 20 | 14 | 14 of 20 |
| claude-desktop | 2.31226.1.0 | 20 | 14 | 14 of 20 |
| claude-sdk | 0.3.295 | 622 | 158 | 158 of 578 |
| codex | 0.161.0 | 838 | 130 | 128 of 547 |

Covered means at least one ledger entry names the id (exactly or by a * pattern). "Primary" leaves out data-model detail kinds (type, tool-output, const).

chatgpt-desktop 26.1002.7124.0 by kind: feature 14/20

claude-desktop 2.31226.1.0 by kind: feature 14/20

claude-sdk 0.3.295 by kind: cli-command 0/18, cli-flag 7/66, control-request 13/40, enum 2/17, export 9/27, hook-event 15/33, message 32/42, option 28/69, permission-mode 6/6, query-method 14/30, setting 15/186, tool-input 17/44, tool-output 0/44

codex 0.161.0 by kind: cli 1/30, cli-flag 5/40, client-notification 1/1, client-request 47/169, enum 4/186, input-item 4/7, item-type 19/19, notification 39/84, server-request 8/11, type 2/291

### Feature ledger

117 features. By status: supported 53, partial 15, planned 49. By product: claude-sdk 34, codex 32, apaki 51.

| Surface | supported | partial | planned | n/a |
|---|---|---|---|---|
| desktop | 60 | 3 | 46 | 8 |
| phone | 39 | 15 | 40 | 23 |

Phone gaps (phone has less than the desktop): 10, of which 0 are desktop supported with nothing on the phone yet (`--strict` counts those).

### Last extraction notes

- claude-desktop: version 2.31226.1.0 from Get-AppxPackage names
- chatgpt-desktop: version 26.1002.7124.0 from Get-AppxPackage names
[//]: # (parity:coverage:end)
