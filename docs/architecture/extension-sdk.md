# Author an extension

The existing `@agentui/sdk` package exposes server contracts at its root and UI contracts at `@agentui/sdk/react`.
Installed server code runs with host process privileges.
Installed UI code runs with client process privileges.
Extensions are full trust. There is no sandbox or isolation promise.
Neither context exposes private host credentials to UI code.

## Declare and check an entry

Declare a namespace, `trust: 'full'`, `sdkVersion: EXTENSION_SDK_VERSION`, and at least one entry.
Each entry names `server`, `desktop`, or `ios` and a contained relative module path such as `./desktop.js`.
A manifest can declare each target once.

Call `parseExtensionManifest` on unknown metadata, then `checkExtensionEntrypoint(manifest, target, loadedExport)` before activation.
An incompatible result names an unsupported version, an undeclared or mismatched target, or an invalid entry export.
Parsing accepts declared version strings within the currently known manifest field shape so compatibility checking can report unsupported versions separately.
It does not parse speculative future manifest shapes.
Path checking validates syntax. The future loader must check filesystem containment and existence.
The caller has already imported the entry. Importing full-trust code can itself execute code.

A server entry implements `ServerExtensionEntry`.
Its context supplies `providers.add(id, provider)`, a generic method preserving the concrete `BackendProvider<Model, Installation>` type.
A provider-only entry requires no React import or UI bootstrap.
The existing [provider contract](provider-contracts.md) stays independent of UI activation.

A UI entry implements `UiExtensionEntry<'desktop'>` or `UiExtensionEntry<'ios'>`.
Its activation returns modules and a required `dispose` function, either directly or through a promise.
Call `validateUiExtensionContributions` on the returned contribution before rendering or invoking modules.
The activation owner withdraws contributions and calls disposal on deactivation.
It must also dispose a valid lifetime if later contribution validation fails.
For UI activation, check the lifetime first and retain it for cleanup before validating modules.
Behaviour checks accept class instances, accessors, and callable objects with the required fields.
They check field shapes, not arbitrary JavaScript behaviour.
A server activation likewise returns required disposal, checked with `validateExtensionLifetime`.
These contracts do not implement an activation manager or recovery after failed activation.

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
A `FrontendToolContribution<Input>` has the actual `RunAgentInput['tools'][number]` protocol definition, an `unknown`-to-`Input` decoder, and an `execute` handler returning `Promise<string>`.
The handler receives the captured conversation scope.
The fixture captures one concrete tool without a model call.

This registration contract does not implement frontend-tool delivery or justify advertising `tools.clientProvided` support.
Schema validation, collisions, platform availability, generation ownership, and pinned per-run definitions remain downstream work.
Runtime dispatch and execution claims also remain downstream work.
Installed extensions appear in the app after the later loader and activation work.
