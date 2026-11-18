import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_SDK_VERSION, parseExtensionManifest } from '@agentui/sdk';

const repository = fileURLToPath(new URL('../', import.meta.url));

/**
 * The first-party desktop plan: every `extensions/<name>` package whose canonical manifest declares a desktop entry,
 * sorted by namespace. It has the shape `desktopPlan` returns (`roots`, `entries`), and its roots are exactly the
 * extension directories, so core sources are never policed as customization sources. It names no extension.
 */
export function bundledPlan(root = repository) {
  const base = join(root, 'extensions');
  if (!existsSync(base)) return { roots: [], entries: [], identity: null };
  const entries = [], roots = [];
  for (const name of readdirSync(base, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) {
    const directory = realpathSync(join(base, name)), file = join(directory, 'package.json');
    if (!existsSync(file)) continue;
    const metadata = JSON.parse(readFileSync(file, 'utf8'));
    if (!metadata.agentui?.extension) continue;
    const manifest = parseExtensionManifest(metadata.agentui.extension);
    if (manifest.sdkVersion !== EXTENSION_SDK_VERSION) throw new Error(`Bundled extension ${manifest.namespace} targets SDK ${manifest.sdkVersion}, not ${EXTENSION_SDK_VERSION}`);
    const desktop = manifest.entries.find(entry => entry.kind === 'desktop');
    if (!desktop) continue;
    const mapped = metadata.agentui.sources?.[desktop.module];
    if (typeof mapped !== 'string') throw new Error(`Bundled extension ${manifest.namespace} has no source for ${desktop.module}`);
    const source = resolve(directory, mapped);
    if (relative(directory, source).startsWith('..') || !source.startsWith(directory + sep) || !existsSync(source)) {
      throw new Error(`Bundled extension ${manifest.namespace} source is missing or outside its package`);
    }
    roots.push(directory);
    entries.push({ module: desktop.module, manifest, source: realpathSync(source) });
  }
  const order = entries.map((entry, index) => [entry, roots[index]]).sort(([a], [b]) => a.manifest.namespace < b.manifest.namespace ? -1 : a.manifest.namespace > b.manifest.namespace ? 1 : 0);
  const names = order.map(([entry]) => entry.manifest.namespace);
  if (new Set(names).size !== names.length) throw new Error('Duplicate bundled extension namespace');
  return { roots: order.map(([, directory]) => directory), entries: order.map(([entry]) => entry), identity: null };
}
