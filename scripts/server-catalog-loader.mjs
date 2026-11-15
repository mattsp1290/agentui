import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isBuiltin, registerHooks } from 'node:module';

export function serverCatalogLinkage({ directory, manifest, abi }) {
  return { catalog: pathToFileURL(join(directory, manifest.catalog)).href, imports: abi.imports,
    allowed: [...abi.files, ...manifest.assets.map(asset => pathToFileURL(join(directory, asset.path)).href)] };
}

export function registerServerCatalogHooks({ imports, allowed }) {
  const urls = new Set(allowed);
  return registerHooks({ resolve(specifier, context, next) {
    if (Object.hasOwn(imports, specifier)) return { url: imports[specifier], shortCircuit: true };
    if (isBuiltin(specifier)) return next(specifier, context);
    const resolved = next(specifier, context);
    if (!urls.has(resolved.url)) throw new Error('Unsupported catalog import');
    return resolved;
  } });
}
