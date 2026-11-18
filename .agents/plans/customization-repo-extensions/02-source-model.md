# WP2: Source model — same-repository references, `enabled`, `installations`, and the settings file

## Goal

A customization package can reference a sibling package in its own repository, can keep a reference listed while it is disabled, and can carry the installation grants its extensions need. A settings file beside it holds appearance and the default agent.

Prerequisite state: WP1 merged.

## Repository evidence

- `packages/host/src/customization/contract.ts`:
  - `GitExtensionReference { repository; commit; subdirectory? }`.
  - `CustomizationSource { local?; shared?; extensions }`.
  - `parseCustomizationPackage` allows exactly `['extension','sources','shared','extensions']`, caps `extensions` at 256 entries.
  - `parseGitExtensionReference` allows exactly `['repository','commit','subdirectory']` and requires `repositoryLocation(...)` and `commitId(...)`.
- `packages/host/src/customization/sources.ts`: `resolveCustomizationSources` and its inner `visit(reference, depth, external)`. Cache key `JSON.stringify([location.address, commit])`. Package dedup key `[address, subdirectory]`. Cycle detection by `packageIdentity(tree.inputs.identity, subdirectory)`. Limits: depth 32, 16 acquisitions, 64 packages, 256 edges. External children must have customization metadata.
- `packages/host/src/customization/catalog.ts`: `planCustomizationCatalog`, `desktopCustomizationIdentity`; an edge `commit` check.
- `packages/host/src/customization/repository.ts`: `readCustomizationSnapshot` also calls `parseCustomizationPackage`.
- `apps/host/src/server-extension-config.ts`: the version 2 installation shape (`id`, `instance { namespace, installationId, generation, protocolVersion }`, `service`, `expectedAuthority`, `authentication`), its validation, and the `AGENTUI_EXTENSION_[A-Za-z0-9_]+` variable rule.
- `apps/host/src/refresh-jobs.ts` and the builder's IPC source in `scripts/build-server-customization.mjs` parse a `GitExtensionReference` with `parseGitExtensionReference`. `resolveCustomizationSources` takes a `GitExtensionReference` as its root.
- In `apps/host/src/server-extension-config.ts`, `installation()` calls `authentication()`, which reads and requires the token value from the environment, and uses `normalizeGrantPool` from `apps/host/src/provider-credentials.ts`.
- `packages/host/src/customization/server-artifact.ts`: `parseServerCustomizationArtifact` has a fixed key list and an identity-checked body. Durable refresh artifacts are parsed by the same function.
- `packages/theme/src/index.ts`: `Appearance = 'light' | 'dark'`.
- `docs/customization/sources.md` documents the source model. It says "Sibling workspace customization does not activate automatically."

## Change surface (`packages/host/src/customization/contract.ts`, `sources.ts`, `catalog.ts`)

### Same-repository reference

- `GitExtensionReference` and `parseGitExtensionReference` stay remote-only and unchanged. Refresh requests, the builder IPC and the root reference of `resolveCustomizationSources` keep using them.
- New type `CommittedExtensionReference` (new, in `contract.ts`): either the remote form `{ repository, commit, subdirectory?, enabled }` or the sibling form `{ subdirectory, enabled }`. New parser `parseCommittedExtensionReference` (new), used only by `parseCustomizationPackage`. It accepts the sibling form when neither `repository` nor `commit` is present and `subdirectory` is present. One of the two present without the other is rejected.
- `CustomizationSource.extensions` becomes `CommittedExtensionReference[]`.
- A sibling reference's `subdirectory` is a path from the repository root, the same meaning `subdirectory` has in a remote reference. It is not relative to the referencing package. It must be contained in the repository.
- `visit` resolves a sibling reference against the parent's snapshot: it reuses the parent's `address` and tree, performs no acquisition, and counts toward the package and edge limits.
- A sibling reference is valid at any depth. Inside an external package it refers to that package's repository.
- The existing cycle check rejects a package that references its own subdirectory.
- Only committed metadata may use the sibling form.

### `enabled`

- Both committed-reference forms accept an optional boolean `enabled`. Absent means true.
- `parseCustomizationPackage` keeps every reference in the parsed result with its flag.
- `resolveCustomizationSources` skips a reference whose `enabled` is false. It does not fetch or parse the referenced package.
- A disabled reference still counts toward the 256-entry cap.
- `desktopCustomizationIdentity` and the server artifact identity already cover the root package's committed files, so flipping the flag changes the identity.

