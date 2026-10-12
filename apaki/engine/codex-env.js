/**
 * codex-env.js: what a Codex process in Apaki gets from the Claude side, so a conversation switched to Codex works
 * in the same environment: the same tool servers, the user's working rules, and their skills on request.
 *
 * WHY (Arthur, 2026-10-11: GPT gets "EVERYTHING including all guidlines/skills/etc that claude code might have";
 * SWITCH.md "environment parity", 2026-10-12): SWITCH.md suggested writing ~/.codex/config.toml and ~/.codex/skills.
 * Apaki never writes there (CODEX.md: "Never write ~/.codex/config.toml: every setting goes per process or per
 * thread"), so everything here is read only from the Claude side and handed to Codex at runtime:
 *   - tool servers   ~/.claude.json's mcpServers (user scope) as `-c mcp_servers.<name>.*` overrides of the one
 *                    app-server process. Secrets never go on the command line: a server's variables and header values
 *                    go into the process's environment, and Codex is told their names (env_vars, env_http_headers).
 *                    Names Codex already has in its own config.toml are left to it. APAKI_CODEX_CLAUDE_MCP=0 turns
 *                    this off (the ledger server stays).
 *   - working rules  the CLAUDE.md layers (~/.claude/CLAUDE.md, then every CLAUDE.md from the home folder down to the
 *                    conversation's folder) in a compact form as developer instructions of a switched thread; the
 *                    full text and the memory index through the ledger server (ledger_instructions).
 *   - skills         a list the agent asks for through the ledger server (ledger_skills, ledger_skill).
 * Claude Code's own system prompt and hooks are not carried: Codex has its own, and the rules that matter are written.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tomlList, tomlString, tomlTable } from './codex-client.js';

/** The ledger tool server's name in both agents. */
export const LEDGER_SERVER = 'apaki_ledger';
const BARE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED = new Set(['apaki', LEDGER_SERVER]);

const claudeHome = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** Where Claude Code keeps its user settings and MCP servers: ~/.claude.json (or inside CLAUDE_CONFIG_DIR when set). */
export function claudeJsonPath(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/** The user-scope MCP servers Claude Code has, read only: [{ name, type, command, args, env, url, headers }]. */
export function claudeMcpServers(file = claudeJsonPath()) {
  const text = readText(file);
  if (!text) return [];
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  const servers = j?.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
  return Object.entries(servers).filter(([, v]) => v && typeof v === 'object' && !v.disabled).map(([name, v]) => ({
    name, type: String(v.type || (v.url ? 'http' : 'stdio')), command: v.command ? String(v.command) : null,
    args: Array.isArray(v.args) ? v.args.map(String) : [], env: v.env && typeof v.env === 'object' ? v.env : {},
    url: v.url ? String(v.url) : null, headers: v.headers && typeof v.headers === 'object' ? v.headers : {},
  }));
}

/** The tool server names Codex's own config.toml already has (read only), so Apaki leaves those to it. */
export function codexMcpNames(file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')) {
  const text = readText(file);
  const names = new Set();
  if (!text) return names;
  for (const m of text.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.[^\]]*)?\]\s*$/gm)) names.add(m[1] || m[2]);
  return names;
}

/** The ledger server as Codex and Claude Code take it. */
export function ledgerServerSpec({ node, script, dir, rolloutRoots = [], claudeDir = claudeHome() }) {
  return { name: LEDGER_SERVER, command: node, args: [script], env: { APAKI_LEDGER_DIR: dir, APAKI_CLAUDE_DIR: claudeDir, APAKI_CODEX_ROLLOUTS: rolloutRoots.join(path.delimiter) } };
}

