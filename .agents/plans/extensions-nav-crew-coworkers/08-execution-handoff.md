# Execution handoff

No implementation has occurred. Each work package is one pull request unless stated.

## Order

```text
WP1 ─► WP2 ─► [G1] ─► WP3 ─► WP4a ─► WP4b ─► WP5 ─► WP6 ─► WP7 ─► WP8 ─► WP11
U3 answered ─► U-Crew      ─► [G2] ─► WP9  (after WP6)
U2 answered ─► U-Coworkers ─► [G3] ─► WP10 (after WP8)
```

## Work packages

| WP | Result | Detail file | Main change surface | Prerequisites |
|---|---|---|---|---|
| WP1 | Server-context installations; extension operations channel; wire 15; SDK 0.12.0 | [01](01-extension-operations.md) | `packages/sdk/src/extensions.ts`, `packages/contracts/src/service.ts`, `packages/contracts/src/compatibility.ts`, `packages/host/src/extensions/index.ts`, `apps/host/src/provider-extensions.ts`, `apps/host/src/provider-credentials.ts`, `apps/host/src/api.ts`, `apps/desktop/src-tauri/src/wire.rs`, `packages/client/src` | none |
| WP2 | Provider identity on agents and catalog entries; catalog provider filter; wire 16; no schema change | [02](02-agent-identity-and-catalog.md) | `packages/contracts/src/service.ts`, `apps/host/src/agents.ts`, `apps/host/src/api.ts`, `packages/host/src/sqlite-store.ts`, `wire.rs` | WP1 |
| WP3 | `workspace` contribution; Extensions rail item and view; SDK 0.13.0 | [03](03-workspace-views-and-navigation.md) | `packages/sdk/src/react.ts`, `apps/desktop/src/shell/BrowserApplication.tsx`, `apps/desktop/src/shell/Shell.tsx`, `apps/desktop/src/application/application-controller.ts`, `apps/desktop/src/application/ExtensionsView.tsx` (new), `application.css`, `tests/application/browser-support.mjs` | G1 |
| WP4a | `examples/crew` moved to `extensions/crew` | [04](04-bundled-extensions-and-launch.md) | move plus reference updates | WP3 |
| WP4b | Canonical manifests; desktop bundling; `desktop --extensions`; launcher discovery | [04](04-bundled-extensions-and-launch.md) | `extensions/crew/package.json`, `scripts/bundled-extensions.mjs` (new), `scripts/local-customization.mjs`, `scripts/build-local-customization.mjs`, `apps/desktop/vite.config.mjs`, `apps/host/src/main.ts`, `scripts/agentui-launch.mjs` | WP4a |
| WP5 | Crew server entry, multi-member discovery, `members.list`, `members.create` | [05](05-crew-extension.md) | `extensions/crew/src` | WP4b |
| WP6 | Crew Slack-style view with create, list and chat | [05](05-crew-extension.md) | `extensions/crew/src/desktop` | WP5 |
| WP7 | Coworkers provider, server entry, `coworkers.list` | [06](06-coworkers-extension.md) | `extensions/coworkers` (new) | WP6 |
| WP8 | Coworkers Teams-style view with list and chat | [06](06-coworkers-extension.md) | `extensions/coworkers/src/desktop` | WP7 |
| WP9 | Crew name, read, replace, retire, profiles | [05](05-crew-extension.md) | `vendor/crew-client`, `extensions/crew/src` | WP6 and G2 |
| WP10 | Coworkers create, read with text, update, delete | [06](06-coworkers-extension.md) | `extensions/coworkers` | WP8 and G3 |
| U-Crew | Crew member name, single read, retire, profile list, client methods | [07](07-upstream-requests.md) | the Crew repository | owner's answer to U3 |
| U-Coworkers | API-managed coworkers and single read | [07](07-upstream-requests.md) | the crabber-coworkers repository | owner's answers to U2 |
| WP11 | Documentation | below | `docs` | WP6 and WP8; revise after WP9 and WP10 |

## Parallelization

- WP1 through WP8 are sequential. WP1, WP2 and WP3 each bump a version constant that the others read. WP4a renames a directory that many tests import. The two extensions share the root `package.json`, `package-lock.json` and `tests/extensions/providers/conformance/providers.mjs`, and WP8's cross-extension test needs WP6.
- WP9 and WP10 are independent of each other.
- U-Crew and U-Coworkers run in other repositories and can run in parallel with WP1–WP8 once their owner decisions are made.

## WP11: Documentation

