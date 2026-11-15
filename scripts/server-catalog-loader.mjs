import { isBuiltin, registerHooks } from 'node:module';

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
