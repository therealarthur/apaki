//! updater.rs: Myrlin Apaki updates itself (2026-10-13).
//!
//! WHY (Arthur, 2026-10-12): releases are built by GitHub Actions on a version tag and the desktop apps update through
//! Tauri's updater plugin from GitHub Releases ("every app keeps in step"). The plugin does the dangerous parts: it
//! fetches the feed (latest.json, plugins.updater.endpoints in tauri.conf.json), refuses anything whose signature does
//! not verify against the public key in the same file (and, with requireSignedVersion, anything signed for another
//! version than the feed announces, so an old signed build cannot be replayed as a new one), and runs the installer.
//! This file decides when, and tells the window.
//!
//! When it asks: a packaged app asks 45 seconds after it starts and every 4 hours after that. An app that runs from a
//! checkout (cargo run, no engine folder beside it) never asks, so developing Apaki never installs a release over the
//! work; APAKI_UPDATE_ENDPOINT names another feed and turns asking on anywhere (testing the updater, or a copy of the app
//! that updates from somewhere else). A feed that cannot be reached or does not parse is only logged
//! (~/.claude/latch/apaki-window.log); nothing is shown for it.
//!
//! What the person sees: nothing until an update is downloaded and verified. Then updater.js (injected into the window)
//! shows one quiet card, "Update ready", with Later and Restart. Nothing installs without Restart; an update that was
//! downloaded and not installed is simply asked for again after the next start.
//!
//! Installing: update_install gives the window's last messages to the engine a moment to go out, then the plugin installs.
//!   Windows: the plugin runs the NSIS installer (passive: a progress bar, no questions) and exits this app; the installer
//!     asks the background engine to retire once idle and moves files it still runs aside (apaki/nsis/hooks.nsh), puts the
//!     new files in, and starts the new app. Sessions that are working keep working: the engine host outlives the window and
//!     notices new files by itself (host.js codeStamp).
//!   macOS: the plugin replaces the .app in place and this app restarts itself.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{mac, wlog};

/// How long after the app starts before the first look at the feed (the window and the engine come first).
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(45);
/// How often a running app looks again.
const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);
/// A feed address that replaces the one in tauri.conf.json (tests, self-hosting); it also turns checking on for a checkout.
const ENDPOINT_ENV: &str = "APAKI_UPDATE_ENDPOINT";
/// Queued messages to the engine (the last workspace save) get this long to leave before the installer ends the app.
const FLUSH_BEFORE_INSTALL: Duration = Duration::from_millis(400);

/// What the window is told: state is "idle", "checking", "downloading", "ready" or "error".
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub state: &'static str,
    /// The version running now.
    pub current: String,
    /// The newer version, once one is known.
    pub version: Option<String>,
    pub notes: Option<String>,
    pub error: Option<String>,
}

struct Inner {
    status: Status,
    /// The verified download, kept until Restart installs it.
    ready: Option<(Update, Vec<u8>)>,
    busy: bool,
}

pub struct Updates(Mutex<Inner>);

impl Updates {
    pub fn new(current: String) -> Self {
        Updates(Mutex::new(Inner { status: Status { state: "idle", current, version: None, notes: None, error: None }, ready: None, busy: false }))
    }
}

/// Does this process run a packaged app (engine and Node beside the executable or in the .app's Resources)?
fn packaged() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .map(|dir| mac::bundle_dirs(&dir).iter().any(|d| d.join("engine").join("apaki").join("engine").join("engine.js").is_file()))
        .unwrap_or(false)
}

/// Should this process look at the feed by itself?
fn enabled() -> bool {
    std::env::var_os(ENDPOINT_ENV).is_some() || packaged()
}

fn set(app: &AppHandle, f: impl FnOnce(&mut Inner)) -> Status {
    let state: State<Updates> = app.state();
    let status = {
        let mut inner = state.0.lock().unwrap();
        f(&mut inner);
        inner.status.clone()
    };
    let _ = app.emit("apaki-update", status.clone());
    status
}

