import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkExtensionEntrypoint, EXTENSION_SDK_VERSION, parseExtensionManifest } from '@agentui/sdk';
import type { ExtensionManifest, ServerExtensionEntry } from '@agentui/sdk';

export interface InstalledServerEntry {
  readonly directory: string;
  readonly manifest: unknown;
}
export interface LoadedServerEntry {
  readonly manifest: ExtensionManifest;
  readonly entry: ServerExtensionEntry;
}
function isServerEntry(manifest: ExtensionManifest, entry: unknown): entry is ServerExtensionEntry {
  return checkExtensionEntrypoint(manifest, 'server', entry).kind === 'compatible';
}
export async function loadServerExtension(source: InstalledServerEntry): Promise<LoadedServerEntry> {
  try {
    const manifest = parseExtensionManifest(source.manifest);
    const declaration = manifest.entries.find(entry => entry.kind === 'server');
    if (manifest.sdkVersion !== EXTENSION_SDK_VERSION || !declaration) throw new Error('Incompatible entry');
    const directory = await realpath(source.directory);
    const filename = await realpath(resolve(directory, declaration.module));
    const contained = relative(directory, filename);
    if (!contained || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained) || !(await stat(filename)).isFile()) {
      throw new Error('Invalid entry path');
    }
    const entry: unknown = (await import(pathToFileURL(filename).href)).default;
    if (!isServerEntry(manifest, entry)) throw new Error('Invalid entry export');
    return { manifest, entry };
  } catch { throw new Error('Server extension loading failed'); }
}
