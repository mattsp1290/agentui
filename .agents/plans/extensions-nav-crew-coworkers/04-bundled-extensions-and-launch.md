# WP4: The `extensions/` directory, desktop bundling and launcher configuration

## Goal

In-repo extensions live in one directory with canonical manifests. The default desktop build includes their UI entries. The `desktop` host command and the launcher load their server entries from a user configuration file.

Prerequisite state: WP3 merged.

This work package ships in two pull requests: 4a (move) and 4b (bundling and launch).

## Repository evidence

- `examples/crew/package.json` is `@agentui/example-crew` with exports `.`, `./file-intents`, `./provider`. It has five `file:../../vendor/...` dependencies: `@birbcrew/client` from `vendor/crew-client/dfe1c288bc4f0e338011389e10ad35656d6e4154/birbcrew-client-0.1.0.tgz` and four `@ag-ui/*` tarballs. The root `package.json` has an `overrides` entry for `@birbcrew/client@0.1.0`.
- `crewProvider(options)` in `examples/crew/src/provider.ts` returns `{ manifest, entry }` built in code. The package has no `agentui.extension` and no default-export server module. `examples/crew/run.mjs` uses grant `id: 'member'` to match `providers.add('member', …)`.
- Files that reference `examples/crew` or `@agentui/example-crew` (from `git grep -l`): `docs/architecture/boundaries.md`, `docs/architecture/extension-sdk.md`, `docs/development/observability.md`, `docs/extensions/provider-contract.md`, `docs/qualification/crew.md`, `package.json`, `package-lock.json`, `spikes/crew/qualification.json`, `tests/application/provider-connections.test.mjs`, `tests/application/provider-credentials.test.mjs`, `tests/application/server-extension-cli.test.mjs`, `tests/extensions/providers/conformance/harness.mjs`, `tests/extensions/providers/conformance/providers.mjs`, `tests/extensions/providers/contracts/crew.ts`, `tests/host/extensions/artifact-support.mjs`, `tests/host/extensions/fixtures.mjs`, `tests/host/extensions/fixtures/selection-journal-v1.json`, `tests/host/extensions/selection-next-start.test.mjs`, `tests/host/server-extension-config.test.mjs`, and files inside `examples/crew`.
- `apps/desktop/src/application/customization-selection.ts` exports `[]`.
- `scripts/local-customization.mjs`: `customizationPlugin(plan)` replaces the selection module in a `load` hook, with `enforce: 'pre'`. It enforces an import policy and a CSS policy (`customizationCssPolicy`). Its `reserved` rule rejects any contained source whose owning package name starts with `@agentui/` with `Duplicate shared customization dependency`. `desktopPlan` builds a plan (`roots`, `entries`) through `planCustomizationCatalog` and `desktopCustomizationIdentity` (`packages/host/src/customization/catalog.ts`).
- `scripts/build-local-customization.mjs` builds with `configFile` set to `apps/desktop/vite.config.mjs` and adds `customizationPlugin(plan)`.
- `scripts/desktop-customization-qualifier.mjs` requires the activated namespaces to equal the plan's entries.
- `apps/desktop/vite.config.mjs` has `plugins: [cssUrlExpressions()]` and no customization plugin.
- `docs/customization/sources.md` says: "Sibling workspace customization does not activate automatically."
- `templates/customization/package.json` shows the manifest plus `agentui.sources` mapping `./dist/desktop.js` to `./desktop/index.tsx`. The template ships no CSS file.
- `apps/desktop/src-tauri/tauri.conf.json`: the Tauri CSP has `style-src 'self'` without `unsafe-inline`. Tauri dev and bundle run `desktop:prepare` and `desktop:build` first; `desktop:prepare` in the root `package.json` does not build `@agentui/host`.
- `scripts/local-customization.mjs` imports `@agentui/host/customization`. The plan's `roots` come from each node's `repositoryDirectory` (`packages/host/src/customization/catalog.ts`), and the plugin polices every file under a root.
- `scripts/artifact-manifest.mjs`: the `dist` exclusion pattern covers `apps`, `packages` and `examples`, and the product-source directory list is `apps`, `packages`, `scripts`, `tests`, `examples`.
- `examples/crew/tsconfig.json` includes only `src/**/*.ts` and has no JSX setting. The package has no React or UI package dependency.
- `examples/crew/src/provider.ts` parses `options.memberId` as a required UUID. The installation schema in `apps/host/src/server-extension-config.ts` has no member field.
- `apps/host/src/main.ts`: `COMMANDS.desktop` is `['port', 'workspace', 'assets', 'executable', 'preferred']`. The shared branch already reads `values.extensions` through `takeServerExtensionConfiguration` for any command that allows the flag. `browser-dev` allows only `port` and `assets`.
- `apps/host/src/server-extension-config.ts` fails startup when a referenced token variable is missing or blank.
- `scripts/agentui-launch.mjs` builds the `desktop` command line with `--data-dir join(setup.root, 'data', profile.id)` and never passes `--extensions`. Remote sessions receive secrets only as fixed keys over standard input (`scripts/agentui-launch-session.mjs`).
- `docs/architecture/extension-sdk.md` asks for immutable revision directories for installed entries, because Node caches each module URL.

