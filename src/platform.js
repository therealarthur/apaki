/**
 * platform.js: where Windows, macOS and Linux differ, as small pure functions.
 *
 * WHY (Arthur, 2026-10-12, "start working on the mac port"): the engine and
 * latch grew up on Windows. Each place that needs a platform switch used to
 * carry its own `process.platform === 'win32' ? ... : ...`; the macOS port
 * needs a handful of new answers (where the voice folder and Glass live, what
 * reveals a file, which terminal opens, where Claude Code keeps its task
 * output, how to start a sign-in), so they are gathered here with the
 * platform, environment and file checks passed in. Nothing here touches the
 * disk or starts a process unless the caller hands in `exists`; the tests in
 * test/apaki-platform.test.js run every branch on any OS.
 *
 * Windows answers are exactly what the code computed before (the same
 * strings), so moving a call site here changes nothing on Windows.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The path flavour of a platform, so a test on one OS can build another OS's paths. */
const flavour = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** The per-user folder an installed Myrlin app lives in (Apaki's voice\ sits inside it). */
export function appFolder(name, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const P = flavour(platform);
  if (platform === 'win32') return P.join(env.LOCALAPPDATA || P.join(home, 'AppData', 'Local'), 'Programs', name);
  if (platform === 'darwin') return P.join(home, 'Library', 'Application Support', name);
  return P.join(env.XDG_DATA_HOME || P.join(home, '.local', 'share'), name);
}

/** Where the local Whisper voice files go (bin/Release/whisper-cli, models/ggml-base.en.bin). APAKI_VOICE_DIR overrides. */
export function voiceDir(opts = {}) {
  const env = opts.env || process.env;
  if (env.APAKI_VOICE_DIR) return env.APAKI_VOICE_DIR;
  return flavour(opts.platform || process.platform).join(appFolder('Myrlin Apaki', opts), 'voice');
}

/** The whisper-cli file name on a platform. */
export const whisperName = (platform = process.platform) => (platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');

/**
 * The voice folder that ships inside a macOS app (macOS port phase 2, 2026-10-13): the packaged engine is
 * <app>/Contents/Resources/engine, and the signed whisper.cpp (Metal) sits beside it in <app>/Contents/Resources/voice
 * with the same bin/Release/whisper-cli layout the per-user voice folder has. null for anything that is not a packaged
 * app (a source checkout, the Windows package), so those keep looking only at voiceDir().
 */
export function bundledVoiceDir(engineRoot, { platform = process.platform } = {}) {
  if (platform !== 'darwin') return null;
  const P = path.posix;
  const resources = P.dirname(P.resolve(engineRoot));
  if (P.basename(resources) !== 'Resources' || P.basename(P.dirname(resources)) !== 'Contents') return null;
  return P.join(resources, 'voice');
}

/** The BROWSER shim in apaki/bin: a batch file on Windows, a shell script on macOS and Linux. */
export const openShimName = (platform = process.platform) => (platform === 'win32' ? 'apaki-open.cmd' : 'apaki-open');

/**
 * Where Myrlin Glass's command line is. LATCH_GLASS_CLI overrides. Windows has one place; on a Mac Glass is not a
 * Windows widget, so the usual app and command-line places are tried and the first that exists wins (none exists:
 * the first one, so a message can name it and "not installed" is the honest answer).
 */
export function glassCli({ platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.LATCH_GLASS_CLI) return env.LATCH_GLASS_CLI;
  const P = flavour(platform);
  if (platform === 'win32') return P.join(appFolder('Myrlin Glass', { platform, env, home }), 'glass.exe');
  const list = platform === 'darwin'
    ? ['/Applications/Myrlin Glass.app/Contents/MacOS/glass', P.join(home, 'Applications', 'Myrlin Glass.app', 'Contents', 'MacOS', 'glass'), '/opt/homebrew/bin/glass', '/usr/local/bin/glass']
    : [P.join(appFolder('Myrlin Glass', { platform, env, home }), 'glass'), '/usr/local/bin/glass'];
  return list.find((f) => exists(f)) || list[0];
}

/**
 * The folder Claude Code writes a session's shell and Monitor output to, below which come <project>/<session>/tasks.
 * Windows: <temp>\claude. macOS and Linux: /tmp/claude-<uid> (not $TMPDIR, which on a Mac is /var/folders/...; seen on
 * the Mac Mini, 2026-10-12).
 */
export function claudeTempRoot({ platform = process.platform, tmpdir = os.tmpdir(), uid = process.getuid?.() } = {}) {
  if (platform === 'win32') return path.win32.join(tmpdir, 'claude');
  return path.posix.join('/tmp', `claude-${uid ?? 0}`);
}

/* ---------- starting other programs ---------- */

/** Opens a web address or a file in the default app. */
export function openCommand(platform, target) {
  if (platform === 'win32') return { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] };
  if (platform === 'darwin') return { cmd: 'open', args: [target] };
  return { cmd: 'xdg-open', args: [target] };
}

/** Shows a folder in the file manager (Explorer, Finder, the desktop's default). */
export function openFolderCommand(platform, dir) {
  const cmd = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  return { cmd, args: [dir] };
}

/** Shows a file selected in its folder: Explorer /select, Finder's reveal (open -R), else its folder. */
export function revealCommand(platform, file) {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [`/select,${file}`] };
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', file] };
  return { cmd: 'xdg-open', args: [flavour(platform).dirname(file)] };
}

