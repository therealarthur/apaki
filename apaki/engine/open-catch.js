/**
 * open-catch.js: spots shell commands whose purpose is to open a URL or a file
 * in the operating system (a browser tab, the default image or PDF viewer), so
 * Myrlin Apaki can show the thing inside the app instead.
 *
 * WHY (Arthur, 2026-10-09: artifacts like Codex has, out of the box): Claude
 * Code's habit when it wants the user to look at something is `start
 * index.html`, `Start-Process http://localhost:5173`, `explorer.exe chart.png`
 * or `python -m webbrowser ...`. Inside Apaki that throws a browser window
 * over the app and the user loses the conversation. A PreToolUse hook
 * (apaki-tools.js) runs every Bash and PowerShell command through
 * analyzeCommand() first and turns the open into an artifact or a link card.
 *
 * Pure functions, no I/O, so the true and false positives are unit tested
 * (test/apaki-open-catch.test.js). It must never catch work commands: npm
 * start, Start-Sleep, Start-Process of a program the user wants to run, git,
 * echo, headless browser screenshots.
 */

import path from 'node:path';

// Files worth showing in Apaki's viewer. Programs, scripts and Office files
// are left alone: opening those means running or editing them.
export const VIEWABLE_EXT = new Set(['html', 'htm', 'xhtml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'pdf', 'md', 'markdown', 'txt', 'log', 'csv', 'json']);
const BROWSER_RE = /^(chrome|google-chrome|google-chrome-stable|chromium|chromium-browser|msedge|microsoft-edge|firefox|brave|brave-browser|opera|iexplore|safari|vivaldi|arc)$/i;
// A browser started for these is a tool run (screenshots, PDFs, automation), not something to show.
const HEADLESS_RE = /^--?(headless|screenshot|print-to-pdf|dump-dom|remote-debugging-port|remote-debugging-pipe)/i;
const URL_RE = /^https?:\/\/[^\s"'<>]+$/i;
const FILE_URL_RE = /^file:\/\/\S+$/i;
const EDGE_URL_RE = /^microsoft-edge:(https?:\/\/\S+)$/i;
// Commands that only move around or print, so a command made of them and an
// open has nothing else worth running.
const TRIVIAL = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location', 'echo', 'write-host', 'write-output', 'sleep', 'start-sleep', 'true', ':']);
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);

/* ---------- splitting and tokens ---------- */

/**
 * Splits a command line into segments at unquoted &&, ||, ;, |, & and
 * newlines. Each segment keeps its exact text and the separator after it, so
 * joining text + sep gives the command back byte for byte (used to rewrite a
 * command without its open step). In PowerShell a lone & is the call
 * operator, not a separator; `2>&1` and `&>` are redirections either way.
 */
export function splitSegments(command, shell = 'bash') {
  const s = String(command || '');
  const out = [];
  let start = 0;
  let quote = null;
  const ps = shell === 'powershell';
  // Only bash escapes with a backslash; cmd and PowerShell keep it literal (Windows paths).
  const bs = shell === 'bash';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && ((c === '\\' && bs) || (c === '`' && ps)) && i + 1 < s.length) i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '`' && ps && i + 1 < s.length && s[i + 1] !== '\n') { i++; continue; }
    let sep = 0;
    if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) sep = 2;
    else if (c === ';' || c === '\n' || c === '|') sep = 1;
    else if (c === '&' && !ps && s[i - 1] !== '>' && s[i + 1] !== '>') sep = 1;
    if (!sep) continue;
    // Whitespace around a separator belongs to the separator.
    let a = i;
    while (a > start && /[ \t]/.test(s[a - 1])) a--;
    let b = i + sep;
    while (b < s.length && /[ \t\r]/.test(s[b])) b++;
    out.push({ text: s.slice(start, a), sep: s.slice(a, b), op: s.slice(i, i + sep) });
    start = b;
    i = b - 1;
  }
  out.push({ text: s.slice(start), sep: '', op: '' });
  return out;
}