const envName = (server, key) => `APAKI_MCP_${server}_${key}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

/**
 * The -c overrides and process variables that give the Codex process the ledger server and the Claude side's servers.
 * @param {object} o
 * @param {object|null} o.ledger            ledgerServerSpec(), or null
 * @param {object[]} [o.servers]            claudeMcpServers()
 * @param {Set<string>} [o.codexNames]      codexMcpNames()
 * @param {object} [o.env]                  the environment the process starts from (to see a variable already set)
 * @returns {{ overrides: string[], env: object, servers: string[], skipped: { name: string, why: string }[] }}
 */
export function codexParity({ ledger = null, servers = null, codexNames = null, env = process.env, log = () => {} } = {}) {
  const overrides = [];
  const extraEnv = {};
  const added = [];
  const skipped = [];
  const put = (name, key, value) => overrides.push(`mcp_servers.${name}.${key}=${value}`);
  if (ledger) {
    put(LEDGER_SERVER, 'command', tomlString(ledger.command));
    put(LEDGER_SERVER, 'args', tomlList(ledger.args));
    put(LEDGER_SERVER, 'env', tomlTable(ledger.env));
    put(LEDGER_SERVER, 'startup_timeout_sec', '30');
    put(LEDGER_SERVER, 'tool_timeout_sec', '120');
    added.push(LEDGER_SERVER);
  }
  if (env.APAKI_CODEX_CLAUDE_MCP === '0') return { overrides, env: extraEnv, servers: added, skipped };
  const list = servers || claudeMcpServers(claudeJsonPath(env));
  const theirs = codexNames || codexMcpNames(path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'));
  for (const s of list) {
    if (RESERVED.has(s.name)) continue;
    if (!BARE_KEY.test(s.name)) { skipped.push({ name: s.name, why: 'its name needs quoting in a config key' }); continue; }
    if (theirs.has(s.name)) { skipped.push({ name: s.name, why: 'Codex has its own server by that name' }); continue; }
    // Secret values travel in the environment; Codex is given their names only. A variable another server already needs
    // with a different value cannot be passed twice under one name, so that server is left out.
    const clashes = (pairs) => pairs.some(([k, v]) => env[k] !== String(v) && extraEnv[k] !== undefined && extraEnv[k] !== String(v));
    const pass = (pairs) => { for (const [k, v] of pairs) if (env[k] !== String(v)) extraEnv[k] = String(v); return pairs.map(([k]) => k); };
    if (s.type === 'stdio' && s.command) {
      const pairs = Object.entries(s.env || {}).filter(([k]) => BARE_KEY.test(k));
      if (clashes(pairs)) { skipped.push({ name: s.name, why: 'a variable it needs has another value for another server' }); continue; }
      const names = pass(pairs);
      put(s.name, 'command', tomlString(s.command));
      if (s.args.length) put(s.name, 'args', tomlList(s.args));
      if (names.length) put(s.name, 'env_vars', tomlList(names));
      put(s.name, 'startup_timeout_sec', '30');
      added.push(s.name);
    } else if ((s.type === 'http' || s.type === 'streamable-http' || s.type === 'streamable_http') && s.url) {
      const pairs = Object.entries(s.headers || {}).map(([h, v]) => [envName(s.name, h), v, h]);
      pass(pairs);
      const headerVars = Object.fromEntries(pairs.map(([k, , h]) => [h, k]));
      put(s.name, 'url', tomlString(s.url));
      if (Object.keys(headerVars).length) put(s.name, 'env_http_headers', tomlTable(headerVars));
      put(s.name, 'startup_timeout_sec', '30');
      added.push(s.name);
    } else {
      skipped.push({ name: s.name, why: `Codex does not take ${s.type} servers` });
    }
  }
  if (skipped.length) log(`codex parity: left out ${skipped.map((x) => `${x.name} (${x.why})`).join(', ')}`);
  return { overrides, env: extraEnv, servers: added, skipped };
}

/* ---------- the user's working rules ---------- */

/**
 * The CLAUDE.md layers Claude Code would load for a folder, broadest first: the user's own (~/.claude/CLAUDE.md), then
 * every CLAUDE.md (and CLAUDE.local.md, .claude/CLAUDE.md) from the home folder, or the drive's top, down to the folder.
 */
export function claudeMdLayers(cwd, { claudeDir = claudeHome(), home = os.homedir() } = {}) {
  const files = [];
  const add = (f) => { if (f && !files.includes(f) && fs.existsSync(f)) files.push(f); };
  add(path.join(claudeDir, 'CLAUDE.md'));
  const target = path.resolve(cwd || home);
  const chain = [];
  for (let d = target; ; d = path.dirname(d)) {
    chain.unshift(d);
    if (path.dirname(d) === d) break;
  }
  const rel = path.relative(home, target);
  const underHome = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  for (const d of underHome ? chain.filter((x) => x.length >= path.resolve(home).length) : chain) {
    add(path.join(d, 'CLAUDE.md'));
    add(path.join(d, '.claude', 'CLAUDE.md'));
    add(path.join(d, 'CLAUDE.local.md'));
  }
  return files;
}

/**
 * A rules file in a compact form: headings, list items, table rows and bold lead lines, each cut to one line; prose,
 * comments, code blocks and blank lines left out. The full text stays one ledger call away.
 */
export function compactRules(text, maxChars = 7000) {
  const out = [];
  let inCode = false;
  for (const raw of String(text || '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode || !line.trim()) continue;
    if (/^\s*\|?\s*:?-{3,}/.test(line)) continue;
    if (/^#{1,6}\s/.test(line) || /^\s*([-*+]|\d+\.)\s/.test(line) || /^\s*\|/.test(line) || /^\s*\*\*[^*]+\*\*/.test(line)) {
      out.push(line.length > 260 ? `${line.slice(0, 259)}…` : line);
    }
  }
  let s = out.join('\n');
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}\n[... cut; ledger_instructions has the whole file]`;
  return s;
}

