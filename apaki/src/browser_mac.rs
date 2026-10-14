//! browser_mac.rs: Myrlin Apaki's built-in browser on macOS (compiled on macOS only; see browser.rs for the
//! Windows twin and the contract both keep).
//!
//! WHY (Arthur, 2026-10-13, macOS port phase 2): the browser pane and Claude's browser tools (browser_open, _read,
//! _click, _type, _back, _screenshot, _tabs) had to work on a Mac, behind the same `features()` contract, the
//! same commands and events, and the same engine code (apaki/engine/browser-tools.js, browser-page.js).
//!
//! WHY a WKWebView made here and not a Tauri child webview: same reason as on Windows. Tauri puts its IPC bridge
//! into every webview it creates and answers their calls; a page from the internet must have none of that. This
//! is a plain WKWebView with its own configuration: no script message handlers, no custom schemes, no Tauri
//! anywhere in it. It sits as a sibling view above the window's own page, in a separate persistent website data
//! store (macOS 14 and later; the default store before that), so its cookies are not shared with anything of Apaki's.
//!
//! WHY no DevTools protocol: WKWebView has none. The engine's browser tools make exactly seven kinds of protocol
//! call (Page.getFrameTree, Page.createIsolatedWorld, Runtime.evaluate, Input.dispatchMouseEvent, Input.insertText,
//! Input.dispatchKeyEvent, Page.captureScreenshot); `cdp` below answers those from WKWebView's own APIs:
//!   - evaluation: callAsyncJavaScript in a named WKContentWorld ("apaki"), an isolated world like the one the
//!     engine asks for on Windows, so the page cannot see or change the page library;
//!   - clicks: a real NSEvent sent to the view (a trusted click) when the page is on screen, else the same
//!     pointer and mouse events dispatched from the bridge script (browser_mac_bridge.js);
//!   - typing and keys: the bridge script (execCommand, KeyboardEvent, form submission), which unlike a real key
//!     event does not need the page to have the window's keyboard focus, so Claude typing never steals it from you;
//!   - screenshots: WKWebView's takeSnapshot, encoded as PNG or JPEG.
//!
//! Everything runs on the main thread, where AppKit lives. The window (ui/browser.js) sends invoke('browser',
//! { cmd, args }); Claude's tools arrive as {ev:"shell", cmd:"browser.<cmd>"} (browser.rs shell_request).
//! Commands: open, go, nav, place, focus, focusApp, snapshot, cdp, state, list, close, theme (plus debug).
//! Events to the window: Tauri event "browser" with ev created | reveal | state | focus | key | closeRequested | closed.
//! Idle cost: nothing exists until the first browser is opened; after that only WebKit's own callbacks and KVO.

use super::Reply;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::OnceLock;
use std::time::Duration;

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, ProtocolObject};
use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSAlert, NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSBitmapImageFileType, NSBitmapImageRep, NSEvent,
    NSEventModifierFlags, NSEventType, NSImage, NSModalResponse, NSModalResponseOK, NSOpenPanel, NSTextField, NSView, NSWindow,
    NSWindowOrderingMode,
};
use objc2_foundation::{
    ns_string, MainThreadMarker, NSArray, NSData, NSDataBase64EncodingOptions, NSDictionary, NSError,
    NSHTTPURLResponse, NSKeyValueChangeKey, NSKeyValueObservingOptions, NSNumber, NSObjectNSKeyValueObserverRegistration,
    NSObjectProtocol, NSPoint, NSProcessInfo, NSRect, NSSize, NSString, NSURLRequest, NSUUID, NSURL,
};
use objc2_web_kit::{
    WKContentWorld, WKFrameInfo, WKNavigation, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate,
    WKNavigationResponse, WKNavigationResponsePolicy, WKOpenPanelParameters, WKSnapshotConfiguration, WKUIDelegate,
    WKWebView, WKWebViewConfiguration, WKWebsiteDataStore, WKWindowFeatures,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const NO_BROWSER: &str = "No browser is open for this conversation. Open a page with browser_open first.";
/// The isolated world the engine's page library and the bridge script live in.
const WORLD: &str = "apaki";
/// The bridge script (clicks, typing, keys inside the page), see the file's header.
const BRIDGE: &str = include_str!("browser_mac_bridge.js");
/// Where a browser sits until the window places it, in points relative to the window's page.
const DEFAULT_RECT: (f64, f64, f64, f64) = (0.0, 0.0, 1000.0, 700.0);
/// The browser's own website data store (macOS 14 and later): fixed, so logins survive a restart.
const PROFILE_UUID: [u8; 16] = [0x4d, 0x79, 0x72, 0x6c, 0x69, 0x6e, 0x41, 0x70, 0x61, 0x6b, 0x69, 0x42, 0x72, 0x6f, 0x77, 0x73];
/// What a Safari-like user agent adds to WKWebView's default one (sites that sniff for "Safari" serve the plain page).
const UA_SUFFIX: &str = "Version/18.0 Safari/605.1.15";
/// No picture ever leaves this module wider than this (the 2000 px rule for pictures, with room).
const MAX_PICTURE_PX: f64 = 1900.0;

static APP: OnceLock<AppHandle> = OnceLock::new();

struct Browser {
    owner: Option<String>,
    view: Retained<ApakiWebView>,
    // The view holds its delegates weakly: these keep them alive.
    _nav: Retained<NavDelegate>,
    _ui: Retained<UiDelegate>,
    watch: Retained<Watcher>,
    url: String,
    title: String,
    loading: bool,
    /// A navigation has started and not committed yet: `url` is the address being loaded, not the old page's.
    provisional: bool,
    back: bool,
    forward: bool,
    status: Option<i32>,
    error: Option<String>,
    /// The window wants it on screen.
    shown: bool,
    /// Pictures in flight while it is hidden (it needs to be on screen, invisibly, to be drawn).
    rendering: u32,
    /// Points, relative to the window's page, top left origin.
    rect: (f64, f64, f64, f64),
    /// Last use by Claude or the user, to pick a conversation's current browser.
    used: u64,
    /// Answers waiting for the navigation in progress to finish.
    waiters: Vec<Reply>,
    /// Counts committed documents (the "loader id" of the protocol).
    doc: u64,
}

type JsDone = Box<dyn FnOnce(Result<Option<String>, String>)>;

thread_local! {
    static BROWSERS: RefCell<HashMap<String, Browser>> = RefCell::new(HashMap::new());
    /// The window's own page: the browsers are placed relative to it and added next to it.
    static MAIN: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) };
    static STORE: RefCell<Option<Retained<WKWebsiteDataStore>>> = const { RefCell::new(None) };
    /// The isolated world the page library and the bridge live in. WebKit drops a named world (and everything the scripts
    /// kept in it: window.__apaki, the refs) when nothing holds the world object, so this one is kept for good.
    static WORLD_OBJ: RefCell<Option<Retained<WKContentWorld>>> = const { RefCell::new(None) };
    /// "native", "js" or None (the default: native when the page is on screen); set by the "mouseMode" command.
    static MOUSE_MODE: RefCell<Option<String>> = const { RefCell::new(None) };
    static DARK: Cell<bool> = const { Cell::new(false) };
    static CLOCK: Cell<u64> = const { Cell::new(0) };
    static SEQ: Cell<u32> = const { Cell::new(0) };
    /// JavaScript calls waiting for WebKit (so a timeout can answer for one that never returns).
    static JS_WAITING: RefCell<HashMap<u64, JsDone>> = RefCell::new(HashMap::new());
    static JS_SEQ: Cell<u64> = const { Cell::new(0) };
    /// Clicks sent as real mouse events and through the bridge script (shown by "debug", checked by the smoke test).
    static CLICKS: Cell<(u64, u64)> = const { Cell::new((0, 0)) };
    /// The last callbacks WebKit made, newest last (shown by "debug"): what to read when a page does something unexpected.
    static TRACE: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// One line in the trace (kept to the last 80).
