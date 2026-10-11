/**
 * dts.mjs: a small reader for TypeScript declaration files (.d.ts), plain text
 * only, no TypeScript compiler (Arthur, 2026-10-11: "do not add dependencies").
 *
 * Why: the upstream parity tracker (apaki/parity/PARITY.md) needs the union
 * members, option keys, settings keys and hook events the Claude Agent SDK
 * declares in node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts. That file
 * is machine written (api-extractor rollup, json-schema-to-typescript), so one
 * declaration starts at column 0 and everything inside it is indented. This
 * reader leans on that and nothing else: it masks comments, splits top level
 * declarations, and reads object members, unions and intersections by
 * bracket depth.
 *
 * What it is not: a type checker. Generics, conditional types and mapped types
 * are skipped or kept as opaque text. Every function here is pure.
 */

/** Index just past the string literal that starts at src[i] (a quote character). */
export function skipString(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === q) return j + 1;
    j++;
  }
  return src.length;
}

/**
 * Blank out comments (same length, newlines kept) so offsets still line up with
 * the source, and list the comments so doc text can be recovered later.
 * Strings are skipped first, so "https://x" in a literal is not a comment.
 */
export function maskComments(src) {
  const out = src.split('');
  const comments = [];
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const close = src.indexOf('*/', i + 2);
      const e = close === -1 ? n : close + 2;
      comments.push({ start: i, end: e, text: src.slice(i + 2, Math.max(i + 2, e - 2)) });
      blank(i, e);
      i = e;
      continue;
    }
    if (c === '/' && d === '/') {
      let e = src.indexOf('\n', i);
      if (e === -1) e = n;
      comments.push({ start: i, end: e, text: src.slice(i + 2, e) });
      blank(i, e);
      i = e;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { i = skipString(src, i); continue; }
    i++;
  }
  return { masked: out.join(''), comments };
}

/**
 * Split masked[a,b) at depth zero on any character in seps. Depth counts
 * { [ ( and < >, with => not closing an angle bracket. Returns ranges.
 */
export function splitRanges(masked, a, b, seps) {
  const parts = [];
  let depth = 0;
  let start = a;
  for (let i = a; i < b; i++) {
    const c = masked[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(masked, i) - 1; continue; }
    if (c === '{' || c === '[' || c === '(' || c === '<') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === '>') { if (masked[i - 1] !== '=') depth--; }
    else if (depth === 0 && seps.includes(c)) { parts.push({ a: start, b: i }); start = i + 1; }
  }
  parts.push({ a: start, b });
  return parts;
}

/** Index of the bracket that closes the one at masked[open], or -1. */
export function matchClose(masked, open) {
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const stack = [pairs[masked[open]]];
  for (let i = open + 1; i < masked.length; i++) {
    const c = masked[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(masked, i) - 1; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === '}' || c === ']' || c === ')') {
      if (stack[stack.length - 1] === c) stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Collapse runs of whitespace to one space and trim. */
export const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The string literals of a pure literal union ("'a' | 'b' | null"), or null when it is anything else. */
export function literalUnion(typeText) {
  if (typeText == null) return null;
  const out = [];
  // split on top level bars only (a literal could in theory contain one)
  const parts = splitRanges(typeText, 0, typeText.length, '|').map((r) => typeText.slice(r.a, r.b));
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    let m;
    if ((m = /^'((?:[^'\\]|\\.)*)'$/.exec(part)) || (m = /^"((?:[^"\\]|\\.)*)"$/.exec(part))) { out.push(m[1]); continue; }
    if (part === 'null' || part === 'undefined') continue;
    if (part.startsWith('(') && part.endsWith(')')) {
      const inner = literalUnion(part.slice(1, -1));
      if (!inner) return null;
      out.push(...inner);
      continue;
    }
    return null;
  }
  return out.length ? out : null;
}

/** The string literals of a tuple body ("'a', 'b'"), or null when any element is not a literal. */
export function tupleLiterals(text) {
  const out = [];
  for (const r of splitRanges(text, 0, text.length, ',')) {
    const part = text.slice(r.a, r.b).trim();
    if (!part) continue;
    const m = /^'((?:[^'\\]|\\.)*)'$/.exec(part) || /^"((?:[^"\\]|\\.)*)"$/.exec(part);
    if (!m) return null;
    out.push(m[1]);
  }
  return out;
}

/**
 * Upstream text with dashes as plain hyphens: Arthur's rule is no em dashes in
 * anything written here, and snapshots quote upstream docs that use them.
 */
