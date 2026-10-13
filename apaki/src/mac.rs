//! mac.rs: what is different about Myrlin Apaki on macOS (compiled on macOS only, apart from the pure helpers).
//!
//! WHY (Arthur, 2026-10-12, "start working on the mac port"): the window, the engine host and the UI are the same
//! on every platform. What a Mac needs on top:
//!   - a menu bar with the standard items. Cut/copy/paste/select-all only work inside a web view when the app menu
//!     has them (they are key equivalents of the menu, not of the page), and Cmd+Q must close the window the same
//!     way the close button does so the engine host's last workspace save is flushed (main.rs, Destroyed).
//!     There is deliberately no Cmd+W item: the page uses Cmd+W (and Ctrl+W) to close the focused pane, so Close
//!     Window is Cmd+Shift+W here.
//!   - the page tweaks for the native traffic lights and Cmd hints (mac.js, injected as a plugin init script, so
//!     apaki/ui, which is also the phone page, stays untouched; see mac.js for why that matters).
//!   - a PATH an app started from the Dock can use: such an app gets launchd's short PATH
//!     (/usr/bin:/bin:/usr/sbin:/sbin), without Homebrew's git/gh or ~/.local/bin; the engine host gets the usual
//!     places added so worktree actions and Codex are found.
//! The pure helpers (bundle folders, the PATH) compile and are tested on every platform.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The folders a packaged build keeps its `engine` and `node` in, best first: next to the executable (the Windows
/// package), then `Contents/Resources` of the .app when the executable is `Contents/MacOS/<name>` (where Tauri's
/// bundle.resources puts them on a Mac).
pub fn bundle_dirs(exe_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![exe_dir.to_path_buf()];
    if exe_dir.file_name().is_some_and(|n| n == "MacOS") {
        if let Some(contents) = exe_dir.parent() {
            dirs.push(contents.join("Resources"));
        }
    }
    dirs
}

/// `path` with these folders added after what it has (those not already there), as a PATH value. None when nothing
/// would change.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn path_with_extras(current: Option<&OsString>, extras: &[PathBuf]) -> Option<OsString> {
    let mut parts: Vec<PathBuf> = current.map(|c| std::env::split_paths(c).collect()).unwrap_or_default();
    let mut changed = false;
    for e in extras {
        if !parts.iter().any(|p| p == e) {
            parts.push(e.clone());
            changed = true;
        }
    }
    if !changed {
        return None;
    }
    std::env::join_paths(parts).ok()
}

/// The places a developer's tools live on a Mac, which an app started from the Dock does not have on PATH.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn tool_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".local").join("bin"),
        home.join(".cargo").join("bin"),
        home.join(".bun").join("bin"),
        home.join(".npm-global").join("bin"),
    ]
}

/// The PATH the engine host should start with: this process's, plus the tool places above.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn host_path() -> Option<OsString> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    path_with_extras(std::env::var_os("PATH").as_ref(), &tool_dirs(&home))
}

#[cfg(target_os = "macos")]
mod imp {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    use tauri::plugin::{Builder, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    /// The page tweaks (mac.js), added to every window the app creates.
    pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("apaki-mac").js_init_script(include_str!("mac.js").to_string()).build()
    }

    /// The menu bar: Myrlin Apaki, Edit, View, Window.
    pub fn install_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
        let quit = MenuItemBuilder::new("Quit Myrlin Apaki").id("quit").accelerator("CmdOrCtrl+Q").build(app)?;
        let close = MenuItemBuilder::new("Close Window").id("close-window").accelerator("CmdOrCtrl+Shift+W").build(app)?;
        let app_menu = SubmenuBuilder::new(app, "Myrlin Apaki")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&quit)
            .build()?;
        let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
        let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
        let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().item(&close).build()?;
        let menu = MenuBuilder::new(app).items(&[&app_menu, &edit, &view, &window]).build()?;
        app.set_menu(menu)?;
        Ok(())
    }

    /// Quit and Close Window close the window (so main.rs flushes the workspace and the app ends with its last window).
    pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
        match event.id().as_ref() {
            "quit" | "close-window" => {
                let windows = app.webview_windows();
                if windows.is_empty() {
                    app.exit(0);
                }
                for w in windows.values() {
                    let _ = w.close();
                }
            }
            _ => {}
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::{install_menu, on_menu_event, plugin};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mac_app_bundle_looks_in_resources_too() {
        let d = bundle_dirs(Path::new("/Applications/Myrlin Apaki.app/Contents/MacOS"));
        assert_eq!(d, vec![PathBuf::from("/Applications/Myrlin Apaki.app/Contents/MacOS"), PathBuf::from("/Applications/Myrlin Apaki.app/Contents/Resources")]);
    }

    #[test]
    fn a_windows_style_folder_has_only_itself() {
        let d = bundle_dirs(Path::new("/opt/apaki"));
        assert_eq!(d, vec![PathBuf::from("/opt/apaki")]);
    }

    #[test]
    fn path_gets_the_tool_places_once() {
        let current = std::env::join_paths([PathBuf::from("/usr/bin"), PathBuf::from("/bin")]).unwrap();
        let extras = tool_dirs(Path::new("/Users/a"));
        let out = path_with_extras(Some(&current), &extras).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&out).collect();
        assert_eq!(parts[0], PathBuf::from("/usr/bin"), "what was there stays first");
        assert!(parts.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(parts.contains(&PathBuf::from("/Users/a/.local/bin")));
        // Already complete: nothing to change.
        assert!(path_with_extras(Some(&out), &extras).is_none());
    }

    #[test]
    fn no_path_at_all_is_still_a_path() {
        let out = path_with_extras(None, &tool_dirs(Path::new("/Users/a"))).unwrap();
        assert!(std::env::split_paths(&out).any(|p| p == PathBuf::from("/opt/homebrew/bin")));
    }
}
