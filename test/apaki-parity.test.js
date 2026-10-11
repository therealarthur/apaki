/**
 * The upstream parity tracker (apaki/parity, PARITY.md; Arthur, 2026-10-11:
 * "keep track of ... claude code, claude desktop, chatgpt app, codex ... so
 * that we can diff in the future if features are adjusted/added/removed", and
 * "all functionality is equal across the board", desktop and phone).
 *
 * Only the pure parts are tested here, on small fixtures: the .d.ts reader,
 * the claude-sdk and codex extractors, snapshot normalizing and diffing, the
 * ledger checks and the report. The live tools (the SDK folder, claude.exe,
 * codex) are run by `npm run parity:extract`, not by npm test. The last group
 * checks the saved ledger and snapshots for internal consistency only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dts, literalUnion, maskComments, plainDashes, splitRanges, tupleLiterals } from '../apaki/parity/lib/dts.mjs';
import { parseChoices, parseCommands, parseFlags, splitHelp } from '../apaki/parity/lib/help.mjs';
import {
  extractClaudeSdk, extractControlRequests, extractEnums, extractExports, extractHookEvents, extractMessages,
  extractOptions, extractPermissionModes, extractQueryMethods, extractTools, mergeFieldLists, mergeSettings, parseBinarySettings, readJsString,
} from '../apaki/parity/lib/claude-sdk.mjs';
import { extractCodex, methodsOf, schemaFields, taggedVariants, variantsOf } from '../apaki/parity/lib/codex.mjs';
import { extractDesktop, findInstalled, parseInventory, parsePackageFullName } from '../apaki/parity/lib/desktop.mjs';
import {
  DETAIL_KINDS, buildSnapshot, compareVersions, describeChange, diffSnapshots, loadSnapshots, makeItem, parseId, pickBaseline,
  saveSnapshot, serializeSnapshot, stableStringify,
} from '../apaki/parity/lib/snapshot.mjs';
import {
  buildReport, deriveStatus, loadLedger, matchIds, missingFiles, patternToRegex, phoneGap, replaceBetween, summarizeCoverage, validateLedger,
} from '../apaki/parity/lib/ledger.mjs';
import { renderProductDiff, renderReport } from '../apaki/parity/lib/report.mjs';

const PARITY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apaki', 'parity');
const NOW = new Date('2026-10-11T12:00:00Z');

/* ---------- a small sdk.d.ts ---------- */

const SDK_DTS = `import type { UUID } from 'crypto';

/**
 * The union of everything the query yields.
 */
export declare type SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage | SDKSystemMessage | SDKInformationalMessage;

export declare type SDKResultMessage = SDKResultSuccess | SDKResultError;

/** An assistant message; the url https://example.com/x is not a comment start. */
export declare type SDKAssistantMessage = {
    type: 'assistant';
    // a line comment with a closing brace }
    message: string;
    error?: 'rate_limit' | 'billing_error';
    uuid: UUID;
    session_id: string;
};

export declare type SDKUserMessage = {
    type: 'user';
    message: string;
    priority?: 'now' | 'next' | 'later';
    uuid?: UUID;
};

export declare type SDKUserMessageReplay = {
    type: 'user';
    message: string;
    isReplay: true;
    uuid: UUID;
};

export declare type SDKResultSuccess = {
    type: 'result';
    subtype: 'success';
    result: string;
};

export declare type SDKResultError = {
    type: 'result';
    subtype: 'error_during_execution' | 'error_max_turns';
    errors: string[];
};

export declare type SDKSystemMessage = {
    type: 'system';
    subtype: 'init';
    model: string;
    tools: string[];
};

export declare type SDKInformationalMessage = {
    type: 'system';
    subtype: 'informational';
    content: string;
    level: 'info' | 'notice' | 'suggestion' | 'warning';
    tag?: string;
};

export declare type BaseHookInput = {
    session_id: string;
    cwd: string;
};

export declare type PreToolUseHookInput = BaseHookInput & {
    hook_event_name: 'PreToolUse';
    tool_name: string;
    tool_input: unknown;
    permission_mode?: PermissionMode;
};

export declare type PreToolUseHookSpecificOutput = {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny' | 'ask';
};

export declare const HOOK_EVENTS: readonly ['PreToolUse', 'PostToolUse', 'Stop'];

export declare type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop';

export declare type PermissionMode = 'default' | 'acceptEdits' | 'plan';

export declare type EffortLevel = 'low' | 'medium' | 'high';

export declare const USAGE_PREFIXES: readonly ["You've used", "You're close to, really"];

export declare type Options = {
    /**
     * Working directory.
     */
    cwd?: string;
    /**
     * Old way to pick a model.
     * @deprecated Use model.
     */
    modelName?: string;
    includeHookEvents?: boolean;
    canUseTool?: CanUseTool;
    effort?: EffortLevel;
};

export declare interface Settings {
    /**
     * Automatically compact conversation when context fills
     */
    autoCompactEnabled?: boolean;
    /**
     * @internal hidden knob
     */
    theme?: ('auto' | 'dark') | string;
}

declare type SDKControlRequestInner = SDKControlInterruptRequest | SDKControlSetModelRequest;

declare type SDKControlInterruptRequest = {
    subtype: 'interrupt';
    cancel_queued?: boolean;
};

declare type SDKControlSetModelRequest = {
    subtype: 'set_model';
    model?: string;
};

export declare interface Query extends AsyncGenerator<SDKMessage, void> {
    /** Interrupt the run. */
    interrupt(): Promise<void>;
    setModel(model?: string): Promise<void>;
    getContextUsage(options?: {
        detail?: 'summary' | 'full';
    }): Promise<Usage>;
}

export declare function query(_params: {
    prompt: string;
    options?: Options;
}): Query;

export declare function listSessions(_options?: ListOptions): Promise<Info[]>;

export declare class AbortError extends Error {
}
`;

