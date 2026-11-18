# Crew extension

`extensions/crew` (package `agentui-extension-crew`, namespace `crew`) connects AgentUI to a Crew service. Its server entry registers one provider per configured installation and the operations `members.list` and `members.create`. Its desktop workspace lists members, creates them and chats with them inside the Extensions view.

## Set up

1. Build AgentUI (`npm run build`). The default desktop build already contains the Crew workspace.
2. Create `~/.local/share/agentui/extensions.json`:

```json
{
  "version": 2,
  "ownership": "transient",
  "extensions": [{
    "directory": "/absolute/path/to/agentui/extensions/crew",
    "installations": [{
      "id": "personal",
      "instance": { "namespace": "crew", "installationId": "personal", "generation": "1", "protocolVersion": "1" },
      "service": "http://<crew host>:<port>",
      "expectedAuthority": "remote-provider",
      "authentication": { "kind": "environment", "variable": "AGENTUI_EXTENSION_CREW_TOKEN", "revision": "1" }
    }]
  }]
}
```

3. Export `AGENTUI_EXTENSION_CREW_TOKEN` with the Crew owner token in the shell that runs `./agentui`, then start AgentUI. The token never goes in the file and never reaches the UI.
4. Open **Extensions → Crew**. Without the file or the variable the row shows `Not configured` and the workspace shows these steps.

The grant `id` is free text; the server entry registers its provider under it. `protocolVersion` must be `1`.

## Network

The Crew gateway binds to loopback by default. A host on the same machine reaches it at `http://127.0.0.1:<port>`. A host on another machine needs the Crew gateway exposed on the private NetBird or Tailscale network; the overlay network is the trust boundary. Use the overlay address as `service`.

## What each action does in Crew

| Workspace action | Crew call | Notes |
|---|---|---|
| List members | `GET /v1/members`, every page up to 1000 members | Each member becomes one agent in the namespace. |
| Add member | `POST /v1/members` with `{ requestId, engine, profile, instructions? }` | One `requestId` per form, so a retry after an unknown outcome cannot create a second member. An unregistered profile is refused with a fixed message. |
| Start conversation | `POST /v1/conversations` for the member | The usual provider creation path. |
| Chat | Crew requests and AG-UI observation | Unchanged provider behaviour, now per member. |
| Edit, Delete | none yet | Disabled until Crew ships member management. |

Crew fixes a member's instructions, engine and profile when it is created and never deletes members. When Crew adds a retire route, AgentUI plans to model **edit** as replace-then-retire: create a replacement member, then retire the old one. Grants, memory, routines and budgets stay with the retired member, and its conversations stay readable. Whether that satisfies "update" is an open owner decision.

## Qualification

See [the Crew qualification record](../qualification/crew.md).
