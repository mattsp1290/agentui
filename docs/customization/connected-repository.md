# Connected customization repository

AgentUI can connect one git repository that holds customization, extensions and settings. The repository holds a [customization package](sources.md) and, beside it, an optional `agentui-settings.json`. [`examples/customization`](../../examples/customization/README.md) is a working example.

## Who does what

- The **host** relays. Wire version 17 adds eight client operations (`customization-status`, `-connect`, `-disconnect`, `-sync`, `-toggle`, `-settings`, `-rebuild`, `-apply`) and two worker operations (`customization-worker-pull`, `customization-worker-push`). A client mutation is queued and answered at once with `accepted` or `refused` (`unsupported`, `busy`, `draining`, `invalid-request`, `not-ready`, `missing-token`, `active-work`); its outcome arrives later in `customization-status` `results` under the client's `requestId`. The host holds at most one pending mutation, keeps the last 32 results, ends a mutation that gets no result within 180 seconds with `worker-timeout`, and reports `worker-offline` when no worker call arrived in the last 30 seconds. It never interprets a location, runs git or starts a build. Its state is in memory; after a restart the worker pushes its full status again. Worker operations use their own HTTP route, `/api/v1/worker`, because a worker status may be up to 1,000,000 bytes; the native (Tauri) allowlist carries only the client operations.
- The **worker** runs inside the launcher on the launcher machine, for local and SSH sessions alike. It owns the clone, every git write and every build.

## Trust

AgentUI runs for one user on a private NetBird or Tailscale network, and that overlay network is the trust boundary (see `AGENTS.md`). Any client on the overlay network can queue a request that makes the launcher machine clone, commit, push and build, and any caller that reaches the host can act as the worker. This matches what clients can already do: they run agents with shell access on the host. Tokens never go into the repository, a wire reply, a state file or a log; the wire carries token variable names only.