fn trace(line: String) {
    TRACE.with(|t| {
        let mut t = t.borrow_mut();
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() % 1_000_000).unwrap_or(0);
        t.push(format!("{ms} {line}"));
        if t.len() > 80 {
            t.remove(0);
        }
    });
}

/* ---------- entry points (the same three as the Windows module) ---------- */

/// Remembers the app and takes the window's own page, which the browsers are placed against.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if let Some(main) = app.get_webview_window("main") {
        // Runs on the main thread, where the thread-local lives.
        let _ = main.with_webview(|pw| {
            let ptr = pw.inner() as *mut NSView;
            // SAFETY: Tauri hands over its own live WKWebView; retain keeps it alive for as long as the browsers need it.
            if let Some(v) = unsafe { Retained::retain(ptr) } {
                MAIN.with(|m| *m.borrow_mut() = Some(v));
            }
        });
    }
}

/// Runs one command on the main thread.
pub fn dispatch(app: &AppHandle, cmd: String, args: Value, reply: Reply) {
    let _ = app.run_on_main_thread(move || handle(&cmd, args, reply));
}

/// The window moved: the browsers are views inside it and move with it. Nothing to tell WebKit.
pub fn parent_moved(_app: &AppHandle) {}

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
        "focus" => match resolve(&a) {
            Some(id) => {
                touch(&id);
                if let Some(view) = view_of(&id) {
                    if let Some(win) = view.window() {
                        win.makeFirstResponder(Some(&view));
                    }
                }
                reply(Ok(json!({ "ok": true })));
            }
            None => reply(Err(NO_BROWSER.into())),
        },
        "state" => match resolve(&a) {
            Some(id) => {
                refresh(&id);
                reply(Ok(state_json(&id)))
            }
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
            if let Some(main) = MAIN.with(|m| m.borrow().clone()) {
                if let Some(win) = main.window() {
                    win.makeFirstResponder(Some(&main));
                }
            }
            reply(Ok(json!({ "ok": true })));
        }
        "theme" => {
            theme(a.get("dark").and_then(Value::as_bool).unwrap_or(false));
            reply(Ok(json!({ "ok": true })));
        }
        "debug" => reply(Ok(debug_json())),
        // For the smoke test: which way clicks go ("native", "js", or "auto" for the default), and the click counters back to zero.
        "mouseMode" => {
            let mode = a.get("mode").and_then(Value::as_str).unwrap_or("auto");
            MOUSE_MODE.with(|m| *m.borrow_mut() = if mode == "auto" { None } else { Some(mode.to_string()) });
            CLICKS.with(|c| c.set((0, 0)));
            reply(Ok(json!({ "ok": true, "mode": mode })));
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

/// Runs `f` on the main thread after `ms`.
fn later(ms: u64, f: impl FnOnce() + Send + 'static) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        if let Some(app) = APP.get() {
            let _ = app.run_on_main_thread(f);
        }
    });
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

