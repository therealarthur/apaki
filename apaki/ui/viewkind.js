/**
 * viewkind.js: which viewer draws an artifact, and the languages the code viewer knows.
 *
 * WHY (Arthur, 2026-10-13: viewer panes "literally exactly everything chatgpt's window could display"): a stored
 * artifact has a kind (html, markdown, svg, image, pdf, text, sheet, docx, chart), a file extension and, since this
 * change, an optional language hint from the show tool. viewOf() turns those into the viewer that draws it:
 *
 *   code      text with line numbers and syntax colours (highlight.js, loaded when a code viewer opens)
 *   table     CSV and TSV as a sortable, filterable table
 *   json      JSON: a table when it is an array of records, a collapsible tree otherwise
 *   sheet     XLSX, XLSM, XLSB and XLS workbooks: one table per sheet (SheetJS)
 *   docx      Word documents, read only (mammoth)
 *   chart     a chart spec (chartspec.js) drawn as SVG (chart.js)
 *   markdown, html, svg, image, pdf   as before
 *
 * Pure, no DOM: the engine imports it too (apaki/engine/artifacts.js stores a language hint as the file's extension,
 * so a download is "report.py", not "report.txt"). apaki/ui ships beside the engine in every package
 * (scripts/package-apaki-*.ps1 and package-apaki-mac.sh mirror it), which is what makes that import safe.
 */

/**
 * The languages: highlight.js grammar (vendor/highlight/languages/<grammar>.min.js), a label for the viewer's
 * header, the file extensions that mean it (the first is the one a hint stores), and other names a show call may use.
 */
