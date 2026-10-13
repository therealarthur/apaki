# package-apaki-win.ps1: builds the Windows installer of Myrlin Apaki with Tauri's own bundler (NSIS).
#
# WHY (Arthur, 2026-10-12): releases are built by GitHub Actions on a version tag and the desktop apps update
# themselves through Tauri's updater plugin, which only works for apps that Tauri's bundler made. package-apaki.ps1 and
# install-apaki.ps1 assemble a folder by hand and copy it; they stay for local builds (and Glass and voice), but the
# release path is this: the same shape as the macOS build (package-apaki-mac.sh). The script only PREPARES what the
# app carries, as bundle.resources, and then runs `tauri build`; a CI job calls the same script.
#
# What it prepares, all under apaki\build-win (gitignored):
#   node\node.exe        the official Node runtime for Windows x64 (zip from nodejs.org, sha256 pinned below and verified)
#   engine\              the engine and latch together: src\, bin\, apaki\engine, apaki\remote, apaki\bin, apaki\ui,
#                        apaki\web, apaki\icons\source, apaki\scripts\build-web.mjs (the phone page check builds the page
#                        from them), apaki\VERSION, hooks\, package.json, node_modules with PRODUCTION dependencies only
#                        (npm ci --omit=dev; the Agent SDK's win32-x64 claude.exe comes with it), and
#                        index\target\release\latch-index.exe with the four Visual C++ runtime DLLs it needs
#   bin\                 apaki.cmd, latch.cmd, glass.cmd: the commands the installer puts on the user PATH
#   .tools\              the Tauri CLI from npm (a prebuilt binary, nothing to compile)
# tauri.windows.bundle.conf.json (next to tauri.conf.json) maps engine\, node\ and bin\ next to myrlin-apaki.exe in the
# install folder, where main.rs finds them (<exe dir>\engine and <exe dir>\node\node.exe), and names the NSIS hooks
# (apaki\nsis\hooks.nsh: PATH commands, the background engine handoff, the sign-in offer).
#
# Not in the installer, on purpose (apaki\docs\windows.md): Myrlin Glass (a separate app with its own installer) and the
# voice model (a large optional download). The app finds both where it always looked (%LOCALAPPDATA%\Programs\Myrlin
# Glass, <install>\voice) and works without them; install-apaki.ps1 can still add the bundled copies on a PC that has them.
#
# Usage: powershell -File apaki\scripts\package-apaki-win.ps1 [options]
#   -PrepareOnly   build the resources and stop
#   -BundleOnly    skip the preparation; build the installer from what is in apaki\build-win
#   -SkipIndex     reuse index\target\release\latch-index.exe instead of building it
#   -Updater       also write the updater's files (the installer's .sig for the update feed). Needs the signing key in
#                  TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD), see apaki\docs\releasing.md
#   -NodeExe PATH  use this node.exe instead of downloading the pinned one (a local build; the release build never does)
#   -Out DIR       where the finished installer goes (default apaki\dist)
# Environment: CARGO_HOME and CARGO_TARGET_DIR are respected; APAKI_MIN_FREE_GB (default 5) is the free disk space the
# script insists on before each big step.
#
# Runs on Windows x64 with: Rust (cargo, MSVC), Node and npm (only to run npm ci and the Tauri CLI; the app runs on the
# Node it carries), and the Visual C++ runtime DLLs (any Windows with the redistributable, and every GitHub runner).

param(
  [switch]$PrepareOnly,
  [switch]$BundleOnly,
  [switch]$SkipIndex,
  [switch]$Updater,
  [string]$NodeExe,
  [string]$Out
)
$ErrorActionPreference = 'Stop'

