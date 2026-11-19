# WP1: Extension operations channel

## Goal

A desktop UI extension calls a named operation on its own server entry. The host routes the call, supplies the installation and its credential handle, bounds the payloads and the time, and sanitizes failures. A server entry can read its configured installations, so it can be written without hard-coded service addresses.

Prerequisite state: `main` at or after `e5db45f`. No other work package.

## Repository evidence

- `packages/sdk/src/extensions.ts:33-37`: `ServerExtensionContext` has only `namespace`, `providers: ProviderContributions` and `credentials: ServerProviderCredentials`. A server entry cannot see an installation's `service` origin today. Every existing provider receives it by closure (`examples/crew/src/provider.ts`, `tests/extensions/providers/conformance/ledger.mjs`).
- `credentials.use({ credential, service }, action)` (`packages/sdk/src/provider-presentation.ts`) refuses a `service` that differs from the grant's.
- `apps/host/src/provider-credentials.ts`: `use` wraps the whole action in a `try`/`catch` and rethrows a fixed `Provider credential use refused` error, so an error thrown inside the action loses its type. It adds each `use` task to `pending`, and `close()` waits for every pending task. `createProviderAuthority(state, namespace, installations)` keys grants by grant `id`. `installationFor(id, instance)` refuses unless the provider contribution ID equals a grant `id` and the instance matches. `issue(id, instance)` returns the credential handle.
- `packages/sdk/src/providers.ts`: `ProviderInstance` holds `namespace`, `installationId`, `generation`, `protocolVersion`. `BackendProvider.connect` receives `{ apiVersion, instance, credential }`.
- `apps/host/src/provider-extensions.ts` and `packages/host/src/extensions/index.ts` (`createServerExtensions`) stage registrations and close registration when activation settles.
- `packages/host/src/providers.ts`: discovery covers every installation (`registry.discover()`), reuses a discovery that is already running (`discovering ??=`), and rejects more than 1000 agents.
- `packages/contracts/src/service.ts`: the closed union `ServiceRequest`, `parseServiceRequest` (uses `exact()` key checks), `ServiceValueMap`, `parseServiceResponse`, and `createServiceConnection`.
- `packages/contracts/src/durable.ts:8`: the JSON value type is `Json`. `DEFAULT_MAX_COMMAND_BYTES = 64_000`.
- `apps/host/src/api.ts`: the `requestScope` switch and the `createApi` dispatch.
- `apps/desktop/src-tauri/src/wire.rs`: `enum Request` tagged on `op` with `deny_unknown_fields`, a scope match, `MAX_COMMAND_BYTES` for `Submit`, and the tests `every_service_operation_and_command_body_round_trips` and the unknown-op test.
- `docs/architecture/native-credentials.md`: the native transport has a 20-second deadline and never retries.
- `packages/contracts/src/compatibility.ts`: `SERVICE_WIRE_VERSION = 14`, `EXTENSION_SDK_VERSION = '0.11.0'`.

## Change surface

### SDK (`packages/sdk/src/extensions.ts`)

- `ServerExtensionContext.installations` (new field): `readonly ServerExtensionInstallation[]`.
- `ServerExtensionInstallation` (new): `{ id: string; instance: ProviderInstance<string>; service: string; expectedAuthority: 'agentui-host' | 'remote-provider' }`. It holds no secret. `id` is the grant `id` from the host configuration.
- Rule, stated in the SDK documentation: a provider contribution ID must equal the grant `id` of the installation it serves. An entry that serves every configured installation registers one provider per installation with `providers.add(installation.id, …)`.
- `ServerExtensionContext.operations` (new field) of type `OperationContributions` (new).
- `OperationContributions.add(id, operation)` (new). `id` matches `^[a-z][a-z0-9.-]{0,63}$`. A duplicate `id` in one namespace throws. Registration after activation throws, as provider registration does.
- `ExtensionOperation` (new):

