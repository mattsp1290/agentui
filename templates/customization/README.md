# Build a local Plan review panel

Copy this directory into a local Git repository and commit it. The desktop module sends the shared review prompt to the selected conversation and shows the actual submission outcome. It leaves the composer draft untouched. Only committed source enters the build.

Use Node 24.22.3 within Node 24 and npm 11.19.1. Prepare AgentUI with its ordinary `npm ci` and `npm run build` first. Install the qualification browser with `npm run setup:browser`. From the AgentUI checkout, build a separate browser artifact with a full immutable commit ID and a new output directory.

```sh
node scripts/build-local-customization.mjs \
  --repository /absolute/personal-agentui \
  --commit FULL_COMMIT_ID \
  --out /absolute/custom-desktop
node apps/host/dist/main.js codex \
  --data-dir /absolute/private-host-data \
  --workspace /absolute/project \
  --assets /absolute/custom-desktop
```

The existing `pi` and `browser-dev` commands also accept `--assets`. Without it, startup uses the ordinary installed browser artifact. Open the host's browser address and select a conversation. Plan review and its nested Review guidance section appear beside the transcript, or below it in a narrow content area. Both share the content scrollbar. The host renders the declared Review the plan action and reports its result. Click **Review the plan** to submit the committed prompt. An accepted receipt means submitted, not completed. Uncertain outcomes use the existing conversation recovery controls.

To remove the panel, open Settings, expand View options, and choose Restore default view. The current conversation and draft remain available. Reloading the artifact enables the panel again.

Custom code has full browser privileges. This is not a sandbox. Only build code you trust.

## Package the protected Mac app

The artifact contains separate native `index.html` and cookie-based `browser.html` entries from the same build. Rebuild older browser-only artifacts before packaging.

On a Mac with the ordinary AgentUI and Tauri build prerequisites installed, use the `artifactId` printed by the customization builder. Choose a fresh output directory.

```sh
node scripts/package-native-customization.mjs \
  --artifact /absolute/custom-desktop \
  --artifact-id ARTIFACT_ID_FROM_BUILD \
  --out /absolute/custom-native-build
```

The command verifies the selected artifact and stages its retained bytes. It disables the stock frontend rebuild and embeds the native entry, which connects directly to the local host. It prints the actual `.app` path after Tauri succeeds. Open that app normally without `--host-url`. The output has its own Cargo target directory, so packaging preserves existing apps and the input artifact. Failed builds remove their own output.

Selecting this artifact gives its code full trust inside the protected app. Hashes verify the selected bytes, not the safety of that code. The manifest continues to describe the browser-development asset build; it does not certify a Mac build, distribution signing, or notarization.

When updating a local development build, keep the old app until the new package builds successfully. Quit the current app before opening a different local build. The new build connects to the same local host, and chats and drafts are retained.

## Supported inputs

`package.json.agentui.extension` is the existing SDK manifest. `sources` maps each declared runtime module to one committed source file. The runtime module path, such as `./dist/desktop.js`, is an identity in the manifest and does not need to exist in Git. The builder bundles desktop entries from the root and its pinned external graph with AgentUI, in declaration preorder. Each namespace keeps its own activation and cleanup. Activations run concurrently without a guaranteed order, so entries must not depend on another namespace's activation side effects. Duplicate namespaces and incompatible SDK manifests fail the build. Other platform declarations are preserved without building those targets. A graph without desktop entries builds the default application.