export function plainDashes(text) {
  // U+2014 and U+2015 (em dash, horizontal bar) become ' - '; U+2013 (en dash) becomes '-'. Written as code points so this file holds none.
  const long = new RegExp('\\s*[' + String.fromCharCode(0x2014, 0x2015) + ']\\s*', 'g');
  return String(text ?? '').replace(long, ' - ').replace(new RegExp(String.fromCharCode(0x2013), 'g'), '-');
}

/** Tidy a JSDoc block's text into one line. */
export function cleanDoc(raw) {
  return plainDashes(squash(String(raw).split('\n').map((l) => l.replace(/^\s*\*+ ?/, '')).join(' ')));
}

const DECL_RE = /^(export\s+)?(declare\s+)?(?:(?:abstract\s+)?(class)|(type)|(interface)|(const|let|var)|(function)|(enum)|(namespace|module))\s+([A-Za-z_$][\w$]*)/;

/**
 * A parsed declaration file. Build with new Dts(source); then ask for members
 * of a named declaration, the arms of a union, or all value exports.
 */
export class Dts {
  constructor(src) {
    this.src = src;
    const { masked, comments } = maskComments(src);
    this.masked = masked;
    this.comments = comments;
    this.decls = this.#splitDecls();
    /** name -> first declaration with that name (functions can repeat; see declsNamed). */
    this.byName = new Map();
    for (const d of this.decls) if (!this.byName.has(d.name)) this.byName.set(d.name, d);
  }

