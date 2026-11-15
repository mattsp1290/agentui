import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { count, hex, nonempty, record } from '@agentui/contracts/decode';
import { parseExtensionManifest, type ExtensionManifest } from '@agentui/sdk';
import { commitId, containedPath, CustomizationError, identity, serverCatalogFile, supportedPackageManager } from './contract.js';
import { sourceFile, treeIdentity, type CommittedInputs, type SourceFile } from './repository.js';
import { npmIdentity, type NpmInputs } from './packages.js';
import { packageIdentity, type ResolvedCustomizationPackage } from './sources.js';
import { customizationPreorder } from './traversal.js';

export type ServerArtifactNpm = Extract<NpmInputs, { kind: 'absent' }> | Omit<Extract<NpmInputs, { kind: 'locked' }>, 'directory'>;

export interface ServerArtifactPackage {
  readonly identity: string;
  readonly commit: string;
  readonly subdirectory: string;
  readonly inputs: CommittedInputs;
  readonly npm: ServerArtifactNpm;
  readonly local: { readonly manifest: ExtensionManifest; readonly sources: readonly { readonly module: string; readonly source: string }[] } | null;
  readonly shared: string | null;
  readonly extensions: readonly { readonly packageIdentity: string; readonly commit: string }[];
}
export interface ServerCustomizationArtifact {
  readonly schemaVersion: 1;
  readonly kind: 'server-customization';
  readonly root: string;
  readonly packages: readonly ServerArtifactPackage[];
  readonly sdkVersion: string;
  readonly builder: { readonly identity: string; readonly esbuildVersion: string };
  readonly runtime: { readonly engine: 'node'; readonly version: string; readonly modules: string; readonly abiIdentity: string };
  readonly catalog: typeof serverCatalogFile;
  readonly entries: readonly { readonly packageIdentity: string; readonly module: string; readonly index: number }[];
  readonly assets: readonly { readonly path: string; readonly sha256: string; readonly size: number }[];
  readonly artifactId: string;
}
export interface ServerArtifactExpectation {
  readonly artifactId: string;
  readonly sdkVersion: string;
  readonly nodeVersion: string;
  readonly nodeModules: string;
  readonly abiIdentity: string;
}
const invalid = () => CustomizationError.fixed('invalid-artifact');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function array<T>(value: unknown, parse: (item: unknown) => T, max = 16_384): T[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value.map(parse);
}
function directory(value: unknown): string { return value === '' ? '' : containedPath(value); }
function sorted<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  if (values.some((value, index) => index > 0 && key(values[index - 1]!) >= key(value))) throw invalid();
  return values;
}
function file(value: unknown): SourceFile {
  const input = record(value, ['path', 'sha256', 'executable']);
  if (typeof input.executable !== 'boolean') throw invalid();
  return sourceFile({ path: containedPath(input.path), sha256: hex(input.sha256, 64), executable: input.executable });
}
const files = (value: unknown) => sorted(array(value, file), value => value.path);
function parseNpm(value: unknown, committed: ReadonlyMap<string, SourceFile>, treeId: string, packageJsonPath: string): ServerArtifactNpm {
  const rawNpm = record(value);
  if (rawNpm.kind === 'absent') { record(rawNpm, ['kind']); return { kind: 'absent' }; }
  record(rawNpm, ['kind', 'identity', 'packageManager', 'path', 'packageJson', 'lockfile', 'workspaces', 'localInputs']);
  if (rawNpm.kind !== 'locked' || rawNpm.packageManager !== supportedPackageManager) throw invalid();
  const npm: ServerArtifactNpm = { kind: 'locked', identity: hex(rawNpm.identity, 64), packageManager: supportedPackageManager, path: directory(rawNpm.path),
    packageJson: file(rawNpm.packageJson), lockfile: file(rawNpm.lockfile), workspaces: files(rawNpm.workspaces), localInputs: files(rawNpm.localInputs) };
  const selected = committed.get(packageJsonPath);
  if (!selected || npmIdentity({ ...npm, treeId, selected }) !== npm.identity) throw invalid();
  for (const captured of [npm.packageJson, npm.lockfile, ...npm.workspaces, ...npm.localInputs]) {
    const file = committed.get(captured.path);
    if (!file || file.sha256 !== captured.sha256 || file.executable !== captured.executable) throw invalid();
  }
  return npm;
}
function parseLocal(value: unknown, committed: ReadonlyMap<string, SourceFile>, packagePath: (path: string) => string): ServerArtifactPackage['local'] {
  if (value === null) return null;
  const rawLocal = record(value, ['manifest', 'sources']);
  const manifest = parseExtensionManifest(rawLocal.manifest);
  const sources = sorted(array(rawLocal.sources, value => {
    const source = record(value, ['module', 'source']);
    return { module: `./${containedPath(source.module, true)}`, source: `./${containedPath(source.source, true)}` };
  }), value => value.module);
  const modules = new Set(manifest.entries.map(entry => entry.module));
  if (sources.length !== modules.size) throw invalid();
  if (sources.some(source => !modules.has(source.module))) throw invalid();
  if (sources.some(source => !committed.has(packagePath(source.source)))) throw invalid();
  return { manifest, sources };
}
function parsePackage(value: unknown): ServerArtifactPackage {
  const input = record(value, ['identity', 'commit', 'subdirectory', 'inputs', 'npm', 'local', 'shared', 'extensions']);
  const rawInputs = record(input.inputs, ['identity', 'files']);
  const inputs = { identity: hex(rawInputs.identity, 64), files: files(rawInputs.files) };
  const subdirectory = directory(input.subdirectory);
  const id = hex(input.identity, 64);
  const committed = new Map(inputs.files.map(file => [file.path, file]));
  const packagePath = (path: string) => [subdirectory, path.replace(/^\.\//u, '')].filter(Boolean).join('/');
  if (treeIdentity(inputs.files) !== inputs.identity || packageIdentity(inputs.identity, subdirectory) !== id) throw invalid();
  const npm = parseNpm(input.npm, committed, inputs.identity, packagePath('package.json'));
  const local = parseLocal(input.local, committed, packagePath);
  const shared = input.shared === null ? null : `./${containedPath(input.shared, true)}`;
  if (shared && !committed.has(packagePath(shared))) throw invalid();
  const extensions = array(input.extensions, value => {
    const edge = record(value, ['packageIdentity', 'commit']);
    return { packageIdentity: hex(edge.packageIdentity, 64), commit: commitId(edge.commit) };
  }, 256);
  return { identity: id, commit: commitId(input.commit), subdirectory, inputs, npm, local, shared, extensions };
}
export interface ServerCatalog {
  readonly packages: readonly ServerArtifactPackage[];
  readonly entries: ServerCustomizationArtifact['entries'];
  readonly manifests: readonly ExtensionManifest[];
}
export function serverCatalog(packages: readonly ServerArtifactPackage[], sdkVersion: string): ServerCatalog {
  const invalidGraph = () => CustomizationError.fixed('invalid-graph');
  const root = packages[0];
  const lookup = new Map(packages.map(pkg => [pkg.identity, pkg]));
  if (!root || packages.length > 64 || lookup.size !== packages.length) throw invalidGraph();
  const ordered = customizationPreorder({ packageIdentity: root.identity, commit: root.commit }, edge => edge.packageIdentity, edge => {
    const pkg = lookup.get(edge.packageIdentity);
    if (!pkg || pkg.commit !== edge.commit) throw invalidGraph();
    return pkg.extensions;
  }).map(edge => lookup.get(edge.packageIdentity)!);
  const namespaces = new Set<string>();
  const entries: ServerCustomizationArtifact['entries'][number][] = [];
  const manifests: ExtensionManifest[] = [];
  for (const pkg of ordered) {
    if (!pkg.local) continue;
    const { manifest } = pkg.local;
    if (manifest.sdkVersion !== sdkVersion || namespaces.has(manifest.namespace)) throw invalidGraph();
    namespaces.add(manifest.namespace);
    for (const entry of manifest.entries.filter(entry => entry.kind === 'server')) {
      entries.push({ packageIdentity: pkg.identity, module: entry.module, index: entries.length });
      manifests.push(manifest);
    }
  }
  if (ordered.length !== packages.length || !entries.length || entries.length > 64) throw invalidGraph();
  return { packages: ordered, entries, manifests };
}
export interface ServerCatalogPlan {
  readonly catalog: ServerCatalog;
  readonly repositoryDirectory: string;
  readonly roots: readonly string[];
  readonly sources: readonly string[];
}
export function planServerCatalog(root: ResolvedCustomizationPackage, sdkVersion: string): ServerCatalogPlan {
  const nodes = customizationPreorder(root, node => node.identity, node => node.extensions);
  const sources: string[] = [];
  const packages = nodes.map((node): ServerArtifactPackage => {
    let npm: ServerArtifactNpm = node.npm;
    if (node.npm.kind === 'locked') { const { directory: _directory, ...locked } = node.npm; npm = locked; }
    const local = node.customization?.local;
    for (const entry of local?.manifest.entries ?? []) {
      if (entry.kind !== 'server') continue;
      const source = local?.sources.get(entry.module);
      if (!source) throw CustomizationError.fixed('invalid-graph');
      sources.push(resolve(node.directory, source));
    }
    return { identity: node.identity, commit: node.commit, subdirectory: node.subdirectory, inputs: node.inputs, npm,
      local: local ? { manifest: local.manifest,
        sources: [...local.sources].map(([module, source]) => ({ module, source })).sort((a, b) => a.module < b.module ? -1 : a.module > b.module ? 1 : 0) } : null,
      shared: node.customization?.shared ?? null, extensions: node.extensions.map(child => ({ packageIdentity: child.identity, commit: child.commit })) };
  });
  return { catalog: serverCatalog(packages, sdkVersion), repositoryDirectory: root.repositoryDirectory,
    roots: [...new Set(nodes.map(node => node.repositoryDirectory))], sources };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function serverCustomizationArtifactId(value: Omit<ServerCustomizationArtifact, 'artifactId'>): string {
  return identity(['agentui-server-artifact-v1', canonical(value)]);
}
export function parseServerCustomizationArtifact(value: unknown): ServerCustomizationArtifact {
  try {
    const input = record(value, ['schemaVersion', 'kind', 'root', 'packages', 'sdkVersion', 'builder', 'runtime', 'catalog', 'entries', 'assets', 'artifactId']);
    if (input.schemaVersion !== 1 || input.kind !== 'server-customization' || input.catalog !== serverCatalogFile) throw invalid();
    const builder = record(input.builder, ['identity', 'esbuildVersion']);
    const runtime = record(input.runtime, ['engine', 'version', 'modules', 'abiIdentity']);
    if (runtime.engine !== 'node' || typeof runtime.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(runtime.version) || typeof runtime.modules !== 'string' || !/^\d+$/u.test(runtime.modules)) throw invalid();
    const packages = array(input.packages, parsePackage, 64);
    const root = hex(input.root, 64);
    if (packages[0]?.identity !== root) throw invalid();
    const sdkVersion = nonempty(input.sdkVersion);
    const catalog = serverCatalog(packages, sdkVersion);
    if (catalog.packages.some((pkg, index) => packages[index]?.identity !== pkg.identity)) throw invalid();
    const entries = array(input.entries, value => {
      const entry = record(value, ['packageIdentity', 'module', 'index']);
      return { packageIdentity: hex(entry.packageIdentity, 64), module: `./${containedPath(entry.module, true)}`, index: count(entry.index) };
    }, 64);
    if (entries.length !== catalog.entries.length) throw invalid();
    if (entries.some((entry, index) => entry.index !== index || entry.packageIdentity !== catalog.entries[index]?.packageIdentity || entry.module !== catalog.entries[index]?.module)) throw invalid();
    const assets = sorted(array(input.assets, value => {
      const asset = record(value, ['path', 'sha256', 'size']);
      const path = containedPath(asset.path);
      if (path === 'customization.json') throw invalid();
      return { path, sha256: hex(asset.sha256, 64), size: count(asset.size) };
    }), value => value.path);
    if (!assets.some(asset => asset.path === serverCatalogFile)) throw invalid();
    const body: Omit<ServerCustomizationArtifact, 'artifactId'> = { schemaVersion: 1, kind: 'server-customization', root, packages, sdkVersion,
      builder: { identity: hex(builder.identity, 64), esbuildVersion: nonempty(builder.esbuildVersion) },
      runtime: { engine: 'node', version: runtime.version, modules: runtime.modules, abiIdentity: hex(runtime.abiIdentity, 64) }, catalog: serverCatalogFile, entries, assets };
    const artifactId = hex(input.artifactId, 64);
    if (serverCustomizationArtifactId(body) !== artifactId) throw invalid();
    return freeze({ ...body, artifactId });
  } catch { throw invalid(); }
}
export interface VerifiedServerCustomizationArtifact {
  readonly manifest: ServerCustomizationArtifact;
  readAsset(path: string): Buffer;
}
async function readVerifiedInventory(directory: string, inventory: ServerCustomizationArtifact['assets']): Promise<Map<string, Buffer>> {
  const assets = new Map(inventory.map(asset => [asset.path, asset]));
  const retained = new Map<string, Buffer>();
  let total = 0;
  const walk = async (parent: string): Promise<void> => {
    for (const name of await readdir(join(directory, parent))) {
      const path = parent ? `${parent}/${name}` : name;
      const metadata = await lstat(join(directory, path));
      if (metadata.isDirectory()) {
        if (![...assets.keys()].some(asset => asset.startsWith(`${path}/`))) throw invalid();
        await walk(path);
      } else {
        if (!metadata.isFile()) throw invalid();
        if (path === 'customization.json') continue;
        const asset = assets.get(path);
        total += metadata.size;
        if (!asset || metadata.size !== asset.size || total > 64 * 1024 * 1024) throw invalid();
        const bytes = await readFile(join(directory, path));
        if (bytes.length !== asset.size || digest(bytes) !== asset.sha256) throw invalid();
        retained.set(path, bytes);
      }
    }
  };
  await walk('');
  if (retained.size !== assets.size) throw invalid();
  return retained;
}
export async function readServerCustomizationArtifact(input: {
  readonly directory: string; readonly expected: ServerArtifactExpectation;
}): Promise<VerifiedServerCustomizationArtifact> {
  try {
    const directory = resolve(input.directory);
    if (!(await lstat(directory)).isDirectory()) throw invalid();
    const manifestPath = join(directory, 'customization.json');
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) throw invalid();
    const manifest = parseServerCustomizationArtifact(JSON.parse(await readFile(manifestPath, 'utf8')));
    const expected = input.expected;
    if (manifest.artifactId !== expected.artifactId || manifest.sdkVersion !== expected.sdkVersion || manifest.runtime.version !== expected.nodeVersion ||
      manifest.runtime.modules !== expected.nodeModules || manifest.runtime.abiIdentity !== expected.abiIdentity) throw invalid();
    const retained = await readVerifiedInventory(directory, manifest.assets);
    return Object.freeze({ manifest, readAsset(path: string) {
      const bytes = retained.get(path);
      if (!bytes) throw invalid();
      return Buffer.from(bytes);
    } });
  } catch { throw invalid(); }
}
