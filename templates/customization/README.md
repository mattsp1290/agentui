# Build a local Plan review panel

Copy this directory into a local Git repository and commit it. The desktop module sends the shared review prompt to the selected conversation and shows the actual submission outcome. It leaves the composer draft untouched. Only committed source enters the build.

Use Node 24.22.3 within Node 24 and npm 11.19.1. Prepare AgentUI with its ordinary `npm ci` and `npm run build` first. From the AgentUI checkout, build a separate browser artifact with a full immutable commit ID and a new output directory.

```sh
node scripts/build-local-customization.mjs \
  --repository /absolute/personal-agentui \
  --commit FULL_COMMIT_ID \
  --out /absolute/custom-desktop
node apps/host/dist/main.js codex \
  --data-dir /absolute/private-host-data \
  --workspace /absolute/project \
  --assets /absolute/custom-desktop
```

The existing `pi` and `browser-dev` commands also accept `--assets`. Without it, startup uses the ordinary installed browser artifact. Open the host's browser address, pair, and select a conversation. Plan review appears below chat. Click **Review the plan** to submit the committed prompt. An accepted receipt means submitted, not completed. Uncertain outcomes use the existing conversation recovery controls.

To remove the panel, open Settings, expand View options, and choose Restore default view. The current conversation and draft remain available. Reloading the artifact enables the panel again.

Custom code has full browser privileges. This is not a sandbox. Only build code you trust.

## Supported inputs

`package.json.agentui.extension` is the existing SDK manifest. `sources` maps each declared runtime module to one committed source file. The runtime module path, such as `./dist/desktop.js`, is an identity in the manifest and does not need to exist in Git. The builder selects the desktop source and bundles it with AgentUI. Other platform declarations are preserved without building those targets. An absent package, absent `agentui`, or absent desktop entry leaves the default application available.

The local builder accepts dependency-free JavaScript, TypeScript, JSX, and TSX with contained relative source imports. Relative `.js` imports can resolve committed `.ts` or `.tsx` files. React, `@agentui/sdk`, `@agentui/sdk/react`, and `@agentui/ui-primitives/desktop` come from the installed AgentUI build and share its React runtime.

Nonempty npm dependency declarations, workspaces, package import maps, and external customization references are unsupported. The builder never installs packages or executes repository scripts or configuration. Assets, CSS imports, other bare imports, absolute imports, computed loading, ambient references, and source JSX configuration are unsupported. The known AgentUI toolchain supplies compiler settings. Nested modules, module actions, and frontend tools are not implemented by this panel host.

The builder reserves a fresh output directory, retains the private committed snapshot throughout the build, generates the ordinary artifact manifest, verifies every asset, and publishes the complete result. Failed builds remove their output and private staging. An existing output is never replaced. The identity asset records the customization commit, namespace, and selected runtime module. The host verifies and retains the artifact bytes at startup.

## Source loader

The source APIs remain available separately through `@agentui/host/customization`. `readCustomizationSnapshot` reads one root snapshot. `resolveCustomizationSources` retrieves a pinned root and its external sources recursively, including selected monorepo packages and committed npm inputs. See the [source API reference](../../docs/customization/sources.md) for ownership, supported inputs, trust, and limits. These broader source inputs remain unsupported by the local desktop builder.

Every read fetches the full commit into private storage and copies raw regular-file blobs. Working files, the index, refs, and `FETCH_HEAD` remain unchanged. Dirty and untracked changes are excluded. Executable bits are preserved; LFS pointers stay pointer bytes. Symlinks and Git submodules are unsupported.

Snapshots permit up to 20000 files and 256 MiB of materialized content. Individual Git commands are bounded to 30 seconds, with 120 seconds for retrieval. Dispose successful snapshots after use. Failed reads remove their own temporary directory.