# Pinned Node runtime. To update: take the new version and its win-x64.zip line from
# https://nodejs.org/dist/<version>/SHASUMS256.txt (the macOS script pins the same version).
$NodeVersion = 'v22.23.3'
$NodeSha256 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'
$MinFreeGb = if ($env:APAKI_MIN_FREE_GB) { [int]$env:APAKI_MIN_FREE_GB } else { 5 }

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$app = Join-Path $repo 'apaki'
$stage = Join-Path $app 'build-win'
$outDir = if ($Out) { [IO.Path]::GetFullPath($Out) } else { Join-Path $app 'dist' }
$doPrepare = -not $BundleOnly
$doBundle = -not $PrepareOnly

function Say([string]$m) { Write-Host $m }
function Die([string]$m) { throw "package-apaki-win: $m" }

if ($env:OS -ne 'Windows_NT') { Die 'this script builds the Windows installer and runs on Windows.' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Die "unsupported CPU $env:PROCESSOR_ARCHITECTURE (the Windows build is x64 for now)" }

function Need-Free([string]$step) {
  $drive = (Get-Item -LiteralPath $repo).PSDrive
  $free = [math]::Floor($drive.Free / 1GB)
  if ($free -lt $MinFreeGb) { Die "only $free GB free on $($drive.Name): (APAKI_MIN_FREE_GB=$MinFreeGb); free some space or lower it. Step: $step" }
  Say "  disk: $free GB free before: $step"
}

# A folder copy that skips build output; /MIR so nothing stale ships. /R:2 /W:1: a locked file fails fast.
function Mirror([string]$from, [string]$to) {
  New-Item -ItemType Directory -Force $to | Out-Null
  robocopy $from $to /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP /XD .git target dist /XF *.log | Out-Null
  if ($LASTEXITCODE -ge 8) { Die "copy failed: $from" }
}

function Write-Note([string]$dir, [string]$text) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  Set-Content -LiteralPath (Join-Path $dir '_WHY_THIS_IS_HERE.md') -Value $text -Encoding utf8
}

function Prepare-Node {
  Say "node $NodeVersion (win-x64)"
  $dest = Join-Path $stage 'node'
  New-Item -ItemType Directory -Force $dest | Out-Null
  if ($NodeExe) {
    if (-not (Test-Path -LiteralPath $NodeExe)) { Die "-NodeExe $NodeExe does not exist" }
    Copy-Item -LiteralPath $NodeExe (Join-Path $dest 'node.exe') -Force
    Say "  using $NodeExe (a local build; the release build downloads the pinned one)"
  } else {
    $cache = Join-Path $stage '.cache'
    New-Item -ItemType Directory -Force $cache | Out-Null
    $file = "node-$NodeVersion-win-x64.zip"
    $zip = Join-Path $cache $file
    if (-not (Test-Path -LiteralPath $zip)) {
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$NodeVersion/$file" -OutFile "$zip.part"
      Move-Item -LiteralPath "$zip.part" -Destination $zip
    }
    $got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($got -ne $NodeSha256) {
      Remove-Item -LiteralPath $zip -Force
      Die "checksum mismatch for ${file}: got $got, pinned $NodeSha256. Deleted the download; nothing was installed."
    }
    Say "  sha256 verified: $got"
    $tmp = Join-Path $cache ("node-extract-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $inner = Join-Path $tmp "node-$NodeVersion-win-x64"
    Copy-Item -LiteralPath (Join-Path $inner 'node.exe') (Join-Path $dest 'node.exe') -Force
    Copy-Item -LiteralPath (Join-Path $inner 'LICENSE') (Join-Path $dest 'LICENSE') -Force
    Remove-Item -LiteralPath $tmp -Recurse -Force
  }
  Write-Note $dest "# node`r`n`r`nThe Node.js runtime ($NodeVersion for Windows x64) the engine and latch run on, from nodejs.org and checked against a pinned sha256 by apaki\scripts\package-apaki-win.ps1 (LICENSE is Node's). See ../_WHY_THIS_IS_HERE.md"
}

# The four Visual C++ runtime DLLs latch-index (ONNX Runtime) imports; a clean Windows has none of them. Microsoft allows
# them next to the exe that uses them. The newest copy found wins: System32 (from the redistributable) or a Visual Studio
# redist folder. Same search as package-apaki.ps1.
function Copy-Crt([string]$to) {
  $names = 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll'
  $dirs = @(Join-Path $env:WINDIR 'System32')
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path $vswhere) {
    foreach ($vs in @(& $vswhere -products * -property installationPath 2>$null)) {
      $redist = Join-Path $vs 'VC\Redist\MSVC'
      if (Test-Path $redist) {
        $dirs += @(Get-ChildItem -LiteralPath $redist -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'x64\Microsoft.VC143.CRT' } | Where-Object { Test-Path $_ })
      }
    }
  }
  $report = @()
  foreach ($n in $names) {
    $best = $null
    foreach ($d in $dirs) {
      $f = Join-Path $d $n
      if (-not (Test-Path -LiteralPath $f)) { continue }
      $v = [version](Get-Item -LiteralPath $f).VersionInfo.FileVersionRaw
      if (-not $best -or $v -gt $best.Version) { $best = @{ Path = $f; Version = $v } }
    }
    if (-not $best) { Die "the Visual C++ runtime DLL $n was not found (install the VC++ 2015-2022 x64 redistributable or Visual Studio Build Tools)" }
    Copy-Item -LiteralPath $best.Path (Join-Path $to $n) -Force
    $report += "$n $($best.Version)"
  }
  return ($report -join ', ')
}

