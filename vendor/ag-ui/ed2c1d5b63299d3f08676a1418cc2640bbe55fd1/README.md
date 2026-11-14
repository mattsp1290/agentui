# Frozen AG-UI fork packages

These six archives contain the bytes built from [mattsp1290/ag-ui PR 49](https://github.com/mattsp1290/ag-ui/pull/49), branch `matt.spurlin/typescript-sdks`, source `ed2c1d5b63299d3f08676a1418cc2640bbe55fd1`, tree `4dd1b37d5fd8486b022827c102f2b53ea2bfdfc8`. Their package versions alone do not identify this source. `provenance.json` binds each archive to its size, SHA-256, SHA-512, npm SRI, complete member list and packed manifest.

| Package | Version | Archive SHA-256 |
| --- | --- | --- |
| `@ag-ui/core` | 1.0.4 | `2cd54a879083e0c351e8c38861b1d2e2b7355a5712b7128da690257c687dad19` |
| `@ag-ui/proto` | 1.0.4 | `f351b5f7ac651330d9e75c395f397540174f85a63fcfad33488dd949f3460501` |
| `@ag-ui/encoder` | 1.0.4 | `e0ce4386279aea136154a3a44d3d9d9570bf546696651cc19a915ae1783f0ff6` |
| `@ag-ui/client` | 1.0.4 | `242dd3f0a45139992da3de96efb6f5c71eb6b9d56f76133756fc4f85175880cc` |
| `@ag-ui/codex-sdk` | 0.0.1 | `4e9529559941198532842b040a5c5b16f861b300c8bd8c5e67b23f4535f11b1a` |
| `@ag-ui/pi` | 0.0.1 | `9cc320d8549901d181abe04e5027dbb5a87bd88b7eed0131b110dbe2aac3447c` |

Every archive includes its MIT notice. Extracted notices and packed manifests are in `notices/` and `manifests/`. Pi preserves YS-BW's MIT notice and donor provenance for `YS-BW/pi-agui` source `ee810dfb9ad3fe81d8854e9121b84ddee4c59148`. No retained archive has been patched or repacked.

`provenance.json` is the frozen acquisition identity, including the source lock, fixture and consumer digests, acquisition evidence and historical commands. `qualification.json` holds current commands, later replay records, their evidence and known limitations. It binds back to the frozen identity through `identityProvenanceSha256`. Its `historicalClarifications` preserve later corrections to historical descriptions without changing the frozen record. The protocol report binds `provenance.json`; adding a qualification record does not change that identity or require a protocol report update.

## Run package qualification

Run these commands from the AgentUI repository root:

```sh
node scripts/verify-agui-fork.mjs --offline
node scripts/verify-agui-fork.mjs
```

The offline command verifies archive bytes, ordered members, packed manifests, notices, acquisition and qualification evidence, the source lock, fixture contents and the independent consumer lock. The full command repeats these checks, then installs and exercises an isolated consumer. Normal application tests do not install this consumer.

Both commands require POSIX and system `tar`. The driver enforces Node >=22.19, the Pi package floor. Retained Node replays used Node `24.22.3`; other Node versions are unmeasured. GNU tar also requires host `gzip`. The full command requires npm and may download the frozen lock's registry dependencies. It uses `npm ci --ignore-scripts --include=optional --no-audit --no-fund`, removes a successful temporary consumer and preserves a failed one for inspection. Process timeouts terminate the direct child; descendants may survive.

The consumer pins all six AG-UI packages to these local archives, Codex SDK and CLI to `0.167.1`, all three Pi peers to `1.5.0`, and zod to `3.25.76`. Its inputs are `tests/dependencies/ag-ui/consumer/package.json` and `package-lock.json`. All six Codex optional platform packages remain in that lock. The applicable native payload must be installed but is never executed. The verifier rejects registry AG-UI resolution, linked, nested or extra AG-UI copies, mismatched installed manifests and incorrect SRI.

Qualification imports every public package, runs Codex first turn and continuation through ESM and CommonJS against the controlled executable, and runs the 15 unchanged Pi tests with their controlled provider. Pi's exported example server listens on loopback. No native provider credential or real agent is used.

## Node execution and launcher scope

`scripts/lib/agui-fork.mjs` owns fork verification and returns the checked package and fixture records. The driver copies from that record without reparsing the fixture index. Fixture paths must be unique and include the controlled Codex executable. Consumer inputs and Pi fixtures must match their verified filename sets before copying. Retained file paths must stay within the fork directory.

The archive reader uses bounded system `tar` calls with `LC_ALL=C` and removes `TAR_OPTIONS`, `TAR_READER_OPTIONS`, `TAR_WRITER_OPTIONS`, `GZIP` and `TAPE`. Node children use the driver's executable. npm resolves with that executable's directory first on PATH, and the driver records the actual npm version. The emitted record also identifies tar, the five qualification source files and inherited runtime configuration names. A `NODE_OPTIONS` digest identifies the inherited value without printing it. The digest does not conceal short or guessable values. Ambient Node and npm settings remain inherited. Each `qualification.json` replay records the source bytes and execution scope it measured. Earlier records keep their original paths and runtime scope.

The pinned Codex package has an observed launcher limitation. Its [factory](https://github.com/mattsp1290/ag-ui/blob/ed2c1d5b63299d3f08676a1418cc2640bbe55fd1/integrations/community/codex-sdk/typescript/src/sdk.ts#L47) writes an extensionless CommonJS executable. With `TMPDIR` beneath a Node package whose type is module, Node rejects `require` before the controlled executable runs. The failed full replay and direct launcher reproduction are retained separately from the successful run with an external temporary directory. Upstream task `ag-ui-4ipx` owns the source fix. These archives contain no workaround or repack.

Retained Node replays cover Linux arm64 with GNU tar. Record `tar --version` for another host. macOS and BSD tar require separately labelled measurements. The pre-existing Switchboard Mac record remains historical and unchanged.

## Retained evidence and rebuilds

`evidence/` contains complete acquisition, build, pack and consumer logs, source integrity records, PR and check snapshots, and the source build lock. The identity and qualification files record raw, retained and compressed sizes and SHA-256 values. The verifier checks evidence from both files and requires every Node replay log to name a verified evidence record. Paths inside historical logs describe their measured environments; current replay uses the committed relative inputs.

The earlier `agui49-consumer-proof` used `npm install` and a pre-retention lock with SHA-256 `0b8f55a697fc9615468273b94dbf55e4e718f4113e16c7a38f1598874f6e10a3`. `retention-replay.log.gz` exercises the committed consumer lock with SHA-256 `239a43a9ac72e7c18b7e84a9b32f410546a3ebc507d73d4539686852705c81cd` using `npm ci`. `standard10-replay.log.gz` records a later frozen-consumer run with the historical lock-derived readers and optimized-Python rejection guard. The frozen identity retains those Python commands as history. `qualification.json` gives the current Node commands and the source-scope clarification for that historical run.

Source verification found all 6,090 archived tracked blobs unchanged after builds and packs. The acquisition toolchain was Linux aarch64, Node `24.22.3`, npm `11.19.1` and pnpm `10.33.4`.

Rebuilding source is a separate operation. Acquire the exact revision, verify the retained source-lock SHA-256, run its filtered frozen pnpm install, then build, typecheck, test and pack the packages. The acquisition logs retain the historical commands and results. New packs need new digest evidence. No repeated-build or cross-machine byte identity is claimed.

## Qualification limits and upstream preparation

This package qualification does not establish live native behavior, direct or LiteLLM routing, Apple application behavior, or registry publication. AgentUI's installed-core pin and the other packages' consumer qualification are separate evidence scopes.

The fork's recorded CI is red at this exact source. Failed checks are `publish` (two runs), `release-allowlist-sync`, `check-config-files`, `licenses`, `dojo / event-trace-unit` and `dojo / check-generated-files`. Skipped checks are `dojo / codex-sdk-typescript`, `dojo / ${{ matrix.suite }}` and `fork-pr-monitor`. Cancelled checks are `dotnet / unit + integration`, `dotnet / cross-language (TS <-> C#)` and `claude-managed-agents-dotnet`. The complete snapshot is `evidence/agui49-checks-snapshot.json.gz`.

The [failed license-policy job](https://github.com/mattsp1290/ag-ui/actions/runs/42942702235/job/130268067856) reports `Public package @ag-ui/codex-sdk needs a license policy entry`. Its complete output is `evidence/upstream-license-policy.log.gz`. Every retained archive's MIT notice and Pi's donor notice were independently checked. Those checks do not make the upstream policy gate pass. Task `ag-ui-whx0` owns the license, release and configuration preparation gaps. Task `ag-ui-sbz5` and [PR 50](https://github.com/mattsp1290/ag-ui/pull/50) own separate Pi CI synchronization. This frozen source includes no fix from that unmerged PR.

Upstream's combined-branch Codex Dojo browser job was skipped. The retained successful upstream TypeScript job, exact-source local package tests, installed exports and declaration checks, and controlled consumer fixtures are separate executed evidence. They do not establish the skipped combined Dojo or Flutter suite.
