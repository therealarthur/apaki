//! browser.rs: Myrlin Apaki's built-in browser.
//!
//! WHY (Arthur, 2026-10-09: "a built-in browser like Codex's, driven by
//! Claude, light and fast"): a browser pane beside the conversation, in
//! Apaki's own window, that Claude can open, read, click, type into and look
//! at, and that the user sees and uses like any browser.
//!
//! WHY a plain WebView2 controller instead of a Tauri child webview: Tauri
//! puts its IPC bridge (__TAURI_INTERNALS__, and __TAURI__ with
//! withGlobalTauri) into every webview it creates and answers their calls.
//! A page from the internet must have none of that. So the browser is a bare
//! WebView2 controller made here, in Apaki's own WebView2 environment (the
//! same runtime and browser process, nothing extra to download), under a
//! separate profile ("apaki-browser": its own cookies and storage, nothing
//! shared with Apaki's own page), with web messages and host objects off. It
//! is in no Tauri capability because it is not a Tauri webview at all, and no
//! handler of any kind listens to it, so nothing in it can reach Tauri, the
//! app's commands or the engine.
//!
//! Who drives it (everything runs on the main thread, where WebView2 lives):
//!   - the window (ui/browser.js) with one command, invoke('browser', { cmd, args });
//!   - Claude, through the engine: it prints {ev:"shell", id, cmd:"browser.<cmd>", args}
//!     on stdout, main.rs hands that to `shell_request`, and the answer goes
//!     back on the engine's stdin as {op:"shellReply", id, ok, result | error}.
//! Commands: open, go, nav, place, focus, focusApp, snapshot, cdp, state,
//! list, close, theme. Page control is WebView2's own DevTools protocol channel
//! (CallDevToolsProtocolMethod): no remote debugging port, no Playwright, no
//! injected bridge; the engine composes reads, clicks, typing and
//! screenshots from it (apaki/engine/browser-tools.js).
//! Events to the window: Tauri event "browser" with ev created | reveal |
//! state | focus | key | closeRequested | closed.
//! Idle cost: nothing exists until the first browser is opened; after that
//! only WebView2's own events, no timers.

use serde_json::{json, Value};
use tauri::AppHandle;

/// An answer to one command, called once, on the main thread.
pub type Reply = Box<dyn FnOnce(Result<Value, String>) + Send + 'static>;

/// What the shell tells the engine it can do (shellHello).
pub fn features() -> Vec<&'static str> {
    if cfg!(windows) {
        vec!["browser"]
    } else {
        vec![]
    }
}

#[cfg(windows)]
pub use imp::{dispatch, init, parent_moved};

#[cfg(not(windows))]
pub fn init(_app: &AppHandle) {}

#[cfg(not(windows))]
pub fn parent_moved(_app: &AppHandle) {}

#[cfg(not(windows))]
pub fn dispatch(_app: &AppHandle, _cmd: String, _args: Value, reply: Reply) {
    reply(Err("Apaki's built-in browser needs Windows for now.".into()));
}

/// One request from the engine: {ev:"shell", id, cmd:"browser.<name>", args}.
/// The answer goes back on the engine's stdin, matched by id.
pub fn shell_request(app: &AppHandle, msg: Value) {
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let cmd = msg.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
    let args = msg.get("args").cloned().unwrap_or(Value::Null);
    let handle = app.clone();
    let reply: Reply = Box::new(move |r| {
        let line = match r {
            Ok(result) => json!({ "op": "shellReply", "id": id, "ok": true, "result": result }),
            Err(error) => json!({ "op": "shellReply", "id": id, "ok": false, "error": error }),
        };
        crate::engine_write(&handle, &line);
    });
    match cmd.strip_prefix("browser.") {
        Some(name) => dispatch(app, name.to_string(), args, reply),
        None => reply(Err(format!("The Apaki shell has no command \"{cmd}\"."))),
    }
}

