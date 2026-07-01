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
fn open_brain_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = brain_path();
    let _ = std::fs::create_dir_all(&dir);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
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
        .invoke_handler(tauri::generate_handler![greet, read_local_config, write_local_config, viewport_eval, brain_dir, open_brain_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
