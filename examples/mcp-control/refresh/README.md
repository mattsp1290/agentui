# Installed refresh over MCP

This private example exposes one `agentui_refresh` tool over stdio on macOS and Linux. The installed host owns builds, durable receipts and desired selection. Run it on the host's machine with access to its private data directory.

Build the workspace, then configure an MCP client to launch the absolute Node executable with these arguments:

```text
/absolute/agentui/examples/mcp-control/refresh/dist/main.js
/absolute/installed-agentui/main.js
/absolute/private-host-data
30000
```

The final argument is an optional CLI wait in milliseconds, default 30000, range 100 through 300000. The installed entry and existing host directory must be absolute. The directory must belong to the current user and have no group/other permissions. Node, entry, directory and launch working directory are fixed at startup. Relative repository references resolve from that launch directory. The CLI alone validates and normalizes references, including both canonical 4096-byte request checks. Its raw source file has no separate byte cap.

Call the tool with one strict operation:

```json
{"operation":{"kind":"request","id":"original-request","reference":{"repository":"/repo","commit":"0123456789abcdef0123456789abcdef01234567"},"expectedSelectionRevision":0}}
```

The reference may also contain a repository-relative `subdirectory`. Status and promotion take the original ID only:

```json
{"operation":{"kind":"status","id":"original-request"}}
{"operation":{"kind":"promote","id":"original-request"}}
```

A new request builds committed source and automatically attempts desired selection. Identical replay and status only inspect. Changed input with the same ID is refused by the host. Explicit promotion reuses the saved command and artifact pins. A selected receipt does not prove activation in any client.

Results contain one complete opaque canonical receipt in `structuredContent.receipt`, alongside `kind` and `requestId`. Build failures and captured promotion refusals are receipt data. Other nonzero CLI exits and adapter failures return an adapter error with the original ID. Human CLI stderr is neither classified nor returned.

After a lost reply, retain the original ID and inspect it. Disconnect, cancellation and timeout end only the adapter's CLI wait. Trusted host work may continue. Never infer that an adapter error means no effects occurred.

Three concurrent CLI waits are admitted immediately; further calls receive `busy`. CLI stdout allows the host's 16 MiB receipt plus its envelope, stderr allows 64 KiB, MCP input allows 64 KiB, and each serialized tool response allows 8 MiB including the actual RPC ID. Receipts that exceed the MCP allowance return a small original-ID error. Recover with the direct installed CLI `extensions-refresh-status --data-dir /absolute/private-host-data --request original-request`. Another MCP call cannot enlarge the allowance; there is no automatic replay or truncation.

Each wait has an exclusive private source file when needed, fixed arguments, no shell and a minimal child environment that excludes inherited provider secrets. A private Node preload ends the CLI on owner EOF/error or its wait deadline. The child can remove only its handed-off source and empty directory. The parent waits for child close before fallback removal. Shutdown closes admission and transport, drains owned CLI groups and files, and exits nonzero if cleanup is unconfirmed. Simultaneous forced loss of both owners cannot guarantee source cleanup.

This example adds no public SDK export, host controller, cache, journal, retry, builder or selection owner. Broader conversation controls and native/iOS activation are outside its scope. The tests distinguish real SDK/copied installed CLI/canonical committed-source builds from synthetic transport and process faults. Root verification runs these tests in the existing Linux CI job.
