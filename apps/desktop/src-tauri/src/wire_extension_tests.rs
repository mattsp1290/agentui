#[test]
fn catalog_filters_reject_unknown_kinds_and_fields() {
    for filter in [
        json!({"kind":"agent", "namespace":"fixture"}),
        json!({"kind":"namespace"}),
        json!({"kind":"namespace", "namespace":"Fixture"}),
        json!({"kind":"namespace", "namespace":"fixture", "installationId":"i"}),
        json!({"kind":"provider-agent", "namespace":"fixture", "installationId":"i"}),
        json!({"kind":"provider-agent", "namespace":"fixture", "installationId":"", "providerAgentId":"a"}),
        json!(null),
    ] {
        invalid(json!({"op":"catalog", "after":null, "limit":5, "filter":filter}));
    }
}

#[test]
fn extension_calls_are_bounded_and_patterned() {
    let call = |namespace: &str, operation: &str, input: Value| json!({"op":"extension-call", "namespace":namespace, "installationId":"personal", "operation":operation, "input":input});
    let overhead = serde_json::to_vec(&json!("")).unwrap().len();
    valid(call(
        "fixture",
        "echo",
        json!("x".repeat(MAX_COMMAND_BYTES - overhead)),
    ));
    invalid(call(
        "fixture",
        "echo",
        json!("x".repeat(MAX_COMMAND_BYTES - overhead + 1)),
    ));
    for (namespace, operation) in [
        ("Fixture", "echo"),
        ("1fixture", "echo"),
        ("fix.ture", "echo"),
        (&"n".repeat(33) as &str, "echo"),
        ("", "echo"),
        ("fixture", "Echo"),
        ("fixture", ".echo"),
        ("fixture", "echo_x"),
        ("fixture", ""),
        ("fixture", &"o".repeat(65) as &str),
    ] {
        invalid(call(namespace, operation, json!({})));
    }
    valid(call(&"n".repeat(32), &"o".repeat(64), json!({})));
    invalid(
        json!({"op":"extension-call", "namespace":"fixture", "installationId":"", "operation":"echo", "input":{}}),
    );
    invalid(
        json!({"op":"extension-call", "namespace":"fixture", "operation":"echo", "input":{}}),
    );
    invalid(
        json!({"op":"extension-call", "namespace":"fixture", "installationId":"i", "operation":"echo"}),
    );
    invalid(
        json!({"op":"extension-call", "namespace":"fixture", "installation_id":"i", "operation":"echo", "input":{}}),
    );
}
