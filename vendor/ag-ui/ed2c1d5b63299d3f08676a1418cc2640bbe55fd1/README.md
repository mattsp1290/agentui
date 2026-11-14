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
python3 tests/dependencies/ag-ui/verify-consumer.py
node scripts/verify-agui-fork.mjs
```

The first command verifies bytes, manifests, notices, compressed evidence, fixture hashes and the independent frozen consumer lock without installing dependencies. The second requires POSIX, Python 3, npm and Node >=22.19. It creates an isolated temporary consumer outside the repository, copies the retained archives and consumer inputs, and runs `npm ci --ignore-scripts --include=optional --no-audit --no-fund`. It may download the lock's registry dependencies. Nothing installs automatically from normal tests. It removes the successful temporary consumer and preserves a failed one for inspection.

The consumer pins all six AG-UI packages to these local bytes, Codex SDK and CLI to `0.167.1`, all three Pi peers to `1.5.0`, and zod to `3.25.76`. The independent inputs are `tests/dependencies/ag-ui/consumer/package.json` and `package-lock.json`. All six Codex optional platform packages remain in that lock; the applicable native payload must be installed but is never executed. The verifier rejects registry AG-UI resolution, nested or extra AG-UI copies, mismatched installed manifests and incorrect SRI. Qualification imports every public package, runs Codex first turn and continuation through ESM and CommonJS against the controlled executable, and runs the 15 unchanged Pi tests with its controlled provider. Pi's exported example server only listens on loopback. No native provider credential or real agent is used.

`evidence/` retains complete acquisition, build, pack and consumer logs compressed without editing, source integrity and observed PR/check snapshots, and the exact source build lock. `provenance.json` records raw, retained and compressed sizes and SHA-256 values for each record. Paths inside those historical logs identify the measured environment only; replay uses the committed relative inputs above. Source verification found all 6,090 archived tracked blobs unchanged after builds and packs. The acquisition toolchain was Linux aarch64, Node `24.22.3`, npm `11.19.1` and pnpm `10.33.4`.

Replaying the consumer verifies these frozen bytes. Rebuilding source is a separate operation: acquire the exact source revision, verify the retained source-lock SHA-256, run its filtered frozen pnpm install, build/typecheck/tests and explicit package packs. The historical commands and results are retained in the acquisition logs. New packs must receive new digest evidence; no cross-machine or repeated-build byte identity is claimed.

This package qualification does not establish live native behavior, direct or LiteLLM routing, Apple application behavior, or a registry publication. The fork's recorded release-policy and Dojo CI failures remain upstream gaps. AgentUI's installed-core pin and the remaining packages' consumer qualification are separate evidence scopes. The pre-existing Switchboard Mac record is historical and unchanged.
