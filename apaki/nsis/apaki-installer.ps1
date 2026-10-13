# apaki-installer.ps1: the steps Myrlin Apaki's Windows installer (NSIS, made by Tauri's bundler) runs through PowerShell.
#
# WHY (Arthur, 2026-10-12: releases are built by GitHub Actions and the desktop apps update themselves through
# Tauri's updater): the app is now installed by the NSIS installer Tauri builds, not by install-apaki.ps1. The
# installer replaces files while Apaki's background engine may be running them, and an update arrives while the app
# is open, so what install-apaki.ps1 did around the copy has to happen here too. apaki/nsis/hooks.nsh calls this
# script at four moments; it never fails the installation (every step reports and goes on), because a
# half-finished PATH entry must not stop a user from getting an update.
#
#   -Action pre-install    before files are replaced. Asks the background engine host (apaki/engine/host.js) to exit
#                          once it is idle, waits a short while (host-ctl.js quit --when-idle --wait), remembers whether
#                          one was running, and moves files that are still in use aside (name.old-<stamp>): Windows
#                          refuses to overwrite a running exe or DLL but allows a rename, so the copy goes on around
#                          the engine's node.exe, claude.exe and latch-index.exe. Nothing is killed. A host that is
#                          busy with a turn keeps running from the moved-aside files, serves the next window, and
#                          retires once idle (it notices new files itself, host.js codeStamp).
#   -Action post-install   after files are in place. Deletes the moved-aside copies nothing uses any more, puts
#                          <install>\bin (the apaki, latch and glass commands) on the user PATH, sets App Paths\apaki.exe
#                          (Win+R "apaki"), and starts the background engine again when one was running before.
#   -Action login-status   exit 3 when Claude Code is not signed in on this PC, 0 when it is (or cannot be told).
#   -Action sign-in        opens a console window running `claude auth login`.
#   -Action pre-uninstall  asks the host to exit, takes the bin folder off the user PATH and removes App Paths.
#
# The installer copies this script to <install>\setup\apaki-installer.ps1 so the uninstaller can run it.
# Myrlin Glass and the voice model are not installed here (see apaki/docs/windows.md): Glass is a separate app with its
# own installer, voice is an optional download; both are found where the app looks for them if the user has them.

param(
  [Parameter(Mandatory)][ValidateSet('pre-install', 'post-install', 'login-status', 'sign-in', 'pre-uninstall')][string]$Action,
  [Parameter(Mandatory)][string]$InstallDir,
  [int]$WaitSeconds = 25
)
$ErrorActionPreference = 'Continue'

$InstallDir = $InstallDir.TrimEnd('\')
$bin = Join-Path $InstallDir 'bin'
$node = Join-Path $InstallDir 'node\node.exe'
$ctl = Join-Path $InstallDir 'engine\apaki\engine\host-ctl.js'
$claude = Join-Path $InstallDir 'engine\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'
$marker = Join-Path $env:TEMP 'apaki-installer-host.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Say([string]$m) { Write-Output "apaki-installer: $m" }

function Invoke-Quiet([string]$File, [string[]]$Arguments) {
  # A native program's output as text, exit code in $LASTEXITCODE. Windows PowerShell turns redirected stderr into
  # error records; the preference is lowered for the call.
  $prev = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; return (& $File @Arguments 2>$null | Out-String) }
  finally { $ErrorActionPreference = $prev }
}

function Test-FileInUse([string]$Path) {
  # True when the file cannot be opened for writing: a running exe or a loaded DLL (a rename is still allowed).
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $fs.Dispose()
    return $false
  } catch { return $true }
}

function Stop-Host {
  # Asks the background engine to exit once it is idle. Returns $true when one was running.
  if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $ctl)) { return $false }
  Say 'asking the background engine to finish its work and exit'
  $out = Invoke-Quiet $node @($ctl, 'quit', '--when-idle', '--wait', "$WaitSeconds")
  $code = $LASTEXITCODE
  $r = try { (($out.Trim() -split "`n")[-1]) | ConvertFrom-Json } catch { $null }
  if ($code -eq 2) { Say 'the engine is still busy (a turn, a background task or a question); it keeps running from the files it has and retires once idle' }
  elseif ($code -ne 0 -or -not $r) { Say "could not ask the background engine to stop ($($out.Trim()))" }
  return [bool]($r -and $r.pid)
}

