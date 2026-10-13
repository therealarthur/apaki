# smoke-win-installer.ps1: installs the Windows installer silently, looks inside, and uninstalls it (2026-10-13).
#
# WHY: the NSIS installer is what every Windows user and every update runs, and its hooks (apaki\nsis\hooks.nsh) do real
# work: PATH commands, App Paths, the background engine handoff. A build that compiled can still ship an installer that
# leaves out the engine or never puts the commands on the PATH, so the release workflow installs the finished file on a
# clean GitHub runner and checks the result before the file is allowed into a release.
#
# THIS INSTALLS AN APP. It refuses to run anywhere but a GitHub Actions runner (GITHUB_ACTIONS=true): on a person's own PC it
# would write the install folder, shortcuts, the user PATH and App Paths of the real Apaki.
#
#   powershell -File apaki\scripts\smoke-win-installer.ps1 -Installer <path to ...-setup.exe>
#
# Checks, in order: the install ends with the files where the app looks for them; the bundled Node runs the engine's
# own code and reports the version of apaki\VERSION; Claude Code's binary, the conversation search and the console's
# node-pty load; the commands are on the user PATH and App Paths names the app; the app starts, connects to its engine and
# the engine host answers; uninstalling removes the files, the PATH entry and App Paths. The installer ran with /S, the
# way an update's silent mode does.

param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -ne 'true') { throw 'smoke-win-installer.ps1 installs the app, so it only runs on a GitHub Actions runner (GITHUB_ACTIONS=true), never on a PC that has Apaki.' }
if (-not (Test-Path -LiteralPath $Installer)) { throw "no installer at $Installer" }

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$wantVersion = (Get-Content -LiteralPath (Join-Path $repo 'apaki\VERSION') -Raw).Trim()
$failures = New-Object System.Collections.Generic.List[string]
function Ok([string]$m) { Write-Host "  ok   $m" }
function Fail([string]$m) { Write-Host "  FAIL $m"; $script:failures.Add($m) }
function Check([bool]$cond, [string]$m) { if ($cond) { Ok $m } else { Fail $m } }

Write-Host "installing $Installer"
$p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
Check ($p.ExitCode -eq 0) "the installer exited 0 (got $($p.ExitCode))"

