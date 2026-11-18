# Execution handoff

No implementation has occurred. Each work package is one pull request unless stated.

## Order

```text
PR 138 merged ─► WP1 ─► WP2 ─► [G1] ─► WP3 ─► WP4 ─► WP5 ─► WP6 ─► [G2] ─► WP7 ─► WP8 ─► WP13
                  │
                  ├─► WP9  (U-Crew, upstream)      ─► [G3] ─► WP10
                  └─► WP11 (U-Coworkers, upstream) ─► [G4] ─► WP12
```

## Work packages

| WP | Result | Detail file | Main change surface | Prerequisites |
|---|---|---|---|---|
| WP1 | Both extensions parse and build as referenced customization packages; SDK 0.14.0 | [01](01-referencable-extensions.md) | `packages/sdk`, `extensions/*/package.json`, four server source files | PR 138 |
| WP2 | Same-repository references, `enabled`, `installations`, the settings file | [02](02-source-model.md) | `packages/host/src/customization/contract.ts`, `sources.ts`, `catalog.ts`, `installations.ts` (new), `settings.ts` (new), `apps/host/src/server-extension-config.ts` | WP1 |
| WP3 | Example customization; default build has no extensions | [03](03-example-and-unbundling.md) | `examples/customization` (new), `apps/desktop/vite.config.mjs`, `scripts/build-local-customization.mjs`, `tests/support/working-tree-plan.mjs` (moved) | G1 |
| WP4 | Relay operations and host state; wire 17 (all ten operations reserved) | [04](04-host-relay-and-worker.md) | `packages/contracts/src/service.ts`, `apps/host/src/customization-relay.ts` (new), `apps/host/src/api.ts`, `apps/desktop/src-tauri/src/wire.rs`, `packages/client` | WP3 |
| WP5 | Worker: connection, commit and push, settings commits | [04](04-host-relay-and-worker.md) | `scripts/agentui-customization-worker.mjs` (new), `scripts/lib/customization-git.mjs` (new), `scripts/lib/customization-store.mjs` (new), `scripts/agentui-launch.mjs` | WP4 |
| WP6 | Worker builds with build keys and one preparation | [05](05-builds-and-apply.md) | `scripts/build-customization.mjs` (new), `scripts/prepare-customization-sources.mjs`, `packages/host/src/customization/budget.ts`, the worker | WP5 |
| WP7 | Delivery, apply by restart, client reconnect and reload; setup-root `extensions.json` removed | [05](05-builds-and-apply.md) | `scripts/agentui-launch-session.mjs`, `scripts/agentui-launch.mjs`, `apps/host/src/customization-relay.ts`, `packages/host/src/local-host.ts`, `apps/desktop/src/application/application-controller.ts`, both workspace setup texts | WP6 and G2 |
| WP8 | Settings sections, Extensions page, appearance and default agent | [06](06-settings-and-extensions-ui.md) | `apps/desktop/src/application/CustomizationRepository.tsx` (new), `SettingsPreferences.tsx` (new), `default-agent.ts` (new), `ExtensionsView.tsx`, `BrowserApplication.tsx`, `Shell.tsx`, `application-controller.ts` | WP7 |
| WP9 | U-Crew: retire route, client method, capability | [07](07-agent-delete-and-create.md) | the Crew repository | none |
| WP10 | Crew Delete | [07](07-agent-delete-and-create.md) | `vendor/crew-client`, `extensions/crew`, `package-lock.json` | WP1 and G3 |
| WP11 | U-Coworkers: create, delete, `source`, capability | [07](07-agent-delete-and-create.md) | the crabber-coworkers repository | none |
| WP12 | Coworkers create and delete | [07](07-agent-delete-and-create.md) | `extensions/coworkers` | WP1 and G4 |
| WP13 | Documentation | below | `docs`, `README.md` | WP8; revise after WP10 and WP12 |

Versions: WP1 sets SDK 0.14.0. WP4 sets wire 17 and reserves every operation of this plan; later packages implement them without another bump. Until WP7, the host refuses `customization-apply` with `not-ready`.

## Parallelization

- WP1 through WP8 are sequential.
- WP9 and WP11 run in other repositories and can start at once, in parallel with everything.
- WP10 and WP12 are independent of each other and of WP2–WP8. They share `package.json`, `package-lock.json` and extension files with WP1, WP3 and WP7, so each rebases on the latest `main` before merge.
- WP3 and WP7 should land close together, because between them the launcher-started app has no extensions.

## WP13: Documentation

