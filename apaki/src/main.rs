//! Myrlin Apaki: the desktop window.
//!
//! WHY (Arthur, 2026-10-09): a dedicated app linked to Myrlin Glass, in the
//! Myrlin x Fly design system, with everything a Claude Code user expects,
//! that keeps every turn in the Claude Code session itself and follows Glass
//! between Platform credits and subscriptions.
//!
//! How it is put together:
//!   - This Rust shell owns the window and talks to one engine:
//!     `node apaki/engine/engine.js`, which drives Claude Code through the Agent
//!     SDK (the same runner latch uses, so Glass follow, the question hook and
//!     the session lock are shared and already tested).
//!   - The UI sends JSON commands with `engine_send`; every JSON line the
//!     engine prints is forwarded to the UI as an `engine` event.
//!   - If the engine goes away, the shell connects to (or starts) a new one,
//!     at most a few times a minute, and the UI is told, so a crash never
//!     leaves a dead window.
//!
//! The engine outlives the window (2026-10-10, Arthur: "apaki closing should
//! not close the claude sessions that are open - they should all just move to
//! the background until they stop naturally or are stopped"): it runs as a
//! detached background host, one per app id (`engine.js --host`, design in
//! apaki/engine/host.js, this side in host.rs). At start the shell connects to
//! the running host of its app id, or starts one and connects; the same JSON
//! lines travel over an authenticated 127.0.0.1 connection instead of the
//! engine's stdin and stdout. Closing the window only disconnects: running
//! turns finish, questions wait, and the next window takes the panes over
//! where they are. If the host stops, the window says so and starts a new one.
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
//! engine reaches it through a small request channel on the same connection:
//! it sends {ev:"shell", id, cmd, args} (kept from the window), the shell
//! answers with {op:"shellReply", id, ok, result | error}, and right after
//! connecting it says what it can do with {op:"shellHello", version,
//! features}. Writes to the engine go through one writer thread, so a large
//! answer (a screenshot) never blocks the window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::{BufRead, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

mod browser;
mod host;
// macOS only in what it does: the menu bar, the page tweaks, the PATH; its pure helpers (bundle folders) run everywhere.
mod mac;

/// How long a host this window started may take to answer.
const HOST_START_TIMEOUT: Duration = Duration::from_secs(45);
/// Engine events kept for a page that is not listening yet (at most this many, oldest dropped).
const EARLY_EVENTS_MAX: usize = 5000;

struct Engine {
    /// Lines for the engine; a writer thread owns the connection. None while
    /// reconnecting, so a message is refused (as it was while the engine
    /// restarted) instead of reaching a host that never saw this window's panes.
    stdin: Mutex<Option<Sender<String>>>,
    restarts: Mutex<Vec<Instant>>,
    /// Which connection is current: a reader that ends on an older one does nothing (2026-10-11).
    gen: std::sync::atomic::AtomicU64,
    /// The window is closing: the connection ending is expected and nothing restarts.
    closing: AtomicBool,
    /// Signalled once the writer thread has sent everything and closed the connection.
    flushed: Mutex<Option<Receiver<()>>>,
    /// Events that arrived before the page listened (Some until its first engine_send).
    /// A host that is already running answers within milliseconds, before the
    /// page has registered its `engine` listener; app.js always listens before
    /// it sends anything, so its first command means it is ready.
    early: Mutex<Option<Vec<Value>>>,
}

/// One engine event for the page: now, or kept until the page listens.
fn to_window(app: &AppHandle, v: Value) {
    let state: State<Engine> = app.state();
    let mut early = state.early.lock().unwrap();
    if let Some(buf) = early.as_mut() {
        if buf.len() >= EARLY_EVENTS_MAX {
            buf.remove(0);
        }
        buf.push(v);
        return;
    }
    drop(early);
    let _ = app.emit("engine", v);
}