/// The view of a browser (cloned out, so no borrow of BROWSERS is held while WebKit runs: it may call back at once).
fn view_of(id: &str) -> Option<Retained<ApakiWebView>> {
    BROWSERS.with(|m| m.borrow().get(id).map(|b| b.view.clone()))
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

/// Addresses a navigation inside a page may go to: the web, files, blank, and the in-page kinds (data, blob).
fn allowed_scheme(u: &str) -> bool {
    let l = u.to_ascii_lowercase();
    ["http:", "https:", "file:", "about:", "data:", "blob:"].iter().any(|s| l.starts_with(s))
}

fn state_json(id: &str) -> Value {
    BROWSERS.with(|m| match m.borrow().get(id) {
        Some(b) => json!({
            "id": id, "owner": b.owner, "url": b.url, "title": b.title, "loading": b.loading,
            "canGoBack": b.back, "canGoForward": b.forward, "status": b.status, "error": b.error,
            "visible": b.shown, "ready": true,
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

/// Reads address, title, history and loading from the view itself. Never panics: called from WebKit's callbacks.
fn refresh(id: &str) {
    let Some(view) = view_of(id) else { return };
    // SAFETY: plain property reads on a live view, on the main thread.
    let (url, title, back, forward, loading) = unsafe {
        (
            view.URL().and_then(|u| u.absoluteString()).map(|s| s.to_string()),
            view.title().map(|s| s.to_string()).unwrap_or_default(),
            view.canGoBack(),
            view.canGoForward(),
            view.isLoading(),
        )
    };
    BROWSERS.with(|m| {
        if let Ok(mut m) = m.try_borrow_mut() {
            if let Some(b) = m.get_mut(id) {
                if !b.provisional {
                    if let Some(u) = url {
                        b.url = u;
                    }
                }
                b.title = title;
                b.back = back;
                b.forward = forward;
                b.loading = loading || b.provisional;
            }
        }
    });
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
    match reply {
        Some(r) => r(Ok(state_json(id))),
        None => poll_settle(id.to_string(), 0),
    }
}

/// A same-page move (a #hash, history.pushState, a back that stays in the page) has no load to wait for: if the
/// view is not loading shortly after the request, the waiting answers go out.
fn poll_settle(id: String, n: u32) {
    later(if n == 0 { 700 } else { 300 }, move || {
        let Some(view) = view_of(&id) else { return };
        let waiting = BROWSERS.with(|m| m.borrow().get(&id).map(|b| !b.waiters.is_empty()).unwrap_or(false));
        if !waiting {
            return;
        }
        refresh(&id);
        // SAFETY: property read on a live view.
        if !unsafe { view.isLoading() } {
            settle(&id);
        } else if n < 400 {
            poll_settle(id, n + 1);
        }
    });
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

fn mtm() -> Result<MainThreadMarker, String> {
    MainThreadMarker::new().ok_or_else(|| "Apaki's browser must run on the main thread.".to_string())
}

fn os_major() -> isize {
    // NSProcessInfo is thread safe.
    NSProcessInfo::processInfo().operatingSystemVersion().majorVersion
}

fn backing_scale() -> f64 {
    MAIN.with(|m| m.borrow().as_ref().and_then(|v| v.window()).map(|w| w.backingScaleFactor())).unwrap_or(2.0)
}

fn error_text(e: &NSError) -> String {
    let (domain, code, desc) = (e.domain().to_string(), e.code(), e.localizedDescription().to_string());
    if domain == "NSURLErrorDomain" {
        return match code {
            -1003 | -1006 => "no such host",
            -1004 | -1009 => "could not connect",
            -1001 => "timed out",
            -1005 | -1017 => "the connection dropped",
            -1007 | -1019 => "a redirect failed",
            -1206..=-1200 => "the site's certificate is not valid",
            -999 => "stopped",
            _ => "the page did not load",
        }
        .to_string();
    }
    let one: String = desc.chars().take(160).collect();
    if one.is_empty() { "the page did not load".to_string() } else { one }
}

/* ---------- the WKWebView, its delegates and its watcher ---------- */

struct IdIvars {
    id: String,
}

define_class!(
    /// The page view: remembers which browser it is, tells the window when it gets the keyboard, and passes the few
    /// shortcuts Apaki owns (Cmd or Ctrl with W, T, L, Tab, 1 to 6) on to the window instead of keeping them.
    #[unsafe(super(WKWebView))]
    #[ivars = IdIvars]
    struct ApakiWebView;

    impl ApakiWebView {
        #[unsafe(method(performKeyEquivalent:))]
        fn perform_key_equivalent(&self, event: &NSEvent) -> Bool {
            if event.r#type() == NSEventType::KeyDown {
                let flags = event.modifierFlags();
                let cmd = flags.contains(NSEventModifierFlags::Command);
                let ctrl = flags.contains(NSEventModifierFlags::Control);
                let shift = flags.contains(NSEventModifierFlags::Shift);
                if cmd || ctrl {
                    let chars = event.charactersIgnoringModifiers().map(|s| s.to_string().to_lowercase()).unwrap_or_default();
                    let key = match chars.as_str() {
                        "w" | "t" | "l" => Some(chars.clone()),
                        "\t" => Some("Tab".to_string()),
                        "1" | "2" | "3" | "4" | "5" | "6" => Some(chars.clone()),
                        _ => None,
                    };
                    // Cmd+Shift+W stays the menu's Close Window.
                    if let Some(key) = key {
                        if !(key == "w" && shift && cmd) {
                            emit(json!({ "ev": "key", "id": self.ivars().id, "key": key, "shift": shift }));
                            return Bool::YES;
                        }
                    }
                }
            }
            // Anything else is for the menu bar (copy, paste, quit), or comes back as a plain key press to the page.
            Bool::NO
        }

        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> Bool {
            Bool::YES
        }

        #[unsafe(method(becomeFirstResponder))]
        fn become_first_responder(&self) -> Bool {
            let ok: Bool = unsafe { msg_send![super(self), becomeFirstResponder] };
            if ok.as_bool() {
                let id = self.ivars().id.clone();
                touch(&id);
                emit(json!({ "ev": "focus", "id": id }));
            }
            ok
        }
    }

    unsafe impl NSObjectProtocol for ApakiWebView {}
);

define_class!(
    /// Navigation: which addresses may load, when a load starts, commits, ends or fails, and the HTTP status.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = IdIvars]
    struct NavDelegate;

    unsafe impl NSObjectProtocol for NavDelegate {}

    unsafe impl WKNavigationDelegate for NavDelegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_action(&self, _wv: &WKWebView, action: &WKNavigationAction, handler: &DynBlock<dyn Fn(WKNavigationActionPolicy)>) {
            // SAFETY: reads of the action, on the main thread.
            let (url, main_frame, download) = unsafe {
                (
                    action.request().URL().and_then(|u| u.absoluteString()).map(|s| s.to_string()).unwrap_or_default(),
                    action.targetFrame().map(|f| f.isMainFrame()).unwrap_or(true),
                    action.shouldPerformDownload(),
                )
            };
            trace(format!("{} action {url} main={main_frame} download={download}", self.ivars().id));
            // Addresses of other apps (mailto:, itms-apps:, a custom scheme) are not opened from a page; downloads are not supported.
            if download || !allowed_scheme(&url) {
                handler.call((WKNavigationActionPolicy::Cancel,));
                return;
            }
            if main_frame {
                let id = self.ivars().id.clone();
                BROWSERS.with(|m| {
                    if let Ok(mut m) = m.try_borrow_mut() {
                        if let Some(b) = m.get_mut(&id) {
                            b.url = url.clone();
                            b.provisional = true;
                        }
                    }
                });
            }
            handler.call((WKNavigationActionPolicy::Allow,));
        }

        #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
        fn decide_response(&self, _wv: &WKWebView, response: &WKNavigationResponse, handler: &DynBlock<dyn Fn(WKNavigationResponsePolicy)>) {
            // SAFETY: reads of the response.
            let (main_frame, can_show, status) = unsafe {
                let r = response.response();
                let status = r.downcast_ref::<NSHTTPURLResponse>().map(|h| h.statusCode() as i32);
                (response.isForMainFrame(), response.canShowMIMEType(), status)
            };
            trace(format!("{} response main={main_frame} show={can_show} status={status:?}", self.ivars().id));
            if main_frame {
                let id = self.ivars().id.clone();
                BROWSERS.with(|m| {
                    if let Ok(mut m) = m.try_borrow_mut() {
                        if let Some(b) = m.get_mut(&id) {
                            b.status = status.filter(|c| *c > 0);
                        }
                    }
                });
            }
            // A type WebKit cannot show would be a download, which this browser does not do.
            handler.call((if can_show { WKNavigationResponsePolicy::Allow } else { WKNavigationResponsePolicy::Cancel },));
        }

        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn did_start(&self, _wv: &WKWebView, _nav: Option<&WKNavigation>) {
            let id = self.ivars().id.clone();
            trace(format!("{id} start"));
            BROWSERS.with(|m| {
                if let Ok(mut m) = m.try_borrow_mut() {
                    if let Some(b) = m.get_mut(&id) {
                        b.loading = true;
                        b.provisional = true;
                        b.error = None;
                        b.status = None;
                    }
                }
            });
            emit_state(&id);
        }

        #[unsafe(method(webView:didCommitNavigation:))]
        fn did_commit(&self, _wv: &WKWebView, _nav: Option<&WKNavigation>) {
            let id = self.ivars().id.clone();
            trace(format!("{id} commit"));
            // The address that was asked for, before the view's own takes over.
            let asked = BROWSERS.with(|m| m.borrow().get(&id).map(|b| b.url.clone())).unwrap_or_default();
            BROWSERS.with(|m| {
                if let Ok(mut m) = m.try_borrow_mut() {
                    if let Some(b) = m.get_mut(&id) {
                        b.provisional = false;
                        b.doc += 1;
                    }
                }
            });
            refresh(&id);
            // WebKit refuses some addresses (a blocked port such as 9) by committing a blank page without a word.
            let now = BROWSERS.with(|m| m.borrow().get(&id).map(|b| b.url.clone())).unwrap_or_default();
            if (now.is_empty() || now == "about:blank") && !asked.is_empty() && asked != "about:blank" {
                trace(format!("{id} the view shows a blank page for {asked}"));
                BROWSERS.with(|m| {
                    if let Ok(mut m) = m.try_borrow_mut() {
                        if let Some(b) = m.get_mut(&id) {
                            b.url = asked.clone();
                            b.error = Some("the page could not be shown (WebKit refused this address or port)".to_string());
                        }
                    }
                });
            }
            emit_state(&id);
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, _wv: &WKWebView, _nav: Option<&WKNavigation>) {
            let id = self.ivars().id.clone();
            trace(format!("{id} finish"));
            BROWSERS.with(|m| {
                if let Ok(mut m) = m.try_borrow_mut() {
                    if let Some(b) = m.get_mut(&id) {
                        b.provisional = false;
                        b.loading = false;
                    }
                }
            });
            refresh(&id);
            BROWSERS.with(|m| {
                if let Ok(mut m) = m.try_borrow_mut() {
                    if let Some(b) = m.get_mut(&id) {
                        b.loading = false;
                    }
                }
            });
            emit_state(&id);
            // The title can arrive a moment after the load ends; the answers waiting for the load carry it.
            let later_id = id.clone();
            later(120, move || {
                refresh(&later_id);
                emit_state(&later_id);
                settle(&later_id);
            });
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, _wv: &WKWebView, _nav: Option<&WKNavigation>, error: &NSError) {
            self.failed(error);
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(&self, _wv: &WKWebView, _nav: Option<&WKNavigation>, error: &NSError) {
            self.failed(error);
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn process_terminated(&self, wv: &WKWebView) {
            crate::wlog("a browser tab's web process stopped; reloading it");
            // SAFETY: reload on the live view.
            unsafe {
                wv.reload();
            }
        }
    }
);

impl NavDelegate {
    /// A load failed: the reason is kept for the engine's tools and the window; a navigation another one replaced is not a failure.
    fn failed(&self, error: &NSError) {
        let id = self.ivars().id.clone();
        let text = error_text(error);
        trace(format!("{id} failed domain={} code={} -> {text}", error.domain(), error.code()));
        let stopped = text == "stopped";
        BROWSERS.with(|m| {
            if let Ok(mut m) = m.try_borrow_mut() {
                if let Some(b) = m.get_mut(&id) {
                    b.provisional = false;
                    b.loading = false;
                    if !stopped {
                        b.error = Some(text.clone());
                    }
                }
            }
        });
        refresh(&id);
        emit_state(&id);
        settle(&id);
    }
}

define_class!(
    /// Pages' own requests: a link or script that wants a new window loads in this browser, a page that closes itself
    /// asks the window to close the tab, and alert, confirm, prompt and the file chooser are shown as sheets.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = IdIvars]
    struct UiDelegate;

    unsafe impl NSObjectProtocol for UiDelegate {}

    unsafe impl WKUIDelegate for UiDelegate {
        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn create_web_view(
            &self,
            _wv: &WKWebView,
            _config: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            // SAFETY: reads of the action.
            let url = unsafe { action.request().URL().and_then(|u| u.absoluteString()).map(|s| s.to_string()).unwrap_or_default() };
            if web_url(&url) {
                let id = self.ivars().id.clone();
                // Not inside this call: WebKit is in the middle of a navigation decision.
                later(0, move || {
                    let _ = load(&id, &url);
                });
            }
            None
        }

        #[unsafe(method(webViewDidClose:))]
        fn did_close(&self, _wv: &WKWebView) {
            emit(json!({ "ev": "closeRequested", "id": self.ivars().id }));
        }

        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn js_alert(&self, wv: &WKWebView, message: &NSString, _frame: &WKFrameInfo, handler: &DynBlock<dyn Fn()>) {
            let done = handler.copy();
            ask_sheet(wv, message, None, &["OK"], move |_, _| done.call(()));
        }

        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn js_confirm(&self, wv: &WKWebView, message: &NSString, _frame: &WKFrameInfo, handler: &DynBlock<dyn Fn(Bool)>) {
            let done = handler.copy();
            ask_sheet(wv, message, None, &["OK", "Cancel"], move |first, _| done.call((Bool::new(first),)));
        }

        #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
        fn js_prompt(&self, wv: &WKWebView, prompt: &NSString, default: Option<&NSString>, _frame: &WKFrameInfo, handler: &DynBlock<dyn Fn(*mut NSString)>) {
            let done = handler.copy();
            ask_sheet(wv, prompt, Some(default), &["OK", "Cancel"], move |first, text| {
                if first {
                    let s = NSString::from_str(&text.unwrap_or_default());
                    done.call((Retained::as_ptr(&s) as *mut NSString,));
                } else {
                    done.call((std::ptr::null_mut(),));
                }
            });
        }

        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn open_panel(&self, wv: &WKWebView, params: &WKOpenPanelParameters, _frame: &WKFrameInfo, handler: &DynBlock<dyn Fn(*mut NSArray<NSURL>)>) {
            let Some(mtm) = MainThreadMarker::new() else {
                handler.call((std::ptr::null_mut(),));
                return;
            };
            let Some(win) = wv.window() else {
                handler.call((std::ptr::null_mut(),));
                return;
            };
            let done = handler.copy();
            // SAFETY: AppKit calls on the main thread; the panel and the block live until the sheet ends.
            unsafe {
                let panel = NSOpenPanel::openPanel(mtm);
                panel.setCanChooseFiles(true);
                panel.setAllowsMultipleSelection(params.allowsMultipleSelection());
                panel.setCanChooseDirectories(params.allowsDirectories());
                let keep = panel.clone();
                let block = RcBlock::new(move |response: NSModalResponse| {
                    if response == NSModalResponseOK {
                        let urls = keep.URLs();
                        done.call((Retained::as_ptr(&urls) as *mut NSArray<NSURL>,));
                    } else {
                        done.call((std::ptr::null_mut(),));
                    }
                });
                panel.beginSheetModalForWindow_completionHandler(&win, &block);
            }
        }
    }
);

/// A page dialog as a sheet on the window: `buttons` are the titles, the callback gets whether the first was pressed
/// and the text of the field when `field` is Some (its inner value is the default text).
fn ask_sheet(wv: &WKWebView, message: &NSString, field: Option<Option<&NSString>>, buttons: &[&str], done: impl Fn(bool, Option<String>) + 'static) {
    let (Some(mtm), Some(win)) = (MainThreadMarker::new(), wv.window()) else {
        done(false, None);
        return;
    };
    // AppKit calls on the main thread; the alert and its field live in the block until the sheet ends.
    {
        let alert = NSAlert::new(mtm);
        alert.setMessageText(message);
        for b in buttons {
            alert.addButtonWithTitle(&NSString::from_str(b));
        }
        let input = field.map(|default| {
            let f = NSTextField::new(mtm);
            f.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(280.0, 24.0)));
            if let Some(d) = default {
                f.setStringValue(d);
            }
            alert.setAccessoryView(Some(&f));
            f
        });
        let keep = alert.clone();
        let block = RcBlock::new(move |response: NSModalResponse| {
            let first = response == 1000;
            done(first, input.as_ref().map(|f| f.stringValue().to_string()));
        });
        keep.beginSheetModalForWindow_completionHandler(&win, Some(&block));
    }
}

define_class!(
    /// Key-value observer on the view: address, title, history and loading change without a navigation callback
    /// (history.pushState, a title set by script), so the window is told from here.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = IdIvars]
    struct Watcher;

    impl Watcher {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe(&self, _key_path: Option<&NSString>, _object: Option<&AnyObject>, _change: Option<&NSDictionary<NSKeyValueChangeKey, AnyObject>>, _context: *mut c_void) {
            let id = self.ivars().id.clone();
            refresh(&id);
            trace(format!("{id} changed {:?} -> {}", _key_path.map(|k| k.to_string()), state_json(&id)));
            emit_state(&id);
        }
    }

    unsafe impl NSObjectProtocol for Watcher {}
);

/// The properties the watcher observes (KVO key paths of WKWebView).
const WATCHED: [&str; 5] = ["URL", "title", "canGoBack", "canGoForward", "loading"];

/* ---------- making and closing a browser ---------- */

/// The browsers' own website data store.
fn data_store(mtm: MainThreadMarker) -> Retained<WKWebsiteDataStore> {
    if let Some(s) = STORE.with(|s| s.borrow().clone()) {
        return s;
    }
    // SAFETY: class methods of WebKit, on the main thread. A persistent store of our own needs macOS 14.
    let store = unsafe {
        if os_major() >= 14 {
            WKWebsiteDataStore::dataStoreForIdentifier(&NSUUID::from_bytes(PROFILE_UUID), mtm)
        } else {
            WKWebsiteDataStore::defaultDataStore(mtm)
        }
    };
    STORE.with(|s| *s.borrow_mut() = Some(store.clone()));
    store
}

/// The frame (in the window page's parent view) for a rectangle in points relative to the window's page, top left origin.
fn frame_for(rect: (f64, f64, f64, f64)) -> Option<(Retained<NSView>, NSRect)> {
    let main = MAIN.with(|m| m.borrow().clone())?;
    // SAFETY: superview is a plain read.
    let parent = unsafe { main.superview() }?;
    let (x, y, w, h) = rect;
    let in_main = if main.isFlipped() {
        NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
    } else {
        NSRect::new(NSPoint::new(x, main.bounds().size.height - y - h), NSSize::new(w, h))
    };
    Some((parent.clone(), parent.convertRect_fromView(in_main, Some(&main))))
}

fn create(id: &str, owner: Option<String>) -> Result<(), String> {
    let mtm = mtm()?;
    let (parent, frame) = frame_for(DEFAULT_RECT).ok_or("Apaki's window is not ready yet.")?;
    // SAFETY: WebKit and AppKit calls on the main thread with objects created here.
    let (view, nav, ui, watch) = unsafe {
        let config = WKWebViewConfiguration::new(mtm);
        config.setWebsiteDataStore(&data_store(mtm));
        config.setApplicationNameForUserAgent(Some(&NSString::from_str(UA_SUFFIX)));
        config.preferences().setJavaScriptCanOpenWindowsAutomatically(true);

        let this = mtm.alloc::<ApakiWebView>().set_ivars(IdIvars { id: id.to_string() });
        let view: Retained<ApakiWebView> = msg_send![super(this), initWithFrame: frame, configuration: &*config];
        view.setHidden(true);
        view.setAllowsBackForwardNavigationGestures(true);
        if os_major() >= 13 {
            // Safari's Web Inspector can attach (Develop menu), as the DevTools can on Windows.
            view.setInspectable(true);
        }
        view.setAppearance(NSAppearance::appearanceNamed(if DARK.with(Cell::get) { NSAppearanceNameDarkAqua } else { NSAppearanceNameAqua }).as_deref());

        let nav = mtm.alloc::<NavDelegate>().set_ivars(IdIvars { id: id.to_string() });
        let nav: Retained<NavDelegate> = msg_send![super(nav), init];
        view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*nav)));
        let ui = mtm.alloc::<UiDelegate>().set_ivars(IdIvars { id: id.to_string() });
        let ui: Retained<UiDelegate> = msg_send![super(ui), init];
        view.setUIDelegate(Some(ProtocolObject::from_ref(&*ui)));

        let watch = mtm.alloc::<Watcher>().set_ivars(IdIvars { id: id.to_string() });
        let watch: Retained<Watcher> = msg_send![super(watch), init];
        for key in WATCHED {
            view.addObserver_forKeyPath_options_context(&watch, &NSString::from_str(key), NSKeyValueObservingOptions::New, std::ptr::null_mut());
        }
        parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Above, None::<&NSView>);
        (view, nav, ui, watch)
    };
    BROWSERS.with(|m| {
        m.borrow_mut().insert(
            id.to_string(),
            Browser {
                owner,
                view,
                _nav: nav,
                _ui: ui,
                watch,
                url: String::new(),
                title: String::new(),
                loading: false,
                provisional: false,
                back: false,
                forward: false,
                status: None,
                error: None,
                shown: false,
                rendering: 0,
                rect: DEFAULT_RECT,
                used: tick(),
                waiters: Vec::new(),
                doc: 0,
            },
        );
    });
    Ok(())
}

fn close(id: &str) {
    let Some(b) = BROWSERS.with(|m| m.borrow_mut().remove(id)) else { return };
    for w in b.waiters {
        w(Err("The browser was closed.".into()));
    }
    // SAFETY: observers are removed before the view goes (a view that dies with observers attached crashes).
    unsafe {
        for key in WATCHED {
            b.view.removeObserver_forKeyPath(&b.watch, &NSString::from_str(key));
        }
        b.view.setNavigationDelegate(None);
        b.view.setUIDelegate(None);
        b.view.stopLoading();
        b.view.removeFromSuperview();
    }
    emit(json!({ "ev": "closed", "id": id }));
}

/// Sets frame, visibility and (for a hidden browser being drawn for a picture) invisibility.
fn apply(id: &str) {
    let Some((view, rect, shown, rendering)) = BROWSERS.with(|m| m.borrow().get(id).map(|b| (b.view.clone(), b.rect, b.shown, b.rendering))) else { return };
    if let Some((_, frame)) = frame_for(rect) {
        view.setFrame(frame);
    }
    view.setHidden(!(shown || rendering > 0));
    view.setAlphaValue(if shown { 1.0 } else { 0.0 });
}

/// Bounds in physical pixels inside Apaki's window, and whether it shows.
fn place(a: &Value) {
    let Some(id) = a.get("id").and_then(Value::as_str) else { return };
    let scale = backing_scale().max(1.0);
    let n = |k: &str| a.get(k).and_then(Value::as_f64).unwrap_or(0.0) / scale;
    let rect = (n("x"), n("y"), n("w").max(1.0 / scale), n("h").max(1.0 / scale));
    let visible = a.get("visible").and_then(Value::as_bool).unwrap_or(true);
    let found = BROWSERS.with(|m| {
        m.borrow_mut().get_mut(id).map(|b| {
            b.rect = rect;
            b.shown = visible;
        })
    });
    if found.is_some() {
        apply(id);
    }
}

/// A hidden browser still draws (invisibly) while a picture is taken.
fn hold_render(id: &str) {
    BROWSERS.with(|m| {
        if let Some(b) = m.borrow_mut().get_mut(id) {
            b.rendering += 1;
        }
    });
    apply(id);
}

fn release_render(id: &str) {
    BROWSERS.with(|m| {
        if let Some(b) = m.borrow_mut().get_mut(id) {
            b.rendering = b.rendering.saturating_sub(1);
        }
    });
    apply(id);
}

/// Pages see Apaki's theme as prefers-color-scheme.
fn theme(dark: bool) {
    DARK.with(|d| d.set(dark));
    let views: Vec<Retained<ApakiWebView>> = BROWSERS.with(|m| m.borrow().values().map(|b| b.view.clone()).collect());
    // SAFETY: AppKit calls on the main thread.
    let appearance = unsafe { NSAppearance::appearanceNamed(if dark { NSAppearanceNameDarkAqua } else { NSAppearanceNameAqua }) };
    for v in views {
        v.setAppearance(appearance.as_deref());
    }
}

/// For diagnosing placement (command "debug"): the window, its page, its parent and every browser's frame.
fn debug_json() -> Value {
    let main = MAIN.with(|m| m.borrow().clone());
    let rect = |r: NSRect| json!({ "x": r.origin.x, "y": r.origin.y, "w": r.size.width, "h": r.size.height });
    let frames: Vec<Value> = BROWSERS.with(|m| {
        m.borrow().iter().map(|(id, b)| json!({ "id": id, "frame": rect(b.view.frame()), "hidden": b.view.isHidden(), "rect": b.rect, "shown": b.shown })).collect()
    });
    json!({
        "scale": backing_scale(),
        "os": os_major(),
        "main": main.as_ref().map(|v| json!({ "frame": rect(v.frame()), "bounds": rect(v.bounds()), "flipped": v.isFlipped() })),
        // SAFETY: plain reads.
        "parent": main.as_ref().and_then(|v| unsafe { v.superview() }).map(|p| json!({ "frame": rect(p.frame()), "flipped": p.isFlipped() })),
        "window": main.as_ref().and_then(|v| v.window()).map(|w| json!({ "frame": rect(w.frame()), "key": w.isKeyWindow() })),
        "browsers": frames,
        "mouse": { "native": CLICKS.with(Cell::get).0, "js": CLICKS.with(Cell::get).1 },
        "trace": TRACE.with(|t| t.borrow().clone()),
    })
}

/* ---------- commands ---------- */

/// Loads an address in a browser: a file through loadFileURL (WKWebView refuses a plain file request), the rest as a request.
fn load(id: &str, url: &str) -> Result<(), String> {
    let view = view_of(id).ok_or(NO_BROWSER)?;
    let ns = NSURL::URLWithString(&NSString::from_str(url)).ok_or_else(|| format!("\"{url}\" is not a valid address."))?;
    // SAFETY: loads on the live view, on the main thread.
    unsafe {
        if ns.isFileURL() {
            let dir = ns.URLByDeletingLastPathComponent().unwrap_or_else(|| ns.clone());
            view.loadFileURL_allowingReadAccessToURL(&ns, &dir);
        } else {
            view.loadRequest(&NSURLRequest::requestWithURL(&ns));
        }
    }
    Ok(())
}

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
                b.provisional = true;
                b.url = url.clone();
                b.error = None;
                b.status = None;
            }
        });
        if let Err(e) = load(&id, &url) {
            reply(Err(e));
            return;
        }
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
            b.provisional = true;
            b.url = url.clone();
            b.error = None;
        }
    });
    match load(&id, &url) {
        Err(e) => reply(Err(e)),
        Ok(()) if wait => wait_for_load(&id, reply),
        Ok(()) => reply(Ok(state_json(&id))),
    }
}

