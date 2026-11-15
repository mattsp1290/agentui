import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { checkExtensionEntrypoint } from '@agentui/sdk';
import { serverCatalog } from '../customization/server-artifact.js';
import { classifyHostSpecifier } from '../customization/server-artifact-policy.js';
import type { VerifiedServerCustomizationArtifact } from '../customization/server-artifact.js';
import type { ExtensionManifest, ServerExtensionEntry } from '@agentui/sdk';
import type { LoadedServerEntry } from './loader.js';

function isServerEntry(manifest: ExtensionManifest, entry: unknown): entry is ServerExtensionEntry {
  return checkExtensionEntrypoint(manifest, 'server', entry).kind === 'compatible';
}

export async function loadServerArtifact(verified: VerifiedServerCustomizationArtifact, sdk: string): Promise<readonly LoadedServerEntry[]> {
  const prefix = `agentui-server://${randomUUID()}/`;
  const assets = new Map(verified.manifest.assets.map(asset => [new URL(asset.path, prefix).href, verified.readAsset(asset.path)]));
  const imports = { '@agentui/sdk': sdk };
  const unsupported = () => new Error('Unsupported server artifact import');
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (!context.parentURL?.startsWith(prefix) && !specifier.startsWith(prefix)) return next(specifier, context);
      const kind = classifyHostSpecifier(imports, specifier);
      if (kind === 'forbidden') throw unsupported();
      if (kind === 'sdk') return { url: sdk, shortCircuit: true };
      if (kind === 'builtin') return next(specifier, context);
      if (!specifier.startsWith(prefix) && !specifier.startsWith('./') && !specifier.startsWith('../')) throw unsupported();
      const url = new URL(specifier, context.parentURL ?? prefix).href;
      if (!assets.has(url)) throw unsupported();
      return { url, shortCircuit: true };
    },
    load(url, context, next) {
      if (!url.startsWith(prefix)) return next(url, context);
      const source = assets.get(url);
      if (!source) throw unsupported();
      return { format: 'module', source, shortCircuit: true };
    },
  });
  let disposed = false;
  const dispose = async () => { if (!disposed) { disposed = true; hooks.deregister(); assets.clear(); } };
  try {
    const { entries }: { entries?: unknown } = await import(new URL(verified.manifest.catalog, prefix).href);
    const { manifests } = serverCatalog(verified.manifest.packages, verified.manifest.sdkVersion);
    if (!Array.isArray(entries) || entries.length !== manifests.length) throw unsupported();
    return manifests.map((manifest, index) => {
      const entry: unknown = entries[index];
      if (!isServerEntry(manifest, entry)) throw unsupported();
      return { manifest, entry, dispose };
    });
  } catch { await dispose(); throw new Error('Server artifact loading failed'); }
}
