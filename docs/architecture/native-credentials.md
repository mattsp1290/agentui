# Native connection

The stock Mac app reaches a host on the same machine through Rust-owned transport. The standard `./agentui` launcher instead opens the host-served client over loopback or an SSH tunnel; see [launcher setup](../development/launcher.md). This document describes the native entry only.

AgentUI serves one owner on a private network, so the native client holds no credential. The host admits every request on its native loopback endpoint as the fixed owner principal. The only protected secrets in the app are provider keys, covered at the end.

## Transport

Normal installed launch uses bundled app assets and Rust-owned transport to `http://127.0.0.1:7140`. Start the local host first. JavaScript never chooses the destination, headers, or cookies.

Rust sends `POST /native/v1` and, for images, `POST /native/v1/images`. Each request carries exactly one Host value, `127.0.0.1:<port>`, and exactly `Content-Type: application/json`. It sends no Authorization, Cookie, or Origin header. The host replies with `Cache-Control: no-store` and no CORS permission. The wire rules are in the [recorded host guide](../development/recorded-host.md#native-protocol-prerequisite).

Transport limits:

- Requests follow the wire size rules. Responses are bounded at 4.1 MB, and image transfers at 6 MiB.
- Redirects are refused.
- Each request has a 20-second deadline and is never retried.
- Failures return fixed safe errors.

## Connect and execute

The app exposes two native commands.

**`connect`** posts `{op:"metadata"}` to `/native/v1` with no credential. The reply gives the host ID. Rust binds it for the app session in memory only. Nothing is written to disk and the Keychain is not used. `connect` returns only an opaque observation token. Connecting again to the same host keeps the current observation. Connecting to a different host creates a new observation and the earlier one becomes stale.

After upgrading the app, restart the host. A host from before this change still requires a device credential and answers the new app with HTTP 401, which the app reports as `network-failed` ("check that the host is running").

**`execute`** takes the current observation and a service request. Rust checks the request's scopes against the bound host ID before sending. After an image reply it checks the observation again.

Rust detects a host replaced mid-session, for example one restarted with another data directory on the same port, in two ways. A metadata reply that reports a different host ID than the bound one is the first. The second is a scoped request refused with 403 `forbidden`: the new host refuses scopes that belong to the old one, so Rust then sends a metadata request and compares its host ID. In either case, when the host IDs differ, Rust drops the binding and fails with `host-changed`. The app reports this as a lost connection: it disables its controls and keeps local work until the user selects **Reconnect**. The app never rebinds on its own.

Errors are `profile-in-use`, `profile-unavailable`, `network-failed`, `stale`, `host-changed`, `invalid-input`, and `forbidden`. A per-profile lock file in the app data directory excludes a second AgentUI copy using the same profile, which reports `profile-in-use`.

## Interface

The connection UI has no access setup: it is either connecting, connected, or offline with a fixed error and a **Reconnect** button. Until the first connection succeeds, a **Connect this Mac** screen shows the error and a **Reconnect** button. After that the normal app opens. **Settings** also offers **Reconnect**. **Reconnect** opens a new connection session after local storage drains and never resubmits an effectful command. The chat UI keeps saved-history search, agent selection, streaming, approvals, Stop, drafts, and original-command recovery. A stable `native-mac-default` view retains the saved route, drafts, outbox, and pending creation across same-build restarts.

Only the bundled local main document can call the native commands. External navigation and new windows are denied in normal native mode. `--host-url` remains an explicit browser development route with no native command authority.

The Rust implementation is in `apps/desktop/src-tauri/src/native.rs`. The JavaScript client is `packages/client/src/mac.ts`, and the connection UI is `apps/desktop/src/application/NativeApplication.tsx`.

## Provider keys

The macOS Keychain is used only for Pi and OpenCode Go provider key setup. See [secure bootstrap](secure-bootstrap.md). Earlier builds stored a host access record under the Keychain service `homes.birb.agentui.native.v1`. Current builds never read it. Delete that item in Keychain Access if it is present.

Provider keys never enter JavaScript, browser storage, URLs, preferences, logs, or customization Git.