- `docs/customization/sources.md`: final wording for same-repository references, `enabled`, `installations`, the settings file, and the example.
- `docs/customization/connected-repository.md` (created in WP4): the worker and where it runs, connect, toggle, settings, commit messages, the never-force rule, git settings (hooks off, identity required, signing honoured), build keys and states, delivery to a remote host, apply by restart, fallback and staleness, where logs and state live on each machine, and the overlay-network trust statement.
- `docs/development/launcher.md`: remove the setup-root `extensions.json` section; document the worker, the session wrapper's restart on exit code 75, `extensionVariables`, the missing-token behaviour, and SSH delivery.
- `docs/architecture/extension-sdk.md`: SDK 0.14.0 note; replace the bundled-extensions section with a pointer to the connected-repository document.
- `docs/extensions/crew.md` and `docs/extensions/coworkers.md`: enabling through the example customization; Delete and Create semantics after WP10 and WP12, including the `api.manage_coworkers` precondition.
- `examples/customization/README.md`: final check against the implemented flow, including the rule that every extension change on `main` must be merged into the connected branch.
- `README.md`: one paragraph and links.
- Acceptance: every relative link in the changed documents resolves, checked with a script that walks Markdown links.

## Verification per package

Use Node 24.22.3 (the host build refuses other major versions). Run these as separate commands and check each result.

```sh
npm run build
npm run check
npm run lint
npm test
```

- WP4, and any later package that touches `apps/desktop/src-tauri`: also `cargo test` in `apps/desktop/src-tauri`.
- WP1 and WP3: the network tier (`AGENTUI_CUSTOMIZATION_NETWORK_TESTS=1`) once, recorded for gate G1.
- WP3: also `npm run clean`, then `npm run desktop:build`.
- WP6: gate G2's real build, with phase durations recorded.
- WP7, WP8: the manual checks listed in their files (local, real `--ssh` host, Mac app, AgentUI update). State what ran and what did not.
- WP10, WP12: the live qualification and the connected-flow check, or a statement that each was not run.
- Every package: `git grep -n -i "crew\|coworker\|crabber" -- apps packages scripts templates` shows no match.
- `tests/examples/mcp/refresh/terminal.test.mjs` has failed intermittently with `kill EPERM` in earlier runs and is unrelated to this work. If only that test fails, rerun and report both runs.
- `node scripts/verify-agentui-launch.mjs` drives real SSH hosts and real agent chats. It is not an automated gate; WP7's manual SSH check covers the new behaviour. State whether it was run.

Each pull request goes through the repository's dual-review step before merge, and review fixes are reviewed before they are committed.

## Integration and regression gates

- G1 before WP3, G2 before WP7, G3 before WP10, G4 before WP12: see [00-overview.md](00-overview.md#stopgo-gates).
- After WP3: the provider conformance suite passes for Crew, ledger and Coworkers, and the extension browser tests pass against the test bundle.
- After WP7: SSH sessions still start. The wrapper-alone test, the launcher-level fallback test and the existing launcher tests pass.
- After WP8: the full flow passes in a browser test (connect, toggle, commit visible on the remote, build, apply, reload, agent gone).
- Stop and ask the owner when a bean, review or finding asks for pairing, invites, device credentials or attestation, or for a force push.

## Rollback

- Each work package is one revertible pull request. Revert in reverse merge order where version constants changed.
- The plan adds files only under `<setup root>/customization/` on the launcher machine and on remote hosts, and under `<data-dir>/customization/` on the host. Removing those directories returns a machine to no connection and default assets.
- WP7 removes the setup-root `extensions.json` flow. Reverting WP7 restores it; the plan never deletes the file itself.
- A commit the worker pushed to the connected repository is ordinary history. The user reverts it with git. The worker never rewrites it.

## Definition of done

- WP1–WP8 and WP13 merged: every success criterion in [00-overview.md](00-overview.md#success-criteria) about the repository-driven flow and settings is shown by a named test and by a manual run, including the SSH path.
- WP9–WP12 merged after their gates: the Delete and Create criteria are shown the same way, and both upstream response files name the adopted commits.
- `docs/qualification/crew.md` and `docs/qualification/coworkers.md` record the live runs or state that they did not happen.
- The pull requests state which verification steps ran and which did not.

## Deferred work

- Live apply without a host restart.
- A worker for hosts the launcher did not start.
- Adding, removing or reordering references, and editing installations, from the UI.
- More settings in the settings file.
- Update of a Crew member or a coworker; the remaining items of the two 2026-11-17 upstream requests.
- iOS.
