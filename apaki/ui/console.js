/**
 * console.js (window): a pane's console, its conversation in the real Claude Code or Codex terminal UI (2026-10-12).
 *
 * WHY (Arthur, 2026-10-12): "we want a toggle console that transitions a pane to console for either claude or codex
 * SEAMLESSLY like super cleanly, as if our ui was right on top of it. should be toggleable/reversable. should be the
 * authentic tui experience." The engine runs the TUI in a pseudo-terminal (apaki/engine/console.js); this draws it
 * with xterm.js inside the same pane frame and header, in Apaki's colours and Spline Sans Mono, and the conversation
 * view lifts off it (and settles back) in about 200 ms, without motion under prefers-reduced-motion.
 *
 * xterm.js is vendored (apaki/ui/vendor/xterm, no CDN) and loaded on first use, so a window that never opens a console
 * loads nothing, and the phone page (which has no vendor folder and cannot host a terminal) never asks for it.
 *
 * The pane owns one PaneConsole (pane.js); it speaks the engine's console ops (consoleOpen, consoleInput,
 * consoleResize, consoleClose) and draws its events (console, consoleData).
 */

/** Slash commands that only work in the TUI (keep in step with apaki/engine/console.js; a test compares them). */
export const CLAUDE_TUI_COMMANDS = Object.freeze([
  'config', 'settings', 'permissions', 'allowed-tools', 'mcp', 'agents', 'hooks', 'memory', 'login', 'logout', 'status',
  'doctor', 'ide', 'terminal-setup', 'theme', 'vim', 'statusline', 'plugin', 'plugins', 'help', 'usage', 'stats',
  'rewind', 'checkpoint', 'export', 'bashes', 'tasks', 'privacy-settings', 'install-github-app', 'upgrade',
  'release-notes', 'feedback', 'bug', 'output-style', 'keybindings', 'extra-usage', 'todos', 'add-dir', 'cost',
]);
export const CLAUDE_TUI_BARE = Object.freeze(['model', 'effort']);
export const CODEX_TUI_COMMANDS = Object.freeze([
  'experimental', 'skills', 'statusline', 'theme', 'personality', 'logout', 'apps', 'feedback', 'ps', 'debug-config',
  'setup-elevated-sandbox', 'agent', 'collab', 'rollout', 'settings',
]);
export const CODEX_TUI_BARE = Object.freeze(['model', 'approvals', 'permissions']);