### `installations`

- `parseCustomizationPackage` allows a fifth key, `installations` (new): an array of at most 64 grants in the version 2 installation shape.
- Split the validator. Structural validation of a grant (shape, namespace, identity fields, origin rules, variable-name pattern) moves to a new module in `packages/host/src/customization/` (new file `installations.ts`) that reads no environment. Secret resolution and `normalizeGrantPool` stay in `apps/host/src/server-extension-config.ts`, which calls the structural validator first. Parsing a customization package must never read `process.env`.
- `authentication` accepts `{ kind: 'environment', variable, revision }` or `{ kind: 'unauthenticated' }`. A literal secret is rejected by the existing rule.
- Only the root package's `installations` are used. `installations` in a referenced package is rejected with the existing `invalid-package` diagnostic.
- Each grant's `instance.namespace` must equal the namespace of an enabled reference's extension once resolved. A grant for a namespace that is not enabled is ignored at build time and reported in the build summary, so disabling an extension does not make the package invalid.
- `CustomizationSource.installations` (new field) carries the parsed grants. `ResolvedCustomizationSources` exposes the root's grants.

- Grants are not written into the server artifact. `customization.json` keeps its schema, so existing artifacts still parse. The worker reads the root's grants from the resolved sources and writes them into its own build record (WP6).

### Settings file

- A file named `agentui-settings.json` (new convention) beside the root package's `package.json`. It is optional.
- New module `packages/host/src/customization/settings.ts` (new): `parseCustomizationSettings(bytes)` and `serializeCustomizationSettings(settings)`. The wire type `CustomizationSettings` (new) lives in `packages/contracts/src/service.ts` because clients receive it.

```json
{
  "version": 1,
  "appearance": "system",
  "showExtensionViews": true,
  "defaultAgent": { "kind": "native", "harness": "codex" }
}
```

- `appearance`: `system`, `light` or `dark`. Absent means `system`.
- `showExtensionViews`: boolean. Absent means true.
- `defaultAgent`: absent, or `{ kind: 'native', harness, model? }`, or `{ kind: 'provider', namespace, installationId, providerAgentId }`. `harness` and `model` are bounded strings (64 and 128 bytes). WP8 defines how the client matches them to an agent.
- Unknown keys and a `version` other than 1 are rejected. The file is at most 16,384 bytes.
- `serializeCustomizationSettings` writes two-space JSON with keys in the order above and a trailing newline, so every settings commit is a small, stable diff.
- The settings file is never a build input. WP6's inputs key excludes it in every case, including a root that has a local extension, so a settings commit never triggers a build.

## Behaviour and invariants

- A package that uses none of the new forms resolves exactly as before.
- Resolution of a sibling reference never touches the network.
- A disabled reference to an unreachable repository does not fail resolution.

## Tests and acceptance

- `tests/customization/sources/*.test.mjs` (existing directory):
  - a root at `examples/x` with sibling references to `extensions/a` and `extensions/b` resolves three packages from one acquisition;
  - a sibling reference inside an external package resolves in that package's repository;
  - `{ repository }` without `commit`, and `{ commit }` without `repository`, are rejected;
  - a self-reference is rejected as a cycle;
  - a sibling reference from a root at `examples/x` to `extensions/a` resolves `extensions/a` at the repository root, not `examples/x/extensions/a`;
  - a disabled reference is skipped, including one whose repository does not exist, and still appears in the parsed list with `enabled: false`;
  - flipping `enabled` changes the desktop customization identity;
  - `installations` parses; a literal secret, an extra key, a bad variable name and a 65th grant are rejected; `installations` in a referenced package is rejected;
  - a grant for a disabled namespace does not fail resolution;
  - parsing a package with `installations` succeeds with an empty environment and never reads `process.env` (assert with a proxy or by deleting every `AGENTUI_EXTENSION_*` variable);
  - a refresh request and the root reference still reject the sibling form with a clear refusal;
  - the settings file parses; an unknown key, a bad `appearance`, a version 2 file and an over-size file are rejected; serialization is byte-stable across a parse and serialize round trip.
- `tests/host/server-extension-config.test.mjs` still passes with the shared validator.
- `docs/customization/sources.md`: document the four additions and replace the sibling sentence with the explicit-reference rule.
- `npm run verify` passes.

## Exclusions

- No UI and no host connection in this package.
- No change to npm input rules.
