# Connected customization repository

AgentUI can connect one git repository that holds customization, extensions and settings. The repository holds a [customization package](sources.md) and, beside it, an optional `agentui-settings.json`. [`examples/customization`](../../examples/customization/README.md) is a working example.

## Who does what

- The **host** relays. Wire version 17 adds eight client operations (`customization-status`, `-connect`, `-disconnect`, `-sync`, `-toggle`, `-settings`, `-rebuild`, `-apply`) and two worker operations (`customization-worker-pull`, `customization-worker-push`). A client mutation is queued and answered at once with `accepted` or `refused` (`unsupported`, `busy`, `draining`, `invalid-request`, `not-ready`, `missing-token`, `active-work`); its outcome arrives later in `customization-status` `results` under the client's `requestId`. The host holds at most one pending mutation, keeps the last 32 results, ends a mutation that gets no result within 180 seconds with `worker-timeout`, and reports `worker-offline` when no worker call arrived in the last 30 seconds. It never interprets a location, runs git or starts a build. Its state is in memory; after a restart the worker pushes its full status again. Worker operations use their own HTTP route, `/api/v1/worker`, because a worker status may be up to 1,000,000 bytes; the native (Tauri) allowlist carries only the client operations.
- The **worker** runs inside the launcher on the launcher machine, for local and SSH sessions alike. It owns the clone, every git write and every build.

## The worker

The launcher starts the worker after the host is ready, for local and SSH sessions alike, and stops it when the session ends. Its store is `~/.local/share/agentui/customization/` on the launcher machine (mode 0700), shared by every launcher profile, so a connection is the same in every workspace and agent:

- `connection.json`: `{ "version": 1, "location", "branch", "subdirectory" }`. A malformed file makes every mutation fail with `state-invalid`; the worker does not repair it.
- `clone/`: the worker's clone of the connected branch.
- `lock/`: the store lock, held only for a git or state mutation. Its `owner.json` records the process, its start time, the host name, the session and a heartbeat the owner rewrites every 5 seconds. Another worker waits up to 30 seconds, then reports `busy`. A lock is taken over only when its owner is provably dead: same host name and no process with that ID and start time, or a heartbeat older than 60 seconds.
- `git.log`: the last 16 KiB of the most recent failed git command's output. Git output never reaches the host or a client.

Requests:

- **Connect** validates the location (no relative local path, no embedded credentials), the branch (`git check-ref-format --branch`) and the subdirectory, clones the branch, and parses the package and settings at HEAD. A failure removes the clone and reports `invalid-location`, `clone-failed`, `invalid-package` or `invalid-settings`.
- **Toggle** syncs, refuses with `conflict` when the head moved since the client read it, changes only that reference's `enabled` value in place (the file is never re-serialized; a layout it cannot change safely reports `unsupported-format`), commits `Enable <key> extension` or `Disable <key> extension` with the body `Changed by AgentUI.`, and pushes. A reference key is its subdirectory, or `<repository>#<subdirectory or .>` for a remote reference.
- **Settings** syncs, writes `agentui-settings.json` with the stable serializer, commits `Update AgentUI settings`, and pushes. Settings are not a build input.
- **Sync** fast-forwards the clone; **Disconnect** removes `connection.json` and the clone.

Every git command runs with a fixed argument list and no shell, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, hooks disabled (`core.hooksPath=/dev/null`), `user.useConfigOnly=true` (a missing identity reports `identity-missing`) and a 120-second deadline. Commit signing follows your git configuration; a signing prompt that blocks ends in `git-timeout`. The worker never force-pushes. A rejected push reports `push-rejected`, an authentication failure `push-unauthorized`, and the clone is reset to the remote branch. Git uses the launcher user's ambient SSH agent and credential helpers.

## Trust

AgentUI runs for one user on a private NetBird or Tailscale network, and that overlay network is the trust boundary (see `AGENTS.md`). Any client on the overlay network can queue a request that makes the launcher machine clone, commit, push and build, and any caller that reaches the host can act as the worker. This matches what clients can already do: they run agents with shell access on the host. Tokens never go into the repository, a wire reply, a state file or a log; the wire carries token variable names only.
