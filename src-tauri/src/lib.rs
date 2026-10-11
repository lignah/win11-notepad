use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Serialize, Clone, Default)]
struct StartupInfo {
    files: Vec<String>,
    theme: Option<String>,
    settings: bool,
}

struct Startup(Mutex<Option<StartupInfo>>);

#[derive(Serialize)]
struct FileData {
    path: String,
    name: String,
    text: String,
    encoding: String,
}

fn parse_args() -> StartupInfo {
    let mut info = StartupInfo::default();
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        if a == "--theme" {
            info.theme = it.next();
        } else if let Some(t) = a.strip_prefix("--theme=") {
            info.theme = Some(t.to_string());
        } else if a == "--settings" {
            info.settings = true;
        } else if a.starts_with("--") {
            // ignore unknown flags
        } else {
            let raw = a.strip_prefix("file://").unwrap_or(&a);
            let p = PathBuf::from(raw);
            let p = if p.is_absolute() {
                p
            } else {
                std::env::current_dir().map(|d| d.join(&p)).unwrap_or(p)
            };
            let p = p.canonicalize().unwrap_or(p);
            info.files.push(p.to_string_lossy().into_owned());
        }
    }
    info
}

fn decode(b: &[u8]) -> (String, &'static str) {
    if b.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(&b[3..]).into_owned(), "UTF-8 with BOM");
    }
    if b.starts_with(&[0xFF, 0xFE]) {
        let (c, _) = encoding_rs::UTF_16LE.decode_without_bom_handling(&b[2..]);
        return (c.into_owned(), "UTF-16 LE");
    }
    if b.starts_with(&[0xFE, 0xFF]) {
        let (c, _) = encoding_rs::UTF_16BE.decode_without_bom_handling(&b[2..]);
        return (c.into_owned(), "UTF-16 BE");
    }
    match std::str::from_utf8(b) {
        Ok(s) => (s.to_string(), "UTF-8"),
        Err(_) => {
            let (c, _) = encoding_rs::WINDOWS_1252.decode_without_bom_handling(b);
            (c.into_owned(), "ANSI")
        }
    }
}

fn encode(text: &str, enc: &str) -> Vec<u8> {
    match enc {
        "UTF-8 with BOM" => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(text.as_bytes());
            v
        }
        "UTF-16 LE" => {
            let mut v = vec![0xFF, 0xFE];
            for u in text.encode_utf16() {
                v.extend_from_slice(&u.to_le_bytes());
            }
            v
        }
        "UTF-16 BE" => {
            let mut v = vec![0xFE, 0xFF];
            for u in text.encode_utf16() {
                v.extend_from_slice(&u.to_be_bytes());
            }
            v
        }
        "ANSI" => {
            let (c, _, _) = encoding_rs::WINDOWS_1252.encode(text);
            c.into_owned()
        }
        _ => text.as_bytes().to_vec(),
    }
}

fn file_name(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string())
}

#[tauri::command]
fn read_file(path: String) -> Result<FileData, String> {
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("NOTFOUND:{}", path))
        }
        Err(e) => return Err(e.to_string()),
    };
    let (text, enc) = decode(&bytes);
    let canon = std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path);
    Ok(FileData {
        name: file_name(&canon),
        path: canon,
        text,
        encoding: enc.to_string(),
    })
}

#[tauri::command]
fn write_file(path: String, text: String, encoding: String) -> Result<String, String> {
    std::fs::write(&path, encode(&text, &encoding)).map_err(|e| e.to_string())?;
    Ok(file_name(&path))
}

#[tauri::command]
fn list_fonts() -> Vec<String> {
    let mut set = BTreeSet::new();
    if let Ok(out) = std::process::Command::new("fc-list").args([":", "family"]).output() {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(f) = line.split(',').next() {
                let f = f.trim();
                if !f.is_empty() && !f.starts_with('.') {
                    set.insert(f.to_string());
                }
            }
        }
    }
    set.into_iter().collect()
}

#[tauri::command]
async fn new_window(app: AppHandle) -> Result<(), String> {
    let label = format!(
        "w{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .title("Notepad")
        .inner_size(1000.0, 680.0)
        .min_inner_size(480.0, 320.0)
        .decorations(false)
        .transparent(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    // Show only after tao installs the Wayland titlebar. See run().
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn startup(window: tauri::Window, st: State<Startup>) -> StartupInfo {
    if window.label() == "main" {
        if let Some(i) = st.0.lock().unwrap().take() {
            return i;
        }
    }
    StartupInfo::default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let info = parse_args();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Startup(Mutex::new(Some(info))))
        .invoke_handler(tauri::generate_handler![
            read_file, write_file, list_fonts, new_window, startup
        ])
        // On Wayland, tao calls gtk_window_set_titlebar() after the window is
        // realized when decorations are off. GTK warns and then frees a corrupt
        // chunk. Create the window hidden so the titlebar is set first, then show.
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Notepad");
}
