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
#                               index\target\release\latch-index.exe,
#                               hooks\prompt-relay.js (latch --relay's hook)
#     node\node.exe             the Node runtime the engine and latch run on
#     bin\apaki.cmd             `apaki`  opens the app (or focuses it)
#     bin\latch.cmd             `latch`  the terminal app, same engine
#     bin\glass.cmd             `glass`  Myrlin Glass's CLI, when Glass is installed
#     install-apaki.ps1         the installer, so the package installs on a PC
#     Install Myrlin Apaki.cmd  without this repo (double-click it)
#     setup\glass\              Myrlin Glass (widget + CLI), installed next door
#                               when the PC has no Glass yet
#     setup\voice\              whisper.cpp and the English model for the mic
#
# WHY the additions (Arthur, 2026-10-10): "its incredibly important that
# everything works out of the box on install, the app, glass, being able to do
# the relay, etc - are there additional services that need to be isntalled? if
# so they need to be packaged with this app". A fresh-PC audit found the
# package needed the repo to install, had no Glass, no voice, and binaries that
# need the Visual C++ runtime (latch-index, Glass, whisper), which a clean
# Windows does not have. The runtime DLLs ship next to those exes (Microsoft's
# app-local deployment), Glass and voice ship in setup\, and the installer is
# in the package. setup\ is never mirrored into the install folder: the
# installer copies voice\ and Glass from it once, and never over what is there.
#
# The folder is built under a staging name and swapped in at the end, so an
# installer waiting for Apaki to close (install-apaki.ps1 -WaitForClose) never
# copies a half-built package.
#
# Then install with apaki\scripts\install-apaki.ps1 (or the package's own copy).
# Usage: powershell -File apaki\scripts\package-apaki.ps1 [-SkipBuild] [-Out <dir>]
#          [-GlassFrom <dir>] [-VoiceFrom <dir>] [-NoGlass] [-NoVoice] [-Zip]
#   -Out        package folder (default apaki\dist\Myrlin Apaki); a test package
#               elsewhere leaves the real one, and any waiting installer, alone
#   -GlassFrom  folder with myrlin-glass.exe and glass.exe (default: $env:APAKI_GLASS_FROM,
#               then ..\claude-swap\widget\target\release next to this repo, then
#               the installed %LOCALAPPDATA%\Programs\Myrlin Glass)
#   -VoiceFrom  a voice folder (bin\Release\whisper-cli.exe, models\ggml-base.en.bin);
#               default: $env:APAKI_VOICE_FROM, then the installed Apaki's voice\
#   -Zip        also writes "<package>.zip" next to the package (for another PC)

