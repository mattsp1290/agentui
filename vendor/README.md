# Switchboard package provenance

The host installs private ESM `@mattsp1290/switchboard@0.0.0` from a commit-named
tarball. No registry publication is claimed. The authoritative
[pin and qualification record](switchboard.json) names the source revision,
artifact, SHA-256, toolchain and retained logs. The root lockfile separately records
npm integrity. The installed-consumer test checks the pin, host dependency,
artifact bytes and lockfile together.

The artifact contains built JavaScript, declarations, the upstream architecture
record and upstream MIT license. Only core and `./agui` are public exports.
Core has no required runtime dependency. The AG-UI entry requires the exact
optional peer `@ag-ui/core@1.0.4`. The `@agentui/host` package, for its `./agui`
entry, and the pure `@agentui/protocol` package each declare that exact SDK
dependency. Core-only host consumers still install the SDK, but the core entry
imports no AG-UI code. See the [consumer conformance matrix](../docs/protocol/README.md).

Linux arm64 qualification used Node 24.22.3, npm 11.19.1, uv 0.11.3 and Python
3.13.12. Installation, lint, type checking, installed-package tests and canonical
AG-UI comparison passed from a clean source archive. Inert compiler qualification
passed from the same source in a clean Git checkout. Its archive attempt reached
the Git revision annotation and failed because the archive has no `.git`.
Both outcomes are retained. No native agent, provider, credential or Apple tooling
was executed during this package qualification.

Two packs from the qualified archive build produced identical bytes. This does
not establish identical output across machines. Install the committed artifact
for downstream qualification instead of rebuilding it on the Mac.

## Rebuild from the immutable source

Use a separate empty checkout and the recorded toolchain. The canonical AG-UI
gate also needs the recorded uv and Python versions.

```sh
git clone https://github.com/mattsp1290/switchboard.git /path/to/empty-checkout
cd /path/to/empty-checkout
git checkout --detach 58c7922d8fade3617cc86fedcf41677f897025ef
npm ci
npm run lint
npm run check
npm test
npm run verify:agui
npm run verify:compiler
npm pack --pack-destination /path/to/package-output
```

The committed artifact was packed from a clean `git archive` build of this
revision. The compiler gate needs a Git checkout to annotate its source revision.
Renaming the package to its commit-named filename does not change its bytes.
Compare the rebuilt package with the recorded SHA-256 before adopting it.

## Check the installed consumer

From the AgentUI root with the pinned Node and npm versions:

```sh
npm ci
npm run build
node --test packages/adapter-tests/tests/switchboard.test.mjs packages/adapter-tests/tests/switchboard-types.test.mjs
```

These commands check the installed package through `@agentui/host`.
They qualify package compatibility and controlled continuation fixtures.
They do not authorize a client reply, consume a pending decision, dispatch to a
native process or qualify integrated desktop and iOS applications.

The [Mac measurement](../docs/qualification/switchboard-macos/58c7922d8fade3617cc86fedcf41677f897025ef/54065e2/README.md)
passed this consumer unit at AgentUI source `54065e2`. It installed the committed
artifact and verified all eleven requested frozen inputs without repacking it.