## Decisions for this package

- D10. In-repo extensions under `extensions/*` are first-party and are bundled into the default desktop build. This is a new rule. The rule for external customization repositories ("sibling workspace customization does not activate automatically") is unchanged. Record both in `docs/customization/sources.md`.
- D11. Bundled server entries load as installed entries from `extensions/<name>` in the working tree. This deviates from the immutable-directory guidance. Reason: the launcher restarts the host process for each session, and a new process imports the rebuilt module. Live replacement of a rebuilt bundled extension at the same path is not supported; the documentation says to restart.
- D12. Extension package names are outside the `@agentui/` scope: `agentui-extension-crew` and `agentui-extension-coworkers`. The `reserved` rule stays as it is.
- D13. Bundled server extensions are supported for a local host only. A remote launcher profile ignores `extensions.json` and prints one line that says so. Token transport to a remote host is deferred.

## 4a. Move the Crew provider

Change surface:

- `git mv examples/crew extensions/crew` (`extensions/` is a new top-level directory).
- `extensions/crew/package.json`: rename to `agentui-extension-crew`. The five `file:../../vendor/...` paths keep the same depth. Confirm each resolves.
- Root `package.json`: replace the workspace entry and the `examples/crew/tests/*.test.mjs` test glob with `extensions/crew/…`. Add `extensions` to the `lint` script's directory list.
- Update every file in the reference list above. Regenerate `package-lock.json` with `npm install`.
- `scripts/artifact-manifest.mjs`: add `extensions` to the product-source directory list and to the `dist` exclusion pattern. Keep `examples` in both.
- `tests/host/extensions/fixtures/selection-journal-v1.json` is a recorded fixture. Read the test that consumes it before editing. Change it only if the test compares the path or package name.
- `spikes/crew/qualification.json` is a historical record. Leave its recorded paths and add no new claims.

Acceptance:

- `git grep -n "examples/crew\|example-crew"` returns only historical records that the implementer lists in the pull request.
- `npm run verify` passes with the same test count for the moved directory.
- A test (beside the existing artifact-manifest tests; find them with `git grep -l artifact-manifest tests`) shows that a modified file under `extensions/crew/src` marks the source dirty.

## 4b. Canonical manifests, desktop bundling, host flag, launcher

### Canonical manifests

