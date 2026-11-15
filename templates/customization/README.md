# Committed customization sources

Copy this directory into your customization Git repository and commit it. The desktop example declares a Plan review module that sends a prompt to the current conversation. Its shared prompt is ordinary source imported by the desktop entry. iOS and server entries remain undeclared, leaving their shipped defaults available.

This template uses the existing private AgentUI SDK, React, and desktop primitives as imports provided by the future host builder. It has no npm dependencies or lockfile. It is not a standalone npm build. Build provisioning, module composition, and activation are separate work. Reading this snapshot does not display the module or change a running conversation.

The Node host can read the committed sources through its dedicated entry point.

```ts
import { readCustomizationSnapshot } from '@agentui/host/customization';

const snapshot = await readCustomizationSnapshot({
  repository: '/home/me/personal-agentui',
  commit: fullCommitId,
  scratchParent: '/home/me/.agentui/sources',
});
try {
  // Pass snapshot.directory and snapshot.customization to the future builder.
} finally {
  await snapshot.dispose();
}
```

`package.json.agentui.extension` is the existing SDK manifest. `sources` maps every declared runtime module to exactly one committed source file. The future builder produces `./dist/desktop.js`; it does not need to exist in Git. All source paths start with `./` and remain inside the repository. An absent package, absent `agentui`, or empty `agentui` declares no customization. Shared or external inputs may appear without a local extension.

Optional `extensions` entries retain an immutable external source reference. This loader validates their syntax. External object retrieval and recursive dependency resolution are separate work.

```json
{
  "repository": "git@example.org:me/widgets.git",
  "commit": "0123456789012345678901234567890123456789",
  "subdirectory": "packages/widgets"
}
```

Use Node 24.22.3 or newer within Node 24 and npm 11.19.1. If you add actual npm dependencies, commit an npm v3 `package-lock.json` whose root dependency declarations, name, and version agree with `package.json`. The loader preserves those files and never installs packages or runs scripts. The builder will own complete lock resolution and host ABI provisioning.

Every read fetches the full commit into private storage, copies raw regular-file blobs, and leaves your working tree, index, refs, and `FETCH_HEAD` alone. Dirty and untracked changes are excluded. Executable bits are preserved. LFS pointers stay pointer bytes. Symlinks and Git submodules are unsupported. Git uses existing SSH agents and credential helpers. Do not put passwords or tokens in repository URLs. Custom code will run with host or client process privileges when a later builder and activation path enables it.

The snapshot currently permits up to 20000 files and 256 MiB of materialized content. Individual Git commands are bounded to 30 seconds, with 120 seconds for retrieval. Dispose each successful snapshot when its consumer finishes. Failed reads remove their own temporary directory.
