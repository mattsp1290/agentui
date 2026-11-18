# Committed customization sources

The source API retrieves committed inputs. An internal preparation helper installs their locked dependencies into disposable copies. The [desktop builder](../../templates/customization/README.md) uses prepared graphs to build and browser-qualify the complete application.

The Node host resolves the committed package and its pinned external sources through its dedicated entry point.

```ts
import { resolveCustomizationSources } from '@agentui/host/customization';

const sources = await resolveCustomizationSources({
	reference: {
		repository: '/home/me/personal-agentui',
		commit: fullCommitId,
	},
	scratchParent: '/home/me/.agentui/sources',
});
try {
	console.log(sources.root.directory, sources.root.customization);
} finally {
	await sources.dispose();
}
```

## Git sources

`package.json.agentui.extension` is the existing SDK manifest. `sources` maps every declared runtime module to exactly one committed source file. Runtime output paths such as `./dist/desktop.js` do not need to exist in Git. All source paths start with `./` and remain inside the repository. An absent package, absent `agentui`, or empty `agentui` declares no customization. Shared or external inputs may appear without a local extension.

Optional `extensions` entries declare immutable external sources. The resolver retrieves them recursively in declaration order. Repeated references share the same package object. External packages require meaningful `agentui` metadata. Before resolution, the caller must trust the pinned root and every source declared transitively by its committed descendants. Resolving the root authorizes all descendant repository locations with the same host Git access and credentials, including local paths and remote repositories. Relative repository paths at every depth use the captured invocation working directory. Local path aliases share an acquisition after absolute path normalization. Remote address spellings remain distinct acquisition addresses, including SSH and HTTPS spellings with different authentication semantics.

Local repository paths may contain spaces. File URLs use ordinary URL encoding. Remote locations cannot contain raw whitespace, control characters, backslashes, or embedded credentials. Malformed caller locations and commit IDs report `invalid-input`; malformed external references in committed metadata report a fixed `invalid-package` diagnostic.

```json
{
  "repository": "git@example.org:me/widgets.git",
  "commit": "0123456789012345678901234567890123456789",
  "subdirectory": "packages/widgets"
}
```

### Same-repository references

A reference that names only a `subdirectory`, such as `{ "subdirectory": "extensions/crew" }`, is a same-repository reference. A committed file cannot name its own commit, so this form resolves in the snapshot of the package that declares it: same repository, same commit, no second acquisition. The `subdirectory` is a path from the repository root, not from the referencing package, and must stay inside the repository. Inside an external package it refers to that package's repository. The existing cycle check rejects a package that references its own subdirectory. A reference with `repository` but no `commit`, or `commit` but no `repository`, is rejected. Only committed metadata may use this form. Refresh requests and the root reference passed to `resolveCustomizationSources` still require a repository and a full commit.

### Enabled flag

Both reference forms accept an optional boolean `enabled`. Absent means `true`. The parsed package keeps every reference with its flag, so a disabled extension stays listed. The resolver skips a disabled reference and never fetches or parses it, so a disabled reference to an unreachable repository does not fail resolution. A disabled reference still counts toward the 256-entry cap. Flipping the flag changes the root package's committed files and therefore the desktop and server artifact identities.

### Installation grants

The root package may declare `installations`: at most 64 grants in the host's version 2 installation shape (`id`, `instance { namespace, installationId, generation, protocolVersion }`, `service`, `expectedAuthority`, `authentication`). `authentication` is `{ "kind": "environment", "variable": "AGENTUI_EXTENSION_…", "revision": "…" }` or `{ "kind": "unauthenticated" }`. A grant names a token variable and never holds a secret; a literal secret, an unknown key or a variable outside the `AGENTUI_EXTENSION_` namespace is rejected. Parsing never reads the environment. `installations` in a referenced package is rejected with `invalid-package`. `resolveCustomizationSources` returns the root's grants as `installations`. A grant for a namespace whose reference is disabled does not fail resolution; builds ignore it.

### Settings file

An optional `agentui-settings.json` beside the root package's `package.json` holds client settings:

```json
{
  "version": 1,
  "appearance": "system",
  "showExtensionViews": true,
  "defaultAgent": { "kind": "native", "harness": "codex" }
}
```

`appearance` is `system` (the default), `light` or `dark`. `showExtensionViews` defaults to `true`. `defaultAgent` is absent, `{ "kind": "native", "harness", "model"? }` or `{ "kind": "provider", "namespace", "installationId", "providerAgentId" }`; `harness` is at most 64 bytes and `model` at most 128. Unknown keys, a `version` other than 1 and a file over 16,384 bytes are rejected. `serializeCustomizationSettings` writes two-space JSON with keys in that order and a trailing newline, so a settings commit is a small, stable diff. The settings file is never a build input.

