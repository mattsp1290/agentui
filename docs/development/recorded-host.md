# Recorded host development

This entry runs the desktop React shell against a separate persistent Node host. It uses recorded playback, requires no model account, and supports conversation creation, progressive output, decisions, and recovery. The host keeps running when every browser window closes.

Use the pinned Node and npm versions. From the repository root:

```sh
npm ci
npm run setup:browser
npm run build
npm run host:browser-dev -- --data-dir /absolute/private/agentui-host
```

The command creates a private data directory if it does not exist. An existing directory must belong to the current user and have mode `0700`. Keep this directory across restarts. It contains the host identity, device access records, conversation database, and recorded acceptance evidence. A second process cannot own it while the first process is running or draining accepted work.

The listener prints its address and host ID. Open that address in a browser supporting IndexedDB and Web Locks. In another terminal, create a pairing invitation:

```sh
npm run host:invite -- --data-dir /absolute/private/agentui-host
```

Enter the returned code in **Pairing code**, then select **Pair host**. Codes expire after five minutes and work once. If the pairing reply is lost, request a new code. Pairing does not retry automatically.

Select **New recorded conversation**. In a second browser profile, pair with another code, select **Reconnect** to refresh the catalog, then open that conversation. Each view owns its draft and saved commands independently. Copied tabs receive separate ownership. After closing a view, use **Reopen saved view** to recover its route, draft, and unresolved commands. A view that is still open cannot be claimed by another tab.

## Recovery

**Reconnect** observes the host without creating a conversation or sending a command. A live store resumes from its last applied cursor when the gap fits the host budget. A cold reopen or invalid feed obtains a snapshot. Pending decisions and unresolved receipts remain authoritative even when visible replay is bounded.

**Recover creation** repeats the saved conversation ID. **Retry original command** repeats the saved command and ID. Neither allocates a replacement operation. **Reconcile command** looks up recorded evidence, then refreshes the saved receipt without dispatching. A newer unsent draft survives settlement of an older command.

The receipt refresh deliberately uses the shared store's read and durable-settlement path. A missing receipt does not prove an earlier request cannot still arrive. Unknown commands retain their original body and ID even when a later retry is refused. They do not prevent editing or sending a new draft.

Recorded cancellation is unavailable. Closing a browser or aborting an HTTP request does not cancel admitted work. Stop the host with Ctrl+C. Graceful shutdown retains ownership until accepted work settles and SQLite closes. After a killed process, start the host with the same directory and address, reconnect, and explicitly reconcile any unfinished receipt.

To list and revoke paired devices:

```sh
npm run host:devices -- --data-dir /absolute/private/agentui-host
npm run host:revoke -- --data-dir /absolute/private/agentui-host --id DEVICE_ID
```

Device lists contain at most 100 entries. Continue with `host:devices -- --data-dir ... --after LAST_DEVICE_ID`. Revocation persists before success, closes that device's observations, and rejects later operations. It preserves local drafts and commands and does not undo an admitted effect.

Device lists show expiry and current activity. Expired rows remain as access history; pagination bounds each read without deleting that history. Conversation and saved-view lists also load one page at a time through **More conversations** and **More saved views**.

## Development boundary and build identity

This listener binds to loopback and serves only the recorded backend. Browser credentials use an HttpOnly, SameSite Strict cookie, expire after one hour, and belong to the browser development credential class. Cookies do not isolate loopback ports. Use this entry for local recorded development; it is not the native credential transport or a remote host deployment. Pairing codes, cookies, and provider secrets do not belong in customization Git or URLs.

HTTP/1.1 browsers share a small connection pool across tabs on one origin. Long polls return within two seconds to leave room for commands; opening many simultaneous views can still delay requests.

Production Tauri keeps its network-denying CSP and disconnected entry. Native desktop and iOS need their own protected credential storage and transport adapters. Browser results do not qualify a packaged macOS or iOS application.

Builds emit `artifact.json` for the executed host bundle and browser assets. The host bundle includes its contracts, durable host, and Switchboard dependencies, with only Node builtin imports remaining. Startup verifies both installed file sets and their hashes before listening. Manifests distinguish the applied source revision, local source changes, dependency lock, artifact bytes, and runtime. The browser shows its own artifact identity. These checks establish artifact consistency; they are not release signatures or Apple qualification.

The browser build is in `apps/desktop/web-dist-browser`; Tauri packages its separate `web-dist` output. A running host serves its verified browser bytes from memory. Rebuilding does not change those served bytes. Restart the host to apply a new browser build.

Run `npm run verify` for the repository gates. Application tests launch the actual bundled host and built desktop browser entry, covering independent drafts, progressive output, one decision winner, dropped replies, saved-view recovery, revocation, incompatible metadata, and host restart.