- `extensions/crew/package.json` gains `agentui.extension` (new): namespace `crew`, `trust: 'full'`, `sdkVersion` equal to `EXTENSION_SDK_VERSION`, entries `server` → `./dist/server.js` and `desktop` → `./dist/desktop.js`, plus `agentui.sources` mapping `./dist/desktop.js` to `./src/desktop/index.tsx`.
- `extensions/crew/src/server.ts` (new): a default-export `ServerExtensionEntry`. For each `context.installations` entry it registers the existing provider with `context.providers.add(installation.id, …)`, taking `instance` and `service` from the installation (WP1). In 4b, `CrewProviderOptions.memberId` becomes optional: without it the provider discovers every member, bounded at 1000. The rest of the multi-member work (per-binding member derivation at every call site) and the operations arrive in WP5; until then the entry is not documented for use. Existing tests keep passing `memberId` to `crewProvider(options)`.
- `extensions/crew/tsconfig.desktop.json` (new): type-checks `src/desktop/**/*.tsx` with `noEmit`, the JSX setting `apps/desktop` uses, and a declaration for `*.css` imports. The package `check` script runs both configurations. The server `tsconfig.json` keeps excluding `src/desktop`.
- `extensions/crew/package.json` declares `react`, `@agentui/theme` and `@agentui/ui-primitives` as peer dependencies at the workspace versions.
- `./dist/desktop.js` is a manifest identifier. The bundler maps it to the source file through `agentui.sources`. `tsc` does not emit it.
- `extensions/crew/src/desktop/index.tsx` (new): a default-export `UiExtensionEntry<'desktop'>` that returns `{ modules: [], workspace: { label: 'Crew', component: Placeholder }, dispose() {} }`. WP6 replaces the placeholder.
- A test asserts that each `extensions/*/package.json` manifest passes `parseExtensionManifest` and that its `sdkVersion` equals `EXTENSION_SDK_VERSION`. This catches a missed literal on the next SDK bump.

### Desktop bundling

- `scripts/bundled-extensions.mjs` (new, beside `scripts/local-customization.mjs`): exports `bundledPlan(root)`. It scans `extensions/*/package.json`, keeps packages whose manifest has a `desktop` entry, and returns a plan in the same shape `desktopPlan` returns (`roots`, `entries`), sorted by namespace. It constructs the plan shape directly. `roots` are exactly the `extensions/<name>` directories, never the repository root, so core sources are not policed as customization sources. It does not import `@agentui/host`: read `desktopPlan` for the shape and for how the identity is derived, and compute the same fields from the working tree.
- The script must not contain the word `crew`. It discovers directories; it names none.
- `apps/desktop/vite.config.mjs` must load on a tree where only `desktop:prepare` has run. Split `scripts/local-customization.mjs` so that `customizationPlugin` and `mergePlans` live in a module with no `@agentui/host` import (for example `scripts/lib/customization-plugin.mjs`, new), and `desktopPlan` keeps the host import. `scripts/local-customization.mjs` re-exports both for existing callers.
- One plugin instance only. Export `mergePlans(bundled, external)` (new) from that host-free module. A namespace that appears in both plans fails with a message that names the namespace.
  - `apps/desktop/vite.config.mjs` adds `customizationPlugin(plan)` where `plan` is the bundled plan, or the merged plan when an external plan is supplied.
  - `scripts/build-local-customization.mjs` stops adding its own plugin. It supplies its external plan to the configuration so that exactly one `customizationPlugin` runs. The implementer picks the mechanism (for example a path in an environment variable read by the configuration file) and documents it in the script.
  - `scripts/desktop-customization-qualifier.mjs` receives the merged namespace list.
- The existing import policy and CSS policy apply to bundled extensions unchanged. Extension CSS ships as a stylesheet file in the bundle, never as an injected `<style>` element, because the Tauri CSP forbids inline styles.
- The 4a change to `scripts/artifact-manifest.mjs` makes bundled extension sources part of the product source set.
- `tests/application/browser-support.mjs` `customRuntime` injects its own selection. Keep that override working: an injected selection replaces the bundled one in tests.

### Host `desktop` command

