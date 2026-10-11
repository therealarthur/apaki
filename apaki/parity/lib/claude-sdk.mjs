/**
 * claude-sdk.mjs: the extractor for the "claude-sdk" product of the upstream
 * parity tracker (apaki/parity/PARITY.md; Arthur, 2026-10-11).
 *
 * "claude-sdk" is what Apaki sits on: the Claude Agent SDK package
 * (node_modules/@anthropic-ai/claude-agent-sdk, its sdk.d.ts and
 * sdk-tools.d.ts) and the Claude Code binary it bundles
 * (claude-agent-sdk-win32-x64/claude.exe, run once with --version and --help).
 * The binary also carries the settings schema as minified JavaScript, which
 * lists settings the published types leave out (the "@internal" ones), so the
 * settings keys are read from both and each item says where it was seen.
 *
 * extractClaudeSdk() is pure: it takes the text of those files and returns a
 * snapshot (snapshot.mjs). Reading the files and running the binary is
 * collectClaudeSdk() at the bottom, used by extract.mjs.
 *
 * Item kinds written: message, option, setting, hook-event, permission-mode,
 * control-request, query-method, export, enum, tool-input, tool-output,
 * cli-flag, cli-command.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Dts, literalUnion, plainDashes, squash } from './dts.mjs';
import { buildSnapshot, clip, makeItem, shortHash } from './snapshot.mjs';
import { parseCommands, parseFlags } from './help.mjs';

const PRODUCT = 'claude-sdk';

/** "a", "b?" style field list, sorted, from a members Map. */
export function fieldList(members) {
  return [...members.entries()].map(([name, m]) => `${name}${m.optional ? '?' : ''}`).sort();
}

/**
 * Merge two field lists ("a", "b?"): a field is optional when either list has it
 * optional or when one list lacks it.
 */
export function mergeFieldLists(a, b) {
  const parse = (list) => new Map(list.map((f) => [f.replace(/\?$/, ''), f.endsWith('?')]));
  const x = parse(a);
  const y = parse(b);
  const out = [];
  for (const k of new Set([...x.keys(), ...y.keys()])) {
    const optional = (x.has(k) ? x.get(k) : true) || (y.has(k) ? y.get(k) : true);
    out.push(`${k}${optional ? '?' : ''}`);
  }
  return out.sort();
}

/** Fields whose type is a pure string literal union, as { field: [values] }, skipping the discriminators. */
export function fieldEnums(members, skip = ['type', 'subtype', 'hook_event_name']) {
  const out = {};
  for (const [name, m] of members) {
    if (skip.includes(name)) continue;
    const lits = literalUnion(m.type);
    if (lits && lits.length > 1) out[name] = [...lits].sort();
  }
  return out;
}

/** type text + hash, doc flags, for an option or setting member. */
function memberAttrs(m) {
  const doc = m.doc || '';
  return {
    type: clip(m.type, 120),
    typeHash: m.type.length > 120 ? shortHash(m.type) : undefined,
    optional: m.optional || undefined,
    deprecated: /@deprecated\b/.test(doc) || /^deprecated\b/i.test(doc) || undefined,
    internal: /@internal\b/.test(doc) || undefined,
    doc: doc ? clip(doc.replace(/@(deprecated|internal)\b/g, '').trim(), 160) : undefined,
  };
}

/** Every SDKMessage union arm as message items, keyed by type and subtype. */
export function extractMessages(dts) {
  const items = new Map();
  for (const leaf of dts.unionLeaves('SDKMessage')) {
    const members = dts.membersOfDecl(leaf);
    if (!members.has('type')) continue;
    const types = literalUnion(members.get('type').type);
    if (!types) continue;
    const subs = members.has('subtype') ? literalUnion(members.get('subtype').type) : null;
    for (const t of types) {
      const names = members.has('subtype') ? (subs ? subs.map((s) => `${t}/${s}`) : [`${t}`]) : [t];
      for (const name of names) {
        const id = `${PRODUCT}:message:${name}`;
        const fields = fieldList(members);
        const enums = fieldEnums(members);
        const prev = items.get(id);
        if (!prev) {
          items.set(id, { name, types: [leaf], fields, enums, subtypeOpen: members.has('subtype') && !subs ? true : undefined });
        } else {
          // two declarations share one type/subtype (a user message and its replay): union of fields
          prev.types.push(leaf);
          prev.fields = mergeFieldLists(prev.fields, fields);
          for (const [k, v] of Object.entries(enums)) prev.enums[k] = [...new Set([...(prev.enums[k] || []), ...v])].sort();
        }
      }
    }
  }
  return [...items.values()].map((m) => makeItem(PRODUCT, 'message', m.name, { types: m.types.sort(), fields: m.fields, enums: m.enums, subtypeOpen: m.subtypeOpen }));
}

