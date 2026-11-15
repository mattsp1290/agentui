# Committed customization sources

Copy this directory into your customization Git repository and commit it. The desktop example declares a Plan review module that sends a prompt to the current conversation. Its shared prompt is ordinary source imported by the desktop entry. iOS and server entries remain undeclared, leaving their shipped defaults available.

This template uses the existing private AgentUI SDK, React, and desktop primitives as imports provided by the future host builder. It has no npm dependencies or lockfile. It is not a standalone npm build. Build provisioning, module composition, and activation are separate work. Reading this snapshot does not display the module or change a running conversation.

The Node host resolves the committed package and its pinned external sources through its dedicated entry point.

```ts
import { resolveCustomizationSources } from '@agentui/host/customization';

const sources = await resolveCustomizationSources({
	reference: {
		repository: '/home/me/personal-agentui',
		commit: fullCommitId,
	},
	scratchParent: '/home/me/.agentui/sources',
});
try {
	console.log(sources.root.directory, sources.root.customization);
} finally {
	await sources.dispose();
}
```

`package.json.agentui.extension` is the existing SDK manifest. `sources` maps every declared runtime module to exactly one committed source file. The future builder produces `./dist/desktop.js`; it does not need to exist in Git. All source paths start with `./` and remain inside the repository. An absent package, absent `agentui`, or empty `agentui` declares no customization. Shared or external inputs may appear without a local extension.

Optional `extensions` entries declare immutable external sources. The resolver retrieves them recursively in declaration order. Repeated references share the same package object. External packages require meaningful `agentui` metadata. Before resolution, the caller must trust the pinned root and every source declared transitively by its committed descendants. Resolving the root authorizes all descendant repository locations with the same host Git access and credentials, including local paths and remote repositories. Relative repository paths at every depth use the captured invocation working directory.

```json
{
  "repository": "git@example.org:me/widgets.git",
  "commit": "0123456789012345678901234567890123456789",
  "subdirectory": "packages/widgets"
}
```

Use Node 24.22.3 or newer within Node 24 and npm 11.19.1. If you add actual npm dependencies, commit an npm v3 `package-lock.json` whose root dependency declarations, name, and version agree with `package.json`. The resolver validates declarations against the committed lock entries and retains exact lock bytes. Required dependencies and peers must have pinned lock targets. Optional peers may be absent. Registry and remote tarball entries require SHA-256, SHA-384, or SHA-512 integrity pins. SHA-1 integrity and bundled entries without their own source and integrity pins are unsupported. Git npm sources and `link:` declarations are unsupported. Contained committed `file:` tarballs and links to declared members of the selected npm workspace retain their files. Other local directory links and lock keys outside the selected npm root are unsupported. A local link can require a separate npm installation context whose transitive pins are absent from the parent lock, even when npm accepts that lock. Use a supported workspace layout or a contained tarball instead. The resolver never installs packages or runs scripts. The builder owns installation, host ABI provisioning, and any additional npm qualification.

Every read fetches the full commit into private storage, copies raw regular-file blobs, and leaves your working tree, index, refs, and `FETCH_HEAD` alone. Dirty and untracked changes are excluded. Executable bits are preserved. LFS pointers stay pointer bytes. Symlinks and Git submodules are unsupported. Git uses existing SSH agents and credential helpers. Do not put passwords or tokens in repository URLs. Custom code will run with host or client process privileges when a later builder and activation path enables it.

A selected `subdirectory` reads that package's metadata while preserving the complete repository for sibling imports. Workspace declarations support literal paths and a trailing `/*` over immediate packages, as an array or a `packages` array inside an object. Duplicate patterns, overlapping declarations, and unsupported patterns on any examined ancestor fail. A declaring ancestor owns the npm lock. Multiple declaring ancestors, or a selected package lock alongside a declaring ancestor, fail as ambiguous. Workspace manifests and contained local package manifests must agree with their exact lock entries. Sibling workspace customization does not activate automatically.

Each package exposes `directory`, `customization`, ordered `extensions`, and `inputs`. The file inventory contains repository-relative paths, SHA-256 byte hashes, and executable flags for every committed regular file. Its identity excludes temporary directories and repository addresses. The package identity also includes its selected subdirectory. `npm.kind` is `absent` or `locked`. An active package with no dependencies or workspace members returns `absent` even when it has a valid stray lockfile and no npm pin. That lockfile still contributes its exact bytes to the file inventory and identity. Locked inputs retain the npm directory, root manifest, exact lockfile, workspace manifests, local inputs, and a deterministic identity. The complete committed repository contributes to these identities. Ambient npm configuration is neither read nor qualified. Committed configuration remains part of the file inventory.

One resolution owns private storage for its complete graph. Concurrent calls have independent directories. Disposal is idempotent and a failed descendant removes the entire failing owner's storage. Limits cover 16 repository acquisitions, 64 packages, 256 declared edges, depth 32, 50000 files, 256 MiB of aggregate raw content, and ten minutes. Package analysis checks the same deadline inside its loops. Each selection also permits at most 256 workspace patterns per manifest, 10000 lock entries, and 50000 dependency declarations across analyzed manifests and lock entries. Individual Git commands allow up to 30 seconds, or 120 seconds for retrieval, within that deadline. These limits do not bound Git's transient downloaded object storage.

The existing `readCustomizationSnapshot` operation remains available for a single root snapshot with unresolved external references. It permits 20000 files and 256 MiB. Dispose each successful snapshot or resolved graph when its consumer finishes.
