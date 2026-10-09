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
//! The repo root is where this crate was built (APAKI_ROOT overrides), since
//! the engine runs latch's code from there.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

struct Engine {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    restarts: Mutex<Vec<Instant>>,
}

fn repo_root() -> PathBuf {
    std::env::var_os("APAKI_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(PathBuf::from).unwrap_or_default())
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
    let mut cmd = Command::new("node");
    cmd.arg(&script).current_dir(&root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(log));
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
    *state.stdin.lock().unwrap() = Some(stdin);
    *state.child.lock().unwrap() = Some(child);

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
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
    let mut guard = state.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("engine is not running")?;
    let mut line = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(Engine { stdin: Mutex::new(None), child: Mutex::new(None), restarts: Mutex::new(Vec::new()) })
        .invoke_handler(tauri::generate_handler![engine_send])
        .setup(|app| {
            if let Err(e) = start_engine(app.handle()) {
                eprintln!("{e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
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