/**
 * Splits one segment into words, removing quotes. Each word knows whether any
 * of it was quoted (cmd's `start "" file` treats a first quoted word as the
 * window title). Backslashes stay literal (Windows paths), except \" inside
 * double quotes in bash.
 */
export function tokenize(text, shell = 'bash') {
  const s = String(text || '');
  const words = [];
  let cur = null;
  const ps = shell === 'powershell';
  const bs = shell === 'bash';
  const push = () => { if (cur) words.push(cur); cur = null; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) { push(); continue; }
    if (!cur) cur = { v: '', q: false };
    if (c === '"' || c === "'") {
      cur.q = true;
      const close = s.indexOf(c, i + 1);
      let body;
      if (c === '"') {
        body = '';
        let j = i + 1;
        for (; j < s.length && s[j] !== '"'; j++) {
          if (((s[j] === '\\' && bs) || (s[j] === '`' && ps)) && (s[j + 1] === '"' || (ps && s[j + 1] === '`'))) { body += s[j + 1]; j++; } else body += s[j];
        }
        i = j;
      } else {
        body = close === -1 ? s.slice(i + 1) : s.slice(i + 1, close);
        i = close === -1 ? s.length : close;
      }
      cur.v += body;
      continue;
    }
    cur.v += c;
  }
  push();
  return words;
}

/* ---------- targets ---------- */