/// The one thread that writes to the engine, in order. It ends when the
/// connection breaks or its sender is dropped (the window closes, or the
/// engine is replaced), then closes the connection and says so.
fn engine_writer(mut stream: TcpStream, rx: Receiver<String>) -> Receiver<()> {
    let (done_tx, done_rx) = channel::<()>();
    std::thread::spawn(move || {
        for line in rx {
            if let Err(e) = stream.write_all(line.as_bytes()).and_then(|_| stream.flush()) {
                wlog(&format!("writing to the engine failed: {e} ({:?})", e.kind()));
                break;
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
        let _ = done_tx.send(());
    });
    done_rx
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

/// The engine's root folder: the packaged copy next to the exe (Windows) or in the .app's Contents/Resources (macOS,
/// where Tauri's bundle.resources puts it), else APAKI_ROOT, else the build checkout.
fn repo_root() -> PathBuf {
    if let Some(dir) = exe_dir() {
        for d in mac::bundle_dirs(&dir) {
            let packaged = d.join("engine");
            if packaged.join("apaki").join("engine").join("engine.js").is_file() {
                return packaged;
            }
        }
    }
    std::env::var_os("APAKI_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(PathBuf::from).unwrap_or_default())
}

/// The bundled Node runtime when packaged, else `node` on PATH.
fn node_path() -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    exe_dir()
        .into_iter()
        .flat_map(|d| mac::bundle_dirs(&d))
        .map(|d| d.join("node").join(name))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn log_path() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
    let dir = home.join(".claude").join("latch");
    std::fs::create_dir_all(&dir).ok();
    dir.join("apaki-engine.log")
}

/// One line in ~/.claude/latch/apaki-window.log (2026-10-11): the window's own connection story (connected, ended
/// and why, reconnecting), which a Windows GUI program cannot print anywhere else. Kept under about 1 MB.
fn wlog(msg: &str) {
    let path = log_path().with_file_name("apaki-window.log");
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{secs} pid {} {msg}", std::process::id());
    }
}

/// The running host of this app id, or a new one this window starts, connected and authenticated.
fn connect_or_start(app: &AppHandle, root: &Path, script: &Path) -> Result<host::Connected, String> {
    let app_id = app.config().identifier.clone();
    let file = host::host_file(&app_id);
    if let Some(info) = host::read_info(&file) {
        match host::connect(&info, &app_id) {
            Ok(c) => return Ok(c),
            Err(e) => eprintln!("apaki: the engine host (pid {}) did not answer ({e}); starting one", info.pid),
        }
    }
    let log = OpenOptions::new().create(true).append(true).open(log_path()).map_err(|e| e.to_string())?;
    let mut envs: Vec<(&str, std::ffi::OsString)> = vec![
        // Which app this is (a dev build has its own identifier), so state the
        // engine keeps per window, like the saved workspace, never mixes builds.
        ("APAKI_APP_ID", app_id.clone().into()),
        // The exact file this window reads, so the host writes its address there.
        ("APAKI_HOST_FILE", file.clone().into_os_string()),
        // What this shell can do (the browser), known before the window connects.
        ("APAKI_SHELL_FEATURES", browser::features().join(",").into()),
    ];
    // A Dock-started Mac app has launchd's short PATH; the host gets Homebrew's, ~/.local/bin and the like too (git, gh, codex).
    #[cfg(target_os = "macos")]
    if let Some(p) = mac::host_path() {
        envs.push(("PATH", p));
    }
    // The packaged index binary sits in the engine folder; tell latch where.
    let index = root.join("index").join("target").join("release").join(if cfg!(windows) { "latch-index.exe" } else { "latch-index" });
    if index.is_file() && std::env::var_os("LATCH_INDEX_BIN").is_none() {
        envs.push(("LATCH_INDEX_BIN", index.into_os_string()));
    }
    let mut child = host::spawn_host(&node_path(), script, root, &envs, &log)
        .map_err(|e| format!("could not start the engine (node {}): {e}", script.display()))?;
    let deadline = Instant::now() + HOST_START_TIMEOUT;
    loop {
        std::thread::sleep(Duration::from_millis(150));
        if let Some(info) = host::read_info(&file) {
            if let Ok(c) = host::connect(&info, &app_id) {
                return Ok(c);
            }
        }
        // It ended: an error, or another host already serves this app id (then that one answers above).
        if let Ok(Some(status)) = child.try_wait() {
            if let Some(Ok(c)) = host::read_info(&file).map(|info| host::connect(&info, &app_id)) {
                return Ok(c);
            }
            return Err(format!("the engine stopped as it started ({status}); see ~/.claude/latch/apaki-engine.log"));
        }
        if Instant::now() > deadline {
            return Err("the engine did not start in time; see ~/.claude/latch/apaki-engine.log".into());
        }
    }
}

/// Connects to the engine (starting it if needed) and starts the threads that
/// carry its lines. `pending` holds what the window sent before the first
/// connection (its start-up requests); a reconnect starts with a new queue.
fn start_engine(app: &AppHandle, pending: Option<Receiver<String>>) -> Result<(), String> {
    let root = repo_root();
    let script = root.join("apaki").join("engine").join("engine.js");
    let host::Connected { stream, reader, ok } = connect_or_start(app, &root, &script)?;
    let state: State<Engine> = app.state();
    let my_gen = state.gen.fetch_add(1, Ordering::SeqCst) + 1;
    wlog(&format!("connection {my_gen}: connected to the engine (pid {}, stamp {})", ok.get("pid").and_then(Value::as_u64).unwrap_or(0), ok.get("stamp").and_then(Value::as_str).unwrap_or("?")));
    let rx = match pending {
        Some(rx) => rx,
        None => {
            let (tx, rx) = channel::<String>();
            *state.stdin.lock().unwrap() = Some(tx);
            rx
        }
    };
    // First lines the engine reads (before anything queued): what this shell can do for it.
    let mut first = stream.try_clone().map_err(|e| e.to_string())?;
    let mut hello = json!({ "op": "shellHello", "version": 1, "features": browser::features() }).to_string();
    hello.push('\n');
    // A host of another build (an update copied in under it, another checkout
    // with the same app id) keeps serving this window, so nothing running is
    // lost, and exits once idle with no window; the next window starts a fresh one.
    // Absolute like Node's path.resolve (symlinks kept), so a relative APAKI_ROOT compares right.
    let root_now = std::path::absolute(&root).unwrap_or_else(|_| root.clone()).to_string_lossy().to_string();
    let host_root = ok.get("root").and_then(Value::as_str).unwrap_or("");
    let host_stamp = ok.get("stamp").and_then(Value::as_str).unwrap_or("");
    if !host::same_root(host_root, &root_now) || host_stamp != host::engine_stamp(&script) {
        eprintln!("apaki: the engine host runs another build ({host_root}, {host_stamp}); it retires once idle");
        hello.push_str(&json!({ "op": "hostQuit", "whenIdle": true, "by": "an Apaki window of another build" }).to_string());
        hello.push('\n');
    }
    first.write_all(hello.as_bytes()).and_then(|_| first.flush()).map_err(|e| e.to_string())?;
    *state.flushed.lock().unwrap() = Some(engine_writer(stream, rx));

    let handle = app.clone();
    std::thread::spawn(move || {
        // Lines read as bytes (2026-10-11): one line that is not valid UTF-8 no longer ends the connection, as
        // BufRead::lines did; an interrupted read is retried. Why it ended goes to apaki-window.log.
        let mut reader = reader;
        let mut buf: Vec<u8> = Vec::new();
        let why = loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break "the engine closed the connection".to_string(),
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf);
                    let line = text.trim_end_matches(['\r', '\n']);
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(line) {
                        // A request for the shell itself (the browser), not an event for the window.
                        if v.get("ev").and_then(Value::as_str) == Some("shell") {
                            browser::shell_request(&handle, v);
                            continue;
                        }
                        to_window(&handle, v);
                    }
                }
                // A timeout is not an ended connection: a quiet engine is still there (2026-10-11, see host::connect).
                Err(e) if matches!(e.kind(), std::io::ErrorKind::Interrupted | std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock) => continue,
                Err(e) => break format!("reading from the engine failed: {e} ({:?})", e.kind()),
            }
        };
        wlog(&format!("connection {my_gen} ended: {why}"));
        let state: State<Engine> = handle.state();
        if state.closing.load(Ordering::SeqCst) {
            return;
        }
        // A newer connection is already live (this one was replaced): nothing to restart.
        if state.gen.load(Ordering::SeqCst) != my_gen {
            wlog(&format!("connection {my_gen}: a newer connection is live; not reconnecting"));
            return;
        }
        // The engine went away: refuse messages until a new one answers.
        drop(state.stdin.lock().unwrap().take());
        to_window(&handle, json!({ "ev": "engine_exit" }));
        restart_engine(&handle);
    });
    Ok(())
}

