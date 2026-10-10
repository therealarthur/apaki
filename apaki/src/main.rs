//! Myrlin Apaki: the desktop window.
//!
//! WHY (Arthur, 2026-10-09): a dedicated app linked to Myrlin Glass, in the
//! Myrlin x Fly design system, with everything a Claude Code user expects,
//! that keeps every turn in the Claude Code session itself and follows Glass
//! between Platform credits and subscriptions.
//!
//! How it is put together:
//!   - This Rust shell owns the window and one engine process:
//!     `node apaki/engine/engine.js`, which drives Claude Code through the Agent
//!     SDK (the same runner latch uses, so Glass follow, the question hook and
//!     the session lock are shared and already tested).
//!   - The UI sends JSON commands with `engine_send`; every JSON line the
//!     engine prints is forwarded to the UI as an `engine` event.
//!   - If the engine exits, it is restarted (at most a few times a minute) and
//!     the UI is told, so a crash never leaves a dead window.
//!
//! Where the engine comes from (2026-10-09, Arthur: "built and packaged in
//! such a way where they're together"):
//!   1. Packaged: `<exe dir>\engine` holds the engine with latch's code, its
//!      node_modules and latch-index, and `<exe dir>\node\node.exe` runs it,
//!      so the installed app needs neither the repo nor a Node install.
//!      apaki\scripts\package-apaki.ps1 builds that folder.
//!   2. APAKI_ROOT, if set (a checkout to run instead).
//!   3. The checkout this crate was built in (development).
//!
//! Only one Apaki runs at a time: starting it again (the `apaki` command, the
//! shortcut) brings the open window forward instead of a second engine
//! fighting over the same session locks.
//!
//! The built-in browser (2026-10-09, browser.rs) lives here in the shell,
//! because only the shell can put a native WebView2 into the window. The
//! engine reaches it through a small request channel on the same pipes: it
//! prints {ev:"shell", id, cmd, args} (kept from the window), the shell
//! answers on the engine's stdin with {op:"shellReply", id, ok, result |
//! error}, and right after starting the engine it says what it can do with
//! {op:"shellHello", version, features}. Writes to the engine go through one
//! writer thread, so a large answer (a screenshot) never blocks the window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

mod browser;

struct Engine {
    /// Lines for the engine's stdin; a writer thread owns the pipe itself.
    stdin: Mutex<Option<Sender<String>>>,
    child: Mutex<Option<Child>>,
    restarts: Mutex<Vec<Instant>>,
}

/// The one thread that writes to the engine's stdin, in order. It ends when
/// the engine's pipe breaks or the engine is replaced (its sender dropped).
fn engine_writer(mut stdin: ChildStdin) -> Sender<String> {
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        for line in rx {
            if stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).is_err() {
                break;
            }
        }
    });
    tx
}

/// Sends one JSON line to the engine from anywhere in the shell (the browser's answers).
pub(crate) fn engine_write(app: &AppHandle, msg: &Value) {
    let state: State<Engine> = app.state();
    let guard = state.stdin.lock().unwrap();
    if let (Some(tx), Ok(mut line)) = (guard.as_ref(), serde_json::to_string(msg)) {
        line.push('\n');
        let _ = tx.send(line);
    }
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from))
}