  #splitDecls() {
    const { masked } = this;
    const starts = [];
    let pos = 0;
    for (const line of masked.split('\n')) {
      if (line.length && !/\s/.test(line[0])) {
        const m = DECL_RE.exec(line);
        if (m) {
          const kind = m[3] ? 'class' : m[4] ? 'type' : m[5] ? 'interface' : m[6] ? 'const' : m[7] ? 'function' : m[8] ? 'enum' : 'namespace';
          starts.push({ pos, kind, name: m[10], exported: !!m[1] });
        } else if (/^(import|export)\b/.test(line)) starts.push({ pos, kind: 'other', name: '', exported: false });
      }
      pos += line.length + 1;
    }
    const decls = [];
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1].pos : masked.length;
      if (starts[i].kind !== 'other') decls.push({ ...starts[i], a: starts[i].pos, b: end });
    }
    return decls;
  }

  decl(name) { return this.byName.get(name); }

  declsNamed(name) { return this.decls.filter((d) => d.name === name); }

  /** The range of a type alias body (after =, before the final ;), or of an interface's braces. */
  bodyRange(d) {
    const { masked } = this;
    let a = d.a;
    let b = d.b;
    // trim trailing whitespace and one semicolon
    while (b > a && /\s/.test(masked[b - 1])) b--;
    if (masked[b - 1] === ';') b--;
    if (d.kind === 'type') {
      let depth = 0;
      for (let i = a; i < b; i++) {
        const c = masked[i];
        if (c === '<') depth++;
        else if (c === '>' && masked[i - 1] !== '=') depth--;
        else if (c === '=' && depth === 0 && masked[i + 1] !== '>') { a = i + 1; break; }
      }
      return { a, b };
    }
    if (d.kind === 'interface') {
      const open = masked.indexOf('{', a);
      return { a: open, b: b, open };
    }
    return { a, b };
  }

  text(r) { return this.masked.slice(r.a, r.b); }

  trim(r) {
    let { a, b } = r;
    while (a < b && /\s/.test(this.masked[a])) a++;
    while (b > a && /\s/.test(this.masked[b - 1])) b--;
    return { a, b };
  }

  /** Doc comment text directly above the member whose text starts at absolute offset pos. */
  docAt(pos) {
    const cs = this.comments;
    let lo = 0;
    let hi = cs.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cs[mid].end <= pos) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found === -1) return '';
    const c = cs[found];
    if (this.masked.slice(c.end, pos).trim() !== '') return '';
    if (!c.text.startsWith('*')) return '';
    return cleanDoc(c.text);
  }

  /** Object members of the {...} that opens at masked[open]. */
  objectMembers(open) {
    const close = matchClose(this.masked, open);
    const out = [];
    if (close === -1) return out;
    for (const rng of splitRanges(this.masked, open + 1, close, ';,')) {
      const r = this.trim(rng);
      if (r.a >= r.b) continue;
      const text = this.masked.slice(r.a, r.b);
      const doc = this.docAt(r.a);
      let m = /^(?:readonly\s+)?(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*))(\?)?\s*:\s*([\s\S]*)$/.exec(text);
      if (m) {
        out.push({ name: m[1] ?? m[2] ?? m[3], optional: !!m[4], type: squash(m[5]), doc, kind: 'prop' });
        continue;
      }
      m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*(?:<[\s\S]*?>)?\s*\(([\s\S]*)$/.exec(text);
      if (m) {
        out.push({ name: m[1], optional: !!m[2], type: squash(text.slice(m[1].length)), doc, kind: 'method' });
      }
      // index signatures and call signatures are not named surface; skipped
    }
    return out;
  }

  /**
   * Members (name -> {optional, type, doc}) of any type expression range:
   * an object literal, a reference to another declaration, an intersection
   * of those, or a union (a member missing from some arm becomes optional).
   */
  membersOf(range, seen = new Set()) {
    const r = this.trim(range);
    const arms =splitRanges(this.masked, r.a, r.b, '|').map((x) => this.trim(x)).filter((x) => x.a < x.b);
    if (arms.length > 1) {
      const maps = arms.map((x) => this.membersOf(x, new Set(seen)));
      const merged = new Map();
      for (const m of maps) {
        for (const [k, v] of m) {
          if (!merged.has(k)) merged.set(k, { ...v, optional: v.optional || maps.some((o) => !o.has(k)) });
          else if (v.optional) merged.get(k).optional = true;
        }
      }
      return merged;
    }
    const out = new Map();
    for (const part of splitRanges(this.masked, r.a, r.b, '&')) {
      const p = this.trim(part);
      if (p.a >= p.b) continue;
      const t = this.text(p);
      if (t.startsWith('{')) {
        for (const m of this.objectMembers(p.a)) out.set(m.name, m);
      } else if (/^[A-Za-z_$][\w$]*$/.test(t)) {
        for (const [k, v] of this.membersOfDecl(t, seen)) out.set(k, v);
      } else if (t.startsWith('(') && t.endsWith(')')) {
        for (const [k, v] of this.membersOf({ a: p.a + 1, b: p.b - 1 }, seen)) out.set(k, v);
      }
    }
    return out;
  }

  /** Members of a named type alias or interface (inheritance and intersections resolved). */
  membersOfDecl(name, seen = new Set()) {
    const d = this.decl(name);
    if (!d || seen.has(name) || (d.kind !== 'type' && d.kind !== 'interface')) return new Map();
    seen.add(name);
    const body = this.bodyRange(d);
    if (d.kind === 'type') return this.membersOf(body, seen);
    const out = new Map();
    const header = this.masked.slice(d.a, body.open);
    const ext = /\bextends\s+([\s\S]*)$/.exec(header);
    if (ext) {
      for (const part of splitRanges(ext[1], 0, ext[1].length, ',')) {
        const nm = /^[A-Za-z_$][\w$]*/.exec(ext[1].slice(part.a, part.b).trim());
        if (nm) for (const [k, v] of this.membersOfDecl(nm[0], seen)) out.set(k, v);
      }
    }
    for (const m of this.objectMembers(body.open)) out.set(m.name, m);
    return out;
  }

  /**
   * The leaf type names of a union alias, flattening nested union aliases
   * (SDKMessage -> ..., SDKResultMessage -> SDKResultSuccess | SDKResultError).
   */
  unionLeaves(name, seen = new Set()) {
    const d = this.decl(name);
    if (!d || d.kind !== 'type' || seen.has(name)) return [];
    seen.add(name);
    const body = this.bodyRange(d);
    const arms = splitRanges(this.masked, body.a, body.b, '|').map((x) => this.text(this.trim(x))).filter(Boolean);
    const out = [];
    for (const arm of arms) {
      const ref = this.decl(arm);
      if (/^[A-Za-z_$][\w$]*$/.test(arm) && ref && ref.kind === 'type' && this.isRefUnion(ref)) out.push(...this.unionLeaves(arm, seen));
      else out.push(arm);
    }
    return out;
  }

  /** True when a type alias is a union whose arms are all plain identifiers. */
  isRefUnion(d) {
    const body = this.bodyRange(d);
    const arms = splitRanges(this.masked, body.a, body.b, '|').map((x) => this.text(this.trim(x))).filter(Boolean);
    return arms.length > 1 && arms.every((x) => /^[A-Za-z_$][\w$]*$/.test(x));
  }

  /** Normalized body text of a type alias. */
  typeText(name) {
    const d = this.decl(name);
    if (!d) return null;
    return squash(this.text(this.bodyRange(d)));
  }

  /** String literals of a type alias that is a pure literal union (or the elements of a readonly tuple const). */
  literalsOf(name) {
    const d = this.decl(name);
    if (!d) return null;
    if (d.kind === 'type') return literalUnion(this.typeText(name));
    if (d.kind === 'const') {
      const text = this.text({ a: d.a, b: d.b });
      const m = /:\s*readonly\s*\[([\s\S]*)\]\s*;?\s*$/.exec(text);
      if (!m) return null;
      return tupleLiterals(m[1]);
    }
    return null;
  }
}
