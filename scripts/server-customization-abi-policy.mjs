import { isBuiltin } from 'node:module';

export function classifyHostSpecifier(imports, specifier) {
  if (specifier === 'module' || specifier === 'node:module') return 'forbidden';
  if (Object.hasOwn(imports, specifier)) return 'sdk';
  return isBuiltin(specifier) ? 'builtin' : 'package';
}