# Where it went: the installer records it (Software\<publisher>\<product>), like it does for the next update.
$dir = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Myrlin\Myrlin Apaki' -ErrorAction SilentlyContinue).'(default)'
if (-not $dir) { $dir = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Myrlin\Myrlin Apaki' -ErrorAction SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -eq '(default)' -or $_.Name -eq '' } | Select-Object -ExpandProperty Value -First 1 }
Check ([bool]$dir -and (Test-Path -LiteralPath $dir)) "the install folder is recorded and exists ($dir)"
if (-not $dir) { throw 'no install folder, nothing more to check' }
Write-Host "install folder: $dir"
Check ($dir -ieq (Join-Path $env:LOCALAPPDATA 'Programs\Myrlin Apaki')) 'it is %LOCALAPPDATA%\Programs\Myrlin Apaki, where the app, the voice folder and latch --relay look'

$node = Join-Path $dir 'node\node.exe'
$must = @(
  'myrlin-apaki.exe', 'uninstall.exe', 'node\node.exe', 'bin\apaki.cmd', 'bin\latch.cmd', 'bin\glass.cmd',
  'engine\apaki\engine\engine.js', 'engine\apaki\engine\host-ctl.js', 'engine\apaki\engine\app-version.js', 'engine\apaki\VERSION',
  'engine\apaki\remote\protocol.js', 'engine\apaki\ui\index.html', 'engine\bin\latch.js', 'engine\package.json',
  'engine\index\target\release\latch-index.exe', 'engine\index\target\release\vcruntime140.dll',
  'engine\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe', 'engine\node_modules\node-pty\prebuilds\win32-x64\conpty.node',
  'setup\apaki-installer.ps1'
)
foreach ($f in $must) { Check (Test-Path -LiteralPath (Join-Path $dir $f)) "installed: $f" }
Check (-not (Test-Path -LiteralPath (Join-Path $dir 'engine\node_modules\node-pty\prebuilds\darwin-arm64'))) 'node-pty carries only the Windows binding'

# The engine's own code on the bundled Node.
$ver = (& $node -e "import(process.argv[1]).then((m) => process.stdout.write(m.APP_VERSION))" ([Uri](Join-Path $dir 'engine\apaki\engine\app-version.js')).AbsoluteUri) 2>&1
Check ("$ver" -eq $wantVersion) "the engine reports version $ver (apaki\VERSION says $wantVersion)"
$pty = & $node -e "require(process.argv[1]); process.stdout.write('ok')" (Join-Path $dir 'engine\node_modules\node-pty') 2>&1
Check ("$pty" -eq 'ok') "node-pty loads with the installed Node ($pty)"
$claude = & (Join-Path $dir 'engine\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe') --version 2>&1
Check ("$claude" -match '\d+\.\d+') "Claude Code runs ($claude)"
$idx = & (Join-Path $dir 'engine\index\target\release\latch-index.exe') --help 2>&1 | Select-Object -First 1
Check ($LASTEXITCODE -eq 0 -or "$idx" -ne '') "latch-index starts with the Visual C++ DLLs beside it ($idx)"

# The handoff scripts: no engine host is running here, so asking it to quit answers at once.
$ctl = & $node (Join-Path $dir 'engine\apaki\engine\host-ctl.js') quit --when-idle 2>&1
Check ($LASTEXITCODE -eq 0) "host-ctl.js answers with no host running ($ctl)"

# PATH and App Paths (the installer's post-install step).
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
Check (($userPath -split ';') -contains (Join-Path $dir 'bin')) 'the commands (apaki, latch, glass) are on the user PATH'
$appPath = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\apaki.exe' -ErrorAction SilentlyContinue).'(default)'
Check ($appPath -ieq (Join-Path $dir 'myrlin-apaki.exe')) "Win+R apaki points at the app ($appPath)"
$start = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Myrlin Apaki.lnk'
Check (Test-Path -LiteralPath $start) 'the Start menu shortcut exists'

# The app itself: starts, opens its window, connects to (or starts) its engine host.
$logDir = Join-Path $env:USERPROFILE '.claude\latch'
$winLog = Join-Path $logDir 'apaki-window.log'
if (Test-Path -LiteralPath $winLog) { Remove-Item -LiteralPath $winLog -Force }
$app = Start-Process -FilePath (Join-Path $dir 'myrlin-apaki.exe') -WorkingDirectory $dir -PassThru
$connected = $false
for ($i = 0; $i -lt 60 -and -not $connected; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path -LiteralPath $winLog) { $connected = [bool](Select-String -LiteralPath $winLog -Pattern 'connected to the engine' -Quiet) }
}
Check $connected 'the app started and connected to its engine host (apaki-window.log)'
if (-not $connected) {
  if (Test-Path -LiteralPath $winLog) { Get-Content -LiteralPath $winLog -Tail 20 | ForEach-Object { Write-Host "    window log: $_" } }
  $engLog = Join-Path $logDir 'apaki-engine.log'
  if (Test-Path -LiteralPath $engLog) { Get-Content -LiteralPath $engLog -Tail 20 | ForEach-Object { Write-Host "    engine log: $_" } }
}
$status = & $node (Join-Path $dir 'engine\apaki\engine\host-ctl.js') status 2>&1
Write-Host "    host status: $status"
Check (("$status" -match '"running":\s*true') -or $connected) 'the engine host is running'

# Close what this script started, by process id (the window, then the host once idle), then uninstall.
if ($app -and -not $app.HasExited) { $null = $app.CloseMainWindow(); Start-Sleep -Seconds 2; if (-not $app.HasExited) { Stop-Process -Id $app.Id -Force } }
$null = & $node (Join-Path $dir 'engine\apaki\engine\host-ctl.js') quit --now --wait 20 2>&1

Write-Host 'uninstalling'
$u = Start-Process -FilePath (Join-Path $dir 'uninstall.exe') -ArgumentList '/S' -PassThru -Wait
Check ($u.ExitCode -eq 0) "the uninstaller exited 0 (got $($u.ExitCode))"
# The uninstaller hands over to a copy of itself in %TEMP% and returns; wait for the files to go.
for ($i = 0; $i -lt 60 -and (Test-Path -LiteralPath (Join-Path $dir 'myrlin-apaki.exe')); $i++) { Start-Sleep -Seconds 1 }
Check (-not (Test-Path -LiteralPath (Join-Path $dir 'myrlin-apaki.exe'))) 'uninstall removed the app'
Check (-not (Test-Path -LiteralPath (Join-Path $dir 'engine'))) 'uninstall removed the engine folder'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
Check (-not (($userPath -split ';') -contains (Join-Path $dir 'bin'))) 'uninstall took the commands off the user PATH'
Check (-not (Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\apaki.exe')) 'uninstall removed App Paths\apaki.exe'

if ($failures.Count) {
  Write-Host ''
  Write-Host "$($failures.Count) check(s) failed:"
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host 'the installer installs, runs and uninstalls cleanly'
