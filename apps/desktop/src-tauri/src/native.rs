use crate::wire;
use reqwest::blocking::Client;
use serde::Deserialize;
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
    Connect {},
    Execute { observation: String, request: Value },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    host_id: String,
}
#[derive(Deserialize)]
struct Reply {
    ok: bool,
    value: Identity,
}
struct Binding {
    host_id: String,
    observation: String,
}

pub struct Owner {
    endpoint: String,
    binding: Option<Binding>,
    lifetime: String,
    _lock: File,
    client: Client,
}
pub type Shared = Arc<Mutex<Owner>>;
fn random() -> Result<String, &'static str> {
    let mut bytes = [0; 16];
    security_framework::random::SecRandom::default()
        .copy_bytes(&mut bytes)
        .map_err(|_| "profile-unavailable")?;
    Ok(bytes.iter().map(|value| format!("{value:02x}")).collect())
}
const SERVICE_MAX_RESPONSE_BYTES: usize = 4_100_000;
fn host_identity(status: u16, body: &str) -> Option<String> {
    let reply: Reply = serde_json::from_str(body).ok()?;
    let host_id = reply.value.host_id;
    (status == 200 && reply.ok && !host_id.is_empty() && host_id.encode_utf16().count() <= 1024)
        .then_some(host_id)
}
impl Owner {
    pub fn new(directory: &Path, endpoint: String) -> Result<Self, &'static str> {
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
            endpoint,
            binding: None,
            lifetime: random()?,
            _lock: lock,
            client,
        })
    }
    fn bind(&mut self, host_id: String) -> Result<&str, &'static str> {
        if self.binding.as_ref().map(|b| &b.host_id) != Some(&host_id) {
            self.binding = Some(Binding {
                host_id,
                observation: format!("{}{}", self.lifetime, random()?),
            });
        }
        Ok(&self.binding.as_ref().ok_or("stale")?.observation)
    }
    fn guard(&self, observation: &str) -> Result<&Binding, &'static str> {
        self.binding
            .as_ref()
            .filter(|binding| binding.observation == observation)
            .ok_or("stale")
    }
}
fn locked(owner: &Shared) -> Result<std::sync::MutexGuard<'_, Owner>, &'static str> {
    owner.lock().map_err(|_| "profile-unavailable")
}
fn http(
    client: Client,
    endpoint: &str,
    path: &str,
    body: &Value,
    cap: usize,
) -> Result<(u16, String), &'static str> {
    let response = client
        .post(format!("{endpoint}{path}"))
        .json(body)
        .send()
        .map_err(|_| "network-failed")?;
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
        Command::Connect {} => {
            let (client, endpoint) = {
                let state = locked(owner)?;
                (state.client.clone(), state.endpoint.clone())
            };
            let (status, body) = http(
                client,
                &endpoint,
                "/native/v1",
                &json!({"op":"metadata"}),
                SERVICE_MAX_RESPONSE_BYTES,
            )?;
            let host_id = host_identity(status, &body).ok_or("network-failed")?;
            let mut state = locked(owner)?;
            Ok(json!({"observation": state.bind(host_id)?}))
        }
        Command::Execute {
            observation,
            request,
        } => {
            let (client, endpoint, host_id, request) = {
                let state = locked(owner)?;
                let binding = state.guard(&observation)?;
                let request =
                    wire::request(request, &binding.host_id).map_err(|_| "invalid-input")?;
                (
                    state.client.clone(),
                    state.endpoint.clone(),
                    binding.host_id.clone(),
                    request,
                )
            };
            let image = wire::image_operation(&request);
            let (status, body) = http(
                client.clone(),
                &endpoint,
                if image {
                    "/native/v1/images"
                } else {
                    "/native/v1"
                },
                &request,
                if image {
                    wire::IMAGE_TRANSFER_MAX_BYTES
                } else {
                    SERVICE_MAX_RESPONSE_BYTES
                },
            )?;
            let value: Value = serde_json::from_str(&body).map_err(|_| "network-failed")?;
            // A replaced host refuses this host's scopes with 403 forbidden, so
            // ask who is answering before treating the refusal as an ordinary error.
            let answering = if request["op"] == "metadata" {
                host_identity(status, &body)
            } else if status == 403 && value["error"]["kind"] == "forbidden" {
                http(
                    client,
                    &endpoint,
                    "/native/v1",
                    &json!({"op":"metadata"}),
                    SERVICE_MAX_RESPONSE_BYTES,
                )
                .ok()
                .and_then(|(status, body)| host_identity(status, &body))
            } else {
                None
            };
            if answering.is_some_and(|answering| answering != host_id) {
                let mut state = locked(owner)?;
                if state.guard(&observation).is_ok() {
                    state.binding = None;
                }
                return Err("host-changed");
            }
            if image {
                locked(owner)?.guard(&observation)?;
                if !wire::image_response(&request, &value) {
                    return Err("network-failed");
                }
            }
            Ok(json!({"status":status, "body":value.to_string()}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use uuid::Uuid;
    struct Fixture {
        directory: std::path::PathBuf,
        owner: Shared,
    }
    impl Fixture {
        fn new(endpoint: &str) -> Self {
            let directory =
                std::env::temp_dir().join(format!("agentui-native-test-{}", Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let owner = Arc::new(Mutex::new(
                Owner::new(&directory.join("profile"), endpoint.into()).unwrap(),
            ));
            Self { directory, owner }
        }
        fn bound(&self, host_id: &str) -> String {
            locked(&self.owner)
                .unwrap()
                .bind(host_id.into())
                .unwrap()
                .to_string()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    fn metadata(host: &str) -> String {
        json!({"ok":true,"value":{"hostId":host,"principalId":"trusted-owner"}}).to_string()
    }
    fn read_request(socket: &std::net::TcpStream) -> (String, Vec<String>, Vec<u8>) {
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        let mut first = String::new();
        reader.read_line(&mut first).unwrap();
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
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        (first, headers, body)
    }
    fn reply(socket: &mut std::net::TcpStream, status: u16, body: &str) {
        write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    }
    fn serve(replies: Vec<String>) -> (String, std::thread::JoinHandle<Vec<Vec<String>>>) {
        serve_statuses(replies.into_iter().map(|body| (200, body)).collect())
    }
    fn serve_statuses(
        replies: Vec<(u16, String)>,
    ) -> (String, std::thread::JoinHandle<Vec<Vec<String>>>) {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            replies
                .into_iter()
                .map(|(status, body)| {
                    let (mut socket, _) = server.accept().unwrap();
                    let (_, mut headers, request) = read_request(&socket);
                    reply(&mut socket, status, &body);
                    headers.push(String::from_utf8(request).unwrap());
                    headers
                })
                .collect()
        });
        (format!("http://{address}"), thread)
    }
    fn delayed_reply(
        body: String,
    ) -> (
        String,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::Sender<()>,
        std::thread::JoinHandle<()>,
    ) {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let (entered, admitted) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            read_request(&socket);
            entered.send(()).unwrap();
            released.recv().unwrap();
            reply(&mut socket, 200, &body);
        });
        (format!("http://{address}"), admitted, release, thread)
    }

    #[test]
    fn connect_learns_the_host_without_credentials_and_keeps_the_observation_for_the_same_host() {
        let (endpoint, server) = serve(vec![metadata("host"), metadata("host")]);
        let fixture = Fixture::new(&endpoint);
        let first = run(&fixture.owner, Command::Connect {}).unwrap();
        assert_eq!(
            first.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["observation"]
        );
        let again = run(&fixture.owner, Command::Connect {}).unwrap();
        assert_eq!(again, first);
        for headers in server.join().unwrap() {
            assert!(
                !headers.iter().any(|line| line.starts_with("authorization:")
                    || line.starts_with("cookie:")
                    || line.starts_with("origin:"))
            );
        }
    }
    #[test]
    fn connect_to_a_different_host_retires_the_previous_observation() {
        let (endpoint, server) = serve(vec![metadata("host"), metadata("elsewhere")]);
        let fixture = Fixture::new(&endpoint);
        let first = run(&fixture.owner, Command::Connect {}).unwrap();
        let second = run(&fixture.owner, Command::Connect {}).unwrap();
        server.join().unwrap();
        assert_ne!(second["observation"], first["observation"]);
        assert!(run(
            &fixture.owner,
            Command::Execute {
                observation: first["observation"].as_str().unwrap().into(),
                request: json!({"op":"metadata"}),
            }
        )
        .is_err_and(|error| error == "stale"));
    }
    #[test]
    fn connect_refuses_failed_or_malformed_metadata() {
        for body in [
            json!({"ok":false,"error":{"kind":"unavailable","message":"Down"}}).to_string(),
            json!({"ok":true,"value":{"hostId":"","principalId":"trusted-owner"}}).to_string(),
            "not json".into(),
        ] {
            let (endpoint, server) = serve(vec![body]);
            let fixture = Fixture::new(&endpoint);
            assert_eq!(
                run(&fixture.owner, Command::Connect {}),
                Err("network-failed")
            );
            server.join().unwrap();
            assert!(locked(&fixture.owner).unwrap().binding.is_none());
        }
        let fixture = Fixture::new("http://127.0.0.1:1");
        assert_eq!(
            run(&fixture.owner, Command::Connect {}),
            Err("network-failed")
        );
    }
    #[test]
    fn execute_requires_the_current_observation_and_this_host_scope() {
        let fixture = Fixture::new("http://127.0.0.1:1");
        let unbound = run(
            &fixture.owner,
            Command::Execute {
                observation: "x".into(),
                request: json!({"op":"metadata"}),
            },
        );
        assert_eq!(unbound, Err("stale"));
        let observation = fixture.bound("host");
        let foreign = run(
            &fixture.owner,
            Command::Execute {
                observation,
                request: json!({"op":"conversation-agent","scope":{"hostId":"other","conversationId":"chat"}}),
            },
        );
        assert_eq!(foreign, Err("invalid-input"));
    }
    #[test]
    fn metadata_from_a_different_host_requires_an_explicit_reconnect() {
        for (host, accepted) in [("host", true), ("elsewhere", false)] {
            let (endpoint, server) = serve(vec![metadata(host)]);
            let fixture = Fixture::new(&endpoint);
            let observation = fixture.bound("host");
            let result = run(
                &fixture.owner,
                Command::Execute {
                    observation: observation.clone(),
                    request: json!({"op":"metadata"}),
                },
            );
            server.join().unwrap();
            if accepted {
                assert_eq!(result.unwrap()["status"], 200);
                assert!(locked(&fixture.owner).unwrap().guard(&observation).is_ok());
            } else {
                assert_eq!(result, Err("host-changed"));
                assert!(locked(&fixture.owner).unwrap().binding.is_none());
            }
        }
    }
    #[test]
    fn a_forbidden_scoped_reply_from_a_replaced_host_requires_an_explicit_reconnect() {
        let forbidden = json!({"ok":false,"error":{"kind":"forbidden","message":"Conversation belongs to another host"}}).to_string();
        let request =
            json!({"op":"conversation-agent","scope":{"hostId":"host","conversationId":"chat"}});
        for (answering, changed) in [("host", false), ("elsewhere", true)] {
            let (endpoint, server) =
                serve_statuses(vec![(403, forbidden.clone()), (200, metadata(answering))]);
            let fixture = Fixture::new(&endpoint);
            let observation = fixture.bound("host");
            let result = run(
                &fixture.owner,
                Command::Execute {
                    observation: observation.clone(),
                    request: request.clone(),
                },
            );
            let requests = server.join().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(requests[1].last().unwrap()).unwrap(),
                json!({"op":"metadata"})
            );
            if changed {
                assert_eq!(result, Err("host-changed"));
                assert!(locked(&fixture.owner).unwrap().binding.is_none());
                assert_eq!(
                    run(
                        &fixture.owner,
                        Command::Execute {
                            observation,
                            request: request.clone(),
                        },
                    ),
                    Err("stale")
                );
            } else {
                let result = result.unwrap();
                assert_eq!(result["status"], 403);
                assert_eq!(
                    serde_json::from_str::<Value>(result["body"].as_str().unwrap()).unwrap(),
                    serde_json::from_str::<Value>(&forbidden).unwrap()
                );
                assert!(locked(&fixture.owner).unwrap().guard(&observation).is_ok());
            }
        }
    }
    #[test]
    fn profile_lock_rejects_a_second_owner_and_closed_commands_reject_extras() {
        let fixture = Fixture::new("http://127.0.0.1:1");
        assert!(matches!(
            Owner::new(
                &fixture.directory.join("profile"),
                "http://127.0.0.1:1".into()
            ),
            Err("profile-in-use")
        ));
        assert!(matches!(
            serde_json::from_value::<Command>(json!({"kind":"connect"})),
            Ok(Command::Connect {})
        ));
        for value in [
            json!({"kind":"connect","url":"http://elsewhere"}),
            json!({"kind":"status"}),
            json!({"kind":"restore"}),
            json!({"kind":"pair","observation":"x","invitation":{}}),
            json!({"kind":"forget","observation":"x"}),
            json!({"kind":"execute","observation":"x","request":{},"headers":{}}),
        ] {
            assert!(serde_json::from_value::<Command>(value).is_err());
        }
    }
    #[test]
    fn native_http_refuses_redirects_and_caps_streamed_responses_without_retry() {
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
                read_request(&socket);
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
                cap,
            );
            assert_eq!(result.is_ok(), headers == "200 OK" && payload == "{}");
            child.join().unwrap();
        }
    }
    #[test]
    fn image_execution_uses_the_fixed_route_and_checks_the_reply() {
        for mode in ["maximum", "wrong-scope"] {
            let server = TcpListener::bind("127.0.0.1:0").unwrap();
            let fixture = Fixture::new(&format!("http://{}", server.local_addr().unwrap()));
            let observation = fixture.bound("host");
            let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            let request = json!({"op":"image-read", "scope":{"hostId":"host", "conversationId":"chat"}, "imageId":id});
            let expected_request = request.clone();
            let mut response = json!({"ok":true, "value":{"scope":request["scope"], "attachment":{"imageId":id, "name":"Screen", "mediaType":"image/png", "byteLength":1, "width":1, "height":1}, "base64":"AA=="}});
            if mode == "maximum" {
                response["value"]["base64"] = json!("A".repeat(5_592_406) + "==");
                response["value"]["attachment"]["byteLength"] = json!(4 * 1024 * 1024);
            } else {
                response["value"]["scope"]["conversationId"] = json!("foreign");
            }
            let response = response.to_string();
            let child = std::thread::spawn(move || {
                let (mut socket, _) = server.accept().unwrap();
                let (first, headers, body) = read_request(&socket);
                assert_eq!(first, "POST /native/v1/images HTTP/1.1\r\n");
                assert!(
                    !headers.iter().any(|line| line.starts_with("authorization:")
                        || line.starts_with("cookie:")
                        || line.starts_with("origin:"))
                );
                assert_eq!(
                    serde_json::from_slice::<Value>(&body).unwrap(),
                    expected_request
                );
                reply(&mut socket, 200, &response);
            });
            let result = run(
                &fixture.owner,
                Command::Execute {
                    observation,
                    request,
                },
            );
            child.join().unwrap();
            if mode == "maximum" {
                assert!(result.unwrap()["body"].as_str().unwrap().len() > 4_100_000);
            } else {
                assert_eq!(result, Err("network-failed"));
            }
        }
    }
    #[test]
    fn image_read_cannot_return_after_the_host_binding_changes() {
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let request = json!({"op":"image-read", "scope":{"hostId":"host", "conversationId":"chat"}, "imageId":id});
        let body = json!({"ok":true, "value":{"scope":request["scope"], "attachment":{"imageId":id, "name":"Screen", "mediaType":"image/png", "byteLength":1, "width":1, "height":1}, "base64":"AA=="}}).to_string();
        let (endpoint, admitted, release, server) = delayed_reply(body);
        let fixture = Fixture::new(&endpoint);
        let observation = fixture.bound("host");
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
        fixture.bound("elsewhere");
        release.send(()).unwrap();
        assert_eq!(execution.join().unwrap(), Err("stale"));
        server.join().unwrap();
    }
    #[test]
    fn a_delayed_host_change_cannot_retire_a_newer_binding() {
        let (endpoint, admitted, release, server) = delayed_reply(metadata("elsewhere"));
        let fixture = Fixture::new(&endpoint);
        let first = fixture.bound("host");
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
        let replacement = fixture.bound("elsewhere");
        release.send(()).unwrap();
        assert_eq!(request.join().unwrap(), Err("host-changed"));
        server.join().unwrap();
        assert!(locked(&fixture.owner).unwrap().guard(&replacement).is_ok());
    }
    include!("native_output_tests.rs");
}
