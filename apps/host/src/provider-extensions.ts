import { loadServerExtension } from '@agentui/host/extensions';
import type { InstalledServerEntry, LoadedServerEntry, ServerExtensionSource } from '@agentui/host/extensions';
import type { ProviderExtension } from '@agentui/host';
import type { ExtensionManifest, ServerExtensionEntry } from '@agentui/sdk';
import type { AccessDatabase } from './access-database.js';
import { createProviderAuthority } from './provider-credentials.js';
import type { ProviderInstallation } from './provider-credentials.js';

export type BrowserProviderExtension = (
  | { readonly kind?: never; readonly manifest: ExtensionManifest; readonly entry: ServerExtensionEntry }
  | { readonly kind: 'installed' } & InstalledServerEntry
) & { readonly installations: readonly ProviderInstallation[] };

export function providerExtensionSource(database: AccessDatabase, selected: readonly BrowserProviderExtension[]): ServerExtensionSource {
  return { async prepare() {
    const loaded: { readonly loaded: LoadedServerEntry; readonly installations: readonly ProviderInstallation[] }[] = [];
    try {
      for (const extension of selected) {
        loaded.push({ loaded: extension.kind === 'installed' ? await loadServerExtension(extension)
          : { manifest: extension.manifest, entry: extension.entry }, installations: extension.installations });
      }
    } catch { return { kind: 'failed', failure: 'load', recovery: 'replace' }; }
    const extensions: ProviderExtension[] = [];
    try {
      for (const extension of loaded) {
        extensions.push({ ...extension.loaded, authority: createProviderAuthority(database,
          extension.loaded.manifest.namespace, extension.installations) });
      }
      return { kind: 'ready', extensions };
    } catch {
      const cleanup = await Promise.allSettled(extensions.map(extension => extension.authority.close()));
      return cleanup.some(result => result.status === 'rejected')
        ? { kind: 'failed', failure: 'cleanup', recovery: 'restart' }
        : { kind: 'failed', failure: 'authorization', recovery: 'replace' };
    }
  } };
}
