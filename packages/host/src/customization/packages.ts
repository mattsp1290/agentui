import { record } from '@agentui/contracts/decode';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { containedPath, CustomizationError, dependencyGroups, parseCustomizationPackage, validateNpmManifest } from './contract.js';
import { identity, type RepositoryTree, type SourceFile } from './repository.js';

export type NpmInputs = { readonly kind: 'absent' } | {
  readonly kind: 'locked';
  readonly identity: string;
  readonly packageManager: 'npm@11.19.1';
  readonly directory: string;
  readonly packageJson: SourceFile;
  readonly lockfile: SourceFile;
  readonly workspaces: readonly SourceFile[];
  readonly localInputs: readonly SourceFile[];
};

function localPath(base: string, value: string): string {
  if (!value || value.startsWith('/') || /[\\:]/u.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || value.split('/').some(part => part.toLowerCase() === '.git')) {
    throw new CustomizationError('path', 'Npm inputs must remain inside the committed repository.');
  }
  const path = posix.normalize(posix.join(base, value));
  if (path === '..' || path.startsWith('../')) throw new CustomizationError('path', 'Npm inputs must remain inside the committed repository.');
  return path === '.' ? '' : containedPath(path);
}
function safeRemote(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function integrity(value: unknown): boolean {
  return typeof value === 'string' && /^(?:sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2})(?:\s+sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2})*$/u.test(value);
}

