# WP8: Settings sections, Extensions page, appearance and default agent

## Goal

The user connects a customization repository in Settings and changes appearance and the default agent there. The Extensions page lists the repository's extensions with a toggle each, shows build progress, and applies a finished build.

Prerequisite state: WP7 merged.

## Repository evidence

- `apps/desktop/src/shell/BrowserApplication.tsx`: the Settings view has sections Connection (Reconnect), Pi and OpenCode Go, Appearance, and About this build. Appearance holds one sentence ("Follows system light or dark appearance.") and the `Enable customizations` checkbox bound to `customizationEnabled`, an in-memory `useState(true)`. `onRestore` disables customizations and returns to Chats.
- `apps/desktop/src/shell/Shell.tsx`: renders `<ThemeScope className="desktop-shell" …>` with no `appearance` prop.
- `packages/ui-primitives/src/desktop.tsx`: `ThemeScope` uses `appearance ?? (system preference at the root)`. `packages/theme/src/index.ts`: `Appearance = 'light' | 'dark'`.
- `apps/desktop/src/application/application-controller.ts`: `create` uses `agentId ?? host.defaultAgentId`. `ApplicationController` and `ApplicationSnapshot`; `refreshMetadata`.
- `packages/contracts/src/service.ts`: `ServiceMetadata.agents` and `defaultAgentId`; a provider `AgentDescriptor` has `namespace`, `installationId`, `providerAgentId`; a descriptor may have `model: { id, label }`.
- `apps/desktop/src/application/ComposerAgentControls.tsx`: groups agents into harness groups `pi`, `claude`, `codex`, `recorded`, `provider`, `other`, and lists models as separate agents. `apps/desktop/src/application/agent-presentation.ts` holds the labels.
- `apps/desktop/src/application/ExtensionsView.tsx`: `ExtensionRowState`, `openableRow()`, rows from the desktop selection and `metadata.extensions`, an Open control per row.
- `apps/desktop/src/application/browser-storage.ts`: persists views and drafts only.
- `tests/desktop/shell/browser.test.mjs` and `tests/application/extensions-view.browser.test.mjs` cover the rail, Settings and the Extensions view.

## Change surface

### Controller (`apps/desktop/src/application/application-controller.ts`, `use-application.ts`)

- `ApplicationSnapshot.customization` (new): the last `CustomizationStatus`, or `null` before the first read.
- Methods (new): `loadCustomization()`, `connectCustomization(input)`, `disconnectCustomization()`, `syncCustomization()`, `rebuildCustomization()`, `toggleExtension(key, enabled)`, `saveSettings(settings)`, `applyCustomization(buildKey)`. Each generates a `requestId`, sends the operation, and resolves when `results` holds that `requestId` or the operation was refused. Each resolves with the outcome and never rejects.
- A request never stays pending forever. It ends as `unknown` when: 200 seconds pass without a result; or the host reconnects and its status has neither `pending` nor a result for that `requestId` (the host restarted and lost it). The page then re-reads status and says: "The result is unknown. The page shows the repository's current state."
- Polling: the controller reads `customization-status` once after connecting to the host, then every 2 seconds while a request is pending, a build is in a non-final state, or the Extensions or Settings view is visible. Otherwise every 30 seconds, so that settings changed from another client arrive.
- `create(agentId?)`: when no `agentId` is given, use `resolveDefaultAgent(settings, metadata) ?? host.defaultAgentId`.
- `resolveDefaultAgent` (new, in a new file `apps/desktop/src/application/default-agent.ts`):
  - `{ kind: 'provider', namespace, installationId, providerAgentId }` matches the provider descriptor with those three values.
  - `{ kind: 'native', harness, model? }` matches agents in that harness group. Reuse the grouping function from `ComposerAgentControls.tsx` (export it); do not duplicate it. With `model`, match `agent.model.id`; without it, take the host default when it is in that group, otherwise the first agent of the group in the picker's order.
  - It returns an ID only for an agent whose availability is ready. Otherwise `null`.

### Appearance and extension views

- `apps/desktop/src/shell/Shell.tsx`: `DesktopShell` takes `appearance?: 'light' | 'dark'` (new prop) and passes it to the root `ThemeScope`. `system` passes nothing.
- `BrowserApplication.tsx`: `customizationEnabled` starts from `settings.showExtensionViews` once the first status arrives, and follows later changes of the setting. `Restore default view` still turns it off for the session only and does not write to the repository.
- Before the first status arrives, the client uses system appearance and shows extension views.

### Settings view (`apps/desktop/src/shell/BrowserApplication.tsx`, with new components beside `ConversationView.tsx`)

- `apps/desktop/src/application/CustomizationRepository.tsx` (new): the section `Customization repository`, placed after Connection.
  - Not connected: fields `Repository`, `Branch` (no default value; placeholder `customization`), `Subdirectory` (optional), and `Connect`. Help text: AgentUI clones the repository on the machine that runs the launcher, commits extension and settings changes to this branch, and pushes them with that user's git credentials.
  - When the branch is `main` or `master`, `Connect` asks for confirmation: "AgentUI will push commits directly to <branch>."
  - Connected: location, branch, subdirectory, short head commit, `Sync`, `Disconnect` (with confirmation that the applied build keeps running until the next apply).
  - `support: 'worker-offline'`: the section says the launcher is not connected, so the repository cannot be changed from here, and shows the last known connection read-only. The Mac app's native mode always shows this state.