const TOOLS_DTS = `/* eslint-disable */
export type ToolInputSchemas =
  | AskUserQuestionInput
  | BashInput;
export interface AskUserQuestionInput {
  questions: {
    question: string;
    multiSelect?: boolean;
  }[];
  answers?: {
    [k: string]: string;
  };
}
export interface BashInput {
  command: string;
  timeout?: number;
}
export interface EnterPlanModeInput {}
export interface BashOutput {
  stdout: string;
  interrupted: boolean;
}
`;

const BINARY = 'function Aa(e){return{$schema:()=>o().optional().describe("JSON Schema ref"),apiKeyHelper:()=>o().optional().describe("Path, with a comma"),'
  + 'theme:()=>Be([U(dxe),o().startsWith("custom:").transform((i)=>i)]).optional().catch(void 0).describe("Color theme"),'
  + 'pat:()=>o().regex(/^["\'{]+$/).optional().describe("regex "+"concat"),internalThing:()=>M().optional().describe("@internal Hidden"),'
  + '...!1,autoCompactEnabled:()=>M().optional().describe("Automatically compact"),last:()=>M().optional().describe("The end")};}function after(){return {x:()=>1}}';

const HELP_COMMANDER = `Usage: claude [options] [command] [prompt]

Options:
  -c, --continue                        Continue the most recent conversation
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow
  --permission-mode <mode>              Permission mode (choices: "acceptEdits",
                                        "auto", "manual")
  --include-hook-events                 Include all hook lifecycle events
  -h, --help                            Display help for command

Commands:
  agents [options]                      Manage background agents
  plugin|plugins                        Manage plugins
  stop|kill <id>                        Stop a background session
`;

const HELP_CLAP = `Codex CLI

Usage: codex [OPTIONS] [PROMPT]

Commands:
  exec              Run Codex non-interactively [aliases: e]
  app-server        [experimental] Run the app server or related tooling
  help              Print this message

Options:
  -c, --config <key=value>
          Override a configuration value.

      --enable <FEATURE>
          Enable a feature (repeatable).

  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy

          [possible values: read-only, workspace-write, danger-full-access]

  -a, --ask-for-approval <APPROVAL_POLICY>
          Configure when approval is needed

          Possible values:
          - on-request: The model decides
          - never:      Never ask

      --worktree
          Run in a new managed Git worktree
`;

/* ---------- dts reader ---------- */

test('parity dts: comments are blanked, strings keep their slashes, offsets stay aligned', () => {
  const src = 'a: \'http://x\'; // gone }\n/* block { */ b: "it\'s";';
  const { masked, comments } = maskComments(src);
  assert.equal(masked.length, src.length);
  assert.ok(masked.includes("'http://x'"));
  assert.ok(!masked.includes('gone'));
  assert.ok(!masked.includes('block'));
  assert.equal(comments.length, 2);
  assert.equal(masked.indexOf('b:'), src.indexOf('b:'));
});

test('parity dts: splitRanges respects brackets, strings and arrow types', () => {
  const text = "a: Promise<{ x: 1; y: 2 }>; b: (n: number) => void; c: 'p;q'";
  const parts = splitRanges(text, 0, text.length, ';').map((r) => text.slice(r.a, r.b).trim());
  assert.deepEqual(parts, ['a: Promise<{ x: 1; y: 2 }>', 'b: (n: number) => void', "c: 'p;q'"]);
});

test('parity dts: literal unions and tuples', () => {
  assert.deepEqual(literalUnion("'a' | 'b' | null"), ['a', 'b']);
  assert.deepEqual(literalUnion("('a' | 'b') | 'c'"), ['a', 'b', 'c']);
  assert.equal(literalUnion("'a' | string"), null);
  assert.equal(literalUnion('boolean'), null);
  assert.deepEqual(tupleLiterals("'a', \"You've, really\""), ['a', "You've, really"]);
  assert.equal(tupleLiterals("'a', 3"), null);
});

test('parity dts: upstream dashes become plain hyphens (no em dashes in anything saved)', () => {
  const em = String.fromCharCode(0x2014);
  const en = String.fromCharCode(0x2013);
  assert.equal(plainDashes(`a ${em} b${em}c ${en} d`), 'a - b - c - d');
  const dts = new Dts(`export declare type T = {\n    /**\n     * Waits ${em} then goes.\n     */\n    wait?: boolean;\n};\n`);
  assert.equal(dts.membersOfDecl('T').get('wait').doc, 'Waits - then goes.');
});

test('parity dts: declarations, nested unions, intersections and docs', () => {
  const dts = new Dts(SDK_DTS);
  assert.ok(dts.decl('SDKMessage') && dts.decl('Options') && dts.decl('Query'));
  assert.deepEqual(dts.unionLeaves('SDKMessage'), ['SDKAssistantMessage', 'SDKUserMessage', 'SDKUserMessageReplay', 'SDKResultSuccess', 'SDKResultError', 'SDKSystemMessage', 'SDKInformationalMessage']);
  const hook = dts.membersOfDecl('PreToolUseHookInput');
  assert.deepEqual([...hook.keys()].sort(), ['cwd', 'hook_event_name', 'permission_mode', 'session_id', 'tool_input', 'tool_name']);
  assert.equal(hook.get('permission_mode').optional, true);
  const opts = dts.membersOfDecl('Options');
  assert.match(opts.get('modelName').doc, /@deprecated/);
  assert.equal(opts.get('cwd').doc, 'Working directory.');
  assert.equal(dts.membersOfDecl('Settings').get('theme').type, "('auto' | 'dark') | string");
  assert.deepEqual(dts.literalsOf('HOOK_EVENTS'), ['PreToolUse', 'PostToolUse', 'Stop']);
  assert.deepEqual(dts.literalsOf('USAGE_PREFIXES'), ["You've used", "You're close to, really"]);
});

