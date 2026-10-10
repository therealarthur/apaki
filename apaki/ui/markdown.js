/**
 * markdown.js: a safe markdown renderer for Claude's replies.
 *
 * Everything is HTML-escaped first; only these constructs become markup:
 *   blocks  headings h1-h6, paragraphs (two trailing spaces or a backslash
 *           break a line), bullet / numbered / task lists nested by indent
 *           (numbered lists keep their start number), block quotes (multi
 *           line, nested markdown inside), fenced code with a language label
 *           and light syntax colouring, tables with column alignment, rules
 *   inline  `code`, **bold**, __bold__, *italic*, _italic_ (only at word
 *           edges, so snake_case stays), ***both***, ~~strike~~,
 *           [links](https://...), <https://...> and bare https:// links,
 *           backslash escapes
 *
 * Rewritten 2026-10-09 (Arthur: "i still see ** built this turn ... really
 * make sure we cover all formatting AND text color"). The old renderer split
 * a line at its code spans before looking for **, so bold text containing
 * `code` kept its asterisks. Code spans are now swapped for placeholders,
 * emphasis is matched across the whole line, and the code comes back last.
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Private-use characters never appear in replies, so they can't collide with text.
const PH_OPEN = '';
const PH_CLOSE = '';

const LINK_OK = /^(https?:\/\/|mailto:)/i;

/** Inline markdown for one block of text (already a single logical line). */
function inline(src) {
  const saved = [];
  const hold = (html) => `${PH_OPEN}${saved.push(html) - 1}${PH_CLOSE}`;
  let s = String(src);

  // Backslash escapes: the next punctuation character is literal.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, ch) => hold(esc(ch)));
  // Code spans (one or more backticks, matched by the same run).
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, code) => hold(`<code>${esc(code.replace(/^ (.*) $/, '$1'))}</code>`));
  // Links: [text](url "title"), then <url>, then bare URLs.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, text, url, title) => {
    if (!LINK_OK.test(url)) return m;
    return hold(`<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noreferrer">${inlineText(text)}</a>`);
  });
  s = s.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, (_, url) => hold(`<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_, pre, url) => `${pre}${hold(`<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)}</a>`)}`);

  s = esc(s);
  // Emphasis, longest markers first. Spans may contain held code and links.
  s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');

  // Put held pieces back (they may themselves hold placeholders, from link text).
  const back = (t) => t.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g'), (_, n) => back(saved[Number(n)]));
  return back(s);
}

/** Link text: inline markdown without nested links. */
function inlineText(text) {
  return inline(text.replace(/\[|\]/g, (c) => `\\${c}`));
}

/* ---------- syntax colouring for fenced code ---------- */

const KEYWORDS = {
  js: 'async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil',
  sh: 'if then else elif fi for while do done case esac in function return export local set unset echo cd exit',
  ps: 'if else elseif foreach for while do function param return switch try catch finally throw begin process end true false null',
  css: 'important',
  sql: 'select from where and or not insert into values update set delete create table index join left right inner outer on group by order having limit as null is in like distinct',
};
const LANG = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', cjs: 'js', json: 'json', jsonc: 'json',
  py: 'py', python: 'py', rs: 'rust', rust: 'rust', go: 'go', golang: 'go',
  sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', ps1: 'ps', powershell: 'ps', pwsh: 'ps',
  css: 'css', scss: 'css', html: 'html', xml: 'html', svg: 'html', sql: 'sql', yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml',
  c: 'js', cpp: 'js', 'c++': 'js', java: 'js', cs: 'js', csharp: 'js', kotlin: 'js', swift: 'js', php: 'js', rb: 'py', ruby: 'py',
};

/**
 * Colours code with a single left-to-right scan: comments, strings, numbers,
 * keywords, function calls. Every piece of text is escaped on its own.
 */
export function highlight(code, lang) {
  const kind = LANG[String(lang || '').toLowerCase()] || '';
  if (!kind) return esc(code);
  const span = (cls, t) => `<span class="tok-${cls}">${esc(t)}</span>`;
  if (kind === 'html') {
    return esc(code)
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-com">$1</span>')
      .replace(/(&lt;\/?)([\w:-]+)/g, '$1<span class="tok-key">$2</span>')
      .replace(/([\w:-]+)(=)(&quot;[^&]*?&quot;)/g, '<span class="tok-fn">$1</span>$2<span class="tok-str">$3</span>');
  }
  const words = new Set((KEYWORDS[kind] || '').split(' ').filter(Boolean));
  const lineCom = { js: '//', json: '//', rust: '//', go: '//', css: '', py: '#', sh: '#', ps: '#', yaml: '#', sql: '--' }[kind] ?? '//';
  const blockCom = ['js', 'json', 'rust', 'go', 'css'].includes(kind) ? ['/*', '*/'] : kind === 'ps' ? ['<#', '#>'] : null;
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const rest = code.slice(i);
    if (blockCom && rest.startsWith(blockCom[0])) {
      const end = code.indexOf(blockCom[1], i + blockCom[0].length);
      const stop = end < 0 ? n : end + blockCom[1].length;
      out += span('com', code.slice(i, stop)); i = stop; continue;
    }
    if (lineCom && rest.startsWith(lineCom)) {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += span('com', code.slice(i, stop)); i = stop; continue;
    }
    const q = code[i];
    if (q === '"' || q === "'" || (q === '`' && kind === 'js')) {
      let j = i + 1;
      while (j < n && code[j] !== q) { if (code[j] === '\\') j++; if (code[j] === '\n' && q !== '`') break; j++; }
      out += span('str', code.slice(i, Math.min(n, j + 1))); i = Math.min(n, j + 1); continue;
    }
    const num = rest.match(/^(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/);
    if (num && !/[\w$]/.test(code[i - 1] || '')) { out += span('num', num[0]); i += num[0].length; continue; }
    const word = rest.match(/^[A-Za-z_$][\w$]*/);
    if (word) {
      const w = word[0];
      const isKey = kind === 'sql' ? words.has(w.toLowerCase()) : words.has(w);
      if (isKey) out += span('key', w);
      else if (kind === 'yaml' && /^\s*:/.test(code.slice(i + w.length)) && /(^|\n)\s*$/.test(code.slice(0, i))) out += span('fn', w);
      else if (/^\s*\(/.test(code.slice(i + w.length))) out += span('fn', w);
      else if (kind === 'sh' && /(^|\n)\s*$/.test(code.slice(0, i))) out += span('fn', w);
      else out += esc(w);
      i += w.length; continue;
    }
    if (kind === 'sh' || kind === 'ps') {
      const v = rest.match(/^\$[\w:{}]+/);
      if (v) { out += span('var', v[0]); i += v[0].length; continue; }
    }
    out += esc(q); i++;
  }
  return out;
}

