# Switchboard artifact provenance

The host consumes `switchboard-2eadb11cbfc01787956a3b18ee500a922e2a7904.tgz`.

- Source repository is https://github.com/mattsp1290/switchboard.
- Source commit is `2eadb11cbfc01787956a3b18ee500a922e2a7904`.
- Package is private ESM `@mattsp1290/switchboard@0.0.0`. No npm publication is claimed.
- SHA-256 is `f096974d77384fda3960f48194fc304d78f5d5288f155ff723ef0f2ae9cdca89`.
- Build used Node 24.22.3 and npm 11.19.1 on macOS.
- Upstream `npm ci`, `npm run lint`, `npm run check`, and `npm test` passed.
- The installed-package test included 34 runtime fixture tests.
- Qualification covers core packaging, contracts, sessions, event streams, and authentication fixtures.
- Native Claude, Codex, Pi, AG-UI mappings, and live proxy behavior are not qualified.

## Reproduce the artifact

Use the pinned toolchain and a clean source archive.
Replace the source checkout path as appropriate.

```sh
git -C ../switchboard archive 2eadb11cbfc01787956a3b18ee500a922e2a7904 | tar -x -C /path/to/empty-build-directory
cd /path/to/empty-build-directory
npm ci
npm run lint
npm run check
npm test
npm pack --pack-destination /path/to/agentui/vendor
```

Rename the output `mattsp1290-switchboard-0.0.0.tgz` to the commit-named filename above.
Run `shasum -a 256` on the result and compare the recorded checksum.
The root lockfile also records npm integrity.
A mutable source link would not reproduce the dependency, and a Git dependency would lack built `dist` exports.
