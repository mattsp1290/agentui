# Author an extension

The existing `@agentui/sdk` package exposes server contracts at its root and UI contracts at `@agentui/sdk/react`.
The `@agentui/sdk/react-tools` entry combines UI presentation capture with frontend tool generations.
Installed server code runs with host process privileges.
Installed UI code runs with client process privileges.
Extensions are full trust. There is no sandbox or isolation promise.
Neither context exposes private host credentials to UI code.

## Declare and check an entry

Declare a namespace, `trust: 'full'`, `sdkVersion: EXTENSION_SDK_VERSION`, and at least one entry.
Each entry names `server`, `desktop`, or `ios` and a contained relative module path such as `./desktop.js`.
A manifest can declare each target once. The namespace matches `[a-z][a-z0-9-]{0,31}`.

Call `parseExtensionManifest` on unknown metadata, then `checkExtensionEntrypoint(manifest, target, loadedExport)` before activation.
An incompatible result names an unsupported version, an undeclared or mismatched target, or an invalid entry export.
Parsing accepts declared version strings within the currently known manifest field shape so compatibility checking can report unsupported versions separately.
It does not parse speculative future manifest shapes.
Manifest path checking validates syntax. `loadServerExtension` from `@agentui/host/extensions` checks filesystem containment and existence.
It checks manifest compatibility before import and requires a regular file beneath the real installation directory.
Symlinks that escape that directory are rejected. The imported default export must pass the SDK entry check.
Use immutable revision directories. Node caches each module URL, so changing bytes at an existing path does not select a new revision.
Importing full-trust code can itself execute code. The extension owns cleanup of import effects and failed partial activation.
The host provides no cleanup callback for import effects.
Start timers, listeners, and connections in `activate` so `dispose` can release them.