/** An app name that is safe to hand to `open -a` (letters, digits, space, dot, dash, underscore). */
const SAFE_APP = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$/;

/**
 * What opens a terminal in a folder. Windows: Windows Terminal, else a plain console window. macOS: iTerm when it is
 * installed, else Terminal (APAKI_TERMINAL_APP names another app, for example Warp or Ghostty). Linux: the desktop's
 * default. `exists` is how installed apps are found (a test passes its own).
 */
export function terminalCommand(platform, dir, { exists = fs.existsSync, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') return { cmd: 'wt.exe', args: ['-d', dir], fallback: { cmd: 'cmd.exe', args: ['/c', 'start', '', '/D', dir, 'cmd.exe'] } };
  if (platform === 'darwin') {
    const chosen = env.APAKI_TERMINAL_APP;
    let app = chosen && SAFE_APP.test(chosen) ? chosen : null;
    if (!app) app = ['/Applications', path.posix.join(home, 'Applications')].some((d) => exists(path.posix.join(d, 'iTerm.app'))) ? 'iTerm' : 'Terminal';
    return { cmd: 'open', args: ['-a', app, dir] };
  }
  return { cmd: 'x-terminal-emulator', args: [], cwd: dir };
}

/** AppleScript text literal: backslash and double quote escaped. */
const asString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** A POSIX shell word. */
const shWord = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** A PowerShell single-quoted string. */
const psWord = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * What opens a terminal window that RUNS a program in a folder (2026-10-13, Apaki's "Open in terminal": the exact
 * session in a terminal window). The same terminal terminalCommand picks: Windows Terminal (a new window with a title),
 * else PowerShell in a console window of its own; on macOS iTerm or Terminal (an AppleScript that runs the line; another
 * APAKI_TERMINAL_APP cannot be handed a command, so Terminal runs it); elsewhere the desktop's terminal with -e.
 * `file` and `args` are the program and its arguments, quoted here for the shell that runs them.
 * @returns {{ cmd, args, cwd?, fallback? }}
 */
export function terminalRunCommand(platform, { dir, title = 'Terminal', file, args = [] }, opts = {}) {
  if (platform === 'win32') {
    const ps = { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', `$Host.UI.RawUI.WindowTitle = ${psWord(title)}; & ${[file, ...args].map(psWord).join(' ')}`], cwd: dir };
    // Windows Terminal splits its command line at ';' (a new tab): such a line goes through PowerShell instead.
    if ([dir, title, file, ...args].some((a) => String(a).includes(';'))) return ps;
    return { cmd: 'wt.exe', args: ['-w', 'new', 'new-tab', '-d', dir, '--title', title, '--', file, ...args], fallback: ps };
  }
  const line = `cd ${shWord(dir)} && ${[file, ...args].map(shWord).join(' ')}`;
  if (platform === 'darwin') {
    const app = terminalCommand(platform, dir, opts).args[1];
    if (app === 'iTerm') {
      return { cmd: 'osascript', args: ['-e', 'tell application "iTerm"', '-e', 'activate', '-e', `create window with default profile command ${asString(`/bin/zsh -lc ${shWord(line)}`)}`, '-e', 'end tell'] };
    }
    return { cmd: 'osascript', args: ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script ${asString(line)}`, '-e', 'end tell'] };
  }
  return { cmd: 'x-terminal-emulator', args: ['-e', 'sh', '-c', line], cwd: dir };
}

/**
 * Runs `<claude> auth login` where the person can finish the browser sign-in. Windows: a console window of its own
 * (cmd start). macOS: a new Terminal window (AppleScript do script). Elsewhere: null, and the caller says what to run.
 * `bin` is Apaki's own Claude Code path (never user input), so quoting is for spaces only.
 */
export function signInCommand(platform, bin, { consoleBilling = false, comspec = 'cmd.exe' } = {}) {
  const tail = consoleBilling ? ' --console' : '';
  if (platform === 'win32') {
    return { cmd: comspec, args: ['/d', '/s', '/c', `"start "Sign in to Claude" "${bin}" auth login${tail}"`], windowsVerbatimArguments: true };
  }
  if (platform === 'darwin') {
    const line = `'${String(bin).replace(/'/g, `'\\''`)}' auth login${tail}`;
    return { cmd: 'osascript', args: ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script ${asString(line)}`, '-e', 'end tell'] };
  }
  return null;
}