/// Looks at the feed once; downloads and verifies an update when there is a newer one. Never installs.
async fn check_once(app: &AppHandle) -> Status {
    {
        let state: State<Updates> = app.state();
        let mut inner = state.0.lock().unwrap();
        // One look at a time, and nothing more to look for once an update waits to be installed.
        if inner.busy || inner.status.state == "ready" {
            return inner.status.clone();
        }
        inner.busy = true;
    }
    set(app, |i| i.status.state = "checking");
    let result = look(app).await;
    match result {
        Ok(Some((update, bytes))) => {
            wlog(&format!("updater: version {} is downloaded and verified, waiting for Restart", update.version));
            set(app, |i| {
                i.status.state = "ready";
                i.status.version = Some(update.version.clone());
                i.status.notes = update.body.clone();
                i.status.error = None;
                i.ready = Some((update, bytes));
                i.busy = false;
            })
        }
        Ok(None) => set(app, |i| {
            i.status.state = "idle";
            i.status.error = None;
            i.busy = false;
        }),
        Err(e) => {
            wlog(&format!("updater: {e}"));
            set(app, |i| {
                i.status.state = "error";
                i.status.error = Some(e);
                i.busy = false;
            })
        }
    }
}

/// The feed, then the download. Err is a sentence for the log.
async fn look(app: &AppHandle) -> Result<Option<(Update, Vec<u8>)>, String> {
    let mut builder = app.updater_builder();
    if let Ok(raw) = std::env::var(ENDPOINT_ENV) {
        let url: Url = raw.parse().map_err(|e| format!("{ENDPOINT_ENV} is not an address ({e})"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| format!("could not set the updater up: {e}"))?;
    let Some(update) = updater.check().await.map_err(|e| format!("could not read the update feed: {e}"))? else {
        return Ok(None);
    };
    wlog(&format!("updater: version {} is available (this is {}); downloading", update.version, update.current_version));
    set(app, |i| {
        i.status.state = "downloading";
        i.status.version = Some(update.version.clone());
    });
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| format!("could not download version {}: {e}", update.version))?;
    Ok(Some((update, bytes)))
}

/// Starts the checking loop (packaged apps, or when APAKI_UPDATE_ENDPOINT is set) and keeps the state for the window.
pub fn init(app: &AppHandle) {
    app.manage(Updates::new(app.package_info().version.to_string()));
    if !enabled() {
        wlog("updater: not checking (running from a checkout; set APAKI_UPDATE_ENDPOINT to try an update feed)");
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        loop {
            let s = check_once(&handle).await;
            if s.state == "ready" {
                // Nothing more to find until it is installed; the window has been told.
                break;
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// The state, for the window when it loads (it may have missed the event).
#[tauri::command]
pub fn update_status(state: State<Updates>) -> Status {
    state.0.lock().unwrap().status.clone()
}

/// Looks at the feed now (scripts and the window's console; the window itself checks by the clock).
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Status {
    check_once(&app).await
}

/// Installs the downloaded update. Windows: returns only if the installer could not start (the app is gone otherwise);
/// macOS: replaces the app and restarts it.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let taken = {
        let state: State<Updates> = app.state();
        let mut inner = state.0.lock().unwrap();
        inner.ready.take()
    };
    let Some((update, bytes)) = taken else {
        return Err("there is no downloaded update to install".to_string());
    };
    wlog(&format!("updater: installing version {}", update.version));
    // The window's last messages (its workspace save) are queued for the engine; give them a moment to leave.
    std::thread::sleep(FLUSH_BEFORE_INSTALL);
    let version = update.version.clone();
    match update.install(&bytes) {
        Ok(()) => {
            // Only macOS and Linux get here: Windows ended the process when the installer started.
            wlog(&format!("updater: version {version} is in place, restarting"));
            app.restart();
        }
        Err(e) => {
            wlog(&format!("updater: installing version {version} failed: {e}"));
            // Keep it: Restart can be tried again.
            let state: State<Updates> = app.state();
            state.0.lock().unwrap().ready = Some((update, bytes));
            Err(e.to_string())
        }
    }
}

/// The page script (updater.js), added to every window the app creates.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("apaki-updater").js_init_script(include_str!("updater.js").to_string()).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_starts_idle_with_the_running_version() {
        let u = Updates::new("0.1.0".to_string());
        let s = u.0.lock().unwrap().status.clone();
        assert_eq!(s.state, "idle");
        assert_eq!(s.current, "0.1.0");
        assert!(s.version.is_none() && s.error.is_none());
    }
}
