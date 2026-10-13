/**
 * apaki-platform.test.js: the platform switches of the macOS port (2026-10-12), checked for every platform on any OS.
 *
 * src/platform.js takes the platform, environment, home folder and file checks as arguments, so a PC runs the Mac
 * branches (and a Mac the Windows ones) without opening or starting anything. The Windows answers must stay the exact
 * strings the engine used before the port.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appFolder, claudeTempRoot, glassCli, openCommand, openFolderCommand, revealCommand, signInCommand, terminalCommand, voiceDir, whisperName,
} from '../src/platform.js';
import { secretStoreFor } from '../apaki/engine/remote-store.js';

const WIN = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' }, home: 'C:\\Users\\A' };
const MAC = { platform: 'darwin', env: {}, home: '/Users/a' };

test('app folder: Windows keeps %LOCALAPPDATA%\\Programs, a Mac uses Application Support, Linux XDG', () => {
  assert.equal(appFolder('Myrlin Apaki', WIN), 'C:\\Users\\A\\AppData\\Local\\Programs\\Myrlin Apaki');
  assert.equal(appFolder('Myrlin Apaki', { ...WIN, env: {} }), 'C:\\Users\\A\\AppData\\Local\\Programs\\Myrlin Apaki', 'no LOCALAPPDATA: the usual place under the profile');
  assert.equal(appFolder('Myrlin Apaki', MAC), '/Users/a/Library/Application Support/Myrlin Apaki');
  assert.equal(appFolder('Myrlin Apaki', { platform: 'linux', env: {}, home: '/home/a' }), '/home/a/.local/share/Myrlin Apaki');
  assert.equal(appFolder('Myrlin Apaki', { platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home: '/home/a' }), '/data/Myrlin Apaki');
});

test('voice folder and whisper name per platform; APAKI_VOICE_DIR wins everywhere', () => {
  assert.equal(voiceDir(WIN), 'C:\\Users\\A\\AppData\\Local\\Programs\\Myrlin Apaki\\voice');
  assert.equal(voiceDir(MAC), '/Users/a/Library/Application Support/Myrlin Apaki/voice');
  assert.equal(voiceDir({ ...MAC, env: { APAKI_VOICE_DIR: '/v' } }), '/v');
  assert.equal(whisperName('win32'), 'whisper-cli.exe');
  assert.equal(whisperName('darwin'), 'whisper-cli');
});

test('Glass command line: the Windows path is unchanged; a Mac tries the usual places and falls back to the first; the env wins', () => {
  assert.equal(glassCli({ ...WIN, exists: () => false }), 'C:\\Users\\A\\AppData\\Local\\Programs\\Myrlin Glass\\glass.exe');
  assert.equal(glassCli({ ...MAC, exists: () => false }), '/Applications/Myrlin Glass.app/Contents/MacOS/glass');
  assert.equal(glassCli({ ...MAC, exists: (f) => f === '/opt/homebrew/bin/glass' }), '/opt/homebrew/bin/glass');
  assert.equal(glassCli({ ...MAC, exists: (f) => f.startsWith('/Users/a/Applications') }), '/Users/a/Applications/Myrlin Glass.app/Contents/MacOS/glass');
  assert.equal(glassCli({ ...MAC, env: { LATCH_GLASS_CLI: '/x/glass' }, exists: () => true }), '/x/glass');
});

test('Claude Code task output folder: <temp>\\claude on Windows, /tmp/claude-<uid> on a Mac (not $TMPDIR)', () => {
  assert.equal(claudeTempRoot({ platform: 'win32', tmpdir: 'C:\\Users\\A\\AppData\\Local\\Temp' }), 'C:\\Users\\A\\AppData\\Local\\Temp\\claude');
  assert.equal(claudeTempRoot({ platform: 'darwin', tmpdir: '/var/folders/sn/x/T', uid: 501 }), '/tmp/claude-501');
  assert.equal(claudeTempRoot({ platform: 'linux', tmpdir: '/tmp', uid: 1000 }), '/tmp/claude-1000');
});

test('open, open folder and reveal: Explorer on Windows, Finder (open -R) on a Mac, xdg-open elsewhere', () => {
  assert.deepEqual(openCommand('win32', 'https://a.b/c'), { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'https://a.b/c'] });
  assert.deepEqual(openCommand('darwin', 'https://a.b/c'), { cmd: 'open', args: ['https://a.b/c'] });
  assert.deepEqual(openCommand('linux', '/x'), { cmd: 'xdg-open', args: ['/x'] });
  assert.deepEqual(openFolderCommand('win32', 'C:\\w'), { cmd: 'explorer.exe', args: ['C:\\w'] });
  assert.deepEqual(openFolderCommand('darwin', '/w'), { cmd: 'open', args: ['/w'] });
  assert.deepEqual(revealCommand('win32', 'C:\\d\\a.md'), { cmd: 'explorer.exe', args: ['/select,C:\\d\\a.md'] });
  assert.deepEqual(revealCommand('darwin', '/Users/a/Downloads/a.md'), { cmd: 'open', args: ['-R', '/Users/a/Downloads/a.md'] });
  assert.deepEqual(revealCommand('linux', '/home/a/a.md'), { cmd: 'xdg-open', args: ['/home/a'] });
});

test('terminal: Windows Terminal with a console fallback; a Mac opens iTerm when installed, else Terminal; APAKI_TERMINAL_APP picks another', () => {
  const win = terminalCommand('win32', 'C:\\w');
  assert.equal(win.cmd, 'wt.exe');
  assert.deepEqual(win.args, ['-d', 'C:\\w']);
  assert.equal(win.fallback.cmd, 'cmd.exe');
  const none = () => false;
  assert.deepEqual(terminalCommand('darwin', '/w', { exists: none, env: {}, home: '/Users/a' }), { cmd: 'open', args: ['-a', 'Terminal', '/w'] });
  assert.deepEqual(terminalCommand('darwin', '/w', { exists: (f) => f === '/Applications/iTerm.app', env: {}, home: '/Users/a' }), { cmd: 'open', args: ['-a', 'iTerm', '/w'] });
  assert.deepEqual(terminalCommand('darwin', '/w', { exists: (f) => f === '/Users/a/Applications/iTerm.app', env: {}, home: '/Users/a' }), { cmd: 'open', args: ['-a', 'iTerm', '/w'] });
  assert.deepEqual(terminalCommand('darwin', '/w', { exists: () => true, env: { APAKI_TERMINAL_APP: 'Ghostty' }, home: '/Users/a' }), { cmd: 'open', args: ['-a', 'Ghostty', '/w'] });
  // A name that is not a plain app name is ignored (it goes to `open -a` as one argument, but nothing odd is passed on).
  assert.deepEqual(terminalCommand('darwin', '/w', { exists: none, env: { APAKI_TERMINAL_APP: '--evil; rm' }, home: '/Users/a' }), { cmd: 'open', args: ['-a', 'Terminal', '/w'] });
  assert.equal(terminalCommand('linux', '/w').cwd, '/w');
});

test('sign-in: a console window on Windows (same command line as before), a Terminal window on a Mac, a hint elsewhere', () => {
  const w = signInCommand('win32', 'C:\\x\\claude.exe', { comspec: 'C:\\Windows\\System32\\cmd.exe' });
  assert.equal(w.cmd, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(w.args, ['/d', '/s', '/c', '"start "Sign in to Claude" "C:\\x\\claude.exe" auth login"']);
  assert.equal(w.windowsVerbatimArguments, true);
  assert.equal(signInCommand('win32', 'C:\\x\\claude.exe', { consoleBilling: true }).args[3], '"start "Sign in to Claude" "C:\\x\\claude.exe" auth login --console"');
  const m = signInCommand('darwin', '/Applications/My Apps/claude', { consoleBilling: true });
  assert.equal(m.cmd, 'osascript');
  assert.ok(m.args.includes('do script "\'/Applications/My Apps/claude\' auth login --console"'), m.args.join(' | '));
  assert.equal(signInCommand('linux', '/x/claude'), null);
});

test('the secret store: DPAPI on Windows, the Keychain on a Mac, a user-only file elsewhere or when asked', () => {
  const yes = () => true;
  const no = () => false;
  assert.equal(secretStoreFor({ platform: 'win32', env: {}, exists: yes }), 'dpapi');
  assert.equal(secretStoreFor({ platform: 'win32', env: {}, exists: no }), 'file', 'no Windows PowerShell: a file');
  assert.equal(secretStoreFor({ platform: 'darwin', env: {}, exists: yes }), 'keychain');
  assert.equal(secretStoreFor({ platform: 'darwin', env: {}, exists: no }), 'file', 'no security tool: a file');
  assert.equal(secretStoreFor({ platform: 'linux', env: {}, exists: yes }), 'file');
  for (const platform of ['win32', 'darwin', 'linux']) assert.equal(secretStoreFor({ platform, env: { APAKI_REMOTE_PROTECT: 'file' }, exists: yes }), 'file', `${platform}: APAKI_REMOTE_PROTECT=file`);
});
