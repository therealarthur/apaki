/**
 * codex.mjs: the extractor for the "codex" product of the upstream parity
 * tracker (apaki/parity/PARITY.md; Arthur, 2026-10-11, apaki/remote/CODEX.md).
 *
 * "codex" is the Codex app-server protocol, the JSON-RPC surface OpenAI's Codex
 * app and IDE extensions speak and that Apaki will speak (CODEX.md). The
 * installed CLI writes its JSON Schema bundle:
 *   codex app-server generate-json-schema --out <dir>
 * (once plain, once with --experimental, so experimental methods and params
 * are marked rather than mixed in). This reads ClientRequest.json,
 * ServerRequest.json, ServerNotification.json, ClientNotification.json and the
 * two bundles in that folder, and `codex --version` / `--help`.
 *
 * extractCodex() is pure (file contents in, snapshot out); collectCodex() runs
 * the CLI into a temp folder and deletes the folder afterwards.
 *
 * Item kinds written: client-request, server-request, notification,
 * client-notification, item-type, input-item, enum, type, cli, cli-flag.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSnapshot, makeItem } from './snapshot.mjs';
import { parseCommands, parseFlags } from './help.mjs';

const PRODUCT = 'codex';

/** "#/definitions/Foo" -> "Foo" ("#/definitions/v2/Foo" -> "Foo"). */
export const refName = (ref) => (typeof ref === 'string' ? ref.split('/').pop() : undefined);

/** "a", "b?" field list of an object schema (required decides the question mark), sorted. */
export function schemaFields(def) {
  if (!def || typeof def !== 'object') return [];
  const props = def.properties || {};
  const req = new Set(def.required || []);
  return Object.keys(props).map((k) => `${k}${req.has(k) ? '' : '?'}`).sort();
}

/**
 * The method list of a JSON-RPC union schema (ClientRequest, ServerRequest,
 * ServerNotification, ClientNotification): [{ method, paramsType, params }].
 * defs resolves a params $ref to its definition.
 */
export function methodsOf(schema, defs) {
  const out = [];
  for (const arm of schema?.oneOf || []) {
    const method = arm.properties?.method?.enum?.[0];
    if (!method) continue;
    const paramsType = refName(arm.properties?.params?.$ref);
    const def = paramsType ? (defs[paramsType] || schema.definitions?.[paramsType]) : arm.properties?.params;
    out.push({ method, paramsType, params: schemaFields(def) });
  }
  return out;
}

/**
 * Named values of an enum-like definition: a plain enum, or a oneOf of string
 * enums and tagged objects ({ type: 'x' } -> "x") and single-key objects
 * ({ granular: {...} } -> "{granular}"). Null when the definition is not
 * enum-like.
 */
export function variantsOf(def) {
  if (!def || typeof def !== 'object') return null;
  if (Array.isArray(def.enum)) return def.enum.map(String).sort();
  const arms = def.oneOf || def.anyOf;
  if (!Array.isArray(arms) || !arms.length) return null;
  const out = [];
  for (const arm of arms) {
    if (Array.isArray(arm.enum)) { out.push(...arm.enum.map(String)); continue; }
    if (!arm.properties) return null;
    const tags = Object.entries(arm.properties).filter(([, p]) => Array.isArray(p.enum) && p.enum.length === 1).map(([k]) => k);
    const tag = ['type', 'kind', 'method', 'mode', 'status'].find((t) => tags.includes(t)) || tags[0];
    if (tag) { out.push(String(arm.properties[tag].enum[0])); continue; }
    const req = arm.required || Object.keys(arm.properties);
    if (req.length === 1) { out.push(`{${req[0]}}`); continue; }
    return null;
  }
  return out.sort();
}

/** The discriminated variants of a tagged union definition (ThreadItem, UserInput): [{ tag, fields }]. */
export function taggedVariants(def) {
  const out = [];
  for (const arm of def?.oneOf || []) {
    const entry = Object.entries(arm.properties || {}).find(([k, p]) => k === 'type' && Array.isArray(p.enum) && p.enum.length === 1);
    if (!entry) continue;
    out.push({ tag: String(entry[1].enum[0]), fields: schemaFields(arm).filter((f) => f.replace(/\?$/, '') !== 'type') });
  }
  return out;
}

/** Methods only the experimental generation lists, and params only it lists, marked. */
function markExperimental(plain, exp) {
  const base = new Map(plain.map((m) => [m.method, m]));
  const out = plain.map((m) => ({ ...m }));
  for (const e of exp) {
    const p = base.get(e.method);
    if (!p) { out.push({ ...e, experimental: true }); continue; }
    const have = new Set(p.params.map((f) => f.replace(/\?$/, '')));
    const extra = e.params.filter((f) => !have.has(f.replace(/\?$/, '')));
    if (extra.length) out.find((m) => m.method === e.method).experimentalParams = extra;
  }
  return out;
}

/**
 * Build the codex snapshot.
 * @param {object} p
 * @param {string} p.version output of codex --version ("codex-cli 0.161.0")
 * @param {object} p.plain parsed schema files { clientRequest, serverRequest, serverNotification, clientNotification, bundle, v2 }
 * @param {object} [p.experimental] the same from --experimental
 * @param {string} [p.cliHelp] codex --help
 * @param {string} [p.appServerHelp] codex app-server --help
 */
