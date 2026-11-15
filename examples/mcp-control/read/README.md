# Inspect an AgentUI host through MCP

This example gives an MCP client four read tools for an existing authenticated AgentUI host. It reads recorded state without submitting commands or reconciling with a provider. It supports the repository's Node 24 runtime on macOS and Linux.

## Build and pair

1. Run `npm ci` and `npm run build` at the repository root.
2. Start your AgentUI host with its usual configuration. Keep its data directory and loopback origin available for the next command.
3. Create a private directory outside the checkout. Pairing requires an existing directory owned by your user with no group or other permissions.

   ```sh
   mkdir -m 700 "$HOME/.agentui-mcp"
   ```

4. Pipe the host's native invitation directly into the pairing command. Replace the host directory, checkout path, and port with your actual values.

   ```sh
   node /absolute/agentui/apps/host/dist/main.js invite-native \
     --data-dir /absolute/private/host-directory |
     node /absolute/agentui/examples/mcp-control/read/dist/main.js \
       pair http://127.0.0.1:7140 "$HOME/.agentui-mcp/access.json"
   ```

   Success exits with code 0 and prints nothing. The command creates a new profile with mode `0600`. It refuses to overwrite an existing file. The invitation and credential never appear in shell arguments or stdout. Do not save the invitation in a checked-in file or enable shell tracing around secret handling.

Pairing sends one enrollment request. An interrupted or failed exchange can consume the invitation and leave a registered device without a saved profile. The helper never retries automatically. Inspect the host's devices, revoke the unwanted device if needed, and issue a new invitation before repeating setup.

## Connect an MCP client

Configure your MCP client to run the built executable with the `serve` command and the absolute profile path. For example, use this entry in a client that accepts an `mcpServers` configuration.

```json
{
  "mcpServers": {
    "agentui-read": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/agentui/examples/mcp-control/read/dist/main.js",
        "serve",
        "/absolute/private/agentui-mcp/access.json"
      ]
    }
  }
}
```

The configuration contains a file path, not the credential. There is no credential environment variable or secret flag. Serve validates the private file and the live host and principal identities before connecting stdio. It rejects symlink profiles, non-regular files, malformed or oversized profiles, loose permissions, and profiles inside the checkout. It makes no profile writes.

The native origin must be exactly `http://127.0.0.1:<port>`, with no path, userinfo, query, or fragment. Redirects fail. You can point this origin at a local tunnel. Every data tool checks live native authorization. Revoked or expired access returns an error without cached data. Stdout contains only MCP messages. Fixed diagnostics use stderr.

## Available reads

| Tool | Input | Result |
| --- | --- | --- |
| `agentui_agents` | `{}` | Advertised agents, commands, availability, and default agent ID. |
| `agentui_conversations` | Optional `after`, optional `limit` | Bounded catalog entries and the next `after` cursor. Follow until `after` is null. A full last page can require one empty follow-up page. |
| `agentui_inspect` | `conversationId` | Snapshot cursor, agent, current run, receipts, pending decisions, and command activities. |
| `agentui_receipt` | `conversationId`, `clientCommandId` | Original command receipt, or null. |

Advertised commands describe the host agent. They do not add MCP mutation tools or describe every provider capability. Inputs reject unknown fields. Tool output contains matching structured JSON and JSON text.

Inspection reports stored host knowledge at the returned cursor. It does not refresh provider state. An ended run can coexist with an uncertain command receipt. The adapter preserves the host's run and receipt variants, uncertainty reasons, original command IDs, and pending decision state. A null receipt is not proof that a command did not execute.

`currentRun` describes the current or latest projected run. It is not a historical run index. A snapshot includes unresolved receipts and the latest 128 terminal receipts. Use `agentui_receipt` with the original command ID to look up an older receipt. Inspection omits transcript messages and command output. Command activities retain their status and command details.

Each inspection opens one snapshot observation and closes it in a `finally` path with a fresh cleanup deadline. Four inspections can run concurrently. Tool calls have an eight-second overall deadline and five-second request deadlines. Cleanup gets one additional second. If the close fails or a watch reply is lost before the feed ID arrives, the host's idle sweep remains the fallback. Independent host background work can change recorded state while you inspect it.

## Protect and revoke access

The profile contains an owner-scoped native bearer credential. The adapter restricts its own operations to reads. The credential itself can authorize writes through another native client. Keep the private directory outside source control, protect backups, and do not copy the profile into MCP configuration or logs. Another process running as your user can read this file. This example does not use the desktop app's protected credential storage.

Use the existing host commands to list devices and revoke this profile's principal.

```sh
node /absolute/agentui/apps/host/dist/main.js devices \
  --data-dir /absolute/private/host-directory
node /absolute/agentui/apps/host/dist/main.js revoke \
  --data-dir /absolute/private/host-directory --id PRINCIPAL_ID
```

Deleting the local file does not revoke host access. Restart the MCP process with a newly paired profile after credential rotation. Windows is outside this example's supported runtime because POSIX permission bits do not establish Windows ACL protection.
