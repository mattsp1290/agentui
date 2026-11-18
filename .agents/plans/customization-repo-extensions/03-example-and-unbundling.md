# WP3: The example customization and removal of default bundling

## Goal

This repository contains an example customization package, in a subfolder, that enables both extensions. The default desktop build contains no extensions.

Prerequisite state: gate G1 (WP1's bundling proof passed and WP2 merged).

## Repository evidence

- `scripts/bundled-extensions.mjs`: `bundledPlan()` scans `extensions/*`.
- `apps/desktop/vite.config.mjs`: `desktopConfig(mode, plan = bundledPlan())`.
- `scripts/build-local-customization.mjs`: merges the bundled plan with the external plan and calls `desktopConfig('browser', merged)`.
- `scripts/lib/customization-plugin.mjs`: `mergePlans` rejects a namespace that is both bundled and external.
- `scripts/desktop-customization-qualifier.mjs`: checks that the activated namespaces equal the plan's entries.
- Tests that rely on the bundled build: `extensions/crew/tests/desktop.browser.test.mjs`, `extensions/coworkers/tests/desktop.browser.test.mjs`, `tests/customization/build/bundled-extensions.test.mjs`, the default-build case that lists `Crew` as `Not configured`, and `tests/customization/build/local-build.test.mjs` (expects the bundled namespaces).
- `docs/customization/sources.md` has a paragraph on bundled in-repo extensions (decision D10 of the earlier plan). `docs/architecture/extension-sdk.md` and `docs/development/launcher.md` describe bundling and the setup-root `extensions.json`.
- `examples/` holds `generated-text-output` and `mcp-control`. The root `package.json` lists the example workspaces explicitly.
- A customization root with no dependencies that is not a workspace member has npm inputs `absent` (`docs/customization/sources.md`).

## Change surface

### Example customization

- `examples/customization/package.json` (new directory beside `examples/generated-text-output`). It is not added to the root `workspaces` and has no dependencies.

```json
{
  "name": "agentui-example-customization",
  "version": "0.0.0",
  "private": true,
  "agentui": {
    "extensions": [
      { "subdirectory": "extensions/crew", "enabled": true },
      { "subdirectory": "extensions/coworkers", "enabled": true }
    ],
    "installations": [
      { "id": "personal",
        "instance": { "namespace": "crew", "installationId": "personal", "generation": "1", "protocolVersion": "1" },
        "service": "http://127.0.0.1:8080",
        "expectedAuthority": "remote-provider",
        "authentication": { "kind": "environment", "variable": "AGENTUI_EXTENSION_CREW_TOKEN", "revision": "1" } },
      { "id": "personal",
        "instance": { "namespace": "coworkers", "installationId": "personal", "generation": "1", "protocolVersion": "1" },
        "service": "http://127.0.0.1:8787",
        "expectedAuthority": "remote-provider",
        "authentication": { "kind": "environment", "variable": "AGENTUI_EXTENSION_COWORKERS_TOKEN", "revision": "1" } }
    ]
  }
}
```

- The implementer confirms the Coworkers `protocolVersion` the provider expects (`extensions/coworkers/src/provider.ts`) and the Crew gateway's default port before committing the example. The service addresses are placeholders for a local setup.
- `examples/customization/agentui-settings.json` (new): `{ "version": 1, "appearance": "system", "showExtensionViews": true }`.
- `examples/customization/README.md` (new) states:
  - how to connect the example: the AgentUI repository's location, the subdirectory `examples/customization`, and a branch;
  - that the worker commits and pushes to that branch, so the supported use is a dedicated branch (for example `customization`) or a fork, not `main`;
  - that the extension source on the connected branch must target the running AgentUI's SDK version, so the branch is merged forward after an SDK bump;
  - to change the service addresses and set the two token variables;
  - that Coworkers create and delete need `api.manage_coworkers: true` on the service;
  - that the extension code that runs is the code on the connected branch, so every extension change merged to `main` reaches a user only after `main` is merged into the connected branch.

### Remove default bundling

- `apps/desktop/vite.config.mjs`: `desktopConfig(mode, plan = null)`. With no plan the selection module stays the committed empty array.
- `scripts/build-local-customization.mjs`: build the external plan alone. Remove the merge with a bundled plan.
- `scripts/lib/customization-plugin.mjs`: `mergePlans` is removed if nothing else uses it.
- Move `scripts/bundled-extensions.mjs` to `tests/support/working-tree-plan.mjs` (new path under the existing `tests/support` directory) and rename its export to `workingTreePlan`. It is test support only.
- Root `package.json`: add a script `build:test-extensions` (new) that runs a Vite browser build with `desktopConfig('browser', workingTreePlan())` into `apps/desktop/web-dist-extensions-test` (new output directory, added to `.gitignore` and to `scripts/clean.mjs` and to the output exclusions in `scripts/artifact-manifest.mjs`). The `build` script runs it last. The product bundle `apps/desktop/web-dist-browser` no longer contains extensions.
- `tests/application/browser-support.mjs`: `extensionFixture` takes an `assets` option. Extension browser tests pass the test bundle.

### Tests to change

- Both extension browser test files use the test bundle.
- `tests/customization/build/bundled-extensions.test.mjs` becomes a test of `workingTreePlan` (rename the file accordingly).
- The default-build browser test now asserts that the Extensions view lists no extension. WP8 adds the connect hint.
- New assertion on both product bundles: no file under `apps/desktop/web-dist-browser` or `apps/desktop/web-dist` (the bundle the Mac app embeds) contains either extension's workspace attribute value or component code. Search the built files for the `data-extension-workspace` values and for a distinctive string from each extension's desktop source, and assert the customization selection module resolved to an empty list.
- `tests/customization/build/local-build.test.mjs`: the external build activates only the external namespaces.

### End-to-end proof with the CLI

- New `tests/customization/build/example-customization.test.mjs`, with the same fixture method and the same two tiers as WP1's test.
  - Default tier (offline): resolving the root `examples/customization` yields the two extension packages from one acquisition and both grants.
  - Network tier (`AGENTUI_CUSTOMIZATION_NETWORK_TESTS=1`): run the desktop build and the server build at the fixture's commit. Assert that the desktop artifact activates `coworkers` and `crew` and that the server artifact's catalog holds both namespaces. Then flip Coworkers to `enabled: false` in the fixture, commit, rebuild, and assert only `crew` remains in both artifacts.
  - The network tier is part of gate G1's recorded run.

### Documentation

- `docs/customization/sources.md`: remove the bundled-extensions paragraph; add the example.
- `docs/architecture/extension-sdk.md` and `docs/extensions/crew.md`, `docs/extensions/coworkers.md`: replace "bundled" with "enabled through a customization repository". Mark the setup-root `extensions.json` as removed in WP7.

## Behaviour and invariants

- Between WP3 and WP7, the launcher-started app has no extensions unless the user builds the example by hand and passes `--assets` and `--extensions`. The handoff states this interim state. WP3 and WP7 should land close together.
- The setup-root `extensions.json` flow in `scripts/agentui-launch.mjs` stays until WP7 replaces it.

## Tests and acceptance

- The tests listed above pass.
- `git grep -n -i "crew\|coworker\|crabber" -- apps packages scripts templates` shows no match (the boundary test enforces it).
- `npm run clean`, then `npm run desktop:build`, succeeds.
- `npm run verify` passes.

## Exclusions

- No host or UI change.
