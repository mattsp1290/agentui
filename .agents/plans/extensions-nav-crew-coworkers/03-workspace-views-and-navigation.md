# WP3: Workspace views and the Extensions navigation item

## Goal

A UI extension contributes one full view. The rail gains an Extensions item between Chats and Settings. The Extensions view lists every installed extension and opens the selected extension's view.

Prerequisite state: gate G1 (WP1 and WP2 merged).

## Repository evidence

- `packages/sdk/src/react.ts`: `UiExtensionContributions` has `modules`, `contentLayout?`, `overrides?` and `dispose`. `parseUiExtensionContributions` and `parseUiExtensionPresentation` capture presentation once and reject unknown slots.
- `apps/desktop/src/application/DesktopCustomizations.tsx`: `DesktopCustomization` is `{ manifest; load() }`. `useDesktopCustomizations` activates each namespace once through `createUiExtensionGeneration`. Its namespace list is empty while customizations are disabled.
- `apps/desktop/src/shell/BrowserApplication.tsx`: `useState<'chats' | 'settings'>`; the `<nav className="view-rail" aria-label="Workspace views">` with two buttons; the sidebar `controls`, which is the only place that renders the storage-failure, incompatible-host, error and captured-sends alerts and the pending-creation recovery control; `views`, which mounts `ConversationView` for `app.active` with `composerControls`, `contentLayout` and `modules`; `settings`, which holds the customization checkbox; `onRestore`, which disables customizations and resets to `'chats'`.
- `apps/desktop/src/shell/Shell.tsx`: `DesktopShell` props `defaultView`, `settingsView`, `activeView?: 'chats' | 'settings'`. It keeps both `.shell-view` divs mounted and toggles `hidden`. Each sits inside `ContentBoundary`. `data-workspace-view` is set on the `ThemeScope`.
- `apps/desktop/src/application/application.css`: grid `56px 232px minmax(0,1fr)`; `.view-rail .settings-view-button { margin-top: auto; }`.
- `apps/desktop/src/application/ConversationView.tsx`: `ConversationView` accepts `transcript?`, `activity?`, `contentLayout?`, `modules?`, `composerControls?`. It renders `<textarea id="message">` and keeps per-instance draft, stop and approval state.
- `apps/desktop/src/application/application-controller.ts`: `ApplicationController` owns one `active: OpenConversation | null` and one catalog (`catalog`, `moreConversations`), updates previews live, and prepends newly created conversations. `apps/desktop/src/application/use-application.ts` exposes it through `useSyncExternalStore`.
- `tests/desktop/shell/browser.test.mjs` asserts the rail with role queries.
- `tests/application/browser-support.mjs`: `fixture(t)` spawns `browser-dev`, which does not accept `--extensions`; `page()` waits for the `New recorded conversation` button; `customRuntime(page, host, selection)` bundles `BrowserApplication` with an injected selection and serves it without the production CSP.
- `tests/extensions/providers/conformance/harness.mjs` starts a host in process with `startBrowserHost` and transient extension entries.
- `tests/extensions/contracts/fixture.ts` is the provider-free UI fixture.

## Change surface

### SDK (`packages/sdk/src/react.ts`)

- `UiExtensionContributions.workspace?` (new) of type `WorkspaceContribution` (new):

```ts
// proposed shape
interface WorkspaceContribution {
  label: string;                                   // 1–40 characters, shown in the Extensions list
  component: ComponentType<WorkspaceViewProps>;
  transcript?: ComponentType<ConversationModuleProps>; // used only inside this workspace
}
interface WorkspaceViewProps {
  readonly installations: readonly { installationId: string; status: 'available' | 'unavailable' }[];
  readonly agents: readonly WorkspaceAgent[];      // this namespace only
  readonly conversations: {
    readonly entries: readonly WorkspaceConversation[];
    readonly hasMore: boolean;                     // last page length equalled the page limit
    more(): void;
  };
  readonly selected: ConversationScope | null;     // the application's active conversation when it belongs to this namespace
  readonly conversation: ReactNode;                // host-rendered; null when nothing is selected
  open(scope: ConversationScope): Promise<void>;
  create(agentId: string): Promise<void>;
  call(installationId: string, operation: string, input: Json): Promise<ExtensionCallValue>;
  refresh(): Promise<void>;                        // re-reads metadata and the workspace conversation list
}
interface WorkspaceAgent { id: string; label: string; installationId: string; providerAgentId: string | null; availability: unknown /* the existing AgentDescriptor availability type */ }
interface WorkspaceConversation { scope: ConversationScope; preview: string | null; provider: { installationId: string; providerAgentId: string } }
```