param(
  [switch]$SkipBuild,
  [string]$Out,
  [string]$GlassFrom,
  [string]$VoiceFrom,
  [switch]$NoGlass,
  [switch]$NoVoice,
  [switch]$Zip
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$finalDist = if ($Out) { [IO.Path]::GetFullPath($Out) } else { Join-Path $repo 'apaki\dist\Myrlin Apaki' }
# Built under a staging name, swapped in at the end (see the header).
$dist = "$finalDist.staging-$PID"
$engine = Join-Path $dist 'engine'
$setup = Join-Path $dist 'setup'

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
# The Claude Code binary the SDK runs; without it no pane can start (it is an optional npm dependency).
$sdkClaude = Join-Path $repo 'node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'
if (-not (Test-Path $sdkClaude)) { throw "missing: $sdkClaude (npm install on Windows x64 installs it)" }

# Fresh staging folder every time, so nothing stale ships.
if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
New-Item -ItemType Directory -Force $dist, $engine, (Join-Path $dist 'node'), (Join-Path $dist 'bin'), $setup | Out-Null

Copy-Item $exe $dist
foreach ($f in 'package.json', 'package-lock.json') { Copy-Item (Join-Path $repo $f) $engine }
# Source folders skip build output and logs; node_modules is copied whole,
# since packages keep their code in folders named dist or target.
# /R:2 /W:1: a locked file fails fast instead of robocopy's default million retries.
function Mirror($from, $to, [switch]$Whole) {
  if ($Whole) { robocopy $from $to /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null }
  else { robocopy $from $to /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP /XD .git target dist /XF *.log | Out-Null }
  if ($LASTEXITCODE -ge 8) { throw "copy failed: $from" }
}
Mirror (Join-Path $repo 'src') (Join-Path $engine 'src')
Mirror (Join-Path $repo 'bin') (Join-Path $engine 'bin')
Mirror (Join-Path $repo 'apaki\engine') (Join-Path $engine 'apaki\engine')
# Phone access (2026-10-09): the engine imports apaki\remote\protocol.js and wire.js.
Mirror (Join-Path $repo 'apaki\remote') (Join-Path $engine 'apaki\remote')
# The BROWSER shim the engine gives Claude Code (apaki-open.cmd + .mjs), so pages open inside Apaki.
Mirror (Join-Path $repo 'apaki\bin') (Join-Path $engine 'apaki\bin')
# The phone page check (2026-10-10, engine remote-page.js): the engine builds the phone page this
# Apaki expects from its own window code and compares it with what the site serves, so it needs
# the sources of that build (apaki\ui, apaki\web, the icon, scripts\build-web.mjs). About 1 MB.
Mirror (Join-Path $repo 'apaki\ui') (Join-Path $engine 'apaki\ui')
Mirror (Join-Path $repo 'apaki\web') (Join-Path $engine 'apaki\web')
Mirror (Join-Path $repo 'apaki\icons\source') (Join-Path $engine 'apaki\icons\source')
New-Item -ItemType Directory -Force (Join-Path $engine 'apaki\scripts') | Out-Null
Copy-Item (Join-Path $repo 'apaki\scripts\build-web.mjs') (Join-Path $engine 'apaki\scripts\build-web.mjs')
Mirror (Join-Path $repo 'node_modules') (Join-Path $engine 'node_modules') -Whole
New-Item -ItemType Directory -Force (Join-Path $engine 'index\target\release') | Out-Null
Copy-Item $index (Join-Path $engine 'index\target\release')
# latch --relay's hook (2026-10-10): the window gets it with --settings, so no Claude settings file is written.
if (Test-Path (Join-Path $repo 'hooks')) { Mirror (Join-Path $repo 'hooks') (Join-Path $engine 'hooks') }

$node = (Get-Command node -ErrorAction Stop).Source
Copy-Item $node (Join-Path $dist 'node\node.exe')

# The console (2026-10-12, apaki/engine/console.js): node-pty is a native module (its ConPTY binding ships prebuilt in
# node_modules\node-pty\prebuilds\win32-x64, N-API, so any Node loads it). Check it loads with the Node this package
# carries, from the packaged engine folder, so an installed app never finds out later. Without it, the console says
# node-pty is missing and everything else works.
$ptyDir = Join-Path $engine 'node_modules\node-pty'
if (Test-Path $ptyDir) {
  $ptyCheck = & (Join-Path $dist 'node\node.exe') -e "require(process.argv[1]); process.stdout.write('ok')" $ptyDir 2>&1
  if ("$ptyCheck" -ne 'ok') { throw "node-pty does not load with the packaged Node: $ptyCheck" }
  'console: node-pty loads with the packaged Node'
} else {
  "WARNING: node_modules\node-pty is missing (npm install in the repo); the console will say so (Open in terminal does not need it)."
}

$cmd = @{
  'apaki.cmd' = "@echo off`r`nrem apaki: opens Myrlin Apaki, or brings the open window forward.`r`nstart `"`" `"%~dp0..\myrlin-apaki.exe`" %*`r`n"
  'latch.cmd' = "@echo off`r`nrem latch: the terminal app on the same engine as Myrlin Apaki.`r`n`"%~dp0..\node\node.exe`" `"%~dp0..\engine\bin\latch.js`" %*`r`n"
  'glass.cmd' = "@echo off`r`nrem glass: Myrlin Glass's command line (accounts, usage, swaps).`r`nif not exist `"%LOCALAPPDATA%\Programs\Myrlin Glass\glass.exe`" (echo Myrlin Glass is not installed. & exit /b 1)`r`n`"%LOCALAPPDATA%\Programs\Myrlin Glass\glass.exe`" %*`r`n"
}
foreach ($k in $cmd.Keys) { [IO.File]::WriteAllText((Join-Path $dist "bin\$k"), $cmd[$k], [Text.Encoding]::ASCII) }

# ---- the installer travels with the package (2026-10-10) -------------------
# install-apaki.ps1 sees myrlin-apaki.exe next to itself and installs this
# folder as it is; the .cmd lets a person double-click it.
Copy-Item (Join-Path $PSScriptRoot 'install-apaki.ps1') (Join-Path $dist 'install-apaki.ps1')
$installCmd = "@echo off`r`nrem Installs Myrlin Apaki (and Myrlin Glass, if this PC has none) for this Windows user.`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0install-apaki.ps1`" %*`r`necho.`r`npause`r`n"
[IO.File]::WriteAllText((Join-Path $dist 'Install Myrlin Apaki.cmd'), $installCmd, [Text.Encoding]::ASCII)

# ---- the Visual C++ runtime, app-local (2026-10-10) ------------------------
# latch-index (ONNX Runtime), Glass and whisper-cli import VCRUNTIME140,
# VCRUNTIME140_1, MSVCP140 and MSVCP140_1; a clean Windows has none of them
# (myrlin-apaki.exe, node.exe and claude.exe do not need them). Microsoft
# allows these four next to the exe that uses them. The newest copy found
# wins: this PC's System32 (from the VC++ redistributable) or a Visual Studio
# redist folder.
$crtNames = 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll'
$crtDirs = @(Join-Path $env:WINDIR 'System32')
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
  foreach ($vs in @(& $vswhere -products * -property installationPath 2>$null)) {
    $redist = Join-Path $vs 'VC\Redist\MSVC'
    if (Test-Path $redist) {
      $crtDirs += @(Get-ChildItem -LiteralPath $redist -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'x64\Microsoft.VC143.CRT' } | Where-Object { Test-Path $_ })
    }
  }
}
$crt = @{}
foreach ($n in $crtNames) {
  $best = $null
  foreach ($d in $crtDirs) {
    $f = Join-Path $d $n
    if (-not (Test-Path -LiteralPath $f)) { continue }
    $v = [version](Get-Item -LiteralPath $f).VersionInfo.FileVersionRaw
    if (-not $best -or $v -gt $best.Version) { $best = @{ Path = $f; Version = $v } }
  }
  if (-not $best) { throw "the Visual C++ runtime DLL $n was not found (install the VC++ 2015-2022 x64 redistributable or Visual Studio Build Tools)" }
  $crt[$n] = $best
}
function Copy-Crt($to) { foreach ($n in $crtNames) { Copy-Item -LiteralPath $crt[$n].Path (Join-Path $to $n) -Force } }
Copy-Crt (Join-Path $engine 'index\target\release')
$crtText = ($crtNames | ForEach-Object { "$_ $($crt[$_].Version)" }) -join ', '

