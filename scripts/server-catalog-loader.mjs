import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { classifyHostSpecifier } from './server-customization-abi-policy.mjs';

const unsupportedImport = () => Object.assign(new Error('Unsupported catalog import'), { code: 'ERR_UNSUPPORTED_CATALOG_IMPORT' });

export function serverCatalogLinkage({ directory, manifest, abi }) {
  return { catalog: pathToFileURL(join(directory, manifest.catalog)).href, imports: abi.imports,
    allowed: [...abi.files, ...manifest.assets.map(asset => pathToFileURL(join(directory, asset.path)).href)] };
}

export function registerServerCatalogHooks({ imports, allowed }) {
  const urls = new Set(allowed);
  return registerHooks({ resolve(specifier, context, next) {
    const kind = classifyHostSpecifier(imports, specifier);
    if (kind === 'forbidden') throw unsupportedImport();
    if (kind === 'sdk') return { url: imports[specifier], shortCircuit: true };
    if (kind === 'builtin') return next(specifier, context);
    const resolved = next(specifier, context);
    if (!urls.has(resolved.url)) throw unsupportedImport();
    return resolved;
  } });
}
