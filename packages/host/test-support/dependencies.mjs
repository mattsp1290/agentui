import { findPackageJSON } from 'node:module';
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const resolveHostDependency = (specifier) => import.meta.resolve(specifier);
export const importHostDependency = (specifier) => import(specifier);
export const hostDependencyManifest = (specifier) => findPackageJSON(specifier, import.meta.url);

export const hostDependencyLockKey = (specifier) => relative(
  fileURLToPath(new URL('../../../', import.meta.url)),
  dirname(hostDependencyManifest(specifier)),
).split(sep).join('/');