fn nav(a: Value, reply: Reply) {
    let Some(id) = resolve(&a) else { return reply(Err(NO_BROWSER.into())) };
    let Some(view) = view_of(&id) else { return reply(Err(NO_BROWSER.into())) };
    let action = a.get("action").and_then(Value::as_str).unwrap_or("").to_string();
    let wait = a.get("wait").and_then(Value::as_bool).unwrap_or(false);
    touch(&id);
    // SAFETY: history and load calls on the live view.
    let r: Result<bool, String> = unsafe {
        match action.as_str() {
            "back" => {
                if view.canGoBack() {
                    view.goBack();
                    Ok(true)
                } else {
                    Err("There is no earlier page in this browser.".into())
                }
            }
            "forward" => {
                if view.canGoForward() {
                    view.goForward();
                    Ok(true)
                } else {
                    Err("There is no later page in this browser.".into())
                }
            }
            "reload" => {
                view.reload();
                Ok(true)
            }
            "stop" => {
                view.stopLoading();
                Ok(false)
            }
            other => Err(format!("unknown browser action \"{other}\"")),
        }
    };
    match r {
        Err(e) => reply(Err(e)),
        Ok(true) if wait => wait_for_load(&id, reply),
        Ok(_) => {
            refresh(&id);
            reply(Ok(state_json(&id)))
        }
    }
}

