# Coworkers extension

`extensions/coworkers` (package `agentui-extension-coworkers`, namespace `coworkers`) connects AgentUI to a crabber-coworkers service through its v1 HTTP API. It lists the coworkers configured in that service's `config.json`, creates conversations with them and shows their replies inside a workspace in the Extensions view. The workspace shows one installation: the selected conversation's installation while it is available, otherwise the available installation with the first installation ID in sort order (the first installation when none is available). Coworkers and chats of other installations stay reachable from Chats.

## Set up

1. Build AgentUI (`npm run build`). The default desktop build contains no extensions; Coworkers is enabled through a customization repository such as [`examples/customization`](../../examples/customization/README.md), which references `extensions/coworkers`.
2. Until the connected customization repository replaces it, the launcher loads the server entry from an entry in `~/.local/share/agentui/extensions.json`:

```json
{
  "directory": "/absolute/path/to/agentui/extensions/coworkers",
  "installations": [{
    "id": "team",
    "instance": { "namespace": "coworkers", "installationId": "team", "generation": "1", "protocolVersion": "1" },
    "service": "http://<coworkers host>:<port>",
    "expectedAuthority": "remote-provider",
    "authentication": { "kind": "environment", "variable": "AGENTUI_EXTENSION_COWORKERS_TOKEN", "revision": "1" }
  }]
}
```

3. Export `AGENTUI_EXTENSION_COWORKERS_TOKEN` with the value of the service's `CRABBER_COWORKERS_API_TOKEN`, then start AgentUI.

## Network

The crabber-coworkers API listens on loopback unless `api.allow_remote` is `true`. Upstream sends the token over plain HTTP and requires a TLS-terminating proxy in front of the API when `api.allow_remote` is set; the service does not check that the proxy exists. For a host on another machine, put the API behind such a proxy on the private overlay network and use the proxy's address as `service`.

## What each action does upstream

| Workspace action | Call | Notes |
|---|---|---|
| Coworker cards and About | `GET /v1/coworkers` | Name, role, workspace access, Slack flag and instruction size. Instruction text is not exposed. |
| Chat or New chat | `POST /v1/conversations` | The conversation ID is derived from the AgentUI operation, so a retry reopens the same conversation. |
| Send | `POST /v1/conversations/{id}/requests` | The request ID is derived from the operation and the text, so a resend is the same request upstream. |
| Stop | `POST …/requests/{requestId}/cancel` | |
| Replies | polling `GET /v1/conversations/{id}` and request receipts | Active conversations every second, idle ones 5, 15, 60 then 300 seconds, at most four requests in flight. A typing indicator shows while a request runs. |
| Create, Edit, Delete | none yet | Disabled until crabber-coworkers manages coworkers over its API. |

The conversation keeps the newest 100 requests, the window upstream returns, with a notice when older turns are hidden.

## Qualification

See [the Coworkers qualification record](../qualification/coworkers.md).
