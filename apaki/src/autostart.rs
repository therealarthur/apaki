//! autostart.rs: Myrlin Apaki opens when you sign in (2026-10-15).
//!
//! Arthur, after the PC blue-screened and came back: "apaki didnt automatically start when the computer came back -
//! that needs to be fixed". Apaki had no start-at-sign-in at all (only Myrlin Glass did). tauri-plugin-autostart
//! writes the same kind of entry Glass uses: on Windows the "Myrlin Apaki" value under
//! HKCU\Software\Microsoft\Windows\CurrentVersion\Run ("<exe>" --autostart), on macOS a LaunchAgent.
//!
//! On by default: the first time this build runs it turns autostart on once and writes a marker file
//! (`autostart-chosen` in the app's config folder), so a later "off" from Settings is never undone. The window reads
//! and changes it through `autostart_get` and `autostart_set`.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// The argument the sign-in entry passes, so a start at sign-in can be told apart in the log.
pub const FLAG: &str = "--autostart";

fn marker<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("autostart-chosen"))
}

fn remember<R: Runtime>(app: &AppHandle<R>, on: bool) {
    if let Some(m) = marker(app) {
        if let Some(dir) = m.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&m, if on { "on\n" } else { "off\n" });
    }
}

/// Called from setup: logs a start at sign-in, and turns autostart on the first time (never again once chosen).
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    if std::env::args().any(|a| a == FLAG) {
        crate::wlog("started at sign-in (--autostart)");
    }
    let Some(m) = marker(app) else { return };
    if m.exists() {
        return;
    }
    match app.autolaunch().enable() {
        Ok(()) => {
            remember(app, true);
            crate::wlog("autostart: on (first run of a build that has it)");
        }
        Err(e) => crate::wlog(&format!("autostart: could not turn it on: {e}")),
    }
}

/// Whether Apaki opens when you sign in.
#[tauri::command]
pub fn autostart_get<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Turns opening at sign-in on or off, and remembers the choice so the first-run default never overrides it.
#[tauri::command]
pub fn autostart_set<R: Runtime>(app: AppHandle<R>, on: bool) -> Result<bool, String> {
    let r = if on { app.autolaunch().enable() } else { app.autolaunch().disable() };
    r.map_err(|e| e.to_string())?;
    remember(&app, on);
    crate::wlog(&format!("autostart: {} (from Settings)", if on { "on" } else { "off" }));
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}