/** The command to run in the console for what was typed in the pane ('/config', '/model' without a name...), or null. */
export function tuiCommand(kind, text) {
  const m = /^\/([A-Za-z][\w-]*)(?:\s+(.*))?$/s.exec(String(text || '').trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const arg = (m[2] || '').trim();
  const [always, bare] = kind === 'codex' ? [CODEX_TUI_COMMANDS, CODEX_TUI_BARE] : [CLAUDE_TUI_COMMANDS, CLAUDE_TUI_BARE];
  if (always.includes(name) || (!arg && bare.includes(name))) return `/${name}${arg ? ` ${arg}` : ''}`;
  return null;
}

/*
 * The 16 ANSI colours, drawn from Apaki's palette (app.css tokens) so a TUI's own colours sit in the app: ink, the
 * periwinkle brand, the peach action, the green good. Claude Code and Codex mostly use truecolor for their accents;
 * minimumContrastRatio below keeps those readable on either ground whichever theme the TUI itself is set to.
 */
export const ANSI = Object.freeze({
  light: {
    black: '#171717', red: '#C4453A', green: '#2E6B47', yellow: '#94650A', blue: '#5361C9', magenta: '#8A4FB8', cyan: '#1D7586', white: '#B7B9D3',
    brightBlack: '#63647D', brightRed: '#D2643F', brightGreen: '#3B8A5B', brightYellow: '#B07D12', brightBlue: '#6572D4', brightMagenta: '#A066CC', brightCyan: '#2A90A3', brightWhite: '#E6E8F9',
  },
  dark: {
    black: '#2D2C45', red: '#EE6F6F', green: '#74D3A0', yellow: '#E8C46A', blue: '#8E96DC', magenta: '#C69BE8', cyan: '#6CCFE0', white: '#B7B9D3',
    brightBlack: '#8D8FAD', brightRed: '#F4A383', brightGreen: '#9BE5BD', brightYellow: '#F2D98E', brightBlue: '#A3ABF2', brightMagenta: '#D9B8F2', brightCyan: '#9ADFEA', brightWhite: '#ECEDF8',
  },
});

/** xterm's theme for the window's current theme: Apaki's ink on a see-through ground (the pane's frosted layer shows). */
export function terminalTheme(mode = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', css = getComputedStyle(document.documentElement)) {
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const ground = v('--ground', mode === 'dark' ? '#121120' : '#FDFDFF');
  return {
    // The ground's colour at zero alpha: transparent, while contrast is still measured against the real ground.
    background: /^#[0-9a-f]{6}$/i.test(ground) ? `${ground}00` : 'rgba(0, 0, 0, 0)',
    foreground: v('--ink', mode === 'dark' ? '#ECEDF8' : '#171717'),
    cursor: v('--brand-strong', '#5361C9'),
    cursorAccent: ground,
    selectionBackground: mode === 'dark' ? 'rgba(142, 150, 220, 0.38)' : 'rgba(101, 114, 212, 0.24)',
    selectionInactiveBackground: mode === 'dark' ? 'rgba(142, 150, 220, 0.2)' : 'rgba(101, 114, 212, 0.12)',
    scrollbarSliderBackground: mode === 'dark' ? 'rgba(141, 143, 173, 0.25)' : 'rgba(99, 100, 125, 0.18)',
    scrollbarSliderHoverBackground: mode === 'dark' ? 'rgba(141, 143, 173, 0.4)' : 'rgba(99, 100, 125, 0.3)',
    scrollbarSliderActiveBackground: mode === 'dark' ? 'rgba(141, 143, 173, 0.5)' : 'rgba(99, 100, 125, 0.4)',
    ...ANSI[mode],
  };
}

/** The type scale's small step (app.css --fs-small), the size of code and tool lines in the conversation. */
function fontSize() {
  const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs-small'));
  return Number.isFinite(n) && n > 0 ? n : 13;
}

let lib = null;

/** xterm.js and its addons, loaded once, the first time a console opens (and its stylesheet with it). */
export function loadXterm() {
  if (lib) return lib;
  lib = (async () => {
    if (!document.querySelector('link[data-xterm]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      // Next to this module, whatever page loaded it.
      link.href = new URL('./vendor/xterm/xterm.css', import.meta.url).href;
      link.dataset.xterm = '';
      document.head.append(link);
    }
    const [x, fit, links, uni, gl] = await Promise.all([
      import('./vendor/xterm/xterm.js'), import('./vendor/xterm/addon-fit.js'), import('./vendor/xterm/addon-web-links.js'),
      import('./vendor/xterm/addon-unicode11.js'), import('./vendor/xterm/addon-webgl.js').catch(() => null),
    ]);
    // The cell size is measured from the font: it must be there first.
    await document.fonts.load(`${fontSize()}px "Spline Sans Mono"`).catch(() => {});
    return { Terminal: x.Terminal, FitAddon: fit.FitAddon, WebLinksAddon: links.WebLinksAddon, Unicode11Addon: uni.Unicode11Addon, WebglAddon: gl?.WebglAddon || null };
  })();
  lib.catch(() => { lib = null; });
  return lib;
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * One pane's console. `pane` is the Pane (pane.js): its element, send(op, args), host (openUrl), note(), kind.
 */
export class PaneConsole {
  constructor(pane) {
    this.pane = pane;
    /** 'off' | 'opening' | 'turn' | 'waiting' | 'starting' | 'running' | 'busy' | 'closing' */
    this.state = 'off';
    this.shown = false;
    this.term = null;
    this.fit = null;
    this.el = null;
    this.lastSeq = 0;
    this.queued = [];
    this.size = { cols: 0, rows: 0 };
    this.noteDismissed = false;
  }

  /** The console's layer in the pane, made the first time it is needed. */
  mount() {
    if (this.el) return this.el;
    const el = document.createElement('section');
    el.className = 'console';
    el.setAttribute('aria-label', 'Console');
    el.innerHTML = '<div class="console-bar" hidden></div><div class="console-term"></div>';
    this.pane.el.append(el);
    this.el = el;
    this.$bar = el.querySelector('.console-bar');
    this.$term = el.querySelector('.console-term');
    // A click anywhere on the layer types into the TUI.
    this.$term.addEventListener('pointerdown', () => queueMicrotask(() => this.term?.focus()));
    return el;
  }

  /** The xterm instance, made once per pane. Resolves with { cols, rows } that fit the pane. */
  async ensureTerm() {
    this.mount();
    if (this.term) return this.measure();
    const X = await loadXterm();
    const term = new X.Terminal({
      fontFamily: '"Spline Sans Mono", "Cascadia Mono", Consolas, "Segoe UI Symbol", monospace',
      fontSize: fontSize(),
      lineHeight: 1.18,
      fontWeight: 400,
      fontWeightBold: 600,
      cursorBlink: true,
      allowTransparency: true,
      allowProposedApi: true,
      minimumContrastRatio: 4.5,
      scrollback: 5000,
      drawBoldTextInBrightColors: false,
      rescaleOverlappingGlyphs: true,
      theme: terminalTheme(),
      // OSC 8 links (Claude Code prints some): web pages open in Apaki's browser, like the conversation's links.
      linkHandler: { activate: (e, uri) => this.openLink(uri), allowNonHttpProtocols: false },
    });
    this.fit = new X.FitAddon();
    term.loadAddon(this.fit);
    term.loadAddon(new X.WebLinksAddon((e, uri) => this.openLink(uri)));
    const uni = new X.Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = '11';
    term.open(this.$term);
    // The GPU renderer draws box lines and blocks itself, so the TUI's frames join up whatever the font has.
    if (X.WebglAddon) {
      try {
        const gl = new X.WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch { /* the DOM renderer is fine */ }
    }
    term.onData((data) => this.pane.send('consoleInput', { data }));
    term.onBinary((data) => this.pane.send('consoleInput', { data }));
    term.attachCustomKeyEventHandler((e) => this.key(e));
    // Ctrl+V with only a picture on the clipboard: the TUI reads the clipboard itself, with its own image paste key
    // (Claude Code on Windows: Alt+V, as its /help says; Codex: Ctrl+V).
    this.$term.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain');
      if (!text && e.clipboardData?.files?.length) { e.preventDefault(); this.pane.send('consoleInput', { data: this.pane.kind === 'codex' ? '\x16' : '\x1bv' }); }
    }, true);
    new ResizeObserver(() => this.refit()).observe(this.$term);
    // The window's theme changes (Settings, or Windows in auto): the terminal follows.
    new MutationObserver(() => { if (this.term) this.term.options.theme = terminalTheme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.term = term;
    return this.measure();
  }

  openLink(uri) {
    if (/^https?:\/\//i.test(String(uri || ''))) this.pane.host.openUrl?.(uri, this.pane);
  }

  /**
   * Keys the terminal does not take: Ctrl+` (back to Apaki's view) and Ctrl+Tab (tabs) reach the window's own
   * shortcuts; Ctrl+C with a selection (and Ctrl+Shift+C) copies, as Windows Terminal does; Ctrl+V and Ctrl+Shift+V
   * paste through the browser's paste, which xterm sends as a bracketed paste. Everything else goes to the TUI.
   */
  key(e) {
    if (e.type !== 'keydown') return true;
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (ctrl && (e.code === 'Backquote' || e.key === '`')) return false;
    if (ctrl && e.key === 'Tab') return false;
    if (ctrl && (e.key === 'c' || e.key === 'C') && (e.shiftKey || this.term?.hasSelection())) {
      const sel = this.term?.getSelection();
      if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
      this.term?.clearSelection();
      e.preventDefault();
      return false;
    }
    if (ctrl && (e.key === 'v' || e.key === 'V')) return false;
    return true;
  }

  /** Cells that fit the pane now. */
  measure() {
    try {
      const d = this.fit?.proposeDimensions();
      if (d && d.cols > 0 && d.rows > 0) return { cols: d.cols, rows: d.rows };
    } catch { /* not laid out yet */ }
    return { cols: this.term?.cols || 100, rows: this.term?.rows || 30 };
  }

  /** The pane changed size: the terminal fits it, and the TUI hears the new size. */
  refit() {
    if (!this.term || !this.shown) return;
    clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      try { this.fit.fit(); } catch { return; }
      const { cols, rows } = this.term;
      if (cols === this.size.cols && rows === this.size.rows) return;
      this.size = { cols, rows };
      if (this.state === 'running' || this.state === 'busy') this.pane.send('consoleResize', { cols, rows });
    }, 40);
  }

  /** Shows or hides the console layer: the conversation lifts off it, or settles back over it. */
  show(on, { instant = false } = {}) {
    this.mount();
    if (on === this.shown) return;
    this.shown = on;
    const el = this.pane.el;
    if (instant || reduced()) el.classList.add('console-instant');
    el.classList.toggle('console-on', on);
    this.pane.$.consoleBtn?.setAttribute('aria-pressed', String(on));
    if (instant || reduced()) requestAnimationFrame(() => el.classList.remove('console-instant'));
    if (on) {
      requestAnimationFrame(() => { this.refit(); this.term?.focus(); });
    } else {
      this.term?.blur();
      setTimeout(() => { if (!this.shown) this.pane.$.input?.focus(); }, 0);
    }
    this.pane.host.changed?.(this.pane);
  }

  /** A strip at the top of the console: what is happening, and the choices when there are some. */
  bar(text, actions = [], { tone = '' } = {}) {
    this.mount();
    if (!text) { this.$bar.hidden = true; this.$bar.innerHTML = ''; return; }
    this.$bar.hidden = false;
    this.$bar.className = `console-bar${tone ? ` ${tone}` : ''}`;
    this.$bar.innerHTML = `<span class="cb-text">${escHtml(text)}</span>${actions.map((a, i) => `<button class="cb-act${a.primary ? ' primary' : ''}" data-i="${i}">${escHtml(a.label)}</button>`).join('')}`;
    for (const b of this.$bar.querySelectorAll('button')) b.onclick = () => actions[Number(b.dataset.i)].run();
  }

  agent() { return this.pane.kind === 'codex' ? 'Codex' : 'Claude'; }

  /** Flip: Apaki's view to the console, or back. */
  toggle() {
    if (this.shown) this.close();
    else this.open();
  }

  /** Opens the console (command: a slash command to run in it, e.g. '/config'; wait or stop: what to do about a running turn). */
  async open({ command = null, wait = false, stop = false } = {}) {
    if (!this.pane.host.consoleAvailable?.()) {
      this.pane.note(`${command ? `${command} opens` : 'The console is'} ${this.agent() === 'Codex' ? 'Codex' : 'Claude Code'}'s own terminal UI, which runs on the PC. Open the conversation there and switch it to the console.`, 'warn');
      return;
    }
    // A pane that follows another pane's conversation (the shared view) has none of its own to open.
    if (this.pane.following) { this.pane.note('This pane shows another pane\'s conversation. Open the console in that pane.', 'warn'); return; }
    // Already showing: a command goes straight to the TUI.
    if (this.shown && this.state === 'running') { if (command) this.pane.send('consoleInput', { data: `${command}\r` }); this.term?.focus(); return; }
    this.state = 'opening';
    this.noteDismissed = false;
    this.show(true);
    this.bar(`Opening ${this.agent() === 'Codex' ? 'Codex' : 'Claude Code'} in the console${command ? ` for ${command}` : ''}…`);
    let dims;
    try {
      dims = await this.ensureTerm();
    } catch (e) {
      this.state = 'off';
      this.show(false);
      this.pane.note(`The console could not load: ${e.message || e}`, 'error');
      return;
    }
    this.pane.send('consoleOpen', { cols: dims.cols, rows: dims.rows, command, wait, stop });
  }

  /** Back to Apaki's view: the TUI quits (wait or stop: what to do about a turn running in it). */
  close({ wait = false, stop = false } = {}) {
    if (this.state === 'off' || this.state === 'opening' || this.state === 'turn' || (this.state === 'waiting' && !this.closingWait)) {
      // Not started yet: nothing to quit (a wait for the pane's turn is cancelled in the engine).
      if (this.state === 'waiting') this.pane.send('consoleClose', {});
      this.state = 'off';
      this.bar('');
      this.show(false);
      return;
    }
    this.pane.send('consoleClose', { wait, stop });
    if (this.state !== 'busy' || wait || stop) this.bar(wait ? `Waiting for ${this.agent()} to finish, then closing the console…` : 'Closing the console…');
  }

  /** The engine's console events for this pane. */
  handle(e) {
    const agent = this.agent();
    switch (e.state) {
      case 'turn':
        this.state = 'turn';
        this.show(true);
        this.bar(`${agent} is working on a turn in this pane. The console opens once it is idle.`, [
          { label: 'Wait for it', primary: true, run: () => { this.state = 'opening'; this.pane.send('consoleOpen', { ...this.measure(), command: e.command || null, wait: true }); } },
          { label: 'Stop it', run: () => { this.state = 'opening'; this.pane.send('consoleOpen', { ...this.measure(), command: e.command || null, stop: true }); } },
          { label: 'Cancel', run: () => this.close() },
        ]);
        break;
      case 'waiting':
        this.state = 'waiting';
        this.closingWait = Boolean(e.closing);
        this.bar(e.closing ? `Waiting for ${agent} to finish, then closing the console…` : e.stop ? `Stopping ${agent}'s turn…` : `Waiting for ${agent} to finish this turn…`, e.closing ? [] : [{ label: 'Cancel', run: () => this.close() }]);
        break;
      case 'starting':
        this.state = 'starting';
        this.bar(`Starting ${agent === 'Codex' ? 'Codex' : 'Claude Code'}…`);
        break;
      case 'running': {
        const was = this.state;
        this.state = 'running';
        if (!this.shown) this.show(true, { instant: Boolean(e.replay != null) });
        if (e.replay != null) {
          // A window that reloaded: the console's screen as it is now. Output that arrives meanwhile waits for it.
          this.replaying = true;
          this.ensureTerm().then(() => {
            this.term.reset();
            this.term.write(e.replay);
            this.lastSeq = e.seq || 0;
            this.replaying = false;
            for (const q of this.queued.splice(0)) if (q.seq > this.lastSeq) { this.term.write(q.data); this.lastSeq = q.seq; }
            this.size = { cols: 0, rows: 0 };
            this.refit();
          }).catch((err) => { this.replaying = false; this.pane.note(`The console could not load: ${err.message || err}`, 'error'); });
        } else if (e.fresh) {
          this.lastSeq = 0;
          this.queued = [];
          this.term?.reset();
          this.size = { cols: e.cols, rows: e.rows };
          this.refit();
        }
        this.cmdLine = e.display || '';
        if (e.note && !this.noteDismissed) this.bar(e.note, [{ label: 'Got it', run: () => { this.noteDismissed = true; this.bar(''); } }], { tone: e.tone === 'warn' ? 'warn' : '' });
        else this.bar('');
        if (was !== 'running') requestAnimationFrame(() => this.term?.focus());
        break;
      }
      case 'busy':
        this.state = 'busy';
        this.bar(`${agent} is working in the console. Going back now stops that turn.`, [
          { label: 'Wait for it', primary: true, run: () => this.close({ wait: true }) },
          { label: 'Stop it', run: () => this.close({ stop: true }) },
          { label: 'Stay here', run: () => { this.state = 'running'; this.bar(''); this.term?.focus(); } },
        ]);
        break;
      case 'closing':
        this.state = 'closing';
        this.bar('Closing the console…');
        break;
      case 'closed':
        this.state = 'off';
        this.bar('');
        this.show(false);
        if (e.note) this.pane.note(e.note, e.tone || '');
        if (e.forced) this.pane.note(`${agent === 'Codex' ? 'Codex' : 'Claude Code'} did not quit on its own, so Apaki ended it.`, 'warn');
        break;
      case 'error':
        this.state = 'off';
        this.bar('');
        this.show(false);
        this.pane.note(e.note || 'The console could not open.', e.tone || 'warn');
        break;
      default: break;
    }
  }

  /** The TUI's output. Pieces that a replay already contains are skipped. */
  data(e) {
    if (!this.term || this.replaying) { this.queued.push(e); if (this.queued.length > 2000) this.queued.shift(); return; }
    if (e.seq && e.seq <= this.lastSeq) return;
    this.term.write(e.data);
    this.lastSeq = e.seq || this.lastSeq;
  }

  destroy() {
    clearTimeout(this.fitTimer);
    try { this.term?.dispose(); } catch { /* gone */ }
    this.term = null;
  }
}