export async function selectPackage(tree: RepositoryTree, subdirectory: string) {
  try {
    const inventory = new Map(tree.inputs.files.map(file => [file.path, file]));
    const manifestPath = (path: string) => posix.join(path, 'package.json');
    const selectedFile = inventory.get(manifestPath(subdirectory));
    if (!selectedFile) {
      if (subdirectory) throw new Error('Missing selected package');
      return { directory: tree.directory, customization: undefined, npm: { kind: 'absent' } satisfies NpmInputs };
    }
    const manifests = new Map<string, Record<string, unknown>>();
    const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(join(tree.directory, path), 'utf8'));
    const manifest = async (path: string) => {
      const existing = manifests.get(path);
      if (existing) return existing;
      const value = record(await readJson(manifestPath(path)));
      manifests.set(path, value);
      return value;
    };
    const workspacePaths = (root: string, pkg: Record<string, unknown>): string[] => {
      if (pkg.workspaces === undefined) return [];
      const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : record(pkg.workspaces).packages;
      if (!Array.isArray(patterns)) throw new Error('Unsupported workspace declarations');
      const members = new Set<string>();
      for (const pattern of patterns) {
        if (typeof pattern !== 'string' || /[?!{}[\]]/u.test(pattern)) throw new Error('Unsupported workspace pattern');
        const wildcard = pattern.endsWith('/*');
        const literal = wildcard ? pattern.slice(0, -2) : pattern;
        if (literal.includes('*')) throw new Error('Unsupported workspace pattern');
        const prefix = posix.join(root, containedPath(literal));
        const matches = wildcard ? [...inventory.keys()].filter(path => path.startsWith(`${prefix}/`) &&
          path.endsWith('/package.json') && path.slice(prefix.length + 1).split('/').length === 2).map(path => posix.dirname(path)) : [prefix];
        for (const path of matches) {
          if (!inventory.has(manifestPath(path)) || members.has(path)) throw new Error('Missing or overlapping workspaces');
          members.add(path);
        }
      }
      return [...members].sort();
    };
    const selected = await manifest(subdirectory);
    const metadata = selected.agentui === undefined ? {} : record(selected.agentui);
    if (Object.keys(metadata).every(key => key === 'extensions' && Array.isArray(metadata.extensions) && !metadata.extensions.length)) {
      return { directory: join(tree.directory, subdirectory), customization: undefined, npm: { kind: 'absent' } satisfies NpmInputs };
    }
    const owners: { path: string; members: string[] }[] = [];
    let ancestor = subdirectory;
    while (ancestor) {
      ancestor = posix.dirname(ancestor);
      if (ancestor === '.') ancestor = '';
      if (!inventory.has(manifestPath(ancestor))) continue;
      const members = workspacePaths(ancestor, await manifest(ancestor));
      if (members.includes(subdirectory)) owners.push({ path: ancestor, members });
    }
    if (owners.length > 1 || (owners.length && inventory.has(posix.join(subdirectory, 'package-lock.json')))) {
      throw new Error('Ambiguous npm ownership');
    }
    const owner = owners[0] ?? { path: subdirectory, members: workspacePaths(subdirectory, selected) };
    const root = await manifest(owner.path);
    const lockfile = inventory.get(posix.join(owner.path, 'package-lock.json'));
    const relativeFiles = new Set([...inventory.keys()].filter(path => !subdirectory || path.startsWith(`${subdirectory}/`))
      .map(path => subdirectory ? path.slice(subdirectory.length + 1) : path));
    const lock = lockfile ? await readJson(lockfile.path) : undefined;
    const context = { lock, packagePath: posix.relative(owner.path, subdirectory), packageManager: root.packageManager };
    const customization = parseCustomizationPackage(selected, relativeFiles, context);
    if (!customization) return { directory: join(tree.directory, subdirectory), customization, npm: { kind: 'absent' } satisfies NpmInputs };
    const packages = [{ path: owner.path, pkg: root }];
    for (const path of owner.members) packages.push({ path, pkg: await manifest(path) });
    const needsLock = owner.members.length > 0 || packages.some(({ pkg }) => dependencyGroups.some(key => pkg[key] !== undefined && Object.keys(record(pkg[key])).length > 0));
    if (!needsLock && !lockfile) return { directory: join(tree.directory, subdirectory), customization, npm: { kind: 'absent' } satisfies NpmInputs };
    if (!lockfile) throw new Error('Missing lockfile');
    const entries = record(record(lock).packages);
    const localFiles = new Map<string, SourceFile>();
    const capture = (path: string) => {
      const files = tree.inputs.files.filter(file => file.path === path || !path || file.path.startsWith(`${path}/`));
      if (!files.length) throw new Error('Missing local npm input');
      for (const file of files) localFiles.set(file.path, file);
    };
    for (const { path, pkg } of packages) {
      if (pkg.packageManager !== undefined && pkg.packageManager !== root.packageManager) throw new Error('Conflicting npm pin');
      validateNpmManifest(pkg, { lock, packagePath: posix.relative(owner.path, path), packageManager: root.packageManager });
    }
    const lockedDependency = (path: string, name: string): unknown => {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) throw new Error('Invalid dependency name');
      let search = path;
      while (true) {
        const entry = entries[posix.join(search, 'node_modules', name)];
        if (entry !== undefined || !search) return entry;
        search = posix.dirname(search);
        if (search === '.') search = '';
      }
    };
    for (const [path, value] of Object.entries(entries)) {
      if (path) localPath(owner.path, path);
      const entry = record(value);
      if (entry.link === true) {
        if (typeof entry.resolved !== 'string') throw new Error('Invalid local link');
        const target = localPath(owner.path, entry.resolved);
        if (!inventory.has(manifestPath(target))) throw new Error('Missing linked package');
        capture(target);
        const pkg = await manifest(target);
        if (pkg.packageManager !== undefined && pkg.packageManager !== root.packageManager) throw new Error('Conflicting npm pin');
        validateNpmManifest(pkg, { lock, packagePath: posix.relative(owner.path, target), packageManager: root.packageManager });
        if (!packages.some(value => value.path === target)) packages.push({ path: target, pkg });
      } else if (path.split('/').includes('node_modules')) {
        if (typeof entry.version !== 'string' || !entry.version) throw new Error('Invalid locked version');
        if (typeof entry.resolved === 'string' && entry.resolved.startsWith('file:')) capture(localPath(owner.path, entry.resolved.slice(5)));
        else if (!safeRemote(entry.resolved) || !integrity(entry.integrity)) throw new Error('Unsupported locked source');
      }
      for (const group of ['dependencies', 'optionalDependencies']) {
        const declarations = entry[group] === undefined ? {} : record(entry[group]);
        for (const [name, spec] of Object.entries(declarations)) {
          if (typeof spec !== 'string' || lockedDependency(path, name) === undefined) throw new Error('Missing locked dependency input');
          if (spec.startsWith('file:')) capture(localPath(localPath(owner.path, path || '.'), spec.slice(5)));
          else if (/[:/]/u.test(spec) && !spec.startsWith('npm:') && !safeRemote(spec)) throw new Error('Unsupported dependency source');
        }
      }
      if (entry.resolved !== undefined && (typeof entry.resolved !== 'string' ||
        (entry.link !== true && !entry.resolved.startsWith('file:') && !safeRemote(entry.resolved)))) throw new Error('Invalid resolved source');
    }
    for (const { path, pkg } of packages) {
      const packagePath = posix.relative(owner.path, path);
      for (const group of dependencyGroups) {
        const declarations = pkg[group] === undefined ? {} : record(pkg[group]);
        for (const [name, spec] of Object.entries(declarations)) {
          if (typeof spec !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) throw new Error('Invalid dependency');
          if (spec.startsWith('link:')) throw new Error('Unsupported npm link declaration');
          const localTarget = spec.startsWith('file:') ? localPath(path, spec.slice(5)) : undefined;
          if (localTarget !== undefined) capture(localTarget);
          else if (/[:/]/u.test(spec) && !spec.startsWith('npm:') && !safeRemote(spec)) throw new Error('Unsupported dependency source');
          const found = lockedDependency(packagePath, name);
          if (found === undefined) {
            const meta = pkg.peerDependenciesMeta === undefined ? {} : record(pkg.peerDependenciesMeta);
            if (group === 'peerDependencies' && meta[name] !== undefined && record(meta[name]).optional === true) continue;
            throw new Error('Missing locked dependency');
          }
          const entry = record(found);
          if (localTarget !== undefined) {
            if (typeof entry.resolved !== 'string' || localPath(owner.path, entry.link === true ? entry.resolved : entry.resolved.startsWith('file:') ? entry.resolved.slice(5) : ':') !== localTarget) throw new Error('Local lock target disagrees');
            if (inventory.has(manifestPath(localTarget))) {
              validateNpmManifest(await manifest(localTarget), { lock, packagePath: posix.relative(owner.path, localTarget), packageManager: root.packageManager });
            }
          }
          if (safeRemote(spec) && (entry.resolved !== spec || !integrity(entry.integrity))) throw new Error('Unpinned remote tarball');
        }
      }
    }
    const rootFile = inventory.get(manifestPath(owner.path));
    if (!rootFile) throw new Error('Missing npm root');
    const workspaces = owner.members.map(path => {
      const file = inventory.get(manifestPath(path));
      if (!file) throw new Error('Missing workspace');
      return file;
    });
    const localInputs = [...localFiles.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const npm: NpmInputs = Object.freeze({ kind: 'locked', packageManager: 'npm@11.19.1', directory: join(tree.directory, owner.path),
      identity: identity(['agentui-npm-v1', tree.inputs.identity, owner.path, selectedFile, rootFile, lockfile, workspaces, localInputs]),
      packageJson: rootFile, lockfile, workspaces: Object.freeze(workspaces), localInputs: Object.freeze(localInputs) });
    return { directory: join(tree.directory, subdirectory), customization, npm };
  } catch (error) {
    if (error instanceof CustomizationError) throw error;
    throw new CustomizationError('invalid-package', 'Invalid committed package, workspace ownership, or npm inputs.');
  }
}
