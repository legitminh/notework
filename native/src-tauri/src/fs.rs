//! Machine folders for the native app.
//!
//! Notework's own folder browser lists folder and file names anywhere on the
//! computer (`fs_places`, `fs_browse`, `fs_search`) so the person can choose what
//! to connect. File contents are read and written only below paths the person
//! chose with an explicit action (`fs_grant`); grants are kept in the app's data
//! folder. Native storage, the app's own `documents` folder inside its data folder,
//! is always allowed: it holds what the person creates at home in the native app.
//! Errors start with the DOMException name the web app expects.
use serde::Serialize;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, Runtime, State};

pub struct Grants {
    file: Option<PathBuf>,
    /// Native storage: the app-owned documents folder, resolved through symbolic links.
    documents: Option<PathBuf>,
    roots: Mutex<Vec<PathBuf>>,
}

impl Grants {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let file = app.path().app_data_dir().ok().map(|dir| dir.join("folder-grants.json"));
        let roots = file
            .as_ref()
            .and_then(|file| fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<PathBuf>>(&bytes).ok())
            .unwrap_or_default();
        let documents = app.path().app_data_dir().ok().map(|dir| dir.join("documents")).and_then(|dir| {
            fs::create_dir_all(&dir).ok()?;
            fs::canonicalize(&dir).ok()
        });
        Grants { file, documents, roots: Mutex::new(roots) }
    }

    /// Native storage is always allowed and never needs a saved grant.
    fn native_storage(&self, path: &Path) -> bool {
        self.documents.as_ref().is_some_and(|documents| path.starts_with(documents))
    }

    fn covers(&self, path: &Path) -> bool {
        if self.native_storage(path) {
            return true;
        }
        self.roots.lock().map(|roots| roots.iter().any(|root| path.starts_with(root))).unwrap_or(false)
    }

    fn add(&self, path: PathBuf) -> Result<(), String> {
        if self.native_storage(&path) {
            return Ok(());
        }
        let mut roots = self.roots.lock().map_err(|_| "UnknownError: folder access is unavailable.".to_string())?;
        if roots.iter().any(|root| path.starts_with(root)) {
            return Ok(());
        }
        roots.retain(|root| !root.starts_with(&path));
        roots.push(path);
        if let Some(file) = &self.file {
            if let Some(dir) = file.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let json = serde_json::to_vec(&*roots).map_err(|error| format!("UnknownError: {error}"))?;
            fs::write(file, json).map_err(|error| format!("UnknownError: folder access could not be saved: {error}"))?;
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub struct Place {
    name: String,
    path: String,
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    kind: &'static str,
    /// Whether a file looks like text, so the browser can hide binary files.
    text: bool,
}

#[derive(Serialize)]
pub struct Stat {
    kind: &'static str,
    size: u64,
    modified: f64,
}

fn error(error: std::io::Error, path: &Path) -> String {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    match error.kind() {
        ErrorKind::NotFound => format!("NotFoundError: “{name}” was not found."),
        ErrorKind::PermissionDenied => format!("NotAllowedError: the system denied access to “{name}”."),
        ErrorKind::AlreadyExists => format!("InvalidModificationError: “{name}” already exists."),
        ErrorKind::DirectoryNotEmpty => format!("InvalidModificationError: “{name}” is not empty."),
        _ => format!("UnknownError: {error}"),
    }
}

fn absolute(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || path.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err("SecurityError: only absolute folder paths can be used.".into());
    }
    Ok(path)
}

/// The real location of `path`, or of its parent for a path that does not exist yet.
fn real(path: &Path) -> Result<PathBuf, String> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(cause) if cause.kind() == ErrorKind::NotFound => {
            let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else { return Err(error(cause, path)) };
            Ok(fs::canonicalize(parent).map_err(|cause| error(cause, parent))?.join(name))
        }
        Err(cause) => Err(error(cause, path)),
    }
}