/** Options keys of the query() options type. */
export function extractOptions(dts) {
  const out = [];
  for (const [name, m] of dts.membersOfDecl('Options')) out.push(makeItem(PRODUCT, 'option', name, memberAttrs(m)));
  return out;
}

/** Hook events with the fields of their input and output types. */
export function extractHookEvents(dts) {
  const events = dts.literalsOf('HOOK_EVENTS') || dts.literalsOf('HookEvent') || [];
  return events.map((ev) => {
    const input = dts.membersOfDecl(`${ev}HookInput`);
    const output = dts.membersOfDecl(`${ev}HookSpecificOutput`);
    return makeItem(PRODUCT, 'hook-event', ev, {
      input: input.size ? fieldList(input) : undefined,
      output: output.size ? fieldList(output) : undefined,
      enums: fieldEnums(input),
    });
  });
}

/** Permission modes, one item per value. */
export function extractPermissionModes(dts) {
  return (dts.literalsOf('PermissionMode') || []).map((m) => makeItem(PRODUCT, 'permission-mode', m));
}

/** Control request subtypes (what a client can ask the Claude Code process to do). */
export function extractControlRequests(dts) {
  const out = [];
  for (const leaf of dts.unionLeaves('SDKControlRequestInner')) {
    const members = dts.membersOfDecl(leaf);
    const subs = members.has('subtype') ? literalUnion(members.get('subtype').type) : null;
    if (!subs) continue;
    for (const s of subs) out.push(makeItem(PRODUCT, 'control-request', s, { type: leaf, fields: fieldList(members), enums: fieldEnums(members) }));
  }
  return out;
}

/** Methods and properties of the Query interface (what the live query handle offers). */
export function extractQueryMethods(dts) {
  const d = dts.decl('Query');
  if (!d) return [];
  const body = dts.bodyRange(d);
  const out = [];
  for (const m of dts.objectMembers(body.open)) {
    out.push(makeItem(PRODUCT, 'query-method', m.name, {
      sig: clip(m.type, 140),
      sigHash: m.type.length > 140 ? shortHash(m.type) : undefined,
      deprecated: /@deprecated\b/.test(m.doc) || undefined,
    }));
  }
  return out;
}

/** Exported values (functions, classes, consts): the runtime API of the package. */
export function extractExports(dts) {
  const byName = new Map();
  for (const d of dts.decls) {
    if (!d.exported || !['function', 'class', 'const', 'enum'].includes(d.kind)) continue;
    const text = squash(dts.text({ a: d.a, b: d.b }).replace(/^export\s+declare\s+(?:abstract\s+)?(?:function|class|const|enum)\s+[A-Za-z_$][\w$]*/, ''));
    const lits = d.kind === 'const' ? dts.literalsOf(d.name) : null;
    const prev = byName.get(d.name);
    byName.set(d.name, { kind: d.kind, sig: prev ? `${prev.sig} ${text}` : text, values: lits || undefined });
  }
  return [...byName.entries()].map(([name, v]) => makeItem(PRODUCT, 'export', name, {
    kind: v.kind,
    sig: v.values ? undefined : clip(v.sig, 140),
    sigHash: !v.values && v.sig.length > 140 ? shortHash(v.sig) : undefined,
    values: v.values,
  }));
}

/** Named types that are pure string literal unions, one item per type (the value lists). */
export function extractEnums(dts, skip = ['HookEvent', 'PermissionMode']) {
  const out = [];
  const seen = new Set();
  for (const d of dts.decls) {
    if (d.kind !== 'type' || skip.includes(d.name) || seen.has(d.name)) continue;
    seen.add(d.name);
    const lits = dts.literalsOf(d.name);
    if (lits && lits.length > 1) out.push(makeItem(PRODUCT, 'enum', d.name, { values: [...lits].sort() }));
  }
  return out;
}

/** Tool inputs and outputs from sdk-tools.d.ts (the shapes of Claude Code's built in tools). */
export function extractTools(toolsDts) {
  const out = [];
  for (const d of toolsDts.decls) {
    if (!d.exported || (d.kind !== 'interface' && d.kind !== 'type')) continue;
    const m = /^(.+?)(Input|Output)$/.exec(d.name);
    if (!m || m[1] === 'ToolInput' || m[1] === 'ToolOutput') continue;
    const members = toolsDts.membersOfDecl(d.name);
    out.push(makeItem(PRODUCT, m[2] === 'Input' ? 'tool-input' : 'tool-output', m[1], { fields: fieldList(members), enums: fieldEnums(members) }));
  }
  return out;
}

