# install-apaki.ps1: installs the packaged Myrlin Apaki for this user, next to
# Myrlin Glass.
#
#   %LOCALAPPDATA%\Programs\Myrlin Apaki    the package (see package-apaki.ps1);
#                                           voice\ there is kept across updates
#   %LOCALAPPDATA%\Programs\Myrlin Glass    Glass, untouched; Apaki follows it live
#   user PATH += Myrlin Apaki\bin           so `apaki`, `latch` and `glass` work in
#                                           any new terminal
#   App Paths\apaki.exe                     so Win+R "apaki" opens it too
#   shortcuts                               Desktop\Desktop\Apps and the Start menu,
#                                           next to Myrlin Glass's
#
# Usage: powershell -File apaki\scripts\install-apaki.ps1 [-DryRun] [-NoPackage]
#   (packages first unless -NoPackage; package-apaki.ps1 builds the release exe)

param([switch]$DryRun, [switch]$NoPackage)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dist = Join-Path $repo 'apaki\dist\Myrlin Apaki'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\Myrlin Apaki'
$bin = Join-Path $dest 'bin'
$exe = Join-Path $dest 'myrlin-apaki.exe'
$glassDir = Join-Path $env:LOCALAPPDATA 'Programs\Myrlin Glass'
$apps = Join-Path $env:USERPROFILE 'Desktop\Desktop\Apps'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

"package:  $dist"
"install:  $dest"
"commands: $bin (apaki, latch, glass) on the user PATH"
"glass:    $glassDir $(if (Test-Path (Join-Path $glassDir 'glass.exe')) { '(installed)' } else { '(NOT installed: Apaki works, billing stays on the live login)' })"
if ($DryRun) { return }

if (-not $NoPackage) { & (Join-Path $PSScriptRoot 'package-apaki.ps1') -SkipBuild:$false }
if (-not (Test-Path (Join-Path $dist 'myrlin-apaki.exe'))) { throw "not packaged yet: $dist" }

$running = Get-Process -Name myrlin-apaki -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dest*" }
if ($running) { throw 'Myrlin Apaki is running from the install folder; close it first.' }

# Mirror the package in, keeping voice\ (the Whisper model is installed separately).
New-Item -ItemType Directory -Force $dest | Out-Null
robocopy $dist $dest /MIR /NFL /NDL /NJH /NJS /NP /XD (Join-Path $dest 'voice') | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'copy into the install folder failed' }

# `apaki`, `latch`, `glass` in new terminals.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $bin)) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User')
  'added to user PATH (open a new terminal)'
}

# Win+R / Start search "apaki".
$appPaths = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\apaki.exe'
New-Item -Path $appPaths -Force | Out-Null
Set-ItemProperty -Path $appPaths -Name '(default)' -Value $exe
Set-ItemProperty -Path $appPaths -Name 'Path' -Value $dest

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @($apps, $startMenu)) {
  if (-not (Test-Path $dir)) { continue }
  $s = $shell.CreateShortcut((Join-Path $dir 'Myrlin Apaki.lnk'))
  $s.TargetPath = $exe
  $s.WorkingDirectory = $dest
  $s.Description = 'Myrlin Apaki: every Claude Code session, linked to Myrlin Glass'
  $s.Save()
}
'installed'