export function extractCodex({ version, plain, experimental, cliHelp, appServerHelp, now }) {
  const commonDefs = Object.fromEntries(Object.entries(plain.bundle?.definitions || {}).filter(([k]) => k !== 'v2'));
  const defs = { ...commonDefs, ...(plain.v2?.definitions || {}) };
  const expDefs = experimental ? { ...Object.fromEntries(Object.entries(experimental.bundle?.definitions || {}).filter(([k]) => k !== 'v2')), ...(experimental.v2?.definitions || {}) } : {};
  const lists = {
    'client-request': ['clientRequest'],
    'server-request': ['serverRequest'],
    notification: ['serverNotification'],
    'client-notification': ['clientNotification'],
  };
  const items = [];
  const paramTypes = new Set();
  for (const [kind, [key]] of Object.entries(lists)) {
    const base = methodsOf(plain[key], defs);
    const merged = experimental ? markExperimental(base, methodsOf(experimental[key], { ...defs, ...expDefs })) : base;
    for (const m of merged) {
      if (m.paramsType) paramTypes.add(m.paramsType);
      items.push(makeItem(PRODUCT, kind, m.method, {
        paramsType: m.paramsType,
        params: m.params,
        experimental: m.experimental,
        experimentalParams: m.experimentalParams,
      }));
    }
  }
  const skipEnum = new Set(['ClientRequest', 'ServerRequest', 'ServerNotification', 'ClientNotification', 'RequestId', 'ThreadItem', 'UserInput']);
  for (const v of taggedVariants(defs.ThreadItem)) items.push(makeItem(PRODUCT, 'item-type', v.tag, { fields: v.fields }));
  for (const v of taggedVariants(defs.UserInput)) items.push(makeItem(PRODUCT, 'input-item', v.tag, { fields: v.fields }));
  for (const [name, def] of Object.entries(defs)) {
    if (skipEnum.has(name) || name.startsWith('JSONRPC')) continue;
    const values = variantsOf(def);
    if (values) { items.push(makeItem(PRODUCT, 'enum', name, { values })); continue; }
    if (def && def.properties && !paramTypes.has(name) && !/Notification$/.test(name)) {
      items.push(makeItem(PRODUCT, 'type', name, { fields: schemaFields(def) }));
    }
  }
  if (cliHelp) {
    for (const c of parseCommands(cliHelp)) items.push(makeItem(PRODUCT, 'cli', c.name, { aliases: c.aliases, args: c.args }));
    for (const f of parseFlags(cliHelp)) items.push(makeItem(PRODUCT, 'cli-flag', f.long, { short: f.short, aliases: f.aliases, arg: f.arg, choices: f.choices }));
  }
  if (appServerHelp) {
    for (const c of parseCommands(appServerHelp)) items.push(makeItem(PRODUCT, 'cli', `app-server/${c.name}`, { aliases: c.aliases, args: c.args }));
    for (const f of parseFlags(appServerHelp)) items.push(makeItem(PRODUCT, 'cli-flag', `app-server/${f.long}`, { short: f.short, aliases: f.aliases, arg: f.arg, choices: f.choices }));
  }
  const v = /(\d+(?:\.\d+)+(?:[-+][\w.]+)?)/.exec(version || '');
  return buildSnapshot({
    product: PRODUCT,
    version: v ? v[1] : String(version).trim(),
    now,
    meta: { cli: String(version || '').trim() || undefined, experimentalIncluded: experimental ? true : undefined },
    items,
  });
}

/** Run a program through the shell on Windows (codex is an npm .cmd shim there). Returns stdout or null. */
function run(cmd, args, timeout = 120000) {
  const win = process.platform === 'win32';
  const quoted = win ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
  const r = spawnSync(cmd, quoted, { encoding: 'utf8', timeout, shell: win, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

/** Read the schema files a generate-json-schema run wrote into dir. */
export function readSchemaDir(dir) {
  const j = (f) => {
    const p = path.join(dir, f);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  };
  return {
    clientRequest: j('ClientRequest.json'),
    serverRequest: j('ServerRequest.json'),
    serverNotification: j('ServerNotification.json'),
    clientNotification: j('ClientNotification.json'),
    bundle: j('codex_app_server_protocol.schemas.json'),
    v2: j('codex_app_server_protocol.v2.schemas.json'),
  };
}

/**
 * Run the installed codex CLI and extract. The schema is written under the
 * system temp folder and that folder is deleted before returning, success or not.
 * Returns { snapshot, notes } or { snapshot: null, notes } when codex is missing.
 */
export function collectCodex(now = new Date()) {
  const notes = [];
  const version = run('codex', ['--version']);
  if (!version) return { snapshot: null, notes: ['codex --version failed (codex is not installed or not on PATH)'] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apaki-parity-codex-'));
  try {
    const plainDir = path.join(tmp, 'plain');
    const expDir = path.join(tmp, 'experimental');
    if (run('codex', ['app-server', 'generate-json-schema', '--out', plainDir]) === null) return { snapshot: null, notes: ['codex app-server generate-json-schema failed'] };
    const plain = readSchemaDir(plainDir);
    let experimental;
    if (run('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', expDir]) !== null) experimental = readSchemaDir(expDir);
    else notes.push('the --experimental schema could not be generated; experimental methods are not marked');
    const cliHelp = run('codex', ['--help']) || undefined;
    const appServerHelp = run('codex', ['app-server', '--help']) || undefined;
    if (!cliHelp) notes.push('codex --help failed');
    if (!appServerHelp) notes.push('codex app-server --help failed');
    return { snapshot: extractCodex({ version, plain, experimental, cliHelp, appServerHelp, now }), notes };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