const baseName = (p) => String(p || '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
const extOf = (p) => { const m = String(p || '').replace(/[?#].*$/, '').match(/\.([A-Za-z0-9]+)$/); return m ? m[1].toLowerCase() : ''; };

/** Expands ~, $HOME, $env:X, %X% and Git Bash drive paths, then resolves against cwd. */
export function resolveLocal(p, { cwd = process.cwd(), home = '', env = {} } = {}) {
  let t = String(p || '');
  const look = (name) => env[name] ?? env[name.toUpperCase()] ?? Object.entries(env).find(([k]) => k.toUpperCase() === name.toUpperCase())?.[1] ?? '';
  if (home) t = t.replace(/^~(?=$|[\\/])/, home);
  t = t.replace(/\$\{(\w+)\}|\$env:(\w+)|\$(\w+)|%(\w+)%/gi, (m, a, b, c, d) => {
    const name = a || b || c || d;
    if (/^home$/i.test(name) && home) return home;
    return look(name) || m;
  });
  // Git Bash spells C:\x as /c/x.
  const drive = t.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (drive && process.platform === 'win32') t = `${drive[1].toUpperCase()}:${drive[2] || '/'}`;
  return path.resolve(cwd, t);
}

function fileUrlToPath(u) {
  let p = u.replace(/^file:\/\//i, '');
  try { p = decodeURIComponent(p); } catch { /* keep as is */ }
  // file:///C:/x -> C:/x ; file://host/share stays a UNC-ish path.
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return p;
}

/**
 * What a program would open: a web page, a viewable local file, or nothing.
 * `rest` are the words after it (a browser's arguments).
 */
function classify(target, rest, ctx, via) {
  if (!target) return null;
  const t = String(target).trim();
  if (!t || t.startsWith('-')) return null;
  const edge = t.match(EDGE_URL_RE);
  if (edge) return { kind: 'url', target: edge[1], raw: t, via };
  if (URL_RE.test(t)) return { kind: 'url', target: t, raw: t, via };
  if (FILE_URL_RE.test(t)) {
    const p = fileUrlToPath(t);
    return VIEWABLE_EXT.has(extOf(p)) ? { kind: 'file', target: resolveLocal(p, ctx), raw: t, via } : null;
  }
  if (BROWSER_RE.test(baseName(t))) {
    if (rest.some((w) => HEADLESS_RE.test(w))) return null;
    // --app=<url> opens the page in an app window: still a page to show.
    const words = rest.map((w) => String(w).replace(/^--app=/i, ''));
    const url = words.find((w) => URL_RE.test(w) || FILE_URL_RE.test(w) || EDGE_URL_RE.test(w) || (!w.startsWith('-') && VIEWABLE_EXT.has(extOf(w))));
    if (!url) return null;
    return classify(url, [], ctx, `${via} ${baseName(t)}`);
  }
  if (VIEWABLE_EXT.has(extOf(t)) && !/[*?<>|]/.test(t)) return { kind: 'file', target: resolveLocal(t, ctx), raw: t, via };
  return null;
}

/* ---------- the openers ---------- */

const CMD_START_FLAG = /^\/(b|i|min|max|wait|separate|shared|low|normal|high|realtime|abovenormal|belownormal|unix)$/i;
const CMD_START_VALUE = /^\/(d|node|affinity)$/i;

/** cmd's `start ["title"] [/flags] target [args]` (also Git Bash's `start` script). */
function cmdStart(args, ctx) {
  let i = 0;
  // A first quoted word is the window title when something follows it.
  if (args[0]?.q && args.length > 1) i = 1;
  while (i < args.length) {
    if (CMD_START_FLAG.test(args[i].v)) { i++; continue; }
    if (CMD_START_VALUE.test(args[i].v)) { i += 2; continue; }
    break;
  }
  const target = args[i]?.v;
  return classify(target, args.slice(i + 1).map((w) => w.v), ctx, 'start');
}

const SP_NO_VALUE = new Set(['wait', 'nonewwindow', 'passthru', 'loaduserprofile', 'usenewenvironment']);

/** PowerShell's Start-Process (and its aliases start, saps). */
function startProcess(args, ctx) {
  let file = null;
  let list = [];
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (!w.q && /^-[A-Za-z]/.test(w.v)) {
      const [rawName, inline] = w.v.slice(1).split(/:(.*)/s);
      const name = rawName.toLowerCase();
      const value = inline !== undefined && inline !== '' ? inline : null;
      if (SP_NO_VALUE.has(name)) continue;
      const take = () => (value !== null ? value : args[++i]?.v);
      if (/^(f|fi|fil|file|filep|filepa|filepat|filepath|path|pspath)$/.test(name)) file = take();
      else if (/^(a|ar|arg|args|argu|argum|argume|argumen|argument|argumentl|argumentli|argumentlis|argumentlist)$/.test(name)) list.push(...String(take() || '').split(/[,\s]+/).filter(Boolean));
      else take(); // -Verb, -WindowStyle, -WorkingDirectory, -Credential, -Redirect*
      continue;
    }
    positional.push(w.v);
  }
  if (!file) file = positional.shift();
  if (!list.length) list = positional.flatMap((x) => String(x).split(/[,\s]+/).filter(Boolean));
  return classify(file, list, ctx, 'Start-Process');
}

/** explorer.exe <url|file>; folders and /select are left alone. */
function explorer(args, ctx) {
  const t = args.find((w) => !w.v.startsWith('/'));
  if (!t) return null;
  const r = classify(t.v, [], ctx, 'explorer');
  return r && !BROWSER_RE.test(baseName(t.v)) ? r : null;
}

/** macOS open, xdg-open and friends: the first word that is not a flag. */
function openLike(args, ctx, via) {
  const words = args.map((w) => w.v);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '-R' || w === '--reveal') return null; // reveal in Finder, not a view
    if (w === '-a' || w === '-b' || w === '--args') { i++; continue; }
    if (w.startsWith('-')) continue;
    return classify(w, [], ctx, via);
  }
  return null;
}

// webbrowser.open('...'), open_new('...') and open_new_tab('...') inside python -c.
const PY_WEBBROWSER_RE = /\bwebbrowser\.(?:open|open_new|open_new_tab)\(\s*(?:url\s*=\s*)?(['"])(.+?)\1/;

/** python -m webbrowser [-n|-t] <url>, or python -c "import webbrowser; webbrowser.open('<url>')" */
function pythonWebbrowser(args, ctx) {
  const words = args.map((w) => w.v);
  const c = words.indexOf('-c');
  if (c !== -1 && words[c + 1]) {
    const hit = words[c + 1].match(PY_WEBBROWSER_RE);
    return hit ? classify(hit[2], [], ctx, 'python webbrowser.open') : null;
  }
  const m = words.indexOf('-m');
  if (m === -1 || words[m + 1] !== 'webbrowser') return null;
  const target = words.slice(m + 2).find((w) => !w.startsWith('-'));
  return classify(target, [], ctx, 'python -m webbrowser');
}

/** rundll32 url.dll,FileProtocolHandler <url> (and the shell32 variant). */
function rundll(args, ctx) {
  const entry = String(args[0]?.v || '').toLowerCase().replace(/\s+/g, '');
  if (!/^(url\.dll,(fileprotocolhandler|openurl)|url,(fileprotocolhandler|openurl)|shell32\.dll,shellexec_rundll)$/.test(entry)) return null;
  return classify(args[1]?.v, [], ctx, 'rundll32');
}

/** Invoke-Item / ii <file>: opens a file with its default program. */
function invokeItem(args, ctx) {
  let target = null;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (!w.q && /^-(path|literalpath|lp)$/i.test(w.v)) { target = args[i + 1]?.v; break; }
    if (!w.q && w.v.startsWith('-')) continue;
    target = w.v;
    break;
  }
  const r = classify(target, [], ctx, 'Invoke-Item');
  return r?.kind === 'file' ? r : null;
}

/* ---------- one segment ---------- */

const SEG_PREFIX = new Set(['sudo', 'exec', 'nohup', 'command', 'time']);

/**
 * Looks at one segment. Returns { match, inner, trivial, cd } where match is
 * the open it performs (or null), inner is set when a wrapper (cmd /c,
 * powershell -Command, bash -c) holds a whole command of its own, trivial says
 * it only moves around or prints, and cd is a directory change to apply to
 * later segments.
 */
function inspectSegment(text, shell, ctx, depth) {
  let words = tokenize(text, shell);
  // Leading VAR=value assignments, sudo, exec, and PowerShell's call operator.
  while (words.length && !words[0].q && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].v) || SEG_PREFIX.has(words[0].v))) words = words.slice(1);
  if (words.length && !words[0].q && (words[0].v === '&' || words[0].v === '.') && shell === 'powershell') words = words.slice(1);
  if (!words.length) return { match: null, trivial: true };
  const prog = baseName(words[0].v);
  const args = words.slice(1);
  const raw = String(text);

  // Wrappers that run a whole command line of their own.
  if (depth < 3) {
    if (prog === 'cmd') {
      const i = args.findIndex((w) => /^[/-]{1,2}[ck]$/i.test(w.v));
      if (i !== -1) {
        const rest = args.slice(i + 1);
        const inner = rest.length === 1 ? rest[0].v : rest.map((w) => (w.q && /\s/.test(w.v) ? `"${w.v}"` : w.v)).join(' ');
        return { inner: analyze(inner, { ...ctx, shell: 'cmd' }, depth + 1) };
      }
    }
    if (prog === 'powershell' || prog === 'pwsh') {
      const i = args.findIndex((w) => /^-(c|co|com|comm|comma|comman|command)$/i.test(w.v));
      if (i !== -1) {
        const rest = args.slice(i + 1);
        const inner = rest.length === 1 ? rest[0].v : rest.map((w) => (w.q && /\s/.test(w.v) ? `'${w.v}'` : w.v)).join(' ');
        return { inner: analyze(inner, { ...ctx, shell: 'powershell' }, depth + 1) };
      }
    }
    if ((prog === 'bash' || prog === 'sh' || prog === 'zsh') && args[0]?.v === '-c' && args[1]) {
      return { inner: analyze(args[1].v, { ...ctx, shell: 'bash' }, depth + 1) };
    }
  }

  // [System.Diagnostics.Process]::Start("https://...")
  const dotnet = raw.match(/\[(?:system\.)?diagnostics\.process\]::start\(\s*(['"])(.+?)\1/i);
  if (dotnet) return { match: classify(dotnet[2], [], ctx, 'Process.Start') };

  const ps = ctx.shell === 'powershell';
  let match = null;
  if (prog === 'start') match = ps ? startProcess(args, ctx) : cmdStart(args, ctx);
  else if (prog === 'start-process' || prog === 'saps') match = startProcess(args, ctx);
  else if (prog === 'explorer') match = explorer(args, ctx);
  else if (['open', 'xdg-open', 'wslview', 'sensible-browser', 'x-www-browser', 'gnome-open', 'kde-open', 'kde-open5'].includes(prog)) match = openLike(args, ctx, prog);
  else if (prog === 'gio' && args[0]?.v === 'open') match = openLike(args.slice(1), ctx, 'gio open');
  else if (/^(python|python3|py|pythonw)(\d+(\.\d+)?)?$/.test(prog)) match = pythonWebbrowser(args, ctx);
  else if (prog === 'rundll32') match = rundll(args, ctx);
  else if (prog === 'invoke-item' || prog === 'ii') match = invokeItem(args, ctx);
  else if (BROWSER_RE.test(prog)) match = classify(words[0].v, args.map((w) => w.v), ctx, 'browser');

  const cd = CD.has(prog) ? args.find((w) => !w.v.startsWith('-'))?.v || null : null;
  return { match, trivial: TRIVIAL.has(prog), cd };
}

/* ---------- whole commands ---------- */

function analyze(command, ctx, depth = 0) {
  const shell = ctx.shell || 'bash';
  const segments = splitSegments(command, shell);
  const matches = [];
  let cwd = ctx.cwd || process.cwd();
  let pure = true;
  let rewritable = true;
  let any = false;
  const parts = segments.map((seg, idx) => {
    const r = inspectSegment(seg.text, shell, { ...ctx, cwd }, depth);
    if (r.cd) cwd = resolveLocal(r.cd, { ...ctx, cwd });
    if (r.inner) {
      if (r.inner.matches.length) {
        any = true;
        matches.push(...r.inner.matches.map((m) => ({ ...m, segment: idx })));
        // An open buried in a wrapper with other work cannot be cut out cleanly.
        if (!r.inner.pure) { pure = false; rewritable = false; }
        return { ...seg, match: true };
      }
      pure = false;
      return { ...seg, match: false };
    }
    if (r.match) {
      any = true;
      matches.push({ ...r.match, segment: idx });
      return { ...seg, match: true };
    }
    if (!r.trivial && seg.text.trim()) pure = false;
    return { ...seg, match: false };
  });
  // A piped open (`... | start x`) cannot be cut out without changing the pipe.
  parts.forEach((p, i) => { if (p.match && (p.op === '|' || parts[i - 1]?.op === '|')) rewritable = false; });
  return { matches, segments: parts, pure: any && pure, rewritable, shell };
}

/**
 * The entry point. command: the Bash or PowerShell tool's command string.
 * Returns:
 *   matches   [{ kind: 'url'|'file', target, raw, via, segment }]: what it opens
 *   pure      true when the command does nothing but open (and cd or echo)
 *   rewritten the command with each open step replaced by a no-op, so the rest
 *             can still run (null when that is not safe, or nothing matched)
 */
export function analyzeCommand(command, { shell = 'bash', cwd = process.cwd(), home = '', env = {} } = {}) {
  const r = analyze(String(command || ''), { shell, cwd, home, env });
  let rewritten = null;
  if (r.matches.length && !r.pure && r.rewritable) {
    const noop = shell === 'powershell' ? '$null' : 'true';
    rewritten = r.segments.map((s) => (s.match ? `${s.text.match(/^\s*/)[0]}${noop}` : s.text) + s.sep).join('');
  }
  return { matches: r.matches, pure: r.pure, rewritten };
}
