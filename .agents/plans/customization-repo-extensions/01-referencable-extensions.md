# WP1: Make the two extension packages buildable as referenced customization packages

## Goal

`extensions/crew` and `extensions/coworkers` pass customization-package parsing, and both their desktop entry and their server entry build through the existing customization builders.

Prerequisite state: pull request 138 merged or branched from. No other work package.

## Repository evidence

- `packages/host/src/customization/contract.ts`: `parseCustomizationPackage` requires "exactly one source mapping per manifest module". Each extension's `package.json` declares `server` → `./dist/server.js` and `desktop` → `./dist/desktop.js`, but `agentui.sources` maps only `./dist/desktop.js`.
- `scripts/server-customization-abi.mjs`: the ABI `imports` are `{ '@agentui/sdk' }`. `scripts/server-customization.mjs` rejects any other `@agentui/` specifier with `build-failed`. `packages/host/src/customization/server-artifact-policy.ts`: `classifyHostSpecifier`.
- Value imports of `@agentui/contracts` in server code: `canonicalJson` and `parseScope` in `extensions/crew/src/index.ts` and `extensions/crew/src/provider.ts`; `canonicalJson` in `extensions/coworkers/src/presentation.ts` and `extensions/coworkers/src/provider.ts`. Type-only imports are erased by the bundler.
- The builder bundles npm dependencies from the prepared `node_modules` and its output audit rejects a `require` call or a non-external import. Bundling of `@birbcrew/client`, `@birbcrew/client/agui`, `@ag-ui/client` and their transitive packages has not been tried.
- `packages/sdk/package.json` exports `.`, `./react`, `./tools`, `./react-tools`. The SDK already depends on `@agentui/contracts`.
- Desktop sources of both extensions import only `react`, `@agentui/sdk`, `@agentui/sdk/react`, `@agentui/theme/react`, `@agentui/ui-primitives/desktop`, a type from `@agentui/contracts`, and local files. That is inside the shared-import policy in `scripts/lib/customization-plugin.mjs`.
- `packages/contracts/src/compatibility.ts`: `EXTENSION_SDK_VERSION = '0.13.0'`.

## Change surface

### First step: the bundling proof (risk R1)

Before any other change, in a scratch directory outside the worktree:

1. Add the server source mapping to a temporary copy of `extensions/crew/package.json`.
2. Run the server-artifact builder's bundling step against the Crew server entry (call `buildServerCustomization` from `scripts/server-customization.mjs` on a local fixture repository that contains the copy, or reproduce its bundler configuration in a short script).
3. Record whether the output audit passes.

If it fails only on the `@agentui/contracts` value imports, continue: the changes below remove them. If it fails on `require` calls from `@birbcrew/client`, `@ag-ui/client` or their dependencies, stop and report the exact packages to the owner (decision D-open: change the bundler's CommonJS handling, or vendor ESM builds).

### SDK (`packages/sdk/src/index.ts` or the file that defines the root export)

- Re-export `canonicalJson` and `parseScope` from `@agentui/contracts` (new exports on the SDK root). The implementer confirms the modules that define them with `git grep -n "export function canonicalJson\|export function parseScope" packages/contracts/src`.
- `EXTENSION_SDK_VERSION` becomes `'0.14.0'`. Update pinned literals: `git grep -n "0\.13\.0" -- . ':(exclude)**/Cargo.lock' ':(exclude)**/package-lock.json' ':(exclude)package-lock.json'` (other lock files contain unrelated `0.13.0` entries that must not change), including `templates/customization/package.json`, both extension manifests and `tests/application/browser-support.mjs`.
- `docs/architecture/extension-sdk.md`: one version note.

### Extension packages

- `extensions/crew/package.json` and `extensions/coworkers/package.json`: add `"./dist/server.js": "./src/server.ts"` to `agentui.sources`.
- In the four files listed above, import `canonicalJson` and `parseScope` from `@agentui/sdk` instead of `@agentui/contracts`. Leave type-only imports.
- Run `git grep -n "from '@agentui/" extensions/*/src` and confirm that no server-reachable file has a value import from an `@agentui/*` package other than `@agentui/sdk`.

## Behaviour and invariants

- The workspace build (`tsc`) of both extensions is unchanged in output.
- Provider behaviour is unchanged. The conformance suite passes for both.

## Tests and acceptance

- New `tests/customization/build/extension-packages.test.mjs` (directory already in the `npm test` globs). Its fixture is the whole committed tree: `git archive HEAD` unpacked into a temporary directory, with the test's uncommitted working-tree versions of changed files copied over it, then committed as a fixture repository. A partial copy fails, because the resolver requires every workspace member the root `package.json` declares. The test has two tiers:
  - Default tier (offline, always runs): `resolveCustomizationSources` accepts `extensions/crew` and `extensions/coworkers` as selected packages. Resolution needs no install.
  - Network tier (runs only when `AGENTUI_CUSTOMIZATION_NETWORK_TESTS=1` is set; this is a new variable and the existing build tests have no skip mechanism): the remaining assertions below, which need a real `npm ci` of the workspace.

  Assertions:
  - asserts `resolveCustomizationSources` accepts `extensions/crew` and `extensions/coworkers` as selected packages;
  - builds a server artifact for each with `buildServerCustomization` and asserts `entries.mjs` and `customization.json` exist and the audit passed;
  - loads each artifact's entry with the host's artifact loader and asserts it exposes a server entry whose `activate` registers at least one provider when given one installation.
  - The network tier is required once for gate G1: run it on the implementer's machine and record the result and duration in the pull request. `npm test` without the variable stays offline.
- The provider conformance suite passes for Crew and Coworkers.
- `npm run verify` passes.

## Exclusions

- No change to the desktop bundling behaviour. That is WP3.
- No change to the server-artifact import policy.
