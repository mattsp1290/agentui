# Pi text-chat integration

AgentUI uses the public `./pi` entrypoint of the commit-pinned Switchboard
package recorded in [the Pi pin](../../../vendor/switchboard-pi.json).
The host installs it through the local `@agentui/switchboard-pi` alias.
The historical core and AG-UI dependency pins remain separate.

This bounded route uses Pi SDK 1.5.2, provider `opencode-go`, and full model
`glm-5.3`. It provides text chat, streaming, follow-up, Stop and saved-session
reopening. It has no tools or approval requests. See the
[startup guide](../../development/pi-host.md).

## Ownership and evidence

Switchboard owns SDK initialization, credential injection, native journals,
strict reopening, one-writer reservations within the process, prompt admission,
stream normalization, cancellation and cleanup. Its native compiler project
isolates known upstream declaration defects. Public declarations expose no
native SDK types. AgentUI and Switchboard core keep strict checking.

AgentUI owns pairing, authorization, durable command admission, exact-command
retry behavior, transcript persistence, replay and crash recovery. It only
reopens session references saved for its own conversations. The private
reference pairs the native session ID with an owned journal filename. Reopening
must preserve both values. Missing or mismatched journals fail without creating
a replacement session.

A completed send receipt records Pi SDK's `preflight-started` acknowledgement.
It does not assert that the upstream model completed or accepted a network
request. The transcript run ends separately from the native assistant outcome.
Stop records its request before calling the SDK, then retains partial text.
A native completed result remains completed if Stop loses a completion race.
Unconfirmed commands retain uncertainty and never replay automatically.

The host injects `OPENCODE_GO_API_KEY` into an in-memory credential store.
It does not persist this key or send it to the browser. Native resource
loading, tools, retries, compaction, telemetry and catalog network refresh are
disabled for this text-chat route. The built-in OpenCode provider supplies its
native session header.

## Verification and remaining work

The opt-in `tests/application/pi-live.test.mjs` starts the bundled host and
uses the actual subscription. It checks streamed text, follow-up memory,
browser reload, host restart with the same native journal, Stop, interrupted
terminal state and credential absence from saved host files and web storage.
`tests/host/pi-driver.test.mjs` exercises the actual SDK against a controlled
provider response for command deduplication, partial output, reopening and
shutdown. `pi-startup.test.mjs` checks paired browser and native endpoints.

The broader Pi graph remains open. External-session discovery, native
extensions, tool approvals, LiteLLM routing, credential renewal, AG-UI native
qualification and cross-process writer coordination are outside this route.
The host's private-directory ownership lock prevents two AgentUI host processes
from sharing its journal directory. Switchboard's process-local reservations
alone do not coordinate independent processes.
