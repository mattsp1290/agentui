use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const IMAGE_TRANSFER_MAX_BYTES: usize = 6 * 1024 * 1024;
const IMAGE_MAX_BYTES: usize = 4 * 1024 * 1024;

const INVALID: &str = "Invalid native service request";
const MAX_COMMAND_BYTES: usize = 64_000;
const MAX_REQUEST_BYTES: usize = MAX_COMMAND_BYTES * 6 + 26_000;

#[derive(Deserialize, Serialize)]
#[serde(try_from = "String")]
struct Id(String);
impl TryFrom<String> for Id {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() || value.encode_utf16().count() > 1024 {
            return Err(INVALID);
        }
        Ok(Self(value))
    }
}
#[derive(Deserialize, Serialize)]
#[serde(try_from = "serde_json::Number")]
struct Count(u64);
impl TryFrom<serde_json::Number> for Count {
    type Error = &'static str;
    fn try_from(value: serde_json::Number) -> Result<Self, Self::Error> {
        let number = value.as_f64().ok_or(INVALID)?;
        if !(0.0..=9_007_199_254_740_991.0).contains(&number) || number.fract() != 0.0 {
            return Err(INVALID);
        }
        Ok(Self(number as u64))
    }
}
fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    de: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(de)
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    host_id: Id,
    conversation_id: Id,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    version: Count,
    scope: Scope,
    client_command_id: Id,
    body: Body,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Body {
    #[serde(rename = "revoke-permission")]
    RevokePermission {
        permission_id: Id,
        scope: PermissionScope,
    },
    Send {
        text: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "present"
        )]
        frontend: Option<FrontendOffer>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        image_id: Option<String>,
    },
    Approve {
        pending_id: String,
        choice_id: String,
    },
    Cancel {
        run_id: String,
    },
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FrontendDefinition {
    name: String,
    description: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    parameters: Option<serde_json::Map<String, Value>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    metadata: Option<serde_json::Map<String, Value>>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OfferedTool {
    definition: FrontendDefinition,
    activation_id: Id,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FrontendOffer {
    platform: String,
    tools: Vec<OfferedTool>,
}
impl FrontendOffer {
    fn valid(&self) -> bool {
        let mut names = std::collections::HashSet::new();
        self.platform == "desktop"
            && !self.tools.is_empty()
            && self.tools.len() <= 128
            && self.tools.iter().all(|tool| {
                let definition = &tool.definition;
                let Some((namespace, local)) = definition.name.split_once("__") else {
                    return false;
                };
                definition.name.len() <= 64
                    && !namespace.is_empty()
                    && namespace.len() <= 32
                    && namespace.as_bytes()[0].is_ascii_lowercase()
                    && namespace
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                    && !local.is_empty()
                    && local.as_bytes()[0].is_ascii_alphabetic()
                    && local
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                    && names.insert(&definition.name)
                    && !definition
                        .metadata
                        .as_ref()
                        .is_some_and(|value| value.contains_key("ag-ui"))
            })
    }
}
fn bounded_json(value: &Value, depth: usize, nodes: &mut usize) -> bool {
    *nodes += 1;
    if depth > 64 || *nodes > 100_000 {
        return false;
    }
    match value {
        Value::Array(values) => values
            .iter()
            .all(|value| bounded_json(value, depth + 1, nodes)),
        Value::Object(values) => values
            .values()
            .all(|value| bounded_json(value, depth + 1, nodes)),
        _ => true,
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum BindingAction {
    Recover,
    Unavailable,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum PermissionScope {
    Conversation,
    Agent,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ObservationAction {
    Read,
    Retry,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "op",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    ImageUpload {
        scope: Scope,
        upload_id: String,
        name: String,
        byte_length: Count,
        base64: String,
    },
    ImageRead {
        scope: Scope,
        image_id: String,
    },
    Metadata {},
    Catalog {
        #[serde(deserialize_with = "nullable")]
        after: Option<Id>,
        limit: Count,
    },
    Search {
        query: String,
        #[serde(deserialize_with = "nullable")]
        after: Option<Id>,
    },
    Create {
        scope: Scope,
        agent_id: Id,
    },
    FrontendBinding {
        scope: Scope,
        id: Id,
        action: BindingAction,
    },
    ProviderObservation {
        scope: Scope,
        action: ObservationAction,
    },
    ConversationPermissions {
        scope: Scope,
    },
    ConversationAgent {
        scope: Scope,
    },
    Submit {
        command: Command,
    },
    Receipt {
        scope: Scope,
        id: Id,
    },
    Reconcile {
        scope: Scope,
        id: Id,
    },
    Watch {
        scope: Scope,
        #[serde(deserialize_with = "nullable")]
        after: Option<Count>,
        projection_version: Count,
    },
    Pull {
        feed_id: Id,
        #[serde(deserialize_with = "nullable")]
        ack: Option<Count>,
    },
    Close {
        feed_id: Id,
    },
}
fn js_space(character: char) -> bool {
    matches!(character, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' |
        '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn encoded_bytes(value: &impl Serialize) -> Result<usize, &'static str> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|_| INVALID)
}
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    de: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(de).map(Some)
}
pub fn image_operation(value: &Value) -> bool {
    matches!(value["op"].as_str(), Some("image-upload" | "image-read"))
}
fn image_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
            }
        })
}
fn image_name(value: &str) -> bool {
    value.len() <= 160
        && !value.trim_matches(js_space).is_empty()
        && !value.chars().any(char::is_control)
}
fn image_base64(value: &str, length: u64) -> bool {
    if length == 0
        || length > IMAGE_MAX_BYTES as u64
        || value.is_empty()
        || value.len() > 5_592_408
        || value.len() % 4 != 0
    {
        return false;
    }
    let padding = if value.ends_with("==") {
        2
    } else if value.ends_with('=') {
        1
    } else {
        0
    };
    let content = &value.as_bytes()[..value.len() - padding];
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if value.len() / 4 * 3 - padding != length as usize
        || !content.iter().all(|byte| alphabet.contains(byte))
    {
        return false;
    }
    let last = content
        .last()
        .and_then(|byte| alphabet.iter().position(|candidate| candidate == byte))
        .unwrap_or(0);
    (padding != 2 || last % 16 == 0) && (padding != 1 || last % 4 == 0)
}
pub fn request(value: Value, host_id: &str) -> Result<Value, &'static str> {
    if encoded_bytes(&value)?
        > if image_operation(&value) {
            IMAGE_TRANSFER_MAX_BYTES
        } else {
            MAX_REQUEST_BYTES
        }
        || !bounded_json(&value, 0, &mut 0)
    {
        return Err(INVALID);
    }
    let mut request: Request = serde_json::from_value(value).map_err(|_| INVALID)?;
    let scope = match &mut request {
        Request::ImageUpload {
            scope,
            upload_id,
            name,
            byte_length,
            base64,
        } => {
            if !image_id(upload_id) || !image_name(name) || !image_base64(base64, byte_length.0) {
                return Err(INVALID);
            }
            Some(scope)
        }
        Request::ImageRead {
            scope,
            image_id: id,
        } => {
            if !image_id(id) {
                return Err(INVALID);
            }
            Some(scope)
        }
        Request::Create { scope, .. }
        | Request::ConversationPermissions { scope }
        | Request::ConversationAgent { scope }
        | Request::FrontendBinding { scope, .. }
        | Request::ProviderObservation { scope, .. }
        | Request::Receipt { scope, .. }
        | Request::Reconcile { scope, .. } => Some(scope),
        Request::Watch {
            scope,
            projection_version,
            ..
        } => {
            if projection_version.0 == 0 {
                return Err(INVALID);
            }
            Some(scope)
        }
        Request::Submit { command } => {
            let valid = match &command.body {
                Body::RevokePermission { .. } => command.version.0 == 1,
                Body::Send {
                    text,
                    frontend,
                    image_id: id,
                } => match (command.version.0, frontend, id) {
                    (1, None, Some(id)) => image_id(id),
                    (1, None, None) => !text.is_empty(),
                    (2, Some(offer), None) => !text.is_empty() && offer.valid(),
                    _ => false,
                },
                Body::Approve {
                    pending_id,
                    choice_id,
                } => command.version.0 == 1 && !pending_id.is_empty() && !choice_id.is_empty(),
                Body::Cancel { run_id } => command.version.0 == 1 && !run_id.is_empty(),
            };
            if !valid || encoded_bytes(command)? > MAX_COMMAND_BYTES {
                return Err(INVALID);
            }
            Some(&mut command.scope)
        }
        Request::Catalog { limit, .. } => {
            if !(1..=100).contains(&limit.0) {
                return Err(INVALID);
            }
            None
        }
        Request::Search { query, .. } => {
            if query.encode_utf16().count() > 200 {
                return Err(INVALID);
            }
            *query = query
                .split(js_space)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if query.is_empty() {
                return Err(INVALID);
            }
            None
        }
        Request::Metadata {} | Request::Pull { .. } | Request::Close { .. } => None,
    };
    if scope.is_some_and(|scope| scope.host_id.0 != host_id) {
        return Err("Conversation belongs to another host");
    }
    serde_json::to_value(request).map_err(|_| INVALID)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageAttachment {
    image_id: String,
    name: String,
    media_type: String,
    byte_length: Count,
    width: Count,
    height: Count,
}
pub fn image_response(request: &Value, response: &Value) -> bool {
    if response["ok"] != true {
        return true;
    }
    let value = &response["value"];
    let Ok(attachment) = serde_json::from_value::<ImageAttachment>(value["attachment"].clone())
    else {
        return false;
    };
    let w = attachment.width.0;
    let h = attachment.height.0;
    if value["scope"] != request["scope"]
        || !image_id(&attachment.image_id)
        || !image_name(&attachment.name)
        || !matches!(attachment.media_type.as_str(), "image/png" | "image/jpeg")
        || attachment.byte_length.0 == 0
        || attachment.byte_length.0 > IMAGE_MAX_BYTES as u64
        || w == 0
        || h == 0
        || w > 8192
        || h > 8192
        || w * h > 16_000_000
    {
        return false;
    }
    if request["op"] == "image-read" {
        attachment.image_id == request["imageId"]
            && value["base64"]
                .as_str()
                .is_some_and(|body| image_base64(body, attachment.byte_length.0))
    } else {
        attachment.name == request["name"] && attachment.byte_length.0 == request["byteLength"]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope() -> Value {
        json!({"hostId":"host", "conversationId":"conversation"})
    }
    fn command(body: Value) -> Value {
        json!({"op":"submit", "command":{"version":1, "scope":scope(), "clientCommandId":"command", "body":body}})
    }
    fn valid(value: Value) {
        assert_eq!(request(value.clone(), "host").unwrap(), value);
        let mut extra = value;
        extra["headers"] = json!({"Authorization":"untrusted"});
        invalid(extra);
    }
    fn invalid(value: Value) {
        assert!(request(value.clone(), "host").is_err(), "accepted {value}");
    }

    #[test]
    fn frontend_wire_golden_cases_match_typescript() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/client/fixtures/frontend-sends.json"
        ))
        .unwrap();
        for case in cases {
            let input = case["request"].clone();
            let result = request(input.clone(), "host");
            assert_eq!(
                result.is_ok(),
                case["accepted"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            if let Ok(output) = result {
                assert_eq!(output, input, "{}", case["name"]);
            }
        }
    }

    #[test]
    fn every_service_operation_and_command_body_round_trips() {
        for value in [
            json!({"op":"metadata"}),
            json!({"op":"catalog", "after":null, "limit":100}),
            json!({"op":"catalog", "after":"cursor", "limit":1}),
            json!({"op":"search", "query":"find text", "after":null}),
            json!({"op":"search", "query":"find text", "after":"cursor"}),
            json!({"op":"create", "scope":scope(), "agentId":"agent"}),
            json!({"op":"conversation-permissions", "scope":scope()}),
            command(
                json!({"kind":"revoke-permission", "permissionId":"p", "scope":"conversation"}),
            ),
            command(json!({"kind":"revoke-permission", "permissionId":"p", "scope":"agent"})),
            json!({"op":"conversation-agent", "scope":scope()}),
            json!({"op":"provider-observation", "scope":scope(), "action":"read"}),
            json!({"op":"provider-observation", "scope":scope(), "action":"retry"}),
            command(json!({"kind":"send", "text":"Hello"})),
            command(json!({"kind":"approve", "pendingId":"pending", "choiceId":"yes"})),
            command(json!({"kind":"cancel", "runId":"run"})),
            json!({"op":"receipt", "scope":scope(), "id":"command"}),
            json!({"op":"reconcile", "scope":scope(), "id":"command"}),
            json!({"op":"watch", "scope":scope(), "after":null, "projectionVersion":1}),
            json!({"op":"watch", "scope":scope(), "after":0, "projectionVersion":2}),
            json!({"op":"pull", "feedId":"feed", "ack":null}),
            json!({"op":"pull", "feedId":"feed", "ack":9_007_199_254_740_991_u64}),
            json!({"op":"close", "feedId":"feed"}),
        ] {
            valid(value);
        }
    }

    #[test]
    fn unknown_transport_and_nested_fields_are_rejected() {
        for extra in [
            "url",
            "headers",
            "credential",
            "secret",
            "destination",
            "token",
        ] {
            let mut value = json!({"op":"metadata"});
            value[extra] = json!("untrusted");
            invalid(value);
        }
        for field in ["scope", "command", "body"] {
            let mut value = command(json!({"kind":"send", "text":"Hello"}));
            let target = match field {
                "scope" => &mut value["command"]["scope"],
                "command" => &mut value["command"],
                _ => &mut value["command"]["body"],
            };
            target["headers"] = json!({"Authorization":"untrusted"});
            invalid(value);
        }
        for body in [
            json!({"kind":"revoke-permission", "permissionId":"p", "scope":"member"}),
            json!({"kind":"revoke-permission", "permissionId":"p", "scope":"conversation", "runId":"r"}),
            json!({"kind":"approve", "pendingId":"p", "choiceId":"c", "runId":"r"}),
            json!({"kind":"cancel", "runId":"r", "text":"x"}),
            json!({"kind":"send", "text":"x", "pendingId":"p"}),
        ] {
            invalid(command(body));
        }
        for value in [
            json!({"op":"pair", "code":"code"}),
            json!({"op":"fetch"}),
            json!({"op":"conversationAgent", "scope":scope()}),
            json!({"op":"create", "scope":scope()}),
            json!({"op":"create", "scope":scope(), "agent_id":"agent"}),
            json!({"op":"watch", "scope":scope(), "after":null, "projection_version":1}),
            json!(null),
            json!([]),
            json!("metadata"),
        ] {
            invalid(value);
        }
    }

    #[test]
    fn nullable_fields_are_required_and_correctly_typed() {
        for value in [
            json!({"op":"catalog", "limit":1}),
            json!({"op":"search", "query":"text"}),
            json!({"op":"watch", "scope":scope(), "projectionVersion":1}),
            json!({"op":"pull", "feedId":"feed"}),
            json!({"op":"catalog", "after":false, "limit":1}),
            json!({"op":"search", "query":"text", "after":1}),
            json!({"op":"watch", "scope":scope(), "after":"1", "projectionVersion":1}),
            json!({"op":"pull", "feedId":"feed", "ack":"1"}),
        ] {
            invalid(value);
        }
    }

    #[test]
    fn scopes_cannot_target_another_host() {
        let foreign = json!({"hostId":"other-host", "conversationId":"conversation"});
        for op in [
            "create",
            "conversation-permissions",
            "conversation-agent",
            "receipt",
            "reconcile",
            "watch",
        ] {
            let mut value = json!({"op":op, "scope":foreign});
            match op {
                "create" => value["agentId"] = json!("agent"),
                "receipt" | "reconcile" => value["id"] = json!("command"),
                "watch" => {
                    value["after"] = Value::Null;
                    value["projectionVersion"] = json!(1);
                }
                _ => {}
            }
            invalid(value);
        }
        let mut value = command(json!({"kind":"send", "text":"Hello"}));
        value["command"]["scope"] = foreign;
        invalid(value);
    }

    #[test]
    fn local_identifiers_count_utf16_units() {
        valid(json!({"op":"create", "scope":scope(), "agentId":"😀".repeat(512)}));
        for id in [String::new(), "x".repeat(1025), "😀".repeat(513)] {
            for field in ["hostId", "conversationId"] {
                let mut value = json!({"op":"conversation-agent", "scope":scope()});
                value["scope"][field] = json!(id);
                invalid(value);
            }
            invalid(json!({"op":"create", "scope":scope(), "agentId":id}));
            invalid(json!({"op":"catalog", "after":id, "limit":1}));
            invalid(json!({"op":"search", "query":"query", "after":id}));
            invalid(json!({"op":"receipt", "scope":scope(), "id":id}));
            invalid(json!({"op":"close", "feedId":id}));
            let mut value = command(json!({"kind":"send", "text":"x"}));
            value["command"]["clientCommandId"] = json!(id);
            invalid(value);
        }
    }

    #[test]
    fn safe_integer_and_version_constraints_match_javascript() {
        for number in [
            json!(-1),
            json!(0.5),
            json!(9_007_199_254_740_992_u64),
            json!("1"),
        ] {
            invalid(json!({"op":"pull", "feedId":"feed", "ack":number.clone()}));
            invalid(json!({"op":"catalog", "after":null, "limit":number.clone()}));
            invalid(
                json!({"op":"watch", "scope":scope(), "after":null, "projectionVersion":number}),
            );
        }
        invalid(json!({"op":"catalog", "after":null, "limit":null}));
        invalid(json!({"op":"watch", "scope":scope(), "after":null, "projectionVersion":null}));
        for number in [0, 101] {
            invalid(json!({"op":"catalog", "after":null, "limit":number}));
        }
        invalid(json!({"op":"watch", "scope":scope(), "after":null, "projectionVersion":0}));
        for version in [0, 2] {
            let mut value = command(json!({"kind":"send", "text":"x"}));
            value["command"]["version"] = json!(version);
            invalid(value);
        }
        assert_eq!(
            request(json!({"op":"pull", "feedId":"feed", "ack":1.0}), "host").unwrap()["ack"],
            json!(1)
        );
        let mut value = command(json!({"kind":"send", "text":"x"}));
        value["command"]["version"] = json!(1.0);
        assert_eq!(
            request(value, "host").unwrap()["command"]["version"],
            json!(1)
        );
    }

    #[test]
    fn search_uses_javascript_whitespace_and_original_length_limit() {
        let query = json!({"op":"search", "query":"\u{feff}  hello\n\tworld\u{a0}", "after":null});
        assert_eq!(
            request(query, "host").unwrap()["query"],
            json!("hello world")
        );
        valid(json!({"op":"search", "query":"\u{85}", "after":null}));
        valid(json!({"op":"search", "query":"😀".repeat(100), "after":null}));
        for query in [
            String::new(),
            " \n\u{feff}".to_owned(),
            "x".repeat(201),
            "😀".repeat(101),
            format!("{}x", " ".repeat(200)),
        ] {
            invalid(json!({"op":"search", "query":query, "after":null}));
        }
    }

    #[test]
    fn command_budgets_include_json_encoding_and_provider_ids_remain_nonempty() {
        let base = command(json!({"kind":"send", "text":"x"}));
        let overhead = serde_json::to_vec(&base["command"]).unwrap().len() - 1;
        valid(command(
            json!({"kind":"send", "text":"x".repeat(MAX_COMMAND_BYTES - overhead)}),
        ));
        invalid(command(
            json!({"kind":"send", "text":"x".repeat(MAX_COMMAND_BYTES - overhead + 1)}),
        ));
        invalid(command(
            json!({"kind":"send", "text":"\u{0001}".repeat(11_000)}),
        ));
        invalid(command(json!({"kind":"send", "text":"😀".repeat(16_000)})));
        valid(command(
            json!({"kind":"approve", "pendingId":"p".repeat(1025), "choiceId":"c".repeat(1025)}),
        ));
        valid(command(json!({"kind":"cancel", "runId":"r".repeat(1025)})));
        for body in [
            json!({"kind":"revoke-permission", "permissionId":"", "scope":"agent"}),
            json!({"kind":"revoke-permission", "permissionId":"p".repeat(1025), "scope":"conversation"}),
            json!({"kind":"send", "text":""}),
            json!({"kind":"send", "text":1}),
            json!({"kind":"cancel", "runId":""}),
            json!({"kind":"approve", "pendingId":"", "choiceId":"yes"}),
            json!({"kind":"approve", "pendingId":"p", "choiceId":""}),
        ] {
            invalid(command(body));
        }
    }

    #[test]
    fn observation_is_scoped_and_accepts_only_read_or_retry() {
        for action in [json!("restart"), json!(null), json!(1)] {
            invalid(json!({"op":"provider-observation", "scope":scope(), "action":action}));
        }
        invalid(json!({"op":"provider-observation", "scope":scope()}));
        invalid(
            json!({"op":"provider-observation", "scope":scope(), "action":"retry", "binding":{}}),
        );
        assert!(request(
            json!({"op":"provider-observation", "scope":scope(), "action":"read"}),
            "foreign"
        )
        .is_err());
    }

    #[test]
    fn images_have_scoped_bounded_canonical_transport() {
        let upload = json!({"op":"image-upload", "scope":scope(), "uploadId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "name":"Screenshot.png", "byteLength":1, "base64":"AA=="});
        valid(upload.clone());
        valid(
            json!({"op":"image-read", "scope":scope(), "imageId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}),
        );
        for (field, value) in [
            ("uploadId", json!("../file")),
            ("uploadId", json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")),
            ("name", json!("x".repeat(161))),
            ("name", json!("x\n")),
            ("name", json!(" ")),
            ("base64", json!("AB==")),
            ("base64", json!("AA==\n")),
            ("base64", json!("-A==")),
            ("base64", json!("A".repeat(5_592_412))),
            ("byteLength", json!(2)),
            ("byteLength", json!(IMAGE_MAX_BYTES + 1)),
            ("uploader", json!("forged")),
        ] {
            let mut value_to_check = upload.clone();
            value_to_check[field] = value;
            invalid(value_to_check);
        }
        assert!(request(upload.clone(), "other-host").is_err());
        let mut large = upload;
        large["byteLength"] = json!(IMAGE_MAX_BYTES);
        large["base64"] = json!("A".repeat(5_592_406) + "==");
        assert!(request(large, "host").is_ok());
        invalid(command(json!({"kind":"send", "text":"x", "image":{}})));
    }

    #[test]
    fn send_carries_an_optional_image_reference() {
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        for body in [
            json!({"kind":"send", "text":"x"}),
            json!({"kind":"send", "text":"x", "imageId":id}),
            json!({"kind":"send", "text":"", "imageId":id}),
        ] {
            let value = command(body);
            assert_eq!(
                serde_json::to_string(&request(value.clone(), "host").unwrap()).unwrap(),
                serde_json::to_string(&value).unwrap()
            );
            valid(value);
        }
        for body in [
            json!({"kind":"send", "text":""}),
            json!({"kind":"send", "text":"x", "imageId":null}),
            json!({"kind":"send", "text":"x", "imageId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"}),
            json!({"kind":"send", "text":"x", "imageId":"../image"}),
            json!({"kind":"send", "imageId":id}),
        ] {
            invalid(command(body));
        }
    }

    #[test]
    fn image_responses_match_identity_and_metadata_before_crossing_the_broker() {
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let request = json!({"op":"image-read", "scope":scope(), "imageId":id});
        let response = json!({"ok":true, "value":{"scope":scope(), "attachment":{"imageId":id, "name":"Screen", "mediaType":"image/png", "byteLength":1, "width":1, "height":1}, "base64":"AA=="}});
        assert!(image_response(&request, &response));
        for (field, value) in [
            ("imageId", json!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")),
            ("name", json!("x".repeat(161))),
            ("width", json!(8193)),
            ("height", json!(0)),
            ("mediaType", json!("image/gif")),
            ("byteLength", json!(2)),
        ] {
            let mut invalid = response.clone();
            invalid["value"]["attachment"][field] = value;
            assert!(!image_response(&request, &invalid));
        }
        for (field, value) in [
            (
                "scope",
                json!({"hostId":"other", "conversationId":"conversation"}),
            ),
            ("base64", json!("AB==")),
        ] {
            let mut invalid = response.clone();
            invalid["value"][field] = value;
            assert!(!image_response(&request, &invalid));
        }
        let upload = json!({"op":"image-upload", "scope":scope(), "name":"Screen", "byteLength":1});
        assert!(image_response(&upload, &response));
        assert!(!image_response(
            &json!({"op":"image-upload", "scope":scope(), "name":"Different", "byteLength":1}),
            &response
        ));
    }

    #[test]
    fn image_unsupported_failure_is_forwarded_to_the_typed_client_parser() {
        let request = json!({"op":"image-upload", "scope":scope(), "name":"Screen", "byteLength":1});
        let response = json!({"ok":false, "error":{"kind":"image-unsupported", "message":"This model cannot read images."}});
        assert!(image_response(&request, &response));
    }
}
