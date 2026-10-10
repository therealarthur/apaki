/**
 * Tests for apaki/engine/open-catch.js: the matcher that spots shell commands
 * whose purpose is to open a URL or a viewable file in the operating system,
 * so Myrlin Apaki shows it inside the app instead. Both directions matter:
 * every common "open this" spelling must be caught, and work commands (npm
 * start, Start-Sleep, starting a program, git, headless browsers) never.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { analyzeCommand, splitSegments, tokenize } from '../apaki/engine/open-catch.js';

const CWD = path.resolve(process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj');
const HOME = path.resolve(process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me');
const bash = (cmd) => analyzeCommand(cmd, { shell: 'bash', cwd: CWD, home: HOME, env: { TEMP: path.join(HOME, 'tmp') } });
const pwsh = (cmd) => analyzeCommand(cmd, { shell: 'powershell', cwd: CWD, home: HOME, env: { TEMP: path.join(HOME, 'tmp') } });
const one = (r) => { assert.equal(r.matches.length, 1, `expected one match, got ${JSON.stringify(r.matches)}`); return r.matches[0]; };
const url = (r, u) => { const m = one(r); assert.equal(m.kind, 'url'); assert.equal(m.target, u); return m; };
const file = (r, p) => { const m = one(r); assert.equal(m.kind, 'file'); assert.equal(m.target, path.resolve(CWD, p)); return m; };
const none = (r, label = '') => assert.equal(r.matches.length, 0, `${label} should not match: ${JSON.stringify(r.matches)}`);

test('cmd start and Git Bash start open URLs and files', () => {
  url(bash('start https://example.com/a?b=1'), 'https://example.com/a?b=1');
  url(bash('start "" "http://localhost:5173/"'), 'http://localhost:5173/');
  url(bash('start /max http://localhost:3000'), 'http://localhost:3000');
  file(bash('start index.html'), 'index.html');
  file(bash('start "" report.pdf'), 'report.pdf');
  file(bash('start chart.png'), 'chart.png');
  url(bash('cmd /c start http://localhost:8080'), 'http://localhost:8080');
  url(bash('cmd.exe /c "start "" http://127.0.0.1:9000/x"'), 'http://127.0.0.1:9000/x');
  url(bash('start chrome http://localhost:4000'), 'http://localhost:4000');
  url(bash('start microsoft-edge:https://example.com'), 'https://example.com');
});

test('PowerShell Start-Process, its aliases, Invoke-Item and Process.Start', () => {
  url(pwsh('Start-Process "http://localhost:5173"'), 'http://localhost:5173');
  url(pwsh('Start-Process -FilePath https://example.com'), 'https://example.com');
  url(pwsh('start http://localhost:3000'), 'http://localhost:3000');
  url(pwsh('saps https://example.com'), 'https://example.com');
  file(pwsh('Start-Process .\\dist\\index.html'), 'dist/index.html');
  file(pwsh('Start-Process ./report.html -Verb open'), 'report.html');
  url(pwsh('Start-Process chrome -ArgumentList "http://localhost:3000"'), 'http://localhost:3000');
  url(pwsh('Start-Process msedge http://localhost:3000'), 'http://localhost:3000');
  file(pwsh('Invoke-Item .\\out\\chart.svg'), 'out/chart.svg');
  file(pwsh('ii notes.md'), 'notes.md');
  url(pwsh('[System.Diagnostics.Process]::Start("https://example.com")'), 'https://example.com');
  url(pwsh('& "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "https://example.com"'), 'https://example.com');
  url(bash('powershell -NoProfile -Command "Start-Process http://localhost:5173"'), 'http://localhost:5173');
  url(bash('pwsh -c start https://example.com'), 'https://example.com');
});

test('explorer, open, xdg-open, python webbrowser and rundll32', () => {
  url(bash('explorer https://example.com'), 'https://example.com');
  file(bash('explorer.exe report.html'), 'report.html');
  url(bash('open https://example.com'), 'https://example.com');
  url(bash('open -a Safari http://localhost:3000'), 'http://localhost:3000');
  file(bash('xdg-open ./chart.png'), 'chart.png');
  url(bash('wslview https://example.com'), 'https://example.com');
  url(bash('python -m webbrowser https://example.com'), 'https://example.com');
  url(bash('python3 -m webbrowser -t "http://localhost:8000"'), 'http://localhost:8000');
  url(bash('py -m webbrowser http://localhost:8000'), 'http://localhost:8000');
  url(bash(`python -c "import webbrowser; webbrowser.open('http://localhost:8888/tree')"`), 'http://localhost:8888/tree');
  url(bash('rundll32 url.dll,FileProtocolHandler https://example.com'), 'https://example.com');
  url(bash('firefox http://localhost:3000'), 'http://localhost:3000');
  url(bash('msedge --app=http://localhost:3000'), 'http://localhost:3000');
});

test('file targets resolve against cd, ~, $HOME, %VAR% and file:// URLs', () => {
  const m = one(bash('cd dist && start index.html'));
  assert.equal(m.target, path.resolve(CWD, 'dist', 'index.html'));
  assert.equal(one(bash('start ~/notes.md')).target, path.join(HOME, 'notes.md'));
  assert.equal(one(pwsh('Start-Process "$env:TEMP\\x.html"')).target, path.join(HOME, 'tmp', 'x.html'));
  assert.equal(one(bash('cmd /c start %TEMP%\\y.png')).target, path.join(HOME, 'tmp', 'y.png'));
  const f = one(bash('start file:///C:/site/index.html'));
  assert.equal(f.kind, 'file');
  assert.match(f.target, /site[\\/]index\.html$/);
});

test('work commands are never caught', () => {
  const work = [
    'npm start', 'npm run start', 'yarn start', 'pnpm start', 'npm run dev', 'npx vite --open',
    'git status', 'git log --oneline -5', 'git commit -m "start index.html later"',
    'echo https://example.com', 'curl -s http://localhost:3000/health', 'wget https://example.com/file.zip',
    'cat index.html', 'ls *.html', 'node server.js', 'python -m http.server 8000', 'python -c "print(1)"',
    'start /b node server.js', 'start "" "C:\\tools\\app.exe"', 'start cmd', 'start .', 'start myapp.exe --flag',
    'explorer .', 'explorer /select,report.html', 'open .', 'open -R report.html',
    'chrome --headless --screenshot=out.png http://localhost:3000', 'msedge --headless --print-to-pdf=a.pdf https://example.com',
    'firefox --headless http://localhost:3000', 'code index.html', 'notepad notes.txt',
    'grep -r "start http" .', 'rg "Start-Process" src', 'docker start web', 'systemctl start nginx',
    'rundll32 shell32.dll,Control_RunDLL', 'python -m webbrowser',
  ];
  for (const c of work) none(bash(c), c);
  const psWork = [
    'Start-Sleep -Seconds 2', 'Start-Sleep 5', 'Start-Process node -ArgumentList server.js',
    'Start-Process -FilePath "notepad.exe" -ArgumentList "a.txt"', 'Start-Process powershell -Verb RunAs',
    'Start-Process "C:\\Program Files\\App\\app.exe"', 'Start-Process msedge -ArgumentList "--headless", "--screenshot", "http://x"',
    'Start-Job { npm run dev }', 'Start-Service spooler', 'Get-Content index.html', 'Invoke-Item .',
    'Invoke-WebRequest https://example.com', 'Write-Host "start http://localhost"', 'git push',
  ];
  for (const c of psWork) none(pwsh(c), c);
});

test('pure opens are recognised; mixed commands are rewritten without the open', () => {
  assert.equal(bash('start http://localhost:5173').pure, true);
  assert.equal(bash('cd dist && start index.html').pure, true);
  assert.equal(pwsh('Start-Sleep 1; Start-Process http://localhost:5173').pure, true);
  assert.equal(bash('start http://localhost:5173').rewritten, null);

  const r = bash('npm run build && start dist/index.html');
  assert.equal(r.pure, false);
  assert.equal(r.rewritten, 'npm run build && true');
  const p = pwsh('npm run build; Start-Process http://localhost:4173; echo done');
  assert.equal(p.rewritten, 'npm run build; $null; echo done');
  // An open inside a pipe cannot be cut out cleanly.
  assert.equal(bash('echo x | xdg-open https://example.com').rewritten, null);
  // A wrapper that does other work too: caught, but not rewritable.
  const w = bash('cmd /c "npm run build && start dist\\index.html"');
  assert.equal(w.matches.length, 1);
  assert.equal(w.pure, false);
  assert.equal(w.rewritten, null);
});

test('splitting keeps quotes, redirections and the PowerShell call operator', () => {
  assert.deepEqual(splitSegments('a && b; c', 'bash').map((s) => s.text), ['a', 'b', 'c']);
  assert.deepEqual(splitSegments('echo "a && b" && c', 'bash').map((s) => s.text), ['echo "a && b"', 'c']);
  assert.deepEqual(splitSegments('cmd 2>&1 && x', 'bash').map((s) => s.text), ['cmd 2>&1', 'x']);
  assert.deepEqual(splitSegments('& "C:\\a b\\c.exe" x; y', 'powershell').map((s) => s.text), ['& "C:\\a b\\c.exe" x', 'y']);
  // Joining text + sep gives the command back byte for byte.
  const cmd = 'npm run build  &&  start x.html ; echo ok';
  assert.equal(splitSegments(cmd, 'bash').map((s) => s.text + s.sep).join(''), cmd);
  // cmd keeps backslashes before a closing quote.
  assert.deepEqual(tokenize('start "" "C:\\dir\\"', 'cmd').map((w) => w.v), ['start', '', 'C:\\dir\\']);
  assert.deepEqual(tokenize('echo "a \\"b\\""', 'bash').map((w) => w.v), ['echo', 'a "b"']);
});
