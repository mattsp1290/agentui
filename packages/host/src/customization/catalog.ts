import { resolve } from 'node:path';
import type { ExtensionManifest } from '@agentui/sdk';
import { CustomizationError } from './contract.js';
import type { CommittedInputs } from './repository.js';
import type { NpmInputs } from './packages.js';
import type { ResolvedCustomizationPackage } from './sources.js';
import { customizationPreorder } from './traversal.js';

export type CustomizationArtifactNpm = Extract<NpmInputs, { kind: 'absent' }> | Omit<Extract<NpmInputs, { kind: 'locked' }>, 'directory'>;

export interface CustomizationArtifactPackage {
  readonly identity: string;
  readonly commit: string;
  readonly subdirectory: string;
  readonly inputs: CommittedInputs;
  readonly npm: CustomizationArtifactNpm;
  readonly local: { readonly manifest: ExtensionManifest; readonly sources: readonly { readonly module: string; readonly source: string }[] } | null;
  readonly shared: string | null;
  readonly extensions: readonly { readonly packageIdentity: string; readonly commit: string }[];
}
export interface CustomizationCatalog {
  readonly packages: readonly CustomizationArtifactPackage[];
  readonly entries: readonly { readonly packageIdentity: string; readonly module: string; readonly manifest: ExtensionManifest }[];
}
export interface CustomizationCatalogPlan extends CustomizationCatalog {
  readonly repositoryDirectory: string;
  readonly roots: readonly string[];
  readonly sources: readonly string[];
}
export interface DesktopCustomizationIdentity {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly packages: readonly CustomizationArtifactPackage[];
  readonly entries: readonly { readonly packageIdentity: string; readonly module: string }[];
}
export function desktopCustomizationIdentity(plan: CustomizationCatalog): DesktopCustomizationIdentity {
  const root = plan.packages[0];
  if (!root) throw CustomizationError.fixed('invalid-graph');
  return { schemaVersion: 1, root: root.identity, packages: plan.packages,
    entries: plan.entries.map(({ packageIdentity, module }) => ({ packageIdentity, module })) };
}
export function customizationCatalog(packages: readonly CustomizationArtifactPackage[], sdkVersion: string, kind: 'server' | 'desktop'): CustomizationCatalog {
  const invalidGraph = () => CustomizationError.fixed('invalid-graph');
  const root = packages[0];
  const lookup = new Map(packages.map(pkg => [pkg.identity, pkg]));
  if (!root || lookup.size !== packages.length) throw invalidGraph();
  const ordered = customizationPreorder({ packageIdentity: root.identity, commit: root.commit }, edge => edge.packageIdentity, edge => {
    const pkg = lookup.get(edge.packageIdentity);
    if (!pkg) throw invalidGraph();
    return pkg.extensions;
  }).map(edge => {
    const pkg = lookup.get(edge.packageIdentity)!;
    if (pkg.commit !== edge.commit) throw invalidGraph();
    return pkg;
  });
  const namespaces = new Set<string>();
  const entries: CustomizationCatalog['entries'][number][] = [];
  for (const pkg of ordered) {
    if (!pkg.local) continue;
    const { manifest } = pkg.local;
    if (manifest.sdkVersion !== sdkVersion || namespaces.has(manifest.namespace)) throw invalidGraph();
    namespaces.add(manifest.namespace);
    for (const entry of manifest.entries.filter(entry => entry.kind === kind)) {
      entries.push({ packageIdentity: pkg.identity, module: entry.module, manifest });
    }
  }
  if (ordered.length !== packages.length) throw invalidGraph();
  return { packages: ordered, entries };
}
export function planCustomizationCatalog(root: ResolvedCustomizationPackage, sdkVersion: string, kind: 'server' | 'desktop'): CustomizationCatalogPlan {
  const nodes = customizationPreorder(root, node => node.identity, node => node.extensions);
  const packages = nodes.map((node): CustomizationArtifactPackage => {
    let npm: CustomizationArtifactNpm = node.npm;
    if (node.npm.kind === 'locked') { const { directory: _directory, ...locked } = node.npm; npm = locked; }
    const local = node.customization?.local;
    return { identity: node.identity, commit: node.commit, subdirectory: node.subdirectory, inputs: node.inputs, npm,
      local: local ? { manifest: local.manifest,
        sources: [...local.sources].map(([module, source]) => ({ module, source })).sort((a, b) => a.module < b.module ? -1 : a.module > b.module ? 1 : 0) } : null,
      shared: node.customization?.shared ?? null, extensions: node.extensions.map(child => ({ packageIdentity: child.identity, commit: child.commit })) };
  });
  const catalog = customizationCatalog(packages, sdkVersion, kind);
  const absolute = new Map(nodes.map(node => [node.identity,
    new Map([...(node.customization?.local?.sources ?? [])].map(([module, source]) => [module, resolve(node.directory, source)]))]));
  const sources = catalog.entries.map(entry => {
    const source = absolute.get(entry.packageIdentity)?.get(entry.module);
    if (!source) throw CustomizationError.fixed('invalid-graph');
    return source;
  });
  return { ...catalog, repositoryDirectory: root.repositoryDirectory,
    roots: [...new Set(nodes.map(node => node.repositoryDirectory))], sources };
}
