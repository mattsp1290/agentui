import { isBuiltin } from 'node:module';

export function classifyHostSpecifier(imports: Readonly<Record<string, string>>, specifier: string): 'forbidden' | 'sdk' | 'builtin' | 'package' {
  if (specifier === 'module' || specifier === 'node:module') return 'forbidden';
  if (Object.hasOwn(imports, specifier)) return 'sdk';
  return isBuiltin(specifier) ? 'builtin' : 'package';
}
