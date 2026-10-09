/**
 * render.js
 *
 * Terminal rendering for streamed markdown. Text arrives in small deltas;
 * LineRenderer prints each line once it is complete, styled: headings, bullets,
 * quotes, rules, **bold**, *italic*, `code`, links, fenced code blocks, and
 * tables (held until the table ends, then printed as aligned columns).
 *
 * Adapted from the renderer in ~/.claude/hooks/prompt-relay.js (2026-10-09).
 * NO_COLOR or a non-TTY output turns styling off; the layout stays.
 */

const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function useColor(stream = process.stdout) {
  return Boolean(stream.isTTY) && !process.env.NO_COLOR;
}

export function styler(color) {
  const wrap = (open, close) => (s) => (color && s ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    bold: wrap(1, 22), dim: wrap(2, 22), italic: wrap(3, 23), under: wrap(4, 24),
    code: wrap(36, 39), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), magenta: wrap(35, 39), blue: wrap(34, 39),
  };
}

export function visibleLength(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Inline markdown: `code`, **bold**, __bold__, *italic*, [text](url). Code spans are left alone inside. */
export function renderInline(text, st) {
  return text.split(/(`[^`\n]+`)/).map((part) => {
    if (/^`[^`\n]+`$/.test(part)) return st.code(part.slice(1, -1));
    return part
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `${st.under(t)} ${st.dim(`(${u})`)}`)
      .replace(/\*\*([^*\n]+)\*\*/g, (_, t) => st.bold(t))
      .replace(/__([^_\n]+)__/g, (_, t) => st.bold(t))
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?=[^*\w]|$)/g, (_, pre, t) => pre + st.italic(t));
  }).join('');
}

/** A markdown table as aligned columns: bold header, a rule, then the rows. */
export function renderTable(rows, st) {
  const cells = rows
    .filter((r, i) => i !== 1 || !TABLE_SEP_RE.test(r))
    .map((r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => renderInline(c.trim(), st)));
  const widths = [];
  for (const row of cells) row.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, visibleLength(c)); });
  const line = (row) => row.map((c, i) => c + ' '.repeat(Math.max(0, widths[i] - visibleLength(c)))).join('   ').trimEnd();
  const total = widths.reduce((a, w) => a + w, 0) + 3 * Math.max(0, widths.length - 1);
  return [st.bold(line(cells[0])), st.dim('─'.repeat(total)), ...cells.slice(1).map(line)];
}

/** One complete non-table, non-code line. */
export function renderLine(line, st) {
  let m;
  if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
    const title = renderInline(m[2], st);
    return m[1].length <= 2 ? st.bold(st.under(title)) : st.bold(title);
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return st.dim('─'.repeat(40));
  if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) return `${m[1]}  • ${renderInline(m[2], st)}`;
  if ((m = line.match(/^(\s*)>\s?(.*)$/))) return `${m[1]}${st.dim('│')} ${renderInline(m[2], st)}`;
  return renderInline(line, st);
}

/**
 * Streams markdown to `write` line by line. push() takes deltas, end() flushes
 * the last partial line and any open table or code block.
 */
export class LineRenderer {
  constructor(write, { color = useColor(), indent = '' } = {}) {
    this.write = write;
    this.st = styler(color);
    this.indent = indent;
    this.buf = '';
    this.fence = null;
    this.table = [];
  }

  push(text) {
    this.buf += text;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this.line(line);
    }
  }

  end() {
    if (this.buf) {
      const rest = this.buf;
      this.buf = '';
      this.line(rest);
    }
    this.flushTable();
    this.fence = null;
  }

  out(s) {
    this.write(`${this.indent}${s}\n`);
  }

  flushTable() {
    if (!this.table.length) return;
    const rows = this.table;
    this.table = [];
    if (rows.length >= 2 && TABLE_SEP_RE.test(rows[1])) {
      for (const r of renderTable(rows, this.st)) this.out(r);
    } else {
      for (const r of rows) this.out(renderInline(r, this.st));
    }
  }

  line(line) {
    const st = this.st;
    if (this.fence) {
      if (line.trim().startsWith(this.fence)) { this.fence = null; return; }
      this.out(`  ${st.code(line)}`);
      return;
    }
    const fence = line.match(/^\s*(```|~~~)\s*(\S*)/);
    if (fence) {
      this.flushTable();
      this.fence = fence[1];
      if (fence[2]) this.out(st.dim(`  ${fence[2]}`));
      return;
    }
    if (/^\s*\|/.test(line)) { this.table.push(line); return; }
    this.flushTable();
    this.out(renderLine(line, st));
  }
}

/** Renders a whole markdown text at once (used for plans and non-streamed text). */
export function renderMarkdown(text, opts) {
  let out = '';
  const r = new LineRenderer((s) => { out += s; }, opts);
  r.push(text);
  r.end();
  return out;
}
