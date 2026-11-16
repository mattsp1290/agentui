import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { commitId, containedPath, CustomizationError, repositoryAddress, identity, type CustomizationSource, type GitExtensionReference } from './contract.js';
import { selectPackage, type NpmInputs } from './packages.js';
import { SourceBudget } from './budget.js';
import { readCommittedRepository, type CommittedInputs, type RepositoryTree } from './repository.js';

export function packageIdentity(treeId: string, subdirectory: string): string { return identity(['agentui-package-v1', treeId, subdirectory]); }

export interface ResolvedCustomizationPackage {
  readonly identity: string;
  readonly commit: string;
  readonly directory: string;
  readonly repositoryDirectory: string;
  readonly subdirectory: string;
  readonly customization: CustomizationSource | undefined;
  readonly inputs: CommittedInputs;
  readonly npm: NpmInputs;
  readonly extensions: readonly ResolvedCustomizationPackage[];
}
export interface ResolvedCustomizationSources {
  readonly root: ResolvedCustomizationPackage;
  dispose(): Promise<void>;
}
/**
 * The caller must trust the pinned root and all committed descendant sources before resolving.
 * Resolution authorizes every descendant location transitively with the same host Git access and credentials.
 * Relative local locations at every depth resolve against the captured invocation directory.
 */
export async function resolveCustomizationSources(input: {
  readonly reference: GitExtensionReference;
  readonly scratchParent: string;
}): Promise<ResolvedCustomizationSources> {
  const cwd = process.cwd();
  const scratchParent = resolve(cwd, input.scratchParent);
  const budget = SourceBudget.graph();
  const repositories = new Map<string, RepositoryTree>();
  const packages = new Map<string, ResolvedCustomizationPackage>();
  const active = new Set<string>();
  let acquisitions = 0;
  let nodes = 0;
  let edges = 0;
  await mkdir(scratchParent, { recursive: true, mode: 0o700 });
  const owner = await mkdtemp(join(scratchParent, 'agentui-sources-'));
  const dispose = () => rm(owner, { recursive: true, force: true });
  const visit = async (reference: GitExtensionReference, depth: number, external: boolean): Promise<ResolvedCustomizationPackage> => {
    budget.check();
    if (depth > 32) throw new CustomizationError('resource-limit', 'Customization source traversal limit exceeded.');
    const commit = commitId(reference.commit);
    const location = repositoryAddress(reference.repository, cwd);
    if (location.address === undefined) throw new CustomizationError('retrieval-failed', 'Could not resolve committed customization sources.');
    const subdirectory = reference.subdirectory === undefined ? '' : containedPath(reference.subdirectory);
    const address = JSON.stringify([location.address, commit]);
    let tree = repositories.get(address);
    if (!tree) {
      if (++acquisitions > 16) throw new CustomizationError('resource-limit', 'Customization source repository limit exceeded.');
      tree = await readCommittedRepository({ transport: location.transport, commit, scratchParent: owner, budget });
      repositories.set(address, tree);
    }
    const key = JSON.stringify([address, subdirectory]);
    const id = packageIdentity(tree.inputs.identity, subdirectory);
    if (active.has(id)) throw new CustomizationError('invalid-package', 'Customization source dependency cycle detected.');
    const previous = packages.get(key);
    if (previous) return previous;
    if (++nodes > 64) throw new CustomizationError('resource-limit', 'Customization source package limit exceeded.');
    active.add(id);
    const selected = await selectPackage(tree, subdirectory, budget);
    if (external && !selected.customization) throw new CustomizationError('invalid-package', 'External sources require committed customization metadata.');
    const extensions: ResolvedCustomizationPackage[] = [];
    for (const child of selected.customization?.extensions ?? []) {
      if (++edges > 256) throw new CustomizationError('resource-limit', 'Customization source edge limit exceeded.');
      extensions.push(await visit(child, depth + 1, true));
    }
    const result: ResolvedCustomizationPackage = Object.freeze({ directory: selected.directory, repositoryDirectory: tree.directory, customization: selected.customization, npm: selected.npm, identity: id, commit: tree.commit,
      subdirectory, inputs: tree.inputs, extensions: Object.freeze(extensions) });
    active.delete(id);
    packages.set(key, result);
    return result;
  };
  try {
    return { root: await visit(input.reference, 0, false), dispose };
  } catch (error) {
    await dispose().catch(() => {});
    if (error instanceof CustomizationError) throw error;
    throw new CustomizationError('retrieval-failed', 'Could not resolve committed customization sources.');
  }
}