- `docs/architecture/extension-sdk.md`: add sections for `operations`, `extension-call`, `workspace`, the single active conversation rule (D4), bundled extensions, and `desktop --extensions`. Fix the `example-crew` / `crew-v2` example.
- `docs/architecture/boundaries.md`: replace the "planned examples" wording with the `extensions/` directory and its rule: service-specific code lives there, core stays generic.
- `docs/extensions/provider-contract.md`: add the polling-provider pattern with a link to the Coworkers provider.
- `docs/customization/sources.md`: the first-party bundling rule (D10).
- `docs/development/launcher.md`: the `extensions.json` location, the two token variable names, the missing-variable behaviour, restart-after-rebuild (D11), and the local-host-only rule (D13).
- New `docs/extensions/crew.md` and `docs/extensions/coworkers.md`: setup, the network exposure each service needs on the overlay network (risk R4), the TLS proxy crabber-coworkers requires when `api.allow_remote` is true, what each CRUD action does upstream, and the Crew replace-then-retire semantics.
- `README.md`: one paragraph and a link.
- Acceptance: every relative link in the changed documents resolves. Check with a script that walks the Markdown links, or by hand, and state which.

## Verification per package

Run these as separate commands and check each result.

```sh
npm run build
npm run check
npm run lint
npm test
```

- WP1, WP2: also run `cargo test` in `apps/desktop/src-tauri`.
- WP3, WP4b, WP6, WP8: browser tests need `npm run setup:browser` once and a completed `npm run build`.
- WP3, WP6, WP8: also start the app (`./agentui` or `npm run host:browser-dev` after a build) and exercise the view by hand. Report what was observed. Compile success is not evidence that the view works.
- WP4b, WP6, WP8, native mode: open the bundled Mac app against a local host started with `--extensions`, open each workspace, and create and chat. The native path has its own CSP and a Rust-owned transport that only `cargo test` covers otherwise. If the Mac app cannot be built or run in the implementing environment, state that the native check did not happen.
- WP5, WP7: run the live qualification, or state that it was not run.
- WP4b: run `node scripts/verify-agentui-launch.mjs` and confirm the four new cases pass. Run `npm run clean` and then `npm run desktop:build` as separate commands.
- WP9, WP10: also run the live qualification procedure, or state that it was not run.
- Every package: `git grep -n -i crew -- apps packages scripts templates` shows no new match.

Each pull request goes through the repository's dual-review step before merge.

## Integration and regression gates

- G1 before WP3: WP1 and WP2 merged; `npm run verify` green on `main`.
- After WP4b: the default build lists `Crew` as `Not configured` with no host extension file, and the existing Chats and Settings browser tests pass unchanged.
- After WP8: the cross-extension test passes (Crew transcript style, Coworkers transcript style, default style in Chats).
- G2 before WP9 and G3 before WP10: see [00-overview.md](00-overview.md#stopgo-gates). G2 includes the owner's answer to U3. G3 includes both parts of U2.
- Regression: the provider conformance suite passes for Crew and ledger at every step, and for Coworkers from WP7 on.
- Stop and ask the owner when a bean, review or finding asks for pairing, invites, device credentials or attestation.

## Rollback

- Each work package is one revertible pull request. WP1–WP3 change version constants; reverting one also reverts the constants, so revert in reverse merge order.
- No work package changes a stored data format, so a revert needs no data step.
- Removing `extensions.json`, or unsetting a token variable it names, returns the launcher-started host to native agents only. Saved provider conversations stay readable.

## Definition of done

Local milestone:

- WP1–WP8 and WP11 merged.
- Every local-milestone success criterion in [00-overview.md](00-overview.md#success-criteria) is demonstrated by a named test and by a manual run.
- The pull requests state which verification steps ran and which did not.
- The owner has reviewed the WP6 and WP8 screenshots and accepted the Slack-style and Teams-style direction, or has asked for changes that are then made.
- The local milestone is reported as partial: the user's CRUD outcome is not met until the full outcome.

Full outcome:

- U-Crew and U-Coworkers delivered, with U2 and U3 answered by the owner.
- WP9 and WP10 merged after their gates.
- Every full-outcome success criterion is demonstrated.
- `docs/qualification/crew.md` and `docs/qualification/coworkers.md` record the live runs or state that they did not happen.
- Both upstream response files exist and name the adopted commits.

## Deferred work

- iOS navigation and workspace rendering.
- Coworkers reply streaming, after upstream ships its AG-UI route.
- A Continue control for concluded Crew conversations in the workspace.
- Importing Crew or Coworkers conversations that were created outside AgentUI.
- Human-decision surfaces specific to Crew inside the workspace beyond the host's existing approvals.
- Mutable Crew member rename (U1).
- Conversation activity times and recency ordering in the host catalog.
- A Crew client `listConversations` method and crabber-coworkers time metadata, which the debate found in mission but which have no consumer in this plan.
- Documenting `ConversationCommands.revokePermission` in the SDK document, which the code has and the document omits.
- Installing, removing or configuring extensions from the UI.
- Bundled server extensions and token transport for remote-host launcher profiles (D13).