/* ---------- claude-sdk extractor ---------- */

test('parity claude-sdk: messages by type and subtype, shared ids merged, enum fields kept', () => {
  const items = extractMessages(new Dts(SDK_DTS));
  const ids = items.map((i) => i.id).sort();
  assert.deepEqual(ids, [
    'claude-sdk:message:assistant',
    'claude-sdk:message:result/error_during_execution',
    'claude-sdk:message:result/error_max_turns',
    'claude-sdk:message:result/success',
    'claude-sdk:message:system/informational',
    'claude-sdk:message:system/init',
    'claude-sdk:message:user',
  ]);
  const info = items.find((i) => i.id.endsWith('system/informational'));
  assert.deepEqual(info.attrs.fields, ['content', 'level', 'subtype', 'tag?', 'type']);
  assert.deepEqual(info.attrs.enums, { level: ['info', 'notice', 'suggestion', 'warning'] });
  const user = items.find((i) => i.id.endsWith('message:user'));
  assert.deepEqual(user.attrs.types, ['SDKUserMessage', 'SDKUserMessageReplay']);
  // isReplay exists in only one arm, so it is optional in the merge; uuid is optional in one arm
  assert.ok(user.attrs.fields.includes('isReplay?'));
  assert.ok(user.attrs.fields.includes('uuid?'));
  assert.ok(user.attrs.fields.includes('message'));
  assert.deepEqual(mergeFieldLists(['a', 'b?'], ['a?', 'c']), ['a?', 'b?', 'c?']);
});

test('parity claude-sdk: options, hook events, permission modes, control requests, query methods, exports, enums', () => {
  const dts = new Dts(SDK_DTS);
  const opts = extractOptions(dts);
  assert.deepEqual(opts.map((o) => o.id.split(':')[2]).sort(), ['canUseTool', 'cwd', 'effort', 'includeHookEvents', 'modelName']);
  assert.equal(opts.find((o) => o.id.endsWith('modelName')).attrs.deprecated, true);
  assert.equal(opts.find((o) => o.id.endsWith('cwd')).attrs.optional, true);

  const hooks = extractHookEvents(dts);
  assert.deepEqual(hooks.map((h) => h.id), ['claude-sdk:hook-event:PreToolUse', 'claude-sdk:hook-event:PostToolUse', 'claude-sdk:hook-event:Stop']);
  assert.deepEqual(hooks[0].attrs.input, ['cwd', 'hook_event_name', 'permission_mode?', 'session_id', 'tool_input', 'tool_name']);
  assert.deepEqual(hooks[0].attrs.output, ['hookEventName', 'permissionDecision?']);
  assert.deepEqual(hooks[0].attrs.enums, undefined);

  assert.deepEqual(extractPermissionModes(dts).map((m) => m.id), ['claude-sdk:permission-mode:default', 'claude-sdk:permission-mode:acceptEdits', 'claude-sdk:permission-mode:plan']);
  assert.deepEqual(extractControlRequests(dts).map((c) => c.id), ['claude-sdk:control-request:interrupt', 'claude-sdk:control-request:set_model']);
  assert.deepEqual(extractQueryMethods(dts).map((m) => m.id.split(':')[2]), ['interrupt', 'setModel', 'getContextUsage']);

  const exp = extractExports(dts);
  assert.deepEqual(exp.map((e) => e.id).sort(), ['claude-sdk:export:AbortError', 'claude-sdk:export:HOOK_EVENTS', 'claude-sdk:export:USAGE_PREFIXES', 'claude-sdk:export:listSessions', 'claude-sdk:export:query']);
  assert.deepEqual(exp.find((e) => e.id.endsWith('HOOK_EVENTS')).attrs.values, ['PreToolUse', 'PostToolUse', 'Stop']);
  assert.equal(exp.find((e) => e.id.endsWith('query')).attrs.kind, 'function');

  const enums = extractEnums(dts);
  assert.deepEqual(enums.map((e) => e.id), ['claude-sdk:enum:EffortLevel']);
  assert.deepEqual(enums[0].attrs.values, ['high', 'low', 'medium']);
});

test('parity claude-sdk: tool inputs and outputs from sdk-tools.d.ts', () => {
  const items = extractTools(new Dts(TOOLS_DTS));
  assert.deepEqual(items.map((i) => i.id).sort(), [
    'claude-sdk:tool-input:AskUserQuestion', 'claude-sdk:tool-input:Bash', 'claude-sdk:tool-input:EnterPlanMode', 'claude-sdk:tool-output:Bash',
  ]);
  assert.deepEqual(items.find((i) => i.id.endsWith('AskUserQuestion')).attrs.fields, ['answers?', 'questions']);
  assert.equal(items.find((i) => i.id.endsWith('Bash') && i.kind === 'tool-output').kind, 'tool-output');
});

test('parity claude-sdk: the settings schema in minified binary text', () => {
  assert.deepEqual(readJsString('"a\\u0041b\\n"', 0), { value: 'aAb\n', end: 12 });
  const got = parseBinarySettings(BINARY);
  assert.deepEqual(got.map((g) => g.key), ['$schema', 'apiKeyHelper', 'theme', 'pat', 'internalThing', 'autoCompactEnabled', 'last']);
  assert.equal(got[1].description, 'Path, with a comma');
  assert.equal(got[3].description, 'regex concat');
  assert.equal(got[4].description, '@internal Hidden');
  assert.deepEqual(parseBinarySettings('nothing here'), []);
});