- `apps/desktop/src/application/SettingsPreferences.tsx` (new): replaces the Appearance section's content.
  - `Appearance`: a group of three radio buttons, `System`, `Light`, `Dark`.
  - `Default agent`: a select with `Host default` and one option per ready agent, grouped as the composer groups them. The stored value is the portable selector from WP2: provider agents store namespace, installation and provider agent ID; native agents store harness and, when the agent has a model, the model ID.
  - `Show extension views`: a checkbox.
  - Each change calls `saveSettings` with the full settings object. While it is pending the controls are disabled.
  - With no connection or `worker-offline`: the controls are disabled, with one line that says settings are stored in the connected repository.
  - A stored default agent that matches no ready agent shows `Unavailable on this host` beside the select and falls back to the host default.
- Each failure cause has one fixed sentence. No raw error text is shown. Examples: `push-unauthorized`: "AgentUI could not push to the repository. Check the git credentials on the machine that runs the launcher." `identity-missing`: "Git has no user name and email configured on the machine that runs the launcher." `conflict`: "The repository changed. The page now shows the latest version; try again."

### Extensions page (`apps/desktop/src/application/ExtensionsView.tsx`)

- One row per reference in `customization.extensions`, sorted by label. The label is the running workspace's label when the extension is active, otherwise the namespace, otherwise the key.
- Extensions that are running but absent from the repository list (possible after a disconnect) follow, marked `Not in the connected repository`, without a toggle.
- Each row: label, key, a toggle (`role="switch"` with an accessible name that includes the label), and a state:
  - enabled and running: the existing running states (`Ready`, `Not configured`, `Unavailable`, `Failed`, `No view`, `Loading`), with `Open` as today. A grant listed in `running.omittedGrants` shows `Not configured` with the variable name to set.
  - enabled, not in the running build: `Enabled, not applied yet`.
  - disabled, still running: `Disabled, still running until applied`. `Open` stays.
  - disabled, not running: `Disabled`.
- Toggling calls `toggleExtension` with the current head. While a request is pending every toggle is disabled and the row shows `Saving…`. A failure shows its sentence, and the toggle shows the repository's value again.
- A status panel above the list, for the build of the current head:
  - non-final states: the phase and elapsed time;
  - `failed`: the sentence for its failure, `Rebuild`, and where the log is on the launcher machine (`customization/builds/<build key>/log.txt` under the AgentUI setup root). `sdk-mismatch` says the extensions on the connected branch target a different AgentUI version and that the branch needs the latest AgentUI changes merged. `toolchain-missing` says to run `npm run setup:browser` in the AgentUI checkout. `builder-changed` says AgentUI was rebuilt during the build and offers `Rebuild`;
  - `ready` and not the running build: `Apply and restart`, with one line that says the host restarts and the page reloads;
  - `ready` and running: nothing.
- `running.stale` true: a line that says AgentUI was updated and the customization is being rebuilt, or is ready to apply.
- `Apply and restart` calls `applyCustomization(buildKey)`. `active-work`: wait for running work. `missing-token`: names the variables to set in the launcher's shell before restarting AgentUI. `delivery-failed`: the build could not be copied to the host.
- No connection: an empty state with a button that opens Settings.
- `worker-offline`: the running extensions without toggles, and a line that says they cannot be changed until the launcher is connected.

### Accessibility

- Status changes go to one `role="status"` region. Failures use `role="alert"`.
- The appearance group is a labelled `radiogroup`.

## Behaviour and invariants

- A toggle never shows a position that differs from the repository's head except while its request is pending.
- Appearance and the default agent take effect without a restart, in every client that polls status.
- The UI never asks for or shows a token, a credential or git output.

## Tests and acceptance

All browser tests here use the dependency-free fixture and real builds from WP6, a real host started through the session wrapper, a real worker, and local bare remotes.

- `tests/application/customization-settings.browser.test.mjs` (new):
  - the form connects a repository and shows location, branch and head; a bad location shows its sentence; `main` asks for confirmation; `Disconnect` confirms and returns to the form;
  - choosing `Dark` creates one commit on the remote that changes only `agentui-settings.json`, and the root element's `data-appearance` becomes `dark` without a reload;
  - a second browser context loaded afterwards starts in dark appearance;
  - choosing a default agent stores the portable selector, and `New chat` then creates a conversation with that agent; a selector that matches no ready agent shows `Unavailable on this host` and the host default is used;
  - turning off `Show extension views` hides workspace contributions in a freshly loaded client;
  - with the worker stopped, the sections become read-only.
- `tests/application/extensions-view.browser.test.mjs` (extend):
  - no connection: the empty state, and its button opens Settings;
  - connected and applied: both fixture extensions are enabled with their running state;
  - turning one off disables all toggles during the save, creates one commit on the remote (assert with `git log` on the bare repository), shows the build phases, then `Apply and restart`;
  - applying restarts the host, the page reloads, the row reads `Disabled`, its workspace cannot be opened, and its agent is absent from the composer's agent picker;
  - a commit pushed to the remote by someone else before the toggle gives the `conflict` sentence and the refreshed list;
  - a failed build shows its sentence and `Rebuild`; `active-work` and `missing-token` show their sentences;
  - the host is restarted while a toggle is pending: the row leaves `Saving…`, the unknown-result sentence shows, and the toggles work again;
  - a missing token for one extension leaves the other extension `Ready` and shows `Not configured` with the variable name for the first.
- `tests/desktop/default-agent.test.mjs` (new): `resolveDefaultAgent` for provider and native selectors, with and without a model, with an unavailable match.
- An axe-core check on both Settings sections and on the Extensions page in each main state.
- `tests/desktop/shell/browser.test.mjs`: the default build's Extensions page shows the empty state.
- Manual check in the running app, including the Mac app if it can be built: report what was observed, or state that it was not run.
- `npm run verify` passes.

## Exclusions

- No UI for adding or removing references or editing installations.
- No settings beyond the three in the settings file.
- No iOS UI.