function Move-LockedAside {
  if (-not (Test-Path -LiteralPath $InstallDir)) { return }
  $voice = Join-Path $InstallDir 'voice'
  foreach ($f in @(Get-ChildItem -LiteralPath $InstallDir -Recurse -File -Include *.exe, *.dll, *.node -ErrorAction SilentlyContinue)) {
    if ($f.Name -match '\.old-\d{8}-\d{6}' -or $f.FullName.StartsWith("$voice\", [StringComparison]::OrdinalIgnoreCase)) { continue }
    if ($f.Name -eq 'uninstall.exe') { continue }
    if (Test-FileInUse $f.FullName) {
      try {
        Move-Item -LiteralPath $f.FullName -Destination "$($f.FullName).old-$stamp" -ErrorAction Stop
        Say "in use, moved aside: $($f.FullName.Substring($InstallDir.Length).TrimStart('\'))"
      } catch { Say "in use and could not be moved: $($f.FullName)" }
    }
  }
}

function Remove-AsideLeftovers {
  foreach ($f in @(Get-ChildItem -LiteralPath $InstallDir -Recurse -File -Filter '*.old-*' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.old-\d{8}-\d{6}$' })) {
    if (Test-FileInUse $f.FullName) { continue }
    Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
  }
}

function Set-UserPath([string]$Dir, [bool]$Present) {
  # The user PATH (registry), with $Dir in it or out of it. SetEnvironmentVariable also tells running programs.
  $path = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @(($path -split ';') | Where-Object { $_ })
  $has = $parts | Where-Object { $_.TrimEnd('\') -ieq $Dir.TrimEnd('\') }
  if ($Present -and -not $has) { [Environment]::SetEnvironmentVariable('Path', (($parts + $Dir) -join ';'), 'User'); Say 'added the commands (apaki, latch, glass) to the user PATH; open a new terminal to use them' }
  elseif (-not $Present -and $has) { [Environment]::SetEnvironmentVariable('Path', (($parts | Where-Object { $_.TrimEnd('\') -ine $Dir.TrimEnd('\') }) -join ';'), 'User'); Say 'took the commands off the user PATH' }
}

$appPaths = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\apaki.exe'

try {
  switch ($Action) {
    'pre-install' {
      $was = Stop-Host
      Set-Content -LiteralPath $marker -Value (@{ wasRunning = $was; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress) -Encoding ascii
      Move-LockedAside
    }
    'post-install' {
      Remove-AsideLeftovers
      Set-UserPath $bin $true
      $exe = Get-ChildItem -LiteralPath $InstallDir -Filter 'myrlin-apaki.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($exe) {
        New-Item -Path $appPaths -Force | Out-Null
        Set-ItemProperty -Path $appPaths -Name '(default)' -Value $exe.FullName
        Set-ItemProperty -Path $appPaths -Name 'Path' -Value $InstallDir
      }
      # The engine that ran before runs again, from the new files (an Apaki window starts one itself otherwise).
      $was = $false
      if (Test-Path -LiteralPath $marker) { try { $was = [bool](Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).wasRunning } catch { $was = $false }; Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
      if ($was -and (Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $ctl)) {
        $out = Invoke-Quiet $node @($ctl, 'start')
        if ($LASTEXITCODE -ne 0) { Say "the background engine did not start again ($($out.Trim())); opening Apaki starts it" } else { Say 'the background engine runs again from the new files' }
      }
    }
    'login-status' {
      if (-not (Test-Path -LiteralPath $claude)) { exit 0 }
      $j = try { (Invoke-Quiet $claude @('auth', 'status', '--json')) | ConvertFrom-Json } catch { $null }
      if ($j -and $j.loggedIn -eq $false) { exit 3 }
      exit 0
    }
    'sign-in' {
      if (Test-Path -LiteralPath $claude) {
        # Its own console window; the pause keeps a message readable when the sign-in stops early.
        Start-Process -FilePath "$env:WINDIR\System32\cmd.exe" -ArgumentList '/c', ('"{0}" auth login & echo. & pause' -f $claude)
      }
    }
    'pre-uninstall' {
      $null = Stop-Host
      Set-UserPath $bin $false
      Remove-Item -Path $appPaths -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
} catch {
  Say "step '$Action' stopped early: $($_.Exception.Message)"
}
exit 0