## Npm inputs

Use Node 24.22.3 or newer within Node 24 and npm 11.19.1. If you add actual npm dependencies, commit an npm v3 `package-lock.json` whose root dependency declarations, name, and version agree with `package.json`. The resolver validates declarations against the committed lock entries and retains exact lock bytes. A committed `npm-shrinkwrap.json` in the owning npm root or selected package is unsupported, including uppercase and mixed-case filename aliases, even beside a valid `package-lock.json`. npm prefers shrinkwrap, so the resolver rejects that context rather than report the unused package lock as validated. Dependency entries declaring embedded shrinkwrap contexts are also unsupported.

Required dependencies and peers must have pinned lock targets. Optional peers may be absent. Registry and remote tarball entries require SHA-256, SHA-384, or SHA-512 integrity pins. SHA-1 integrity is unsupported. Installed lock entries with active `bundleDependencies` or `bundledDependencies`, and entries with truthy `inBundle` markers, are unsupported even when every bundled child has its own source and integrity pins. npm can substitute archive contents for those separately pinned children during installation. Omitted or false bundle declarations and empty bundle arrays remain supported. Git npm sources and `link:` declarations are unsupported.

Contained committed `file:` tarballs and links to declared members of the selected npm workspace retain their files. Home-directory shorthand in npm file payloads is unsupported. Any exact `~` path segment is rejected before normalization, including `file:~/b.tgz`, `file:./~/b.tgz`, and `file:vendor/../~/b.tgz`. Literal segments such as `~name` remain supported. A local tarball's relative `file:` declarations use the directory containing its committed source archive. Dependency lookup still uses its installed lock path. Other local directory links and lock keys outside the selected npm root are unsupported. A local link can require a separate npm installation context whose transitive pins are absent from the parent lock, even when npm accepts that lock. Use a supported workspace layout or a contained tarball instead. The resolver never installs packages or runs scripts. The preparation helper owns installation. Host ABI provisioning and further dependency qualification belong to later build work.

## Repository snapshots

Every read fetches the full commit into private storage, copies raw regular-file blobs, and leaves your working tree, index, refs, and `FETCH_HEAD` alone. Dirty and untracked changes are excluded. Executable bits are preserved. LFS pointers stay pointer bytes. Symlinks and Git submodules are unsupported. Git uses existing SSH agents and credential helpers. Do not put passwords or tokens in repository URLs. Custom code will run with host or client process privileges when a later builder and activation path enables it.

A selected `subdirectory` reads that package's metadata while preserving the complete repository for sibling imports. Workspace declarations support literal paths and a trailing `/*` over immediate packages, as an array or a `packages` array inside an object. Duplicate patterns, overlapping declarations, and unsupported patterns on any examined ancestor fail. A declaring ancestor owns the npm lock. Multiple declaring ancestors, or a selected package lock alongside a declaring ancestor, fail as ambiguous. Workspace manifests and contained local package manifests must agree with their exact lock entries. Each workspace member also requires its canonical `node_modules/<name>` link with the matching member path, including entries with an explicit name. Normalized-only link spellings such as `packages/./foo` do not match the canonical member path. Sibling workspace customization does not activate automatically; a package enables a sibling only through an explicit same-repository reference.

The default desktop build contains no extensions, including this repository's own packages under `extensions/`. A customization package enables them with explicit same-repository references. [`examples/customization`](../../examples/customization/README.md) is such a package: it references `extensions/crew` and `extensions/coworkers` and carries one installation grant for each. Tests build a separate extension test bundle from the working tree (`npm run build:test-extensions`, output `apps/desktop/web-dist-extensions-test`); it is not a product build.

## Resolved packages

Each package exposes its absolute selected-package `directory`, absolute `repositoryDirectory`, `customization`, ordered `extensions`, and `inputs`. The file inventory contains repository-relative paths, SHA-256 byte hashes, and executable flags for every committed regular file. Its identity excludes temporary directories and repository addresses. The package identity also includes its selected subdirectory. `npm.kind` is `absent` or `locked`. An active package with no dependencies or workspace members returns `absent` even when it has a stray lockfile and no npm pin. The resolver does not parse that lockfile, so malformed JSON does not block dependency-free standalone customization. That lockfile still contributes its exact bytes to the file inventory and identity. Locked inputs retain the absolute npm `directory`, its repository-relative `path` (empty at the repository root), root manifest, exact lockfile, workspace manifests, local inputs, and a deterministic identity. The complete committed repository contributes to these identities. Ambient npm configuration is neither read nor qualified. Committed configuration remains part of the file inventory.

## Ownership and limits