/** Settings keys from the SDK's Settings interface (the typed view of the settings schema). */
export function extractSettingsFromTypes(dts) {
  const out = new Map();
  for (const [name, m] of dts.membersOfDecl('Settings')) out.set(name, { ...memberAttrs(m), source: 'types' });
  return out;
}

// ---- the settings schema inside the Claude Code binary ----------------------------------------

/** Read the JavaScript string literal that starts at s[i], returning { value, end }. */
export function readJsString(s, i) {
  const q = s[i];
  let j = i + 1;
  let v = '';
  while (j < s.length && s[j] !== q) {
    if (s[j] === '\\') {
      const c = s[j + 1];
      if (c === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(j + 2, j + 6))) { v += String.fromCharCode(parseInt(s.slice(j + 2, j + 6), 16)); j += 6; continue; }
      v += c === 'n' ? '\n' : c === 't' ? '\t' : c;
      j += 2;
      continue;
    }
    v += s[j];
    j++;
  }
  return { value: v, end: j + 1 };
}

/**
 * Keys (and descriptions) of the settings schema in minified Claude Code
 * JavaScript. The schema is an object literal of lazy members
 * `key:()=>zod.expr().optional().describe("...")` that starts at
 * `$schema:()=>`; this walks it by bracket depth, treating strings and regex
 * literals as opaque, and returns [{ key, description }].
 */
export function parseBinarySettings(text) {
  // anchor on apiKeyHelper (a stable key); the object begins at the $schema member just before it
  const anchor = text.indexOf('apiKeyHelper:()=>');
  let start = anchor === -1 ? text.indexOf('$schema:()=>') : text.lastIndexOf('$schema:()=>', anchor);
  if (start === -1) start = anchor;
  if (start === -1) return [];
  const s = text;
  const entries = [];
  let depth = 0;
  let i = start;
  let memberStart = start;
  const flush = (end) => {
    const seg = s.slice(memberStart, end);
    const km = /^\s*([A-Za-z_$][\w$]*|"[^"]+"):/.exec(seg);
    if (!km) return;
    const dm = /\.describe\(((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?:\+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))*)\)(?:\.catch\([^)]*\))?$/.exec(seg);
    let description;
    if (dm) {
      description = '';
      let k = 0;
      const lit = dm[1];
      while (k < lit.length) {
        const r = readJsString(lit, k);
        description += r.value;
        k = r.end;
        if (lit[k] === '+') k++;
      }
    }
    entries.push({ key: km[1].replace(/"/g, ''), description });
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === '\'' || c === '`') { i = readJsString(s, i).end; continue; }
    if (c === '/' && /[(,=:[!&|?{};]/.test(prevSignificant(s, i))) {
      // regex literal: skip to the closing slash outside a character class
      let j = i + 1;
      let inClass = false;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '[') inClass = true;
        else if (s[j] === ']') inClass = false;
        else if (s[j] === '/' && !inClass) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ')' || c === ']') {
      if (depth === 0) { flush(i); break; }
      depth--;
      i++;
      continue;
    }
    if (c === ',' && depth === 0) {
      flush(i);
      memberStart = i + 1;
      i++;
      continue;
    }
    i++;
  }
  return entries;
}

/** The last non-space character before index i (for regex-or-divide decisions). */
function prevSignificant(s, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j])) j--;
  return j >= 0 ? s[j] : '(';
}

/** Merge settings seen in the types and in the binary into setting items. */
export function mergeSettings(typed, binary) {
  const keys = new Set([...typed.keys(), ...(binary || []).map((b) => b.key)]);
  const bin = new Map((binary || []).map((b) => [b.key, b]));
  const out = [];
  for (const key of keys) {
    const t = typed.get(key);
    const b = bin.get(key);
    const attrs = t ? { ...t } : {};
    if (binary) attrs.source = t && b ? 'types+binary' : t ? 'types' : 'binary';
    if (!t && b) {
      const doc = plainDashes(b.description || '');
      attrs.doc = clip(doc.replace(/@internal\s*/g, '').trim(), 160) || undefined;
      attrs.internal = /@internal/.test(doc) || undefined;
      attrs.deprecated = /^deprecated\b/i.test(doc) || undefined;
    }
    out.push(makeItem(PRODUCT, 'setting', key, attrs));
  }
  return out;
}

/** CLI flags and subcommands of the bundled claude binary. */
export function extractCli(helpText) {
  const items = [];
  for (const f of parseFlags(helpText)) {
    items.push(makeItem(PRODUCT, 'cli-flag', f.long, { short: f.short, aliases: f.aliases, arg: f.arg, choices: f.choices }));
  }
  for (const c of parseCommands(helpText)) {
    items.push(makeItem(PRODUCT, 'cli-command', c.name, { aliases: c.aliases, args: c.args }));
  }
  return items;
}