```ts
// proposed shape
interface ExtensionOperation {
  run(call: {
    installation: ServerExtensionInstallation;   // the installation the client named
    credential: CredentialHandle<string> | null; // issued by the host for that installation
    input: Json;                                  // bounded copy
    signal: AbortSignal;                          // aborted at the host deadline
  }): Promise<ExtensionOperationResult>;
}
type ExtensionOperationResult =
  | { kind: 'ok'; output: Json; agentsChanged?: true }
  | { kind: 'refused'; code: string };            // code matches ^[a-z][a-z0-9-]{0,63}$
```

- SDK documentation note: an error thrown inside a `credentials.use` action reaches the caller as one fixed opaque error. Code that needs to classify a failure catches inside the action and returns a typed value.
- SDK documentation note: operation code must pass `call.signal` to every request it makes. A request that ignores the signal keeps its `credentials.use` task pending and holds generation close.
- `EXTENSION_SDK_VERSION` becomes `'0.12.0'`.

### Contracts (`packages/contracts/src/service.ts`, `compatibility.ts`)

- `ServiceRequest` gains `{ op: 'extension-call'; namespace: string; installationId: string; operation: string; input: Json }` (new). `installationId` is `ProviderInstance.installationId`.
- `ServiceValueMap['extension-call']` (new):

```ts
// proposed shape
type ExtensionCallValue =
  | { kind: 'ok'; output: Json }
  | { kind: 'refused'; code: string }
  | { kind: 'failed'; cause: 'unknown-extension' | 'unknown-installation' | 'unknown-operation'
                             | 'unavailable' | 'too-large' | 'invalid-result' | 'threw' | 'timeout' };
```

- `ServiceMetadata` gains `extensions: readonly ExtensionDescriptor[]` (new). `ExtensionDescriptor` is `{ namespace: string; state: 'active' | 'failed'; operations: readonly string[]; installations: readonly { installationId: string; status: 'available' | 'unavailable' }[] }`. `state: 'failed'` reports a configured namespace whose generation failed to load or activate, with empty `operations`. The implementer reads the existing unavailable-cause type in `service.ts` and adds it as an optional `cause` when a named type exists. Sort by `namespace`, then `installationId`.
- `parseServiceRequest` and the response parser accept the new shapes with `exact()` checks. They enforce the `namespace` and `operation` patterns.
- `createServiceConnection` gains `extensionCall(request)` (new method).
- `SERVICE_WIRE_VERSION` becomes `15`.

### Host (`packages/host/src/extensions/index.ts`, `apps/host/src/provider-extensions.ts`, `apps/host/src/provider-credentials.ts`, `apps/host/src/api.ts`)

- Activation passes each namespace its `installations`, built from the same normalized grants that `createProviderAuthority` receives.
- The staging step that collects provider registrations also collects operations per namespace.
- The generation owner exposes `callOperation({ namespace, installationId, operation, input })` (new). It admits the call the same way it admits a provider command. A retired or changing generation refuses it with `unavailable`.
- The host resolves the grant by `namespace` and `instance.installationId`. No match, or more than one match, gives `unknown-installation`. It issues the credential handle through the authority's existing `issue` path.
- `requestScope` returns `null` for `extension-call`.
- `createApi` dispatches `extension-call` to `callOperation`.
- `metadata` fills `extensions` from the configured selection and the generation status. No configuration gives `[]`. A failed generation gives one `state: 'failed'` descriptor per configured namespace, with no exception text.

### Tauri (`apps/desktop/src-tauri/src/wire.rs`)

- `Request::ExtensionCall { namespace, installation_id, operation, input }` (new variant). Serde renames keep the wire keys `installationId` and `op: "extension-call"`.
- The scope match returns `None` for it.
- Reject an `input` over 64,000 bytes and a `namespace` or `operation` that fails its pattern, the same way `Submit` is bounded.
- Both wire tests list the new variant. Add an over-limit case and a bad-pattern case.

### Client (`packages/client/src/service-engine.ts`, `service.ts`, `mac.ts`)

- Each connection forwards `extensionCall`. No retry. No outbox entry. A transport failure or client-side timeout rejects with the existing `ServiceError` types; WP3 converts that rejection for extension authors.

## Behaviour and invariants

