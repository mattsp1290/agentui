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
interface DeclarationContext { readonly lookupPath: string; readonly sourceDirectory: string }

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

export async function selectPackage(tree: RepositoryTree, subdirectory: string, allowance = { deadline: Infinity }) {
  const check = () => {
    if (Date.now() >= allowance.deadline) throw new CustomizationError('resource-limit', 'Customization source analysis limit exceeded.');
  };
  let declarations = 0;
  const boundDeclarations = (pkg: Record<string, unknown>) => {
    for (const group of dependencyGroups) {
      check();
      declarations += pkg[group] === undefined ? 0 : Object.keys(record(pkg[group])).length;
      if (declarations > 50_000) throw new CustomizationError('resource-limit', 'Customization source declaration limit exceeded.');
    }
  };
  try {
    const inventory = new Map<string, SourceFile>();
    const directories = new Map<string, { files: SourceFile[]; children: Set<string> }>();
    for (const file of tree.inputs.files) {
      check();
      inventory.set(file.path, file);
      let path = posix.dirname(file.path);
      if (path === '.') path = '';
      if (!directories.has(path)) directories.set(path, { files: [], children: new Set() });
      directories.get(path)?.files.push(file);
      while (path) {
        check();
        const parent = posix.dirname(path) === '.' ? '' : posix.dirname(path);
        if (!directories.has(parent)) directories.set(parent, { files: [], children: new Set() });
        const children = directories.get(parent)?.children;
        if (children?.has(path)) break;
        children?.add(path);
        path = parent;
      }
    }
    const manifestPath = (path: string) => posix.join(path, 'package.json');
    const selectedFile = inventory.get(manifestPath(subdirectory));
    if (!selectedFile) {
      if (subdirectory) throw new Error('Missing selected package');
      return { directory: tree.directory, customization: undefined, npm: { kind: 'absent' } satisfies NpmInputs };
    }
    const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(join(tree.directory, path), 'utf8'));
    const selected = record(await readJson(manifestPath(subdirectory)));
    const metadata = selected.agentui === undefined ? {} : record(selected.agentui);
    if (Object.keys(metadata).every(key => key === 'extensions' && Array.isArray(metadata.extensions) && !metadata.extensions.length)) {
      return { directory: join(tree.directory, subdirectory), customization: undefined, npm: { kind: 'absent' } satisfies NpmInputs };
    }
    boundDeclarations(selected);
    const manifests = new Map<string, Record<string, unknown>>([[subdirectory, selected]]);
    const manifest = async (path: string) => {
      const existing = manifests.get(path);
      if (existing) return existing;
      check();
      const value = record(await readJson(manifestPath(path)));
      boundDeclarations(value);
      manifests.set(path, value);
      return value;
    };
    const workspacePaths = (root: string, pkg: Record<string, unknown>): string[] => {
      if (pkg.workspaces === undefined) return [];
      const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : record(pkg.workspaces).packages;
      if (!Array.isArray(patterns)) throw new Error('Unsupported workspace declarations');
      if (patterns.length > 256) throw new CustomizationError('resource-limit', 'Customization source workspace pattern limit exceeded.');
      const seen = new Set<string>();
      const members = new Set<string>();
      for (const pattern of patterns) {
        check();
        if (typeof pattern !== 'string' || seen.has(pattern) || /[?!{}[\]]/u.test(pattern)) throw new Error('Unsupported workspace pattern');
        seen.add(pattern);
        const wildcard = pattern.endsWith('/*');
        const literal = wildcard ? pattern.slice(0, -2) : pattern;
        if (literal.includes('*')) throw new Error('Unsupported workspace pattern');
        const prefix = posix.join(root, containedPath(literal));
        const matches = wildcard ? directories.get(prefix)?.children ?? [] : [prefix];
        for (const path of matches) {
          check();
          if (!inventory.has(manifestPath(path))) {
            if (wildcard) continue;
            throw new Error('Missing workspace');
          }
          if (members.has(path)) throw new Error('Overlapping workspaces');
          members.add(path);
        }
      }
      return [...members].sort();
    };
    const owners: { path: string; members: string[] }[] = [];
    let ancestor = subdirectory;
    while (ancestor) {
      check();
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
    if ([owner.path, subdirectory].some(path => inventory.has(posix.join(path, 'npm-shrinkwrap.json')))) {
      throw new CustomizationError('invalid-package', 'Committed npm-shrinkwrap.json is unsupported in the selected npm context.');
    }
    const members = new Set(owner.members);
    const workspaceKeys = new Set(owner.members.map(path => posix.relative(owner.path, path)));
    const root = await manifest(owner.path);
    const lockfile = inventory.get(posix.join(owner.path, 'package-lock.json'));
    const relativeFiles = new Set<string>();
    for (const path of inventory.keys()) {
      check();
      if (!subdirectory || path.startsWith(`${subdirectory}/`)) relativeFiles.add(subdirectory ? path.slice(subdirectory.length + 1) : path);
    }
    const lock = lockfile ? await readJson(lockfile.path) : undefined;
    const context = { lock, packagePath: posix.relative(owner.path, subdirectory), packageManager: root.packageManager };
    const customization = parseCustomizationPackage(selected, relativeFiles, context);
    if (!customization) return { directory: join(tree.directory, subdirectory), customization, npm: { kind: 'absent' } satisfies NpmInputs };
    const packages = [{ path: owner.path, pkg: root }];
    for (const path of owner.members) packages.push({ path, pkg: await manifest(path) });
    const needsLock = owner.members.length > 0 || packages.some(({ pkg }) => dependencyGroups.some(key => pkg[key] !== undefined && Object.keys(record(pkg[key])).length > 0));
    if (!needsLock) return { directory: join(tree.directory, subdirectory), customization, npm: { kind: 'absent' } satisfies NpmInputs };
    if (!lockfile) throw new CustomizationError('invalid-package', 'Dependencies require a committed npm v3 lockfile.');
    const entries = record(record(lock).packages);
    const lockEntries = Object.entries(entries);
    if (lockEntries.length > 10_000) throw new CustomizationError('resource-limit', 'Customization source lock entry limit exceeded.');
    for (const [, value] of lockEntries) boundDeclarations(record(value));
    const localFiles = new Map<string, SourceFile>();
    const captured = new Set<string>();
    const capture = (path: string) => {
      const file = inventory.get(path);
      if (file) { localFiles.set(path, file); return; }
      if (!members.has(path)) throw new Error('Local directories require a declared workspace');
      const pending = [path];
      for (const path of pending) {
        check();
        if (captured.has(path)) continue;
        captured.add(path);
        const directory = directories.get(path);
        if (!directory) throw new Error('Missing local npm input');
        pending.push(...directory.children);
        for (const file of directory.files) { check(); localFiles.set(file.path, file); }
      }
    };
    for (const { path, pkg } of packages) {
      check();
      if (pkg.packageManager !== undefined && pkg.packageManager !== root.packageManager) throw new CustomizationError('invalid-package', 'Conflicting npm package manager pin.');
      validateNpmManifest(pkg, { lock, packagePath: posix.relative(owner.path, path), packageManager: root.packageManager });
    }
    const lockedDependency = (path: string, name: string, peer: boolean): unknown => {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) throw new Error('Invalid dependency name');
      let search = peer && path.split('/').includes('node_modules') ? path.slice(0, path.lastIndexOf('node_modules/')).replace(/\/$/u, '') : path;
      while (true) {
        check();
        const entry = posix.basename(search) === 'node_modules' ? undefined : entries[posix.join(search, 'node_modules', name)];
        if (entry !== undefined || !search) return entry;
        search = posix.dirname(search);
        if (search === '.') search = '';
      }
    };
    const declarationContext = (lookupPath: string, entry: Record<string, unknown>): DeclarationContext => {
      const sourceDirectory = entry.link === true && typeof entry.resolved === 'string' ? localPath(owner.path, entry.resolved)
        : typeof entry.resolved === 'string' && entry.resolved.startsWith('file:') ? posix.dirname(localPath(owner.path, entry.resolved.slice(5)))
        : localPath(owner.path, lookupPath || '.');
      return { lookupPath, sourceDirectory: sourceDirectory === '.' ? '' : sourceDirectory };
    };
    const validateDeclarations = (context: DeclarationContext, pkg: Record<string, unknown>, groups: readonly string[]) => {
      for (const group of groups) {
        const values = pkg[group] === undefined ? {} : record(pkg[group]);
        for (const [name, spec] of Object.entries(values)) {
          check();
          if (typeof spec !== 'string') throw new Error('Invalid dependency');
          const found = lockedDependency(context.lookupPath, name, group === 'peerDependencies');
          const meta = pkg.peerDependenciesMeta === undefined ? {} : record(pkg.peerDependenciesMeta);
          const optional = group === 'peerDependencies' && meta[name] !== undefined && record(meta[name]).optional === true;
          const localTarget = spec.startsWith('file:') ? localPath(context.sourceDirectory, spec.slice(5)) : undefined;
          if (localTarget !== undefined) capture(localTarget);
          else if (/[:/]/u.test(spec) && !spec.startsWith('npm:') && !safeRemote(spec)) throw new Error('Unsupported dependency source');
          if (found === undefined) {
            if (optional) continue;
            throw new Error('Missing locked dependency');
          }
          const entry = record(found);
          if (localTarget !== undefined) {
            if (typeof entry.resolved !== 'string' || (entry.link !== true && !entry.resolved.startsWith('file:'))) throw new CustomizationError('invalid-package', 'Local lock target has an incompatible source kind.');
            if (localPath(owner.path, entry.link === true ? entry.resolved : entry.resolved.slice(5)) !== localTarget) throw new CustomizationError('invalid-package', 'Local lock target disagrees with its declaration.');
          }
          if (safeRemote(spec) && (entry.resolved !== spec || !integrity(entry.integrity))) throw new Error('Unpinned remote tarball');
        }
      }
    };
    for (const [path, value] of lockEntries) {
      check();
      if (path.startsWith('../') || (path && !path.split('/').includes('node_modules') && !workspaceKeys.has(path))) throw new Error('Separate npm contexts are unsupported');
      if (path) localPath(owner.path, path);
      const entry = record(value);
      if (entry.hasShrinkwrap !== undefined && entry.hasShrinkwrap !== false) throw new CustomizationError('invalid-package', 'Nested npm shrinkwrap contexts are unsupported.');
      if (entry.link === true) {
        if (typeof entry.resolved !== 'string') throw new Error('Invalid local link');
        const target = localPath(owner.path, entry.resolved);
        if (!members.has(target)) throw new Error('Local links require a declared workspace');
        capture(target);
      } else if (path.split('/').includes('node_modules')) {
        if (typeof entry.version !== 'string' || !entry.version) throw new Error('Invalid locked version');
        if (typeof entry.resolved === 'string' && entry.resolved.startsWith('file:')) capture(localPath(owner.path, entry.resolved.slice(5)));
        else if (!safeRemote(entry.resolved) || !integrity(entry.integrity)) throw new Error('Unsupported locked source');
      }
      validateDeclarations(declarationContext(path, entry), entry, ['dependencies', 'optionalDependencies', 'peerDependencies']);
      if (entry.resolved !== undefined && (typeof entry.resolved !== 'string' ||
        (entry.link !== true && !entry.resolved.startsWith('file:') && !safeRemote(entry.resolved)))) throw new Error('Invalid resolved source');
    }
    for (const { path, pkg } of packages) {
      check();
      validateDeclarations({ lookupPath: posix.relative(owner.path, path), sourceDirectory: path }, pkg, dependencyGroups);
    }
    const rootFile = inventory.get(manifestPath(owner.path));
    if (!rootFile) throw new Error('Missing npm root');
    const workspaces = owner.members.map(path => {
      check();
      const file = inventory.get(manifestPath(path));
      if (!file) throw new Error('Missing workspace');
      return file;
    });
    check();
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