/**
 * Build the claude-sdk snapshot from file texts.
 * @param {object} p
 * @param {string} p.sdkDts text of sdk.d.ts
 * @param {string} [p.toolsDts] text of sdk-tools.d.ts
 * @param {string} p.sdkVersion package.json version of @anthropic-ai/claude-agent-sdk
 * @param {string} [p.claudeCodeVersion] output of claude --version ("2.1.295 (Claude Code)")
 * @param {string} [p.binarySchemaText] a window of the binary starting before "$schema:()=>"
 * @param {string} [p.cliHelp] output of claude --help
 */
export function extractClaudeSdk({ sdkDts, toolsDts, sdkVersion, claudeCodeVersion, binarySchemaText, cliHelp, now }) {
  const dts = new Dts(sdkDts);
  const binary = binarySchemaText ? parseBinarySettings(binarySchemaText) : null;
  const items = [
    ...extractMessages(dts),
    ...extractOptions(dts),
    ...extractHookEvents(dts),
    ...extractPermissionModes(dts),
    ...extractControlRequests(dts),
    ...extractQueryMethods(dts),
    ...extractExports(dts),
    ...extractEnums(dts),
    ...mergeSettings(extractSettingsFromTypes(dts), binary && binary.length ? binary : null),
    ...(toolsDts ? extractTools(new Dts(toolsDts)) : []),
    ...(cliHelp ? extractCli(cliHelp) : []),
  ];
  const ccv = claudeCodeVersion ? (/^(\d+(?:\.\d+)+)/.exec(claudeCodeVersion.trim()) || [])[1] : undefined;
  return buildSnapshot({
    product: PRODUCT,
    version: sdkVersion,
    now,
    meta: {
      claudeCodeVersion: ccv,
      sdkPackage: '@anthropic-ai/claude-agent-sdk',
      settingsFromBinary: binary && binary.length ? binary.length : undefined,
    },
    items,
  });
}

/** Run a program and return its stdout, or null when it is missing or fails. */
function run(cmd, args, timeout = 60000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

/** Read a window of a big file starting at the first occurrence of needle (streamed; the claude binary is about 250 MB). */
export function readWindowAt(file, needle, windowBytes = 400000, back = 64) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = 16 * 1024 * 1024;
    const buf = Buffer.alloc(chunk + needle.length);
    const nb = Buffer.from(needle);
    let pos = 0;
    let carry = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, carry, chunk, pos);
      if (!n) return null;
      const len = carry + n;
      const at = buf.subarray(0, len).indexOf(nb);
      if (at !== -1) {
        const abs = pos - carry + at;
        const out = Buffer.alloc(windowBytes + back);
        const from = Math.max(0, abs - back);
        const got = fs.readSync(fd, out, 0, out.length, from);
        return out.subarray(0, got).toString('utf8');
      }
      carry = Math.min(nb.length - 1, len);
      buf.copy(buf, 0, len - carry, len);
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Gather the real inputs from node_modules under repoRoot and extract. */
export function collectClaudeSdk(repoRoot, now = new Date()) {
  const base = path.join(repoRoot, 'node_modules', '@anthropic-ai');
  const pkgDir = path.join(base, 'claude-agent-sdk');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const sdkDts = fs.readFileSync(path.join(pkgDir, 'sdk.d.ts'), 'utf8');
  const toolsFile = path.join(pkgDir, 'sdk-tools.d.ts');
  const toolsDts = fs.existsSync(toolsFile) ? fs.readFileSync(toolsFile, 'utf8') : undefined;
  const exe = path.join(base, `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
  const notes = [];
  let claudeCodeVersion;
  let cliHelp;
  let binarySchemaText;
  if (fs.existsSync(exe)) {
    claudeCodeVersion = run(exe, ['--version']) || undefined;
    cliHelp = run(exe, ['--help']) || undefined;
    // the settings schema is minified JavaScript; apiKeyHelper is its second member, so start the window just before it
    try { binarySchemaText = readWindowAt(exe, 'apiKeyHelper:()=>', 600000, 200) || undefined; } catch (e) { notes.push(`binary settings scan failed: ${e.message}`); }
    if (!claudeCodeVersion) notes.push('claude --version failed');
    if (!cliHelp) notes.push('claude --help failed');
    if (!binarySchemaText) notes.push('settings schema not found in the binary');
  } else {
    notes.push(`bundled binary not found at ${exe}`);
  }
  const snap = extractClaudeSdk({ sdkDts, toolsDts, sdkVersion: pkg.version, claudeCodeVersion, binarySchemaText, cliHelp, now });
  return { snapshot: snap, notes };
}
