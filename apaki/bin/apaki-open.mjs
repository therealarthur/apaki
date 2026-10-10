#!/usr/bin/env node
/**
 * apaki-open.mjs: the browser Myrlin Apaki gives Claude Code (via BROWSER =
 * apaki-open.cmd, which runs this). Tools that honour BROWSER (Python's
 * webbrowser, vite --open, gh, jupyter...) call it with a URL; it hands the
 * URL to the running Apaki engine, which opens it inside Apaki, in the pane
 * whose Claude Code asked, instead of throwing a browser window over the app.
 *
 * WHY (Arthur, 2026-10-09: Claude inside Apaki shows things in Apaki, out of
 * the box): nothing is configured on the machine. The engine sets, per pane,
 * BROWSER (this shim), APAKI_OPEN_URL (http://127.0.0.1:<random port>/open),
 * APAKI_OPEN_TOKEN (that pane's random token) and APAKI_NODE in the Claude Code
 * process's environment only. No fixed port, nothing listening without a token.
 *
 * When Apaki cannot be reached (the engine restarted, the variables are
 * missing) the URL opens in the system browser as before, so a tool never
 * loses its page.
 *
 * Python starts BROWSER without quoting its argument, so cmd cuts a URL at
 * its first "&" and would run the rest as a command. apaki-open.cmd passes
 * cmd's own command line (APAKI_OPEN_CMDLINE) so the whole URL is recovered
 * here, and exits cmd outright (exit code 3 from here) so the rest never runs.
 */

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const URL_START = /^(https?|file):\/\//i;
export const HARD_EXIT = 3;

/**
 * The URL as the tool meant it: argUrl, extended with whatever cmd cut off
 * after it in the full command line (up to the next space or quote).
 */
export function fullUrl(argUrl, cmdline = '') {
  const u = String(argUrl || '').trim();
  if (!u || !cmdline) return u;
  const at = cmdline.indexOf(u);
  if (at === -1) return u;
  let end = at + u.length;
  while (end < cmdline.length && !/[\s"]/.test(cmdline[end])) end++;
  return cmdline.slice(at, end);
}

/** True when cmd was started just to run this shim (cmd /c ...), so `exit` ends only that cmd. */
export function startedByCmdC(cmdline = '') {
  return /apaki-open/i.test(cmdline) && /(^|\s)\/[cC](\s|")/.test(cmdline);
}

function systemOpen(url) {
  if (process.env.APAKI_OPEN_NO_FALLBACK) return;
  const [cmd, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* nothing else to try */ }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const cmdline = process.env.APAKI_OPEN_CMDLINE || '';
  const url = fullUrl(args.find((a) => URL_START.test(a)) || args[0] || '', cmdline);
  const done = (code) => process.exit(startedByCmdC(cmdline) ? HARD_EXIT : code);
  if (!URL_START.test(url)) { process.stderr.write(`apaki-open: not a URL: ${url}\n`); done(1); return; }
  const endpoint = process.env.APAKI_OPEN_URL;
  const token = process.env.APAKI_OPEN_TOKEN;
  if (endpoint && token) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-apaki-token': token },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(4000),
      });
      if (r.ok) { done(0); return; }
    } catch { /* fall back below */ }
  }
  systemOpen(url);
  done(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
