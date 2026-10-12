# install-apaki.ps1: installs the packaged Myrlin Apaki for this user, next to
# Myrlin Glass.
#
#   %LOCALAPPDATA%\Programs\Myrlin Apaki    the package (see package-apaki.ps1);
#                                           voice\ there is kept across updates
#   %LOCALAPPDATA%\Programs\Myrlin Glass    Glass, untouched when it is there;
#                                           installed from the package when the
#                                           PC has none (2026-10-10)
#   user PATH += Myrlin Apaki\bin           so `apaki`, `latch` and `glass` work in
#                                           any new terminal
#   App Paths\apaki.exe                     so Win+R "apaki" opens it too
#   shortcuts                               Desktop\Desktop\Apps (else the Desktop)
#                                           and the Start menu, next to Myrlin Glass's
#
# Usage: powershell -File apaki\scripts\install-apaki.ps1 [-DryRun] [-NoPackage] [-WaitForClose]
#          [-NoGlass] [-NoSignIn]
#   (packages first unless -NoPackage; package-apaki.ps1 builds the release exe)
#   -WaitForClose: instead of refusing while Apaki runs, wait (up to 12 hours)
#   until it is closed, install, then open the new version. Lets an update be
#   staged while Apaki is in use (2026-10-09).
#   -Now: install while Apaki runs (2026-10-10 night). Files the open window or
#   its engine still use (myrlin-apaki.exe, node.exe, claude.exe) are moved
#   aside and the new ones go in next to them; nothing is stopped or closed,
#   and the next time Apaki opens it runs the new version. Replaces the
#   -WaitForClose dance for updates: a close and a quick reopen raced the copy
#   and left the old window in place (the reopened exe was locked mid-copy).
#   -NoGlass: never install the bundled Myrlin Glass.
#   -NoSignIn: do not offer Claude's sign-in at the end.
#   -TestProfile: a test seam (2026-10-10, no Windows Sandbox on Arthur's PC).
#   Installs into whatever $env:LOCALAPPDATA, $env:APPDATA and $env:USERPROFILE
#   point at (a throwaway profile) and changes nothing outside it: no registry
#   (user PATH, App Paths, Run), no programs started, shortcuts under
#   $env:USERPROFILE\Desktop, and its own install lock, so a real installer
#   waiting for Apaki to close is not disturbed. Implies -NoSignIn.
#
# From a package (2026-10-10): the package carries a copy of this script and
# "Install Myrlin Apaki.cmd". Run from there (myrlin-apaki.exe sits next to the
# script), it installs that folder as it is, so a PC without the repo installs
# too. Arthur (2026-10-10): "its incredibly important that everything works out
# of the box on install, the app, glass, being able to do the relay, etc".
# What a fresh Windows 11 PC needs and where it comes from:
#   Node, Claude Code      in the package (node\node.exe; the Agent SDK's claude.exe)
#   VC++ runtime           next to the exes that need it (package-apaki.ps1)
#   WebView2               part of Windows 11; installed here if it is missing
#   Myrlin Glass           from the package when there is none (widget + CLI,
#                          started now and at login, like Glass's own setup);
#                          without Myrlin Workbook it runs in its lite mode
#   voice                  from the package, added to voice\ (nothing replaced)
#   Claude sign-in         Claude Code's own `claude auth login` (offered at the
#                          end; later: `latch login` or Sign in in Apaki's Glass panel)
#   Git for Windows        optional: Claude Code uses PowerShell for its shell
#                          tool without it
# Never written: ~/.claude/settings.json, ~/.claude.json, Codex's config.toml
# (registering Glass's MCP server there is printed as a command to run).

