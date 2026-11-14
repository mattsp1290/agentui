#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

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
    let host_url = local_host_url().expect("invalid local AgentUI host address");
    tauri::Builder::default()
        .setup(move |app| {
            if let Some(url) = &host_url {
                app.get_webview_window("main")
                    .ok_or("AgentUI window is missing")?
                    .navigate(url.clone())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run AgentUI desktop");
}
