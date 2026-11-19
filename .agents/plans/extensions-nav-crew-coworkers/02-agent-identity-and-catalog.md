# WP2: Provider identity on agents and a provider filter on the catalog

## Goal

A workspace view maps a service's agent (a Crew member, a coworker) to the AgentUI agent that creates conversations with it. It lists the conversations of one namespace or one provider agent without one request per conversation. The list keeps conversations whose agent was later retired, deleted or replaced.

Prerequisite state: WP1 merged (wire 15).

## Repository evidence

- `packages/contracts/src/service.ts`: provider `AgentDescriptor` has `id, label, commands, availability, imageInput, frontendOffers, kind: 'provider', namespace, protocolVersion`. It has no installation ID and no provider agent ID.
- `apps/host/src/agents.ts:36` builds `id` as `provider-v1-${sha256(providerInstallationKey)}`. The key includes `instance.generation`, so the ID changes on a generation bump. `describeUnavailableProvider` builds installation-level descriptors that have no agent.
- `packages/host/src/provider-creation.ts`: `ProviderInstallation` holds `contributionId`, `instance` and `agent: { opaqueId, name }`.
- `packages/host/src/sqlite-schema.ts:46-49`: the `conversations` table stores the installation as canonical JSON. It has no agent column and no time column.
- `packages/host/src/sqlite-store.ts:296-303`: the catalog query orders by conversation ID, pages with `conversationId > ?`, and excludes a predecessor that has a confirmed successor.
- `apps/host/src/conversation-search.ts`: `searchConversations` builds search entries.
- `ConversationCatalogEntry` is `{ scope: ConversationScope; preview: string | null }`. The catalog value is a bare array. `ConversationSearchEntry extends ConversationCatalogEntry`, and the search parser reuses the catalog entry parser.
- `docs/extensions/provider-contract.md` describes the agent `opaqueId` as provider-owned and opaque.

## Decisions for this package

- No schema change. The filter reads the stored installation JSON with SQLite `json_extract`. The data set is one user's conversations, so no index is added. This closes risk R2.
- The filter and the per-entry provider identity come from the installation stored with the conversation, not from the current agent descriptors.
- The catalog keeps its ID order and its cursor. This plan adds no activity time.

## Change surface

### Contracts (`packages/contracts/src/service.ts`)

- Provider `AgentDescriptor` gains `installationId: string` and `providerAgentId: string | null` (both new). `providerAgentId` is the provider's `opaqueId`. It is `null` on installation-level descriptors such as unavailable installations.
- `ConversationCatalogEntry` gains `provider: { namespace: string; installationId: string; providerAgentId: string } | null` (new). It is `null` for a native or recorded conversation.
- `ConversationSearchEntry` gains the same field through its base type. State this in the wire documentation.
- The `catalog` request gains an optional `filter` (new): `{ kind: 'namespace'; namespace: string } | { kind: 'provider-agent'; namespace: string; installationId: string; providerAgentId: string }`.
- Parsers accept the new fields with `exact()` checks.
- `SERVICE_WIRE_VERSION` becomes `16`.

### Host

- `apps/host/src/agents.ts`: fill the two new descriptor fields from `ProviderInstallation`. Use `null` for `providerAgentId` where no agent exists.
- `packages/host/src/sqlite-store.ts`: the catalog read accepts the filter and adds `json_extract` predicates to the existing query, so the predecessor exclusion still applies. First step: read `sqlite-schema.ts` and one stored row to confirm the JSON paths for `instance.namespace`, `instance.installationId` and `agent.opaqueId`. Write the paths into the pull request description.
- `apps/host/src/api.ts`: pass `filter` through and fill `provider` on each entry from the stored installation.
- `apps/host/src/conversation-search.ts`: fill `provider` on each search entry the same way.
- The page size and cursor rules are unchanged. A client treats a page whose length equals the requested limit as "more may exist".

### Tauri (`apps/desktop/src-tauri/src/wire.rs`)

- `Request::Catalog` accepts the optional `filter`. Update the round-trip test and add an unknown-`kind` rejection.

### Client

- `packages/client`: forward `filter`. Desktop controller changes belong to WP3.

### Documentation

- `docs/extensions/provider-contract.md`: state that an agent `opaqueId` is visible to clients and must not carry a secret.

## Behaviour and invariants

- An unfiltered `catalog` returns the same entries in the same order as before, with `provider` added.
- A `namespace` filter returns every conversation whose stored installation has that namespace, including conversations whose agent is no longer discovered and conversations created under an earlier `generation`.
- A `provider-agent` filter ignores `generation`.

## Tests and acceptance

- A host-level test (in `tests/application/` or `tests/host/`) with two ledger conformance providers in different namespaces (`tests/extensions/providers/conformance/ledger.mjs`):
  - the `namespace` filter returns only that namespace's conversations;
  - the `provider-agent` filter returns only that agent's conversations;
  - paging holds across two pages with three or more conversations;
  - after the agent disappears from discovery, the filtered list still returns its conversation;
  - a continued conversation appears once in a filtered list (its successor), as in the unfiltered list;
  - after the installation's `generation` changes, the filtered list still returns the earlier conversation.
- A host test proves the descriptor carries `installationId` and `providerAgentId`, and that an unavailable installation's descriptor has `providerAgentId: null`.
- A host-level search test: `provider` is filled for a provider conversation and `null` for a recorded one.
- `tests/client/wire-validation.test.mjs`: new fields round-trip for catalog and search; an unknown `filter.kind` is rejected.
- A test opens a data directory fixture created before this change and lists its conversations. This proves no migration is needed.
- `cargo test` passes.

## Exclusions

- No conversation titles, timestamps or recency ordering.
- No filter on `search`.