param([switch]$DryRun, [switch]$NoPackage, [switch]$WaitForClose, [switch]$Now, [switch]$NoGlass, [switch]$NoSignIn, [switch]$TestProfile)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dist = Join-Path $repo 'apaki\dist\Myrlin Apaki'
# Run from inside a package: install that package (2026-10-10).
$fromPackage = Test-Path (Join-Path $PSScriptRoot 'myrlin-apaki.exe')
if ($fromPackage) { $dist = $PSScriptRoot; $NoPackage = $true }
$dest = Join-Path $env:LOCALAPPDATA 'Programs\Myrlin Apaki'
$bin = Join-Path $dest 'bin'
$exe = Join-Path $dest 'myrlin-apaki.exe'
$glassDir = Join-Path $env:LOCALAPPDATA 'Programs\Myrlin Glass'
$apps = Join-Path $env:USERPROFILE 'Desktop\Desktop\Apps'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
# Arthur keeps app shortcuts in Desktop\Desktop\Apps; any other PC gets them on its Desktop
# (GetFolderPath follows a Desktop that OneDrive moved).
$desktopDir = if (Test-Path $apps) { $apps } else { [Environment]::GetFolderPath('Desktop') }
# -TestProfile: the shell folder API ignores the environment, so the test profile's own Desktop.
if ($TestProfile) { $desktopDir = Join-Path $env:USERPROFILE 'Desktop'; New-Item -ItemType Directory -Force $desktopDir, $startMenu | Out-Null; $NoSignIn = $true }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$glassBundle = Join-Path $dist 'setup\glass'
$voiceBundle = Join-Path $dist 'setup\voice'
$claudeExe = Join-Path $dest 'engine\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'

if ([IO.Path]::GetFullPath($dist).TrimEnd('\') -ieq [IO.Path]::GetFullPath($dest).TrimEnd('\')) {
  throw "this is the installed copy ($dest); run the installer from the package folder instead"
}

# ---------------------------------------------------------------------------
# Small helpers (2026-10-10)
# ---------------------------------------------------------------------------

function Test-FileInUse([string]$Path) {
  # True when the file cannot be opened for writing: the case for a running exe
  # or a loaded DLL (Windows refuses write access to a mapped image but still
  # allows a rename). Opening does not write anything. Same check as Glass's installer.
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $fs.Dispose()
    return $false
  } catch { return $true }
}

function Invoke-Quiet([string]$File, [string[]]$Arguments) {
  # A native program's output as text, exit code in $LASTEXITCODE. Windows
  # PowerShell turns redirected stderr into error records, which would stop
  # this script under ErrorActionPreference Stop, so the preference is lowered.
  $prev = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; return (& $File @Arguments 2>$null | Out-String) }
  finally { $ErrorActionPreference = $prev }
}

function Get-WebView2Version {
  # The Evergreen WebView2 Runtime's version (per machine or per user), or $null.
  $id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  foreach ($k in "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$id", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$id", "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$id") {
    $v = (Get-ItemProperty -LiteralPath $k -Name pv -ErrorAction SilentlyContinue).pv
    if ($v -and $v -ne '0.0.0.0') { return $v }
  }
  return $null
}

function Get-ClaudeLogin {
  # `claude auth status --json` from the installed Claude Code, or $null.
  if (-not (Test-Path -LiteralPath $claudeExe)) { return $null }
  try { return ((Invoke-Quiet $claudeExe @('auth', 'status', '--json')) | ConvertFrom-Json) } catch { return $null }
}