function Prepare-Index {
  $e = Join-Path $stage 'engine\index\target\release'
  $built = Join-Path $repo 'index\target\release\latch-index.exe'
  if ($SkipIndex -and (Test-Path -LiteralPath (Join-Path $e 'latch-index.exe'))) {
    Say 'latch-index: keeping the one already in the staging folder'
    return
  } elseif ($SkipIndex -and (Test-Path -LiteralPath $built)) {
    Say 'latch-index: reusing index\target\release\latch-index.exe'
  } else {
    Need-Free 'building latch-index'
    Say 'latch-index: cargo build --release (the conversation search; the first build takes several minutes)'
    cargo build --release --locked --manifest-path (Join-Path $repo 'index\Cargo.toml')
    if ($LASTEXITCODE) { Die 'latch-index build failed' }
  }
  New-Item -ItemType Directory -Force $e | Out-Null
  Copy-Item -LiteralPath $built (Join-Path $e 'latch-index.exe') -Force
  $script:crtText = Copy-Crt $e
}

function Prepare-Engine {
  Say 'engine: copying sources'
  $e = Join-Path $stage 'engine'
  New-Item -ItemType Directory -Force $e | Out-Null
  foreach ($f in 'package.json', 'package-lock.json') { Copy-Item -LiteralPath (Join-Path $repo $f) $e -Force }
  Mirror (Join-Path $repo 'src') (Join-Path $e 'src')
  Mirror (Join-Path $repo 'bin') (Join-Path $e 'bin')
  Mirror (Join-Path $app 'engine') (Join-Path $e 'apaki\engine')
  # The app's one version (apaki\VERSION, apaki\scripts\version.mjs): the engine reports it (engine\app-version.js).
  Copy-Item -LiteralPath (Join-Path $app 'VERSION') (Join-Path $e 'apaki\VERSION') -Force
  Mirror (Join-Path $app 'remote') (Join-Path $e 'apaki\remote')
  Mirror (Join-Path $app 'bin') (Join-Path $e 'apaki\bin')
  # The phone page check builds the page this Apaki expects from its own window code: it needs these sources.
  Mirror (Join-Path $app 'ui') (Join-Path $e 'apaki\ui')
  Mirror (Join-Path $app 'web') (Join-Path $e 'apaki\web')
  Mirror (Join-Path $app 'icons\source') (Join-Path $e 'apaki\icons\source')
  New-Item -ItemType Directory -Force (Join-Path $e 'apaki\scripts') | Out-Null
  Copy-Item -LiteralPath (Join-Path $app 'scripts\build-web.mjs') (Join-Path $e 'apaki\scripts\build-web.mjs') -Force
  if (Test-Path (Join-Path $repo 'hooks')) { Mirror (Join-Path $repo 'hooks') (Join-Path $e 'hooks') }
  Say 'engine: npm ci --omit=dev (production dependencies only)'
  Need-Free 'npm ci'
  Push-Location $e
  try {
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache (Join-Path $stage '.npm-cache')
    if ($LASTEXITCODE) { Die 'npm ci failed' }
  } finally { Pop-Location }
  # npm's .bin shims are scripts the app never runs.
  Remove-Item -LiteralPath (Join-Path $e 'node_modules\.bin') -Recurse -Force -ErrorAction SilentlyContinue
  $claude = Join-Path $e 'node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'
  if (-not (Test-Path -LiteralPath $claude)) { Die "missing ${claude}: npm did not install the Agent SDK's claude.exe for win32-x64" }
  # The console (apaki\engine\console.js) runs on node-pty, a native module whose ConPTY binding ships prebuilt for each
  # platform under prebuilds\ (N-API, so any Node loads it). Only this platform's goes into the installer; then check it
  # loads with the Node the app carries, so an installed app never finds out later.
  $pty = Join-Path $e 'node_modules\node-pty'
  if (Test-Path -LiteralPath $pty) {
    foreach ($d in @(Get-ChildItem -LiteralPath (Join-Path $pty 'prebuilds') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'win32-x64' })) { Remove-Item -LiteralPath $d.FullName -Recurse -Force }
    if (-not (Test-Path -LiteralPath (Join-Path $pty 'prebuilds\win32-x64\conpty.node'))) { Die 'node-pty has no win32-x64 prebuild (prebuilds\win32-x64\conpty.node)' }
    $ptyCheck = & (Join-Path $stage 'node\node.exe') -e "require(process.argv[1]); process.stdout.write('ok')" $pty 2>&1
    if ("$ptyCheck" -ne 'ok') { Die "node-pty does not load with the packaged Node: $ptyCheck" }
    Say '  console: node-pty loads with the packaged Node'
  } else {
    Die 'node_modules\node-pty is missing from the production install; the console needs it'
  }
  Write-Note $e "# engine`r`n`r`nApaki's engine and latch, copied from the repo by apaki\scripts\package-apaki-win.ps1, with production node_modules and latch-index built for Windows (plus the Visual C++ runtime DLLs it needs). Regenerated on every package run. See ../_WHY_THIS_IS_HERE.md"
}