- The parser validates `workspace` with the same component rules as `overrides.transcript` (function, memo, forwardRef, lazy). It rejects unknown keys and a blank or over-long `label`.
- `EXTENSION_SDK_VERSION` becomes `'0.13.0'`. Update the pinned literals as in WP1.

### Desktop controller (`apps/desktop/src/application/application-controller.ts`, `use-application.ts`)

- `ApplicationSnapshot.workspaces` (new): a map from namespace to `{ entries, hasMore, loading }`, filled by the `catalog` operation with `filter: { kind: 'namespace', namespace }`.
- `ApplicationController.loadWorkspace(namespace)`, `moreWorkspace(namespace)` (new): first page and next page.
- `ApplicationController.refreshMetadata()` (new): re-reads `metadata` and replaces `host.metadata`.
- `ApplicationController.extensionCall(namespace, installationId, operation, input)` (new): forwards to the connection.
- When `create` opens a conversation whose agent has a namespace, the controller prepends it to that namespace's workspace list as it already prepends to the main catalog. Live preview updates apply to both lists.
- Unit tests for these methods go beside the existing controller tests in `tests/desktop/`.

### Desktop shell

- `apps/desktop/src/shell/BrowserApplication.tsx`:
  - The view state union becomes `'chats' | 'extensions' | 'settings'`.
  - The rail renders three buttons in the order Chats, Extensions, Settings. The Extensions button has `aria-label="Extensions"`, `aria-pressed`, and an inline SVG like its siblings. Settings keeps `settings-view-button` and stays pinned to the bottom.
  - The sidebar title shows `Extensions` for the new view.
  - `ConversationView` for the Chats view is created only while `selectedView === 'chats'`. See "One mounted conversation".
- `apps/desktop/src/shell/Shell.tsx`: `activeView` accepts `'extensions'`. `DesktopShell` gains `extensionsView` (new prop) rendered in a third `.shell-view` inside its own `ContentBoundary`.
- `apps/desktop/src/application/ExtensionsView.tsx` (new, beside `ConversationView.tsx`): the list and the selected workspace.
- `apps/desktop/src/application/application.css`: styles for the list and for a workspace that fills the content area. With a workspace open, the workspace owns the area right of the rail and the 232px sidebar column collapses. The host alerts and the pending-creation recovery control move into a host-owned status strip above the workspace, so they stay visible. Extract them from `controls` into one component used by both places.

### Extensions view behaviour

- The list is the union of:
  - namespaces in the desktop selection (the static selection list, so that a disabled extension still appears), and
  - namespaces in `metadata.extensions` (WP1).
- Sort by namespace. Each row shows the `workspace.label` when present, otherwise the namespace.
- Row state, one of:
  - `Ready`: a workspace is present and at least one installation is `available`.
  - `Not configured`: a workspace is present and `metadata.extensions` has no installation for the namespace.
  - `Unavailable`: every installation is `unavailable`. Show the fixed sanitized reason the agent chooser already uses.
  - `No view`: the namespace has no workspace contribution. The row is not selectable.
  - `Failed`: UI activation failed, or `metadata.extensions` reports `state: 'failed'` for the namespace. Show the existing namespace diagnostic or a fixed server-side failure message.
  - `Disabled`: customizations are turned off (the Settings checkbox or `Restore default view`). The row names the Settings control that turns them on. The row is not selectable.
- Selecting a row with a workspace renders its `component`. A back control returns to the list. The selected namespace persists across view switches for the session (plain component state).
- `Not configured` and `Unavailable` workspaces still render. The extension shows its own setup guidance.

### One mounted conversation

- At most one `ConversationView` for the active conversation exists in the DOM at any time.
- The Chats view mounts it only while Chats is the selected view. The Extensions view mounts it only while Extensions is selected, a workspace is open, and the active conversation belongs to that workspace's namespace.
- The draft is persisted by the existing draft storage, so switching views keeps the draft text. Confirm this in the test below. If the draft is held only in component state, lift it into the existing persisted draft path before changing the mount rule.

### Host-rendered conversation inside a workspace