function Move-LockedAside {
  # Files the new package replaces (or drops) that a running process still
  # maps: node.exe under a latch terminal or keep-warm's keeper, claude.exe
  # under a latch session, latch-index.exe, a DLL. Windows refuses to overwrite
  # them but allows a rename, so they move aside to <name>.old-<stamp> and the
  # new copy goes in next to them. Nothing is stopped. Same rule Glass's
  # installer uses for its running exes. Without this, robocopy waited on them.
  if (-not (Test-Path -LiteralPath $dest)) { return }
  $voiceDir = Join-Path $dest 'voice'
  foreach ($f in @(Get-ChildItem -LiteralPath $dest -Recurse -File -Include *.exe, *.dll, *.node -ErrorAction SilentlyContinue)) {
    if ($f.Name -match '\.old-\d{8}-\d{6}' -or $f.FullName.StartsWith("$voiceDir\", [StringComparison]::OrdinalIgnoreCase)) { continue }
    $src = Join-Path $dist $f.FullName.Substring($dest.Length).TrimStart('\')
    $changed = $true
    if (Test-Path -LiteralPath $src) {
      $s = Get-Item -LiteralPath $src
      $changed = ($s.Length -ne $f.Length) -or ($s.LastWriteTimeUtc -ne $f.LastWriteTimeUtc)
    }
    if ($changed -and (Test-FileInUse $f.FullName)) {
      Move-Item -LiteralPath $f.FullName -Destination "$($f.FullName).old-$stamp"
      "in use, moved aside: $($f.FullName.Substring($dest.Length).TrimStart('\')) (the program using it keeps the old copy until it restarts)"
    }
  }
}

function Remove-AsideLeftovers([string]$Dir) {
  # Deletes copies an earlier run moved aside, once nothing uses them.
  if (-not (Test-Path -LiteralPath $Dir)) { return }
  foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Filter '*.old-*' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.old-\d{8}-\d{6}$' })) {
    if (Test-FileInUse $f.FullName) { continue }
    Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------
# BACKGROUND ENGINE HOST (2026-10-10)
# The background-sessions change (apaki/src/main.rs, apaki/engine/host.js and
# host-ctl.js) keeps an engine running when the window is closed. That host
# runs node\node.exe and claude.exe from this install folder, so it has to
# stop before files are replaced and start again afterwards:
#   Stop-ApakiBackgroundHost   asks the installed host-ctl.js to make the host
#                              exit once it is idle (no window, turn, background
#                              task or question left; never a process-name kill)
#                              and waits: 5 minutes, or 12 hours with
#                              -WaitForClose. Returns $true when one was running.
#                              An Apaki from before host-ctl.js has no host: $false.
#   Start-ApakiBackgroundHost  starts it again from the new files when it was
#                              running before.
# The -WaitForClose loop waits for the window (myrlin-apaki.exe) first; Stop
# then waits for the host. Files something else still holds are moved aside
# (Move-LockedAside) instead of blocking the copy.
# ---------------------------------------------------------------------------
function Stop-ApakiBackgroundHost {
  $node = Join-Path $dest 'node\node.exe'
  $ctl = Join-Path $dest 'engine\apaki\engine\host-ctl.js'
  if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $ctl)) { return $false }
  $wait = if ($WaitForClose) { 43200 } else { 300 }
  # Write-Host, not output: this function's output is its return value.
  Write-Host 'asking the background engine to finish its work and exit'
  $out = Invoke-Quiet $node @($ctl, 'quit', '--when-idle', '--wait', "$wait")
  $code = $LASTEXITCODE
  $r = try { (($out.Trim() -split "`n")[-1]) | ConvertFrom-Json } catch { $null }
  if ($code -eq 2) { throw 'Apaki is still working in the background (a turn, a background task, or a question waiting for an answer). Open Apaki to let it finish or stop it, then install again (or use -WaitForClose).' }
  if ($code -ne 0 -or -not $r) { throw "could not ask the background engine to stop: $($out.Trim())" }
  return [bool]$r.pid
}
function Start-ApakiBackgroundHost([bool]$WasRunning) {
  if (-not $WasRunning) { return }
  $node = Join-Path $dest 'node\node.exe'
  $ctl = Join-Path $dest 'engine\apaki\engine\host-ctl.js'
  if (-not (Test-Path -LiteralPath $ctl)) { return }
  $out = Invoke-Quiet $node @($ctl, 'start')
  if ($LASTEXITCODE -ne 0) { "the background engine did not start again ($($out.Trim())); opening Apaki starts it" }
}

# ---------------------------------------------------------------------------

$glassInstalled = Test-Path (Join-Path $glassDir 'glass.exe')
$glassPlan = if ($glassInstalled) { '(installed; left as is)' }
  elseif ($NoGlass) { '(NOT installed, -NoGlass: Apaki works, billing stays on the live login)' }
  elseif (Test-Path (Join-Path $glassBundle 'glass.exe')) { '(not installed: installing the bundled Glass, started now and at login)' }
  else { '(NOT installed and not in this package: Apaki works, billing stays on the live login)' }
$webview = Get-WebView2Version
$git = Get-Command git -ErrorAction SilentlyContinue

"package:  $dist$(if ($fromPackage) { ' (installing this package)' })"
"install:  $dest"
"commands: $bin (apaki, latch, glass) on the user PATH"
"glass:    $glassDir $glassPlan"
"voice:    $(if (Test-Path (Join-Path $voiceBundle 'models\ggml-base.en.bin')) { 'bundled; missing files are added to voice\, nothing is replaced' } else { 'not in this package (the mic button stays off unless voice\ is already installed)' })"
"webview2: $(if ($webview) { $webview } else { 'MISSING: it will be installed (needed for the window)' })"
"git:      $(if ($git) { $git.Source } else { 'not found (optional: Claude Code uses PowerShell for its shell tool; Git for Windows adds Bash)' })"
"shortcuts: $startMenu, $desktopDir"
if ($DryRun) { return }

if (-not $NoPackage) { & (Join-Path $PSScriptRoot 'package-apaki.ps1') -SkipBuild:$false }
if (-not (Test-Path (Join-Path $dist 'myrlin-apaki.exe'))) { throw "not packaged yet: $dist" }

# One installer at a time. A second one (for example a newer build staged
# while an earlier one waits for Apaki to close) has just refreshed the
# package above; the waiting installer copies the package as it is when Apaki
# closes, so this one hands over instead of racing it into the install folder.
$installLock = New-Object System.Threading.Mutex($false, $(if ($TestProfile) { "Local\MyrlinApakiInstallTest-$PID" } else { 'Local\MyrlinApakiInstall' }))
if (-not $installLock.WaitOne(0)) {
  'another install is already waiting for Apaki to close; it will install this package'
  return
}

$isRunning = { Get-Process -Name myrlin-apaki -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dest*" } }
$waited = $false
if ($WaitForClose) {
  $deadline = (Get-Date).AddHours(12)
  while ((& $isRunning) -and (Get-Date) -lt $deadline) { $waited = $true; Start-Sleep -Seconds 3 }
  # The engine releases its session locks as it shuts down.
  if ($waited) { Start-Sleep -Seconds 3 }
}
if ((& $isRunning) -and -not $Now) { throw 'Myrlin Apaki is running from the install folder; close it first (or use -Now, or -WaitForClose).' }
if ($Now -and (& $isRunning)) { 'Apaki is open: files it uses are moved aside, and it runs the new version the next time it opens' }

# The background engine host (reserved spot above) stops before files change.
# With -Now it stays: it may be serving the open window, and Move-LockedAside
# lets the copy go around the files it holds.
$hostWasRunning = if ($Now) { $false } else { Stop-ApakiBackgroundHost }
# The engine build before the copy (size and modified time of engine.js, as the window compares builds), so -Now
# can tell whether the engine itself changed (2026-10-11).
$engineJs = Join-Path $dest 'engine\apaki\engine\engine.js'
$engineBefore = if (Test-Path -LiteralPath $engineJs) { $i = Get-Item -LiteralPath $engineJs; "$($i.Length)-$($i.LastWriteTimeUtc.Ticks)" } else { '' }

# Mirror the package in, keeping voice\ (its files come from setup\voice below,
# never over the user's). setup\ and the installer itself stay in the package.
# A full path in /XD only matches on its own side, so both voice paths are
# listed: the package's is skipped, the installed one is never purged
# (checked 2026-10-10: with only the installed path, a package voice\ was
# copied over it and its extra files purged). *.old-* are copies moved aside.
New-Item -ItemType Directory -Force $dest | Out-Null
Move-LockedAside
robocopy $dist $dest /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP /XD (Join-Path $dest 'voice') (Join-Path $dist 'voice') (Join-Path $dist 'setup') /XF 'install-apaki.ps1' 'Install Myrlin Apaki.cmd' '*.old-*' | Out-Null
# A file can be locked after the check above (2026-10-10 night: Arthur closed
# and reopened Apaki within seconds, the reopened window locked
# myrlin-apaki.exe mid-copy, and only the exe was left old). Move whatever is
# locked now aside and copy again; robocopy only copies what still differs.
for ($try = 1; $LASTEXITCODE -ge 8 -and $try -le 3; $try++) {
  "copy: some files were locked, moving them aside and trying again ($try of 3)"
  Start-Sleep -Seconds 2
  Move-LockedAside
  $failed = robocopy $dist $dest /MIR /R:2 /W:1 /NDL /NJH /NJS /NP /XD (Join-Path $dest 'voice') (Join-Path $dist 'voice') (Join-Path $dist 'setup') /XF 'install-apaki.ps1' 'Install Myrlin Apaki.cmd' '*.old-*'
}
if ($LASTEXITCODE -ge 8) {
  $failed | Where-Object { $_ -match 'ERROR' } | Select-Object -First 10 | ForEach-Object { "copy failed: $($_.Trim())" }
  throw 'copy into the install folder failed'
}
Remove-AsideLeftovers $dest

# -Now with a new engine (2026-10-11): the running background engine keeps the old code until it exits, and it only
# exits idle with no window. Ask it now to retire once idle, so the next time Apaki is closed it exits within seconds
# and the next window starts the new engine: one restart instead of two, and no long wait.
if ($Now -and -not $TestProfile) {
  $engineAfter = if (Test-Path -LiteralPath $engineJs) { $i = Get-Item -LiteralPath $engineJs; "$($i.Length)-$($i.LastWriteTimeUtc.Ticks)" } else { '' }
  $ctlNow = Join-Path $dest 'engine\apaki\engine\host-ctl.js'
  $nodeNow = Join-Path $dest 'node\node.exe'
  if ($engineBefore -and $engineAfter -ne $engineBefore -and (Test-Path -LiteralPath $ctlNow) -and (Test-Path -LiteralPath $nodeNow)) {
    $null = Invoke-Quiet $nodeNow @($ctlNow, 'quit', '--when-idle')
    'engine updated: the background engine retires the next time Apaki is closed with nothing running, and the next window starts the new one'
  }
}

# Voice (2026-10-10): add what is missing, never replace (/XC /XN /XO copy only new files).
if (Test-Path (Join-Path $voiceBundle 'bin\Release\whisper-cli.exe')) {
  robocopy $voiceBundle (Join-Path $dest 'voice') /E /XC /XN /XO /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { 'warning: voice could not be copied; the mic button stays off' } else { 'voice: ready' }
}

# `apaki`, `latch`, `glass` in new terminals.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($TestProfile) { "test profile: would add $bin to the user PATH and set App Paths\apaki.exe" }
elseif (-not (($userPath -split ';') -contains $bin)) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User')
  'added to user PATH (open a new terminal)'
}

# Win+R / Start search "apaki".
$appPaths = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\apaki.exe'
if (-not $TestProfile) {
  New-Item -Path $appPaths -Force | Out-Null
  Set-ItemProperty -Path $appPaths -Name '(default)' -Value $exe
  Set-ItemProperty -Path $appPaths -Name 'Path' -Value $dest
}

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @($desktopDir, $startMenu)) {
  if (-not (Test-Path $dir)) { continue }
  $s = $shell.CreateShortcut((Join-Path $dir 'Myrlin Apaki.lnk'))
  $s.TargetPath = $exe
  $s.WorkingDirectory = $dest
  $s.Description = 'Myrlin Apaki: every Claude Code session, linked to Myrlin Glass'
  $s.IconLocation = "$exe,0"
  $s.Save()
}

# ---------------------------------------------------------------------------
# Myrlin Glass from the package (2026-10-10)
# Only when this PC has no Glass: an installed Glass (Arthur's own builds,
# installed by its repo's install-glass.ps1) is never touched. Mirrors what
# Glass's installer and widget do: files in %LOCALAPPDATA%\Programs\Myrlin
# Glass, a Start menu shortcut, the "Start at login" Run value the widget's own
# toggle writes ("<exe>" --autostart), and install.json in the shape
# install-glass.ps1 reads, so `install-glass.ps1 -Uninstall` removes it. Not
# done: registering glass.exe as an MCP server in Claude Code and Codex, which
# writes ~/.claude.json and config.toml; the commands are printed instead.
# ---------------------------------------------------------------------------
$glassNew = $false
if (-not $glassInstalled -and -not $NoGlass -and (Test-Path (Join-Path $glassBundle 'glass.exe'))) {
  New-Item -ItemType Directory -Force $glassDir | Out-Null
  foreach ($f in @(Get-ChildItem -LiteralPath $glassBundle -File)) {
    $to = Join-Path $glassDir $f.Name
    if ($f.Name -eq '_WHY_THIS_IS_HERE.md') { continue }
    Copy-Item -LiteralPath $f.FullName -Destination $to -Force
  }
  $glassWidget = Join-Path $glassDir 'myrlin-glass.exe'
  $glassLinks = @()
  foreach ($dir in @($startMenu, $desktopDir)) {
    if (-not (Test-Path $dir)) { continue }
    $lnk = Join-Path $dir 'Myrlin Glass.lnk'
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath = $glassWidget
    $s.Arguments = ''
    $s.WorkingDirectory = $glassDir
    $s.Description = 'Myrlin Glass: Claude and Codex usage limits on the desktop'
    $s.IconLocation = "$glassWidget,0"
    $s.WindowStyle = 1
    $s.Save()
    $glassLinks += $lnk
  }
  # Start at login, the same value tauri-plugin-autostart writes for the widget's toggle.
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if ($TestProfile) { "test profile: would set the Run value 'Myrlin Glass' to `"$glassWidget`" --autostart" }
  elseif ($null -eq (Get-ItemProperty -LiteralPath $runKey -Name 'Myrlin Glass' -ErrorAction SilentlyContinue)) {
    Set-ItemProperty -LiteralPath $runKey -Name 'Myrlin Glass' -Value "`"$glassWidget`" --autostart"
  }
  $manifest = [ordered]@{
    schema = 1; app = 'Myrlin Glass'; installDir = $glassDir; updatedAt = (Get-Date).ToString('o')
    shortcuts = [string[]]$glassLinks; codexConfig = $null; codexBackups = [string[]]@()
    installedBy = 'Myrlin Apaki install-apaki.ps1'
  }
  [IO.File]::WriteAllText((Join-Path $glassDir 'install.json'), ([pscustomobject]$manifest | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
  $glassWhy = @"
# Why this folder is here

**What:** Myrlin Glass, installed by Myrlin Apaki's installer (install-apaki.ps1) on $(Get-Date -Format 'yyyy-MM-dd')
because this PC had no Glass: ``myrlin-glass.exe`` (the desktop widget, started at login through the
Run registry value "Myrlin Glass") and ``glass.exe`` (its command line and MCP server). The
``vcruntime140*.dll`` and ``msvcp140*.dll`` files are the Visual C++ runtime both need.

Without Myrlin Workbook, Glass runs in its lite mode: it shows the live Claude and Codex logins, their
usage and your API-credit entries, and switches Claude between the live login and API keys. Keeping
several subscription logins is Workbook's job.

**Safe to delete?** Quit Glass from its tray menu first. ``install-glass.ps1 -Uninstall`` (in this
folder when the package carried it) removes the shortcuts, the Run value and the files. The data folder
``%LOCALAPPDATA%\Quota`` (settings, logs, state) is separate.
"@
  Set-Content -Path (Join-Path $glassDir '_WHY_THIS_IS_HERE.md') -Value $glassWhy -Encoding utf8
  $glassNew = $true
  'installed Myrlin Glass (started now and at login)'
}

# Downloaded packages carry the internet zone mark; installed files should not
# (SmartScreen would stop the unsigned exes). Only when the package has it.
$motw = Get-Item -LiteralPath (Join-Path $dist 'myrlin-apaki.exe') -Stream Zone.Identifier -ErrorAction SilentlyContinue
if ($motw) {
  Get-ChildItem -LiteralPath $dest -Recurse -File | Unblock-File
  if ($glassNew) { Get-ChildItem -LiteralPath $glassDir -File | Unblock-File }
  'cleared the downloaded-file mark on the installed files'
}

# WebView2 draws the window. Windows 11 has it; an older PC gets the Evergreen
# runtime from Microsoft's bootstrapper (per user when not elevated).
if (-not $webview) {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $boot = Join-Path $env:TEMP "MicrosoftEdgeWebview2Setup-$stamp.exe"
    Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $boot
    Start-Process -FilePath $boot -ArgumentList '/silent', '/install' -Wait
    Remove-Item -LiteralPath $boot -Force -ErrorAction SilentlyContinue
    $webview = Get-WebView2Version
    "webview2: $(if ($webview) { "installed ($webview)" } else { 'still missing; install it from https://developer.microsoft.com/microsoft-edge/webview2/' })"
  } catch { "webview2: could not install it ($($_.Exception.Message)); install it from https://developer.microsoft.com/microsoft-edge/webview2/" }
}

# Windows caches icons by path, so a new app icon (the Myrlin M, 2026-10-09)
# would keep showing the old one on the same exe path until the cache is
# refreshed. ie4uinit -show rebuilds the user's icon cache; harmless if absent.
$refresh = Join-Path $env:WINDIR 'System32\ie4uinit.exe'
if ((Test-Path $refresh) -and -not $TestProfile) { & $refresh -show }

# The background engine host (reserved spot above) starts again on the new files.
if (-not $TestProfile) { Start-ApakiBackgroundHost $hostWasRunning }
'installed'

# Glass starts now on a fresh install, like after its own setup.
if ($glassNew -and -not $TestProfile) { Start-Process -FilePath (Join-Path $glassDir 'myrlin-glass.exe') -WorkingDirectory $glassDir }
if ($glassNew -or -not $glassInstalled) {
  "optional, for agents: let Claude Code and Codex sessions call Glass by registering its MCP server yourself:"
  "  claude mcp add -s user myrlin-glass -- `"$(Join-Path $glassDir 'glass.exe')`" mcp"
}
if (-not $git) { 'note: Git for Windows is not installed. Claude Code works with PowerShell; for Bash and git: winget install Git.Git' }

# Claude sign-in (2026-10-10). A PC that never ran Claude Code has no login, and
# Apaki's panes cannot sign in by themselves. Offered only to a person at the
# console, never in a -WaitForClose run (that one runs unattended).
$login = Get-ClaudeLogin
if ($login -and -not $login.loggedIn) {
  $canAsk = -not $NoSignIn -and -not $WaitForClose -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
  $answer = if ($canAsk) { Read-Host 'Claude is not signed in on this PC. Sign in now? [Y/n]' } else { 'n' }
  if ($answer -notmatch '^\s*n') {
    $prev = $ErrorActionPreference
    try { $ErrorActionPreference = 'Continue'; & $claudeExe auth login } finally { $ErrorActionPreference = $prev }
  } else {
    'Claude is not signed in yet: run `latch login` in a new terminal, or use Sign in to Claude in Apaki''s Glass panel.'
  }
} elseif ($login) {
  "claude:   signed in$(if ($login.email) { " as $($login.email)" })"
}

# Waited for the old version to close: open the new one in its place.
if ($waited -and -not $TestProfile) { Start-Process -FilePath $exe -WorkingDirectory $dest }