# ---- Myrlin Glass, bundled (2026-10-10) ------------------------------------
# The widget and its CLI/MCP server, plus the runtime DLLs they need. The
# installer puts them in %LOCALAPPDATA%\Programs\Myrlin Glass only when that
# PC has no Glass; an installed Glass is never replaced from here.
$glassBundled = $null
if (-not $NoGlass) {
  $glassCandidates = @($GlassFrom, $env:APAKI_GLASS_FROM, (Join-Path (Split-Path -Parent $repo) 'claude-swap\widget\target\release'), (Join-Path $env:LOCALAPPDATA 'Programs\Myrlin Glass')) | Where-Object { $_ }
  $glassSrc = $glassCandidates | Where-Object { (Test-Path (Join-Path $_ 'myrlin-glass.exe')) -and (Test-Path (Join-Path $_ 'glass.exe')) } | Select-Object -First 1
  if ($GlassFrom -and $glassSrc -ne $GlassFrom) { throw "-GlassFrom $GlassFrom has no myrlin-glass.exe and glass.exe" }
  if ($glassSrc) {
    $glassOut = Join-Path $setup 'glass'
    New-Item -ItemType Directory -Force $glassOut | Out-Null
    foreach ($n in 'myrlin-glass.exe', 'glass.exe') { Copy-Item -LiteralPath (Join-Path $glassSrc $n) (Join-Path $glassOut $n) }
    Copy-Crt $glassOut
    # Glass's own installer, when its repo is next to the build: it uninstalls what this one installs.
    $glassScript = Join-Path $glassSrc '..\..\..\scripts\install-glass.ps1'
    if (Test-Path $glassScript) { Copy-Item -LiteralPath $glassScript (Join-Path $glassOut 'install-glass.ps1') }
    $glassVer = (Get-Item -LiteralPath (Join-Path $glassOut 'myrlin-glass.exe')).VersionInfo.ProductVersion
    $glassCommit = $null
    $glassRepo = [IO.Path]::GetFullPath((Join-Path $glassSrc '..\..\..'))
    if (Test-Path (Join-Path $glassRepo '.git')) { $glassCommit = (git -C $glassRepo rev-parse --short HEAD) 2>$null }
    $glassBundled = "version $glassVer from $glassSrc$(if ($glassCommit) { " (commit $glassCommit)" })"
    Set-Content -Path (Join-Path $glassOut '_WHY_THIS_IS_HERE.md') -Value "# setup\glass`r`n`r`nMyrlin Glass ($glassBundled): myrlin-glass.exe (the widget) and glass.exe (CLI and MCP server), with the Visual C++ runtime DLLs they need. install-apaki.ps1 installs them to %LOCALAPPDATA%\Programs\Myrlin Glass when the PC has no Glass yet. See ../../_WHY_THIS_IS_HERE.md" -Encoding utf8
  } else {
    "WARNING: no Myrlin Glass build found ($($glassCandidates -join '; ')); the package installs without Glass."
  }
}

