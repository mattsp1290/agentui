import { findPackageJSON } from 'node:module';

export const resolveHostDependency = (specifier) => import.meta.resolve(specifier);
export const importHostDependency = (specifier) => import(specifier);
export const hostDependencyManifest = (specifier) => findPackageJSON(specifier, import.meta.url);