The builder accepts committed JavaScript, TypeScript, JSX, and TSX, external graph references, selected monorepo packages, and locked npm dependencies supported by the [source preparation rules](../../docs/customization/sources.md#prepared-sources). Use `--subdirectory packages/widgets` to select a monorepo package. Root repositories accept the same local paths and Git transports as the source API. Dependencies install into disposable copies with lifecycle scripts disabled. Repository build scripts and Vite configuration never run.

React, React DOM, SDK, contracts, protocol, theme, and desktop UI imports use the installed AgentUI packages, regardless of customization lock pins for those packages. Ordinary dependencies and workspace imports must resolve inside prepared repositories. Ambient machine dependencies and aliased copies of shared packages fail resolution. Vite handles contained CSS, JSON, and asset imports. Absolute imports, package import maps, Node builtins, computed loading, ambient references, and source JSX configuration remain unsupported. The AgentUI toolchain supplies compiler settings. Nested modules render as labeled sections. Declarative module actions render as labeled buttons with pending and submission feedback. IDs are local to siblings; the namespace and complete module path keep actions independent. Frontend tools are not implemented by this panel host.

Literal JavaScript URL assets require an exact dot-relative file inside prepared sources. Plain CSS URL assets and CSS imports also stay inside those sources. Computed asset patterns, ambiguous escaped paths, public-directory fallbacks, CSS modules, CSS `image-set`, and separate worker compilations are unsupported. Artifact asset names must use NFC and contained path segments without control characters or colons.

CSS assets require package ancestry without object-valued `browser` metadata around both source and target. This conservative rule also rejects unrelated map entries. Vite's reserved `@vite/` asset aliases are unsupported; explicit relative files such as `./@vite/client` remain ordinary assets. JavaScript-only browser maps still use guarded module resolution.

Source rules reject unsupported module lookups in authored code and installed dependencies. Runtime string evaluation is governed by the host CSP. An unused global-detection fallback inside a dependency is allowed.

The builder reserves a fresh output directory and generates the ordinary artifact manifest. Chromium serves retained verified bytes with the host's headers and activates every entry through the app's lifecycle. That lifecycle checks SDK compatibility and contribution validity. Qualification checks panel namespace order and readiness. Off-origin requests are blocked during qualification. It also checks that `index.html` starts under the native CSP. Native-session activation, component rendering, and conversation operations are not exercised by this gate. The builder verifies the inventory again before publication. Failed builds remove their output and private staging. An existing output is never replaced.

The hashed `customization-identity.json` asset records the ordered package graph, committed input and npm identities, manifests, and selected desktop modules. Each entry references its package and module; package records own the manifests. It excludes temporary paths and repository addresses. The ordinary artifact manifest retains the AgentUI source and lock provenance. The host verifies and retains the artifact bytes at startup.

## Source loader

The source APIs remain available separately through `@agentui/host/customization`. `readCustomizationSnapshot` reads one root snapshot. `resolveCustomizationSources` retrieves a pinned root and its external sources recursively, including selected monorepo packages and committed npm inputs. The desktop builder uses the preparation helper over this graph. See the [source API reference](../../docs/customization/sources.md) for ownership, supported inputs, trust, and limits.

Every read fetches the full commit into private storage and copies raw regular-file blobs. Working files, the index, refs, and `FETCH_HEAD` remain unchanged. Dirty and untracked changes are excluded. Executable bits are preserved; LFS pointers stay pointer bytes. Symlinks and Git submodules are unsupported.

Snapshots permit up to 20000 files and 256 MiB of materialized content. Individual Git commands are bounded to 30 seconds, with 120 seconds for retrieval. Dispose successful snapshots after use. Failed reads remove their own temporary directory.

## Optional iOS artifact contract

`@agentui/contracts` exports `OptionalIosArtifact` and `parseOptionalIosArtifact`. A version 1 descriptor declares either `absent` or `present`. A present artifact requires `embedded-full-native-build` delivery, the current SDK version, a sorted asset inventory, and a native runtime identity. `assertIosRuntime` compares the SDK, engine, engine version, format, React Native version, and native build identity exactly.

Parsing checks the descriptor shape. A future consumer must also hash `iosArtifactIdentityText` and call `assertIosArtifactId`, then verify each asset's bytes before acceptance. This desktop command does not emit or install iOS bundles. The contract does not enable iOS live updates.

### Replace transcript presentation

An activation can add `overrides: { transcript: MyTranscript }` alongside its required `modules` and `dispose` fields.
`MyTranscript` receives `ConversationModuleProps`, including current conversation scope, activity, and captured commands.
See the [SDK transcript example](../../docs/architecture/extension-sdk.md#contribute-conversation-views-and-actions).
Only transcript presentation changes. The ordinary composer, approvals, Stop, and recovery remain available.
The host retains the default transcript while selected activations or a lazy override load, and reports a conflict if multiple namespaces claim it.
A failed namespace is disposed once. Restore default view removes all presentation contributions and preserves the draft.

### Arrange transcript and modules

To replace only command and file presentation, return `overrides: { activity: MyActivity }`.
Its `ConversationActivityProps` adds readonly `updates` with `connected`, `reconnecting` or `paused` to the ordinary module context.
Native messages, Markdown and sent images remain host-owned. A selected whole transcript takes precedence over this activity slot.

The template returns `contentLayout: ReviewLayout`. Its `ConversationContentLayoutProps` contains only the host-created `transcript` and `modules` nodes.
The transcript includes any selected transcript override. Render each node once with ordinary React and CSS.
This desktop arrangement keeps permissions, approvals, the composer, Stop, and recovery under their existing host owners.
Omit `contentLayout` to use the transcript-then-modules stack. A suspended layout temporarily shows native activity while custom transcript and module views, actions, and namespace diagnostics wait.
SDK compatibility is `0.12.0` and requires an exact match in both the manifest and loaded entry. Rebuild older extensions.
