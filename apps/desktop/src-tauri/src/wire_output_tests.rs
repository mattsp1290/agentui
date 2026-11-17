#[test]
fn output_requests_share_the_public_service_golden_cases() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../tests/client/fixtures/output-requests.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let value = case["request"].clone();
        assert_eq!(
            request(value.clone(), "host").is_ok(),
            case["valid"].as_bool().unwrap(),
            "{value}"
        );
        if case["valid"] == true {
            assert!(!image_operation(&value));
            let mut foreign = value;
            foreign["scope"]["hostId"] = json!("foreign");
            assert!(request(foreign, "host").is_err());
        }
    }
}
