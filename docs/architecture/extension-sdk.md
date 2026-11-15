# Author an extension

The existing `@agentui/sdk` package exposes server contracts at its root and UI contracts at `@agentui/sdk/react`.
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
A provider-only entry requires no React import or UI bootstrap.
The [provider contract](provider-contracts.md) stays independent of UI activation.
The server-only `credentials.use({ credential, service }, action)` resolves a host-issued handle for an authorized callback.
SDK compatibility is now `0.1.0`: authors must supply a presentation and hosts must supply the credential capability.
Workspace package versions remain `0.0.0`; service wire version 2 and transcript projection version 2 are unchanged.

A UI entry implements `UiExtensionEntry<'desktop'>` or `UiExtensionEntry<'ios'>`.
Its activation returns modules and a required `dispose` function, either directly or through a promise.
Call `validateUiExtensionContributions` on the returned contribution before rendering or invoking modules.
The activation owner withdraws contributions and calls disposal on deactivation.
It must also dispose a valid lifetime if later contribution validation fails.
For UI activation, check the lifetime first and retain it for cleanup before validating modules.
Behaviour checks accept class instances, accessors, and callable objects with the required fields.
They check field shapes, not arbitrary JavaScript behaviour.
A server activation likewise returns required disposal, checked with `validateExtensionLifetime`.
The host accepts already imported server entries through `startBrowserHost({ providerExtensions })`.
It stages all registrations before connecting, rejects duplicate contributions or full instances, and closes registration when activation settles.
Failed activation disposes earlier valid lifetimes; an entry that throws before returning a valid lifetime owns its partial activation cleanup.

## Load and replace server entries

`startBrowserHost` accepts imported `providerExtensions` and installed entries with this shape:

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
The production CLI does not yet select installed server entries from customization configuration.

The returned host exposes `discoverProviders()`, `extensionStatus()`, `replaceProviderExtensions(selection)`, and `close()`.
An empty selection disables local extensions. It does not send a provider cancel, delete, or other remote command.
The owner in `@agentui/host/extensions` manages one whole provider registry generation at a time.
The host supplies its `prepare()` callback only after replacement admission and successful old cleanup.
Preparation loads all entries before creating authorities and closes any authorities acquired before a preparation failure.
A custom host using `createServerExtensions()` must follow that same preparation ownership contract.
It returns `{ kind: 'ready', extensions }` to transfer authorities to the registry, or a fixed failure after its own cleanup.
If preparation cleanup fails, it returns `{ kind: 'failed', failure: 'cleanup', recovery: 'restart' }`.

`extensionStatus()` reports `empty`, `active`, `changing`, `failed`, `closing`, or `closed`.
An active status includes a generation number and the number of admitted discovery, creation, send, and original-operation lookup operations.
Replacement outcomes are:

- `replaced` includes the new generation number, or `null` for an empty selection.
- `deferred` with reason `active-work` leaves healthy admitted work and later operations on the original generation.
  It does not import the candidate, prepare authorities, revoke credentials, or dispose the original generation.
- `deferred` with reason `changing` refuses a competing change while an accepted change or failure cleanup is pending.
- `failed` reports a fixed failure category and recovery action.
- `unavailable` refuses replacement during or after shutdown.

A deferred request is not queued or remembered. Retry with the latest desired selection after work settles.
Continuous admitted work can postpone replacement indefinitely.
An accepted idle replacement stops discovery, creation, send, and lookup admission before any asynchronous work.
It awaits complete old disposal before importing or activating the next generation.
This ordering prevents overlap between activation-owned listeners, with an unavailable interval between generations.
Close during replacement prevents publication of the new generation and disposes every acquired valid lifetime once.

A load, authorization, activation, or discovery failure permits an explicit replacement only after successful cleanup.
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
An independent discovery failure can also start registry cleanup and revoke concurrent work.
The successful-result guarantee applies to healthy discovery, creation, send, and original-operation lookup across deferred replacement, not to shutdown or independent provider failure.
Independent credential callbacks and extension background work are not counted as admitted provider operations.
They keep the registry's existing close behavior.
Cooperative code that never settles can leave replacement or shutdown pending indefinitely.

The owner admits provider creation, send, and original-operation lookup. Send and lookup execution enter the generation pending count synchronously before provider delegation.
It does not own provider observation feeds or deliver frontend tools.
Each API request reads the active catalog. Retired, changing, disabled, and failed generations expose no choices.
Creation and command recovery retain the original installation, credential, and operation identity across replacement.
Command lookup never translates or resends the original request. A replacement that cannot match its original target leaves the existing outcome unchanged.
UI refresh does not invoke server replacement.
The remaining `agentui-ksx0` work must connect provider feed lifetimes and production CLI selection, then prove a slow delivered frontend tool survives a UI update.
Activation listener tests do not establish provider-feed or frontend-tool ownership.

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

The eventual production UI bridge must use the existing client command and outbox path.
Its `send(text)` implementation must submit explicit text as an intent.
It must not call `setDraft(text)` followed by send, which would overwrite the user's draft.
The client owns command IDs, persisted intent, and retries of captured commands.
The SDK supplies no second command identity mechanism and never retries arbitrary extension action callbacks.
Theme and platform controls remain direct imports from `@agentui/theme/react` and `@agentui/ui-primitives/desktop` or `/native`.

## Register a typed frontend tool

The UI context exposes `frontendTools.add(tool)`.
Each contribution supplies a protocol tool definition, a decoder from `unknown`, and an async handler returning a string.
The handler receives the pinned conversation scope.
The factory supplies the validated namespace and registration sink in an immutable activation context.
Import the runtime from `@agentui/sdk/tools` when implementing an activation owner:

```ts
const { generation, contributions } = await createFrontendToolGeneration({
  namespace: manifest.namespace, generation: 'activation-1', platform: 'desktop',
  accept: value => { validateUiExtensionContributions(value); return value; },
  activate: context => entry.activate(context),
});
const pin = pinFrontendTools({ generations: [generation], platform: 'desktop', run, capabilities });
try {
  const outcome = await pin.invoke(`${manifest.namespace}__text_length`, { text: 'hello' });
} finally {
  pin.release();
}
await generation.retire();
```

Use `contributions.modules` to render validated modules and handle the returned tool outcome.
- **Creation.** If activation throws or returns a value without a callable disposer, the callback owns cleanup of any partial activation.
Otherwise, creation captures its disposer once, then awaits the acceptance decoder.
The decoder may return the original contribution or a transformed contribution.
The raw activation result still owns disposal in either case.
Creation disposes a rejected contribution and preserves both validation and disposal errors.
Any failed `frontendTools.add` fails the whole activation even when the extension catches it.
Creation rethrows the first registration error before checking acceptance.
Creation waits for failed-activation disposal, so a disposer that never settles leaves creation pending.
Creation has no cancellation and registration stays open until activation settles.
An owner that abandons the wait must observe the promise and retire any generation it eventually returns.
An activation that never settles retains its partial resources.
An acceptance decoder that never settles retains the captured activation resources.
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
Contributed provider instance namespaces must match their validated extension manifest namespace, such as `example-crew`.

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