test('parity claude-sdk: settings merge says where each key was seen', () => {
  const typed = new Map([['autoCompactEnabled', { type: 'boolean', source: 'types' }], ['theme', { type: 'string', source: 'types' }]]);
  const items = mergeSettings(typed, parseBinarySettings(BINARY));
  const by = Object.fromEntries(items.map((i) => [i.id.split(':')[2], i.attrs]));
  assert.equal(by.autoCompactEnabled.source, 'types+binary');
  assert.equal(by.internalThing.source, 'binary');
  assert.equal(by.internalThing.internal, true);
  assert.equal(by.internalThing.doc, 'Hidden');
  const noBinary = mergeSettings(typed, null);
  assert.equal(noBinary.find((i) => i.id.endsWith('theme')).attrs.source, 'types');
});

test('parity claude-sdk: the full snapshot is sorted, stable and counted', () => {
  const snap = extractClaudeSdk({
    sdkDts: SDK_DTS, toolsDts: TOOLS_DTS, sdkVersion: '0.3.295', claudeCodeVersion: '2.1.295 (Claude Code)',
    binarySchemaText: BINARY, cliHelp: HELP_COMMANDER, now: NOW,
  });
  assert.equal(snap.product, 'claude-sdk');
  assert.equal(snap.version, '0.3.295');
  assert.equal(snap.extractedAt, '2026-10-11');
  assert.equal(snap.meta.claudeCodeVersion, '2.1.295');
  const ids = snap.items.map((i) => i.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['claude-sdk:hook-event:Stop', 'claude-sdk:setting:autoCompactEnabled', 'claude-sdk:cli-flag:--include-hook-events', 'claude-sdk:cli-command:agents', 'claude-sdk:option:includeHookEvents']) assert.ok(ids.includes(id), id);
  assert.equal(snap.counts['hook-event'], 3);
  // the same inputs give byte-identical output
  const again = extractClaudeSdk({ sdkDts: SDK_DTS, toolsDts: TOOLS_DTS, sdkVersion: '0.3.295', claudeCodeVersion: '2.1.295 (Claude Code)', binarySchemaText: BINARY, cliHelp: HELP_COMMANDER, now: NOW });
  assert.equal(serializeSnapshot(again), serializeSnapshot(snap));
});

/* ---------- help text ---------- */

test('parity help: commander flags, choices, aliases and commands', () => {
  const flags = parseFlags(HELP_COMMANDER);
  assert.deepEqual(flags.map((f) => f.long), ['--continue', '--allowedTools', '--permission-mode', '--include-hook-events', '--help']);
  assert.equal(flags[0].short, '-c');
  assert.deepEqual(flags[1].aliases, ['--allowed-tools']);
  assert.equal(flags[1].arg, '<tools...>');
  assert.deepEqual(flags[2].choices, ['acceptEdits', 'auto', 'manual']);
  const cmds = parseCommands(HELP_COMMANDER);
  assert.deepEqual(cmds.map((c) => c.name), ['agents', 'plugin', 'stop']);
  assert.deepEqual(cmds[1].aliases, ['plugins']);
  assert.equal(cmds[2].args, '<id>');
});

test('parity help: clap puts long-only flags at indent 6 and lists values in prose', () => {
  const flags = parseFlags(HELP_CLAP);
  assert.deepEqual(flags.map((f) => f.long), ['--config', '--enable', '--sandbox', '--ask-for-approval', '--worktree']);
  assert.deepEqual(flags[2].choices, ['read-only', 'workspace-write', 'danger-full-access']);
  assert.deepEqual(flags[3].choices, ['on-request', 'never']);
  const cmds = parseCommands(HELP_CLAP);
  assert.deepEqual(cmds.map((c) => c.name), ['exec', 'app-server']);
  assert.deepEqual(cmds[0].aliases, ['e']);
  assert.equal(parseChoices('nothing to see'), undefined);
  assert.ok(splitHelp(HELP_CLAP).Commands.length >= 3);
});

/* ---------- codex extractor ---------- */

const arm = (method, params) => ({ properties: { id: { $ref: '#/definitions/RequestId' }, method: { enum: [method] }, ...(params ? { params: { $ref: `#/definitions/${params}` } } : {}) }, required: ['method'] });
const codexPlain = () => ({
  clientRequest: { oneOf: [arm('thread/start', 'ThreadStartParams'), arm('turn/steer', 'TurnSteerParams')] },
  serverRequest: { oneOf: [arm('item/tool/requestUserInput', 'ToolRequestUserInputParams')] },
  serverNotification: { oneOf: [arm('thread/tokenUsage/updated', 'TokenUsageNotification')] },
  clientNotification: { oneOf: [arm('initialized')] },
  bundle: { definitions: { v2: {}, RequestId: { type: 'string' } } },
  v2: {
    definitions: {
      ThreadStartParams: { properties: { cwd: { type: 'string' }, model: { type: 'string' } } },
      TurnSteerParams: { properties: { threadId: {}, input: {}, expectedTurnId: {} }, required: ['threadId', 'input', 'expectedTurnId'] },
      ToolRequestUserInputParams: { properties: { itemId: {}, questions: {} }, required: ['itemId', 'questions'] },
      TokenUsageNotification: { properties: { threadId: {}, tokenUsage: {} }, required: ['threadId'] },
      ThreadItem: { oneOf: [
        { properties: { type: { enum: ['agentMessage'] }, id: {}, text: {} }, required: ['type', 'id'] },
        { properties: { type: { enum: ['plan'] }, id: {}, steps: {} }, required: ['type', 'id'] },
      ] },
      UserInput: { oneOf: [{ properties: { type: { enum: ['text'] }, text: {} }, required: ['type', 'text'] }] },
      SandboxMode: { enum: ['read-only', 'workspace-write'], type: 'string' },
      AskForApproval: { oneOf: [{ enum: ['never', 'on-request'], type: 'string' }, { properties: { granular: {} }, required: ['granular'], type: 'object' }] },
      ReasoningEffort: { type: 'string', minLength: 1 },
      Model: { properties: { id: {}, supportedReasoningEfforts: {} }, required: ['id'] },
    },
  },
});

