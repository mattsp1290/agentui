#[test]
fn outputs_execute_through_the_ordinary_native_http_route_without_credentials() {
    use std::io::{BufRead, BufReader, Write};
    for operation in ["output-list", "output-read"] {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let fixture = Fixture::new(&format!("http://{address}"));
        eprintln!(
            "output-native-resource {}",
            json!({"directory":fixture.directory, "port":address.port(), "pid":std::process::id()})
        );
        let observation = fixture.bound("host");
        let scope = json!({"hostId":"host", "conversationId":"chat"});
        let output_id = format!("output-{}", "a".repeat(64));
        let mut request = json!({"op":operation, "scope":scope});
        let response = if operation == "output-read" {
            request["outputId"] = json!(output_id);
            json!({"ok":true, "value":{"scope":scope, "outputId":output_id, "result":{"kind":"available", "output":{
                "outputId":output_id, "name":"report.txt", "mediaType":"text/plain", "byteLength":65536,
                "sha256":"156c38442089c1323d3e3ba549a6ac24341c47e8b6367bec4740c9b8c865826e", "lifetime":"provider-retained"}, "base64":"QUFB".repeat(21845)+"QQ=="}}})
        } else {
            json!({"ok":true, "value":{"scope":scope, "result":{"kind":"available", "outputs":[]}}})
        };
        let expected_request = request.clone();
        let expected_response = response.to_string();
        let response_body = expected_response.clone();
        let child = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            assert_eq!(first, "POST /native/v1 HTTP/1.1\r\n");
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
            assert!(
                !headers.iter().any(|line| line.starts_with("authorization:")
                    || line.starts_with("cookie:")
                    || line.starts_with("origin:"))
            );
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes).unwrap(),
                expected_request
            );
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response_body.len(), response_body).unwrap();
        });
        let result = run(
            &fixture.owner,
            Command::Execute {
                observation,
                request,
            },
        )
        .unwrap();
        child.join().unwrap();
        assert_eq!(result["status"], 200);
        assert_eq!(result["body"], expected_response);
        assert!(
            std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_err()
        );
        let directory = fixture.directory.clone();
        drop(fixture);
        assert!(!directory.exists());
    }
}
