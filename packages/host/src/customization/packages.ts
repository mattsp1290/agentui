import { record } from '@agentui/contracts/decode';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { containedPath, CustomizationError, dependencyGroups, hasDependencies, parseCustomizationPackage, npmLockPackages, manifestMatchesLockEntry, npmLocalPath, parentDirectory, byPath, identity, type CustomizationSource } from './contract.js';
import { SourceBudget } from './budget.js';
import type { RepositoryTree, SourceFile } from './repository.js';

export type NpmInputs = { readonly kind: 'absent' } | {
  readonly kind: 'locked';
  readonly identity: string;
  readonly packageManager: 'npm@11.19.1';
  readonly directory: string;
  readonly path: string;
  readonly packageJson: SourceFile;
  readonly lockfile: SourceFile;
  readonly workspaces: readonly SourceFile[];
  readonly localInputs: readonly SourceFile[];
};
export function npmIdentity(input: {
  readonly treeId: string; readonly path: string; readonly selected: SourceFile;
} & Pick<Extract<NpmInputs, { kind: 'locked' }>, 'packageJson' | 'lockfile' | 'workspaces' | 'localInputs'>): string {
  return identity(['agentui-npm-v1', input.treeId, input.path, input.selected, input.packageJson, input.lockfile, input.workspaces, input.localInputs]);
}
export interface SelectedPackage { readonly directory: string; readonly customization: CustomizationSource | undefined; readonly npm: NpmInputs }
interface Member { readonly path: string; readonly file: SourceFile; readonly manifest: Record<string, unknown> }
interface NpmOwner { readonly root: Member; readonly members: ReadonlyMap<string, Member>; readonly lockfile: SourceFile | undefined }
interface Directory { readonly files: SourceFile[]; readonly children: Set<string> }
interface AnalysisContext {
  readonly tree: RepositoryTree;
  readonly budget: SourceBudget;
  readonly files: ReadonlyMap<string, SourceFile>;
  readonly directories: ReadonlyMap<string, Directory>;
  readonly manifests: Map<string, Member>;
  declarations: number;
}
interface DeclarationContext { readonly lookupPath: string; readonly sourceDirectory: string }
interface Declaration { readonly name: string; readonly spec: string; readonly peer: boolean; readonly optional: boolean }
type LockSource = { readonly kind: 'workspace'; readonly target: string; readonly resolved: string } | { readonly kind: 'tarball'; readonly archive: string }
  | { readonly kind: 'remote'; readonly url: string } | { readonly kind: 'none' };