/** The developer instructions of a switched Codex thread: the user's rules in compact form (total budget in characters). */
export function workingRules(cwd, { claudeDir = claudeHome(), home = os.homedir(), budget = 16000 } = {}) {
  const layers = claudeMdLayers(cwd, { claudeDir, home });
  if (!layers.length) return '';
  const per = Math.max(2000, Math.floor(budget / layers.length));
  const parts = layers.map((f) => { const t = compactRules(readText(f), per); return t ? `### ${f}\n${t}` : ''; }).filter(Boolean);
  if (!parts.length) return '';
  return `The user's working rules from Claude Code (their CLAUDE.md files, broadest first, in a compact form; they apply to you as they did to Claude; the full text is in the apaki_ledger tool ledger_instructions):\n\n${parts.join('\n\n')}`;
}

/** The memory index Claude Code keeps for a folder (~/.claude/projects/<folder as a slug>/memory/MEMORY.md), or null. */
export function memoryIndex(cwd, { claudeDir = claudeHome() } = {}) {
  const slug = path.resolve(cwd || os.homedir()).replace(/[:\\/. ]/g, '-');
  const f = path.join(claudeDir, 'projects', slug, 'memory', 'MEMORY.md');
  return fs.existsSync(f) ? f : null;
}

/* ---------- skills ---------- */

/** The front matter fields name and description of a skill file. */
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) { const kv = /^(name|description):\s*(.*)$/.exec(line); if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim(); }
  return out;
}

/**
 * The user's Claude Code skills, read only: ~/.claude/skills/<name>.md and ~/.claude/skills/<name>/SKILL.md, then the
 * folder's own .claude/skills. [{ name, description, path, scope }]
 */
export function claudeSkills({ claudeDir = claudeHome(), cwd = null } = {}) {
  const out = [];
  const seen = new Set();
  const scan = (root, scope) => {
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      let file = null;
      let name = null;
      if (e.isFile() && e.name.endsWith('.md') && !/^readme\.md$/i.test(e.name)) { file = path.join(root, e.name); name = e.name.slice(0, -3); }
      else if (e.isDirectory() && fs.existsSync(path.join(root, e.name, 'SKILL.md'))) { file = path.join(root, e.name, 'SKILL.md'); name = e.name; }
      if (!file) continue;
      const fm = frontMatter(readText(file)?.slice(0, 4000));
      const key = `${scope}:${fm.name || name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: fm.name || name, description: (fm.description || '').slice(0, 300), path: file, scope });
    }
  };
  scan(path.join(claudeDir, 'skills'), 'user');
  if (cwd) scan(path.join(cwd, '.claude', 'skills'), 'project');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