/* ---------- blocks ---------- */

const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
const indentOf = (line) => line.replace(/\t/g, '    ').match(/^ */)[0].length;

/** Renders a run of lines (a whole reply, a quote's inside, or a list item's body). */
function blocks(lines) {
  const out = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    // Two trailing spaces or a trailing backslash break the line; otherwise lines join.
    const html = para.map((l, k) => {
      const brk = k < para.length - 1 && (/ {2,}$/.test(l) || /\\$/.test(l));
      return inline(l.replace(/\\$/, '').trim()) + (brk ? '<br>' : '');
    }).join(' ').replace(/<br> /g, '<br>');
    out.push(`<p>${html}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(FENCE))) {
      flush();
      const fence = m[2];
      const lang = m[3];
      const pad = m[1].length;
      const body = [];
      for (i++; i < lines.length && !new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[i]); i++) body.push(lines[i].slice(Math.min(pad, indentOf(lines[i]))));
      const label = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
      out.push(`<pre class="code${lang ? ` lang-${esc(lang.toLowerCase())}` : ''}">${label}<code>${highlight(body.join('\n'), lang)}</code></pre>`);
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      const a = (k) => (align[k] ? ` style="text-align:${align[k]}"` : '');
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c, k) => `<th${a(k)}>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td${a(k)}>${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if (LIST_ITEM.test(line)) {
      flush();
      const consumed = list(lines, i);
      out.push(consumed.html);
      i = consumed.next - 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const inner = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { inner.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++; }
      i--;
      out.push(`<blockquote>${blocks(inner)}</blockquote>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * One list starting at lines[start], with nested lists for deeper indents.
 * Returns { html, next } (the index of the first line after the list).
 */
function list(lines, start) {
  const first = lines[start].match(LIST_ITEM);
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const startNo = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST_ITEM);
    if (!m || indentOf(m[1]) !== base || /\d/.test(m[2]) !== ordered) break;
    const body = [m[3]];
    const contentIndent = base + m[2].length + 1;
    i++;
    // The item's body: deeper-indented lines (nested lists, code, paragraphs)
    // and lazy continuation lines, up to the next sibling or a dedent.
    let blank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { blank = true; body.push(''); i++; continue; }
      const ind = indentOf(l);
      const sib = l.match(LIST_ITEM);
      if (ind < contentIndent && sib && indentOf(sib[1]) <= base) break;
      if (ind <= base && !sib && blank) break;
      if (ind <= base && /^\s*(#{1,6}\s|>|```|~~~|\|)/.test(l)) break;
      body.push(l.slice(Math.min(ind, contentIndent)));
      blank = false;
      i++;
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    let task = '';
    const t = body[0].match(/^\[([ xX])\]\s+(.*)$/);
    if (t) { task = t[1].trim() ? ' class="task done"' : ' class="task"'; body[0] = t[2]; }
    const box = task ? `<span class="tick" aria-hidden="true"></span>` : '';
    // A one-paragraph item renders inline; anything more as blocks.
    const simple = body.length === 1 || !body.slice(1).some((l) => l.trim());
    const inner = simple ? inline(body.join(' ')) : blocks(body).replace(/^<p>([\s\S]*?)<\/p>/, '$1');
    items.push(`<li${task}>${box}${inner}</li>`);
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNo !== 1 ? ` start="${startNo}"` : '';
  return { html: `<${tag}${startAttr}>${items.join('')}</${tag}>`, next: i };
}

export function md(src) {
  return blocks(String(src || '').replace(/\r/g, '').split('\n'));
}

export { esc, inline };
