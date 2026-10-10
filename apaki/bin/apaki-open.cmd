@echo off
rem apaki-open.cmd: the BROWSER Myrlin Apaki sets for Claude Code. Hands the
rem URL to apaki-open.mjs, which opens it inside Apaki (see that file).
rem cmd's own command line goes along through delayed expansion, which is
rem never parsed again, so a URL cut at an unquoted "&" is recovered there;
rem exit code 3 means "cmd was started just for this", and exit then ends cmd
rem before it can run the cut-off rest of the URL as a command.
setlocal EnableDelayedExpansion
set "APAKI_OPEN_CMDLINE=!CMDCMDLINE!"
setlocal DisableDelayedExpansion
set "APAKI_OPEN_NODE=node"
if defined APAKI_NODE set "APAKI_OPEN_NODE=%APAKI_NODE%"
"%APAKI_OPEN_NODE%" "%~dp0apaki-open.mjs" %*
if errorlevel 3 exit 0
exit /b %errorlevel%
