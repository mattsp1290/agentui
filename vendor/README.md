# Dependency provenance

## AG-UI fork

The shared protocol and host workspaces install `@ag-ui/core@1.0.4` from the
[PR49 fork artifact](ag-ui/ed2c1d5b63299d3f08676a1418cc2640bbe55fd1/README.md).
Its six-package closure includes the Codex and Pi packages intended for later
Switchboard composition. A separate controlled consumer verifies their installation,
public imports and fixture behavior. AgentUI does not start a second native runtime. Full native integration,
approvals, discovery, provider routes and Apple qualification remain open.

## Current Switchboard package

The host installs `@mattsp1290/switchboard@0.0.0` and the existing Pi, Codex,
and Claude aliases from one immutable artifact at source
`c9179737ec340dbbde284af4b11bcf2608756938`.
The [active pin](switchboard.json) records the source tree, source-lock SHA-256,
artifact SHA-256, toolchain, command results, and retained logs.
The alias pins identify their public entrypoints and native SDK versions. Their
`qualificationRecord` references the active pin as the single artifact identity.
Qualification limits are recorded in the active pin’s `qualification.limits`.
The root lockfile records npm integrity separately.

The public entries are core, `./agui`, `./testkit`, `./pi`, `./codex`, `./claude`,
and `./observability`. Core has no required runtime dependencies.
The observability entry requires the exact optional peer
`@opentelemetry/api@1.9.0`. AgentUI declares that peer and keeps the existing
native SDK versions. The host owns telemetry providers and exporters.

Qualification ran from a clean `git archive` of this revision on Darwin arm64
with Node 24.22.3 and npm 11.19.1. `npm ci`, build, lint, type checking,
`npm test`, and `verify:package` passed. The source test runner reported 249
passing top-level tests. Its package verification also exercised controlled
installed-package, compiler, observability, and AG-UI fixtures.
The explicit package-verification command passed separately.
No live native agent, Datadog backend, or Apple application test ran for this update.
These results do not renew the historical Linux or Mac application receipts.

Reproduce the artifact from a separate directory. Do not replace a working
Switchboard checkout to build the dependency.
Since Switchboard #42, `npm ci` in the source downloads the `@ag-ui/core`
devDependency from
`https://raw.githubusercontent.com/mattsp1290/agentui/661216eab627be33067951ffad7a1691127a80fe/vendor/ag-ui/ed2c1d5b63299d3f08676a1418cc2640bbe55fd1/ag-ui-core-1.0.4.tgz`,
the PR49 fork archive retained in AgentUI, so rebuilding needs network access
to GitHub.

```sh
	git -C /path/to/switchboard archive c9179737ec340dbbde284af4b11bcf2608756938 | tar -x -C /path/to/empty-source
	cd /path/to/empty-source
	npm ci
	npm run build
	npm run lint
	npm run check
	npm test
	npm run verify:package
	npm pack --json --pack-destination /path/to/package-output
```

Rename the packed file to the commit-named artifact without changing its bytes.
Compare its SHA-256 with the active pin before adoption. This update made no
cross-machine reproducibility claim.

From AgentUI, check the installed consumer after installation and build.

```sh
	npm ci
	npm run build
	node --test packages/adapter-tests/tests/switchboard*.test.mjs packages/adapter-tests/tests/qualification-consumer*.test.mjs tests/host/*pin.test.mjs
	npm run protocol:check
```

The tests compare all runtime aliases with the same current artifact, import
its public entries, reject private imports, and verify retained historical
artifact and log bytes. Provider and Apple qualification remain separate.

## Historical Switchboard qualification

The original pin records are preserved byte-for-byte in [historical](historical/).
The original artifacts and qualification logs remain at their existing paths.
The following records describe their measured source revisions.
They do not qualify the current runtime.

The historical host installed private ESM `@mattsp1290/switchboard@0.0.0` from a commit-named
tarball. No registry publication is claimed. The authoritative
[historical pin and qualification record](historical/switchboard-58c7922d8fade3617cc86fedcf41677f897025ef.json) names the source revision,
artifact, SHA-256, toolchain and retained logs. The root lockfile separately records
npm integrity. The installed-consumer test checks the pin, host dependency,
artifact bytes and lockfile together.

The artifact contains built JavaScript, declarations, the upstream architecture
record and upstream MIT license. That historical package exports only core and `./agui`.
Core has no required runtime dependency. The AG-UI entry requires the exact
optional peer `@ag-ui/core@1.0.4`. The `@agentui/host` package, for its `./agui`
entry, and the pure `@agentui/protocol` package each declare the pinned fork SDK
artifact dependency. Core-only host consumers still install the SDK, but the core entry
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

### Rebuild the historical immutable source

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

### Historical consumer checks

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

### Historical Pi text-chat adapter

The historical host installed a separate commit-named Switchboard artifact through the
`@agentui/switchboard-pi` local package alias. The [historical Pi pin](historical/switchboard-pi-564f04434b3a6575c5c97f706dd6d5510e41726f.json)
records its source and digest. AgentUI imports only its public `./pi` entrypoint.
The existing core and AG-UI dependency pins above remain separate.

This adapter uses Pi SDK 1.5.2 with `opencode-go/glm-5.3` for text chat.
Its emitted declarations contain no native SDK types. Switchboard isolates
known upstream declaration errors in its adapter compiler project. AgentUI
and Switchboard core retain strict dependency checking.

See the [Pi host guide](../docs/development/pi-host.md) for startup and the
opt-in live integration test. The test uses a host environment credential and
checks streaming, follow-up, reload, host restart, Stop and saved-file redaction.