- `apps/host/src/main.ts`: add `'extensions'` to `COMMANDS.desktop`.
- First step (risk R1): add a test that starts the built host with `desktop --extensions <file>` and a ledger-style installed fixture extension, then reads `metadata`. Confirm that native agents and provider agents both appear and that the native default stays selected. If `startBrowserHost` refuses the combination, extend the `desktop` startup to accept `extensions` the way `configured` startup does, and document the default-agent rule.
- `docs/development/launcher.md` and `docs/architecture/extension-sdk.md`: state that `--extensions` is valid for `serve` and `desktop`.

### Launcher

- `scripts/agentui-launch.mjs`, local profile only:
  - When `join(setup.root, 'extensions.json')` does not exist, pass nothing.
  - When it exists, read it and collect every `authentication.variable` name. If each named variable is set and non-blank in the launcher's environment, pass `--extensions <that path>`.
  - If any is missing, do not pass `--extensions`. Print one warning line per missing variable name. Never print a value. The app then starts with native agents, and the Extensions view shows `Not configured`.
  - If the file is not valid JSON, print one warning and do not pass `--extensions`.
- Confirm by reading `scripts/agentui-launch-session.mjs` that a local session passes the environment to the host process. The host removes referenced variables after capture.
- Remote profile: ignore `extensions.json` and print the D13 line.
- `scripts/verify-agentui-launch.mjs`: add cases for no file, a file with every variable set, a file with a missing variable, and a remote profile with a file.

### Configuration file

The file is the existing version 2 format. Example for documentation (no secrets):

```json
{
  "version": 2,
  "ownership": "transient",
  "extensions": [
    { "directory": "<absolute path to extensions/crew>",
      "installations": [{
        "id": "personal",
        "instance": { "namespace": "crew", "installationId": "personal", "generation": "1", "protocolVersion": "1" },
        "service": "http://<crew host>:<port>",
        "expectedAuthority": "remote-provider",
        "authentication": { "kind": "environment", "variable": "AGENTUI_EXTENSION_CREW_TOKEN", "revision": "1" }
      }] }
  ]
}
```

- The grant `id` is free text. The server entry registers its provider under that `id` (WP1 rule).
- `protocolVersion` for Crew is `'1'`. The existing documentation example uses `crew-v2` with namespace `example-crew`, which the provider rejects. Fix that example in `docs/architecture/extension-sdk.md`.

## Tests and acceptance

- New `tests/customization/build/bundled-extensions.test.mjs` (directory already globbed): `bundledPlan` lists the in-repo desktop entries sorted by namespace; a bundled package with its real name passes the `reserved` rule; an import outside the policy fails; `mergePlans` rejects a duplicate namespace.
- `tests/customization/build/local-build.test.mjs` (existing): an external customization build still succeeds, activates the bundled and external namespaces, and passes qualification.
- A browser test against the real `apps/desktop/web-dist-browser` build and a host with no extension configuration: the Extensions view lists `Crew` with state `Not configured`, and the page loads with no CSP violation in the console.
- The `desktop --extensions` host test from the first step passes.
- A host test activates `extensions/crew` through an installed entry with a real version 2 configuration and the fake Crew service, and `metadata` lists the fake's members as agents.
- `npm run clean`, then `npm run desktop:build`, succeeds. This proves the Vite configuration loads without a host build.
- A build test shows that a core `apps/desktop` source importing an `@agentui/*` package still builds, which proves core files are outside the plan's `roots`.
- `tests/extensions/providers/conformance/boundaries.test.mjs` passes. Run `git grep -n -i crew -- apps packages scripts templates` and confirm no new match.
- `npm run verify` passes.

## Exclusions

- No durable-artifact ownership for bundled extensions.
- No UI for editing `extensions.json`.
- No change to `templates/customization` beyond the SDK version literal.
- No bundled server extensions on remote launcher profiles (D13).