interface LockEntry { readonly record: Record<string, unknown>; readonly source: LockSource; readonly context: DeclarationContext; readonly declarations: readonly Declaration[] }
const manifestPath = (path: string) => posix.join(path, 'package.json');
const isInstalledPath = (path: string) => path.split('/').includes('node_modules');
const filePayload = (value: unknown) => typeof value === 'string' && value.startsWith('file:') ? value.slice(5) : undefined;
const readJson = async (ctx: AnalysisContext, path: string): Promise<unknown> => JSON.parse(await readFile(join(ctx.tree.directory, path), 'utf8'));
function safeRemote(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function integrity(value: unknown): boolean {
  return typeof value === 'string' && /^(?:sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2})(?:\s+sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2})*$/u.test(value);
}
function analysisContext(tree: RepositoryTree, budget: SourceBudget): AnalysisContext {
  const files = new Map<string, SourceFile>();
  const directories = new Map<string, Directory>();
  const ctx: AnalysisContext = { tree, budget, files, directories, manifests: new Map(), declarations: 0 };
  for (const file of tree.inputs.files) {
    ctx.budget.check();
    files.set(file.path, file);
    let path = parentDirectory(file.path);
    if (!directories.has(path)) directories.set(path, { files: [], children: new Set() });
    directories.get(path)?.files.push(file);
    while (path) {
      ctx.budget.check();
      const parent = parentDirectory(path);
      if (!directories.has(parent)) directories.set(parent, { files: [], children: new Set() });
      const children = directories.get(parent)?.children;
      if (children?.has(path)) break;
      children?.add(path);
      path = parent;
    }
  }
  return ctx;
}
function boundDeclarations(ctx: AnalysisContext, pkg: Record<string, unknown>): void {
  for (const group of dependencyGroups) {
    ctx.budget.check();
    ctx.declarations += pkg[group] === undefined ? 0 : Object.keys(record(pkg[group])).length;
    if (ctx.declarations > 50_000) throw new CustomizationError('resource-limit', 'Customization source declaration limit exceeded.');
  }
}
async function member(ctx: AnalysisContext, file: SourceFile): Promise<Member> {
  const path = parentDirectory(file.path);
  const existing = ctx.manifests.get(path);
  if (existing) return existing;
  ctx.budget.check();
  const manifest = record(await readJson(ctx, file.path));
  boundDeclarations(ctx, manifest);
  const result = { path, file, manifest };
  ctx.manifests.set(path, result);
  return result;
}
function workspaceFiles(ctx: AnalysisContext, root: Member): Map<string, SourceFile> {
  const members = new Map<string, SourceFile>();
  if (root.manifest.workspaces === undefined) return members;
  const patterns = Array.isArray(root.manifest.workspaces) ? root.manifest.workspaces : record(root.manifest.workspaces).packages;
  if (!Array.isArray(patterns)) throw new Error('Unsupported workspace declarations');
  if (patterns.length > 256) throw new CustomizationError('resource-limit', 'Customization source workspace pattern limit exceeded.');
  const seen = new Set<string>();
  for (const pattern of patterns) {
    ctx.budget.check();
    if (typeof pattern !== 'string' || seen.has(pattern) || /[?!{}[\]]|[+@]\(/u.test(pattern)) throw new Error('Unsupported workspace pattern');
    seen.add(pattern);
    const wildcard = pattern.endsWith('/*');
    const literal = wildcard ? pattern.slice(0, -2) : pattern;
    if (literal.includes('*')) throw new Error('Unsupported workspace pattern');
    const prefix = posix.join(root.path, containedPath(literal));
    for (const path of wildcard ? ctx.directories.get(prefix)?.children ?? [] : [prefix]) {
      ctx.budget.check();
      const file = ctx.files.get(manifestPath(path));
      if (!file) { if (wildcard) continue; throw new Error('Missing workspace'); }
      if (members.has(path)) throw new Error('Overlapping workspaces');
      members.set(path, file);
    }
  }
  return new Map([...members].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
async function npmOwner(ctx: AnalysisContext, selected: Member): Promise<NpmOwner> {
  const owners: { root: Member; files: Map<string, SourceFile> }[] = [];
  let ancestor = selected.path;
  while (ancestor) {
    ctx.budget.check();
    ancestor = parentDirectory(ancestor);
    const file = ctx.files.get(manifestPath(ancestor));
    if (!file) continue;
    const root = await member(ctx, file);
    const files = workspaceFiles(ctx, root);
    if (files.has(selected.path)) owners.push({ root, files });
  }
  if (owners.length > 1 || (owners.length && ctx.files.has(posix.join(selected.path, 'package-lock.json')))) throw new Error('Ambiguous npm ownership');
  const { root, files } = owners[0] ?? { root: selected, files: workspaceFiles(ctx, selected) };
  if ([root.path, selected.path].some(path => ctx.directories.get(path)?.files.some(file => posix.basename(file.path).toLowerCase() === 'npm-shrinkwrap.json'))) {
    throw new CustomizationError('invalid-package', 'Committed npm-shrinkwrap.json is unsupported in the selected npm context.');
  }
  const members = new Map<string, Member>();
  for (const [path, file] of files) members.set(path, await member(ctx, file));
  return { root, members, lockfile: ctx.files.get(posix.join(root.path, 'package-lock.json')) };
}
function declarations(ctx: AnalysisContext, pkg: Record<string, unknown>, groups: readonly string[]): Declaration[] {
  const result: Declaration[] = [];
  let peerMetadata: Record<string, unknown> | undefined;
  for (const group of groups) {
    for (const [name, spec] of Object.entries(pkg[group] === undefined ? {} : record(pkg[group]))) {
      ctx.budget.check();
      if (typeof spec !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name) ||
        name.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid dependency');
      const meta = peerMetadata ??= pkg.peerDependenciesMeta === undefined ? {} : record(pkg.peerDependenciesMeta);
      const peer = group === 'peerDependencies';
      result.push({ name, spec, peer, optional: peer && Object.hasOwn(meta, name) && record(meta[name]).optional === true });
    }
  }
  return result;
}
function lockSource(owner: NpmOwner, entry: Record<string, unknown>, installed: boolean): LockSource {
  if (entry.link === true) {
    if (typeof entry.resolved !== 'string') throw new Error('Invalid local link');
    const target = npmLocalPath(owner.root.path, entry.resolved);
    if (!owner.members.has(target)) throw new Error('Local links require a declared workspace');
    return { kind: 'workspace', target, resolved: entry.resolved };
  }
  if (installed && (typeof entry.version !== 'string' || !entry.version)) throw new Error('Invalid locked version');
  const archive = filePayload(entry.resolved);
  if (archive !== undefined) return { kind: 'tarball', archive: npmLocalPath(owner.root.path, archive) };
  if (safeRemote(entry.resolved) && (!installed || integrity(entry.integrity))) return { kind: 'remote', url: entry.resolved };
  if (!installed && entry.resolved === undefined) return { kind: 'none' };
  throw new Error('Unsupported locked source');
}
function lockEntries(ctx: AnalysisContext, owner: NpmOwner, packages: Record<string, unknown>, targets: Set<string>): ReadonlyMap<string, LockEntry> {
  const entries = Object.entries(packages);
  if (entries.length > 10_000) throw new CustomizationError('resource-limit', 'Customization source lock entry limit exceeded.');
  const result = new Map<string, LockEntry>();
  for (const [path, value] of entries) {
    ctx.budget.check();
    const installed = isInstalledPath(path);
    const workspace = owner.members.get(posix.join(owner.root.path, path));
    if (path.startsWith('../') || (path && !installed && (!workspace || posix.relative(owner.root.path, workspace.path) !== path))) throw new Error('Separate npm contexts are unsupported');
    const directory = npmLocalPath(owner.root.path, path || '.');
    const entry = record(value);
    boundDeclarations(ctx, entry);
    if (entry.hasShrinkwrap !== undefined && entry.hasShrinkwrap !== false) throw new CustomizationError('invalid-package', 'Nested npm shrinkwrap contexts are unsupported.');
    if (entry.inBundle || (installed && [entry.bundleDependencies, entry.bundledDependencies].some(value => Array.isArray(value) ? value.length > 0 : Boolean(value)))) {
      throw new CustomizationError('invalid-package', 'Bundled npm dependencies are unsupported.');
    }
    const source = lockSource(owner, entry, installed);
    const sourceDirectory = source.kind === 'workspace' ? source.target : source.kind === 'tarball' ? parentDirectory(source.archive) : directory;
    if (source.kind === 'workspace') targets.add(source.target);
    if (installed && source.kind === 'tarball') targets.add(source.archive);
    result.set(path, { record: entry, source, context: { lookupPath: path, sourceDirectory }, declarations: declarations(ctx, entry, ['dependencies', 'optionalDependencies', 'peerDependencies']) });
  }
  return result;
}
function lockedDependency(ctx: AnalysisContext, entries: ReadonlyMap<string, LockEntry>, path: string, declaration: Declaration): LockEntry | undefined {
  let search = declaration.peer && isInstalledPath(path) ? path.slice(0, path.lastIndexOf('node_modules/')).replace(/\/$/u, '') : path;
  while (true) {
    ctx.budget.check();
    const entry = posix.basename(search) === 'node_modules' ? undefined : entries.get(posix.join(search, 'node_modules', declaration.name));
    if (entry !== undefined || !search) return entry;
    search = parentDirectory(search);
  }
}
function validateDeclarations(ctx: AnalysisContext, entries: ReadonlyMap<string, LockEntry>, context: DeclarationContext, values: readonly Declaration[], targets: Set<string>): void {
  for (const declaration of values) {
    ctx.budget.check();
    const { spec, optional } = declaration;
    const found = lockedDependency(ctx, entries, context.lookupPath, declaration);
    const payload = filePayload(spec);
    const localTarget = payload === undefined ? undefined : npmLocalPath(context.sourceDirectory, payload);
    if (localTarget !== undefined) targets.add(localTarget);
    else if (/[:/]/u.test(spec) && !spec.startsWith('npm:') && !safeRemote(spec)) throw new Error('Unsupported dependency source');
    if (found === undefined) { if (optional) continue; throw new Error('Missing locked dependency'); }
    const source = found.source;
    if (localTarget !== undefined) {
      if (source.kind !== 'workspace' && source.kind !== 'tarball') throw new CustomizationError('invalid-package', 'Local lock target has an incompatible source kind.');
      if ((source.kind === 'workspace' ? source.target : source.archive) !== localTarget) throw new CustomizationError('invalid-package', 'Local lock target disagrees with its declaration.');
    }
    if (safeRemote(spec) && (source.kind !== 'remote' || source.url !== spec)) throw new Error('Unpinned remote tarball');
  }
}
function capture(ctx: AnalysisContext, owner: NpmOwner, targets: ReadonlySet<string>): SourceFile[] {
  const files = new Map<string, SourceFile>();
  const captured = new Set<string>();
  for (const target of targets) {
    const file = ctx.files.get(target);
    if (file) { files.set(target, file); continue; }
    if (!owner.members.has(target)) throw new Error('Local directories require a declared workspace');
    const pending = [target];
    for (const path of pending) {
      ctx.budget.check();
      if (captured.has(path)) continue;
      captured.add(path);
      const directory = ctx.directories.get(path);
      if (!directory) throw new Error('Missing local npm input');
      pending.push(...directory.children);
      for (const file of directory.files) { ctx.budget.check(); files.set(file.path, file); }
    }
  }
  return [...files.values()].sort(byPath);
}
async function npmInputs(ctx: AnalysisContext, selected: Member, owner: NpmOwner): Promise<NpmInputs> {
  const lockfile = owner.lockfile;
  const lock = lockfile ? await readJson(ctx, lockfile.path) : undefined;
  const packages = [owner.root, ...owner.members.values()];
  if (!owner.members.size && !packages.some(member => hasDependencies(member.manifest))) return { kind: 'absent' };
  if (!lockfile) throw new CustomizationError('invalid-package', 'Dependencies require a committed npm v3 lockfile.');
  const rawPackages = npmLockPackages(lock, owner.root.manifest.packageManager);
  const targets = new Set<string>();
  const entries = lockEntries(ctx, owner, rawPackages, targets);
  for (const { path, manifest } of packages) {
    ctx.budget.check();
    if (manifest.packageManager !== undefined && manifest.packageManager !== owner.root.manifest.packageManager) throw new CustomizationError('invalid-package', 'Conflicting npm package manager pin.');
    const packagePath = posix.relative(owner.root.path, path);
    const entry = entries.get(packagePath);
    if (!entry) throw new Error('Missing lock entry');
    manifestMatchesLockEntry(manifest, entry.record);
    const link = entries.get(`node_modules/${String(manifest.name)}`)?.source;
    const linkedName = packagePath !== '' && link?.kind === 'workspace' && link.resolved === packagePath;
    if (packagePath !== '' && !linkedName) throw new CustomizationError('invalid-package', 'Workspace requires a matching canonical lockfile link.');
    if (entry.record.name !== manifest.name && !(entry.record.name === undefined && linkedName)) throw new CustomizationError('invalid-package', 'Lockfile name disagrees with package.json.');
    validateDeclarations(ctx, entries, { lookupPath: packagePath, sourceDirectory: path }, declarations(ctx, manifest, dependencyGroups), targets);
  }
  for (const entry of entries.values()) validateDeclarations(ctx, entries, entry.context, entry.declarations, targets);
  const workspaces = [...owner.members.values()].map(member => member.file);
  const localInputs = capture(ctx, owner, targets);
  ctx.budget.check();
  return Object.freeze({ kind: 'locked', packageManager: 'npm@11.19.1', directory: join(ctx.tree.directory, owner.root.path), path: owner.root.path,
    identity: npmIdentity({ treeId: ctx.tree.inputs.identity, path: owner.root.path, selected: selected.file, packageJson: owner.root.file, lockfile, workspaces, localInputs }),
    packageJson: owner.root.file, lockfile, workspaces: Object.freeze(workspaces), localInputs: Object.freeze(localInputs) });
}
export async function selectPackage(tree: RepositoryTree, subdirectory: string, budget: SourceBudget): Promise<SelectedPackage> {
  try {
    const ctx = analysisContext(tree, budget);
    const file = ctx.files.get(manifestPath(subdirectory));
    if (!file && subdirectory) throw new Error('Missing selected package');
    const manifest = file ? record(await readJson(ctx, file.path)) : {};
    const relativeFiles = new Set<string>();
    for (const path of ctx.files.keys()) {
      ctx.budget.check();
      if (!subdirectory || path.startsWith(`${subdirectory}/`)) relativeFiles.add(subdirectory ? path.slice(subdirectory.length + 1) : path);
    }
    const customization = parseCustomizationPackage(manifest, relativeFiles);
    let npm: NpmInputs = { kind: 'absent' };
    if (customization && file) {
      boundDeclarations(ctx, manifest);
      const selected = { path: subdirectory, file, manifest };
      ctx.manifests.set(subdirectory, selected);
      npm = await npmInputs(ctx, selected, await npmOwner(ctx, selected));
    }
    budget.check();
    return { directory: join(tree.directory, subdirectory), customization, npm };
  } catch (error) {
    if (error instanceof CustomizationError) throw error;
    throw new CustomizationError('invalid-package', 'Invalid committed package, workspace ownership, or npm inputs.');
  }
}
