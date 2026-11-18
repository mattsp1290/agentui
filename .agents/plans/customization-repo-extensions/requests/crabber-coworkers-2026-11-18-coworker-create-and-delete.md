# Create and delete coworkers over the HTTP API

Requested by: AgentUI planning session for the plan `customization-repo-extensions`.
Date: 2026-11-18.
Target repository: existing crabber-coworkers (`mattsp1290/crabber-coworkers`).
Status: proposed. No owner acceptance and no implementation exist.
Priority: blocking for AgentUI work package WP12 only.
Decision owner: Matt (owner of both repositories).
Relation to earlier request: this carves create, delete, the `source` field and the capability out of `2026-11-17-coworker-management-api.md` and asks for them first. Update (`PATCH`) and the single-coworker read with instruction text stay proposed in that request and are not needed by this plan.

## Consumers and evidence

Planned consumer: AgentUI work package WP12 (Create and Delete in the Coworkers workspace). The owner asked for create and delete support on 2026-11-18 and stated that it needs changes in all three repositories. No consumer is demonstrated.

Observed revision: `44ed2ad8326a4822a67a3eeca4087cfc98f03df8`.

## Background

Coworkers come from `config.json` and load when `serve` starts. HTTP API v1 offers only `GET /v1/coworkers` for them. AgentUI may run on another machine on the same private overlay network, so it cannot edit `config.json` and restart `serve`. A for-and-against debate recorded in the AgentUI plan `extensions-nav-crew-coworkers` concluded that API-managed coworkers fit the repository's mission when `config.json` stays authoritative for the coworkers it defines.

## Requested contract

1. A durable store of API-managed coworker definitions under `state_dir`, behind the existing `api.lock`.
2. `POST /v1/coworkers` with strict body `{coworkerId, name, role, instructions, workspace}`. The same body again returns the same result. A different body for an existing ID returns `409 conflict`. The new coworker is usable without restarting `serve`.
3. `DELETE /v1/coworkers/{coworkerId}`. On 2026-11-18 the owner asked that this behave like Crew's member retire. It retires the definition: the coworker is omitted from `GET /v1/coworkers` by default (a strict query parameter includes retired coworkers), a new conversation with it is refused, existing conversations stay readable, the conversation store and workspace files are kept, the ID cannot be reused, and the action cannot be undone. It is refused with `409 conflict` while any conversation of that coworker is `running`. Repeating a completed delete returns the same result.
4. Every coworker in `GET /v1/coworkers` reports `source: "config" | "api"`. A `config.json` coworker cannot be deleted over the API: `409 conflict`. An API coworker ID that collides with a `config.json` ID is rejected at create time and at startup.
5. `GET /v1/capabilities` advertises `coworkerManagement`. Keep `apiVersion` at `"1"`.
6. No Slack binding through the API.

## Proposed owner decisions

The earlier request left two decisions open. This request proposes answers so the work can start. The owner confirms or changes them when reviewing the upstream change.

- **Management switch.** Management is off by default and is enabled by a new `config.json` key, `api.manage_coworkers: true`. `coworkerManagement` is advertised only when the key is true. With the key false, the two routes return `404 not_found`.
- **borb backend.** `coworkerManagement` is advertised only on the `local` backend in the first delivery. On `borb`, the routes return `404 not_found`.

## Exclusions

- `PATCH`, the single-coworker read, time metadata, reply streaming, human approval routes, CORS, TLS, a client SDK, per-user tokens.

## Acceptance criteria

- `cargo xtask check` passes, including the regenerated OpenAPI document.
- An API test creates a coworker, opens a conversation, completes a request, deletes the coworker, observes that a new conversation is refused, that the old conversation remains readable, and that the default coworker list omits it while the strict parameter includes it.
- A test shows that `DELETE` on a `config.json` coworker returns `409 conflict`.
- A test shows that API-created coworkers and retired IDs survive a `serve` restart.
- A test shows that the routes return `404 not_found` and the capability is absent when `api.manage_coworkers` is false.
- The response names an exact commit that AgentUI records as its tested server revision.

## Affected AgentUI work packages

- WP11 (upstream work package U-Coworkers) implements this request in the crabber-coworkers repository.
- WP12 adopts it and is blocked until the response names an exact commit.

## Response and unblock

Respond at `$HOME/.agents/projects/crabber-coworkers/responses/2026-11-18-coworker-create-and-delete.md`. State accepted, declined or needs-decision per numbered item and per proposed decision, the delivered contract, and the exact 40-character commit. Owner acceptance is separate from implementation delivery.