export const LANGS = Object.freeze({
  javascript: { grammar: 'javascript', label: 'JavaScript', ext: ['js', 'mjs', 'cjs'], alias: ['js', 'node', 'mjs', 'cjs', 'ecmascript'] },
  jsx: { grammar: 'javascript', label: 'JSX', ext: ['jsx'], alias: [] },
  typescript: { grammar: 'typescript', label: 'TypeScript', ext: ['ts', 'mts', 'cts'], alias: ['ts'] },
  tsx: { grammar: 'typescript', label: 'TSX', ext: ['tsx'], alias: [] },
  python: { grammar: 'python', label: 'Python', ext: ['py', 'pyw', 'pyi'], alias: ['py', 'python3', 'py3'] },
  rust: { grammar: 'rust', label: 'Rust', ext: ['rs'], alias: ['rs'] },
  go: { grammar: 'go', label: 'Go', ext: ['go'], alias: ['golang'] },
  java: { grammar: 'java', label: 'Java', ext: ['java'], alias: [] },
  kotlin: { grammar: 'kotlin', label: 'Kotlin', ext: ['kt', 'kts'], alias: ['kt'] },
  swift: { grammar: 'swift', label: 'Swift', ext: ['swift'], alias: [] },
  c: { grammar: 'c', label: 'C', ext: ['c', 'h'], alias: [] },
  cpp: { grammar: 'cpp', label: 'C++', ext: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino'], alias: ['c++', 'cxx', 'cplusplus'] },
  csharp: { grammar: 'csharp', label: 'C#', ext: ['cs', 'csx'], alias: ['cs', 'c#'] },
  bash: { grammar: 'bash', label: 'Shell', ext: ['sh', 'bash', 'zsh', 'ksh'], alias: ['sh', 'shell', 'zsh', 'console', 'shellscript'] },
  powershell: { grammar: 'powershell', label: 'PowerShell', ext: ['ps1', 'psm1', 'psd1'], alias: ['ps1', 'ps', 'pwsh', 'posh'] },
  json: { grammar: 'json', label: 'JSON', ext: ['json', 'jsonc', 'json5', 'geojson', 'webmanifest'], alias: ['jsonc', 'json5'] },
  yaml: { grammar: 'yaml', label: 'YAML', ext: ['yaml', 'yml'], alias: ['yml'] },
  toml: { grammar: 'ini', label: 'TOML', ext: ['toml'], alias: [] },
  ini: { grammar: 'ini', label: 'INI', ext: ['ini', 'cfg', 'conf', 'properties', 'editorconfig'], alias: ['cfg', 'conf', 'properties'] },
  sql: { grammar: 'sql', label: 'SQL', ext: ['sql'], alias: ['psql', 'mysql', 'sqlite', 'postgres', 'postgresql', 'tsql', 'plsql'] },
  html: { grammar: 'xml', label: 'HTML', ext: ['html', 'htm', 'xhtml'], alias: ['htm', 'xhtml'] },
  xml: { grammar: 'xml', label: 'XML', ext: ['xml', 'xsd', 'xsl', 'xslt', 'plist', 'csproj', 'props', 'targets', 'resx'], alias: ['xsl', 'xslt', 'plist'] },
  css: { grammar: 'css', label: 'CSS', ext: ['css'], alias: [] },
  scss: { grammar: 'scss', label: 'SCSS', ext: ['scss', 'sass'], alias: ['sass'] },
  markdown: { grammar: 'markdown', label: 'Markdown', ext: ['md', 'markdown', 'mdx'], alias: ['md', 'mdx'] },
  diff: { grammar: 'diff', label: 'Diff', ext: ['diff', 'patch'], alias: ['patch'] },
  ruby: { grammar: 'ruby', label: 'Ruby', ext: ['rb', 'rake', 'gemspec'], alias: ['rb'] },
  php: { grammar: 'php', label: 'PHP', ext: ['php'], alias: [] },
  lua: { grammar: 'lua', label: 'Lua', ext: ['lua'], alias: [] },
  dockerfile: { grammar: 'dockerfile', label: 'Dockerfile', ext: ['dockerfile'], alias: ['docker'] },
  makefile: { grammar: 'makefile', label: 'Makefile', ext: ['mk', 'mak', 'make'], alias: ['make', 'mk'] },
  plaintext: { grammar: 'plaintext', label: 'Text', ext: ['txt', 'text', 'log', 'out'], alias: ['text', 'txt', 'plain', 'none', 'log'] },
  // Data: drawn as tables and trees, not as code (viewOf).
  csv: { grammar: null, label: 'CSV', ext: ['csv'], alias: [] },
  tsv: { grammar: null, label: 'TSV', ext: ['tsv', 'tab'], alias: ['tab'] },
  jsonl: { grammar: 'json', label: 'JSON Lines', ext: ['jsonl', 'ndjson'], alias: ['ndjson'] },
});

/** Every grammar the code viewer can load (vendor/highlight/languages/<name>.min.js). */
export const GRAMMARS = Object.freeze([...new Set(Object.values(LANGS).map((l) => l.grammar).filter(Boolean))].sort());

const BY_EXT = new Map();
const BY_NAME = new Map();
for (const [id, l] of Object.entries(LANGS)) {
  BY_NAME.set(id, id);
  for (const a of l.alias) if (!BY_NAME.has(a)) BY_NAME.set(a, id);
  for (const e of l.ext) if (!BY_EXT.has(e)) BY_EXT.set(e, id);
}

/** A language id from a name a show call used ("Python", "ts", "c++"), or null when it is not one Apaki knows. */
export function normLang(name) {
  const s = String(name ?? '').trim().toLowerCase().replace(/^\./, '');
  if (!s || s.length > 40) return null;
  return BY_NAME.get(s) || BY_EXT.get(s) || null;
}

/** The language a file extension means, or null. */
export function langOfExt(ext) {
  return BY_EXT.get(String(ext ?? '').toLowerCase()) || null;
}

/** The extension a language hint is stored with ("python" -> "py"), or null for a language Apaki does not know. */
export function extOfLang(name) {
  const id = normLang(name);
  return id ? LANGS[id].ext[0] : null;
}

/** File names that mean a language without an extension. */
const BY_FILE_NAME = { dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', 'cmakelists.txt': 'plaintext', '.gitignore': 'plaintext', '.env': 'ini' };

/** The language of a file name (its extension, or names like Dockerfile), or null. */
export function langOfName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().toLowerCase();
  if (BY_FILE_NAME[base]) return BY_FILE_NAME[base];
  const m = base.match(/\.([a-z0-9]{1,10})$/);
  return m ? langOfExt(m[1]) : null;
}

/** Stored kinds whose bytes are not text (sent to a viewer as base64). */
export const BINARY_KINDS = Object.freeze(['image', 'pdf', 'sheet', 'docx']);

/** Kinds a person may edit in the viewer (a new revision marked as theirs, apaki/engine/artifacts.js edit). */
export const EDITABLE_KINDS = Object.freeze(['markdown', 'text']);

/** Text kinds a "Changes" view can compare between revisions. */
export const DIFFABLE_KINDS = Object.freeze(['markdown', 'text', 'html', 'svg', 'chart']);

/**
 * The viewer for an artifact: { view, lang, grammar, label, delim?, wrap }.
 * art: { kind, ext, lang?, title? } (a record, an artifact event, or an artifactContent reply).
 */
export function viewOf(art = {}) {
  const kind = String(art.kind || '').toLowerCase();
  const ext = String(art.ext || '').toLowerCase();
  const out = (view, extra = {}) => ({ view, lang: null, grammar: null, label: '', wrap: false, ...extra });
  if (['html', 'markdown', 'svg', 'image', 'pdf', 'sheet', 'docx', 'chart'].includes(kind)) return out(kind, kind === 'markdown' ? { wrap: true } : {});
  // text (and anything older or unknown): the hint first, then the extension, then the title's name.
  const lang = normLang(art.lang) || langOfExt(ext) || langOfName(art.title) || null;
  if (lang === 'csv') return out('table', { lang, label: 'CSV', delim: ',' });
  if (lang === 'tsv') return out('table', { lang, label: 'TSV', delim: '\t' });
  if (lang === 'json' || lang === 'jsonl') return out('json', { lang, grammar: 'json', label: LANGS[lang].label, lines: lang === 'jsonl' });
  if (lang) {
    const l = LANGS[lang];
    return out('code', { lang, grammar: l.grammar, label: l.label, wrap: lang === 'plaintext' || lang === 'markdown' });
  }
  // A language Apaki has no grammar for still gets line numbers; its name is shown as the show call gave it.
  const named = String(art.lang || '').trim().slice(0, 24);
  return out('code', { lang: null, grammar: null, label: named || (ext && ext !== 'txt' ? ext.toUpperCase() : 'Text'), wrap: !named && (!ext || ext === 'txt') });
}

/** A file name for saving an artifact: its title made safe, ending in its extension. */
export function fileNameFor(art = {}) {
  const ext = String(art.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'txt';
  let base = String(art.title || art.id || 'artifact').trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!base) base = 'artifact';
  if (base.toLowerCase().endsWith(`.${ext}`)) return base;
  // "report.md" shown as text stays "report.md"; a title with another extension keeps it and gets the stored one.
  return `${base.replace(/\.+$/, '')}.${ext}`;
}