test('parity codex: methods with params, tagged variants, enums, free strings', () => {
  const p = codexPlain();
  const defs = { ...p.v2.definitions };
  const methods = methodsOf(p.clientRequest, defs);
  assert.deepEqual(methods.map((m) => m.method), ['thread/start', 'turn/steer']);
  assert.deepEqual(methods[0].params, ['cwd?', 'model?']);
  assert.deepEqual(methods[1].params, ['expectedTurnId', 'input', 'threadId']);
  assert.deepEqual(methodsOf(p.clientNotification, defs)[0].params, []);
  assert.deepEqual(taggedVariants(defs.ThreadItem).map((v) => [v.tag, v.fields]), [['agentMessage', ['id', 'text?']], ['plan', ['id', 'steps?']]]);
  assert.deepEqual(variantsOf(defs.AskForApproval), ['never', 'on-request', '{granular}']);
  assert.deepEqual(variantsOf(defs.SandboxMode), ['read-only', 'workspace-write']);
  assert.equal(variantsOf(defs.ReasoningEffort), null);
  assert.deepEqual(schemaFields(defs.Model), ['id', 'supportedReasoningEfforts?']);
});

test('parity codex: the snapshot lists every kind and marks experimental methods and params', () => {
  const exp = codexPlain();
  exp.clientRequest.oneOf.push(arm('thread/queue/add', 'QueueAddParams'));
  exp.v2.definitions.QueueAddParams = { properties: { threadId: {}, text: {} }, required: ['threadId'] };
  exp.v2.definitions.ThreadStartParams = { properties: { cwd: {}, model: {}, dynamicTools: {} } };
  const snap = extractCodex({ version: 'codex-cli 0.161.0', plain: codexPlain(), experimental: exp, cliHelp: HELP_CLAP, appServerHelp: HELP_CLAP, now: NOW });
  assert.equal(snap.version, '0.161.0');
  const by = Object.fromEntries(snap.items.map((i) => [i.id, i]));
  assert.ok(by['codex:client-request:turn/steer']);
  assert.ok(by['codex:server-request:item/tool/requestUserInput']);
  assert.ok(by['codex:notification:thread/tokenUsage/updated']);
  assert.ok(by['codex:client-notification:initialized']);
  assert.ok(by['codex:item-type:agentMessage'] && by['codex:input-item:text']);
  assert.deepEqual(by['codex:enum:AskForApproval'].attrs.values, ['never', 'on-request', '{granular}']);
  assert.ok(by['codex:type:Model']);
  assert.ok(!by['codex:type:ThreadStartParams'], 'params types are covered by the method item');
  assert.ok(!by['codex:enum:ReasoningEffort']);
  assert.equal(by['codex:client-request:thread/queue/add'].attrs.experimental, true);
  assert.deepEqual(by['codex:client-request:thread/start'].attrs.experimentalParams, ['dynamicTools?']);
  assert.equal(by['codex:client-request:turn/steer'].attrs.experimental, undefined);
  assert.ok(by['codex:cli:exec'] && by['codex:cli-flag:--sandbox'] && by['codex:cli:app-server/exec'] && by['codex:cli-flag:app-server/--sandbox']);
  assert.deepEqual(by['codex:cli:exec'].attrs.aliases, ['e']);
});

/* ---------- desktop products ---------- */

test('parity desktop: package names give the installed version; the manual bullets are the surface', () => {
  assert.deepEqual(parsePackageFullName('Claude_2.31226.1.0_x64__pzs8sxrjxfjjc'), { name: 'Claude', version: '2.31226.1.0', arch: 'x64', publisherId: 'pzs8sxrjxfjjc' });
  assert.deepEqual(parsePackageFullName('OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0').name, 'OpenAI.Codex');
  assert.equal(parsePackageFullName('not a package'), null);
  const names = ['Microsoft.Edge_1.0.0.0_x64__8wekyb3d8bbwe', 'Claude_2.31226.1.0_x64__pzs8sxrjxfjjc', 'OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0'];
  assert.equal(findInstalled('claude-desktop', names)[0].version, '2.31226.1.0');
  assert.equal(findInstalled('chatgpt-desktop', names)[0].package, 'OpenAI.Codex');
  assert.equal(findInstalled('claude-desktop', ['Other_1.0.0.0_x64__abc']).length, 0);
  assert.equal(findInstalled('claude-desktop', [], ['app-1.2.3', 'junk'])[0].version, '1.2.3');

  const md = '# t\n\n## Code tab\n\n- `side-chat`: Side chat (Ctrl+;) reading the main thread.\nnot a bullet\n- plain bullet\n\n## Remote\n- `remote-control`: Drive a session from the phone.\n';
  assert.deepEqual(parseInventory(md), [
    { slug: 'side-chat', text: 'Side chat (Ctrl+;) reading the main thread.', group: 'Code tab' },
    { slug: 'remote-control', text: 'Drive a session from the phone.', group: 'Remote' },
  ]);
  const snap = extractDesktop({ product: 'claude-desktop', installed: [{ version: '2.31226.1.0', package: 'Claude' }], inventoryMd: md, now: NOW });
  assert.equal(snap.version, '2.31226.1.0');
  assert.deepEqual(snap.items.map((i) => i.id), ['claude-desktop:feature:remote-control', 'claude-desktop:feature:side-chat']);
  assert.equal(extractDesktop({ product: 'chatgpt-desktop', installed: [], inventoryMd: '', now: NOW }).version, 'unknown');
});

