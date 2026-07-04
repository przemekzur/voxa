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

// ── Voxa: harness supervisor ─────────────────────────────────────────────────
// One-file launch: starting the orb also boots the local connector harness
// (tools + memory brain) and shuts it down on exit. If a harness is already
// listening (e.g. started manually in a terminal), the orb just uses it.
static HARNESS_CHILD: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

// Which loopback port to boot the harness on: env override, else the harness
// URL configured in Settings (so we start the same server the orb will call),
// else the default. None = the configured tool source is remote — don't spawn.
fn harness_spawn_port() -> Option<u16> {
    if let Ok(v) = std::env::var("VOXA_HARNESS_PORT") {
        return v.parse().ok();
    }
    let cfg: serde_json::Value = match std::fs::read_to_string(voxa_config_path()) {
        Err(_) => return Some(3010), // no config yet (first run) — use the default
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
    };
    let url = cfg
        .get("sources")
        .and_then(|s| s.get(0))
        .and_then(|s| s.get("url"))
        .and_then(|u| u.as_str());
    match url {
        None => Some(3010),
        Some(u) if u.contains("localhost") || u.contains("127.0.0.1") => {
            let digits: String = u
                .rsplit(':')
                .next()
                .unwrap_or("")
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            Some(digits.parse().unwrap_or(3010))
        }
        Some(_) => None, // remote tool source — the user runs their own
    }
}

fn harness_running(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(400),
    )
    .is_ok()
}

// Locate the harness: a repo checkout first (dev — live code; needs npm install
// there), then the copy bundled into the app's resources (packaged installs).
fn find_harness(app: &tauri::AppHandle) -> Option<(std::path::PathBuf, bool)> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            roots.push(d.to_path_buf());
        }
    }
    for root in &roots {
        for anc in root.ancestors() {
            let dir = anc.join("packages").join("harness");
            if dir.join("server.mjs").exists() && dir.join("node_modules").exists() {
                return Some((dir, false));
            }
        }
    }
    use tauri::Manager;
    if let Ok(res) = app.path().resource_dir() {
        let dir = res.join("harness");
        if dir.join("server.mjs").exists() {
            return Some((dir, true));
        }
    }
    None
}

fn start_harness(app: &tauri::AppHandle) {
    let Some(port) = harness_spawn_port() else { return };
    if harness_running(port) {
        return; // already up (manual terminal, another instance)
    }
    let Some((dir, packaged)) = find_harness(app) else {
        eprintln!("[voxa] no connector harness found to auto-start (see packages/harness)");
        return;
    };
    let mut cmd = std::process::Command::new("node");
    cmd.arg("server.mjs").current_dir(&dir).env("PORT", port.to_string());
    if packaged {
        // App resources are read-only — keep connector state in the user dir.
        if let Some(base) = voxa_config_path().parent() {
            cmd.env("VOXA_DATA_DIR", base.join("harness"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash
    }
    match cmd.spawn() {
        Ok(child) => {
            eprintln!("[voxa] connector harness starting on http://127.0.0.1:{} (pid {})", port, child.id());
            *HARNESS_CHILD.lock().unwrap() = Some(child);
        }
        Err(e) => eprintln!("[voxa] couldn't start the harness (is Node 18+ installed?): {}", e),
    }
}

fn stop_harness() {
    if let Some(mut child) = HARNESS_CHILD.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
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
        .setup(|app| {
            // Linux: wire WebKitGTK's media-stream gates open (mic). No-op elsewhere.
            #[cfg(target_os = "linux")]
            enable_linux_media(app);
            // Voxa one-file launch: the orb supervises the local connector harness.
            start_harness(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, read_local_config, write_local_config, viewport_eval, brain_dir, open_brain_folder])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_harness();
            }
        });
}
