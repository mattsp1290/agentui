import { loadServerArtifact, loadServerExtension } from '@agentui/host/extensions';
import type { InstalledServerEntry, LoadedServerEntry, ServerExtensionSource } from '@agentui/host/extensions';
import type { ProviderExtension } from '@agentui/host';
import { readServerCustomizationArtifact, serverCatalog } from '@agentui/host/customization';
import type { VerifiedServerCustomizationArtifact } from '@agentui/host/customization';
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

type Prepared = {
  readonly manifests: readonly ExtensionManifest[];
  readonly installations: readonly ProviderInstallation[];
} & (
  | { readonly kind: 'artifact'; readonly verified: VerifiedServerCustomizationArtifact }
  | { readonly kind: 'installed'; readonly directory: string; readonly manifest: ExtensionManifest }
  | { readonly kind: 'entry'; readonly manifest: ExtensionManifest; readonly entry: ServerExtensionEntry }
);

export function providerExtensionSource(database: AccessDatabase, selected: readonly BrowserProviderExtension[]): ServerExtensionSource {
  return { async prepare() {
    const loaded: { readonly loaded: LoadedServerEntry; readonly installations: readonly ProviderInstallation[] }[] = [];
    const extensions: ProviderExtension[] = [];
    const cleanup = async () => {
      const authorities = await Promise.allSettled(extensions.map(extension => extension.authority.close()));
      const modules = await Promise.allSettled(loaded.map(extension => Promise.resolve().then(() => extension.loaded.dispose?.())));
      return [...authorities, ...modules].some(result => result.status === 'rejected');
    };
    let failure: 'load' | 'authorization' = 'load';
    try {
      const prepared: Prepared[] = [];
      const namespaces = new Set<string>();
      for (const extension of selected) {
        failure = 'load';
        let item: Prepared;
        if (extension.kind === 'artifact') {
          const verified = await readServerCustomizationArtifact({ directory: extension.directory, expected: serverArtifactExpectation(extension.artifactId) });
          item = { kind: 'artifact', verified, manifests: serverCatalog(verified.manifest.packages, verified.manifest.sdkVersion).manifests,
            installations: extension.installations };
        } else {
          const manifest = parseExtensionManifest(extension.manifest);
          item = extension.kind === 'installed' ? { kind: 'installed', directory: extension.directory, manifest,
            manifests: [manifest], installations: extension.installations } : { kind: 'entry', entry: extension.entry, manifest,
            manifests: [manifest], installations: extension.installations };
        }
        for (const manifest of item.manifests) {
          if (manifest.sdkVersion !== EXTENSION_SDK_VERSION || !manifest.entries.some(entry => entry.kind === 'server') || namespaces.has(manifest.namespace)) throw new Error();
          namespaces.add(manifest.namespace);
          failure = 'authorization';
          normalizeProviderInstallations(manifest.namespace, item.installations.filter(grant => grant.instance.namespace === manifest.namespace));
        }
        if (item.installations.some(grant => !item.manifests.some(manifest => manifest.namespace === grant.instance.namespace))) throw new Error();
        prepared.push(item);
      }
      failure = 'load';
      for (const item of prepared) {
        const entries = item.kind === 'artifact' ? await loadServerArtifact(item.verified, serverArtifactSdk())
          : item.kind === 'installed' ? [await loadServerExtension(item)] : [{ manifest: item.manifest, entry: item.entry }];
        loaded.push(...entries.map(entry => ({ loaded: entry, installations: item.installations.filter(grant => grant.instance.namespace === entry.manifest.namespace) })));
      }
    } catch {
      return await cleanup() ? { kind: 'failed', failure: 'cleanup', recovery: 'restart' } : { kind: 'failed', failure, recovery: 'replace' };
    }
    try {
      for (const extension of loaded) {
        extensions.push({ ...extension.loaded, authority: createProviderAuthority(database,
          extension.loaded.manifest.namespace, extension.installations) });
      }
      return { kind: 'ready', extensions };
    } catch {
      return await cleanup() ? { kind: 'failed', failure: 'cleanup', recovery: 'restart' }
        : { kind: 'failed', failure: 'authorization', recovery: 'replace' };
    }
  } };
}