function Prepare-Bin {
  # The commands the installer puts on the user PATH; the same three install-apaki.ps1 always wrote.
  $b = Join-Path $stage 'bin'
  New-Item -ItemType Directory -Force $b | Out-Null
  $cmd = @{
    'apaki.cmd' = "@echo off`r`nrem apaki: opens Myrlin Apaki, or brings the open window forward.`r`nstart `"`" `"%~dp0..\myrlin-apaki.exe`" %*`r`n"
    'latch.cmd' = "@echo off`r`nrem latch: the terminal app on the same engine as Myrlin Apaki.`r`n`"%~dp0..\node\node.exe`" `"%~dp0..\engine\bin\latch.js`" %*`r`n"
    'glass.cmd' = "@echo off`r`nrem glass: Myrlin Glass's command line (accounts, usage, swaps).`r`nif not exist `"%LOCALAPPDATA%\Programs\Myrlin Glass\glass.exe`" (echo Myrlin Glass is not installed. & exit /b 1)`r`n`"%LOCALAPPDATA%\Programs\Myrlin Glass\glass.exe`" %*`r`n"
  }
  foreach ($k in $cmd.Keys) { [IO.File]::WriteAllText((Join-Path $b $k), $cmd[$k], [Text.Encoding]::ASCII) }
  Write-Note $b "# bin`r`n`r`nThe apaki, latch and glass commands; the installer puts this folder on the user PATH. See ../_WHY_THIS_IS_HERE.md"
}

