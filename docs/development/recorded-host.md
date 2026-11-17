# Recorded host development

This entry runs the desktop React shell against a separate persistent Node host. It uses recorded playback, requires no model account, and supports conversation creation, progressive output, decisions, and recovery. The host keeps running when every browser window closes.

Use the pinned Node and npm versions. From the repository root:

```sh
npm ci
npm run setup:browser
npm run build
npm run host:browser-dev -- --data-dir /absolute/private/agentui-host
```

The command creates a private data directory if it does not exist. An existing directory must belong to the current user and have mode `0700`. Keep this directory across restarts. It contains the host identity, access records, conversation database, and recorded acceptance evidence. A second process cannot own it while the first process is running or draining accepted work.

The listener prints its address and host ID. Open that address in a browser supporting IndexedDB and Web Locks. The browser reaches the host directly as its single owner.

Select **New recorded conversation**. In a second browser profile, open the same address, select **Reconnect** to refresh the catalog, then open that conversation. Each view owns its draft and saved commands independently. Copied tabs receive separate ownership. After closing a view, use **Reopen saved view** to recover its route, draft, and unresolved commands. A view that is still open cannot be claimed by another tab.

## Recovery

**Reconnect** observes the host without creating a conversation or sending a command. A live store resumes from its last applied cursor when the gap fits the host budget. A cold reopen or invalid feed obtains a snapshot. Pending decisions and unresolved receipts remain authoritative even when visible replay is bounded.

**Recover creation** repeats the saved conversation ID. **Retry original command** repeats the saved command and ID. Neither allocates a replacement operation. **Reconcile command** looks up recorded evidence, then refreshes the saved receipt without dispatching. A newer unsent draft survives settlement of an older command.

The receipt refresh deliberately uses the shared store's read and durable-settlement path. A missing receipt does not prove an earlier request cannot still arrive. Unknown commands retain their original body and ID even when a later retry is refused. They do not prevent editing or sending a new draft.

Recorded cancellation is unavailable. Closing a browser or aborting an HTTP request does not cancel admitted work. Stop the host with Ctrl+C. Graceful shutdown retains ownership until accepted work settles and SQLite closes. After a killed process, start the host with the same directory and address, reconnect, and explicitly reconcile any unfinished receipt.

Conversation and saved-view lists load one page at a time through **More conversations** and **More saved views**.

Access records and conversations share the existing host database. The application owns the versioned `service_*` namespace; the durable host owns its conversation schema. Startup checks that their host identities agree. Keeping that existing boundary preserves conversations across upgrades without copying authority into another database.

The access schema is at version 2. Opening a version 1 database drops its `service_devices` table and keeps the host ID and provider credentials. The upgrade is one-way: an older host refuses a version 2 database. To roll back, restore a copy of `host.sqlite` taken before the upgrade.

## Development boundary and build identity

This listener binds to loopback and serves only the recorded backend. It admits every request that reaches it as the single owner, with no cookie or Authorization check. Access control is the network boundary, loopback or a private overlay, plus the Host, Origin and content-type checks on each request. Use this entry for local recorded development; it is not a packaged native adapter or a remote host deployment. Provider secrets do not belong in customization Git or URLs.

The absolute data-directory path plus `/control.sock` must fit within 103 UTF-8 bytes for the local control socket. Choose a shorter private directory if startup reports that limit.

HTTP/1.1 browsers share a small connection pool across tabs on one origin. Long polls return within two seconds to leave room for commands; opening many simultaneous views can still delay requests.

Production Tauri keeps its network-denying CSP and disconnected entry. The [native connection](../architecture/native-credentials.md) document describes the Mac app's transport. Browser results do not qualify a packaged macOS or iOS application.

Builds emit `artifact.json` for the executed host bundle and browser assets. The host bundle includes its contracts, durable host, and Switchboard dependencies, with only Node builtin imports remaining. Startup verifies both installed file sets and their hashes before listening. Manifests distinguish the applied source revision, local source changes, dependency lock, artifact bytes, and runtime. The browser shows its own artifact identity. These checks establish artifact consistency; they are not release signatures or Apple qualification.

The browser build is in `apps/desktop/web-dist-browser`; Tauri packages its separate `web-dist` output. A running host serves its verified browser bytes from memory. Rebuilding does not change those served bytes. Restart the host to apply a new browser build.

Run `npm run verify` for the repository gates. Application tests launch the actual bundled host and built desktop browser entry, covering independent drafts, progressive output, one decision winner, dropped replies, saved-view recovery, incompatible metadata, and host restart.

## Native protocol prerequisite

The same development listener accepts native-class requests only at literal `http://127.0.0.1:<port>`. `POST /native/v1` accepts the existing closed service requests and `POST /native/v1/images` carries image transfers. Both admit every request as the single owner. There is no pairing route, and the `Authorization` header is ignored.

Both routes require exactly one Host header, `127.0.0.1:<port>`, and exactly `Content-Type: application/json` with no parameters. They reject Origin and Cookie headers, return no CORS permission, and use `Cache-Control: no-store`. A native client learns the host ID and principal ID from a credential-free `{op:"metadata"}` request, as the [native connection](../architecture/native-credentials.md) document describes.

The shared connection engine takes a `ServiceExecutor` that returns a fetch `Response`. The engine owns bounded JSON and UTF-8 decoding, HTTP status classification, envelope validation, and observation resynchronization. The engine serializes and bounds each request once, then passes its validated body to the browser or private test executor.

The application test runs separate client processes against the same connection engine as the browser. It proves protocol metadata and observation, client-exit recovery, and one outcome for the original command ID. It is not a production native adapter. This prerequisite does not qualify native IPC, installed macOS or iOS apps, TLS, LAN access, or remote phone access. Loopback host IDs identify a host; they are not cryptographic server authentication.