/// The window's one browser command: invoke('browser', { cmd, args }).
#[tauri::command]
pub async fn browser(app: AppHandle, cmd: String, args: Option<Value>) -> Result<Value, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    dispatch(&app, cmd, args.unwrap_or(Value::Null), Box::new(move |r| {
        let _ = tx.send(r);
    }));
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(30)).unwrap_or_else(|_| Err("Apaki's browser did not answer.".into()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
mod imp {
    use super::Reply;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::OnceLock;

    use serde_json::{json, Value};
    use tauri::{AppHandle, Emitter, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{
        take_pwstr, AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler,
        CreateCoreWebView2ControllerCompletedHandler, DocumentTitleChangedEventHandler, FocusChangedEventHandler,
        HistoryChangedEventHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler,
        NewWindowRequestedEventHandler, ProcessFailedEventHandler, SourceChangedEventHandler, WindowCloseRequestedEventHandler,
    };
    use windows::core::{w, Interface, BOOL, HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{E_POINTER, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, SetFocus, VK_CONTROL, VK_SHIFT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindow, LoadCursorW, RegisterClassExW, SetWindowPos, GW_CHILD,
        HWND_TOP, IDC_ARROW, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_SHOWWINDOW, WINDOW_EX_STYLE, WM_SETFOCUS, WNDCLASSEXW,
        WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
    };

    /// The browser's own WebView2 profile inside Apaki's data folder.
    const PROFILE: &str = "apaki-browser";
    const CLASS: PCWSTR = w!("ApakiBrowserHost");
    const NO_BROWSER: &str = "No browser is open for this conversation. Open a page with browser_open first.";

    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// The main window's HWND, the browsers' parent.
    static PARENT: AtomicIsize = AtomicIsize::new(0);
    static CLASS_READY: AtomicBool = AtomicBool::new(false);

    /// A browser's live WebView2 objects (main thread only).
    #[derive(Clone)]
    struct Live {
        ctl: ICoreWebView2Controller,
        wv: ICoreWebView2,
    }

    struct Browser {
        owner: Option<String>,
        /// Our own child window inside Apaki's window; the controller lives in it.
        host: isize,
        live: Option<Live>,
        /// Work that arrived while the controller was still being created.
        queued: Vec<Box<dyn FnOnce(&Live)>>,
        url: String,
        title: String,
        loading: bool,
        back: bool,
        forward: bool,
        status: Option<i32>,
        error: Option<String>,
        /// The window wants it on screen.
        shown: bool,
        /// Screenshots in flight while hidden (they need it to render).
        rendering: u32,
        rect: (i32, i32, i32, i32),
        /// Last use by Claude or the user, to pick a conversation's current browser.
        used: u64,
        /// Answers waiting for the navigation in progress to finish.
        waiters: Vec<Reply>,
    }

    thread_local! {
        static BROWSERS: RefCell<HashMap<String, Browser>> = RefCell::new(HashMap::new());
        static ENV: RefCell<Option<ICoreWebView2Environment>> = const { RefCell::new(None) };
        /// Apaki's own page, to hand the keyboard back to it (Ctrl+L in a page).
        static MAIN: RefCell<Option<ICoreWebView2Controller>> = const { RefCell::new(None) };
        static DARK: Cell<bool> = const { Cell::new(false) };
        static CLOCK: Cell<u64> = const { Cell::new(0) };
        static SEQ: Cell<u32> = const { Cell::new(0) };
    }

    /// Remembers the app and takes Apaki's own WebView2 environment from the main webview.
    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        if let Some(main) = app.get_webview_window("main") {
            if let Ok(h) = main.hwnd() {
                PARENT.store(h.0 as isize, Ordering::SeqCst);
            }
            let _ = main.with_webview(|pw| {
                ENV.with(|e| *e.borrow_mut() = Some(pw.environment()));
                MAIN.with(|c| *c.borrow_mut() = Some(pw.controller()));
                if let Ok(wv) = unsafe { pw.controller().CoreWebView2() } {
                    watch_main(&wv);
                }
            });
        }
    }

    /// The window's own page when its WebView2 processes fail (2026-10-13). Arthur: "myrlin apaki still freezes up
    /// pretty often and just now crashed": at 00:23 the page's process died out of memory (0xe0000008, the PC's commit
    /// charge near its limit), and the window sat frozen until it died five minutes later. Now a crashed or hung page
    /// reloads at once (the engine and every conversation keep running; the page reconnects as after any engine
    /// restart), a crashed GPU process is left to WebView2, which starts a new one, and a dead browser process, which
    /// cannot be reloaded in place, starts the app again. Each one is written to apaki-window.log.
    fn watch_main(wv: &ICoreWebView2) {
        let mut tok = 0i64;
        let r = unsafe {
            wv.add_ProcessFailed(
                &ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                    if let Some(a) = &args {
                        let _ = a.ProcessFailedKind(&mut kind);
                    }
                    if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
                        let what = if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED { "exited" } else { "stopped responding" };
                        crate::wlog(&format!("the page's process {what}; reloading the page"));
                        if let Some(wv) = &sender {
                            let _ = wv.Reload();
                        }
                    } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                        crate::wlog("WebView2's browser process exited; starting Apaki again");
                        if let Some(app) = APP.get() {
                            app.restart();
                        }
                    } else {
                        crate::wlog(&format!("a WebView2 process failed (kind {}); WebView2 recovers it", kind.0));
                    }
                    Ok(())
                })),
                &mut tok,
            )
        };
        if let Err(e) = r {
            crate::wlog(&format!("could not watch the page's processes: {e}"));
        }
    }

    /// Runs one command on the main thread.
    pub fn dispatch(app: &AppHandle, cmd: String, args: Value, reply: Reply) {
        let _ = app.run_on_main_thread(move || handle(&cmd, args, reply));
    }

    /// The window moved: WebView2 must know, or its popups (select menus) open in the old place.
    pub fn parent_moved(app: &AppHandle) {
        let _ = app.run_on_main_thread(|| {
            for l in all_live() {
                unsafe {
                    let _ = l.ctl.NotifyParentWindowPositionChanged();
                }
            }
        });
    }

    fn handle(cmd: &str, a: Value, reply: Reply) {
        match cmd {
            "open" => open(a, reply),
            "go" => go(a, reply),
            "nav" => nav(a, reply),
            "cdp" => cdp(a, reply),
            "snapshot" => snapshot(a, reply),
            "place" => {
                place(&a);
                reply(Ok(json!({ "ok": true })));
            }
            "focus" => {
                match resolve(&a) {
                    Some(id) => {
                        touch(&id);
                        with_live(&id, Box::new(|l| unsafe {
                            let _ = l.ctl.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                        }));
                        reply(Ok(json!({ "ok": true })));
                    }
                    None => reply(Err(NO_BROWSER.into())),
                }
            }
            "state" => match resolve(&a) {
                Some(id) => reply(Ok(state_json(&id))),
                None => reply(Err(NO_BROWSER.into())),
            },
            "list" => reply(Ok(json!({ "browsers": list() }))),
            "close" => {
                if let Some(id) = a.get("id").and_then(Value::as_str) {
                    close(id);
                }
                reply(Ok(json!({ "ok": true })));
            }
            "focusApp" => {
                if let Some(c) = MAIN.with(|c| c.borrow().clone()) {
                    unsafe {
                        let _ = c.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                    }
                }
                reply(Ok(json!({ "ok": true })));
            }
            "theme" => {
                theme(a.get("dark").and_then(Value::as_bool).unwrap_or(false));
                reply(Ok(json!({ "ok": true })));
            }
            _ => reply(Err(format!("Apaki's browser has no command \"{cmd}\"."))),
        }
    }

    /* ---------- helpers ---------- */

    fn emit(v: Value) {
        if let Some(app) = APP.get() {
            let _ = app.emit("browser", v);
        }
    }

    fn tick() -> u64 {
        CLOCK.with(|c| {
            c.set(c.get() + 1);
            c.get()
        })
    }

    fn touch(id: &str) {
        let t = tick();
        BROWSERS.with(|m| {
            if let Some(b) = m.borrow_mut().get_mut(id) {
                b.used = t;
            }
        });
    }

    fn exists(id: &str) -> bool {
        BROWSERS.with(|m| m.borrow().contains_key(id))
    }

    /// The browser a conversation used last.
    fn current_of(owner: &str) -> Option<String> {
        BROWSERS.with(|m| {
            m.borrow()
                .iter()
                .filter(|(_, b)| b.owner.as_deref() == Some(owner))
                .max_by_key(|(_, b)| b.used)
                .map(|(id, _)| id.clone())
        })
    }

    /// args.id when it exists, else the owner's current browser.
    fn resolve(a: &Value) -> Option<String> {
        if let Some(id) = a.get("id").and_then(Value::as_str) {
            if exists(id) {
                return Some(id.to_string());
            }
        }
        a.get("owner").and_then(Value::as_str).and_then(current_of)
    }

    fn all_live() -> Vec<Live> {
        BROWSERS.with(|m| m.borrow().values().filter_map(|b| b.live.clone()).collect())
    }

    fn new_id() -> String {
        let n = SEQ.with(|s| {
            s.set(s.get() + 1);
            s.get()
        });
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        format!("b{:x}{n}", ms)
    }

    /// What the browser may load: web pages, local files, and a blank page.
    fn web_url(u: &str) -> bool {
        let l = u.to_ascii_lowercase();
        (l.starts_with("http://") || l.starts_with("https://") || l.starts_with("file:///") || l == "about:blank") && !u.chars().any(char::is_whitespace)
    }

    fn state_json(id: &str) -> Value {
        BROWSERS.with(|m| match m.borrow().get(id) {
            Some(b) => json!({
                "id": id, "owner": b.owner, "url": b.url, "title": b.title, "loading": b.loading,
                "canGoBack": b.back, "canGoForward": b.forward, "status": b.status, "error": b.error,
                "visible": b.shown, "ready": b.live.is_some(),
            }),
            None => json!({ "id": id, "closed": true }),
        })
    }

    fn emit_state(id: &str) {
        let mut s = state_json(id);
        s["ev"] = json!("state");
        emit(s);
    }

    fn list() -> Vec<Value> {
        let ids: Vec<String> = BROWSERS.with(|m| m.borrow().keys().cloned().collect());
        ids.iter().map(|id| state_json(id)).collect()
    }

    /// Runs `f` with the live controller now, or once it exists. False when there is no such browser.
    fn with_live(id: &str, f: Box<dyn FnOnce(&Live)>) -> bool {
        let mut f = Some(f);
        let now = BROWSERS.with(|m| {
            let mut m = m.borrow_mut();
            match m.get_mut(id) {
                None => Err(()),
                Some(b) => match &b.live {
                    Some(l) => Ok(Some(l.clone())),
                    None => {
                        if let Some(f) = f.take() {
                            b.queued.push(f);
                        }
                        Ok(None)
                    }
                },
            }
        });
        match now {
            Err(()) => false,
            Ok(None) => true,
            Ok(Some(l)) => {
                if let Some(f) = f.take() {
                    f(&l);
                }
                true
            }
        }
    }

    /// Answers once the navigation in progress has finished.
    fn wait_for_load(id: &str, reply: Reply) {
        let mut reply = Some(reply);
        BROWSERS.with(|m| {
            if let Some(b) = m.borrow_mut().get_mut(id) {
                if let Some(r) = reply.take() {
                    b.waiters.push(r);
                }
            }
        });
        if let Some(r) = reply {
            r(Ok(state_json(id)));
        }
    }

    fn settle(id: &str) {
        let waiters = BROWSERS.with(|m| m.borrow_mut().get_mut(id).map(|b| std::mem::take(&mut b.waiters)).unwrap_or_default());
        if waiters.is_empty() {
            return;
        }
        let s = state_json(id);
        for w in waiters {
            w(Ok(s.clone()));
        }
    }

    fn background() -> COREWEBVIEW2_COLOR {
        // White in both themes, like a real browser's canvas (2026-10-11). It used to be the app's
        // ground (#121120 in dark), so a page that sets no background of its own, such as App Store
        // Connect, drew its black text on our navy (Arthur: "weird dark mode in app store connect").
        // Pages that support dark mode still turn dark: they get prefers-color-scheme: dark (scheme())
        // and paint their own background. The cost is a white frame while a light page loads in
        // dark mode, which is what Chrome and Edge show too.
        let _dark_theme = DARK.with(Cell::get);
        COREWEBVIEW2_COLOR { A: 255, R: 0xFF, G: 0xFF, B: 0xFF }
    }

    fn scheme() -> COREWEBVIEW2_PREFERRED_COLOR_SCHEME {
        if DARK.with(Cell::get) {
            COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK
        } else {
            COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT
        }
    }

    unsafe extern "system" fn host_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_SETFOCUS {
            // Keyboard focus goes on into the page.
            if let Ok(child) = unsafe { GetWindow(hwnd, GW_CHILD) } {
                let _ = unsafe { SetFocus(Some(child)) };
            }
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    fn hinstance() -> Option<HINSTANCE> {
        unsafe { GetModuleHandleW(PCWSTR::null()).ok().map(Into::into) }
    }

    fn register_class() {
        if CLASS_READY.swap(true, Ordering::SeqCst) {
            return;
        }
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(host_proc),
            hInstance: hinstance().unwrap_or_default(),
            hCursor: unsafe { LoadCursorW(None, IDC_ARROW) }.unwrap_or_default(),
            lpszClassName: CLASS,
            ..Default::default()
        };
        unsafe { RegisterClassExW(&class) };
    }

    /* ---------- making a browser ---------- */

    fn create(id: &str, owner: Option<String>) -> Result<(), String> {
        let env = ENV.with(|e| e.borrow().clone()).ok_or("Apaki's WebView2 environment is not ready yet.")?;
        let parent = PARENT.load(Ordering::SeqCst);
        if parent == 0 {
            return Err("Apaki's window is not ready yet.".into());
        }
        register_class();
        let host = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                CLASS,
                PCWSTR::null(),
                WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0,
                0,
                640,
                480,
                Some(HWND(parent as _)),
                None,
                hinstance(),
                None,
            )
        }
        .map_err(|e| format!("could not make the browser's window: {}", e.message()))?;
        BROWSERS.with(|m| {
            m.borrow_mut().insert(id.to_string(), Browser {
                owner,
                host: host.0 as isize,
                live: None,
                queued: Vec::new(),
                url: String::new(),
                title: String::new(),
                loading: false,
                back: false,
                forward: false,
                status: None,
                error: None,
                shown: false,
                rendering: 0,
                rect: (0, 0, 640, 480),
                used: tick(),
                waiters: Vec::new(),
            });
        });
        let started = (|| -> windows::core::Result<()> {
            let id2 = id.to_string();
            let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |hr, ctl| {
                created(&id2, hr.and_then(|()| ctl.ok_or_else(|| windows::core::Error::from(E_POINTER))));
                Ok(())
            }));
            match env.cast::<ICoreWebView2Environment10>() {
                Ok(env10) => unsafe {
                    let opts = env10.CreateCoreWebView2ControllerOptions()?;
                    opts.SetProfileName(&HSTRING::from(PROFILE))?;
                    if let Ok(o3) = opts.cast::<ICoreWebView2ControllerOptions3>() {
                        let _ = o3.SetDefaultBackgroundColor(background());
                    }
                    env10.CreateCoreWebView2ControllerWithOptions(host, &opts, &handler)
                },
                // An old WebView2 runtime without profiles: the default profile, still no bridge.
                Err(_) => unsafe { env.CreateCoreWebView2Controller(host, &handler) },
            }
        })();
        if let Err(e) = started {
            fail(id, &e.message());
            return Err(format!("could not start the browser: {}", e.message()));
        }
        Ok(())
    }

    fn fail(id: &str, why: &str) {
        let gone = BROWSERS.with(|m| m.borrow_mut().remove(id));
        if let Some(b) = gone {
            unsafe {
                let _ = DestroyWindow(HWND(b.host as _));
            }
            for w in b.waiters {
                w(Err(format!("The browser could not start: {why}")));
            }
        }
        emit(json!({ "ev": "closed", "id": id, "error": why }));
    }

    fn created(id: &str, r: windows::core::Result<ICoreWebView2Controller>) {
        let ctl = match r {
            Ok(c) => c,
            Err(e) => {
                fail(id, &e.message());
                return;
            }
        };
        let wv = match unsafe { ctl.CoreWebView2() } {
            Ok(w) => w,
            Err(e) => {
                unsafe {
                    let _ = ctl.Close();
                }
                fail(id, &e.message());
                return;
            }
        };
        if let Err(e) = unsafe { configure(id, &ctl, &wv) } {
            eprintln!("apaki browser: configure: {}", e.message());
        }
        let live = Live { ctl, wv };
        let got = BROWSERS.with(|m| {
            m.borrow_mut().get_mut(id).map(|b| {
                b.live = Some(live.clone());
                (std::mem::take(&mut b.queued), b.host, b.rect, b.shown, b.rendering)
            })
        });
        let Some((queued, host, rect, shown, rendering)) = got else {
            // Closed while it was being made.
            unsafe {
                let _ = live.ctl.Close();
            }
            return;
        };
        apply(host, Some(&live), rect, shown, rendering);
        for f in queued {
            f(&live);
        }
        emit_state(id);
    }

    /// Settings and events. Nothing here gives the page a way out: no web
    /// messages, no host objects, no custom schemes, no injected scripts.
    #[allow(unused_unsafe)]
    unsafe fn configure(id: &str, ctl: &ICoreWebView2Controller, wv: &ICoreWebView2) -> windows::core::Result<()> {
        unsafe {
            let s = wv.Settings()?;
            s.SetIsWebMessageEnabled(false)?;
            s.SetAreHostObjectsAllowed(false)?;
            s.SetAreDevToolsEnabled(true)?;
            s.SetIsStatusBarEnabled(true)?;
            s.SetAreDefaultContextMenusEnabled(true)?;
            s.SetIsZoomControlEnabled(true)?;
            if let Ok(p) = wv.cast::<ICoreWebView2_13>().and_then(|w| w.Profile()) {
                let _ = p.SetPreferredColorScheme(scheme());
            }
            let mut tok = 0i64;

            let i = id.to_string();
            wv.add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut uri = PWSTR::null();
                        unsafe { args.Uri(&mut uri)? };
                        let uri = take_pwstr(uri);
                        BROWSERS.with(|m| {
                            if let Some(b) = m.borrow_mut().get_mut(&i) {
                                b.loading = true;
                                b.url = uri;
                                b.error = None;
                                b.status = None;
                            }
                        });
                        emit_state(&i);
                    }
                    Ok(())
                })),
                &mut tok,
            )?;

            let i = id.to_string();
            wv.add_NavigationCompleted(
                &NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
                    let mut ok = BOOL(1);
                    let mut status = None;
                    let mut web = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                    if let Some(args) = &args {
                        unsafe {
                            let _ = args.IsSuccess(&mut ok);
                            let _ = args.WebErrorStatus(&mut web);
                        }
                        if let Ok(a2) = args.cast::<ICoreWebView2NavigationCompletedEventArgs2>() {
                            let mut code = 0i32;
                            if unsafe { a2.HttpStatusCode(&mut code) }.is_ok() && code > 0 {
                                status = Some(code);
                            }
                        }
                    }
                    let page = sender.as_ref().map(read_page);
                    BROWSERS.with(|m| {
                        if let Some(b) = m.borrow_mut().get_mut(&i) {
                            b.loading = false;
                            b.status = status;
                            b.error = if ok.as_bool() { None } else { Some(web_error(web)) };
                            if let Some(p) = page {
                                b.url = p.0;
                                b.title = p.1;
                                b.back = p.2;
                                b.forward = p.3;
                            }
                        }
                    });
                    emit_state(&i);
                    settle(&i);
                    Ok(())
                })),
                &mut tok,
            )?;

            let i = id.to_string();
            wv.add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |sender, args| {
                    let mut new_doc = BOOL(1);
                    if let Some(args) = &args {
                        let _ = unsafe { args.IsNewDocument(&mut new_doc) };
                    }
                    if let Some(p) = sender.as_ref().map(read_page) {
                        BROWSERS.with(|m| {
                            if let Some(b) = m.borrow_mut().get_mut(&i) {
                                b.url = p.0;
                                b.back = p.2;
                                b.forward = p.3;
                            }
                        });
                    }
                    emit_state(&i);
                    // A same-page move (a #hash, history.pushState) has no load to wait for.
                    if !new_doc.as_bool() {
                        settle(&i);
                    }
                    Ok(())
                })),
                &mut tok,
            )?;

            let i = id.to_string();
            wv.add_HistoryChanged(
                &HistoryChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(p) = sender.as_ref().map(read_page) {
                        BROWSERS.with(|m| {
                            if let Some(b) = m.borrow_mut().get_mut(&i) {
                                b.back = p.2;
                                b.forward = p.3;
                            }
                        });
                        emit_state(&i);
                    }
                    Ok(())
                })),
                &mut tok,
            )?;

            let i = id.to_string();
            wv.add_DocumentTitleChanged(
                &DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(p) = sender.as_ref().map(read_page) {
                        BROWSERS.with(|m| {
                            if let Some(b) = m.borrow_mut().get_mut(&i) {
                                b.title = p.1;
                            }
                        });
                        emit_state(&i);
                    }
                    Ok(())
                })),
                &mut tok,
            )?;

            // Links that want a new window (target=_blank, window.open) open in this browser.
            let i = id.to_string();
            wv.add_NewWindowRequested(
                &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut uri = PWSTR::null();
                        unsafe {
                            args.Uri(&mut uri)?;
                            args.SetHandled(true)?;
                        }
                        let uri = take_pwstr(uri);
                        if web_url(&uri) {
                            if let Some(app) = APP.get() {
                                let id = i.clone();
                                let _ = app.run_on_main_thread(move || {
                                    with_live(&id, Box::new(move |l| unsafe {
                                        let _ = l.wv.Navigate(&HSTRING::from(uri.as_str()));
                                    }));
                                });
                            }
                        }
                    }
                    Ok(())
                })),
                &mut tok,
            )?;

            let i = id.to_string();
            wv.add_WindowCloseRequested(
                &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                    emit(json!({ "ev": "closeRequested", "id": i }));
                    Ok(())
                })),
                &mut tok,
            )?;

            let i = id.to_string();
            ctl.add_GotFocus(
                &FocusChangedEventHandler::create(Box::new(move |_, _| {
                    touch(&i);
                    emit(json!({ "ev": "focus", "id": i }));
                    Ok(())
                })),
                &mut tok,
            )?;

            // Apaki's own shortcuts still work while the page has the keyboard.
            let i = id.to_string();
            ctl.add_AcceleratorKeyPressed(
                &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                    let mut vk = 0u32;
                    unsafe {
                        args.KeyEventKind(&mut kind)?;
                        args.VirtualKey(&mut vk)?;
                    }
                    if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN {
                        return Ok(());
                    }
                    let ctrl = unsafe { GetKeyState(VK_CONTROL.0 as i32) } < 0;
                    if !ctrl {
                        return Ok(());
                    }
                    let shift = unsafe { GetKeyState(VK_SHIFT.0 as i32) } < 0;
                    let key = match vk {
                        0x57 => "w".to_string(),
                        0x54 => "t".to_string(),
                        0x4C => "l".to_string(),
                        0x09 => "Tab".to_string(),
                        0x31..=0x36 => char::from_u32(vk).map(String::from).unwrap_or_default(),
                        _ => return Ok(()),
                    };
                    unsafe { args.SetHandled(true)? };
                    emit(json!({ "ev": "key", "id": i, "key": key, "shift": shift }));
                    Ok(())
                })),
                &mut tok,
            )?;
            let _ = ctl.cast::<ICoreWebView2Controller2>().map(|c2| c2.SetDefaultBackgroundColor(background()));
        }
        Ok(())
    }

    /// (url, title, can go back, can go forward) from a webview.
    fn read_page(wv: &ICoreWebView2) -> (String, String, bool, bool) {
        unsafe {
            let mut src = PWSTR::null();
            let mut title = PWSTR::null();
            let mut back = BOOL(0);
            let mut fwd = BOOL(0);
            let _ = wv.Source(&mut src);
            let _ = wv.DocumentTitle(&mut title);
            let _ = wv.CanGoBack(&mut back);
            let _ = wv.CanGoForward(&mut fwd);
            (take_pwstr(src), take_pwstr(title), back.as_bool(), fwd.as_bool())
        }
    }

    fn web_error(s: COREWEBVIEW2_WEB_ERROR_STATUS) -> String {
        let name = match s {
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT
            | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED
            | COREWEBVIEW2_WEB_ERROR_STATUS_CLIENT_CERTIFICATE_CONTAINS_ERRORS
            | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED
            | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID => "the site's certificate is not valid",
            COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE | COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT => "could not connect",
            COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT => "timed out",
            COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED => "no such host",
            COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED | COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET | COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED => "the connection dropped",
            COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED => "stopped",
            COREWEBVIEW2_WEB_ERROR_STATUS_REDIRECT_FAILED => "a redirect failed",
            _ => "the page did not load",
        };
        name.to_string()
    }

    /* ---------- commands ---------- */

    fn open(a: Value, reply: Reply) {
        let url = a.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if !url.is_empty() && !web_url(&url) {
            reply(Err(format!("Apaki's browser opens http, https and file addresses; \"{url}\" is none of those.")));
            return;
        }
        let owner = a.get("owner").and_then(Value::as_str).map(String::from);
        let hint = a.get("hint").and_then(Value::as_str).unwrap_or("reuse").to_string();
        let wait = a.get("wait").and_then(Value::as_bool).unwrap_or(false);
        let focus = a.get("focus").and_then(Value::as_bool).unwrap_or(false);
        let adopt = a.get("adopt").and_then(Value::as_bool).unwrap_or(false);
        let reason = a.get("reason").and_then(Value::as_str).unwrap_or("").to_string();
        let want = a.get("id").and_then(Value::as_str).map(String::from);
        let existing = match &want {
            Some(id) if exists(id) => Some(id.clone()),
            Some(_) => None,
            None if hint == "reuse" => owner.as_deref().and_then(current_of),
            None => None,
        };
        let (id, created) = match existing {
            Some(id) => (id, false),
            None => {
                let id = want.unwrap_or_else(new_id);
                if let Err(e) = create(&id, owner.clone()) {
                    reply(Err(e));
                    return;
                }
                (id, true)
            }
        };
        touch(&id);
        let navigate = !url.is_empty() && (created || !adopt);
        if navigate {
            BROWSERS.with(|m| {
                if let Some(b) = m.borrow_mut().get_mut(&id) {
                    b.loading = true;
                    b.url = url.clone();
                    b.error = None;
                    b.status = None;
                }
            });
            let u = url.clone();
            with_live(&id, Box::new(move |l| unsafe {
                let _ = l.wv.Navigate(&HSTRING::from(u.as_str()));
            }));
        }
        let s = state_json(&id);
        emit(json!({
            "ev": if created { "created" } else { "reveal" }, "id": id, "owner": owner, "url": url,
            "reason": reason, "hint": hint, "focus": focus, "state": s,
        }));
        if wait && navigate {
            wait_for_load(&id, reply);
        } else {
            reply(Ok(s));
        }
    }

    fn go(a: Value, reply: Reply) {
        let Some(id) = resolve(&a) else { return reply(Err(NO_BROWSER.into())) };
        let url = a.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if !web_url(&url) {
            return reply(Err(format!("Apaki's browser opens http, https and file addresses; \"{url}\" is none of those.")));
        }
        let wait = a.get("wait").and_then(Value::as_bool).unwrap_or(false);
        touch(&id);
        BROWSERS.with(|m| {
            if let Some(b) = m.borrow_mut().get_mut(&id) {
                b.loading = true;
                b.url = url.clone();
                b.error = None;
            }
        });
        let i = id.clone();
        let slot = Rc::new(RefCell::new(Some(reply)));
        let s2 = slot.clone();
        let found = with_live(&id, Box::new(move |l| {
            let r = unsafe { l.wv.Navigate(&HSTRING::from(url.as_str())) };
            let Some(reply) = s2.borrow_mut().take() else { return };
            match r {
                Err(e) => reply(Err(e.message().to_string())),
                Ok(()) if wait => wait_for_load(&i, reply),
                Ok(()) => reply(Ok(state_json(&i))),
            }
        }));
        if !found {
            if let Some(reply) = slot.borrow_mut().take() {
                reply(Err(NO_BROWSER.into()));
            }
        }
    }

    fn nav(a: Value, reply: Reply) {
        let Some(id) = resolve(&a) else { return reply(Err(NO_BROWSER.into())) };
        let action = a.get("action").and_then(Value::as_str).unwrap_or("").to_string();
        let wait = a.get("wait").and_then(Value::as_bool).unwrap_or(false);
        touch(&id);
        let i = id.clone();
        with_live(&id, Box::new(move |l| unsafe {
            let mut can = BOOL(0);
            let r: Result<bool, String> = match action.as_str() {
                "back" => {
                    let _ = l.wv.CanGoBack(&mut can);
                    if can.as_bool() { l.wv.GoBack().map(|_| true).map_err(|e| e.message().to_string()) } else { Err("There is no earlier page in this browser.".into()) }
                }
                "forward" => {
                    let _ = l.wv.CanGoForward(&mut can);
                    if can.as_bool() { l.wv.GoForward().map(|_| true).map_err(|e| e.message().to_string()) } else { Err("There is no later page in this browser.".into()) }
                }
                "reload" => l.wv.Reload().map(|_| true).map_err(|e| e.message().to_string()),
                "stop" => l.wv.Stop().map(|_| false).map_err(|e| e.message().to_string()),
                other => Err(format!("unknown browser action \"{other}\"")),
            };
            match r {
                Err(e) => reply(Err(e)),
                Ok(true) if wait => wait_for_load(&i, reply),
                Ok(_) => reply(Ok(state_json(&i))),
            }
        }));
    }

    /// Bounds in physical pixels inside Apaki's window, and whether it shows.
    fn place(a: &Value) {
        let Some(id) = a.get("id").and_then(Value::as_str) else { return };
        let n = |k: &str| a.get(k).and_then(Value::as_f64).unwrap_or(0.0).round() as i32;
        let rect = (n("x"), n("y"), n("w").max(1), n("h").max(1));
        let visible = a.get("visible").and_then(Value::as_bool).unwrap_or(true);
        let got = BROWSERS.with(|m| {
            m.borrow_mut().get_mut(id).map(|b| {
                b.rect = rect;
                b.shown = visible;
                (b.host, b.live.clone(), b.rendering)
            })
        });
        if let Some((host, live, rendering)) = got {
            apply(host, live.as_ref(), rect, visible, rendering);
        }
    }

    fn apply(host: isize, live: Option<&Live>, (x, y, w, h): (i32, i32, i32, i32), visible: bool, rendering: u32) {
        unsafe {
            let flags = SWP_NOACTIVATE | if visible { SWP_SHOWWINDOW } else { SWP_HIDEWINDOW };
            let _ = SetWindowPos(HWND(host as _), Some(HWND_TOP), x, y, w, h, flags);
            if let Some(l) = live {
                let _ = l.ctl.SetBounds(RECT { left: 0, top: 0, right: w, bottom: h });
                let _ = l.ctl.SetIsVisible(visible || rendering > 0);
            }
        }
    }

    /// A hidden browser still renders while a screenshot is taken (its window stays hidden).
    fn hold_render(id: &str, l: &Live) {
        let start = BROWSERS.with(|m| {
            m.borrow_mut().get_mut(id).map(|b| {
                b.rendering += 1;
                !b.shown && b.rendering == 1
            })
        });
        if start == Some(true) {
            unsafe {
                let _ = l.ctl.SetIsVisible(true);
            }
        }
    }

    fn release_render(id: &str) {
        let stop = BROWSERS.with(|m| {
            m.borrow_mut().get_mut(id).and_then(|b| {
                b.rendering = b.rendering.saturating_sub(1);
                if !b.shown && b.rendering == 0 { b.live.clone() } else { None }
            })
        });
        if let Some(l) = stop {
            unsafe {
                let _ = l.ctl.SetIsVisible(false);
            }
        }
    }

    /// One DevTools protocol call on a browser: {id | owner, method, params, render?}.
    fn cdp(a: Value, reply: Reply) {
        let Some(id) = resolve(&a) else { return reply(Err(NO_BROWSER.into())) };
        let method = a.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let params = a.get("params").filter(|p| p.is_object()).map(Value::to_string).unwrap_or_else(|| "{}".into());
        let render = a.get("render").and_then(Value::as_bool).unwrap_or(false);
        touch(&id);
        call_cdp(&id, method, params, render, Box::new(move |r| reply(r)));
    }

    fn call_cdp(id: &str, method: String, params: String, render: bool, reply: Reply) {
        let i = id.to_string();
        let slot = Rc::new(RefCell::new(Some(reply)));
        let s2 = slot.clone();
        let found = with_live(id, Box::new(move |l| {
            if render {
                hold_render(&i, l);
            }
            let s3 = s2.clone();
            let i3 = i.clone();
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, out| {
                if render {
                    release_render(&i3);
                }
                if let Some(reply) = s3.borrow_mut().take() {
                    match hr {
                        Ok(()) => reply(Ok(json!({ "id": i3, "result": serde_json::from_str::<Value>(&out).unwrap_or(Value::Null) }))),
                        Err(e) => reply(Err(cdp_error(&out, &e))),
                    }
                }
                Ok(())
            }));
            let r = unsafe { l.wv.CallDevToolsProtocolMethod(&HSTRING::from(method.as_str()), &HSTRING::from(params.as_str()), &handler) };
            if let Err(e) = r {
                if render {
                    release_render(&i);
                }
                if let Some(reply) = s2.borrow_mut().take() {
                    reply(Err(e.message().to_string()));
                }
            }
        }));
        if !found {
            if let Some(reply) = slot.borrow_mut().take() {
                reply(Err(NO_BROWSER.into()));
            }
        }
    }

    /// The protocol's own error message when it gave one.
    fn cdp_error(out: &str, e: &windows::core::Error) -> String {
        serde_json::from_str::<Value>(out)
            .ok()
            .and_then(|v| v.get("message").and_then(Value::as_str).map(String::from))
            .unwrap_or_else(|| if out.trim().is_empty() { e.message().to_string() } else { out.chars().take(400).collect() })
    }

    /// A JPEG of what the browser shows, for the window to put in its place while a menu or sheet covers it.
    fn snapshot(a: Value, reply: Reply) {
        let Some(id) = resolve(&a) else { return reply(Err(NO_BROWSER.into())) };
        let quality = a.get("quality").and_then(Value::as_u64).unwrap_or(72).clamp(30, 95);
        let params = json!({ "format": "jpeg", "quality": quality, "optimizeForSpeed": true }).to_string();
        call_cdp(&id, "Page.captureScreenshot".into(), params, true, Box::new(move |r| {
            reply(r.and_then(|v| {
                v.pointer("/result/data")
                    .and_then(Value::as_str)
                    .map(|d| json!({ "id": v["id"], "dataUrl": format!("data:image/jpeg;base64,{d}") }))
                    .ok_or_else(|| "no picture came back".to_string())
            }))
        }));
    }

    fn close(id: &str) {
        let Some(b) = BROWSERS.with(|m| m.borrow_mut().remove(id)) else { return };
        for w in b.waiters {
            w(Err("The browser was closed.".into()));
        }
        unsafe {
            if let Some(l) = &b.live {
                let _ = l.ctl.Close();
            }
            let _ = DestroyWindow(HWND(b.host as _));
        }
        emit(json!({ "ev": "closed", "id": id }));
    }

    /// Pages see Apaki's theme as prefers-color-scheme, and the blank ground matches it.
    fn theme(dark: bool) {
        DARK.with(|d| d.set(dark));
        for l in all_live() {
            unsafe {
                if let Ok(p) = l.wv.cast::<ICoreWebView2_13>().and_then(|w| w.Profile()) {
                    let _ = p.SetPreferredColorScheme(scheme());
                }
                if let Ok(c2) = l.ctl.cast::<ICoreWebView2Controller2>() {
                    let _ = c2.SetDefaultBackgroundColor(background());
                }
            }
        }
    }
}