/// A path the person granted, resolved through symbolic links before the check.
fn granted(grants: &Grants, path: &str) -> Result<PathBuf, String> {
    let path = absolute(path)?;
    if grants.covers(&real(&path)?) {
        Ok(path)
    } else {
        Err("NotAllowedError: reconnect this folder in Notework to allow access.".into())
    }
}

fn hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn looks_like_text(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else { return false };
    let mut buffer = [0u8; 4096];
    let Ok(read) = file.read(&mut buffer) else { return false };
    let sample = &buffer[..read];
    if sample.contains(&0) {
        return false;
    }
    match std::str::from_utf8(sample) {
        Ok(_) => true,
        // A multi-byte character may be cut off at the end of the sample.
        Err(cause) => cause.error_len().is_none(),
    }
}

fn entry(path: PathBuf, check_text: bool) -> Option<Entry> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let directory = fs::metadata(&path).ok()?.is_dir();
    Some(Entry {
        text: !directory && check_text && looks_like_text(&path),
        kind: if directory { "directory" } else { "file" },
        path: path.to_string_lossy().into_owned(),
        name,
    })
}

fn list(path: &Path, browsing: bool) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = fs::read_dir(path)
        .map_err(|cause| error(cause, path))?
        .filter_map(Result::ok)
        .filter(|item| !(browsing && hidden(&item.file_name().to_string_lossy())))
        .filter_map(|item| entry(item.path(), browsing))
        .collect();
    entries.sort_by(|a, b| (a.kind != "directory").cmp(&(b.kind != "directory")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

#[tauri::command]
pub fn fs_places<R: Runtime>(app: AppHandle<R>) -> Vec<Place> {
    let paths = app.path();
    let mut places = Vec::new();
    let mut add = |name: &str, path: Option<PathBuf>| {
        if let Some(path) = path.filter(|path| path.is_dir()) {
            if !places.iter().any(|place: &Place| Path::new(&place.path) == path) {
                places.push(Place { name: name.into(), path: path.to_string_lossy().into_owned() });
            }
        }
    };
    #[cfg(mobile)]
    add("on this device", paths.document_dir().ok());
    #[cfg(desktop)]
    {
        add("home", paths.home_dir().ok());
        add("desktop", paths.desktop_dir().ok());
        add("documents", paths.document_dir().ok());
        add("downloads", paths.download_dir().ok());
        #[cfg(target_os = "windows")]
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            add(&drive.clone(), Some(PathBuf::from(&drive)));
        }
        #[cfg(target_os = "macos")]
        if let Ok(volumes) = fs::read_dir("/Volumes") {
            for volume in volumes.filter_map(Result::ok) {
                add(&volume.file_name().to_string_lossy(), Some(volume.path()));
            }
        }
        #[cfg(target_os = "linux")]
        {
            add("computer", Some(PathBuf::from("/")));
            if let Ok(user) = std::env::var("USER") {
                for base in ["/media", "/run/media"] {
                    if let Ok(mounts) = fs::read_dir(Path::new(base).join(&user)) {
                        for mount in mounts.filter_map(Result::ok) {
                            add(&mount.file_name().to_string_lossy(), Some(mount.path()));
                        }
                    }
                }
            }
        }
    }
    places
}

#[tauri::command]
pub async fn fs_browse(path: String) -> Result<Vec<Entry>, String> {
    list(&absolute(&path)?, true)
}

#[tauri::command]
pub fn fs_parent(path: String) -> Result<Option<String>, String> {
    Ok(absolute(&path)?.parent().map(|parent| parent.to_string_lossy().into_owned()))
}

/// Breadth-first name search for the folder browser, skipping hidden folders.
#[tauri::command]
pub async fn fs_search(path: String, query: String) -> Result<Vec<Entry>, String> {
    const RESULTS: usize = 200;
    const VISITS: usize = 50_000;
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut queue = std::collections::VecDeque::from([absolute(&path)?]);
    let (mut results, mut visits) = (Vec::new(), 0);
    while let Some(folder) = queue.pop_front() {
        let Ok(items) = fs::read_dir(&folder) else { continue };
        for item in items.filter_map(Result::ok) {
            visits += 1;
            let name = item.file_name().to_string_lossy().into_owned();
            if hidden(&name) {
                continue;
            }
            let directory = item.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            if name.to_lowercase().contains(&query) {
                if let Some(found) = entry(item.path(), true) {
                    results.push(found);
                }
            }
            if directory {
                queue.push_back(item.path());
            }
            if results.len() >= RESULTS || visits >= VISITS {
                return Ok(results);
            }
        }
    }
    Ok(results)
}

/// The native storage folder, where new resources at home are created.
#[tauri::command]
pub fn fs_documents(grants: State<Grants>) -> Result<String, String> {
    let documents = grants.documents.as_ref().ok_or("NotSupportedError: native storage is unavailable on this device.")?;
    fs::create_dir_all(documents).map_err(|cause| error(cause, documents))?;
    Ok(documents.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn fs_grant(grants: State<Grants>, path: String) -> Result<(), String> {
    grants.add(real(&absolute(&path)?)?)
}

#[tauri::command]
pub fn fs_granted(grants: State<Grants>, path: String) -> Result<bool, String> {
    Ok(grants.covers(&real(&absolute(&path)?)?))
}

#[tauri::command]
pub async fn fs_list(grants: State<'_, Grants>, path: String) -> Result<Vec<Entry>, String> {
    list(&granted(&grants, &path)?, false)
}

#[tauri::command]
pub fn fs_stat(grants: State<Grants>, path: String) -> Result<Stat, String> {
    let path = granted(&grants, &path)?;
    let metadata = fs::metadata(&path).map_err(|cause| error(cause, &path))?;
    let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|time| time.as_millis() as f64).unwrap_or(0.0);
    Ok(Stat { kind: if metadata.is_dir() { "directory" } else { "file" }, size: metadata.len(), modified })
}

#[tauri::command]
pub async fn fs_read(grants: State<'_, Grants>, path: String) -> Result<Response, String> {
    let path = granted(&grants, &path)?;
    fs::read(&path).map(Response::new).map_err(|cause| error(cause, &path))
}

/// The file contents arrive as the raw request body and the path in a header.
#[tauri::command]
pub async fn fs_write(grants: State<'_, Grants>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("TypeError: file contents are missing.".into()) };
    let encoded = request.headers().get("notework-path").and_then(|value| value.to_str().ok()).ok_or("TypeError: the file path is missing.")?;
    let decoded = percent_encoding::percent_decode_str(encoded).decode_utf8().map_err(|_| "TypeError: the file path is not valid.")?;
    let path = granted(&grants, &decoded)?;
    if path.is_dir() {
        return Err("TypeMismatchError: this path is a folder.".into());
    }
    fs::write(&path, bytes).map_err(|cause| error(cause, &path))
}

#[tauri::command]
pub fn fs_mkdir(grants: State<Grants>, path: String) -> Result<(), String> {
    let path = granted(&grants, &path)?;
    fs::create_dir(&path).map_err(|cause| error(cause, &path))
}

#[tauri::command]
pub fn fs_create(grants: State<Grants>, path: String) -> Result<(), String> {
    let path = granted(&grants, &path)?;
    fs::OpenOptions::new().write(true).create_new(true).open(&path).map(|_| ()).map_err(|cause| error(cause, &path))
}

#[tauri::command]
pub fn fs_remove(grants: State<Grants>, path: String, recursive: bool) -> Result<(), String> {
    let path = granted(&grants, &path)?;
    let metadata = fs::symlink_metadata(&path).map_err(|cause| error(cause, &path))?;
    let result = if !metadata.is_dir() {
        fs::remove_file(&path)
    } else if recursive {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_dir(&path)
    };
    result.map_err(|cause| error(cause, &path))
}