/* ---------- snapshots ---------- */

const item = (id, attrs = {}) => { const { kind } = parseId(id); return { id, kind, attrs }; };

test('parity snapshot: stable stringify, one item per line, sorted, duplicates refused', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  const snap = buildSnapshot({ product: 'codex', version: '0.1.0', now: NOW, meta: { x: 1 }, items: [makeItem('codex', 'notification', 'b', { params: ['x'] }), makeItem('codex', 'client-request', 'a')] });
  assert.deepEqual(snap.items.map((i) => i.id), ['codex:client-request:a', 'codex:notification:b']);
  assert.deepEqual(snap.counts, { 'client-request': 1, notification: 1 });
  const text = serializeSnapshot(snap);
  assert.equal(text.split('\n').filter((l) => l.startsWith('    {')).length, 2);
  assert.deepEqual(JSON.parse(text), snap);
  assert.throws(() => buildSnapshot({ product: 'codex', version: '1', now: NOW, items: [makeItem('codex', 'k', 'a'), makeItem('codex', 'k', 'a')] }), /duplicate surface id/);
  assert.deepEqual(makeItem('p', 'k', 'n', { a: false, b: [], c: {}, d: null, e: undefined, f: 1 }).attrs, { f: 1 });
  assert.deepEqual(parseId('codex:server-request:item/tool/requestUserInput'), { product: 'codex', kind: 'server-request', name: 'item/tool/requestUserInput' });
  assert.deepEqual(parseId('claude-sdk:message:system/informational'), { product: 'claude-sdk', kind: 'message', name: 'system/informational' });
});

test('parity snapshot: versions compare by number, the baseline is the newest older one', () => {
  assert.ok(compareVersions('0.161.0', '0.162.0') < 0);
  assert.ok(compareVersions('0.162.10', '0.162.9') > 0);
  assert.ok(compareVersions('2.31226.1.0', '2.31226.1') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  const saved = ['0.3.100', '0.3.290', '0.3.295'].map((version) => ({ version }));
  assert.equal(pickBaseline(saved, '0.3.295').version, '0.3.290');
  assert.equal(pickBaseline(saved, '0.3.296').version, '0.3.295');
  assert.equal(pickBaseline([{ version: '0.3.295' }], '0.3.295').version, '0.3.295');
  assert.equal(pickBaseline([], '1.0.0'), null);
});

test('parity snapshot: diff lists added, removed and changed with the attr keys that differ', () => {
  const a = { items: [item('x:message:a', { fields: ['p', 'q?'], t: 1 }), item('x:message:gone'), item('x:message:same', { v: 1 })] };
  const b = { items: [item('x:message:a', { fields: ['p', 'r'], t: 1 }), item('x:message:new'), item('x:message:same', { v: 1 })] };
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.added.map((i) => i.id), ['x:message:new']);
  assert.deepEqual(d.removed.map((i) => i.id), ['x:message:gone']);
  assert.equal(d.changed.length, 1);
  assert.deepEqual(d.changed[0].changes.map((c) => c.key), ['fields']);
  assert.equal(describeChange(d.changed[0].changes[0]), 'fields: +r, -q?');
  assert.equal(describeChange({ key: 'type', before: 'a', after: 'b' }), 'type: a -> b');
  assert.equal(describeChange({ key: 'enums', before: { level: ['a', 'b'], same: ['x'] }, after: { level: ['a', 'b', 'c'], same: ['x'] } }), 'enums.level: +c');
  assert.deepEqual(diffSnapshots(a, a), { added: [], removed: [], changed: [] });
});

