# Server customization artifacts

Build a pinned committed source graph into a fresh directory with Node >=24.22.3 <25 and npm 11.19.1. The builder checks Node before creating output directories, including graphs without npm dependencies. Source preparation checks npm when an installation is required.

First run `npm ci` and `npm run build` from the AgentUI checkout. The CLI imports the built host and SDK workspace exports.

```sh
node scripts/build-server-customization.mjs \
  --repository /path/to/customization \
  --commit FULL_COMMIT \
  --out /path/to/fresh-artifact
```

`--subdirectory` selects a monorepo package. The command prints JSON containing the directory, artifact ID, and root package identity. The internal `buildServerCustomization({ reference, out })` function in `scripts/server-customization.mjs` provides the same operation.

The builder calls source preparation once. The typed host function `planServerCatalog(root, sdkVersion)` owns canonical package provenance, graph validation, distinct repository roots, and absolute entry sources aligned with the catalog. It returns the explicit root repository directory for compilation. The builder bundles committed JavaScript or TypeScript server entries and locked npm dependencies into `entries.mjs`. It ignores author build scripts, Vite configuration, and TypeScript configuration. Packages contribute once in root-first graph order. Distinct packages cannot share an extension namespace. A graph without server entries fails.

TypeScript sources include `.ts`, `.tsx`, `.mts`, and `.cts` files. Package exports select the `import` or `require` condition for each dependency reference, with the common `node` condition enabled. Packages without exports use `main`, without preferring the bundler-specific `module` field. Static CommonJS dependencies are bundled.

`customization.json` contains immutable root and package provenance, full committed file inventories, source mappings, npm lock identities and inputs, graph edges, catalog entry indexes, builder implementation identity, exact SDK and Node versions, Node module ABI, host SDK ABI identity, and sorted emitted file hashes. Its artifact ID hashes canonical metadata. Locked npm inputs retain their repository-relative `path`; the artifact type omits their absolute `directory`. Temporary directories and dirty or untracked author files never enter the artifact.

Each package's `extensions` contains ordered `{ packageIdentity, commit }` edges. The target package supplies the selected subdirectory and committed content identity. Different commits with identical content share one package and one catalog contribution, while each edge retains its pinned commit. A package's `commit` is the representative used for compilation. The first edge reaching that content in depth-first declaration order owns each non-root representative commit. The reader requires that exact commit; the root keeps the selected root commit. Edge commits can differ from that representative and remain part of the artifact ID.

Before publication, a bounded Node child imports the actual emitted catalog and checks each export with `checkExtensionEntrypoint`. It never calls `activate`. Output bytes must remain unchanged throughout qualification. Failure removes owned staging and the fresh reservation. Existing output directories are rejected and previous artifacts survive failures.

## Read verified bytes

```js
import { readServerCustomizationArtifact } from '@agentui/host/customization';

const verified = await readServerCustomizationArtifact({
  directory,
  expected: { artifactId, sdkVersion, nodeVersion, nodeModules, abiIdentity },
});
const manifest = verified.manifest;
const catalogBytes = verified.readAsset(manifest.catalog);
```

All expectations are mandatory and belong to the caller. The flat runtime expectation fields deliberately differ from artifact metadata so the untrusted artifact cannot itself satisfy the expectation type. The reader checks the complete inventory, hashes, provenance structure, compatibility, and pinned artifact ID before retaining bytes. `readAsset` returns a copy of retained bytes, so later filesystem changes cannot change the verified result. The reader executes no customization code. Invalid artifacts raise `CustomizationError` with code `invalid-artifact`. Its result has the named type `VerifiedServerCustomizationArtifact`. The raw parser and artifact ID helpers are metadata utilities only; they do not verify retained bytes or authorize execution.

## Host ABI and scope

The only host-provided author import is `@agentui/sdk`. Supported Node builtins also remain external. Imports of `module` and `node:module` are unsupported, including `createRequire` and explicit loader registration. Other `@agentui/*` imports, SDK subpaths, native addons, nonliteral dependency imports, and residual runtime CommonJS package loading are unsupported. Ordinary dependencies must resolve inside prepared repositories and validated npm installations. Host `node_modules` cannot supply missing customization dependencies.

`scripts/server-customization-abi.mjs` owns `serverCustomizationAbi()`, which returns the exact SDK specifier map and a digest of the reachable installed public SDK runtime graph, including package versions and file bytes. It also re-exports `classifyHostSpecifier(imports, specifier)` from the pure ABI-policy module. The compiler, emitted-import audit, and qualification loader share this classifier for SDK aliases, supported builtins, forbidden runtime loaders, and ordinary packages. The loader permits the SDK's transitive graph by resolved URL; those packages remain separate from author-facing host aliases. Workspace version `0.0.0` alone does not identify an ABI. `scripts/server-catalog-loader.mjs` exports `serverCatalogLinkage({ directory, manifest, abi })` to construct the catalog URL, SDK imports, and allowed URLs, and `registerServerCatalogHooks({ imports, allowed })` to install that linkage. The qualification child and consumer tests use this module to map the SDK specifier and restrict resolved URLs to the SDK graph and artifact assets. `scripts/server-customization-qualifier.mjs` passes the catalog and canonical manifests to the real child module over stdin, with a five-second timeout and 16 KiB output limit. The qualifier obtains entry manifests from the canonical catalog owner; callers do not supply a parallel manifest list. The production host embeds the same ABI identity at build time and imports retained artifact bytes through a host-owned loader. It maps `@agentui/sdk` to the SDK shared with the host. A plain filesystem import without equivalent linkage is unsupported.

This is a server extension catalog, separate from the complete application artifact contract. The production host can select and activate it at startup through [`serve --extensions`](../architecture/extension-sdk.md#select-server-extensions-with-the-cli). Desktop and iOS artifact activation, version selection, refresh, and rollback remain separate work. Qualification and activation execute trusted code with process privileges. Qualification checks import and export compatibility; it does not sandbox the code or establish successful provider activation.

The builder identity hashes the reachable first-party build modules and qualification child, keyed by checkout-relative paths, plus the root lockfile that pins third-party tools. Builder and ABI identities are computed before reserving an output directory.