# ---- voice, bundled (2026-10-10) --------------------------------------------
# whisper.cpp (CPU build) and the free English model the mic button uses. The
# installer adds them to the install folder's voice\ without replacing files
# that are already there (a different model stays).
$voiceBundled = $null
if (-not $NoVoice) {
  $voiceCandidates = @($VoiceFrom, $env:APAKI_VOICE_FROM, (Join-Path $env:LOCALAPPDATA 'Programs\Myrlin Apaki\voice')) | Where-Object { $_ }
  $voiceSrc = $voiceCandidates | Where-Object { (Test-Path (Join-Path $_ 'bin\Release\whisper-cli.exe')) -and (Test-Path (Join-Path $_ 'models\ggml-base.en.bin')) } | Select-Object -First 1
  if ($VoiceFrom -and $voiceSrc -ne $VoiceFrom) { throw "-VoiceFrom $VoiceFrom has no bin\Release\whisper-cli.exe and models\ggml-base.en.bin" }
  if ($voiceSrc) {
    $voiceOut = Join-Path $setup 'voice'
    Mirror (Join-Path $voiceSrc 'bin') (Join-Path $voiceOut 'bin') -Whole
    New-Item -ItemType Directory -Force (Join-Path $voiceOut 'models') | Out-Null
    Copy-Item -LiteralPath (Join-Path $voiceSrc 'models\ggml-base.en.bin') (Join-Path $voiceOut 'models\ggml-base.en.bin')
    Copy-Crt (Join-Path $voiceOut 'bin\Release')
    if (Test-Path (Join-Path $voiceSrc '_WHY_THIS_IS_HERE.md')) { Copy-Item -LiteralPath (Join-Path $voiceSrc '_WHY_THIS_IS_HERE.md') (Join-Path $voiceOut '_WHY_THIS_IS_HERE.md') }
    $voiceBundled = "from $voiceSrc"
  } else {
    "WARNING: no voice folder found ($($voiceCandidates -join '; ')); the package installs without voice (the mic button stays off)."
  }
}

$commit = (git -C $repo rev-parse --short HEAD) 2>$null
$why = @"
# Myrlin Apaki

The installed Myrlin Apaki desktop app, packaged by apaki\scripts\package-apaki.ps1
from $repo (commit $commit) and copied here by apaki\scripts\install-apaki.ps1.
Created by Claude Code (Opus 5.5) for Arthur, 2026-10-09. Fresh-install additions
(installer in the package, bundled Glass and voice, Visual C++ runtime) 2026-10-10.

- myrlin-apaki.exe: the window. Starting it again focuses the open one.
- engine\: Apaki's engine and latch (the terminal app) with their node_modules
  and latch-index (the conversation search). A copy, not a link: the repo can
  move or change without breaking this. Re-run package + install to update.
  node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe is the Claude
  Code every pane runs (and `latch login` signs in with). hooks\ holds the
  prompt-relay hook `latch --relay` hands to its window.
- node\node.exe: the Node runtime the engine and latch run on.
- bin\: apaki, latch and glass commands; this folder is on your user PATH.
- voice\: the local Whisper model and whisper.cpp (bundled since 2026-10-10;
  the installer adds missing files and never replaces what is there).
- install-apaki.ps1, Install Myrlin Apaki.cmd, setup\ (in the package only, not
  in the installed copy): the installer, Myrlin Glass and voice to install.

Myrlin Glass lives next door in ..\Myrlin Glass. Apaki follows it live: it watches
the login Glass writes (~\.claude\.credentials.json) and reads account labels from
glass status. A PC without Glass gets the bundled one ($(if ($glassBundled) { $glassBundled } else { 'not bundled in this package' })).

