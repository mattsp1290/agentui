import { loadServerArtifact, loadServerExtension } from '@agentui/host/extensions';
import type { InstalledServerEntry, LoadedServerEntry, ServerExtensionFailure, ServerExtensionSource } from '@agentui/host/extensions';
import type { ProviderExtension } from '@agentui/host';
import { readServerCustomizationArtifact, serverCatalog } from '@agentui/host/customization';
import type { ServerCustomizationArtifact, VerifiedServerCustomizationArtifact } from '@agentui/host/customization';
import { EXTENSION_SDK_VERSION, parseExtensionManifest } from '@agentui/sdk';
import type { ExtensionManifest, ServerExtensionEntry } from '@agentui/sdk';
import type { AccessDatabase } from './access-database.js';
import { createProviderAuthority, normalizeProviderInstallations } from './provider-credentials.js';
import type { ProviderInstallation } from './provider-credentials.js';
import { serverArtifactExpectation, serverArtifactSdk } from './server-artifact-runtime.js';

export type BrowserProviderExtension = (
  | { readonly kind?: never; readonly manifest: ExtensionManifest; readonly entry: ServerExtensionEntry }
  | { readonly kind: 'installed' } & InstalledServerEntry
  | { readonly kind: 'artifact'; readonly directory: string; readonly artifactId: string }
) & { readonly installations: readonly ProviderInstallation[] };

export type ArtifactPin = { readonly directory: string; readonly artifactId: string };
export type ProviderExtensionSelection =
  | { readonly kind: 'entries'; readonly entries: readonly BrowserProviderExtension[] }
  | { readonly kind: 'artifacts'; readonly pins: readonly ArtifactPin[]; readonly grants: readonly ProviderInstallation[] };

type Prepared = {
  readonly manifests: readonly ExtensionManifest[];
  readonly installations: readonly ProviderInstallation[];
} & (
  | { readonly kind: 'artifact'; readonly directory: string; readonly verified: VerifiedServerCustomizationArtifact }
  | { readonly kind: 'installed'; readonly directory: string; readonly manifest: ExtensionManifest }
  | { readonly kind: 'entry'; readonly manifest: ExtensionManifest; readonly entry: ServerExtensionEntry }
);

type PreparedSelection =
  | { readonly kind: 'ready'; readonly entries: readonly Prepared[]; readonly artifacts: readonly ServerCustomizationArtifact[] }
  | ServerExtensionFailure;
async function prepareProviderExtensions(selected: ProviderExtensionSelection): Promise<PreparedSelection> {
  const prepared: Prepared[] = [];
  const namespaces = new Set<string>();
  let failure: 'load' | 'authorization' = 'load';
  try {
    const entries = selected.kind === 'entries' ? selected.entries : selected.pins.map(pin => ({ ...pin, kind: 'artifact' as const, installations: selected.grants }));
    for (const extension of entries) {
      failure = 'load';
      let item: Prepared;
      if (extension.kind === 'artifact') {
        const directory = extension.directory;
        const verified = await readServerCustomizationArtifact({ directory, expected: serverArtifactExpectation(extension.artifactId) });
        const manifests = serverCatalog(verified.manifest.packages, verified.manifest.sdkVersion).manifests;
        item = { kind: 'artifact', directory, verified, manifests,
          installations: selected.kind === 'artifacts'
            ? extension.installations.filter(grant => manifests.some(manifest => manifest.namespace === grant.instance.namespace)) : extension.installations };
      } else {
        const manifest = parseExtensionManifest(extension.manifest);
        item = extension.kind === 'installed' ? { kind: 'installed', directory: extension.directory, manifest,
          manifests: [manifest], installations: extension.installations } : { kind: 'entry', entry: extension.entry, manifest,
          manifests: [manifest], installations: extension.installations };
      }
      for (const manifest of item.manifests) {
        if (manifest.sdkVersion !== EXTENSION_SDK_VERSION || !manifest.entries.some(entry => entry.kind === 'server') || namespaces.has(manifest.namespace)) throw new Error();
        namespaces.add(manifest.namespace);
      }
      failure = 'authorization';
      if (item.installations.some(grant => !item.manifests.some(manifest => manifest.namespace === grant.instance.namespace))) throw new Error();
      const installations = item.manifests.flatMap(manifest =>
        normalizeProviderInstallations(manifest.namespace, item.installations.filter(grant => grant.instance.namespace === manifest.namespace)));
      prepared.push({ ...item, installations });
    }
    return { kind: 'ready', entries: prepared, artifacts: prepared.flatMap(item => item.kind === 'artifact' ? [item.verified.manifest] : []) };
  } catch { return { kind: 'failed', failure, recovery: 'replace' }; }
}

