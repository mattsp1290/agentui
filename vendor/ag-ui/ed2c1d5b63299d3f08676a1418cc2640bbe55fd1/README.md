# Frozen AG-UI fork packages

These six archives preserve the actual bytes built from [mattsp1290/ag-ui PR 49](https://github.com/mattsp1290/ag-ui/pull/49), branch `matt.spurlin/typescript-sdks`, source `ed2c1d5b63299d3f08676a1418cc2640bbe55fd1`, tree `4dd1b37d5fd8486b022827c102f2b53ea2bfdfc8`. Their package versions alone do not identify this source. `provenance.json` binds each filename to its byte count, SHA-256, SHA-512, npm SRI, complete archive member list and packed manifest.

| Package | Version | Archive SHA-256 |
| --- | --- | --- |
| `@ag-ui/core` | 1.0.4 | `2cd54a879083e0c351e8c38861b1d2e2b7355a5712b7128da690257c687dad19` |
| `@ag-ui/proto` | 1.0.4 | `f351b5f7ac651330d9e75c395f397540174f85a63fcfad33488dd949f3460501` |
| `@ag-ui/encoder` | 1.0.4 | `e0ce4386279aea136154a3a44d3d9d9570bf546696651cc19a915ae1783f0ff6` |
| `@ag-ui/client` | 1.0.4 | `242dd3f0a45139992da3de96efb6f5c71eb6b9d56f76133756fc4f85175880cc` |
| `@ag-ui/codex-sdk` | 0.0.1 | `4e9529559941198532842b040a5c5b16f861b300c8bd8c5e67b23f4535f11b1a` |
| `@ag-ui/pi` | 0.0.1 | `9cc320d8549901d181abe04e5027dbb5a87bd88b7eed0131b110dbe2aac3447c` |

Every archive includes its MIT notice. Extracted notices and packed manifests are retained in `notices/` and `manifests/`. Pi preserves YS-BW's MIT notice and donor provenance for `YS-BW/pi-agui` source `ee810dfb9ad3fe81d8854e9121b84ddee4c59148`. No archive has been patched or repacked for retention.

Run these explicit commands from the AgentUI repository root. They are separate from normal application tests.

```sh
node scripts/verify-agui-fork.mjs --offline
node scripts/verify-agui-fork.mjs
```

The first command verifies bytes, manifests, notices, compressed evidence, fixture hashes and the independent frozen consumer lock without installing dependencies. Both commands require POSIX and system `tar`. The driver enforces Node >=22.19, the Pi package floor; all retained replays used Node24.22.3 and other Node versions are unmeasured. GNU tar also requires `gzip` for these archives. The second also requires npm. It creates an isolated consumer in the host temporary directory, copies the retained archives and consumer inputs, and runs `npm ci --ignore-scripts --include=optional --no-audit --no-fund`. It may download the lock's registry dependencies. Nothing installs automatically from normal tests. It removes the successful temporary consumer and preserves a failed one for inspection.

The consumer pins all six AG-UI packages to these local bytes, Codex SDK and CLI to `0.167.1`, all three Pi peers to `1.5.0`, and zod to `3.25.76`. The independent inputs are `tests/dependencies/ag-ui/consumer/package.json` and `package-lock.json`. All six Codex optional platform packages remain in that lock; the applicable native payload must be installed but is never executed. The verifier rejects registry AG-UI resolution, nested or extra AG-UI copies, mismatched installed manifests and incorrect SRI. Qualification imports every public package, runs Codex first turn and continuation through ESM and CommonJS against the controlled executable, and runs the 15 unchanged Pi tests with its controlled provider. Pi's exported example server only listens on loopback. No native provider credential or real agent is used.

`evidence/` retains complete acquisition, build, pack and consumer logs compressed without editing, source integrity and observed PR/check snapshots, and the exact source build lock. `provenance.json` records raw, retained and compressed sizes and SHA-256 values for each record. Paths inside those historical logs identify the measured environment only; replay uses the committed relative inputs above. The earlier `agui49-consumer-proof` used `npm install` and a pre-retention lock (SHA-256 `0b8f55a697fc9615468273b94dbf55e4e718f4113e16c7a38f1598874f6e10a3`); `retention-replay.log.gz` exercises the committed consumer lock (SHA-256 `239a43a9ac72e7c18b7e84a9b32f410546a3ebc507d73d4539686852705c81cd`) with `npm ci`. The later `standard10-replay.log.gz` repeats that frozen consumer using the lock-derived readers and optimized-Python rejection guard; its driver/checker digests and actual times are recorded separately in `qualification.standard10Replay`. Source verification found all 6,090 archived tracked blobs unchanged after builds and packs. The acquisition toolchain was Linux aarch64, Node `24.22.3`, npm `11.19.1` and pnpm `10.33.4`.

Replaying the consumer verifies these frozen bytes. Rebuilding source is a separate operation: acquire the exact source revision, verify the retained source-lock SHA-256, run its filtered frozen pnpm install, build/typecheck/tests and explicit package packs. The historical commands and results are retained in the acquisition logs. New packs must receive new digest evidence; no cross-machine or repeated-build byte identity is claimed.

This package qualification does not establish live native behavior, direct or LiteLLM routing, Apple application behavior, or a registry publication. The fork's recorded CI is red at this exact source. Failed checks are `publish` (two runs), `release-allowlist-sync`, `check-config-files`, `licenses`, `dojo / event-trace-unit` and `dojo / check-generated-files`. Skipped checks are `dojo / codex-sdk-typescript`, `dojo / ${{ matrix.suite }}` and `fork-pr-monitor`. Cancelled checks are `dotnet / unit + integration`, `dotnet / cross-language (TS <-> C#)` and `claude-managed-agents-dotnet`. The complete check snapshot is retained in `evidence/agui49-checks-snapshot.json.gz`.

The [failed license-policy job](https://github.com/mattsp1290/ag-ui/actions/runs/42942702235/job/130268067856) reports `Public package @ag-ui/codex-sdk needs a license policy entry`. Its complete output is retained in `evidence/upstream-license-policy.log.gz`. The missing policy entry affects the vendored Codex package's upstream preparation gate. Every retained archive's MIT notice and Pi's donor notice/provenance were independently checked; those notice checks do not make the failed upstream policy gate pass. Upstream task `ag-ui-whx0` owns the license, release and configuration preparation gaps. Existing `ag-ui-sbz5` and [PR50](https://github.com/mattsp1290/ag-ui/pull/50) own a separate Pi CI synchronization; no fix from that unmerged PR is included here.

Upstream's combined-branch Codex Dojo browser job was skipped. The retained successful upstream TypeScript job and local exact-source package tests, installed exports/declaration checks and controlled consumer fixtures are separate executed evidence. None establishes the skipped combined Dojo or Flutter suite. The retained replay records cover Linux arm64. Other host and archive-reader combinations require separately labelled measurements. AgentUI's installed-core pin and the remaining packages' consumer qualification are separate evidence scopes. The pre-existing Switchboard Mac record is historical and unchanged.

## Node qualification and launcher scope

The live offline command uses the same Node resolver and archive checks as the full command. The reader uses bounded system `tar` calls; record `tar --version` when qualifying a host. The retained GNU/Linux replay does not establish BSD tar or macOS compatibility. Earlier Python commands and source hashes remain historical observations in the retained records.

`qualification.nodeReplays` records source hashes, runtime and temporary directory for each retained Node replay. The original archives, native pins, consumer lock and donor fixtures are unchanged. Each record identifies the implementation it measured; earlier records retain their historical source paths.

The pinned Codex package has an observed launcher limitation. Its [factory](https://github.com/mattsp1290/ag-ui/blob/ed2c1d5b63299d3f08676a1418cc2640bbe55fd1/integrations/community/codex-sdk/typescript/src/sdk.ts#L47) writes an extensionless CommonJS executable. With `TMPDIR` beneath a Node package whose type is module, Node rejects `require` before the controlled executable runs. The failed full replay and direct launcher reproduction are retained separately from the successful external-temporary-directory run. Upstream task `ag-ui-4ipx` owns the source fix. No workaround or repack is included in these archives.

`evidence/single-owner-node-qualification.log.gz` retains separate offline and full
replays after fork verification moved into `scripts/lib/agui-fork.mjs`. The driver
binds child Node processes to its own executable, records the actual npm version,
and emits hashes for itself, the fork module and all three consumer assertion scripts.
Older replay records retain their original paths and state their runtime-binding scope.

`evidence/archive-identity-node-qualification.log.gz` retains the separate offline
and full replay of the archive-identity verifier. Its emitted source hashes bind
the fork module, driver and all three consumer assertion scripts. Node children use the driver's executable; npm resolves with that directory
first on PATH and its version is recorded. The tar version identifies the host
archive reader; GNU tar also uses host gzip. Ambient runtime settings are inherited.

`evidence/closed-input-node-qualification.log.gz` retains the exact-copy verifier
replay. Consumer inputs and Pi fixtures must match their verified filename sets
before copying; retained file paths must be relative and stay within the fork
directory. The emitted record includes runtime configuration names and a digest
of NODE_OPTIONS, without its value.
