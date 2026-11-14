# Shared conversation client

`@agentui/client` provides a conversation store for desktop and iOS consumers. Its core compiles against ES2023 without browser or Node globals. `@agentui/client/react` exports `useConversation(store)` using React's external-store subscription API. The package contains no transport, authentication, native adapter, or platform storage implementation.

Create a store with `createConversationStore({ scope, port, projection, drafts, createCommandId })`. The scope contains both host and conversation IDs. The port must belong to that scope. The command ID generator must return a fresh nonempty ID accepted by the shared contracts.

Each store needs its own `DraftStoragePort` instance and independent storage records, including stores viewing the same conversation. `load(scope)` returns `null` for a new store or the previously saved `LocalRecords`. `save(records)` must resolve only after those records are durably stored. Sharing a storage location across client instances requires a future compare-and-swap contract and is unsupported here.

Await `store.ready` to load the draft and outbox. Call `connect()` to request a fresh host snapshot. The immutable view exposes `document`, `cursor`, `draft`, `outbox`, and `connection`. Subscribe directly or call `useConversation(store)` from a React component. `disconnect()` closes the current feed and invalidates late callbacks. `connect()` always starts from a snapshot, including after a sequence gap.

`setDraft(text)` persists an edit. `send()`, `approve(pendingId, choiceId)`, and `cancel(runId)` persist the exact command before submission. A failed save prevents submission. A lost reply or pending/uncertain receipt leaves the command in the outbox. `retry(clientCommandId)` explicitly resubmits that exact persisted command with the same ID. The store never retries a side effect automatically.

A snapshot changes only the host document and cursor. It preserves the local draft and outbox, even if the host document now reports a completed command whose response was lost. Use `document.receipts[entry.command.clientCommandId]` to display the known host outcome beside a local outbox entry. Its presence does not mean a new command should be generated. An explicit retry can obtain the existing receipt and settle the saved local entry. Accepted or completed replies clear a sent draft only when its captured revision still matches. A newer draft with identical text is preserved.

Feed pages apply atomically. The store retains at most 256 sequence identities to recognize exact duplicates. A changed duplicate, older duplicate with no retained identity, or gap requests explicit resynchronization. Scope and projection version mismatches stop the connection. These failures never fabricate an applied cursor.

`checkCompatibility(client, host)` reports independent wire, SDK contract, native runtime, deployment revision, and applied artifact mismatches with corrective actions. Its inputs come from the caller's compatibility exchange; the frozen conversation port does not provide that exchange. An application version alone cannot establish compatibility. Native compatibility is an exact engine, version, and session-format tuple. A desired Git revision and the identity of the artifact actually applied remain separate facts.

The tests exercise emitted exports, the store with injected ports, React updates in Chromium, and ambient-type isolation. These checks do not establish Apple or React Native execution or live-provider behavior.