A server entry implements `ServerExtensionEntry`.
Its context supplies `providers.add(id, provider, presentation)`, a generic method preserving the concrete `BackendProvider<Model, Installation>` type.
`providers.addAgui` uses the same registration and authority with a model whose request is the actual `RunAgentInput`.
The backend must send that exact input and confirm its preallocated `runId`.
Allocate a fresh run ID for each independent offered send. Exact retries keep the saved input and original run ID.
SDK 0.5.0 introduced this required activation-context method. Extensions built before SDK 0.13.0 must rebuild; exact-version hosts refuse them before activation.
A provider-only entry requires no React import or UI bootstrap.
The [provider contract](provider-contracts.md) stays independent of UI activation.
The server-only `credentials.use({ credential, service }, action)` resolves a host-issued handle for an authorized callback.
SDK compatibility is `0.13.0`. Both the manifest and loaded entry must match this version exactly.
SDK 0.6.0 adds the optional `contentLayout` contribution and requires rebuilding older extensions.
SDK 0.9.0 adds optional provider text outputs through `ConnectedProvider.outputs`. Hosts enumerate complete scoped descriptors and read verified UTF-8 bytes through `LocalHost.conversationOutputs` and `LocalHost.readOutput`. Existing providers may omit the capability. This in-process addition keeps backend contract 1, wire 10, core DB 7 and transcript 4.
SDK 0.10.0 adds the optional `ProviderPresentation.closure(state)` hook. It reads a provider-confirmed end of the conversation from saved state without I/O and returns `{ cause }` or `null`. Hosts report such a conversation as `concluded`, start no observation for it and refuse its sends. Existing presentations may omit the hook. The new observation status requires wire 12; backend contract 1, core DB 7 and transcript 4 are unchanged.
SDK 0.11.0 adds the optional `CreationIntent.from`, which names the confirmed conversation a new creation continues, and the optional `ProviderPresentation.continuation(evidence)` hook. The host copies `from` from its own record of that conversation: the scope must be on the same host and the binding must belong to the same provider installation. A presentation opts its provider in to continuation by declaring `continuation`. A presentation may omit it; the host then refuses a successor for that provider and never passes it `from`. A provider that receives `from` must continue that predecessor or refuse the creation. It derives the binding of a `from` creation from its intent except for what the provider service assigns: the session and, optionally, `carryingTurn`, the provider's ID for the turn that carried the predecessor. The host refuses a successor whose session equals the predecessor's and any other binding that names `carryingTurn`. `continuation(evidence)` reads the creation's saved evidence without I/O and returns the carried turn and byte counts, `{ refused }` or `null`. Core DB 8 adds an index of creations by predecessor, and format 7 hosts refuse it. Wire 12, backend contract 1 and transcript 4 are unchanged.
Wire 13 later adds the `abandon` service operation and wire 14 the `continuation` operation, both without an SDK change.
SDK 0.12.0 adds `ServerExtensionContext.installations` and `ServerExtensionContext.operations`, and wire 15 adds the `extension-call` service operation and `ServiceMetadata.extensions`. See [Call server operations from the client](#call-server-operations-from-the-client).
Wire 16 adds `installationId` and `providerAgentId` to provider agent descriptors, `provider` to catalog and search entries, and an optional `filter` (`namespace` or `provider-agent`) to `catalog`. The filter reads the installation stored with each conversation, so conversations of retired, replaced or earlier-generation agents stay listed. No stored data format changes.

SDK 0.8.0 adds an optional fourth `providers.addAgui` argument, `AguiObservations<Model, Installation>`.
Its `event(event)` callback returns ordered `AguiRunBatch` values. Its `snapshot(state, originals)` callback returns complete prefixes or explicit unavailable histories for the supplied original operations.
Both callbacks are synchronous. A batch identifies the original operation, thread and fully scoped run reference. Positions begin at one within that run; every AG-UI event counts.
A snapshot prefix includes all events through its provider cursor. An empty prefix asserts that no events occurred. Omitting a relevant original makes its history permanently unavailable.
Both mapping results have a 128-entry limit. Snapshot callbacks receive at most 128 originals. Their canonical unavailable replies, which contain the exact public descriptors, and compact host membership records share a 128,000-byte selection budget. Originals excluded by count or bytes become permanently unavailable. The host continues scanning after an oversized descriptor, so a later smaller original can still fit.
Event mappings retain a strict 1,000,000-byte aggregate limit. Snapshot preparation has a separate 1,000,000-byte bound that includes metadata and encoded frame storage. Complete histories that exceed the remaining preparation budget become unavailable after every frame is validated. The host retains at most 4096 events and 1,000,000 raw event bytes per original, with 64,000 bytes per event. Capacity loss permits canonical snapshot progress; invalid mapper data rejects it.
A send captures its observation opt-in permanently. Installing a mapper later does not reinterpret an older request-only send.
Observations can arrive before the submit response. The host acknowledges their journal and provider checkpoint atomically, then registers frontend calls only after exact original command confirmation.
This contract does not add browser consent, execution or continuation. Existing three-argument `addAgui` registrations retain capture-and-bind behavior. Actual Crew and Switchboard adapters require separate qualification.

SDK 0.7.0 adds the optional `overrides.activity` contribution.
Authors supply a presentation and hosts supply the credential capability.
Workspace package versions are `0.0.0`, service wire version is 16, and transcript projection version is 4.

Desktop contributions may arrange transcript and module presentation with `contentLayout`.
The composer, approvals, Stop, recovery, agent selection and protected navigation remain host-owned.

A UI entry implements `UiExtensionEntry<'desktop'>` or `UiExtensionEntry<'ios'>`.
Its activation returns modules and a required `dispose` function, either directly or through a promise.
Standalone owners call `parseUiExtensionContributions` once on the returned contribution.
The result distinguishes an invalid lifetime, invalid presentation with an acquired disposer, and ready presentation with a disposer.
The owner retains the disposer before handling presentation failure or removal, including late activation results.
It withdraws contributions and calls that disposer on deactivation. Repeated calls share the same completion or rejection.
Render only the ready result's `presentation`, whose module/action records and arrays are copied recursively.
Captured actions and disposal retain their original receivers. Component references stay opaque, including React wrappers.
The standalone assertion helpers never invoke disposal; standalone owners use the parser to retain captured values.
Behaviour checks accept class instances, accessors, and callable objects with the required fields.
They check field shapes, not arbitrary JavaScript behaviour.
A server activation likewise returns required disposal, checked with `validateExtensionLifetime`.
The host accepts already imported server entries through `startBrowserHost({ agentStartup: { kind: 'extensions' }, extensions: { kind: 'transient', entries } })`.
It stages all registrations before connecting, rejects duplicate contributions or full instances, and closes registration when activation settles.
Failed activation disposes earlier valid lifetimes; an entry that throws before returning a valid lifetime owns its partial activation cleanup.

## Load and replace server entries

### Contract

`startBrowserHost` accepts imported entries and installed entries inside `extensions: { kind: 'transient', entries }`. An installed entry has this shape:

```ts
{
	kind: 'installed',
	directory: '/installed/example/revision-2',
	manifest,
	installations,
}
```

The host loads and activates the selected entries, then discovers their providers before listening.
`installations` uses the existing host provisioning and credential policy.
Credentials remain server-only. Discovery results, lifecycle status, and replacement results contain no secrets or extension exception text.
The production CLI selects installed server entries and verified server artifacts through `serve --extensions` as described below.

The returned host exposes `discoverProviders()`, `extensionStatus()`, `replaceProviderExtensions(selection)`, and `close()`.
An empty selection disables local extensions. It does not send a provider cancel, delete, or other remote command.
The owner in `@agentui/host/extensions` manages one whole provider registry generation at a time.
The host supplies its `prepare()` callback only after replacement admission and successful old cleanup.
Preparation loads all entries before creating authorities and closes any authorities acquired before a preparation failure.
A custom host using `createServerExtensions()` must follow that same preparation ownership contract.
It returns `{ kind: 'ready', extensions }` to transfer authorities to the registry, or a fixed failure after its own cleanup.
If preparation cleanup fails, it returns `{ kind: 'failed', failure: 'cleanup', recovery: 'restart' }`.

`extensionStatus()` reports `empty`, `active`, `changing`, `failed`, `closing`, or `closed`.
An active status includes a generation number and the number of admitted discovery, creation, command, lookup, and observation acquisition operations.
An acquired observation feed does not count as pending work.
Replacement outcomes are:

- `replaced` includes the new generation number, or `null` for an empty selection.
- `deferred` with reason `active-work` leaves healthy admitted work and later operations on the original generation.
  It does not import the candidate, prepare authorities, revoke credentials, or dispose the original generation.
- `deferred` with reason `changing` refuses a competing change while an accepted change or failure cleanup is pending.
- `failed` reports a fixed failure category and recovery action.
- `unavailable` refuses replacement during or after shutdown.

A deferred request is not queued or remembered. Retry with the latest desired selection after work settles.
Continuous admitted work can postpone replacement indefinitely.
An accepted idle replacement stops discovery, creation, command, lookup, and observation admission before any asynchronous work.
It stops local feeds, drains admitted callbacks, and awaits complete old disposal before importing or activating the next generation.
This ordering prevents overlap between activation-owned listeners, with an unavailable interval between generations.
Close during replacement prevents publication of the new generation and disposes every acquired valid lifetime once.
After a successful nonempty replacement, the host resumes saved provider observations compatible with the new selection.
Each observation keeps its original installation, credential handle, conversation binding, and last committed cursor.
An existing checkpoint avoids another snapshot. Recovery does not create conversations, submit commands, reconcile operations, or change saved provenance.
Incompatible identities, credentials, or decoders leave saved history readable without opening a feed.
Concurrent replacement or shutdown stops an obsolete recovery scan. A later compatible replacement retries failed observation starts.

### Provider status

Discovery is per installation and never retires the generation. Each installation reports `available` with its agents, or `unavailable` with one cause from a closed set: `offline`, `authentication-failed`, `unauthorized`, `version-unsupported`, or `invalid-installation`.
Backend `unavailable`, `authentication-failed`, `unauthorized`, and `version-unsupported` results map to the same-named cause (`unavailable` becomes `offline`, contract `unsupported` becomes `version-unsupported`). Thrown callbacks, malformed results, identity mismatches, and host authorization refusals are `invalid-installation`.
A backend reports a configuration problem it cannot classify, such as a host credential it cannot use, by throwing.
Each cause has one fixed, sanitized reason; provider-supplied reasons and errors are never shown.
Healthy installations stay selectable. The chooser lists an unavailable installation as a disabled entry labeled with its namespace and installation ID, and existing conversations show its reason instead of "no longer configured".
Every cause except `invalid-installation` is retried on the next discovery: a refused connection holds nothing and reconnects, a reported `version-unsupported` closes its connection so the reconnect probes capabilities again, and other reported causes keep their connection.
When metadata or conversation reads find that the last discovery started at least 30 seconds ago, the host starts one background discovery without waiting for it. This both recovers retryable outages and reports outages that begin after a healthy discovery. No timer runs, and shutdown waits for that discovery.
An `authentication-failed` installation recovers automatically when the credential is fixed on the provider. AgentUI reads its own extension secret once at startup, so changing that secret needs a host restart.
`providers-refresh` (`node apps/host/dist/main.js providers-refresh --data-dir /private/host`) discovers immediately and returns every installation's status.
An `invalid-installation` closes that installation's connection and recovers only after the configuration is fixed and the extension is replaced, normally by restarting the host.
Transient and durable serving keep running through provider discovery failures.
Backends must bound their own connect and discover calls; the host does not impose a deadline, and an unsettled call keeps refresh and replacement pending.

### Failure and shutdown

A load, authorization, or activation failure permits an explicit replacement only after successful cleanup.
A `load` failure caused by the entry module throwing during import stays cached for that path.
Recover by replacing with a new immutable revision directory, or restart the host.
The owner does not automatically retry extension callbacks or restore the old generation.
Any cleanup failure is permanent for that host and reports `recovery: 'restart'`.
Further replacements remain refused and repeated shutdown remains rejected without calling disposers again.
The application retains its storage and directory ownership after failed cleanup because extension code may still be live.
Recovery requires a process restart, with the failing extension disabled or repaired as needed.

Shutdown retains the existing immediate authorization freeze.
Unlike normal deferred replacement, `close()` revokes credential admission immediately and discards late discovery results. Entered creation and send effects retain uncertain outcomes for later lookup.
It waits for admitted work before closing connections and disposing lifetimes.
The successful-result guarantee applies to healthy discovery, creation, commands, lookup, and observation acquisition across deferred replacement, not to shutdown or independent provider failure.
Feed callbacks copy and authorize their input before admission. Already admitted callbacks may commit during retirement after credentials freeze.
Retirement waits for those callbacks. New callbacks and credential use are refused.
A throwing feed close or rejected drain reports cleanup failure and retains storage and directory ownership.
A feed that closes without error but never ends can keep retirement pending indefinitely.
Independent credential callbacks and extension background work are not counted as admitted provider operations.
They keep the registry's existing close behavior.
Cooperative code that never settles can leave replacement or shutdown pending indefinitely.

The registry admits provider creation, commands, lookup, and observation acquisition synchronously before provider delegation.
It owns observation stop and drain. It does not deliver frontend tools or qualify slow frontend-tool execution.
Agent discovery and creation requests read the active catalog. Retired, changing, disabled, and failed generations expose no choices.
Creation and command recovery retain the original installation, credential, and operation identity across replacement.
Command lookup never translates or resends the original request. A replacement that cannot match its original target leaves the existing outcome unchanged.
UI refresh does not invoke server replacement.

## Select server extensions with the CLI

`serve --config ./agents.json --extensions ./extensions.json --data-dir ./state` selects server extensions alongside configured native agents.
`serve --extensions ./extensions.json --data-dir ./state` runs providers without native agents or recorded playback.
`--extensions` is valid for `serve` and `desktop`. With `desktop`, the configured native default stays selected and provider agents are listed beside the native agents.
With both files, the configured native default remains selected. Without native configuration, the default is the ready provider with the smallest stable ID in the current catalog, independent of discovery order.
Empty, changing, or failed catalogs remain readable with no default. Creation is disabled while saved conversations and their original agent identities remain available.
Omitting `--extensions` preserves the existing native-agent behavior.
Changes to launch configuration and credential rotation take effect after a restart. Saved durable artifact selections can also be applied explicitly [without restarting](#durable-selection-and-explicit-live-application).

The version 2 extension configuration has this shape:

```json
{
	"version": 2,
	"ownership": "transient",
	"extensions": [{
		"directory": "/absolute/path/to/agentui/extensions/crew",
		"installations": [{
			"id": "personal",
			"instance": {
				"namespace": "crew",
				"installationId": "personal",
				"generation": "1",
				"protocolVersion": "1"
			},
			"service": "https://crew.example",
			"expectedAuthority": "remote-provider",
			"authentication": {
				"kind": "environment",
				"variable": "AGENTUI_EXTENSION_CREW_TOKEN",
				"revision": "rotation-1"
			}
		}]
	}]
}
```

To select a [built server artifact](../customization/server-artifacts.md), use an artifact entry instead of an installed package entry:

```json
{
	"kind": "artifact",
	"directory": "./artifacts/crew-v1",
	"artifactId": "<64-character artifact ID printed by the builder>",
	"installations": [{
		"id": "personal",
		"instance": {
			"namespace": "crew",
			"installationId": "personal",
			"generation": "1",
			"protocolVersion": "1"
		},
		"service": "https://crew.example",
		"expectedAuthority": "remote-provider",
		"authentication": { "kind": "unauthenticated" }
	}]
}
```

Put this object in the `extensions` array. The `artifactId` must be the exact lowercase hexadecimal ID printed by the builder. A catalog can contain several extension namespaces. Each installation grant names a namespace in that catalog. Installed entries and artifact entries can appear together under transient ownership. Use `"ownership": "durable-artifacts"` for journaled next-start selection.

`directory` resolves relative to the selection file's directory. Absolute directories are also accepted.
Each installed package supplies its canonical manifest at `package.json.agentui.extension`:

```json
{
	"name": "agentui-extension-crew",
	"agentui": {
		"extension": {
			"namespace": "crew",
			"trust": "full",
			"sdkVersion": "0.13.0",
			"entries": [{ "kind": "server", "module": "./dist/server.mjs" }]
		}
	}
}
```

Package metadata outside `agentui.extension` is ignored.
Selection objects, grants, authentication objects, identities, and manifests reject extra or missing fields.
Empty `extensions` and `installations` arrays are valid.
Selected namespaces, grant IDs within a package, and complete provider identities must be unique.
Under transient ownership, each grant's namespace must match a manifest in its selected package or artifact catalog.
[Durable selection](#durable-selection-and-explicit-live-application) retains unused startup grants when an artifact is disabled.
`expectedAuthority` accepts `agentui-host` or `remote-provider`.
`service` must be an HTTP or HTTPS origin without credentials, a query, a fragment, or a non-root path.

`authentication` accepts either the environment reference shown above or exactly `{ "kind": "unauthenticated" }`.
Environment names follow `AGENTUI_EXTENSION_[A-Za-z0-9_]+` and have at most 1024 characters.
Missing or blank secrets fail startup. The host captures the original secret bytes without trimming.
After the entire selection passes validation, the host removes only referenced variables from its environment before extension activation and native child startup.
Extensions access the captured value through the existing credential authority. The host persists only grant metadata.
Unreferenced variables remain available, including other variables with the reserved prefix.
Changing the process environment after configuration decoding does not change the captured value.
Use a new explicit `revision` and restart to rotate a credential. Literal secrets are not accepted in the document.

The host validates the complete selection, all manifests, grants, and environment references before importing selected code. It also verifies each artifact against its pinned ID and the host SDK, Node, and ABI identities before importing any selected entry.
Configuration decoding failures report `Invalid server extension configuration` without paths, secret names, values, or underlying exception text.
Staging verifies artifacts to retain their complete manifests in receipts without importing code. Activation verifies each artifact once after lifecycle admission, then imports those retained bytes. A fresh journal verifies separately for its initial receipt and activation. Failures report sanitized diagnostics.
The installed package loader then checks each entry's filesystem path and imported export. An earlier entry can execute import effects before a later entry fails its import or export checks.

Removing referenced variables reduces explicit inheritance by native child processes.
It does not isolate credentials from full-trust extensions, same-user processes, existing environment snapshots, or the same secret under another variable name.
Installed entries are trusted ordinary filesystem modules with host process privileges. Use distinct immutable installation directories for package revisions because Node caches imported module URLs.

Artifact entries also run with full host process privileges. The host imports the verified retained bytes, so later changes to artifact files do not change the loaded catalog. Under transient ownership, the programmatic server replacement method accepts artifact, installed, and empty selections through the same lifecycle owner.
CLI hosts configured with durable ownership use [durable selection](#durable-selection-and-explicit-live-application), followed by explicit live application or a restart. Admitted provider work defers replacement before candidate preparation; retry explicitly after the work settles. Replacement retires the old generation before verifying and importing the requested selection. Each artifact activation uses a fresh module generation, including repeated selection of the same bytes. A failed candidate leaves the old generation retired and reports the existing replacement or restart recovery classification. The host does not restore old code automatically.

## Call server operations from the client

A server entry reads its configured installations from `context.installations`. Each `ServerExtensionInstallation` has the grant `id`, the provider `instance`, the `service` origin and `expectedAuthority`. It holds no secret.
A provider contribution ID must equal the grant `id` of the installation it serves. An entry that serves every configured installation registers one provider per installation with `providers.add(installation.id, …)`.

`context.operations.add(id, operation)` registers a named operation. The ID matches `[a-z][a-z0-9.-]{0,63}`. A duplicate ID, an invalid ID or a registration after activation throws and fails the activation.
`operation.run({ installation, credential, input, signal })` receives the installation the client named, a credential handle the host issued for it (`null` when unauthenticated), a bounded copy of the input and an `AbortSignal`.
It returns `{ kind: 'ok', output, agentsChanged? }` or `{ kind: 'refused', code }`, where `code` matches `[a-z][a-z0-9-]{0,63}`.

Clients call an operation through the `extension-call` service operation with `namespace`, `installationId` (the `ProviderInstance.installationId`), `operation` and `input`.
The host replies `{ kind: 'ok', output }`, `{ kind: 'refused', code }` or `{ kind: 'failed', cause }`. The causes are `unknown-extension`, `unknown-installation`, `unknown-operation`, `unavailable`, `too-large`, `invalid-result`, `threw` and `timeout`.
Input is limited to 64,000 bytes of canonical JSON and output to 256,000 bytes. A thrown handler, malformed result or exception text never reaches the client.
The host replies within 15 seconds of admission, below the 20-second native transport deadline. At the deadline it aborts `signal`, replies `timeout`, releases the call's admission so replacement is not deferred, and discards a late result.
`agentsChanged: true` makes the host wait for any discovery that is already running, then start a fresh discovery, before it replies; a slow or failed discovery does not change the reply.
The channel gives no idempotency. An operation that changes remote state carries its own idempotency key inside `input`; after `timeout` or a lost reply the outcome is unknown, and the caller retries with the same key.

An error thrown inside a `credentials.use` action reaches the caller as one fixed opaque error. Code that needs to classify a failure catches inside the action and returns a typed value.
Operation code must pass `call.signal` to every request it makes. A request that ignores the signal keeps its `credentials.use` task pending and holds generation close.
`ServiceMetadata.extensions` lists each configured namespace with `state` (`active` or `failed`), its operation IDs and each installation's `available` or `unavailable` status. It contains no credential, handle or service origin. While a replacement is changing, it keeps listing the retiring generation's namespaces with every installation `unavailable`, and calls fail `unavailable` until the new generation is active.
Host close aborts every admitted operation's `signal` and replies `unavailable` at once, so shutdown does not wait for the operation deadline.
Full-trust extensions share one realm. The host's namespace and installation checks are the only enforcement.

## Contribute conversation views and actions

The [provider-free fixture](../../tests/extensions/contracts/fixture.ts) declares nested views and a conversation action.
Each module has an ID, label, React component, optional child modules, and optional actions.
IDs are local to sibling modules. Action IDs are local to their module.
The namespace, complete module path, and action ID together identify an action.
`validateConversationModules` rejects duplicate siblings or actions, blank names, malformed fields, and cycles.

Views and actions receive `ConversationModuleProps` with a captured conversation scope, activity, and commands.
Activity is the existing `ConversationDocument<Transcript>` with `domain`, `decisions`, and `receipts`.
The caller passes an immutable snapshot as props on each render.
Commands expose `send(text)`, `approve(pendingId, choiceId)`, and `cancel(runId)`.
Every command and contributed action returns `Promise<SubmitResult>`.
Preserve rejected admission and uncertain receipt states for the caller.
Resolving an action does not establish native execution success.

The desktop customization host renders nested modules as labeled sections after the transcript, before approvals and the composer.
Transcript and modules share one content scrollbar by default.
It renders declarative actions as labeled buttons, suppresses duplicate clicks while an action is pending, and reports the returned submission state.
The host reports rejected admission, rejected receipts, not-dispatched receipts, uncertain receipts, abandoned receipts, and thrown errors.
An abandoned receipt means the user stopped waiting on the command; it does not say whether the command ran.
An accepted or pending receipt does not mean the agent has finished.
Uncertain feedback points to the conversation recovery controls; the host never automatically replays an action callback.
Action state belongs to its namespace, complete module path, action ID, and current conversation.
Navigation gives the next conversation fresh props and feedback; late results stay with the previous view.
A descendant render failure removes only its extension, with its captured disposer called once.
Restore default view preserves the ordinary conversation and composer.

UI contributions may also replace the desktop transcript with `overrides: { transcript: MyTranscript }`.
`MyTranscript` is a React component receiving the same `ConversationModuleProps` as modules.
`modules` and `dispose` remain required. An override-only extension returns `modules: []`.
Function, memo, forwardRef, and lazy components follow the same validation as module components.
Unknown own or inherited override slots and malformed components are rejected.
Class transcript accessors are supported; ordinary prototype constructor metadata is ignored.
Changing author records or arrays after capture does not change the selected transcript, modules, or actions.
This captures presentation slots, not the internal behavior of full-trust component code.

```tsx
function MyTranscript({ conversation, activity }: ConversationModuleProps) {
  return <section aria-label="My transcript">
    <h2>{conversation.conversationId}</h2>
    {activity.domain.messages.map(message => <p key={message.messageId}>{message.text}</p>)}
  </section>;
}
// Returned from the existing activate function.
return { modules: [], overrides: { transcript: MyTranscript }, dispose() {} };
```

The desktop activates each namespace once for its contributions.
The override changes only transcript presentation. The ordinary composer, approvals, Stop, and command recovery keep their owners.
An activity override replaces command and file presentation while native messages, Markdown and sent images remain visible.
It receives `ConversationActivityProps`, which extends `ConversationModuleProps` with readonly `updates` equal to `connected`, `reconnecting` or `paused`.
Stopped provider observation takes precedence over the local conversation connection when deriving `updates`.
`connected` describes that connection, not whether the provider is producing events.
The canonical `activity.domain.activities` data retains unknown and terminal outcomes, revisions and truncation facts. The author controls their presentation.
Return `overrides: { activity: MyActivity }` to claim this combined command and file slot.
A claimed whole transcript takes precedence over selective activity, including its native fallback during loading or failure.
Activity loading, conflict or failure uses native activity without replacing messages or the protected composer.
An outer content layout fallback is fully native and does not mount another activity override.
The default transcript stays visible while any selected activation is pending or a lazy override is loading.
If multiple ready namespaces claim the transcript after all activations settle, the host reports their sorted names and keeps the default transcript.
A failed namespace releases its claim and disposes once; other namespaces remain available.
Restore default view removes all presentation contributions while preserving the composer and draft.
This slot does not provide a layout language, split conversations, or live artifact refresh.

The host calls `action.run(context)` directly.
The supplied commands already use the existing client command and outbox path; wrapping an action in another submission owner would contend with that path.
`commands.send(text)` submits explicit text without replacing the composer draft.
Controls are disabled when the conversation is unavailable, disconnected, busy, or responding.
Captured commands still validate the active conversation and availability at invocation; a saved callback cannot bypass those checks.
The client owns command IDs, persisted intent, and retries of captured commands.
The SDK supplies no second command identity mechanism and never retries arbitrary extension action callbacks.
Theme and platform controls remain direct imports from `@agentui/theme/react` and `@agentui/ui-primitives/desktop` or `/native`.

## Bundled in-repo extensions

Every package under the repository's `extensions/` directory is first-party. Its `package.json.agentui.extension` is its canonical manifest, its package name stays outside the `@agentui/` scope, and the default desktop build bundles its `desktop` entry through `agentui.sources` (`scripts/bundled-extensions.mjs`). Its server entry loads as an installed entry from the working tree through `serve --extensions` or `desktop --extensions`; the [launcher](../development/launcher.md#load-server-extensions-on-a-local-host) passes the file when every token variable is set. Restart the host after rebuilding an extension: Node keeps the module it imported.

## Contribute a workspace view

SDK 0.13.0 adds the optional `workspace` contribution: `{ label, component, transcript? }`. The label has 1 to 40 characters and names the extension in the Extensions view. `component` and the optional `transcript` follow the same function, memo, forwardRef and lazy rules as transcript overrides. Unknown keys are rejected.
The desktop rail shows Chats, Extensions and Settings. The Extensions view lists every namespace in the desktop selection and in `ServiceMetadata.extensions`, sorted by namespace, with a state of `Ready`, `Not configured`, `Unavailable`, `No view`, `Failed`, `Disabled` or `Loading` (while the desktop entry activates, or while the host has not yet reported its extensions, for example during startup or while it is unreachable). Selecting a row with a workspace renders its component inside an element with `data-extension-workspace="<namespace>"`; scope every stylesheet selector under that attribute. That element also contains the host-rendered `conversation` node, so the attribute alone does not keep a rule off the host composer, approvals or agent picker: scope element rules such as `button` or `h2` to your own containers, for example `[data-extension-workspace="crew"] :is(.crew-header, .crew-member-form) button`. The host conversation keeps the host styles; only theme tokens set by an enclosing `ThemeScope` reach it.

`WorkspaceViewProps` gives the component its namespace, installation status, this namespace's agents (with `installationId` and `providerAgentId`), its conversations (catalog order, paged with `more()`, except that a conversation created in this session is listed first until the list is next read from its first page, for example by `refresh()`; when the selected conversation's agent has a `providerAgentId`, the selected conversation is always among them, after the loaded pages when it is not on one yet; otherwise it is among them only if a loaded page lists it), the selected conversation and a host-rendered `conversation` node.
`open(scope)` and `create(agentId)` reject only a conversation or agent outside the namespace. Otherwise they resolve when the attempt ends, including an attempt that did not open or create anything: the application was busy, a pending creation needs recovery, the agent is unavailable or the host refused. `selected` stays unchanged, so react to a change of `selected`, not to the resolved promise. The host shows a refusal, a pending creation or an unavailable agent in the workspace status strip. An attempt made while the application is busy with another operation is ignored without a notice. `call(installationId, operation, input)` calls the extension's own server operations and never rejects: a transport failure resolves as `{ kind: 'failed', cause: 'unavailable' }`. `refresh()` re-reads metadata and the conversation list.
The host-rendered conversation keeps the composer, approvals, Stop, recovery and permissions. Inside a workspace it uses the workspace `transcript` when one is supplied, no `contentLayout` and no modules, and its agent control lists only the namespace's agents.

The application has one active conversation (decision D4). Opening a conversation in a workspace changes that same active conversation, so switching to Chats shows it selected. At most one conversation view is mounted at a time, and the draft is kept in the persisted draft store across views.
A workspace render failure retires its namespace once and returns the Extensions list with the row `Failed`. Restore default view disables workspaces with the other presentation contributions.

## Arrange conversation content

The optional top-level `contentLayout` contribution arranges the selected conversation's transcript and modules on desktop.
The opaque `transcript` node includes the selected transcript renderer and, when an override is active, the host's sent-image fallback. Images stay inside the same transcript area without a separate layout property. A full-trust layout author controls how these supplied nodes appear.
`ConversationContentLayoutProps` has exactly two readonly `ReactNode` properties, `transcript` and `modules`.
The transcript already reflects independent transcript override selection. The modules include nested views, actions, and namespace diagnostics.
Render each supplied node once and treat it as an opaque presentation value.
Inspecting, cloning, or rendering these elements' props is unsupported and does not provide an isolation boundary for full-trust code.
The typed layout props add no commands, draft editor, conversation selector, or lifetime API.

```tsx
import type { ConversationContentLayoutProps } from '@agentui/sdk/react';

function ReviewLayout({ transcript, modules }: ConversationContentLayoutProps) {
	return <div className="review-layout"><div>{transcript}</div><aside>{modules}</aside></div>;
}
return { contentLayout: ReviewLayout, modules, dispose() {} };
```

The [Plan review template](../../templates/customization/desktop/index.tsx) includes responsive CSS for this arrangement.
The host supplies one scroll viewport and an inline-size container. The template stacks its columns at or below 640px of available content width.
Permissions, approvals, the composer, Stop, command recovery, and navigation remain outside the layout.
Activation, failure, suspension, and restore preserve those controls for the same selected conversation.
Navigation retains the existing conversation identity and command checks. Layouts do not create independently active conversations.

The host captures `contentLayout` once with the same function, memo, forwardRef, and lazy rules as transcript components.
Layout selection waits for every selected namespace to settle. Multiple ready claims produce sorted diagnostics and the default transcript-then-modules arrangement.
An omitted layout uses that same default arrangement. Without an active conversation, namespace diagnostics remain visible in customization catalog order and layouts do not render.
Layout activation, conflict changes, and render failure can remount module and transcript views. Pending action feedback and duplicate-click suppression do not survive a remount.
Pending commands retain their original identities in the conversation outbox.

While a layout suspends, the host shows native messages, command and file activity, and a loading notice.
Custom transcript components, module views and actions, and namespace diagnostics wait until the layout is ready, so a retained hidden layout cannot duplicate extension trees.
Suspension does not retire a namespace. A render failure retires the failing namespace once and restores the default arrangement.
A nearer module or transcript boundary owns its failure. A layout in another namespace remains selected.
The layout boundary also catches render failures in host content beneath it.
Restore default view disables the contributions without replacing the composer or its persisted draft.

## Register a typed frontend tool

The UI context exposes `frontendTools.add(tool)`.
Each contribution supplies a protocol tool definition, a decoder from `unknown`, and an async handler returning a string.
The handler receives the pinned conversation scope.
The factory supplies the validated namespace and registration sink in an immutable activation context.
The `@agentui/sdk/react-tools` adapter includes tool validation.
The root and React presentation entries stay lightweight.
Import the adapter and the pin runtime from their separate entries:

```ts
import { createUiExtensionGeneration } from '@agentui/sdk/react-tools';
import { pinFrontendTools } from '@agentui/sdk/tools';

const { generation, presentation } = await createUiExtensionGeneration({
  namespace: manifest.namespace, generation: 'activation-1', platform: 'desktop',
  activate: context => entry.activate(context),
});
const pin = pinFrontendTools({ generations: [generation], platform: 'desktop', run, capabilities });
try {
  const binding = pin.bindings.find(value => value.name === `${manifest.namespace}__text_length`);
  if (binding) {
    const outcome = await pin.invoke(binding.name, { text: 'hello' }, binding.activationId);
  }
} finally {
  pin.release();
}
await generation.retire();
```

Render `presentation.modules`, `presentation.transcript`, and `presentation.contentLayout`, which contain captured presentation values.
The core generation factory captures raw disposal once. The UI adapter uses `parseUiExtensionPresentation` to capture presentation without inspecting disposal.
The standalone `parseUiExtensionContributions` parser shares that presentation parser and retains its own once-only disposal contract.
The returned presentation contains no disposal method.
Activation owners can supply `onFailure` to publish the primary failure before cleanup starts.
A pending observer does not delay starting cleanup.
The creation promise awaits both completions, preserving the original error and any later failures.
This activation support does not advertise tools to backends or deliver tool calls from the host.

- **Creation.** If activation throws or returns a value without a callable disposer, the callback owns cleanup of any partial activation.
Otherwise, the core captures its raw disposer once, then awaits `capture(value)`.
This decoder returns the actual presentation exposed as `contributions`, including `undefined` when there is no presentation.
Its return type needs no disposal method. The core retains raw cleanup even if capture throws synchronously or rejects asynchronously.
Creation disposes the acquired raw lifetime after capture failure and preserves both capture and disposal errors.
Any failed `frontendTools.add` fails the whole activation even when the extension catches it.
Invalid lifetime takes precedence over registration failure. Otherwise, creation rethrows the first registration error and skips presentation capture entirely.
Presentation getters run after registration closes and cannot add tools.
Creation waits for failed-activation disposal, so a disposer that never settles leaves creation pending.
Creation has no cancellation and registration stays open until activation settles.
An owner that abandons the wait must observe the promise and retire any generation it eventually returns.
An activation that never settles retains its partial resources.
A presentation capture that never settles retains the captured activation resources with registration closed.
- **Retirement.** The activation owner retains the generation and retires it when replaced.
Contributions are cooperative full-trust objects.
Call `generation.retire()` for cleanup instead of calling the contribution disposer directly.
Remove the generation from the active list in the same synchronous step that calls `retire()`, before awaiting its promise.
A pin request listing any retiring generation throws for the whole list.
The generation label is captured for diagnostics and owner correlation; the SDK does not enforce uniqueness.
Disposal runs once after all pins and calls drain.
Its failure rejects every retirement caller.
Always observe the retirement promise.
A replacement generation can activate before the previous generation disposes, so extensions must tolerate overlapping activations.
A disposer must not await its own generation's retirement, since retirement waits for that disposer.
- **Pins.** Existing pins and calls remain usable until released or settled.
Release every pin on every run outcome, including cancellation and failure.
A handler must not await retirement of any generation held by its own run's pin, since retirement waits for that pin.
A loader action reachable from a tool call must start retirement and return without awaiting it.
A handler that never settles retains its resources and leaves retirement pending.
A pin snapshots the run and definitions.
It holds only generations that contribute at least one tool.
Enabled client tool names must not match agent-provided names in `tools.items`.
It exposes definitions only when `tools.clientProvided` is true and `tools.supported` is not false.
Otherwise it holds no generation and refuses every call as `unknown-tool` until released.
Released pins refuse calls.
Handler errors reject and are never retried.
A loader must match tool calls to the correct pin; `RunIdentity` does not contain an AG-UI thread ID.

Tool names combine the manifest namespace, two underscores, and a local name matching `[A-Za-z][A-Za-z0-9_-]*`.
The combined name is limited to 64 characters.
Duplicate local names and duplicate selected namespaces are rejected.
Platform belongs to the activation generation, not individual tools.
A mixed desktop and iOS generation list is intentionally filtered to the pin's platform.
The `ag-ui` metadata key is reserved.
Contributed provider instance namespaces must match their validated extension manifest namespace, such as `crew`.

Parameters use a bounded JSON copy and an object-root inline draft-07 JSON Schema.
Schema-position `$ref`, `definitions`, `$id`, unknown keywords, nested or non-draft-07 `$schema`, and unsupported formats are rejected.
Literal boolean schemas remain valid in schema positions.
Annotation values such as `default`, `enum`, `const`, and `examples` are data.
Regular expressions use Unicode mode.
Registration normalizes omitted parameters and `{}` to `{ type: 'object' }`, which is both advertised and validated.
Arrays and primitives are refused.
Arguments are parsed values.
The loader parses accumulated argument text when a tool call completes and passes `{}` when that text is empty.
They are copied, validated, then decoded without coercion or defaults.
`decodeInput` must be synchronous.
Extensions are fully trusted; schema regular expressions can consume excessive time on hostile input.

Supported formats are `date`, `time`, `date-time`, `uri`, `uri-reference`, `uri-template`, `email`, `hostname`, `ipv4`, `ipv6`, `regex`, `json-pointer`, and `relative-json-pointer`.
They are asserted.
Every other format is rejected, including draft-07's `idn-email`, `idn-hostname`, `iri`, and `iri-reference`, and the common `uuid` and `duration` formats.
The validator's constructor rejects some valid schemas with dependencies named `id` or `$id`.
For example, `dependencies: { id: ['name'] }` is supported, but `dependencies: { id: [] }` is rejected.

Nonempty schemas and metadata retain their authored property order.
A provider adapter whose tool-schema dialect is narrower than draft-07 must translate or refuse the definition; the SDK does not.

The validator uses `@cfworker/json-schema` 4.1.6 and the [official draft-07 meta-schema](https://json-schema.org/draft-07/schema).
The source meta-schema is 4,979 bytes with SHA-256 `692e1d165e47afcb5f11b2ce1c639635ffa834035d6ecb6bcf3087481dae8404`.
The tools subpath owns this dependency; root and React runtime imports do not load it.
A browser test exercises the bundle under the desktop CSP.
React Native's global `URL` cannot set `hash` or resolve fragment references, which the validator requires.
iOS needs a standards-compliant `URL` before registering tools.
WKWebView and native Hermes have not been qualified.

This contract does not implement frontend-tool delivery, authorization, durable call claims, stream parsing, or protocol continuation.
It does not by itself justify advertising `tools.clientProvided`.
Installed extensions appear in the app after later loader and activation work.


### Durable selection and explicit live application

The version 2 `serve --extensions` configuration requires an explicit `ownership` of `durable-artifacts` or `transient`. Durable ownership accepts only artifact entries. Transient ownership accepts installed packages, artifacts, mixed selections, and empty selections, and refuses selection commands. Version 1 and missing ownership are rejected. Transient startup, including startup without extension options, refuses any existing durable selection journal before native drivers, extension imports, or listeners start. Programmatic callers choose `extensions: { kind: 'durable-artifacts', entries }` or `extensions: { kind: 'transient', entries }` explicitly. Durable ownership refuses direct `replaceProviderExtensions` calls.

On a fresh data directory, startup verifies the artifact pins and checks the receipt size before atomically creating the journal and accepting revision zero. Failed verification leaves no selection journal, so the directory remains eligible for transient startup. A complete, valid unseeded journal from an older version retains durable ownership and can be seeded by correcting the durable configuration. Partial or malformed journals are never repaired automatically.

Run the built host's actual entry point to inspect and stage a selection:

```sh
node apps/host/dist/main.js extensions-status --data-dir /private/host
node apps/host/dist/main.js extensions-select --data-dir /private/host --operation build-b --expected-revision 0 --selection /build/selection.json
node apps/host/dist/main.js extensions-status --data-dir /private/host --operation build-b --receipt /build/receipt.json
```

The selection file contains a version and ordered, absolute artifact pins:

```json
{"version":1,"artifacts":[{"directory":"/build/artifact-b","artifactId":"<64 lowercase hex characters>"}]}
```

Use `{"version":1,"artifacts":[]}` to disable every artifact at the next startup. Unused startup grants remain in the binding. A selection cannot edit grants or add authority. Keep provider instance identities unchanged when only artifact code changes.

Read `desiredRevision` before starting an external build and submit that revision when the build finishes. A newer accepted selection rejects the stale build. Caller operation IDs use 1–96 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit. `startup` identifies the initial revision-zero selection. Repeating an identical operation returns its recorded outcome; changing its intent refuses the reused ID. After connecting, select waits for its reply until completion or transport failure. A lost reply leaves admission uncertain. Query or resend the same ID before deciding what to do next.

A successful select reports `staged` and leaves the current provider generation running. Startup loads the durable pins even if the original launch artifact has been removed. The configured public grants must still match and credentials must be supplied again. The parser consumes environment credentials once and never stores credential values, resolver functions, or handles in the selection journal.

Apply an accepted selection without restarting:

```sh
node apps/host/dist/main.js extensions-apply --data-dir /private/host --operation build-b --expected-revision 1 --request apply-b
node apps/host/dist/main.js extensions-status --data-dir /private/host --attempt apply-b
```

`--operation` identifies the immutable selection. `--expected-revision` must equal its accepted revision and the current desired revision. Apply reads its original receipt and uses the fixed startup grants. It accepts no selection file or replacement grants. The selection must have no prior activation attempt. Select and apply are separate commands. A restart between them can consume the staged selection, after which apply refuses and status reports the boot attempt.

Active provider work produces a persisted `deferred` outcome before candidate artifact reads. Completing that work does not activate the candidate. Retry explicitly names the latest attempt:

```sh
node apps/host/dist/main.js extensions-retry --data-dir /private/host --operation build-b --expected-revision 1 --request retry-b --after-attempt apply-b
node apps/host/dist/main.js extensions-status --data-dir /private/host --attempt retry-b --receipt /build/receipt.json
```

A retry accepts deferred, interrupted, or failed attempts for the current desired selection. A grant mismatch requires restoring the original fixed grant binding first. A cleanup failure that requires restart blocks new apply and retry requests in that process without recording an attempt. After a real restart, explicit retry can use the clean lifecycle. Two new retry requests cannot both consume the same predecessor. Pending, applying, and successful attempts cannot be retried with a new request ID.

After connecting, apply and retry wait for a reply until completion or transport failure. If an apply or retry reply is lost, resend the identical `--request` and arguments or inspect `--attempt`. The existing request returns its exact historical attempt, even after later attempts, supersession, or restart. Changed intent under the same request ID refuses. A new request for a superseded selection also refuses. Selection and attempt IDs share a collision domain for new commands. `extensions-status --operation` selects a selection's latest attempt. `--attempt` selects one exact attempt. The flags are mutually exclusive, including for legacy IDs that occur in both histories.

Boot, apply, and retry share one durable attempt ledger. `attemptId` identifies the attempt in summaries and runtime identity. `applied` and `applied-empty` name successful historical outcomes. `runtime` describes the current process separately. It exposes an acknowledged selection only while its provider generation is current, or its acknowledged empty selection remains empty. Replacement retires the old generation before the observation pass and final journal commit. During that interval, `runtime` is `withheld`, the attempt remains `applying`, and `lastApplied` retains the previous success. A deferred replacement retains the still-active generation's identity. Startup converts unresolved pending and applying attempts to interrupted. A latest deferred, interrupted, failed, or grant-mismatched attempt withholds providers. Ordinary restart restores only a staged target or its latest settled success. There is no queue, automatic retry, or previous-success fallback.

A live mutation holds admission through artifact preparation, replacement, every saved-conversation page, and the final journal commit. A successful acknowledgement follows the complete observation pass. Individual provider observation failures retain their existing conversation status and do not imply that every remote feed resumed. An exception escaping the observation pass, a lost final journal write, or changed desired authority starts shutdown and freezes credentials. The initiating request receives a sanitized uncertainty error when its connection remains available. Journal errors while recording a selection or admitting an attempt also stop the host, even before any runtime effect. Those failures report `Selection unavailable` when the connection remains available. Shutdown can make subsequent status requests unavailable. Shutdown drains source preparation that was already admitted. Candidate module evaluation can finish during that drain, but the closing lifecycle refuses activation. Reopening an unresolved attempt never assumes that its effect did not happen.

The packaged CLI exits nonzero after fatal uncertainty even when cleanup succeeds. Programmatic hosts expose a non-rejecting `fatal` promise that resolves after fatal shutdown starts. `close()` separately reports cleanup completion or failure. The host does not change its caller's process exit status.

Journal version 2 migrates valid deployed version 1 history in one transaction. It preserves selection rows, receipt bytes and digests, and settled historical outcomes. Receipts remain version 1. An unseeded version 1 journal migrates only after startup verification succeeds. Older bundled hosts refuse version 2 journals before artifact import. A downgrade requires restoring a separately managed backup. The bundled host and CLI use the updated protocol together.

The local control socket limits requests to 4096 UTF-8 bytes and replies to 16000 bytes, including framing. Summaries omit paths and full manifests. Receipt export reads digest-addressed base64 chunks of at most 8192 raw bytes, validates contiguous offsets and the final SHA-256, and writes the complete JSON receipt. The journal retains complete immutable artifact manifests and source provenance. Receipts exceeding 16 MiB are refused before staging. Malformed journals expose `journal-invalid` and do not activate providers or accept new selections.