/* ---------- the protocol calls the engine makes ---------- */

/// One DevTools-protocol-shaped call: {id | owner, method, params, render?}. Answers {id, result}.
fn cdp(a: Value, reply: Reply) {
    let Some(id) = resolve(&a) else { return reply(Err(NO_BROWSER.into())) };
    let method = a.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let params = a.get("params").filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({}));
    touch(&id);
    match method.as_str() {
        "Page.getFrameTree" => {
            let (url, doc) = BROWSERS.with(|m| m.borrow().get(&id).map(|b| (b.url.clone(), b.doc)).unwrap_or_default());
            reply(Ok(json!({ "id": id, "result": { "frameTree": { "frame": { "id": "main", "loaderId": format!("d{doc}"), "url": url } } } })));
        }
        "Page.createIsolatedWorld" => {
            let doc = BROWSERS.with(|m| m.borrow().get(&id).map(|b| b.doc).unwrap_or(0));
            reply(Ok(json!({ "id": id, "result": { "executionContextId": doc + 1 } })));
        }
        "Runtime.evaluate" => evaluate(&id, &params, reply),
        "Input.dispatchMouseEvent" => mouse(&id, &params, reply),
        "Input.insertText" => {
            let text = params.get("text").and_then(Value::as_str).unwrap_or("");
            bridge_call(&id, &format!("insertText({})", Value::from(text)), reply);
        }
        "Input.dispatchKeyEvent" => {
            let s = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let vk = params.get("windowsVirtualKeyCode").and_then(Value::as_i64).unwrap_or(0);
            let text = s("text");
            bridge_call(
                &id,
                &format!("key({}, {}, {}, {}, {})", Value::from(s("type")), Value::from(s("key")), Value::from(s("code")), vk, Value::from(text)),
                reply,
            );
        }
        "Page.captureScreenshot" => capture_protocol(&id, &params, reply),
        other => reply(Err(format!("Apaki's browser on macOS does not answer the protocol call {other}."))),
    }
}