/// The engine's root folder: the packaged copy next to the exe, else APAKI_ROOT, else the build checkout.
fn repo_root() -> PathBuf {
    if let Some(dir) = exe_dir() {
        let packaged = dir.join("engine");
        if packaged.join("apaki").join("engine").join("engine.js").is_file() {
            return packaged;
        }
    }
    std::env::var_os("APAKI_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(PathBuf::from).unwrap_or_default())
}

/// The bundled Node runtime when packaged, else `node` on PATH.
fn node_path() -> PathBuf {
    exe_dir()
        .map(|d| d.join("node").join(if cfg!(windows) { "node.exe" } else { "node" }))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn log_path() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
    let dir = home.join(".claude").join("latch");
    std::fs::create_dir_all(&dir).ok();
    dir.join("apaki-engine.log")
}

/// Starts the engine and the thread that forwards its output to the window.
fn start_engine(app: &AppHandle) -> Result<(), String> {
    let root = repo_root();
    let script = root.join("apaki").join("engine").join("engine.js");
    let log = OpenOptions::new().create(true).append(true).open(log_path()).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(node_path());
    cmd.arg(&script).current_dir(&root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(log));
    // The packaged index binary sits in the engine folder; tell latch where.
    let index = root.join("index").join("target").join("release").join(if cfg!(windows) { "latch-index.exe" } else { "latch-index" });
    if index.is_file() && std::env::var_os("LATCH_INDEX_BIN").is_none() {
        cmd.env("LATCH_INDEX_BIN", &index);
    }
    // Which app this is (a dev build has its own identifier), so state the
    // engine keeps per window, like the saved workspace, never mixes builds.
    cmd.env("APAKI_APP_ID", &app.config().identifier);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start the engine (node {}): {e}", script.display()))?;
    let stdout = child.stdout.take().ok_or("engine has no stdout")?;
    let stdin = child.stdin.take().ok_or("engine has no stdin")?;
    let state: State<Engine> = app.state();
    *state.stdin.lock().unwrap() = Some(engine_writer(stdin));
    *state.child.lock().unwrap() = Some(child);
    // First line the engine reads: what this shell can do for it.
    engine_write(app, &json!({ "op": "shellHello", "version": 1, "features": browser::features() }));

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                // A request for the shell itself (the browser), not an event for the window.
                if v.get("ev").and_then(Value::as_str) == Some("shell") {
                    browser::shell_request(&handle, v);
                    continue;
                }
                let _ = handle.emit("engine", v);
            }
        }
        let _ = handle.emit("engine", json!({ "ev": "engine_exit" }));
        restart_engine(&handle);
    });
    Ok(())
}

/// Restarts a crashed engine, unless it has crashed 5 times in a minute.
fn restart_engine(app: &AppHandle) {
    let state: State<Engine> = app.state();
    {
        let mut r = state.restarts.lock().unwrap();
        r.retain(|t| t.elapsed() < Duration::from_secs(60));
        if r.len() >= 5 {
            let _ = app.emit("engine", json!({ "ev": "error", "message": "The engine keeps stopping; see ~/.claude/latch/apaki-engine.log" }));
            return;
        }
        r.push(Instant::now());
    }
    std::thread::sleep(Duration::from_millis(400));
    if let Err(e) = start_engine(app) {
        let _ = app.emit("engine", json!({ "ev": "error", "message": e }));
    }
}

/// Sends one command (a JSON object) to the engine.
#[tauri::command]
fn engine_send(state: State<Engine>, msg: Value) -> Result<(), String> {
    let guard = state.stdin.lock().unwrap();
    let stdin = guard.as_ref().ok_or("engine is not running")?;
    let mut line = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
    line.push('\n');
    // The writer thread owns the pipe; a failed send means the engine is gone.
    stdin.send(line).map_err(|_| "engine is not running".to_string())
}

fn main() {
    tauri::Builder::default()
        // A second launch focuses the window that is already open.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(Engine { stdin: Mutex::new(None), child: Mutex::new(None), restarts: Mutex::new(Vec::new()) })
        .invoke_handler(tauri::generate_handler![engine_send, browser::browser])
        .setup(|app| {
            // The browser borrows the main webview's WebView2 environment; nothing starts until one opens.
            browser::init(app.handle());
            if let Err(e) = start_engine(app.handle()) {
                eprintln!("{e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Moved(_) = event {
                browser::parent_moved(window.app_handle());
            }
            if let tauri::WindowEvent::Destroyed = event {
                // Our own engine child only, by handle; never a process-name kill.
                let state: State<Engine> = window.state();
                state.restarts.lock().unwrap().extend(std::iter::repeat(Instant::now()).take(5));
                let child = state.child.lock().unwrap().take();
                if let Some(mut child) = child {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Myrlin Apaki");
}
