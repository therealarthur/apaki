# package-apaki.ps1: builds the self-contained Myrlin Apaki package.
#
# WHY (Arthur, 2026-10-09): "make sure this is built and packaged in such a way
# where they're together". The installed app used to run its engine out of
# this repo with whatever Node was on PATH; moving or editing the repo changed
# or broke the app. The package carries everything it runs:
#
#   apaki\dist\Myrlin Apaki\
#     myrlin-apaki.exe          the window (UI embedded)
#     engine\                   the engine and latch together: apaki\engine,
#                               apaki\remote (phone access protocol),
#                               apaki\bin (the BROWSER shim),
#                               src\, bin\latch.js, package.json, node_modules\,
#                               index\target\release\latch-index.exe
#     node\node.exe             the Node runtime the engine and latch run on
#     bin\apaki.cmd             `apaki`  opens the app (or focuses it)
#     bin\latch.cmd             `latch`  the terminal app, same engine
#     bin\glass.cmd             `glass`  Myrlin Glass's CLI, when Glass is installed
#
# Then install with apaki\scripts\install-apaki.ps1.
# Usage: powershell -File apaki\scripts\package-apaki.ps1 [-SkipBuild]

param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dist = Join-Path $repo 'apaki\dist\Myrlin Apaki'
$engine = Join-Path $dist 'engine'

if (-not $SkipBuild) {
  cargo build --release --manifest-path (Join-Path $repo 'apaki\Cargo.toml')
  if ($LASTEXITCODE) { throw 'apaki build failed' }
  cargo build --release --manifest-path (Join-Path $repo 'index\Cargo.toml')
  if ($LASTEXITCODE) { throw 'latch-index build failed' }
}

$exe = Join-Path $repo 'apaki\target\release\myrlin-apaki.exe'
$index = Join-Path $repo 'index\target\release\latch-index.exe'
foreach ($f in @($exe, $index, (Join-Path $repo 'node_modules\@anthropic-ai\claude-agent-sdk\package.json'))) {
  if (-not (Test-Path $f)) { throw "missing: $f (build first, and npm install in the repo)" }
}

# Fresh staging folder every time, so nothing stale ships.
if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
New-Item -ItemType Directory -Force $dist, $engine, (Join-Path $dist 'node'), (Join-Path $dist 'bin') | Out-Null

Copy-Item $exe $dist
foreach ($f in 'package.json', 'package-lock.json') { Copy-Item (Join-Path $repo $f) $engine }
# Source folders skip build output and logs; node_modules is copied whole,
# since packages keep their code in folders named dist or target.
function Mirror($from, $to, [switch]$Whole) {
  if ($Whole) { robocopy $from $to /E /NFL /NDL /NJH /NJS /NP | Out-Null }
  else { robocopy $from $to /E /NFL /NDL /NJH /NJS /NP /XD .git target dist /XF *.log | Out-Null }
  if ($LASTEXITCODE -ge 8) { throw "copy failed: $from" }
}
Mirror (Join-Path $repo 'src') (Join-Path $engine 'src')
Mirror (Join-Path $repo 'bin') (Join-Path $engine 'bin')
Mirror (Join-Path $repo 'apaki\engine') (Join-Path $engine 'apaki\engine')
# Phone access (2026-10-09): the engine imports apaki\remote\protocol.js and wire.js.
Mirror (Join-Path $repo 'apaki\remote') (Join-Path $engine 'apaki\remote')
# The BROWSER shim the engine gives Claude Code (apaki-open.cmd + .mjs), so pages open inside Apaki.
Mirror (Join-Path $repo 'apaki\bin') (Join-Path $engine 'apaki\bin')
Mirror (Join-Path $repo 'node_modules') (Join-Path $engine 'node_modules') -Whole
New-Item -ItemType Directory -Force (Join-Path $engine 'index\target\release') | Out-Null
Copy-Item $index (Join-Path $engine 'index\target\release')

$node = (Get-Command node -ErrorAction Stop).Source
Copy-Item $node (Join-Path $dist 'node\node.exe')

$cmd = @{
  'apaki.cmd' = "@echo off`r`nrem apaki: opens Myrlin Apaki, or brings the open window forward.`r`nstart `"`" `"%~dp0..\myrlin-apaki.exe`" %*`r`n"
  'latch.cmd' = "@echo off`r`nrem latch: the terminal app on the same engine as Myrlin Apaki.`r`n`"%~dp0..\node\node.exe`" `"%~dp0..\engine\bin\latch.js`" %*`r`n"
  'glass.cmd' = "@echo off`r`nrem glass: Myrlin Glass's command line (accounts, usage, swaps).`r`nif not exist `"%LOCALAPPDATA%\Programs\Myrlin Glass\glass.exe`" (echo Myrlin Glass is not installed. & exit /b 1)`r`n`"%LOCALAPPDATA%\Programs\Myrlin Glass\glass.exe`" %*`r`n"
}
foreach ($k in $cmd.Keys) { [IO.File]::WriteAllText((Join-Path $dist "bin\$k"), $cmd[$k], [Text.Encoding]::ASCII) }

$commit = (git -C $repo rev-parse --short HEAD) 2>$null
$why = @"
# Myrlin Apaki

The installed Myrlin Apaki desktop app, packaged by apaki\scripts\package-apaki.ps1
from $repo (commit $commit) and copied here by apaki\scripts\install-apaki.ps1.
Created by Claude Code (Opus 5.5) for Arthur, 2026-10-09.

- myrlin-apaki.exe: the window. Starting it again focuses the open one.
- engine\: Apaki's engine and latch (the terminal app) with their node_modules
  and latch-index (the conversation search). A copy, not a link: the repo can
  move or change without breaking this. Re-run package + install to update.
- node\node.exe: the Node runtime the engine and latch run on.
- bin\: apaki, latch and glass commands; this folder is on your user PATH.
- voice\: the local Whisper model and whisper.cpp (installed separately, kept on update).

Myrlin Glass lives next door in ..\Myrlin Glass. Apaki follows it live: it watches
the login Glass writes (~\.claude\.credentials.json) and reads account labels from
glass status.

Runtime data (index, folders, locks, engine log) is in ~\.claude\latch, not here.
Safe to delete: yes, when the app is closed (delete voice\ only if you want the
model gone too). Also remove bin\ from the user PATH, the shortcuts, the App Paths
registry key HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\apaki.exe,
and the matching lines in ~\_AI_LEDGER.md.
"@
Set-Content -Path (Join-Path $dist '_WHY_THIS_IS_HERE.md') -Value $why -Encoding utf8
Set-Content -Path (Join-Path $engine '_WHY_THIS_IS_HERE.md') -Value "# engine`r`n`r`nApaki's engine and latch, copied from the repo with their node_modules and latch-index. Regenerated by package-apaki.ps1. See ../_WHY_THIS_IS_HERE.md" -Encoding utf8
Set-Content -Path (Join-Path $dist 'bin\_WHY_THIS_IS_HERE.md') -Value "# bin`r`n`r`nThe apaki, latch and glass commands. On the user PATH. See ../_WHY_THIS_IS_HERE.md" -Encoding utf8
Set-Content -Path (Join-Path $dist 'node\_WHY_THIS_IS_HERE.md') -Value "# node`r`n`r`nThe Node runtime ($(& $node -v)) the engine and latch run on. See ../_WHY_THIS_IS_HERE.md" -Encoding utf8

$size = [math]::Round(((Get-ChildItem -LiteralPath $dist -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB)
"packaged: $dist ($size MB, commit $commit)"
