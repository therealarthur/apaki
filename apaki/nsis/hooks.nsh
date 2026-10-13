; hooks.nsh: what Myrlin Apaki's Windows installer does around Tauri's own steps (apaki/tauri.windows.bundle.conf.json,
; bundle.windows.nsis.installerHooks). 2026-10-13.
;
; WHY: install-apaki.ps1 used to do these things; the installer Tauri's bundler builds replaces it (and is what the
; updater runs for an update), so the parts users need live here. The work itself is in apaki-installer.ps1 (same
; folder), which the installer carries and runs; it never fails the installation.
;
;   PREINSTALL    the background engine host is asked to exit once idle (host-ctl.js quit --when-idle) and files
;                 something still runs are moved aside, so the copy goes on without anything being killed
;   POSTINSTALL   the apaki, latch and glass commands go on the user PATH, App Paths\apaki.exe is set (Win+R "apaki"), the
;                 engine host runs again if it ran before, and a person at the screen (not an update, not a silent
;                 install) is offered Claude Code's sign-in when this PC has none
;   PREUNINSTALL  the host is asked to exit, the commands leave the PATH, App Paths goes
;   POSTUNINSTALL the engine, node and bin folders (all made by the installer, none holds user data) and the helper go;
;                 voice\ and Myrlin Glass are not ours to remove, and ~\.claude\latch (history, index) stays
;
; Start Menu and Desktop shortcuts and the WebView2 runtime are Tauri's template (webviewInstallMode in the bundle config).

!define APAKI_HELPER_SRC "${__FILEDIR__}\apaki-installer.ps1"
!define APAKI_POWERSHELL "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  File "/oname=$PLUGINSDIR\apaki-installer.ps1" "${APAKI_HELPER_SRC}"
  DetailPrint "Asking Apaki's background engine to finish its work"
  nsExec::ExecToLog '"${APAKI_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\apaki-installer.ps1" -Action pre-install -InstallDir "$INSTDIR"'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Kept for the uninstaller (an uninstaller cannot extract files of its own).
  CreateDirectory "$INSTDIR\setup"
  File "/oname=$INSTDIR\setup\apaki-installer.ps1" "${APAKI_HELPER_SRC}"
  nsExec::ExecToLog '"${APAKI_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\setup\apaki-installer.ps1" -Action post-install -InstallDir "$INSTDIR"'
  Pop $0
  ; Claude Code's sign-in, offered to a person at the screen on a first install. An update or a silent/passive
  ; install never asks (it may run unattended).
  ${If} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
  ${AndIfNot} ${Silent}
    nsExec::ExecToLog '"${APAKI_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\setup\apaki-installer.ps1" -Action login-status -InstallDir "$INSTDIR"'
    Pop $0
    ${If} $0 = 3
      MessageBox MB_YESNO|MB_ICONQUESTION "Claude is not signed in on this PC.$\r$\n$\r$\nSign in now? A window opens and finishes in your browser. You can also sign in later: Sign in to Claude in Apaki's Glass panel, or run: latch login" IDNO apaki_no_signin
      Exec '"${APAKI_POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\setup\apaki-installer.ps1" -Action sign-in -InstallDir "$INSTDIR"'
      apaki_no_signin:
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\setup\apaki-installer.ps1" 0 +3
    nsExec::ExecToLog '"${APAKI_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\setup\apaki-installer.ps1" -Action pre-uninstall -InstallDir "$INSTDIR"'
    Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\setup\apaki-installer.ps1"
  RMDir "$INSTDIR\setup"
  RMDir /r "$INSTDIR\engine"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\bin"
!macroend
