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

The UI context exposes `frontendTools.add(tool)`. Each contribution supplies a protocol tool definition, a decoder from `unknown`, and an async handler returning a string. The handler receives the pinned conversation scope. Import the runtime from `@agentui/sdk/tools` when implementing an activation owner:

```ts
let contributions: unknown;
const generation = await createFrontendToolGeneration({
  namespace: 'notes', generation: 'activation-1', platform: 'desktop',
  async activate(frontendTools) {
    const result = await entry.activate({ namespace: 'notes', frontendTools });
    contributions = result;
    return result;
  },
});
try {
  validateUiExtensionContributions(contributions);
} catch (error) {
  await generation.retire();
  throw error;
}
const pin = pinFrontendTools({ generations: [generation], platform: 'desktop', run, capabilities });
try {
  const outcome = await pin.invoke('notes__text_length', { text: 'hello' });
} finally {
  pin.release();
}
await generation.retire();
```

Use `contributions.modules` to render validated modules and handle the returned tool outcome.
If activation throws before returning a lifetime, the callback owns cleanup of any partial activation. Perform later validation after generation construction so retirement owns cleanup. The activation owner retains the generation and retires it when replaced or when later module validation fails. Retirement immediately excludes new pins. Existing pins and calls remain usable until released or settled. Disposal runs once after all pins and calls drain; its failure rejects every retirement caller. Always observe the promise returned by `retire()`.

Release every pin on every run outcome, including cancellation and failure. A handler must not await retirement of its own generation, since retirement waits for that handler. A handler that never settles retains its resources and leaves retirement pending. A pin snapshots the run and definitions. It exposes definitions only when `tools.clientProvided` is true and `tools.supported` is not false. Released pins refuse calls. Handler errors reject and are never retried. A loader must match tool calls to the correct pin; `RunIdentity` does not contain an AG-UI thread ID.

Tool names combine the manifest namespace, two underscores, and a local name matching `[A-Za-z][A-Za-z0-9_-]*`. The combined name is limited to 64 characters. Duplicate local names and duplicate selected namespaces are rejected. Platform belongs to the activation generation, not individual tools.

Parameters use a bounded JSON copy and an object-root draft-07 JSON Schema. The supported keywords are draft-07 validation, applicator, and annotation keywords. Unknown keywords, `$id`, nested or non-draft-07 `$schema`, unknown formats, external or unresolved references, and recursive references are rejected. References must be local JSON pointers resolved by the validator to object-schema positions. A `$ref` node may carry only annotations alongside the reference. Literal boolean schemas remain valid in schema positions. Annotation values such as `default`, `enum`, `const`, and `examples` are data. Arguments are copied, validated, then decoded without coercion or defaults. Extensions are fully trusted; schema regular expressions can consume excessive time on hostile input.

The validator uses `@cfworker/json-schema` 4.1.6 and the [official draft-07 meta-schema](https://json-schema.org/draft-07/schema). The source meta-schema is 4,979 bytes with SHA-256 `692e1d165e47afcb5f11b2ce1c639635ffa834035d6ecb6bcf3087481dae8404`. The tools subpath owns this dependency; root and React runtime imports do not load it. A browser test exercises the bundle under the desktop CSP. React Native's global `URL` cannot set `hash` or resolve fragment references, which the validator requires. iOS needs a standards-compliant `URL` before registering tools. WKWebView and native Hermes have not been qualified.

This contract does not implement frontend-tool delivery, authorization, durable call claims, stream parsing, or protocol continuation. It does not by itself justify advertising `tools.clientProvided`. Installed extensions appear in the app after later loader and activation work.