- `props.conversation` is `<ConversationView …>` for the application's `active` conversation when that conversation's stored `provider.namespace` equals the workspace's namespace. Otherwise it is `null`.
- The host passes `workspace.transcript` as the `transcript` prop. Without one, it passes the transcript the global selection chose.
- Inside a workspace the host passes no `contentLayout` and no `modules`. The workspace owns the layout. The global `activity` override applies as it does in Chats.
- `composerControls` inside a workspace lists only that namespace's agents.
- The composer, approvals, Stop, recovery and permissions stay inside the host-rendered node.
- `props.create(agentId)` calls the controller's `create` with that agent and leaves the user in the Extensions view. An `agentId` outside the namespace rejects.
- `props.open(scope)` calls the controller's `open`. A scope that is not in the namespace's workspace list rejects.
- `props.call` passes the extension's own namespace. This is a convenience for authors. The host enforces namespace and installation (WP1). `props.call` never rejects: a transport failure or client timeout resolves as `{ kind: 'failed', cause: 'unavailable' }`.
- The host wraps each workspace in an element with `data-extension-workspace="<namespace>"`. Extension stylesheets scope every selector under that attribute (WP6, WP8).

### Failure and lifetime

- A render failure inside a workspace component retires that namespace once, calls its disposer once, and returns the user to the list with the row in `Failed`. This reuses the retirement path that module failures use.
- A lazy workspace component shows a loading notice inside the Extensions view.
- `Restore default view` disables workspace contributions together with the other presentation contributions and switches to `'chats'`. The Extensions list then shows `Disabled` rows.
- Changing `props` never remounts the host-rendered conversation unless the selected conversation changes.

## Decision D4 consequence

Opening a conversation in a workspace changes the application's single `active` conversation. Switching to Chats shows the same conversation selected. State this in `docs/architecture/extension-sdk.md`.

## Tests and acceptance

- New helper `extensionFixture(t, { extensions })` in `tests/application/browser-support.mjs`: it starts a host in process with `startBrowserHost({ agentStartup: { kind: 'recorded' }, extensions: { kind: 'transient', entries } })`, as `tests/extensions/providers/conformance/harness.mjs` does, and serves `apps/desktop/web-dist-browser`. It returns the same shape `fixture(t)` returns, so `customRuntime` and `page` work with it. `page` takes an option for which control to wait for.
- The WP3 fixture extension has namespace `fixture`. Its server entry registers the ledger conformance provider (`tests/extensions/providers/conformance/ledger.mjs`) and one echo operation. Its UI entry contributes a workspace and a workspace transcript. The UI entry is injected with `customRuntime`.
- `tests/desktop/shell/browser.test.mjs`:
  - the rail has `Chats`, `Extensions`, `Settings` in DOM order;
  - `Extensions` sets `aria-pressed="true"` and the sidebar title;
  - the 360px-wide case still shows all three buttons.
- New `tests/application/extensions-view.browser.test.mjs` (directory already globbed):
  - the list shows the fixture's label and `Ready`;
  - opening it renders the component with the ledger agents in `props.agents`;
  - `props.create` with a ledger agent opens a conversation and `props.conversation` shows the composer;
  - sending a message from that composer appears in the workspace transcript;
  - `props.call` reaches the echo operation and returns its output;
  - exactly one `#message` element exists in the document while the workspace is open, and again after switching to Chats;
  - a draft typed in the workspace is present after switching to Chats;
  - the same conversation renders the workspace transcript in the workspace and the default transcript in Chats;
  - the composer's agent control inside the workspace lists no native or recorded agent;
  - `props.create` with a recorded agent's ID rejects;
  - an uncertain creation started from the workspace (the ledger fixture withholds its reply) shows the recovery control while the workspace is open;
  - `props.call` resolves `unavailable` when the host is stopped mid-call;
  - a throwing workspace component gives `Failed` and leaves Chats usable;
  - a namespace with no workspace shows `No view`;
  - after `Restore default view` the row shows `Disabled`.
- `tests/extensions/contracts/ui-capture.test.mjs`: `workspace` capture, unknown key rejection, label bounds.
- An axe-core check on the Extensions list and an open workspace, following the pattern in `tests/theme/browser.test.mjs`.
- `npm run verify` passes.

## Exclusions

- No iOS rendering of workspaces. `UiExtensionEntry<'ios'>` may return `workspace`; nothing activates it.
- No URL routing or deep links.
- No per-extension settings page.