function Prepare-TauriCli {
  $lock = Get-Content -LiteralPath (Join-Path $app 'Cargo.lock')
  $ver = '2'
  for ($i = 0; $i -lt $lock.Count - 1; $i++) {
    if ($lock[$i] -eq 'name = "tauri"') { $ver = ($lock[$i + 1] -replace '[^0-9.]', ''); break }
  }
  $tools = Join-Path $stage '.tools'
  if (-not (Test-Path -LiteralPath (Join-Path $tools 'node_modules\.bin\tauri.cmd'))) {
    Say "tauri cli: @tauri-apps/cli@$ver (npm; a prebuilt binary)"
    New-Item -ItemType Directory -Force $tools | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $tools 'package.json'))) { Set-Content -LiteralPath (Join-Path $tools 'package.json') -Value '{"private":true}' -Encoding ascii }
    Push-Location $tools
    try {
      npm install --no-save --no-audit --no-fund --cache (Join-Path $stage '.npm-cache') "@tauri-apps/cli@$ver"
      if ($LASTEXITCODE) { Die 'installing the Tauri CLI failed' }
    } finally { Pop-Location }
  }
}

function Prepare {
  Say "preparing the bundle resources in $stage"
  New-Item -ItemType Directory -Force $stage | Out-Null
  Write-Note $stage "# build-win`r`n`r`nBuild staging for the Windows installer (apaki\scripts\package-apaki-win.ps1); gitignored, safe to delete, regenerated by the script. node\ (Node runtime), engine\ (engine, latch, node_modules, latch-index), bin\ (the commands) become files next to myrlin-apaki.exe in the install folder through bundle.resources in tauri.windows.bundle.conf.json. .cache\ holds the Node download, .npm-cache\ npm's downloads, .tools\ the Tauri CLI."
  Prepare-Node
  Prepare-Index
  Prepare-Engine
  Prepare-Bin
  Prepare-TauriCli
}

function Bundle {
  foreach ($f in @('engine\apaki\engine\engine.js', 'engine\index\target\release\latch-index.exe', 'node\node.exe', 'bin\apaki.cmd')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $f))) { Die "nothing prepared for $f in $stage; run without -BundleOnly first" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $stage '.tools\node_modules\.bin\tauri.cmd'))) { Prepare-TauriCli }
  Need-Free 'tauri build (the Rust app)'
  $tauriArgs = @('build', '--config', 'tauri.windows.bundle.conf.json', '--bundles', 'nsis')
  if ($Updater) {
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) { Die '-Updater needs the updater signing key in TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD)' }
    $tauriArgs += @('--config', 'tauri.updater.conf.json')
  }
  Say "tauri $($tauriArgs -join ' ')"
  Push-Location $app
  try {
    & (Join-Path $stage '.tools\node_modules\.bin\tauri.cmd') @tauriArgs
    if ($LASTEXITCODE) { Die 'tauri build failed' }
  } finally { Pop-Location }

  $target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $app 'target' }
  $setup = @(Get-ChildItem -LiteralPath (Join-Path $target 'release\bundle\nsis') -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  if (-not $setup) { Die "the bundler did not produce an installer in $target\release\bundle\nsis" }
  New-Item -ItemType Directory -Force $outDir | Out-Null
  foreach ($f in @($setup[0]) + @(Get-ChildItem -LiteralPath $setup[0].DirectoryName -Filter "$($setup[0].Name).sig" -File -ErrorAction SilentlyContinue)) {
    Copy-Item -LiteralPath $f.FullName (Join-Path $outDir $f.Name) -Force
  }
  Write-Note $outDir "# dist`r`n`r`nThe finished Windows build of Myrlin Apaki (apaki\scripts\package-apaki-win.ps1): the NSIS installer Tauri's bundler made (and its .sig when built with -Updater). Safe to delete; regenerated by the script. Not code signed yet (SmartScreen warns on a download)."
  $size = [math]::Round($setup[0].Length / 1MB)
  Say "done: $(Join-Path $outDir $setup[0].Name) ($size MB)"
}

if ($doPrepare) { Prepare }
if ($doBundle) { Bundle }
