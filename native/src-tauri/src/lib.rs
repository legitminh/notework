//! Tauri shell for the Notework web build (macOS, Windows, Linux, iOS).
//!
//! The window loads the same static build the PWA ships, from Tauri's own app
//! origin. Besides the GitHub login requests in `github`, the commands are the machine folder ones in `fs`: the page lists
//! names to choose folders in Notework's own folder browser, and reads and writes
//! contents only below folders the person chose.
mod fs;
mod github;

use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// Pages served by the app itself: the bundled build, or the Vite dev server in debug builds.
fn is_app(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            host == "tauri.localhost"
                || (cfg!(debug_assertions) && matches!(host, "localhost" | "127.0.0.1"))
        }
        _ => false,
    }
}

/// Links to other sites (such as GitHub token pages) open in the system browser.
fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

/// macOS needs an Edit menu for Cmd+C/V/X/A. Undo and redo are left to the editor so
/// its own history handles them. Windows and Linux get no menu, so every Ctrl shortcut
/// (Vim's Ctrl+R and Ctrl+W included) reaches Notework untouched.
#[cfg(target_os = "macos")]
fn menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, PredefinedMenuItem as Item, Submenu};
    Menu::with_items(app, &[
        &Submenu::with_items(app, "Notework", true, &[
            &Item::about(app, None, None)?,
            &Item::separator(app)?,
            &Item::hide(app, None)?,
            &Item::hide_others(app, None)?,
            &Item::show_all(app, None)?,
            &Item::separator(app)?,
            &Item::quit(app, None)?,
        ])?,
        &Submenu::with_items(app, "Edit", true, &[
            &Item::cut(app, None)?,
            &Item::copy(app, None)?,
            &Item::paste(app, None)?,
            &Item::select_all(app, None)?,
        ])?,
        &Submenu::with_items(app, "View", true, &[&Item::fullscreen(app, None)?])?,
        &Submenu::with_items(app, "Window", true, &[
            &Item::minimize(app, None)?,
            &Item::maximize(app, None)?,
            &Item::separator(app)?,
            &Item::close_window(app, None)?,
        ])?,
    ])
}

/// macOS normally treats Escape as a request to leave native fullscreen. Swallow
/// that AppKit event and deliver an equivalent DOM event straight to Notework, so
/// an unhandled webview key can never bubble back to NSWindow and leave fullscreen.
#[cfg(target_os = "macos")]
fn keep_escape_in_fullscreen(webview: tauri::WebviewWindow) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSWindow, NSWindowStyleMask};
    use std::{ptr, ptr::NonNull};

    let handler = RcBlock::new(move |event: NonNull<NSEvent>| {
        let event = unsafe { event.as_ref() };
        if event.keyCode() == 53 {
            let fullscreen = webview.ns_window().ok().and_then(|window| unsafe {
                window.cast::<NSWindow>().as_ref()
            }).is_some_and(|window| window.styleMask().contains(NSWindowStyleMask::FullScreen));
            if fullscreen {
                let _ = webview.eval("(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, composed: true }));");
                return ptr::null_mut();
            }
        }
        event as *const NSEvent as *mut NSEvent
    });

    // The monitor intentionally lives for the process lifetime; Notework creates one
    // main window and installs this once during setup.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
    };
    std::mem::forget(monitor);
}

/// WebKitGTK ships the Storage API and the origin private file system (OPFS) turned off.
/// Notework keeps browser documents in OPFS, so the Linux app turns them on, then loads
/// the app. The bindings are declared here because the webkit2gtk crate predates them.
#[cfg(target_os = "linux")]
mod webkitgtk {
    use std::ffi::{c_char, c_int, c_void, CStr};
    use webkit2gtk::glib::object::ObjectType;
    use webkit2gtk::WebViewExt;

    extern "C" {
        fn webkit_settings_get_all_features() -> *mut c_void;
        fn webkit_feature_list_get_length(list: *mut c_void) -> usize;
        fn webkit_feature_list_get(list: *mut c_void, index: usize) -> *mut c_void;
        fn webkit_feature_list_unref(list: *mut c_void);
        fn webkit_feature_get_identifier(feature: *mut c_void) -> *const c_char;
        fn webkit_settings_set_feature_enabled(settings: *mut c_void, feature: *mut c_void, enabled: c_int);
    }

    const FEATURES: [&str; 5] = [
        "StorageAPI",
        "StorageAPIEstimate",
        "FileSystem",
        "FileSystemWritableStream",
        // Also gates FileSystemFileHandle.createWritable().
        "AccessHandle",
    ];

    pub fn enable_storage(webview: &webkit2gtk::WebView) {
        let Some(settings) = webview.settings() else { return };
        unsafe {
            let list = webkit_settings_get_all_features();
            if list.is_null() {
                return;
            }
            for index in 0..webkit_feature_list_get_length(list) {
                let feature = webkit_feature_list_get(list, index);
                let name = CStr::from_ptr(webkit_feature_get_identifier(feature));
                if FEATURES.iter().any(|wanted| name.to_bytes() == wanted.as_bytes()) {
                    webkit_settings_set_feature_enabled(settings.as_ptr() as *mut c_void, feature, 1);
                }
            }
            webkit_feature_list_unref(list);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu);
    builder
        .invoke_handler(tauri::generate_handler![
            fs::fs_places,
            fs::fs_browse,
            fs::fs_parent,
            fs::fs_search,
            fs::fs_grant,
            fs::fs_granted,
            fs::fs_list,
            fs::fs_stat,
            fs::fs_read,
            fs::fs_write,
            fs::fs_mkdir,
            fs::fs_create,
            fs::fs_remove,
            github::github_login,
            github::github_open,
            github::app_focus,
        ])
        .setup(|app| {
            app.manage(fs::Grants::load(app.handle()));
            // Linux starts blank so the storage features are on before the app's first load.
            #[cfg(target_os = "linux")]
            let start = WebviewUrl::External("about:blank".parse().expect("valid url"));
            #[cfg(not(target_os = "linux"))]
            let start = WebviewUrl::default();
            let window = WebviewWindowBuilder::new(app, "main", start)
                // Windows serves the app from https://tauri.localhost, a secure context for OPFS.
                .use_https_scheme(true)
                .on_navigation(|url| {
                    if is_app(url) || url.as_str() == "about:blank" {
                        return true;
                    }
                    open_external(url);
                    false
                })
                .on_new_window(|url, _features| {
                    open_external(&url);
                    NewWindowResponse::Deny
                });
            #[cfg(desktop)]
            let window = window
                .title("Notework")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 360.0);
            let window = window.build()?;
            #[cfg(target_os = "macos")]
            keep_escape_in_fullscreen(window.clone());
            #[cfg(target_os = "linux")]
            window.with_webview(|webview| {
                use webkit2gtk::WebViewExt;
                let webview = webview.inner();
                webkitgtk::enable_storage(&webview);
                webview.load_uri(if cfg!(debug_assertions) { "http://localhost:5173/" } else { "tauri://localhost/" });
            })?;
            #[cfg(not(target_os = "linux"))]
            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Notework");
}
