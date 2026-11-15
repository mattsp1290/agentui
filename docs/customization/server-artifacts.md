# Server customization artifacts

Build a pinned committed source graph into a fresh directory with Node >=24.22.3 <25 and npm 11.19.1. The builder checks Node before creating output directories, including graphs without npm dependencies. Source preparation checks npm when an installation is required.

```sh
node scripts/build-server-customization.mjs \
  --repository /path/to/customization \
  --commit FULL_COMMIT \
  --out /path/to/fresh-artifact
```

`--subdirectory` selects a monorepo package. The command prints JSON containing the directory, artifact ID, and root package identity. The internal `buildServerCustomization({ reference, out })` function in `scripts/server-customization.mjs` provides the same operation.

The builder calls source preparation once. It bundles committed JavaScript or TypeScript server entries and locked npm dependencies into `entries.mjs`. It ignores author build scripts, Vite configuration, and TypeScript configuration. Packages contribute once in root-first graph order. Distinct packages cannot share an extension namespace. A graph without server entries fails.

TypeScript sources include `.ts`, `.tsx`, `.mts`, and `.cts` files. Package exports select the `import` or `require` condition for each dependency reference, with the common `node` condition enabled. Packages without exports use `main`, without preferring the bundler-specific `module` field. Static CommonJS dependencies are bundled.

`customization.json` contains immutable root and package provenance, full committed file inventories, source mappings, npm lock identities and inputs, graph edges, catalog entry indexes, builder implementation identity, exact SDK and Node versions, Node module ABI, host SDK ABI identity, and sorted emitted file hashes. Its artifact ID hashes canonical metadata. Temporary directories and dirty or untracked author files never enter the artifact.

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

All expectations are mandatory and belong to the caller. The reader checks the complete inventory, hashes, provenance structure, compatibility, and pinned artifact ID before retaining bytes. `readAsset` returns a copy of retained bytes, so later filesystem changes cannot change the verified result. The reader executes no customization code.

## Host ABI and scope

The only host-provided author import is `@agentui/sdk`. Supported Node builtins also remain external. Imports of `module` and `node:module` are unsupported, including `createRequire` and explicit loader registration. Other `@agentui/*` imports, SDK subpaths, native addons, nonliteral dependency imports, and residual runtime CommonJS package loading are unsupported. Ordinary dependencies must resolve inside prepared repositories and validated npm installations. Host `node_modules` cannot supply missing customization dependencies.

`scripts/server-customization-abi.mjs` owns `serverCustomizationAbi()`. It returns the exact SDK specifier map and a digest of the reachable installed public SDK runtime graph, including package versions and file bytes. Workspace version `0.0.0` alone does not identify an ABI. The qualification child uses this map through Node `registerHooks`. A future consumer must compute the same identity and use the same map when importing retained artifact modules. A plain filesystem import without that mapping is unsupported.

This is a server extension catalog. It is separate from the complete application artifact contract. Desktop and iOS production, importing retained modules, provider activation, version selection, refresh, and rollback belong to future consumers. Qualification executes trusted top-level code with process privileges. It establishes import and export compatibility, not a sandbox or successful provider activation.