/** Namespaces a selection configures, read from its grants and the manifests known before loading. */
export function selectedNamespaces(selected: ProviderExtensionSelection): readonly string[] {
  const grants = selected.kind === 'entries' ? selected.entries.flatMap(entry => entry.installations) : selected.grants;
  const manifests = selected.kind === 'entries' ? selected.entries.flatMap(entry => {
    if (entry.kind === 'artifact') return [];
    try { return [parseExtensionManifest(entry.manifest).namespace]; } catch { return []; }
  }) : [];
  return [...new Set([...grants.map(grant => grant.instance.namespace), ...manifests])].sort();
}

export async function verifyArtifactPins(pins: readonly ArtifactPin[], grants: readonly ProviderInstallation[]): Promise<readonly ServerCustomizationArtifact[]> {
  const prepared = await prepareProviderExtensions({ kind: 'artifacts', pins, grants });
  if (prepared.kind === 'failed') throw new Error('Invalid artifact selection');
  return prepared.artifacts;
}

export function providerExtensionSource(database: AccessDatabase, selected: ProviderExtensionSelection): ServerExtensionSource {
  return { namespaces: () => selectedNamespaces(selected), async prepare() {
    const loaded: { readonly loaded: LoadedServerEntry; readonly installations: readonly ProviderInstallation[] }[] = [];
    const extensions: ProviderExtension[] = [];
    const cleanup = async () => {
      const authorities = await Promise.allSettled(extensions.map(extension => extension.authority.close()));
      const modules = await Promise.allSettled(loaded.map(extension => Promise.resolve().then(() => extension.loaded.dispose?.())));
      return [...authorities, ...modules].some(result => result.status === 'rejected');
    };
    const prepared = await prepareProviderExtensions(selected);
    if (prepared.kind === 'failed') return prepared;
    try {
      for (const item of prepared.entries) {
        const entries = item.kind === 'artifact' ? await loadServerArtifact(item.verified, serverArtifactSdk())
          : item.kind === 'installed' ? [await loadServerExtension(item)] : [{ manifest: item.manifest, entry: item.entry }];
        loaded.push(...entries.map(entry => ({ loaded: entry, installations: item.installations.filter(grant => grant.instance.namespace === entry.manifest.namespace) })));
      }
    } catch {
      return await cleanup() ? { kind: 'failed', failure: 'cleanup', recovery: 'restart' } : { kind: 'failed', failure: 'load', recovery: 'replace' };
    }
    try {
      for (const extension of loaded) {
        extensions.push({ ...extension.loaded, authority: createProviderAuthority(database,
          extension.loaded.manifest.namespace, extension.installations),
          installations: extension.installations.map(grant => ({ id: grant.id, instance: grant.instance, service: grant.service,
            expectedAuthority: grant.expectedAuthority })) });
      }
      return { kind: 'ready', extensions };
    } catch {
      return await cleanup() ? { kind: 'failed', failure: 'cleanup', recovery: 'restart' }
        : { kind: 'failed', failure: 'authorization', recovery: 'replace' };
    }
  } };
}