Runtime data (index, folders, locks, engine log) is in ~\.claude\latch, not here.
Safe to delete: yes, when the app is closed (delete voice\ only if you want the
model gone too). Also remove bin\ from the user PATH, the shortcuts, the App Paths
registry key HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\apaki.exe,
and the matching lines in ~\_AI_LEDGER.md.
"@
Set-Content -Path (Join-Path $dist '_WHY_THIS_IS_HERE.md') -Value $why -Encoding utf8
Set-Content -Path (Join-Path $engine '_WHY_THIS_IS_HERE.md') -Value "# engine`r`n`r`nApaki's engine and latch, copied from the repo with their node_modules and latch-index (plus the Visual C++ runtime DLLs it needs: $crtText). Regenerated by package-apaki.ps1. See ../_WHY_THIS_IS_HERE.md" -Encoding utf8
Set-Content -Path (Join-Path $dist 'bin\_WHY_THIS_IS_HERE.md') -Value "# bin`r`n`r`nThe apaki, latch and glass commands. On the user PATH. See ../_WHY_THIS_IS_HERE.md" -Encoding utf8
Set-Content -Path (Join-Path $dist 'node\_WHY_THIS_IS_HERE.md') -Value "# node`r`n`r`nThe Node runtime ($(& $node -v)) the engine and latch run on. See ../_WHY_THIS_IS_HERE.md" -Encoding utf8
Set-Content -Path (Join-Path $setup '_WHY_THIS_IS_HERE.md') -Value "# setup`r`n`r`nWhat install-apaki.ps1 installs besides Apaki itself: glass\ (Myrlin Glass, only when the PC has none) and voice\ (added to the install folder's voice\ without replacing anything). Never mirrored into the install folder. See ../_WHY_THIS_IS_HERE.md" -Encoding utf8

# ---- swap the finished package in -----------------------------------------
# Rename, not copy: a waiting installer sees either the old package or the new one.
if (Test-Path -LiteralPath $finalDist) {
  $old = "$finalDist.old-$PID"
  try { Rename-Item -LiteralPath $finalDist -NewName (Split-Path -Leaf $old) }
  catch { throw "the package folder $finalDist is in use (an installer copying it, or a program running from it); the new package is at $dist" }
  Rename-Item -LiteralPath $dist -NewName (Split-Path -Leaf $finalDist)
  Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $old) { "note: could not delete the previous package at $old (in use); delete it later" }
} else {
  New-Item -ItemType Directory -Force (Split-Path -Parent $finalDist) | Out-Null
  Rename-Item -LiteralPath $dist -NewName (Split-Path -Leaf $finalDist)
}
$dist = $finalDist

$size = [math]::Round(((Get-ChildItem -LiteralPath $dist -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB)
"packaged: $dist ($size MB, commit $commit)"
"  glass:   $(if ($glassBundled) { $glassBundled } else { 'not bundled' })"
"  voice:   $(if ($voiceBundled) { $voiceBundled } else { 'not bundled' })"
"  VC++:    $crtText"
"  install: double-click 'Install Myrlin Apaki.cmd' in the package, or run install-apaki.ps1"
if ($Zip) {
  # bsdtar ships with Windows 10 and later and writes zip archives quickly.
  $zipFile = "$dist.zip"
  if (Test-Path -LiteralPath $zipFile) { Remove-Item -LiteralPath $zipFile -Force }
  & (Join-Path $env:WINDIR 'System32\tar.exe') -a -c -f $zipFile -C (Split-Path -Parent $dist) (Split-Path -Leaf $dist)
  if ($LASTEXITCODE) { throw 'zip failed' }
  "  zip:     $zipFile ($([math]::Round((Get-Item -LiteralPath $zipFile).Length / 1MB)) MB)"
}
# Phone pairing only works when the hosted site has this build's phone page (engine remote-page.js
# refuses otherwise). Say so here, so a release is never shipped with phone access quietly broken.
$pageVersion = (& node -e "import('file:///$($repo -replace '\\','/')/apaki/scripts/build-web.mjs').then((m) => process.stdout.write(m.expected({ relay: process.env.APAKI_RELAY_URL || 'wss://apaki.myrlin.io' }).version))") 2>$null
if ($pageVersion -and -not (Test-Path (Join-Path $repo "relay\site\v\$pageVersion"))) {
  "WARNING: this build's phone page (version $pageVersion) is not published. Phone pairing will refuse until it is:"
  "  node apaki/scripts/build-web.mjs --release   then deploy the relay (cd relay; npx wrangler deploy)"
} elseif ($pageVersion) { "phone page: version $pageVersion is published in relay/site (deploy the relay if it is new)" }