/// Runs a function body in the browser's isolated world and hands over its string result (or the exception's message).
fn run_js(id: &str, body: String, timeout_ms: u64, done: JsDone) {
    let (Some(view), Ok(mtm)) = (view_of(id), mtm()) else {
        done(Err(NO_BROWSER.to_string()));
        return;
    };
    let key = JS_SEQ.with(|s| {
        s.set(s.get() + 1);
        s.get()
    });
    JS_WAITING.with(|w| w.borrow_mut().insert(key, done));
    let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
        let Some(done) = JS_WAITING.with(|w| w.borrow_mut().remove(&key)) else { return };
        // SAFETY: WebKit passes live objects or null, valid for this call.
        if let Some(e) = unsafe { error.as_ref() } {
            done(Err(js_error_text(e)));
            return;
        }
        let text = unsafe { result.as_ref() }.and_then(|o| o.downcast_ref::<NSString>().map(|s| s.to_string()));
        done(Ok(text));
    });
    // SAFETY: the call is made on the main thread with live objects; WebKit copies the block.
    unsafe {
        let world = match WORLD_OBJ.with(|w| w.borrow().clone()) {
            Some(w) => w,
            None => {
                let w = WKContentWorld::worldWithName(&NSString::from_str(WORLD), mtm);
                WORLD_OBJ.with(|slot| *slot.borrow_mut() = Some(w.clone()));
                w
            }
        };
        view.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(&NSString::from_str(&body), None, None, &world, Some(&block));
    }
    later(timeout_ms, move || {
        if let Some(done) = JS_WAITING.with(|w| w.borrow_mut().remove(&key)) {
            done(Err(format!("The page did not answer within {} s.", timeout_ms / 1000)));
        }
    });
}

