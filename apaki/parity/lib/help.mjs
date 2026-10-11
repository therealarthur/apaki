/**
 * help.mjs: read the "--help" text of a command line tool (commander style for
 * Claude Code, clap style for Codex) into flags and subcommands, for the
 * upstream parity tracker (apaki/parity/PARITY.md, 2026-10-11).
 *
 * Both tools print "Options:" and "Commands:" sections with the entry at two
 * spaces of indent and its description either on the same line (after two or
 * more spaces) or on following, deeper indented lines. Pure; no process is run
 * here (the extractors run the tool and pass the text in).
 */

/** The three kinds of things a help screen lists. */
const SECTION = /^([A-Za-z][A-Za-z ]*):\s*$/;

/** A string of help text -> { sections: { Options: [{spec, desc}], Commands: [...] } }. */
export function splitHelp(text) {
  const sections = {};
  let current = null;
  let entry = null;
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const sec = SECTION.exec(raw);
    if (sec && !raw.startsWith(' ')) { current = sec[1]; sections[current] = []; entry = null; continue; }
    if (!current) continue;
    if (!raw.trim()) continue; // clap separates entries and description paragraphs with blank lines
    if (!raw.startsWith(' ')) { current = null; entry = null; continue; }
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    // clap prints flags without a short form at indent 6 (aligned under "-c, "); commander prints every flag at 2
    const startsEntry = current === 'Options' ? indent <= 6 && /^-{1,2}[A-Za-z]/.test(trimmed) : indent === 2;
    if (startsEntry) {
      const m = /^\s*(\S.*?)(?:\s{2,}(.*))?$/.exec(raw);
      entry = { spec: m[1].trim(), desc: (m[2] || '').trim() };
      sections[current].push(entry);
    } else if (entry) {
      entry.desc = `${entry.desc} ${raw.trim()}`.trim();
    }
  }
  return sections;
}

/** "-c, --config <key=value>" -> { short, long, aliases, arg }. Null when it names no long flag. */
export function parseFlagSpec(spec) {
  const names = [];
  let arg = '';
  for (const piece of spec.split(/,\s*/)) {
    const m = /^(-{1,2}[A-Za-z0-9][\w-]*)(?:[\s=]+(.*))?$/.exec(piece.trim());
    if (!m) continue;
    names.push(m[1]);
    if (m[2]) arg = m[2].trim();
  }
  const longs = names.filter((n) => n.startsWith('--'));
  const shorts = names.filter((n) => !n.startsWith('--'));
  if (!longs.length) return null;
  return { long: longs[0], aliases: longs.slice(1), short: shorts[0] || undefined, arg: arg || undefined };
}

/** The choices a flag's description lists: (choices: "a", "b") -> ['a','b']. */
export function parseChoices(desc) {
  const m = /\(choices:\s*([^)]*)\)/.exec(desc);
  if (m) {
    const vals = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    return vals.length ? vals : undefined;
  }
  // clap: "[possible values: a, b, c]" or a "Possible values:" list of "- name: text" items
  const p = /\[possible values:\s*([^\]]*)\]/i.exec(desc);
  if (p) return p[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  const q = /Possible values:\s*(.*)$/i.exec(desc);
  if (q) {
    const vals = [...q[1].matchAll(/(?:^|\s)-\s+([A-Za-z0-9][\w-]*):/g)].map((x) => x[1]);
    return vals.length ? vals : undefined;
  }
  return undefined;
}

/** Flags of a help screen: [{ long, aliases, short, arg, choices }] in help order. */
export function parseFlags(text) {
  const { Options = [] } = splitHelp(text);
  const out = [];
  for (const o of Options) {
    const f = parseFlagSpec(o.spec);
    if (f) out.push({ ...f, choices: parseChoices(o.desc) });
  }
  return out;
}

/** Subcommands of a help screen: [{ name, aliases, args }]. Skips "help". */
export function parseCommands(text) {
  const { Commands = [] } = splitHelp(text);
  const out = [];
  for (const c of Commands) {
    const m = /^([A-Za-z0-9][\w|-]*)(?:\s+(.*))?$/.exec(c.spec);
    if (!m) continue;
    const names = m[1].split('|');
    const alias = /\[aliases?:\s*([^\]]+)\]/.exec(c.desc);
    const aliases = [...names.slice(1), ...(alias ? alias[1].split(/,\s*/) : [])].map((s) => s.trim()).filter(Boolean);
    if (names[0] === 'help') continue;
    out.push({ name: names[0], aliases, args: m[2] ? m[2].trim() : undefined });
  }
  return out;
}
