use crate::keychain::{Keychain, ReadMode};
use security_framework::os::macos::keychain::SecKeychain;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct SetupState(pub Option<Arc<Mutex<Configuration>>>);

pub struct Configuration {
    endpoint: tauri::Url,
    capability: String,
    service: String,
    target: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Command {
    Status {},
    SaveAndConnect {
        #[serde(rename = "apiKey")]
        api_key: String,
    },
    ConnectSaved {},
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HostStatus {
    MissingKey,
    Ready,
    Unavailable { reason: String },
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StorageStatus {
    Absent,
    Saved,
    Locked,
    Denied,
    Unavailable,
}

#[derive(Serialize)]
pub struct Status {
    target: String,
    storage: StorageStatus,
    host: HostStatus,
}

impl Configuration {
    pub fn from_environment(host: Option<&tauri::Url>) -> Option<Self> {
        let capability = std::env::var("AGENTUI_SETUP_CAPABILITY").ok();
        let profile = std::env::var("AGENTUI_SETUP_PROFILE").ok();
        let target = std::env::var("AGENTUI_SETUP_TARGET").ok();
        for name in [
            "AGENTUI_SETUP_CAPABILITY",
            "AGENTUI_SETUP_PROFILE",
            "AGENTUI_SETUP_TARGET",
        ] {
            std::env::remove_var(name);
        }
        Self::new(host?, capability?, profile?, target?)
    }

    fn new(host: &tauri::Url, capability: String, profile: String, target: String) -> Option<Self> {
        if host.scheme() != "http"
            || host.host_str() != Some("127.0.0.1")
            || !host.username().is_empty()
            || host.password().is_some()
            || host.path() != "/browser.html"
            || host.query().is_some()
            || host.fragment().is_some()
            || capability.len() != 64
            || !capability
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || profile.is_empty()
            || profile.len() > 128
            || !profile
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || target.is_empty()
            || target.len() > 512
            || target.chars().any(char::is_control)
        {
            return None;
        }
        let mut endpoint = host.clone();
        endpoint.set_path("/setup/pi");
        Some(Self {
            endpoint,
            capability,
            service: format!("homes.birb.agentui.provider.opencode-go.v1.{profile}"),
            target,
        })
    }

    pub fn setup_url(&self) -> &tauri::Url {
        &self.endpoint
    }

    fn request(&self, api_key: Option<&str>) -> Result<HostStatus, &'static str> {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "host-unavailable")?;
        let body = match api_key {
            Some(key) => serde_json::json!({"op":"configure", "apiKey":key}),
            None => serde_json::json!({"op":"status"}),
        };
        let response = client
            .post(self.endpoint.clone())
            .bearer_auth(&self.capability)
            .json(&body)
            .send()
            .map_err(|_| "host-unavailable")?;
        if response.status() == reqwest::StatusCode::CONFLICT {
            return Err("restart-required");
        }
        if !response.status().is_success() {
            return Err("host-unavailable");
        }
        let mut bytes = Vec::new();
        response
            .take(8193)
            .read_to_end(&mut bytes)
            .map_err(|_| "host-unavailable")?;
        if bytes.len() > 8192 {
            return Err("host-unavailable");
        }
        let result: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "host-unavailable")?;
        if result.get("ok") != Some(&serde_json::Value::Bool(true)) {
            return Err("host-unavailable");
        }
        let status: HostStatus =
            serde_json::from_value(result.get("value").cloned().ok_or("host-unavailable")?)
                .map_err(|_| "host-unavailable")?;
        Ok(match status {
            HostStatus::Unavailable { .. } => HostStatus::Unavailable {
                reason: "Pi could not start. Check the host runtime and try again.".into(),
            },
            value => value,
        })
    }
}

pub fn admitted(label: &str, url: &tauri::Url) -> bool {
    label == "provider-setup"
        && url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && url.path() == "/provider-setup.html"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn valid_key(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}

fn storage_status(result: Result<Option<Vec<u8>>, &'static str>) -> StorageStatus {
    match result {
        Ok(None) => StorageStatus::Absent,
        Ok(Some(bytes)) if std::str::from_utf8(&bytes).is_ok_and(valid_key) => StorageStatus::Saved,
        Err("keychain-locked") => StorageStatus::Locked,
        Err("keychain-denied") => StorageStatus::Denied,
        _ => StorageStatus::Unavailable,
    }
}

fn connect(
    configuration: &Configuration,
    store: &Keychain,
    command: Command,
) -> Result<HostStatus, &'static str> {
    let key = match command {
        Command::Status {} => return configuration.request(None),
        Command::SaveAndConnect { api_key } => {
            if !valid_key(&api_key) {
                return Err("invalid-key");
            }
            let expected = store.read(ReadMode::UserInitiated)?;
            let intended = Some(api_key.trim().as_bytes().to_vec());
            store.write(&expected, &intended)?;
            if store.read(ReadMode::UserInitiated)? != intended {
                return Err("keychain-unavailable");
            }
            intended.ok_or("keychain-unavailable")?
        }
        Command::ConnectSaved {} => store.read(ReadMode::UserInitiated)?.ok_or("key-absent")?,
    };
    let text = std::str::from_utf8(&key).map_err(|_| "keychain-unavailable")?;
    if !valid_key(text) {
        return Err("keychain-unavailable");
    }
    configuration.request(Some(text))
}

pub fn run(configuration: &Configuration, command: Command) -> Result<Status, &'static str> {
    let handle = SecKeychain::default().map_err(|_| "keychain-unavailable")?;
    let store = Keychain {
        handle,
        service: configuration.service.clone(),
    };
    let host = match command {
        Command::Status {} => configuration.request(None).unwrap_or(HostStatus::Unavailable {
            reason: "The launcher host is unavailable. Keep the launcher running and check its connection.".into(),
        }),
        command => connect(configuration, &store, command)?,
    };
    Ok(Status {
        target: configuration.target.clone(),
        storage: storage_status(store.read(ReadMode::Quiet)),
        host,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_foundation::base::TCFType;
    use security_framework::os::macos::keychain::CreateOptions;
    use std::io::Write;
    use std::net::TcpListener;
    use uuid::Uuid;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainLock(keychain: *mut std::ffi::c_void) -> i32;
        fn SecKeychainDelete(keychain: *mut std::ffi::c_void) -> i32;
    }

    fn configuration() -> Configuration {
        Configuration::new(
            &tauri::Url::parse("http://127.0.0.1:12500/browser.html").unwrap(),
            "a".repeat(64),
            "profile-1".into(),
            "local".into(),
        )
        .unwrap()
    }

    #[test]
    fn credential_admission_is_only_the_bundled_setup_window() {
        let valid = tauri::Url::parse("tauri://localhost/provider-setup.html").unwrap();
        assert!(admitted("provider-setup", &valid));
        assert!(!admitted("main", &valid));
        for url in [
            "http://127.0.0.1:12500/provider-setup.html",
            "tauri://localhost/index.html",
            "tauri://localhost/provider-setup.html?token=bad",
            "tauri://localhost/provider-setup.html#bad",
            "tauri://other/provider-setup.html",
        ] {
            assert!(!admitted(
                "provider-setup",
                &tauri::Url::parse(url).unwrap()
            ));
        }
    }

    #[test]
    fn setup_endpoint_and_keychain_service_bind_to_launcher_profile() {
        let first = configuration();
        assert_eq!(first.endpoint.as_str(), "http://127.0.0.1:12500/setup/pi");
        assert_eq!(
            first.service,
            "homes.birb.agentui.provider.opencode-go.v1.profile-1"
        );
        for host in [
            "http://localhost:12500/browser.html",
            "https://127.0.0.1:12500/browser.html",
            "http://127.0.0.1:12500/browser.html?target=other",
            "http://127.0.0.1:12500/browser.html#other",
        ] {
            assert!(Configuration::new(
                &tauri::Url::parse(host).unwrap(),
                "a".repeat(64),
                "profile".into(),
                "local".into()
            )
            .is_none());
        }
    }

    #[test]
    fn invalid_keys_and_commands_are_rejected_without_reflection() {
        for key in ["", " ", "key\nextra", "key\0extra"] {
            assert!(!valid_key(key));
        }
        assert!(!valid_key(&"a".repeat(4097)));
        assert!(serde_json::from_value::<Command>(
            serde_json::json!({"kind":"connect-saved", "url":"http://example.com"})
        )
        .is_err());
        assert!(serde_json::from_value::<Command>(
            serde_json::json!({"kind":"save-and-connect", "apiKey":"synthetic", "endpoint":"other"})
        )
        .is_err());
    }

    fn response_fixture(code: &str, body: &str) -> (tauri::Url, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = tauri::Url::parse(&format!(
            "http://{}/browser.html",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let reply = format!("HTTP/1.1 {code}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let task = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let header_end = loop {
                let mut byte = [0_u8];
                stream.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 8192);
                if bytes.ends_with(b"\r\n\r\n") {
                    break bytes.len();
                }
            };
            let headers = String::from_utf8(bytes.clone()).unwrap();
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(str::trim)
                        .map(str::to_string)
                })
                .unwrap()
                .parse()
                .unwrap();
            bytes.resize(header_end + length, 0);
            stream.read_exact(&mut bytes[header_end..]).unwrap();
            stream.write_all(reply.as_bytes()).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (url, task)
    }

