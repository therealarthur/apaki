# install-apaki.ps1: installs Myrlin Apaki for this user.
#
# Copies the release build to %LOCALAPPDATA%\Programs\Myrlin Apaki and makes a
# shortcut in Desktop\Desktop\Apps (next to Myrlin Glass's). The app runs its
# engine from this repo (apaki/engine, latch's src/, latch-index), so keep the
# repo where it is, or set APAKI_ROOT.
#
# Build first:  cd apaki; cargo build --release   (and cd index; cargo build --release)
# Usage:        powershell -File apaki\scripts\install-apaki.ps1 [-DryRun]

param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exe = Join-Path $repo 'apaki\target\release\myrlin-apaki.exe'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\Myrlin Apaki'
$apps = Join-Path $env:USERPROFILE 'Desktop\Desktop\Apps'
$lnk = Join-Path $apps 'Myrlin Apaki.lnk'

if (-not (Test-Path $exe)) { throw "not built yet: $exe (cd apaki; cargo build --release)" }
"repo:     $repo"
"install:  $dest\myrlin-apaki.exe"
"shortcut: $lnk"
if ($DryRun) { return }

$running = Get-Process -Name myrlin-apaki -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dest*" }
if ($running) { throw 'Myrlin Apaki is running from the install folder; close it first.' }

New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item $exe (Join-Path $dest 'myrlin-apaki.exe') -Force
$why = @"
# Myrlin Apaki

Installed copy of the Myrlin Apaki desktop app (source: $repo\apaki), put here by
apaki\scripts\install-apaki.ps1. Created by Claude Code (Opus 5.5) on 2026-10-09
for Arthur. The app runs its engine from the repo, so the repo must stay in place.

Safe to delete: yes, when the app is closed. Reinstall with the script above.
Also remove the shortcut "$lnk" and the matching lines in ~/_AI_LEDGER.md.
"@
Set-Content -Path (Join-Path $dest '_WHY_THIS_IS_HERE.md') -Value $why -Encoding utf8

if (Test-Path $apps) {
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $dest 'myrlin-apaki.exe'
  $s.WorkingDirectory = $dest
  $s.Description = 'Myrlin Apaki: every Claude Code session, linked to Myrlin Glass'
  $s.Save()
}
'installed'
