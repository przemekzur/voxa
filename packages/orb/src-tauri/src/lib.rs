// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Tier A (vision -> action): run JS inside the `viewport` webview so the orb can
// READ and DRIVE the page shown there. The frontend can't eval into another
// webview, so it routes through here. Result is fire-and-forget: the injected JS
// emits a `vp-result` event the orb's main window listens for (matched by reqId).
#[tauri::command]
fn viewport_eval(app: tauri::AppHandle, js: String) -> Result<(), String> {
    use tauri::Manager;
    let win = app
        .get_webview_window("viewport")
        .ok_or_else(|| "viewport window is not open".to_string())?;
    win.eval(&js).map_err(|e| e.to_string())
}

fn voxa_config_path() -> std::path::PathBuf {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME").map(|h| format!("{}/.config", h)))
        .unwrap_or_default();
    std::path::Path::new(&base).join("Voxa").join("voxa-config.json")
}

#[tauri::command]
fn read_local_config() -> String {
    std::fs::read_to_string(voxa_config_path()).unwrap_or_else(|_| "{}".to_string())
}

#[tauri::command]
fn write_local_config(contents: String) -> Result<(), String> {
    let path = voxa_config_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

fn brain_path() -> std::path::PathBuf {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME").map(|h| format!("{}/.config", h)))
        .unwrap_or_default();
    std::path::Path::new(&base).join("Voxa").join("brain")
}

#[tauri::command]
fn brain_dir() -> String { brain_path().to_string_lossy().to_string() }

#[tauri::command]
fn open_brain_folder() -> Result<(), String> {
    // Reveal the brain folder in the OS file manager. tauri-plugin-opener's
    // open_path is unreliable for *directories* on Windows, so shell out to the
    // native file manager directly (explorer / open / xdg-open).
    let dir = brain_path();
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// Linux/WebKitGTK: getUserMedia() is gated off twice over, and nothing wires
// either gate open by default — so `navigator.mediaDevices` is unusable,
// `enumerateDevices()` comes back empty ("no devices"), the mic never starts,
// and the realtime session dies with a misleading "session closed". We reach
// through Tauri's `with_webview` to the underlying `webkit2gtk::WebView` and:
//   1. flip the `enable-media-stream` setting on (default is OFF), and
//   2. answer the `permission-request` signal, granting mic/camera requests
//      (the frontend is our own bundled, loopback-only UI).
// No-op on macOS/Windows, whose WebViews expose the mic without this.
#[cfg(target_os = "linux")]
fn enable_linux_media(app: &tauri::App) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.with_webview(|webview| {
        use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
        let wv = webview.inner();
        if let Some(settings) = WebViewExt::settings(&wv) {
            settings.set_enable_media_stream(true);
        }
        wv.connect_permission_request(|_wv, req| {
            req.allow();
            true
        });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance guard: if the orb is already running, a second launch
        // (desktop double-spawn, reboot leftover, manual relaunch) exits instead
        // of starting a duplicate — which would speak over the first with its own
        // voice. The callback just focuses the existing window. Must be registered
        // first per Tauri's single-instance plugin docs.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(target_os = "linux")]
            enable_linux_media(_app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, read_local_config, write_local_config, viewport_eval, brain_dir, open_brain_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