    #[test]
    fn native_delivery_uses_fixed_capability_headers_without_returning_the_key() {
        let marker = "synthetic-pi-delivery-marker";
        let (url, request) = response_fixture(
            "200 OK",
            r#"{"ok":true,"value":{"kind":"ready","source":"native-session"}}"#,
        );
        let configuration =
            Configuration::new(&url, "a".repeat(64), "delivery".into(), "local".into()).unwrap();
        let result = configuration.request(Some(marker)).unwrap();
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"kind":"ready"}"#
        );
        let request = request.join().unwrap();
        let headers = request.split("\r\n\r\n").next().unwrap().to_lowercase();
        assert!(headers.starts_with("post /setup/pi http/1.1\r\n"));
        assert!(headers.contains(&format!("authorization: bearer {}\r\n", "a".repeat(64))));
        assert!(!headers.contains("origin:"));
        assert!(!headers.contains("cookie:"));
        assert!(!headers.contains(marker));
        assert!(request.contains(marker));
    }

    #[test]
    fn host_errors_are_fixed_and_replacement_requires_a_restart() {
        let (url, request) = response_fixture(
            "200 OK",
            r#"{"ok":true,"value":{"kind":"unavailable","reason":"synthetic-host-secret"}}"#,
        );
        let configuration =
            Configuration::new(&url, "a".repeat(64), "safe-error".into(), "local".into()).unwrap();
        let result = serde_json::to_string(&configuration.request(None).unwrap()).unwrap();
        assert!(!result.contains("synthetic-host-secret"));
        request.join().unwrap();
        let (url, request) = response_fixture(
            "409 Conflict",
            r#"{"ok":false,"error":{"kind":"unavailable","message":"private provider payload"}}"#,
        );
        let configuration =
            Configuration::new(&url, "a".repeat(64), "conflict".into(), "local".into()).unwrap();
        assert!(matches!(
            configuration.request(Some("synthetic")),
            Err("restart-required")
        ));
        request.join().unwrap();
    }

    #[test]
    fn saved_key_is_encrypted_in_a_separate_keychain_item_and_never_returned() {
        let directory =
            std::env::temp_dir().join(format!("agentui-pi-keychain-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let handle = CreateOptions::new()
            .password(&Uuid::new_v4().to_string())
            .create(directory.join("test.keychain"))
            .unwrap();
        let store = Keychain {
            handle: handle.clone(),
            service: format!("agentui-pi-test-{}", Uuid::new_v4()),
        };
        let marker = "synthetic-pi-keychain-marker";
        let intended = Some(marker.as_bytes().to_vec());
        store.write(&None, &intended).unwrap();
        assert_eq!(store.read(ReadMode::Quiet).unwrap(), intended);
        let reopened = Keychain {
            handle: handle.clone(),
            service: store.service.clone(),
        };
        assert_eq!(reopened.read(ReadMode::Quiet).unwrap(), intended);
        for file in std::fs::read_dir(&directory).unwrap() {
            let path = file.unwrap().path();
            if path.is_file() {
                let contents = std::fs::read(path).unwrap();
                assert!(!contents
                    .windows(marker.len())
                    .any(|window| window == marker.as_bytes()));
            }
        }
        let status = Status {
            target: "local".into(),
            storage: storage_status(store.read(ReadMode::Quiet)),
            host: HostStatus::MissingKey,
        };
        let public = serde_json::to_string(&status).unwrap();
        assert!(!public.contains(marker));
        assert!(public.contains("saved"));
        assert_ne!(configuration().service, "homes.birb.agentui.native.v1");
        {
            let _lock = crate::keychain::INTERACTION.lock().unwrap();
            unsafe {
                assert_eq!(SecKeychainLock(handle.as_CFTypeRef() as *mut _), 0);
            }
        }
        assert!(store.read(ReadMode::Quiet).is_err());
        assert!(matches!(
            storage_status(store.read(ReadMode::Quiet)),
            StorageStatus::Locked | StorageStatus::Denied | StorageStatus::Unavailable
        ));
        unsafe {
            assert_eq!(SecKeychainDelete(handle.as_CFTypeRef() as *mut _), 0);
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