/// Reconnects to (or starts) the engine after it went away. It never gives up (2026-10-11: an update's old
/// background engine exiting just as the new window started used up the old limit of 5 tries a minute and
/// left the window with no engine): the wait grows with the recent tries, 0.4 s doubling to 10 s, and the
/// window is told once per minute of trouble instead of on every try.
fn restart_engine(app: &AppHandle) {
    let state: State<Engine> = app.state();
    let wait = {
        let mut r = state.restarts.lock().unwrap();
        r.retain(|t| t.elapsed() < Duration::from_secs(60));
        if r.len() == 5 {
            to_window(app, json!({ "ev": "note", "tone": "warn", "text": "Still reconnecting to the engine; Apaki keeps trying (details in ~/.claude/latch/apaki-engine.log)." }));
        }
        r.push(Instant::now());
        let tries = u32::try_from(r.len()).unwrap_or(u32::MAX).saturating_sub(1).min(5);
        Duration::from_millis((400u64 << tries).min(10_000))
    };
    wlog(&format!("reconnecting in {} ms", wait.as_millis()));
    std::thread::sleep(wait);
    if state.closing.load(Ordering::SeqCst) {
        return;
    }
    if let Err(e) = start_engine(app, None) {
        // Logged, not shown: the window already says it is reconnecting, and the next try follows.
        wlog(&format!("reconnecting to the engine failed: {e}"));
        restart_engine(app);
    }
}