/// The message of a JavaScript exception (WebKit puts it in the error's user info), else the error's description.
fn js_error_text(e: &NSError) -> String {
    {
        let info = e.userInfo();
        let key = NSString::from_str("WKJavaScriptExceptionMessage");
        if let Some(m) = info.objectForKey(&key) {
            if let Some(s) = m.downcast_ref::<NSString>() {
                return s.to_string();
            }
        }
        e.localizedDescription().to_string()
    }
}

/// Runtime.evaluate: the expression runs in the isolated world; the value comes back as JSON.
fn evaluate(id: &str, params: &Value, reply: Reply) {
    let expr = params.get("expression").and_then(Value::as_str).unwrap_or("").to_string();
    let timeout = params.get("timeout").and_then(Value::as_u64).unwrap_or(15000).clamp(1000, 60000);
    let body = format!("const __v = await (\n{expr}\n);\nreturn __v === undefined ? null : JSON.stringify(__v);");
    let id2 = id.to_string();
    run_js(id, body, timeout, Box::new(move |r| {
        let result = match r {
            Ok(Some(text)) => json!({ "result": { "type": "object", "value": serde_json::from_str::<Value>(&text).unwrap_or(Value::Null) } }),
            Ok(None) => json!({ "result": { "type": "undefined" } }),
            Err(message) => json!({ "result": { "type": "object", "subtype": "error" }, "exceptionDetails": { "text": message, "exception": { "description": message } } }),
        };
        reply(Ok(json!({ "id": id2, "result": result })));
    }));
}

/// A call into the bridge script (browser_mac_bridge.js) in the isolated world; answers {id, result: {}} or the error.
fn bridge_call(id: &str, call: &str, reply: Reply) {
    let body = format!("const __m = ({BRIDGE})();\nreturn JSON.stringify(__m.{call});");
    let id2 = id.to_string();
    run_js(id, body, 8000, Box::new(move |r| match r {
        Ok(_) => reply(Ok(json!({ "id": id2, "result": {} }))),
        Err(message) => reply(Err(message)),
    }));
}

/// Input.dispatchMouseEvent: a real click event when the page is on screen, else the bridge's.
fn mouse(id: &str, p: &Value, reply: Reply) {
    let kind = p.get("type").and_then(Value::as_str).unwrap_or("").to_string();
    let x = p.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = p.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    let clicks = p.get("clickCount").and_then(Value::as_i64).unwrap_or(1).max(1);
    let button = p.get("button").and_then(Value::as_str).unwrap_or("left");
    let on_screen = BROWSERS.with(|m| m.borrow().get(id).map(|b| b.shown).unwrap_or(false));
    let forced_js = MOUSE_MODE.with(|m| m.borrow().clone()).map(|v| v == "js").unwrap_or_else(|| std::env::var("APAKI_BROWSER_MOUSE").map(|v| v == "js").unwrap_or(false));
    let pressed = kind == "mousePressed";
    if on_screen && !forced_js && button != "right" {
        if native_mouse(id, &kind, x, y, clicks) {
            if pressed {
                CLICKS.with(|c| c.set((c.get().0 + 1, c.get().1)));
            }
            reply(Ok(json!({ "id": id, "result": {} })));
            return;
        }
    }
    if pressed {
        CLICKS.with(|c| c.set((c.get().0, c.get().1 + 1)));
    }
    bridge_call(id, &format!("mouse({}, {x}, {y}, {}, {clicks})", Value::from(kind), Value::from(button)), reply);
}

