# Mac installed Switchboard package qualification

PASS for the current unit requested by handoff `agentui-h-c9p6`.
Measured AgentUI source: `54065e29b732519d575e7d8e8cbcc196a7c0e162`.
Evidence branch: `codex/switchboard-macos-54065e2`.
The later evidence delivery commit is not the tested source.

The committed artifact was installed without rebuilding or repacking it:
`vendor/switchboard-58c7922d8fade3617cc86fedcf41677f897025ef.tgz`, 40,232 bytes,
SHA-256 `15416f5505eb8c3f5b0e3236a48f879f873661e46d27a652ad845f08cb0b9421`.
Switchboard source: `58c7922d8fade3617cc86fedcf41677f897025ef`.
Its computed npm integrity matches the request and is recorded in `provenance.json`.
No registry publication is claimed.

macOS 26.6.2 (25G83), arm64; Node 24.22.3, npm 11.19.1.
The capture records actual environment command outputs and UTC start/end timestamps.
The Node/npm toolchain was selected by prepending
`/tmp/agentui-ios-tools/node_modules/.bin` to PATH.

| Command from repository root | Exit | Result |
| --- | --- | --- |
| `node scripts/check-toolchain.mjs` | 0 | PASS |
| `npm ci` | 0 | PASS |
| `npm run build` | 0 | PASS |
| `node --test packages/adapter-tests/tests/switchboard.test.mjs packages/adapter-tests/tests/switchboard-types.test.mjs` | 0 | PASS: 5 tests, 5 pass, 0 fail/cancelled/skipped/todo |

The focused tests verify artifact/pin/manifest/lock and retained Linux-log integrity,
real installed parser correspondence, rejection of identity/target/choice mismatches,
independent error/effect/unknown-delivery facts, and positive-first compiler fixtures
through the canonical host configuration. The build compiled all current workspaces.
No full browser suite was requested or run as part of this Mac measurement.

All eleven requested frozen input SHA-256 hashes and Git blobs matched before the
commands ran. Artifact SHA-256, npm integrity and size also matched. All inputs and
the artifact remained unchanged afterward. The working tree was clean before and
after the measurement, before this evidence directory was added. The provenance
records the actual checks and statuses; no host, vendor, manifest, lock or fixture
inputs were edited.

Each command has a separate full combined stdout/stderr log and exit status.
The empty toolchain-check output is retained as an empty compressed stream.
The only log redaction replaces the local home-directory prefix with `~`; no lines
are omitted. Both original raw-output and retained-output digests are in the JSON,
as well as the compressed-file digests. Raw logs remain in the ignored local
`.audit/switchboard-macos-54065e2/` directory. `capture-procedure.py.txt` preserves
the measurement procedure with the same home-prefix substitution, as an audit
record rather than new project tooling.

This is installed-package and controlled-fixture compatibility only. Parser
correspondence to a supplied trusted pending record does not establish authorization,
current pendingness, single consumption, delivery, or safe retry. No Apple tooling,
native agent, packaged native adapter, provider call, or integrated application
behavior was exercised. Physical-device, live-update and integrated Apple
qualification remain outside this result. Linux owns integration and the repeated
review/fix/current-pinned-strict/fix cycle before PR4 merge.
