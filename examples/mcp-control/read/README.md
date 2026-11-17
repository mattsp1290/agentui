# Inspect an AgentUI host through MCP

This example gives an MCP client four read tools for a running AgentUI host. It reads recorded state without submitting commands or reconciling with a provider. It supports the repository's Node 24 runtime.

## Build and start

1. Run `npm ci` and `npm run build` at the repository root.
2. Start your AgentUI host with its usual configuration and note its loopback port.

## Connect an MCP client

Configure your MCP client to run the built executable with the `serve` command and the host's origin. For example, use this entry in a client that accepts an `mcpServers` configuration.

```json
{
  "mcpServers": {
    "agentui-read": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/agentui/examples/mcp-control/read/dist/main.js",
        "serve",
        "http://127.0.0.1:7140"
      ]
    }
  }
}
```

The origin must be exactly `http://127.0.0.1:<port>`, with no path, userinfo, query, or fragment. Redirects fail. You can point this origin at a local tunnel. Serve reads the host's metadata once before connecting stdio and exits with code 1 if the host is unreachable. Stdout contains only MCP messages. Fixed diagnostics use stderr.

## Host identity

On startup the adapter records the host ID from the host's metadata and pins it for the life of the process. Every tool call reads metadata again. If the host ID differs, for example because another host now answers on the same port, the call fails with "Host identity changed. Restart the MCP server to reconnect." and returns no data. Catalog and receipt results are also checked against the pinned host ID.

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

## Access

The host's native endpoint has no authentication. It treats any loopback caller as the owner on a private, single-user network. The adapter restricts its own operations to reads, but the endpoint itself accepts writes from any process that can reach it, including through a tunnel you point this origin at. To stop access, stop the MCP process or the host. Windows is outside this example's supported runtime.