/// Sends the event to the view as AppKit would (a trusted mouse event, so pages that insist on one are satisfied).
/// False when it cannot (no window, an unknown type): the caller falls back to the bridge.
fn native_mouse(id: &str, kind: &str, x: f64, y: f64, clicks: i64) -> bool {
    let Some(view) = view_of(id) else { return false };
    let Some(win) = view.window() else { return false };
    let ty = match kind {
        "mouseMoved" => NSEventType::MouseMoved,
        "mousePressed" => NSEventType::LeftMouseDown,
        "mouseReleased" => NSEventType::LeftMouseUp,
        _ => return false,
    };
    let in_view = if view.isFlipped() { NSPoint::new(x, y) } else { NSPoint::new(x, view.bounds().size.height - y) };
    let in_window = view.convertPoint_toView(in_view, None);
    // Event creation and delivery on the main thread, to a live view in a live window.
    {
        let when = NSProcessInfo::processInfo().systemUptime();
        let pressure = if ty == NSEventType::LeftMouseDown { 1.0 } else { 0.0 };
        let Some(ev) = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            ty,
            in_window,
            NSEventModifierFlags::empty(),
            when,
            win.windowNumber(),
            None,
            tick() as isize,
            clicks as isize,
            pressure,
        ) else {
            return false;
        };
        match ty {
            NSEventType::MouseMoved => view.mouseMoved(&ev),
            NSEventType::LeftMouseDown => view.mouseDown(&ev),
            _ => view.mouseUp(&ev),
        }
    }
    true
}

/* ---------- pictures ---------- */

/// Page.captureScreenshot: {format, quality, clip: {width, height, scale}}. The clip's x and y are page coordinates
/// (the scroll position); a snapshot is always of what is in view, so only its size matters.
fn capture_protocol(id: &str, p: &Value, reply: Reply) {
    let png = p.get("format").and_then(Value::as_str).unwrap_or("png") != "jpeg";
    let quality = p.get("quality").and_then(Value::as_f64).unwrap_or(80.0).clamp(10.0, 100.0) / 100.0;
    let clip = p.get("clip").filter(|c| c.is_object()).map(|c| {
        let f = |k: &str| c.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        (f("width"), f("height"), if f("scale") > 0.0 { f("scale") } else { 1.0 })
    });
    let id2 = id.to_string();
    capture(id, png, quality, clip, Box::new(move |r| match r {
        Ok(data) => reply(Ok(json!({ "id": id2, "result": { "data": data } }))),
        Err(e) => reply(Err(e)),
    }));
}

/// A picture of what the browser shows for the window to put in its place while a menu or sheet covers it.
fn snapshot(a: Value, reply: Reply) {
    let Some(id) = resolve(&a) else { return reply(Err(NO_BROWSER.into())) };
    let quality = a.get("quality").and_then(Value::as_u64).unwrap_or(72).clamp(30, 95) as f64 / 100.0;
    let id2 = id.clone();
    capture(&id, false, quality, None, Box::new(move |r| match r {
        Ok(data) => reply(Ok(json!({ "id": id2, "dataUrl": format!("data:image/jpeg;base64,{data}") }))),
        Err(e) => reply(Err(e)),
    }));
}

type PictureDone = Box<dyn FnOnce(Result<String, String>)>;

/// A snapshot of the part in view, `clip` = (css width, css height, scale) as the protocol would take it. The result
/// is base64 of a PNG or a JPEG.
fn capture(id: &str, png: bool, quality: f64, clip: Option<(f64, f64, f64)>, done: PictureDone) {
    let Some(view) = view_of(id) else { return done(Err(NO_BROWSER.into())) };
    let Ok(mtm) = mtm() else { return done(Err("not on the main thread".into())) };
    hold_render(id);
    let bounds = view.bounds();
    let (w, h) = match clip {
        Some((cw, ch, _)) if cw >= 1.0 && ch >= 1.0 => (cw.min(bounds.size.width), ch.min(bounds.size.height)),
        _ => (bounds.size.width, bounds.size.height),
    };
    let scale = backing_scale();
    // The width in pixels the caller asked for: the protocol's clip width x scale x device pixel ratio.
    let want_px = (w * clip.map(|c| c.2).unwrap_or(1.0) * scale).clamp(1.0, MAX_PICTURE_PX).round();
    take_snapshot(id.to_string(), view, mtm, w, h, want_px, want_px / scale, png, quality, 0, done);
}

#[allow(clippy::too_many_arguments)]
fn take_snapshot(id: String, view: Retained<ApakiWebView>, mtm: MainThreadMarker, w: f64, h: f64, want_px: f64, snap_width: f64, png: bool, quality: f64, attempt: u8, done: PictureDone) {
    let done = RefCell::new(Some(done));
    let view2 = view.clone();
    let id2 = id.clone();
    let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let Some(done) = done.borrow_mut().take() else { return };
        // SAFETY: WebKit passes a live image or error, or null.
        let outcome = unsafe {
            match (image.as_ref(), error.as_ref()) {
                (Some(img), _) => encode(img, png, quality),
                (None, Some(e)) => Err(e.localizedDescription().to_string()),
                _ => Err("no picture came back".to_string()),
            }
        };
        match outcome {
            Ok((data, px)) if attempt == 0 && (px - want_px).abs() > want_px * 0.03 + 1.0 && px > 0.0 => {
                // The picture came out at another size than asked (a display's scale differs from the window's): once more, corrected.
                let _ = data;
                take_snapshot(id2.clone(), view2.clone(), mtm, w, h, want_px, snap_width * want_px / px, png, quality, 1, done);
            }
            Ok((data, _)) => {
                release_render(&id2);
                done(Ok(data));
            }
            Err(e) => {
                release_render(&id2);
                done(Err(e));
            }
        }
    });
    // SAFETY: snapshot configuration and call on the main thread with live objects.
    unsafe {
        let cfg = WKSnapshotConfiguration::new(mtm);
        cfg.setRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(w, h)));
        cfg.setSnapshotWidth(Some(&NSNumber::new_f64(snap_width)));
        cfg.setAfterScreenUpdates(true);
        view.takeSnapshotWithConfiguration_completionHandler(Some(&cfg), &block);
    }
}

/// A snapshot as base64 of a PNG or a JPEG, with its width in pixels.
///
/// # Safety
/// Main thread, a live image.
unsafe fn encode(image: &NSImage, png: bool, quality: f64) -> Result<(String, f64), String> {
    let tiff = image.TIFFRepresentation().ok_or("the picture could not be read")?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("the picture could not be read")?;
    let px = rep.pixelsWide() as f64;
    let props: Retained<NSDictionary<NSString, AnyObject>> = if png {
        NSDictionary::new()
    } else {
        let factor = NSNumber::new_f64(quality);
        // SAFETY: an NSNumber is an object like any other.
        let factor: Retained<AnyObject> = unsafe { Retained::cast_unchecked(factor) };
        NSDictionary::from_retained_objects(&[ns_string!("NSImageCompressionFactor")], &[factor])
    };
    let data: Retained<NSData> = rep
        .representationUsingType_properties(if png { NSBitmapImageFileType::PNG } else { NSBitmapImageFileType::JPEG }, &props)
        .ok_or("the picture could not be encoded")?;
    Ok((data.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty()).to_string(), px))
}

#[allow(dead_code)]
fn _types_used(_: &NSWindow) {}