- Input limit: 64,000 UTF-8 bytes of canonical JSON. Output limit: 256,000 bytes. Over-limit input gives `too-large` before the handler runs. Over-limit output gives `too-large` after it.
- The host copies input and output through a bounded JSON copy. A non-JSON output gives `invalid-result`.
- Deadline: the host replies within 15 seconds of admission. This stays below the 20-second native transport deadline. At the deadline the host aborts `signal`, replies `timeout`, releases the call's admission so replacement is not deferred by it, and discards a late result. A handler that ignores `signal` while inside `credentials.use` still holds the authority's close. The plan does not change the authority; it requires operations to honour `signal` and tests that they do (WP5, WP7).
- A thrown or rejected handler gives `threw`. The exception text never leaves the host. The host records the failure category through the existing observability path without secrets.
- A `refused` code that fails the pattern gives `invalid-result`.
- `agentsChanged: true` on an `ok` result: the host waits for any discovery that is already running, then starts a fresh discovery, and waits for it only until the 15-second deadline. It then replies `ok`. A slow or failed discovery does not change the reply. The reply never contains `agentsChanged`. The view calls `refresh()` afterwards (WP3).
- The channel gives no idempotency. An operation that mutates remote state carries its own idempotency key inside `input`. A `timeout` or a lost reply means the outcome is unknown; the caller retries with the same key.
- UI code never receives a credential, a credential handle or a service origin. `metadata.extensions` contains none of them.
- Desktop extensions are full trust and share one JavaScript realm. Binding a UI extension's calls to its own namespace (WP3) is a convenience. The host's namespace and installation checks are the only enforcement.

## Compatibility

Backward compatibility is not required. SDK 0.11.0 extensions are refused until rebuilt. Update every pinned literal:

- `templates/customization/package.json`.
- Test files that hold the SDK literal. Find them with `git grep -n "0\.11\.0" -- . ':(exclude)apps/desktop/src-tauri/Cargo.lock' ':(exclude)package-lock.json'`. `tests/application/browser-support.mjs` holds a hard-coded `sdkVersion`.
- `tests/client/compatibility.test.mjs` (current and previous-version cases) and `tests/client/service-empty.test.mjs` for the wire version.
- `examples/generated-text-output/tests/packed-consumer.mjs`.
- `docs/architecture/extension-sdk.md` and `docs/architecture/provider-contracts.md` version statements.

## Tests and acceptance

- New `tests/host/extensions/operations.test.mjs` (the directory is already in the `npm test` globs):
  - an entry activated with two installations sees both in `context.installations`, registers one provider per installation by grant `id`, and each provider connects to its own service origin;
  - a registered operation receives the named installation and a credential handle that `credentials.use` accepts for that installation's `service`;
  - unknown namespace, installation and operation give the three `unknown-*` causes;
  - a throwing handler gives `threw` and the reply contains none of the thrown text;
  - over-limit input and output give `too-large`;
  - a handler that waits inside `credentials.use` on a promise that settles only when `signal` aborts gives `timeout` at the deadline, and a replacement requested afterwards completes (use an injectable clock or a shortened deadline option in the test);
  - a failed generation yields `state: 'failed'` descriptors;
  - an `ok` result with `agentsChanged` makes a newly discoverable agent appear in the next `metadata` reply, including when a discovery was already running before the call;
  - a call after `close()` gives `unavailable`.
- `tests/extensions/contracts/extensions.test.mjs`: duplicate and late `operations.add` throw.
- `tests/client/wire-validation.test.mjs`: the request and each response kind round-trip; an extra key is rejected; a bad `operation` pattern is rejected.
- `tests/application/service-endpoint.test.mjs`: `metadata` returns `extensions` with no service origin.
- `tests/application/server-extension-cli.test.mjs`: an installed entry configured only through the extension configuration file reads its service origin from `context.installations`.
- `cargo test` in `apps/desktop/src-tauri` passes with the new variant and the two rejection cases.
- `tests/extensions/providers/conformance/boundaries.test.mjs` still passes.

## Exclusions

- No streaming or feed for operations.
- No operation calls from iOS.
- No operation without an installation. An extension with no configured installation exposes no callable operation.