test('parity snapshot: save and load round trip, oldest version first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-parity-test-'));
  try {
    for (const version of ['0.10.0', '0.9.0']) saveSnapshot(dir, buildSnapshot({ product: 'codex', version, now: NOW, items: [makeItem('codex', 'cli', 'x')] }));
    assert.deepEqual(loadSnapshots(dir, 'codex').map((s) => s.version), ['0.9.0', '0.10.0']);
    assert.deepEqual(loadSnapshots(dir, 'nothing'), []);
    assert.ok(fs.existsSync(path.join(dir, 'snapshots', 'codex', '0.10.0.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- ledger ---------- */

const feat = (o) => ({
  id: 'a-feature', title: 'A feature', product: 'claude-sdk', upstream: ['claude-sdk:message:a'], status: 'supported',
  surfaces: { desktop: 'supported', phone: 'supported' }, where: ['x.js'], commits: ['abc1234'], sessions: ['c6e7b179-2ed4-4ae5-afac-7845f0c7b029'],
  verifiedAgainst: { 'claude-sdk': '1.0.0' }, notes: 'n', ...o,
});

test('parity ledger: status follows surfaces and the shape is checked', () => {
  assert.equal(deriveStatus({ desktop: 'supported', phone: 'supported' }), 'supported');
  assert.equal(deriveStatus({ desktop: 'supported', phone: 'n/a' }), 'supported');
  assert.equal(deriveStatus({ desktop: 'supported', phone: 'planned' }), 'partial');
  assert.equal(deriveStatus({ desktop: 'planned', phone: 'partial' }), 'partial');
  assert.equal(deriveStatus({ desktop: 'planned', phone: 'planned' }), 'planned');
  assert.equal(deriveStatus({ desktop: 'n/a', phone: 'n/a' }), 'not-applicable');

  assert.deepEqual(validateLedger({ features: [feat({})] }).errors, []);
  const bad = validateLedger({ features: [
    feat({ id: 'Bad Id' }), feat({ id: 'dup' }), feat({ id: 'dup' }),
    feat({ id: 'no-status', status: 'done' }),
    feat({ id: 'mismatch', status: 'supported', surfaces: { desktop: 'supported', phone: 'planned' } }),
    feat({ id: 'bad-surface', surfaces: { desktop: 'supported', phone: 'yes' } }),
    feat({ id: 'no-phone', surfaces: { desktop: 'supported' } }),
    feat({ id: 'odd-key', surfaces: { desktop: 'supported', phone: 'supported', tablet: 'planned' } }),
    feat({ id: 'bad-commit', commits: ['xyz'] }), feat({ id: 'bad-session', sessions: ['nope'] }),
    feat({ id: 'bad-upstream', upstream: ['no-kind'] }), feat({ id: 'bad-product', product: 'nope' }),
  ] }).errors.join('\n');
  for (const want of ['kebab-case', 'duplicate id', 'status must be', 'does not match its surfaces', 'surfaces.phone must be', 'unknown surface tablet', 'not a short hash', 'not a session id', 'not product:kind:name', 'product must be']) assert.match(bad, new RegExp(want), want);
  const warn = validateLedger({ features: [feat({ id: 'thin', where: [], commits: [], notes: undefined, upstream: [] })] }).warnings.join('\n');
  assert.match(warn, /no where/);
  assert.match(warn, /no commits/);
  assert.match(warn, /no upstream ids/);
  assert.deepEqual(validateLedger({}).errors.length, 1);
});

test('parity ledger: patterns match exact ids and * wildcards, files are checked through a callback', () => {
  assert.ok(patternToRegex('codex:notification:item/commandExecution/*').test('codex:notification:item/commandExecution/outputDelta'));
  assert.ok(!patternToRegex('codex:notification:item/commandExecution/*').test('codex:notification:item/fileChange/outputDelta'));
  assert.ok(patternToRegex('a:b.c:d').test('a:b.c:d'));
  assert.ok(!patternToRegex('a:b.c:d').test('a:bxc:d'));
  assert.deepEqual(matchIds(['x:k:a', 'y:k:*'], ['x:k:a', 'x:k:b', 'y:k:1', 'y:k:2']), ['x:k:a', 'y:k:1', 'y:k:2']);
  const led = { features: [feat({ where: ['here.js', 'gone.js'] })] };
  assert.deepEqual(missingFiles(led, (f) => f === 'here.js').map((m) => m.file), ['gone.js']);
});

test('parity ledger: phone gaps only count against a supported desktop with nothing on the phone', () => {
  const g = (d, p) => phoneGap(feat({ surfaces: { desktop: d, phone: p } }));
  assert.equal(g('supported', 'supported'), null);
  assert.equal(g('supported', 'n/a'), null);
  assert.equal(g('planned', 'planned'), null);
  assert.equal(g('n/a', 'planned'), null);
  assert.deepEqual(g('supported', 'planned'), { desktop: 'supported', phone: 'planned', strict: true });
  assert.deepEqual(g('supported', 'partial'), { desktop: 'supported', phone: 'partial', strict: false });
  assert.deepEqual(g('partial', 'planned'), { desktop: 'partial', phone: 'planned', strict: false });
  assert.equal(g('supported', undefined).strict, true);
});

test('parity report: needs attention, dangling, unreviewed, phone gaps, stale verification', () => {
  const before = { product: 'claude-sdk', version: '1.0.0', items: [item('claude-sdk:message:a', { f: 1 }), item('claude-sdk:message:b'), item('claude-sdk:message:c')] };
  const fresh = { product: 'claude-sdk', version: '1.1.0', items: [item('claude-sdk:message:a', { f: 2 }), item('claude-sdk:message:c'), item('claude-sdk:message:d'), item('claude-sdk:option:o'), item('claude-sdk:type:T')] };
  const diffs = { 'claude-sdk': diffSnapshots(before, fresh) };
  const ledger = { features: [
    feat({ id: 'on-a', upstream: ['claude-sdk:message:a'] }),
    feat({ id: 'on-b', upstream: ['claude-sdk:message:b'], status: 'planned', surfaces: { desktop: 'planned', phone: 'planned' } }),
    feat({ id: 'on-c', upstream: ['claude-sdk:message:c', 'claude-sdk:message:typo'] }),
    feat({ id: 'na', upstream: ['claude-sdk:message:b'], status: 'not-applicable', surfaces: { desktop: 'n/a', phone: 'n/a' } }),
    feat({ id: 'lags', upstream: ['claude-sdk:message:c'], status: 'partial', surfaces: { desktop: 'supported', phone: 'planned' } }),
    feat({ id: 'wild', upstream: ['claude-sdk:option:*'] }),
  ] };
  const r = buildReport({ ledger, diffs, current: { 'claude-sdk': fresh } });
  assert.deepEqual(r.needsAttention.map((h) => [h.feature.id, h.removed, h.changed]), [['on-a', [], ['claude-sdk:message:a']], ['on-b', ['claude-sdk:message:b'], []]]);
  assert.equal(r.needsAttention[0].detail['claude-sdk:message:a'], 'f: 1 -> 2');
  assert.deepEqual(r.dangling.map((d) => `${d.feature.id} ${d.pattern}`), ['on-c claude-sdk:message:typo']);
  assert.deepEqual(r.unreviewed, { 'claude-sdk': { message: ['claude-sdk:message:d'] } });
  assert.deepEqual(r.phoneGaps.map((g) => g.feature.id), ['lags']);
  assert.equal(r.stale.length, 6);
  assert.equal(r.attention, 2 + 1 + 1);
  assert.equal(buildReport({ ledger, diffs, current: { 'claude-sdk': fresh }, details: true }).unreviewed['claude-sdk'].type[0], 'claude-sdk:type:T');
  assert.ok(DETAIL_KINDS.has('type'));

  const lines = renderReport(r).join('\n');
  for (const want of ['NEEDS ATTENTION', 'on-a [supported]', 'removed  claude-sdk:message:b', 'changed  claude-sdk:message:a  [f: 1 -> 2]', 'DANGLING', 'UNREVIEWED', 'claude-sdk:message:d', 'PHONE GAPS', 'lags: desktop supported, phone planned  (counts for --strict)', 'RE-VERIFY']) assert.ok(lines.includes(want), want);

  const prod = renderProductDiff({ product: 'claude-sdk', fresh, baseline: before, diff: diffs['claude-sdk'] }).join('\n');
  assert.match(prod, /fresh 1\.1\.0 vs saved 1\.0\.0/);
  assert.match(prod, /added 2, removed 1, changed 1 \(1 data-model detail changes hidden/);
  assert.match(prod, /~ claude-sdk:message:a {2}\[f: 1 -> 2\]/);
  assert.match(renderProductDiff({ product: 'x', fresh, baseline: null, diff: { added: [], removed: [], changed: [] } }).join('\n'), /no saved snapshot/);
});

test('parity ledger: coverage numbers and the generated markdown block', () => {
  const snap = { product: 'claude-sdk', version: '1.0.0', items: [item('claude-sdk:message:a'), item('claude-sdk:message:b'), item('claude-sdk:type:T')] };
  const ledger = { features: [feat({ upstream: ['claude-sdk:message:a', 'claude-sdk:type:*'] }), feat({ id: 'two', upstream: [], product: 'apaki', status: 'planned', surfaces: { desktop: 'planned', phone: 'planned' } })] };
  const s = summarizeCoverage({ ledger, snapshots: [snap] });
  assert.deepEqual(s.products['claude-sdk'], { version: '1.0.0', total: 3, covered: 2, primaryTotal: 2, primaryCovered: 1, byKind: { message: { total: 2, covered: 1 }, type: { total: 1, covered: 1 } } });
  assert.equal(s.features, 2);
  assert.deepEqual(s.byStatus, { supported: 1, planned: 1 });
  assert.deepEqual(s.bySurface.phone, { supported: 1, planned: 1 });
  assert.equal(replaceBetween('top\n[//]: # (s)\nold\n[//]: # (e)\nbottom\n', '[//]: # (s)', '[//]: # (e)', 'new'), 'top\n[//]: # (s)\nnew\n[//]: # (e)\nbottom\n');
  assert.equal(replaceBetween('top\n', '[//]: # (s)', '[//]: # (e)', 'new'), 'top\n\n[//]: # (s)\nnew\n[//]: # (e)\n');
});

/* ---------- the saved ledger and snapshots ---------- */

test('parity saved data: features.json is valid and its ids exist in the snapshots it was verified against', () => {
  const ledger = loadLedger(PARITY_ROOT);
  const { errors } = validateLedger(ledger);
  assert.deepEqual(errors, []);
  assert.ok(ledger.features.length > 50);
  const newest = {};
  for (const product of ['claude-sdk', 'codex', 'claude-desktop', 'chatgpt-desktop']) newest[product] = loadSnapshots(PARITY_ROOT, product).pop();
  for (const [p, s] of Object.entries(newest)) assert.ok(s, `a saved snapshot of ${p}`);
  const problems = [];
  for (const f of ledger.features) {
    for (const u of f.upstream) {
      const product = parseId(u).product;
      const snap = newest[product];
      if (!snap) { problems.push(`${f.id}: no snapshot for ${product}`); continue; }
      // only enforce for entries checked against the newest saved version; an upgrade leaves older claims alone until they are re-verified
      if (f.verifiedAgainst[product] !== snap.version) continue;
      if (!matchIds([u], snap.items.map((i) => i.id)).length) problems.push(`${f.id}: ${u} is not in ${product} ${snap.version}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('parity saved data: snapshots are sorted, unique, in the one-item-per-line format, and name their product', () => {
  for (const product of ['claude-sdk', 'codex', 'claude-desktop', 'chatgpt-desktop']) {
    const dir = path.join(PARITY_ROOT, 'snapshots', product);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 1, product);
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const snap = JSON.parse(text);
      assert.equal(snap.product, product);
      assert.equal(`${snap.version}.json`, f);
      const ids = snap.items.map((i) => i.id);
      assert.deepEqual(ids, [...ids].sort(), `${product}/${f} sorted`);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(ids.every((id) => id.startsWith(`${product}:`)));
      assert.equal(serializeSnapshot(snap), text, `${product}/${f} is in canonical form`);
    }
  }
});

test('parity saved data: the hand kept desktop inventories parse, and PARITY.md has its generated section', () => {
  for (const product of ['claude-desktop', 'chatgpt-desktop']) {
    const md = fs.readFileSync(path.join(PARITY_ROOT, 'manual', `${product}.md`), 'utf8');
    assert.ok(parseInventory(md).length >= 10, product);
  }
  assert.ok(fs.readFileSync(path.join(PARITY_ROOT, 'PARITY.md'), 'utf8').includes('[//]: # (parity:coverage:start)'));
});
