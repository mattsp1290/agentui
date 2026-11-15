#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
mod keychain;
mod native;
mod wire;

struct NativeState {
    owner: std::sync::Arc<std::sync::Mutex<Option<native::Shared>>>,
    directory: std::path::PathBuf,
    enabled: bool,
}
fn bundled(url: &tauri::Url) -> bool {
    url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && matches!(url.path(), "/" | "/index.html")
        && url.query().is_none()
}
#[tauri::command]
async fn native_access(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NativeState>,
    command: serde_json::Value,
) -> Result<serde_json::Value, &'static str> {
    if !state.enabled
        || window.label() != "main"
        || !bundled(&window.url().map_err(|_| "forbidden")?)
    {
        return Err("forbidden");
    }
    let command: native::Command = serde_json::from_value(command).map_err(|_| "invalid-input")?;
    let directory = state.directory.clone();
    let owners = state.owner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let owner = {
            let mut guard = owners.lock().map_err(|_| "profile-unavailable")?;
            if guard.is_none() {
                let handle = security_framework::os::macos::keychain::SecKeychain::default()
                    .map_err(|_| "keychain-unavailable")?;
                let owner = native::Owner::new(
                    &directory,
                    "http://127.0.0.1:7140".into(),
                    keychain::Keychain {
                        handle,
                        service: "homes.birb.agentui.native.v1".into(),
                    },
                )?;
                *guard = Some(std::sync::Arc::new(std::sync::Mutex::new(owner)));
            }
            guard.clone().ok_or("profile-unavailable")?
        };
        native::run(&owner, command)
    })
    .await
    .map_err(|_| "keychain-unavailable")?
}

fn local_host_url() -> Result<Option<tauri::Url>, Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        return Ok(None);
    }
    if args.len() != 2 || args[0] != "--host-url" {
        return Err("Use --host-url http://127.0.0.1:PORT/browser.html".into());
    }
    let url = tauri::Url::parse(&args[1])?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/browser.html"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("The desktop host must use http://127.0.0.1:PORT/browser.html".into());
    }
    Ok(Some(url))
}

fn main() {
    let host_url = local_host_url().unwrap_or_else(|error| {
        eprintln!("Cannot connect to AgentUI host: {error}");
        None
    });
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![native_access])
        .setup(move |app| {
            app.manage(NativeState {
                owner: std::sync::Arc::new(std::sync::Mutex::new(None)),
                directory: app.path().app_data_dir()?,
                enabled: host_url.is_none(),
            });
            let browser_url = host_url.clone();
            let window =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .on_navigation(move |url| bundled(url) || browser_url.as_ref() == Some(url))
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .build()?;
            let background = |theme| match theme {
                tauri::Theme::Dark => tauri::window::Color(33, 33, 33, 255),
                _ => tauri::window::Color(247, 247, 248, 255),
            };
            window.set_background_color(Some(background(window.theme()?)))?;
            let themed_window = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::ThemeChanged(theme) = event {
                    let _ = themed_window.set_background_color(Some(background(*theme)));
                }
            });
            if let Some(url) = &host_url {
                window.navigate(url.clone())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run AgentUI desktop");
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_bundled_main_document_qualifies_for_native_admission() {
        for value in ["tauri://localhost/", "tauri://localhost/index.html"] {
            assert!(super::bundled(&tauri::Url::parse(value).unwrap()));
        }
        for value in [
            "http://127.0.0.1:7140/browser.html",
            "https://example.com/",
            "tauri://localhost/browser.html",
            "tauri://other/index.html",
            "tauri://localhost/index.html?url=remote",
        ] {
            assert!(!super::bundled(&tauri::Url::parse(value).unwrap()));
        }
    }
}
