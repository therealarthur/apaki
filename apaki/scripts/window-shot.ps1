<#
  window-shot.ps1: a PNG of one Apaki window, including its built-in
  browser pages (2026-10-09).

  WHY: since the browser is a native WebView2 laid over Apaki's own page,
  a DevTools screenshot of Apaki's page shows the pane frame but not the
  page in it. This asks Windows for the whole window instead
  (PrintWindow with PW_RENDERFULLCONTENT), which works while other windows
  cover it.

    powershell -File apaki/scripts/window-shot.ps1 -ProcessId <pid> -Out shot.png [-Width 1980 -Height 1290]

  It finds the app window itself (class "Tauri Window"; the process's
  "main window" can be the single-instance helper). A minimized window is
  restored BEHIND the other windows and not activated, so it does not jump
  in front of whoever is using the PC. -Width/-Height resize it first
  (physical pixels). Only ever point it at a dev build you started.
#>
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Width = 0,
  [int]$Height = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ApakiShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static IntPtr AppWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() == "Tauri Window") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$h = [ApakiShot]::AppWindow([uint32]$ProcessId)
if ($h -eq [IntPtr]::Zero) { throw "process $ProcessId has no Tauri window" }
$HWND_BOTTOM = [IntPtr]1
# SWP_NOSIZE 0x1, SWP_NOMOVE 0x2, SWP_NOZORDER 0x4, SWP_NOACTIVATE 0x10
if ([ApakiShot]::IsIconic($h)) {
  [void][ApakiShot]::ShowWindow($h, 4)   # SW_SHOWNOACTIVATE
  [void][ApakiShot]::SetWindowPos($h, $HWND_BOTTOM, 0, 0, 0, 0, 0x1 -bor 0x2 -bor 0x10)
  Start-Sleep -Milliseconds 600
}
if ($Width -gt 0 -and $Height -gt 0) {
  [void][ApakiShot]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $Width, $Height, 0x2 -bor 0x4 -bor 0x10)
  Start-Sleep -Milliseconds 700
}
$r = New-Object ApakiShot+RECT
[void][ApakiShot]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT (2): includes DirectComposition content such as WebView2.
$ok = [ApakiShot]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("{0}x{1} printed={2} -> {3}" -f $w, $ht, $ok, $Out)
