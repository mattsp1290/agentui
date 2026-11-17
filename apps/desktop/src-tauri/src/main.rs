#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
mod keychain;
mod native;
mod provider_setup;
mod wire;

struct NativeState {
    owner: std::sync::Arc<std::sync::Mutex<Option<native::Shared>>>,
    directory: std::path::PathBuf,
    enabled: bool,
}
fn bundled(url: &tauri::Url) -> bool {
    url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && matches!(url.path(), "" | "/" | "/index.html")
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
                let owner = native::Owner::new(&directory, "http://127.0.0.1:7140".into())?;
                *guard = Some(std::sync::Arc::new(std::sync::Mutex::new(owner)));
            }
            guard.clone().ok_or("profile-unavailable")?
        };
        native::run(&owner, command)
    })
    .await
    .map_err(|_| "profile-unavailable")?
}

#[tauri::command]
async fn provider_setup(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, provider_setup::SetupState>,
    command: serde_json::Value,
) -> Result<provider_setup::Status, &'static str> {
    if !provider_setup::admitted(window.label(), &window.url().map_err(|_| "forbidden")?) {
        return Err("forbidden");
    }
    let command: provider_setup::Command =
        serde_json::from_value(command).map_err(|_| "invalid-input")?;
    let configuration = state.inner().0.clone().ok_or("setup-unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let configuration = configuration.lock().map_err(|_| "setup-unavailable")?;
        provider_setup::run(&configuration, command)
    })
    .await
    .map_err(|_| "setup-unavailable")?
}

fn open_provider_setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("provider-setup") {
        window.show()?;
        return window.set_focus();
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "provider-setup",
        tauri::WebviewUrl::App("provider-setup.html".into()),
    )
    .title("Set up Pi · AgentUI")
    .inner_size(520.0, 650.0)
    .min_inner_size(360.0, 480.0)
    .on_navigation(|url| provider_setup::admitted("provider-setup", url))
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .build()?;
    Ok(())
}

fn local_host_url() -> Result<Option<tauri::Url>, Box<dyn std::error::Error>> {
    parse_host_args(&std::env::args().skip(1).collect::<Vec<_>>())
}

fn parse_host_args(args: &[String]) -> Result<Option<tauri::Url>, Box<dyn std::error::Error>> {
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
    let setup = provider_setup::Configuration::from_environment(host_url.as_ref());
    let setup_url = setup
        .as_ref()
        .map(|configuration| configuration.setup_url().clone());
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![native_access, provider_setup])
        .setup(move |app| {
            app.manage(NativeState {
                owner: std::sync::Arc::new(std::sync::Mutex::new(None)),
                directory: app.path().app_data_dir()?,
                enabled: host_url.is_none(),
            });
            app.manage(provider_setup::SetupState(setup.map(|configuration| {
                std::sync::Arc::new(std::sync::Mutex::new(configuration))
            })));
            let browser_url = host_url.clone();
            let setup_app = app.handle().clone();
            let window =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .on_navigation(move |url| {
                        if setup_url.as_ref() == Some(url) {
                            let app = setup_app.clone();
                            let _ = setup_app.run_on_main_thread(move || {
                                let _ = open_provider_setup(&app);
                            });
                            return false;
                        }
                        bundled(url) || browser_url.as_ref() == Some(url)
                    })
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
    #[derive(serde::Deserialize)]
    struct HostUrlCase {
        args: Vec<String>,
        accepted: bool,
        normalized: Option<String>,
    }

    #[test]
    fn host_url_acceptance_matches_launcher_cases() {
        let cases: Vec<HostUrlCase> = serde_json::from_str(include_str!(
            "../../../../tests/desktop/host-url-cases.json"
        ))
        .unwrap();
        for case in cases {
            let result = super::parse_host_args(&case.args);
            assert_eq!(result.is_ok(), case.accepted, "args: {:?}", case.args);
            if case.accepted {
                let url = result.unwrap();
                assert_eq!(
                    url.as_ref().map(|value| value.as_str()),
                    case.normalized.as_deref()
                );
            }
        }
    }

    #[test]
    fn only_the_bundled_main_document_qualifies_for_native_admission() {
        for value in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
        ] {
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