One resolution owns private storage for its complete graph. Concurrent calls have independent directories. Disposal is idempotent and a failed descendant removes the entire failing owner's storage. Limits cover 16 repository acquisitions, 64 packages, 256 declared edges, depth 32, 50000 files, 256 MiB of aggregate raw content, and ten minutes. Package analysis checks the same deadline inside its loops. Each selection also permits at most 256 workspace patterns per manifest, 10000 lock entries, and 50000 dependency declarations across analyzed manifests and lock entries. Individual Git commands allow up to 30 seconds, or 120 seconds for retrieval, within that deadline. These limits do not bound Git's transient downloaded object storage.

The existing `readCustomizationSnapshot` operation remains available for a single root snapshot with unresolved external references. Its npm validation compares only the root manifest with the root lock entry. It parses the lockfile only when the root selects customization and declares dependencies. It permits 20000 files, 256 MiB, and 256 external references in root metadata. Dispose each successful snapshot or resolved graph when its consumer finishes.

The graph API checks the npm manager and v3 lock header once before decoding entries. When both the header and entries are invalid, the header error takes precedence.

Git output exceeding its bounded buffer reports `resource-limit` without retaining command output. A failed read preserves its original diagnostic if cleanup also fails. Explicit disposal of a successful result reports cleanup failures to the caller.

## Prepared sources

`scripts/prepare-customization-sources.mjs` exports the internal `prepareCustomizationSources({ reference, scratchParent })` helper used by the [server artifact builder](server-artifacts.md) and [desktop builder](../../templates/customization/README.md). The helper has no separate production command or public host export. Its complete return value is `{ root, dispose }`. The caller uses `root.directory` for the selected package and calls `dispose()` when finished.

Preparation resolves the source graph itself and copies every recorded committed file into new private storage. It verifies file hashes and executable flags before copying and after installation. Every package `repositoryDirectory`, selected-package `directory`, and locked `npm.directory` points into those copies. The npm `path` remains repository-relative and unchanged. Ordered extension edges and shared package objects retain their graph structure. Identities, manifests, source mappings, and file inventories still describe the original committed inputs. Installed files do not become committed provenance.

Each repository acquisition gets one copy, preserving sibling imports. Each owning npm directory gets one installation, including when selected workspace members have different npm identities. Independent preparations never share writable copies. A committed `node_modules` path segment anywhere in a repository fails preparation, including ASCII case variants. Dirty working files and untracked installations do not affect the result.

For locked dependencies, the helper uses the running supported Node 24 executable and its adjacent npm CLI. npm must report exactly `11.19.1`. Every npm invocation receives an explicit canonical directory prefix so caller ancestor workspaces cannot change its installation context. Selected workspaces within the owning npm directory remain supported. `npm ci` includes development, optional, and peer dependencies and disables lifecycle scripts for roots, workspaces, and dependencies. Audit, funding, and update checks are disabled. The helper never rewrites author manifests or locks and never injects host ABI packages.

Before any installation, preparation records each owner's qualified copied lock entries. After all installations, it inventories actual packages in the root and workspace `node_modules` directories, including scopes and nested dependencies. Installed manifests must have the exact locked versions and any explicit locked names. Workspace links must point to their copied targets, whose versions may be absent. Unexpected package locations and active bundle declarations in installed manifests fail even when the lock omits bundle markers. Only entries marked `optional: true` may be absent. A present optional package must pass the same checks, including a readable, valid manifest. npm's `.bin` and hidden lock are installation metadata. An embedded shrinkwrap file alone is not rejected when the qualified lock omits `hasShrinkwrap` or sets it to false. This check verifies installed identity and layout, not arbitrary package contents or runtime behavior.

Committed `.npmrc` files remain in the inventory. Preparation temporarily removes copied `.npmrc` files and their ASCII case variants during installation, then restores their original paths, exact bytes, and executable flags. npm uses private HOME, cache, temporary files, and empty user and global configuration files. An allowlisted environment excludes inherited npm settings, credentials, proxies, `NODE_OPTIONS`, and `NODE_PATH`. The child executable search path starts with the running Node directory. This prevents ambient machine configuration from changing an ordinary install. It does not provide a sandbox or inherit private registry authentication.

Preparation permits ten minutes overall. npm version detection permits ten seconds, and each installation permits two minutes within that deadline. Each subprocess captures at most 1 MiB per output stream. Public errors use fixed diagnostics without npm output or credential-bearing paths. Preparation failures remove the complete owned tree. Explicit disposal is idempotent and preserves caller-owned siblings and other successful preparations. Resolver snapshots are disposed before preparation returns.

Prepared sources are inputs for a later compiler. Preparation does not bundle code, load runtime entrypoints, verify native dependency usability, supply the host ABI, publish artifacts, select versions, or activate extensions. A package that requires lifecycle scripts may install successfully and still fail compilation or execution later.
