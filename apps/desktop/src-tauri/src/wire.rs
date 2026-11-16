use serde::{Deserialize, Serialize};
use serde_json::Value;

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
pub fn request(value: Value, host_id: &str) -> Result<Value, &'static str> {
    if encoded_bytes(&value)? > MAX_REQUEST_BYTES {
        return Err(INVALID);
    }
    let mut request: Request = serde_json::from_value(value).map_err(|_| INVALID)?;
    let scope = match &mut request {
        Request::Create { scope, .. }
        | Request::ConversationPermissions { scope }
        | Request::ConversationAgent { scope }
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
                Body::RevokePermission { .. } => true,
                Body::Send { text } => !text.is_empty(),
                Body::Approve {
                    pending_id,
                    choice_id,
                } => !pending_id.is_empty() && !choice_id.is_empty(),
                Body::Cancel { run_id } => !run_id.is_empty(),
            };
            if command.version.0 != 1 || !valid || encoded_bytes(command)? > MAX_COMMAND_BYTES {
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
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invitation {
    version: Count,
    pub host_id: String,
    pub code: String,
}
pub fn invitation(value: Value) -> Result<Invitation, &'static str> {
    if encoded_bytes(&value)? > 4096 {
        return Err(INVALID);
    }
    let invitation: Invitation = serde_json::from_value(value).map_err(|_| INVALID)?;
    Id::try_from(invitation.host_id.clone())?;
    if invitation.version.0 != 1
        || invitation.code.len() != 32
        || !invitation
            .code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(INVALID);
    }
    Ok(invitation)
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
    fn every_service_operation_and_command_body_round_trips() {
        for value in [
            json!({"op":"metadata"}),
            json!({"op":"catalog", "after":null, "limit":100}),
            json!({"op":"catalog", "after":"cursor", "limit":1}),
            json!({"op":"search", "query":"find text", "after":null}),
            json!({"op":"search", "query":"find text", "after":"cursor"}),
            json!({"op":"create", "scope":scope(), "agentId":"agent"}),
            json!({"op":"conversation-permissions", "scope":scope()}),
            command(json!({"kind":"revoke-permission", "permissionId":"p", "scope":"conversation"})),
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
        invalid(json!({"op":"provider-observation", "scope":scope(), "action":"retry", "binding":{}}));
        assert!(request(json!({"op":"provider-observation", "scope":scope(), "action":"read"}), "foreign").is_err());
    }

    #[test]
    fn invitation_has_exact_version_host_and_base64url_code() {
        let good = json!({"version":1, "hostId":"host", "code":"aA0_-".repeat(6) + "aa"});
        let parsed = invitation(good.clone()).unwrap();
        assert_eq!(parsed.host_id, "host");
        assert_eq!(parsed.code.len(), 32);
        for (field, value) in [
            ("version", json!(0)),
            ("version", json!(2)),
            ("hostId", json!("")),
            ("hostId", json!("😀".repeat(513))),
            ("code", json!("a".repeat(31))),
            ("code", json!("a".repeat(33))),
            ("code", json!(format!("{}+", "a".repeat(31)))),
            ("code", json!("😀".repeat(8))),
            ("secret", json!("x")),
        ] {
            let mut value_to_check = good.clone();
            value_to_check[field] = value;
            assert!(invitation(value_to_check).is_err());
        }
        for field in ["version", "hostId", "code"] {
            let mut value = good.clone();
            value.as_object_mut().unwrap().remove(field);
            assert!(invitation(value).is_err());
        }
    }
}
