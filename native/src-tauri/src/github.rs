//! GitHub login for the native app. GitHub's device-flow endpoints refuse browser
//! (CORS) requests, so the page asks Rust to send them. Only these two GitHub URLs
//! can be reached, only public values (client ID, device code) are sent, and the
//! JSON reply goes back to the page unchanged.
use std::collections::HashMap;
use std::time::Duration;

#[tauri::command]
pub async fn github_login(step: String, params: HashMap<String, String>) -> Result<String, String> {
    let url = match step.as_str() {
        "code" => "https://github.com/login/device/code",
        "token" => "https://github.com/login/oauth/access_token",
        _ => return Err("TypeError: unknown GitHub login step.".into()),
    };
    const ALLOWED: [&str; 3] = ["client_id", "device_code", "grant_type"];
    if params.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err("TypeError: unexpected GitHub login field.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let form: Vec<(&str, &str)> = params.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).redirects(0).build();
        match agent.post(url).set("Accept", "application/json").set("User-Agent", "Notework").send_form(&form) {
            Ok(response) => response.into_string().map_err(|_| "NetworkError: GitHub sent an unreadable reply.".to_string()),
            Err(ureq::Error::Status(code, _)) => Err(format!("NetworkError: GitHub login failed (HTTP {code}). try again.")),
            Err(_) => Err("NetworkError: could not reach GitHub. check your connection and try again.".into()),
        }
    })
    .await
    .map_err(|_| "UnknownError: the GitHub login request stopped.".to_string())?
}

/// Open GitHub's device-code page in the system browser. Only GitHub login pages are allowed.
#[tauri::command]
pub fn github_open(url: String) -> Result<(), String> {
    let allowed = tauri::Url::parse(&url)
        .map(|url| url.scheme() == "https" && url.host_str() == Some("github.com") && url.path().starts_with("/login/"))
        .unwrap_or(false);
    if !allowed {
        return Err("TypeError: only GitHub login pages can be opened.".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| "UnknownError: could not open the browser.".to_string())
}

/// Bring Notework back to the front once GitHub approves the login, standing in for a redirect.
#[tauri::command]
pub fn app_focus<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(desktop)]
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}
