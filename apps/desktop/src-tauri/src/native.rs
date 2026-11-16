use crate::{
    keychain::{Keychain, ReadMode},
    wire,
};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Command {
    Status {},
    Restore {},
    Pair {
        observation: String,
        invitation: Value,
    },
    Forget {
        observation: String,
    },
    Execute {
        observation: String,
        request: Value,
    },
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credential {
    host_id: String,
    principal_id: String,
    secret: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    namespace: String,
    profile: String,
    class: String,
    endpoint: String,
    generation: String,
    credential: Credential,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enrollment {
    ok: bool,
    value: Credential,
}

pub struct Owner {
    store: Keychain,
    endpoint: String,
    raw: Option<Vec<u8>>,
    reference: Option<String>,
    lifetime: String,
    blocked: bool,
    _lock: File,
    client: Client,
}
pub type Shared = Arc<Mutex<Owner>>;
fn random() -> Result<String, &'static str> {
    let mut bytes = [0; 16];
    security_framework::random::SecRandom::default()
        .copy_bytes(&mut bytes)
        .map_err(|_| "keychain-unavailable")?;
    Ok(bytes.iter().map(|value| format!("{value:02x}")).collect())
}
fn id(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 1024
}
fn token(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'_' | b'-'))
}
impl Owner {
    pub fn new(directory: &Path, endpoint: String, store: Keychain) -> Result<Self, &'static str> {
        std::fs::create_dir_all(directory).map_err(|_| "profile-unavailable")?;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "profile-unavailable")?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .open(directory.join("native-owner.lock"))
            .map_err(|_| "profile-unavailable")?;
        lock.try_lock().map_err(|_| "profile-in-use")?;
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "network-failed")?;
        Ok(Self {
            store,
            endpoint,
            raw: None,
            reference: None,
            lifetime: random()?,
            blocked: false,
            _lock: lock,
            client,
        })
    }
    fn record(&self) -> Option<Record> {
        let record: Record = serde_json::from_slice(self.raw.as_ref()?).ok()?;
        (record.version == 1
            && record.namespace == "homes.birb.agentui"
            && record.profile == "mac-default"
            && record.class == "native"
            && record.endpoint == self.endpoint
            && token(&record.generation, 32)
            && id(&record.credential.host_id)
            && id(&record.credential.principal_id)
            && token(&record.credential.secret, 43))
        .then_some(record)
    }
    fn status(&mut self, mode: ReadMode) -> Result<Value, &'static str> {
        if self.blocked {
            return Err("keychain-unavailable");
        }
        let raw = self.store.read(mode)?;
        if raw != self.raw || self.reference.is_none() {
            self.reference = None;
            self.raw = raw;
            self.reference = Some(format!("{}{}", self.lifetime, random()?));
        }
        let observation = self.reference.as_ref().ok_or("stale")?;
        Ok(match self.record() {
            Some(record) => {
                json!({"kind":"ready", "observation":observation, "hostId":record.credential.host_id, "principalId":record.credential.principal_id})
            }
            None => {
                json!({"kind":if self.raw.is_some() {"unreadable"} else {"absent"}, "observation":observation})
            }
        })
    }
    fn guard(&mut self, reference: &str) -> Result<(), &'static str> {
        if self.blocked {
            return Err("keychain-unavailable");
        }
        if self.reference.as_deref() != Some(reference) {
            return Err("stale");
        }
        if self.store.read(ReadMode::Quiet)? != self.raw {
            self.reference = None;
            return Err("stale");
        }
        Ok(())
    }
    fn commit(&mut self, intended: Option<Vec<u8>>) -> Result<Value, &'static str> {
        self.reference = None;
        self.blocked = true;
        let write = self.store.write(&self.raw, &intended);
        let actual = self.store.read(ReadMode::Quiet)?;
        if actual == intended {
            self.raw = actual;
            self.blocked = false;
            return self.status(ReadMode::Quiet);
        }
        if actual == self.raw && write != Err("stale") {
            self.blocked = false;
        }
        Err(write.err().unwrap_or("keychain-unavailable"))
    }
}
fn locked(owner: &Shared) -> Result<std::sync::MutexGuard<'_, Owner>, &'static str> {
    owner.lock().map_err(|_| "keychain-unavailable")
}
fn http(
    client: Client,
    endpoint: &str,
    path: &str,
    body: &Value,
    secret: Option<&str>,
    cap: usize,
) -> Result<(u16, String), &'static str> {
    let mut request = client.post(format!("{endpoint}{path}")).json(body);
    if let Some(secret) = secret {
        request = request.bearer_auth(secret);
    }
    let response = request.send().map_err(|_| "network-failed")?;
    let status = response.status().as_u16();
    if response.status().is_redirection()
        || response
            .content_length()
            .is_some_and(|len| len > cap as u64)
        || !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().starts_with("application/json"))
    {
        return Err("network-failed");
    }
    let mut bytes = Vec::new();
    response
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "network-failed")?;
    if bytes.len() > cap {
        return Err("network-failed");
    }
    Ok((
        status,
        String::from_utf8(bytes).map_err(|_| "network-failed")?,
    ))
}
pub fn run(owner: &Shared, command: Command) -> Result<Value, &'static str> {
    match command {
        Command::Status {} => locked(owner)?.status(ReadMode::Quiet),
        Command::Restore {} => locked(owner)?.status(ReadMode::UserInitiated),
        Command::Forget { observation } => {
            let unreadable = {
                let mut state = locked(owner)?;
                state.guard(&observation)?;
                state.raw.is_some() && state.record().is_none()
            };
            if unreadable && rfd::MessageDialog::new().set_title("Discard unreadable AgentUI pairing?")
                .set_description("This protected record may belong to a newer app. Discard only this local pairing? Conversations and unresolved commands are kept.")
                .set_buttons(rfd::MessageButtons::OkCancel).show() != rfd::MessageDialogResult::Ok { return Err("cancelled"); }
            let mut state = locked(owner)?;
            state.guard(&observation)?;
            state.commit(None)
        }
        Command::Pair {
            observation,
            invitation,
        } => {
            let invitation = wire::invitation(invitation).map_err(|_| "invalid-input")?;
            let (client, endpoint) = {
                let mut state = locked(owner)?;
                state.guard(&observation)?;
                if state.raw.is_some() && state.record().is_none() {
                    return Err("unreadable");
                }
                (state.client.clone(), state.endpoint.clone())
            };
            let (status, body) = http(
                client,
                &endpoint,
                "/native/v1/pair",
                &serde_json::to_value(&invitation).map_err(|_| "invalid-input")?,
                None,
                4096,
            )?;
            let enrollment: Enrollment =
                serde_json::from_str(&body).map_err(|_| "pairing-failed")?;
            if status != 200
                || !enrollment.ok
                || enrollment.value.host_id != invitation.host_id
                || !id(&enrollment.value.principal_id)
                || !token(&enrollment.value.secret, 43)
            {
                return Err("pairing-failed");
            }
            let mut state = locked(owner)?;
            state.guard(&observation)?;
            let record = Record {
                version: 1,
                namespace: "homes.birb.agentui".into(),
                profile: "mac-default".into(),
                class: "native".into(),
                endpoint,
                generation: random()?,
                credential: enrollment.value,
            };
            state.commit(Some(
                serde_json::to_vec(&record).map_err(|_| "keychain-unavailable")?,
            ))
        }
        Command::Execute {
            observation,
            request,
        } => {
            let (client, endpoint, credential, request) = {
                let mut state = locked(owner)?;
                state.guard(&observation)?;
                let record = state.record().ok_or("unreadable")?;
                let request = wire::request(request, &record.credential.host_id)
                    .map_err(|_| "invalid-input")?;
                (
                    state.client.clone(),
                    state.endpoint.clone(),
                    record.credential,
                    request,
                )
            };
            let image = wire::image_operation(&request);
            let (status, body) = http(
                client,
                &endpoint,
                if image {
                    "/native/v1/images"
                } else {
                    "/native/v1"
                },
                &request,
                Some(&credential.secret),
                if image {
                    wire::IMAGE_TRANSFER_MAX_BYTES
                } else {
                    4_100_000
                },
            )?;
            let value: Value = serde_json::from_str(&body).map_err(|_| "network-failed")?;
            let body = value.to_string();
            if body.contains(&credential.secret) {
                return Err("network-failed");
            }
            if request["op"] == "metadata"
                && value["ok"] == true
                && (value["value"]["hostId"] != credential.host_id
                    || value["value"]["principalId"] != credential.principal_id)
            {
                return Err("network-failed");
            }
            if image {
                locked(owner)?.guard(&observation)?;
                if !wire::image_response(&request, &value) {
                    return Err("network-failed");
                }
            }
            if status == 401 {
                let mut state = locked(owner)?;
                if state.guard(&observation).is_ok() {
                    state.reference = None;
                }
            }
            Ok(json!({"status":status, "body":body}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_foundation::base::TCFType;
    use security_framework::os::macos::keychain::{CreateOptions, SecKeychain};
    use std::net::TcpListener;
    use uuid::Uuid;
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainLock(keychain: *mut std::ffi::c_void) -> i32;
        fn SecKeychainDelete(keychain: *mut std::ffi::c_void) -> i32;
    }
    struct Fixture {
        directory: std::path::PathBuf,
        handle: SecKeychain,
        owner: Shared,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("agentui-native-test-{}", Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let handle = CreateOptions::new()
                .password(&Uuid::new_v4().to_string())
                .create(directory.join("test.keychain"))
                .unwrap();
            let store = Keychain {
                handle: handle.clone(),
                service: format!("agentui-test-{}", Uuid::new_v4()),
            };
            let owner = Arc::new(Mutex::new(
                Owner::new(
                    &directory.join("profile"),
                    "http://127.0.0.1:1".into(),
                    store,
                )
                .unwrap(),
            ));
            Self {
                directory,
                handle,
                owner,
            }
        }
        fn ready(&self) -> Value {
            let record = Record {
                version: 1,
                namespace: "homes.birb.agentui".into(),
                profile: "mac-default".into(),
                class: "native".into(),
                endpoint: locked(&self.owner).unwrap().endpoint.clone(),
                generation: Uuid::new_v4().simple().to_string(),
                credential: Credential {
                    host_id: "host".into(),
                    principal_id: "principal".into(),
                    secret: "S".repeat(43),
                },
            };
            locked(&self.owner)
                .unwrap()
                .commit(Some(serde_json::to_vec(&record).unwrap()))
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                assert_eq!(SecKeychainDelete(self.handle.as_CFTypeRef() as *mut _), 0);
            }
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    #[test]
    fn protected_readback_binding_retirement_and_absent_forget_are_exact() {
        let fixture = Fixture::new();
        let first = run(&fixture.owner, Command::Status {}).unwrap();
        assert_eq!(first["kind"], "absent");
        let absent = first["observation"].as_str().unwrap().to_string();
        let ready = fixture.ready();
        assert_eq!(ready["kind"], "ready");
        assert!(ready.get("secret").is_none());
        assert_eq!(locked(&fixture.owner).unwrap().guard(&absent), Err("stale"));
        let reference = ready["observation"].as_str().unwrap().to_string();
        let removed = run(
            &fixture.owner,
            Command::Forget {
                observation: reference.clone(),
            },
        )
        .unwrap();
        assert_eq!(removed["kind"], "absent");
        assert_eq!(
            locked(&fixture.owner).unwrap().guard(&reference),
            Err("stale")
        );
        let reference = removed["observation"].as_str().unwrap().to_string();
        let removed_again = run(
            &fixture.owner,
            Command::Forget {
                observation: reference.clone(),
            },
        )
        .unwrap();
        assert_ne!(removed_again["observation"], reference);
        assert_eq!(
            locked(&fixture.owner).unwrap().guard(&reference),
            Err("stale")
        );
        let ready = fixture.ready();
        let mut state = locked(&fixture.owner).unwrap();
        let mut record = state.record().unwrap();
        record.endpoint = "http://127.0.0.1:2".into();
        state.raw = Some(serde_json::to_vec(&record).unwrap());
        assert!(state.record().is_none());
        assert!(!ready.to_string().contains(&"S".repeat(43)));
    }
    #[test]
    fn restore_preserves_records_and_observations_and_respects_blocked_owners() {
        let fixture = Fixture::new();
        let absent = run(&fixture.owner, Command::Restore {}).unwrap();
        assert_eq!(absent["kind"], "absent");
        assert_eq!(run(&fixture.owner, Command::Status {}).unwrap(), absent);
        let ready = fixture.ready();
        let bytes = locked(&fixture.owner).unwrap().raw.clone();
        assert_eq!(run(&fixture.owner, Command::Restore {}).unwrap(), ready);
        {
            let state = locked(&fixture.owner).unwrap();
            assert_eq!(state.store.read(ReadMode::Quiet).unwrap(), bytes);
            state
                .store
                .write(&bytes, &Some(b"unreadable".to_vec()))
                .unwrap();
        }
        let unreadable = run(&fixture.owner, Command::Restore {}).unwrap();
        assert_eq!(unreadable["kind"], "unreadable");
        assert_ne!(unreadable["observation"], ready["observation"]);
        assert_eq!(
            run(&fixture.owner, Command::Restore {}).unwrap(),
            unreadable
        );
        let mut state = locked(&fixture.owner).unwrap();
        assert_eq!(
            state.guard(ready["observation"].as_str().unwrap()),
            Err("stale")
        );
        assert_eq!(
            state.store.read(ReadMode::Quiet).unwrap(),
            Some(b"unreadable".to_vec())
        );
        state.blocked = true;
        let reference = state.reference.clone();
        drop(state);
        assert_eq!(
            run(&fixture.owner, Command::Restore {}),
            Err("keychain-unavailable")
        );
        let state = locked(&fixture.owner).unwrap();
        assert!(state.blocked);
        assert_eq!(state.reference, reference);
        assert_eq!(state.raw, Some(b"unreadable".to_vec()));
    }
    #[test]
    fn all_keychain_operations_wait_for_the_process_interaction_lock() {
        let fixture = Fixture::new();
        fixture.ready();
        for operation in ["quiet", "restore", "write"] {
            let state = locked(&fixture.owner).unwrap();
            let store = Keychain {
                handle: fixture.handle.clone(),
                service: state.store.service.clone(),
            };
            let bytes = state.raw.clone();
            let lock = crate::keychain::INTERACTION.lock().unwrap();
            let interaction = SecKeychain::disable_user_interaction().unwrap();
            assert!(!SecKeychain::user_interaction_allowed().unwrap());
            let (started, starting) = std::sync::mpsc::channel();
            let (finished, finishing) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                started.send(()).unwrap();
                let result = match operation {
                    "quiet" => store
                        .read(ReadMode::Quiet)
                        .map(|actual| assert_eq!(actual, bytes)),
                    "restore" => store
                        .read(ReadMode::UserInitiated)
                        .map(|actual| assert_eq!(actual, bytes)),
                    _ => store.write(&bytes, &bytes),
                };
                finished.send(result).unwrap();
            });
            starting.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(matches!(
                finishing.recv_timeout(Duration::from_millis(100)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
            assert!(!SecKeychain::user_interaction_allowed().unwrap());
            drop(interaction);
            assert!(SecKeychain::user_interaction_allowed().unwrap());
            drop(lock);
            finishing
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            worker.join().unwrap();
            let _lock = crate::keychain::INTERACTION.lock().unwrap();
            assert!(SecKeychain::user_interaction_allowed().unwrap());
        }
    }
    #[test]
    fn locked_private_keychain_stops_admission_without_removal() {
        let fixture = Fixture::new();
        fixture.ready();
        let ready = run(&fixture.owner, Command::Restore {}).unwrap();
        let before = locked(&fixture.owner).unwrap().raw.clone();
        unsafe {
            assert_eq!(SecKeychainLock(fixture.handle.as_CFTypeRef() as *mut _), 0);
        }
        let reference = ready["observation"].as_str().unwrap().to_string();
        assert!(locked(&fixture.owner).unwrap().guard(&reference).is_err());
        assert!(run(
            &fixture.owner,
            Command::Forget {
                observation: reference
            }
        )
        .is_err());
        assert!(run(&fixture.owner, Command::Status {}).is_err());
        assert!(run(
            &fixture.owner,
            Command::Execute {
                observation: ready["observation"].as_str().unwrap().to_string(),
                request: json!({"op":"metadata"}),
            }
        )
        .is_err());
        let state = locked(&fixture.owner).unwrap();
        assert_eq!(state.raw, before);
        assert_eq!(state.reference.as_deref(), ready["observation"].as_str());
        assert!(state.store.write(&before, &before).is_err());
        let _lock = crate::keychain::INTERACTION.lock().unwrap();
        assert!(SecKeychain::user_interaction_allowed().unwrap());
    }
    #[test]
    fn profile_lock_rejects_a_second_owner_and_closed_commands_reject_extras() {
        let fixture = Fixture::new();
        let store = Keychain {
            handle: fixture.handle.clone(),
            service: "unused".into(),
        };
        assert!(matches!(
            Owner::new(
                &fixture.directory.join("profile"),
                "http://127.0.0.1:1".into(),
                store
            ),
            Err("profile-in-use")
        ));
        assert!(matches!(
            serde_json::from_value::<Command>(json!({"kind":"restore"})),
            Ok(Command::Restore {})
        ));
        for value in [
            json!({"kind":"status","url":"http://elsewhere"}),
            json!({"kind":"restore","observation":"x"}),
            json!({"kind":"restore","mode":"quiet"}),
            json!({"kind":"forget","observation":"x","secret":"x"}),
            json!({"kind":"execute","observation":"x","request":{},"headers":{}}),
        ] {
            assert!(serde_json::from_value::<Command>(value).is_err());
        }
    }
    #[test]
    fn native_http_refuses_redirects_and_caps_streamed_responses_without_retry() {
        use std::io::{BufRead, BufReader, Write};
        for (headers, payload, cap) in [
            (
                "302 Found\r\nLocation: http://127.0.0.1:1/redirect",
                "{}",
                100,
            ),
            ("200 OK", "oversized-body", 4),
            ("200 OK", "{}", 100),
        ] {
            let server = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = server.local_addr().unwrap();
            let child = std::thread::spawn(move || {
                let (mut socket, _) = server.accept().unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                write!(socket, "HTTP/1.1 {headers}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{payload}").unwrap();
                server.set_nonblocking(true).unwrap();
                std::thread::sleep(Duration::from_millis(50));
                assert!(server.accept().is_err(), "no redirect or retry request");
            });
            let client = Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();
            let result = http(
                client,
                &format!("http://{address}"),
                "/native/v1",
                &json!({"op":"metadata"}),
                Some("not-logged"),
                cap,
            );
            assert_eq!(result.is_ok(), headers == "200 OK" && payload == "{}");
            child.join().unwrap();
        }
    }
    #[test]
    fn image_execution_uses_the_fixed_route_and_keeps_credentials_private() {
        use std::io::{BufRead, BufReader, Write};
        for mode in ["maximum", "wrong-scope", "secret"] {
            let fixture = Fixture::new();
            let server = TcpListener::bind("127.0.0.1:0").unwrap();
            locked(&fixture.owner).unwrap().endpoint =
                format!("http://{}", server.local_addr().unwrap());
            let ready = fixture.ready();
            let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            let request = json!({"op":"image-read", "scope":{"hostId":"host", "conversationId":"chat"}, "imageId":id});
            let expected_request = request.clone();
            let mut response = json!({"ok":true, "value":{"scope":request["scope"], "attachment":{"imageId":id, "name":"Screen", "mediaType":"image/png", "byteLength":1, "width":1, "height":1}, "base64":"AA=="}});
            match mode {
                "maximum" => {
                    response["value"]["base64"] = json!("A".repeat(5_592_406) + "==");
                    response["value"]["attachment"]["byteLength"] = json!(4 * 1024 * 1024);
                }
                "wrong-scope" => response["value"]["scope"]["conversationId"] = json!("foreign"),
                _ => response["value"]["attachment"]["name"] = json!("S".repeat(43)),
            }
            let response = response.to_string();
            let child = std::thread::spawn(move || {
                let (mut socket, _) = server.accept().unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                assert_eq!(first, "POST /native/v1/images HTTP/1.1\r\n");
                let mut headers = Vec::new();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                    headers.push(line.to_lowercase());
                }
                assert!(headers.contains(&format!("authorization: bearer {}\r\n", "s".repeat(43))));
                assert!(!headers
                    .iter()
                    .any(|line| line.starts_with("cookie:") || line.starts_with("origin:")));
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                assert_eq!(
                    serde_json::from_slice::<Value>(&bytes).unwrap(),
                    expected_request
                );
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
            });
            let result = run(
                &fixture.owner,
                Command::Execute {
                    observation: ready["observation"].as_str().unwrap().into(),
                    request,
                },
            );
            child.join().unwrap();
            if mode == "maximum" {
                let result = result.unwrap();
                assert!(result["body"].as_str().unwrap().len() > 4_100_000);
                assert!(!result.to_string().contains(&"S".repeat(43)));
            } else {
                assert_eq!(result, Err("network-failed"));
            }
        }
    }

    fn delayed_reply(
        body: String,
        status: u16,
    ) -> (
        String,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::Sender<()>,
        std::thread::JoinHandle<()>,
    ) {
        use std::io::{BufRead, BufReader, Write};
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let (entered, admitted) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut request = vec![0; length];
            reader.read_exact(&mut request).unwrap();
            entered.send(()).unwrap();
            released.recv().unwrap();
            write!(socket,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        });
        (format!("http://{address}"), admitted, release, thread)
    }
    #[test]
    fn image_read_cannot_return_after_its_credential_observation_changes() {
        let fixture = Fixture::new();
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let request = json!({"op":"image-read", "scope":{"hostId":"host", "conversationId":"chat"}, "imageId":id});
        let reply = json!({"ok":true, "value":{"scope":request["scope"], "attachment":{"imageId":id, "name":"Screen", "mediaType":"image/png", "byteLength":1, "width":1, "height":1}, "base64":"AA=="}}).to_string();
        let (endpoint, admitted, release, server) = delayed_reply(reply, 200);
        locked(&fixture.owner).unwrap().endpoint = endpoint;
        let observation = fixture.ready()["observation"].as_str().unwrap().to_string();
        let owner = fixture.owner.clone();
        let execution = std::thread::spawn(move || {
            run(
                &owner,
                Command::Execute {
                    observation,
                    request,
                },
            )
        });
        admitted.recv_timeout(Duration::from_secs(5)).unwrap();
        fixture.ready();
        release.send(()).unwrap();
        assert_eq!(execution.join().unwrap(), Err("stale"));
        server.join().unwrap();
    }

    #[test]
    fn a_delayed_pair_cannot_install_after_forgetting_absence() {
        let fixture = Fixture::new();
        let reply=json!({"ok":true,"value":{"hostId":"host","principalId":"principal","secret":"S".repeat(43)}}).to_string();
        let (endpoint, admitted, release, server) = delayed_reply(reply, 200);
        locked(&fixture.owner).unwrap().endpoint = endpoint;
        let absent = run(&fixture.owner, Command::Status {}).unwrap()["observation"]
            .as_str()
            .unwrap()
            .to_string();
        let owner = fixture.owner.clone();
        let reference = absent.clone();
        let pair = std::thread::spawn(move || {
            run(
                &owner,
                Command::Pair {
                    observation: reference,
                    invitation: json!({"version":1,"hostId":"host","code":"A".repeat(32)}),
                },
            )
        });
        admitted.recv_timeout(Duration::from_secs(5)).unwrap();
        let forgotten = run(
            &fixture.owner,
            Command::Forget {
                observation: absent,
            },
        )
        .unwrap();
        release.send(()).unwrap();
        assert_eq!(pair.join().unwrap(), Err("stale"));
        server.join().unwrap();
        assert_eq!(run(&fixture.owner, Command::Status {}).unwrap(), forgotten);
        assert!(locked(&fixture.owner)
            .unwrap()
            .store
            .read(ReadMode::Quiet)
            .unwrap()
            .is_none());
    }
    #[test]
    fn a_delayed_unauthorized_response_cannot_retire_a_replacement() {
        let fixture = Fixture::new();
        let (endpoint, admitted, release, server) = delayed_reply(
            json!({"ok":false,"error":{"kind":"unauthorized","message":"Expired"}}).to_string(),
            401,
        );
        locked(&fixture.owner).unwrap().endpoint = endpoint;
        let first = fixture.ready()["observation"].as_str().unwrap().to_string();
        let owner = fixture.owner.clone();
        let request = std::thread::spawn(move || {
            run(
                &owner,
                Command::Execute {
                    observation: first,
                    request: json!({"op":"metadata"}),
                },
            )
        });
        admitted.recv_timeout(Duration::from_secs(5)).unwrap();
        let replacement = fixture.ready();
        release.send(()).unwrap();
        assert_eq!(request.join().unwrap().unwrap()["status"], 401);
        server.join().unwrap();
        assert_eq!(
            run(&fixture.owner, Command::Status {}).unwrap(),
            replacement
        );
    }
}