/// Sends one command (a JSON object) to the engine.
#[tauri::command]
fn engine_send(app: AppHandle, state: State<Engine>, msg: Value) -> Result<(), String> {
    // The page's first command: it listens now, so what arrived before goes to it first.
    // The lock is held while they go out, so a newer event (to_window) cannot pass them.
    {
        let mut early = state.early.lock().unwrap();
        for v in early.take().unwrap_or_default() {
            let _ = app.emit("engine", v);
        }
    }
    let guard = state.stdin.lock().unwrap();
    let stdin = guard.as_ref().ok_or("engine is not running")?;
    let mut line = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
    line.push('\n');
    // The writer thread owns the connection; a failed send means the engine is gone.
    stdin.send(line).map_err(|_| "engine is not running".to_string())
}

fn main() {
    let builder = tauri::Builder::default();
    // macOS: the page tweaks for the native traffic lights (mac.js) and the menu bar's Quit / Close Window.
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(mac::plugin()).on_menu_event(mac::on_menu_event);
    builder
        // A second launch focuses the window that is already open.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(Engine { stdin: Mutex::new(None), restarts: Mutex::new(Vec::new()), gen: std::sync::atomic::AtomicU64::new(0), closing: AtomicBool::new(false), flushed: Mutex::new(None), early: Mutex::new(Some(Vec::new())) })
        .invoke_handler(tauri::generate_handler![engine_send, browser::browser])
        .setup(|app| {
            // The browser borrows the main webview's WebView2 environment; nothing starts until one opens.
            browser::init(app.handle());
            #[cfg(target_os = "macos")]
            mac::install_menu(app.handle())?;
            // What the window sends before the engine answers (its start-up
            // requests) waits in this queue; connecting, or starting a host,
            // runs off the main thread so the window opens at once.
            let (tx, rx) = channel::<String>();
            let state: State<Engine> = app.state();
            *state.stdin.lock().unwrap() = Some(tx);
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = start_engine(&handle, Some(rx)) {
                    eprintln!("{e}");
                    drop(handle.state::<Engine>().stdin.lock().unwrap().take());
                    to_window(&handle, json!({ "ev": "error", "message": e }));
                    restart_engine(&handle);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Moved(_) = event {
                browser::parent_moved(window.app_handle());
            }
            if let tauri::WindowEvent::Destroyed = event {
                // Closing only disconnects: the engine host keeps every Claude
                // Code session going (host.js). What was already queued for it
                // (the last workspace save) goes out first, briefly waited for.
                let state: State<Engine> = window.state();
                state.closing.store(true, Ordering::SeqCst);
                drop(state.stdin.lock().unwrap().take());
                let flushed = state.flushed.lock().unwrap().take();
                if let Some(done) = flushed {
                    let _ = done.recv_timeout(Duration::from_millis(1500));
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Myrlin Apaki");
}
